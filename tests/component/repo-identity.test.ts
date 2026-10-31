/**
 * Component tests for the repo-identity analyzer, exercised end-to-end through
 * the real AnalyzerFramework. Hand-written synthetic rows, no network.
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
	type TestMessage,
} from "./helpers.js";
import { repoIdentityAnalyzer, type RepoIdentityProperties } from "../../src/analyze/analyzers/repo-identity/index.js";

const MESSAGES: TestMessage[] = [
	{ role: "user", text: "Fix the build." },
	{ role: "assistant", text: "Done." },
];

async function runIn(db: import("../../src/db/async-db.js").AsyncDatabase, id: string, cwd: string) {
	await insertSession(db, id, `/tmp/${id}.jsonl`, cwd);
	await insertMessages(db, id, MESSAGES);
	const fw = mockFramework(db);
	await fw.register(repoIdentityAnalyzer);
	const summary = await fw.run(id, {});
	assert.equal(summary.errors.length, 0, summary.errors.join("; "));
}

describe("repo-identity component test", () => {
	it("gives two worktrees of one repository the same key, anchored to the session", async () => {
		const { db, close } = await tempDb();
		try {
			await runIn(db, "ri-a", "/Users/ana/Source/widgets/main");
			await runIn(db, "ri-b", "/Users/ana/Source/Widgets/feat-x");
			const nodes = await readAnalyzerNodes(db, "repo-identity");
			assert.equal(nodes.length, 2);
			const contents = nodes.map((n) => JSON.parse(n.content_json) as RepoIdentityProperties);
			assert.deepEqual(contents.map((c) => c.repo_key), ["widgets", "widgets"]);
			assert.deepEqual(contents.map((c) => c.checkout).sort(), ["feat-x", "main"]);
			const edges = await nodeEdges(db, nodes[0]!.id);
			assert.equal(edges.filter((e) => e["edge_kind"] === "anchors" && e["to_ref_kind"] === "session").length, 1);
		} finally {
			await close();
		}
	});

	it("records a placement and a null key for a session outside every root", async () => {
		const { db, close } = await tempDb();
		try {
			await runIn(db, "ri-tmp", "/private/tmp/scratch");
			await runIn(db, "ri-none", "");
			const contents = (await readAnalyzerNodes(db, "repo-identity")).map((n) => JSON.parse(n.content_json) as RepoIdentityProperties);
			assert.deepEqual(contents.map((c) => [c.repo_key, c.placement]).sort(), [
				[null, "temp"],
				[null, "unknown"],
			]);
		} finally {
			await close();
		}
	});

	it("a plain re-run adds no node", async () => {
		const { db, close } = await tempDb();
		try {
			await runIn(db, "ri-r", "/Users/ana/Source/widgets/main");
			const before = await readAnalyzerNodes(db, "repo-identity");
			const again = mockFramework(db);
			await again.register(repoIdentityAnalyzer);
			await again.run("ri-r", {});
			assert.equal((await readAnalyzerNodes(db, "repo-identity")).length, before.length, "plain re-run adds nothing");
		} finally {
			await close();
		}
	});
});
