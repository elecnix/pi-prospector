/**
 * Component tests for the session-ending analyzer, exercised end-to-end
 * through the real AnalyzerFramework (issue #102). No real session data, no
 * network: hand-written synthetic rows. The analyzer never touches the LLM
 * seam; the mock LLM exists only to satisfy the framework's construction and
 * prove the analyzer stays deterministic.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages, type TestMessage } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import { sessionEndingAnalyzer } from "../../src/analyze/analyzers/session-ending/index.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";

const WRAP_UP =
	"All done: the failing assertion was in the cache invalidation path and every test passes now.";

/** Work, a green test run, then a substantive wrap-up — resolved. */
function resolvedSession(): TestMessage[] {
	return [
		{ role: "user", text: "Please fix the failing build and confirm the suite passes." },
		{ toolCalls: [{ id: "c1", name: "bash", arguments: { command: "npm test" } }], role: "assistant", stopReason: "toolUse" },
		{ role: "toolResult", toolResults: [{ toolCallId: "c1", toolName: "bash", isError: false, textLength: 20 }] },
		{ role: "assistant", text: WRAP_UP },
	];
}

/** Ends on an error-flagged tool result with no answer after it — errored. */
function erroredSession(): TestMessage[] {
	return [
		{ role: "user", text: "Run the deploy script again." },
		{
			role: "assistant",
			stopReason: "toolUse",
			toolCalls: [{ id: "e1", name: "bash", arguments: { command: "./deploy.sh" } }],
		},
		{ role: "toolResult", toolResults: [{ toolCallId: "e1", toolName: "bash", isError: true, textLength: 40 }] },
	];
}

/** Ends on a plain user question nobody ever answered — abandoned. */
function abandonedSession(): TestMessage[] {
	return [
		{ role: "user", text: "Start migrating the auth module to the new interface." },
		{ role: "assistant", text: "I will begin with the login handler and work through the callbacks next." },
		{ role: "user", text: "How far did the migration get before you stopped?" },
	];
}

/** Ends on a short explicit closing utterance — handed-off. */
function handedOffSession(): TestMessage[] {
	return [
		{ role: "user", text: "Fix the typo in the README heading." },
		{ role: "assistant", text: "Fixed the heading and pushed the one-line change to the docs branch." },
		{ role: "user", text: "thanks, done" },
	];
}

/** Pure conversation, no tools at all — the conservative unclear. */
function unclearSession(): TestMessage[] {
	return [
		{ role: "user", text: "What does the standard library's sort guarantee about stability?" },
		{ role: "assistant", text: "It is stable since the 2.3 release; equal elements keep their insertion order." },
	];
}

function newFramework(db: import("better-sqlite3").Database) {
	return new AnalyzerFramework({
		db,
		llm: createMockLLM({ responder: () => "unused by this analyzer" }).caller,
		modelTiers: DEFAULT_MODEL_TIERS,
	});
}

function newFrameworkWithOverrides(db: import("better-sqlite3").Database, overrides: Record<string, unknown>) {
	return new AnalyzerFramework({
		db,
		llm: createMockLLM({ responder: () => "unused by this analyzer" }).caller,
		modelTiers: DEFAULT_MODEL_TIERS,
		configOverrides: { "session-ending": overrides },
	});
}

interface NodeRow extends Record<string, unknown> {
	id: string;
	node_kind: string;
	input_key: string;
	output_key: string;
	content_json: string;
	analyzer_id: string;
}

async function readNodes(db: import("better-sqlite3").Database): Promise<NodeRow[]> {
	return (await db
		.prepare("SELECT id, node_kind, input_key, output_key, content_json, analyzer_id FROM analysis_nodes WHERE analyzer_id = ?")
		.all("session-ending")) as unknown as NodeRow[];
}

async function runAndLabel(
	db: import("better-sqlite3").Database,
	sessionId: string,
	messages: TestMessage[],
) {
	await insertSession(db, sessionId);
	const ids = await insertMessages(db, sessionId, messages);
	const fw = newFramework(db);
	await fw.register(sessionEndingAnalyzer);
	const summary = await fw.run(sessionId, {});
	assert.equal(summary.errors.length, 0, `run should have no errors: ${summary.errors.join("; ")}`);
	const nodes = await readNodes(db);
	assert.equal(nodes.length, 1, `exactly one session-ending node for ${sessionId}`);
	return { ids, node: nodes[0]!, content: JSON.parse(nodes[0]!.content_json) as {
		session_id: string;
		label: string;
		evidence: { final_message_id: string; final_role: string; rule: string; final_assistant_excerpt: string | null };
	} };
}

describe("session-ending component test", () => {
	it("labels each ending fixture correctly and anchors the evidence trail", async () => {
		const cases: Array<{
			name: string;
			messages: TestMessage[];
			expected: string;
			rule: string;
		}> = [
			{ name: "end-resolved", messages: resolvedSession(), expected: "resolved", rule: "verification_passed" },
			{ name: "end-errored", messages: erroredSession(), expected: "errored", rule: "failed_result_at_end" },
			{ name: "end-abandoned", messages: abandonedSession(), expected: "abandoned", rule: "unanswered_user_message" },
			{ name: "end-handed-off", messages: handedOffSession(), expected: "handed-off", rule: "explicit_closure" },
			{ name: "end-unclear", messages: unclearSession(), expected: "unclear", rule: "no_outcome_evidence" },
		];

		for (const c of cases) {
			const { db, close } = await tempDb();
			try {
				const { ids, content } = await runAndLabel(db, c.name, c.messages);
				assert.equal(content.session_id, c.name);
				assert.equal(content.label, c.expected, `${c.name}: expected ${c.expected}`);
				assert.equal(content.evidence.rule, c.rule);
				assert.equal(content.evidence.final_message_id, ids[ids.length - 1], "the verdict names the final row");

				// Evidence trail: session anchor + anchor on the exact deciding row.
				const edges = (await db
					.prepare("SELECT * FROM analysis_edges WHERE from_node_id = ?")
					.all((await readNodes(db))[0]!.id)) as unknown as Array<Record<string, unknown>>;
				assert.equal(edges.filter((e) => e["edge_kind"] === "anchors" && e["to_ref_kind"] === "session").length, 1);
				assert.ok(
					edges.find((e) => e["edge_kind"] === "anchors" && e["to_ref_id"] === ids[ids.length - 1]),
					`${c.name}: the label anchors to the message it was decided on`,
				);

				// The label proposes nothing: it is ranking input, not friction.
				const proposals = (await db
					.prepare("SELECT COUNT(*) AS c FROM proposals WHERE analyzer_id = 'session-ending'")
					.get()) as unknown as { c: number };
				assert.equal(proposals.c, 0, `${c.name}: session-ending never materialises proposals`);
			} finally {
				await close();
			}
		}
	});

	it("emits a metric node carrying the excerpt flag, never a proposal node", async () => {
		const { db, close } = await tempDb();
		try {
			const { node, content } = await runAndLabel(db, "end-node-kind", resolvedSession());
			assert.equal(node.node_kind, "metric");
			assert.ok(content.evidence.final_assistant_excerpt!.startsWith("All done:"), "the wrap-up excerpt is carried as provenance");
			assert.equal(typeof content.stop_reason_recorded, "boolean");
			assert.equal(content.evidence.final_role, "assistant");
		} finally {
			await close();
		}
	});

	it("an empty transcript plans no unit at all", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "end-empty");
			await insertMessages(db, "end-empty", []);
			const fw = newFramework(db);
			await fw.register(sessionEndingAnalyzer);
			const summary = await fw.run("end-empty", {});
			assert.equal(summary.errors.length, 0);
			assert.equal((await readNodes(db)).length, 0, "nothing ends, so nothing is labelled");
		} finally {
			await close();
		}
	});

	it("re-running the same recipe is idempotent: no new nodes, keys unchanged", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "end-idem");
			await insertMessages(db, "end-idem", resolvedSession());
			const fw = newFramework(db);
			await fw.register(sessionEndingAnalyzer);

			const first = await fw.run("end-idem", {});
			assert.equal(first.errors.length, 0);
			const before = await readNodes(db);
			assert.equal(before.length, 1);

			const second = await fw.run("end-idem", {});
			assert.equal(second.errors.length, 0);
			assert.equal(second.nodesProduced, 0, "second plain fill must produce nothing");
			assert.equal(second.nodesSkipped, 1, "the existing unit is current");

			const after = await readNodes(db);
			assert.deepEqual(after.map((n) => [n.input_key, n.output_key]), before.map((n) => [n.input_key, n.output_key]));
		} finally {
			await close();
		}
	});

	it("changing a config knob marks the node stale for `config` and revises beside it", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "end-config");
			// Ends on a two-word assistant reply: below the default minimum summary
			// length it cannot be trusted as a delivered summary, so unclear.
			const messages: TestMessage[] = [
				{ role: "user", text: "Run the checks." },
				{
					role: "assistant",
					stopReason: "toolUse",
					toolCalls: [{ id: "k1", name: "bash", arguments: { command: "make test" } }],
				},
				{ role: "toolResult", toolResults: [{ toolCallId: "k1", toolName: "bash", isError: false, textLength: 8 }] },
				{ role: "assistant", text: "All good." },
			];
			await insertMessages(db, "end-config", messages);

			const fw = newFramework(db);
			await fw.register(sessionEndingAnalyzer);
			await fw.run("end-config", {});
			const before = await readNodes(db);
			assert.equal(before.length, 1);
			assert.equal(JSON.parse(before[0]!.content_json).label, "unclear", "short final text defaults to unclear");

			// Lowering the minimum summary length is a config change: the unit goes
			// stale for `config` and recomputes beside its predecessor.
			const lowered = newFrameworkWithOverrides(db, { minFinalSummaryLength: 5 });
			await lowered.register(sessionEndingAnalyzer);
			const revised = await lowered.run("end-config", { revise: ["config"] });
			assert.equal(revised.errors.length, 0);
			assert.equal(revised.nodesRevised, 1);

			const after = await readNodes(db);
			assert.equal(after.length, 2, "old version preserved as lineage beside the revision");
			const newNode = after.find((n) => n.input_key !== before[0]!.input_key)!;
			assert.equal(JSON.parse(newNode.content_json).label, "resolved", "with the knob lowered, the wrap-up plus green make resolves");

			const reviseEdges = (await db
				.prepare("SELECT * FROM analysis_edges WHERE from_node_id = ? AND edge_kind = 'revises'")
				.all(newNode.id)) as unknown as Array<Record<string, unknown>>;
			assert.equal(reviseEdges.length, 1, "a revises edge links the revision to its predecessor");
		} finally {
			await close();
		}
	});
});
