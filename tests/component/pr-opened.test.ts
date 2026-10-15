/**
 * Component tests for the pr-opened analyzer, exercised end-to-end through the
 * real AnalyzerFramework. No real session data, no network: hand-written
 * synthetic rows. The analyzer never touches the LLM seam; the mock LLM exists
 * only to satisfy the framework's construction and prove the analyzer stays
 * deterministic.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	tempDb,
	insertSession,
	insertMessages,
	mockFramework,
	readAnalyzerNodes,
	nodeEdges,
	runAnalyzerOverSession,
	expectPlainRerunIsNoOpFill,
	expectConfigChangeRevises,
	type TestMessage,
} from "./helpers.js";
import { prOpenedAnalyzer } from "../../src/analyze/analyzers/pr-opened/index.js";

const ANALYZER_ID = "pr-opened";
const URL = "https://github.com/acme/widgets/pull/42";

/** A session that opened one pull request and said so in its answer. */
function openedOne(): TestMessage[] {
	return [
		{ role: "user", text: "Open the pull request for this fix." },
		{
			role: "assistant",
			stopReason: "toolUse",
			toolCalls: [
				{
					id: "p1",
					name: "bash",
					arguments: { command: `gh pr create --title "fix: stop the cache going stale" --body "x"` },
				},
			],
		},
		{
			role: "toolResult",
			text: `Creating pull request for fix into main in acme/widgets\n\n${URL}\n`,
			toolResults: [{ toolCallId: "p1", toolName: "bash", isError: false, textLength: 90 }],
		},
		{ role: "assistant", text: `Opened ${URL} and the checks are running.` },
	];
}

/** A session whose only pull request URL came from reading a document. */
function readOnly(): TestMessage[] {
	return [
		{ role: "user", text: "What does the README say about the workflow?" },
		{
			role: "assistant",
			stopReason: "toolUse",
			toolCalls: [{ id: "r1", name: "bash", arguments: { command: "cat README.md" } }],
		},
		{
			role: "toolResult",
			text: `See ${URL} for the example.`,
			toolResults: [{ toolCallId: "r1", toolName: "bash", isError: false, textLength: 40 }],
		},
		{ role: "assistant", text: "It points at an example pull request." },
	];
}

interface NodeContent {
	session_id: string;
	pull_request: {
		url: string;
		host: string;
		owner: string;
		repo: string;
		number: number;
		title: string | null;
		via: string;
		call_message_id: string;
		result_message_id: string;
	};
}

async function runAndRead(db: import("better-sqlite3").Database, sessionId: string, messages: TestMessage[]) {
	await insertSession(db, sessionId);
	const ids = await insertMessages(db, sessionId, messages);
	const fw = mockFramework(db);
	await fw.register(prOpenedAnalyzer);
	const summary = await fw.run(sessionId, {});
	assert.equal(summary.errors.length, 0, `run should have no errors: ${summary.errors.join("; ")}`);
	const nodes = await readAnalyzerNodes(db, ANALYZER_ID);
	return { ids, nodes };
}

describe("pr-opened component test", () => {
	it("records the URL and title of the pull request the session opened", async () => {
		const { db, close } = await tempDb();
		try {
			const { ids, nodes } = await runAndRead(db, "pr-one", openedOne());
			assert.equal(nodes.length, 1, "one node per pull request");
			assert.equal(nodes[0]!.node_kind, "metric");
			const content = JSON.parse(nodes[0]!.content_json) as NodeContent;
			assert.equal(content.session_id, "pr-one");
			assert.deepEqual(content.pull_request, {
				url: URL,
				host: "github.com",
				owner: "acme",
				repo: "widgets",
				number: 42,
				title: "fix: stop the cache going stale",
				via: "gh_pr_create",
				call_message_id: ids[1],
				result_message_id: ids[2],
			});

			// The label anchors the session and both rows it was read from.
			const edges = await nodeEdges(db, nodes[0]!.id);
			const anchors = edges.filter((e) => e["edge_kind"] === "anchors");
			assert.equal(anchors.filter((e) => e["to_ref_kind"] === "session").length, 1);
			assert.ok(anchors.find((e) => e["to_ref_id"] === ids[1]), "the call it was read from");
			assert.ok(anchors.find((e) => e["to_ref_id"] === ids[2]), "the result it was read from");

			const proposals = (await db
				.prepare("SELECT COUNT(*) AS c FROM proposals WHERE analyzer_id = 'pr-opened'")
				.get()) as unknown as { c: number };
			assert.equal(proposals.c, 0, "pr-opened never materialises proposals");
		} finally {
			await close();
		}
	});

	it("plans nothing for a session that only read a pull request URL", async () => {
		const { db, close } = await tempDb();
		try {
			const nodes = await runAnalyzerOverSession(db, prOpenedAnalyzer, "pr-read-only", readOnly());
			assert.equal(nodes.length, 0, "reading a URL is not opening a pull request");
		} finally {
			await close();
		}
	});

	it("plans nothing for an empty transcript", async () => {
		const { db, close } = await tempDb();
		try {
			const nodes = await runAnalyzerOverSession(db, prOpenedAnalyzer, "pr-empty", []);
			assert.equal(nodes.length, 0);
		} finally {
			await close();
		}
	});

	it("re-running the same recipe is idempotent: no new nodes, keys unchanged", async () => {
		const { db, close } = await tempDb();
		try {
			await expectPlainRerunIsNoOpFill(db, prOpenedAnalyzer, "pr-idem", openedOne());
		} finally {
			await close();
		}
	});

	it("changing a config knob marks the node stale for `config` and revises beside it", async () => {
		const { db, close } = await tempDb();
		try {
			// Naming the creation tool as a shell tool changes nothing about this
			// session's detection, but it is a different recipe: the unit goes stale
			// for `config` and the same pull request is recorded again beside its
			// predecessor.
			const { before, after } = await expectConfigChangeRevises(db, prOpenedAnalyzer, "pr-config", openedOne(), {
				maxTitleChars: 10,
			});
			assert.equal((JSON.parse(before[0]!.content_json) as NodeContent).pull_request.title, "fix: stop the cache going stale");

			const newNode = after.find((n) => n.input_key !== before[0]!.input_key)!;
			assert.equal(
				(JSON.parse(newNode.content_json) as NodeContent).pull_request.title,
				"fix: stop ",
				"the shorter cap is applied by the recomputed recipe",
			);
		} finally {
			await close();
		}
	});
});
