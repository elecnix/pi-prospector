/**
 * Component tests for the task-tool-mismatch analyzer, exercised end-to-end
 * through the real AnalyzerFramework (issue #158). No real session data, no
 * network: hand-written synthetic rows. The analyzer never touches the LLM
 * seam; the mock LLM exists only to satisfy the framework's construction and
 * prove the analyzer stays deterministic.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	tempDb,
	insertSession,
	insertMessages,
	mockFramework,
	mockFrameworkWithOverrides,
	readAnalyzerNodes,
	assertPlainRerunIsNoOpFill,
	reviseBesidePredecessor,
	sessionProposals,
	assertProposalEvidenceTrail,
	bashCall,
	readCall,
	type TestMessage,
} from "./helpers.js";
import type { AsyncDatabase } from "../../src/db/async-db.js";
import { taskToolMismatchAnalyzer } from "../../src/analyze/analyzers/task-tool-mismatch/index.js";

const ANALYZER_ID = "task-tool-mismatch";

/** Set a session's recorded tool manifest (insertSession leaves it NULL/UNKNOWN). */
async function setInventory(db: AsyncDatabase, sessionId: string, tools: string[]): Promise<void> {
	await db.prepare("UPDATE sessions SET tool_inventory = ? WHERE id = ?").run(
		JSON.stringify({ source: "pi-session-header", tools: tools.map((name) => ({ name, definitionChars: null })) }),
		sessionId,
	);
}

/** One assistant turn issuing a tool call plus its paired result. */
function callTurn(id: string, toolName: string, args: Record<string, unknown> = {}): TestMessage[] {
	return [
		{
			id,
			role: "assistant",
			text: `calling ${toolName}`,
			stopReason: "toolUse",
			toolCalls: [{ id: `${id}-call`, name: toolName, arguments: args }],
		},
		{
			role: "toolResult",
			text: "ok",
			toolResults: [{ toolCallId: `${id}-call`, toolName, isError: false, textLength: 2 }],
		},
	];
}

/** N read turns reconstructing a diff by hand (the substitute symptom). */
function substituteReads(count: number, prefix = "r"): TestMessage[] {
	const msgs: TestMessage[] = [];
	for (let i = 0; i < count; i++) msgs.push(...callTurn(`${prefix}${i}`, "read", { file_path: `src/f${i}.ts` }));
	return msgs;
}

interface RunOutcome {
	nodeKind: string;
	content: {
		session_id: string;
		instruction_message_id: string | null;
		verdicts: Array<{
			mention: string;
			source: string;
			resolution: string;
			target_tool: string | null;
			target_tool_calls: number;
			mismatched: boolean;
		}>;
		substitute_calls: number;
		substitute_tool_names: string[];
		available_tools: number;
		mismatch_found: boolean;
		improvement_proposals: Array<{ title: string; severity: string; evidence: string; target_type: string; summary: string }>;
	};
}

/** Run one session end-to-end on a fresh framework; returns its single node. */
async function runSession(
	db: AsyncDatabase,
	sessionId: string,
	firstUserText: string,
	followUps: TestMessage[],
	tools: string[] | null,
): Promise<RunOutcome> {
	await insertSession(db, sessionId);
	if (tools !== null) await setInventory(db, sessionId, tools);
	const ids = await insertMessages(db, sessionId, [{ role: "user", text: firstUserText }, ...followUps]);
	const fw = mockFramework(db);
	await fw.register(taskToolMismatchAnalyzer);
	const summary = await fw.run(sessionId, {});
	assert.equal(summary.errors.length, 0, `run should have no errors: ${summary.errors.join("; ")}`);
	const allNodes = (await readAnalyzerNodes(db, ANALYZER_ID)) as unknown as Array<{
		node_kind: string;
		content_json: string;
	}>;
	const nodes = allNodes.filter((n) => (JSON.parse(n.content_json) as { session_id?: string }).session_id === sessionId);
	assert.equal(nodes.length, 1, "one node per inventoried session");
	const content = JSON.parse(nodes[0]!.content_json);
	assert.equal(content.instruction_message_id, ids[0], "the node anchors back to the instructing message");
	return { nodeKind: nodes[0]!.node_kind, content };
}

// ─────────────────────────── tests ───────────────────────────

describe("task-tool-mismatch component tests", () => {
	it("fires when all four conditions hold: instructed command available, zero calls, many substitutes", async () => {
		const { db, close } = await tempDb();
		try {
			const out = await runSession(
				db,
				"ttm-fire",
				'Review PR #1407.\nRun `git diff origin/main...HEAD` first.',
				substituteReads(15),
				["bash", "read", "grep"],
			);

			assert.equal(out.nodeKind, "proposal");
			assert.equal(out.content.mismatch_found, true);
			assert.deepEqual(
				out.content.verdicts,
				[
					{
						mention: "git",
						source: "backticked",
						resolution: "shell-command",
						target_tool: "bash",
						target_tool_calls: 0,
						ran_instructed_command: false,
						mismatched: true,
					},
				],
			);
			assert.ok(out.content.substitute_calls >= 10, "substitute volume recorded");
			assert.ok(out.content.substitute_tool_names.some((n) => n.startsWith("read×")));

			// The finding points at the MISMATCH, never at the substitute symptom.
			const proposals = await sessionProposals(db, "ttm-fire", ANALYZER_ID);
			assert.equal(proposals.length, 1, "exactly one materialised proposal");
			assert.match(proposals[0]!.title, /avoided/i);
			assert.match(proposals[0]!.title, /git/);
			assert.doesNotMatch(String(proposals[0]!.title), /redundant|re-reading|stop re-/i);
			assert.equal(proposals[0]!.target_type, "agents_md");
			assert.equal(proposals[0]!.severity, "waste");
			assert.match(out.content.improvement_proposals[0]!.summary, /run the command you were told to run/i);

			// Evidence trail: session anchor + anchors edge onto the instructing user message.
			const nodes = (await readAnalyzerNodes(db, ANALYZER_ID)) as unknown as Array<{ id: string }>;
			await assertProposalEvidenceTrail(db, nodes[0]!.id, { exactly: 1, note: "the instructing user message" });
		} finally {
			await close();
		}
	});

	it("does not fire when the instructed tool is missing from the available-tools list", async () => {
		const { db, close } = await tempDb();
		try {
			// Instruction names rg, inventory has neither rg nor any shell tool.
			const out = await runSession(
				db,
				"ttm-unavailable",
				"Use `rg` across the repo.",
				substituteReads(15),
				["read"],
			);
			assert.equal(out.nodeKind, "metric", "the agent could not have used a tool it did not have");
			assert.equal(out.content.mismatch_found, false);
			assert.equal(out.content.verdicts[0]!.resolution, "unavailable");
			assert.equal((await sessionProposals(db, "ttm-unavailable", ANALYZER_ID)).length, 0);
		} finally {
			await close();
		}
	});

	it("does not fire when the agent called the target tool", async () => {
		const { db, close } = await tempDb();
		try {
			const out = await runSession(
				db,
				"ttm-called",
				"Run `make test` before you finish.",
				callTurn("b0", "bash", { command: "make test" }).concat(callTurn("b1", "bash", { command: "ls" })),
				["bash", "read"],
			);
			assert.equal(out.nodeKind, "metric", "one bash call satisfies condition 3");
			assert.equal(out.content.mismatch_found, false);
			assert.equal(out.content.verdicts[0]!.ran_instructed_command, true);
		} finally {
			await close();
		}
	});

	it("does not fire without enough substitute-call volume", async () => {
		const { db, close } = await tempDb();
		try {
			const out = await runSession(
				db,
				"ttm-lowvol",
				'Run `git diff origin/main...HEAD` first.',
				substituteReads(3),
				["bash", "read"],
			);
			assert.equal(out.nodeKind, "metric", "three reads are ordinary work, not hand-reconstruction");
			assert.equal(out.content.mismatch_found, false);
		} finally {
			await close();
		}
	});

	it("instruction extraction guards: prose mentions and negated imperatives do not fire", async () => {
		const { db, close } = await tempDb();
		try {
			const prose = await runSession(
				db,
				"ttm-prose",
				"You can use `rg` for fast search. The docs say to run `git diff` sometimes.",
				substituteReads(15, "p"),
				["bash", "read", "rg"],
			);
			assert.equal(prose.nodeKind, "metric", "prose mentions are not instructions");

			const negated = await runSession(
				db,
				"ttm-negated",
				"Don't run `make test`; it is slow.",
				substituteReads(15, "n"),
				["bash", "read"],
			);
			assert.equal(negated.nodeKind, "metric", "a negated imperative is not an instruction");
		} finally {
			await close();
		}
	});

	it("skips sessions whose inventory was never captured (UNKNOWN), never reading NULL as empty", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "ttm-unknown");
			await insertMessages(db, "ttm-unknown", [
				{ role: "user", text: "Run `git diff`." },
				...substituteReads(12),
			]);
			const fw = mockFramework(db);
			await fw.register(taskToolMismatchAnalyzer);
			const summary = await fw.run("ttm-unknown", {});
			assert.equal(summary.errors.length, 0);
			assert.equal((await readAnalyzerNodes(db, ANALYZER_ID)).length, 0, "UNKNOWN inventory produces no unit at all");
		} finally {
			await close();
		}
	});

	it("re-running the same recipe is idempotent: no new nodes, keys unchanged", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "ttm-idem");
			await setInventory(db, "ttm-idem", ["bash", "read"]);
			await insertMessages(db, "ttm-idem", [
				{ role: "user", text: 'Run `git diff origin/main...HEAD`.' },
				...substituteReads(11),
			]);
			await assertPlainRerunIsNoOpFill(
				mockFramework(db),
				taskToolMismatchAnalyzer,
				"ttm-idem",
				() => readAnalyzerNodes(db, ANALYZER_ID),
			);
		} finally {
			await close();
		}
	});

	it("changing config marks nodes stale for the `config` reason and revises beside them", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "ttm-config");
			await setInventory(db, "ttm-config", ["bash", "read"]);
			await insertMessages(db, "ttm-config", [
				{ role: "user", text: 'Run `git diff origin/main...HEAD`.' },
				...substituteReads(12),
			]);

			const fw = mockFramework(db);
			await fw.register(taskToolMismatchAnalyzer);
			await fw.run("ttm-config", {});
			const before = await readAnalyzerNodes(db, ANALYZER_ID);
			assert.equal(before.length, 1);
			assert.equal(before[0]!.node_kind, "proposal");

			// Raising the volume gate above 12 reads changes the resolved config
			// fingerprint → stale for the `config` reason; the revise run recomputes
			// beside its predecessor as a clean metric.
			const revisedFw = mockFrameworkWithOverrides(db, ANALYZER_ID, { minSubstituteCalls: 50 });
			await revisedFw.register(taskToolMismatchAnalyzer);
			const after = await reviseBesidePredecessor(db, revisedFw, ANALYZER_ID, "ttm-config", before);
			assert.deepEqual(after.map((n) => n.node_kind).sort(), ["metric", "proposal"]);
		} finally {
			await close();
		}
	});
});
