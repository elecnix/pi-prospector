/**
 * Component tests for the repo-identity analyzer, exercised end-to-end through
 * the real AnalyzerFramework. Hand-written synthetic rows, no network.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages, mockFramework, readAnalyzerNodes, nodeEdges, type TestMessage } from "./helpers.js";
import { repoIdentityAnalyzer, type RepoIdentityProperties } from "../../src/analyze/analyzers/repo-identity/index.js";

function step(id: string, command: string, text: string): TestMessage[] {
	return [
		{ role: "assistant", stopReason: "toolUse", toolCalls: [{ id, name: "bash", arguments: { command } }] },
		{ role: "toolResult", text, toolResults: [{ toolCallId: id, toolName: "bash", isError: false, textLength: text.length }] },
	];
}

const withRemote = (): TestMessage[] => [
	{ role: "user", text: "Push this branch." },
	...step("r1", "git remote -v", "origin\tgit@github.com:acme/widgets.git (fetch)\norigin\tgit@github.com:acme/widgets.git (push)"),
	...step("p1", "git push -u origin x", "To github.com:acme/widgets.git\n * [new branch] x -> x"),
];

async function run(db: import("better-sqlite3").Database, id: string, cwd: string, messages: TestMessage[]) {
	await insertSession(db, id, `/tmp/${id}.jsonl`, cwd);
	const ids = await insertMessages(db, id, messages);
	const fw = mockFramework(db);
	await fw.register(repoIdentityAnalyzer);
	const summary = await fw.run(id, {});
	assert.equal(summary.errors.length, 0, summary.errors.join("; "));
	return { ids, fw };
}

describe("repo-identity component test", () => {
	it("gives two worktrees of one repository the same key, anchored to the session and the evidence", async () => {
		const { db, close } = await tempDb();
		try {
			const { ids } = await run(db, "ri-a", "/work/widgets/main", withRemote());
			await run(db, "ri-b", "/work/widgets/feat-x", withRemote());
			const nodes = await readAnalyzerNodes(db, "repo-identity");
			assert.equal(nodes.length, 2);
			const contents = nodes.map((n) => JSON.parse(n.content_json) as RepoIdentityProperties);
			assert.deepEqual(contents.map((c) => c.repo_key), ["github.com/acme/widgets", "github.com/acme/widgets"]);
			assert.deepEqual(contents.map((c) => c.basis), ["remote_output", "remote_output"]);
			assert.deepEqual(contents.map((c) => c.directory).sort(), ["feat-x", "main"]);
			const edges = (await nodeEdges(db, nodes[0]!.id)).filter((e) => e["edge_kind"] === "anchors");
			assert.equal(edges.filter((e) => e["to_ref_kind"] === "session").length, 1);
			assert.ok(edges.find((e) => e["to_ref_id"] === ids[2]), "the result that carried the hint");
		} finally {
			await close();
		}
	});

	it("gives a null key and the basis none to a session with no git command", async () => {
		const { db, close } = await tempDb();
		try {
			await run(db, "ri-none", "/work/widgets/main", [{ role: "user", text: "Explain this." }, { role: "assistant", text: "Sure." }]);
			const content = JSON.parse((await readAnalyzerNodes(db, "repo-identity"))[0]!.content_json) as RepoIdentityProperties;
			assert.equal(content.repo_key, null);
			assert.equal(content.basis, "none");
			assert.equal(content.directory, "main");
		} finally {
			await close();
		}
	});

	it("leaves out a command that ran outside the working directory", async () => {
		const { db, close } = await tempDb();
		try {
			await run(db, "ri-else", "/work/widgets/main", [
				{ role: "user", text: "Check the other repo." },
				...step("e1", "cd /work/other && git push", "To github.com:acme/other.git\n * [new branch] x -> x"),
			]);
			const content = JSON.parse((await readAnalyzerNodes(db, "repo-identity"))[0]!.content_json) as RepoIdentityProperties;
			assert.equal(content.repo_key, null);
		} finally {
			await close();
		}
	});

	it("a plain re-run adds no node, and a changed working directory is a new unit", async () => {
		const { db, close } = await tempDb();
		try {
			const { fw } = await run(db, "ri-r", "/work/widgets/main", withRemote());
			await fw.run("ri-r", {});
			assert.equal((await readAnalyzerNodes(db, "repo-identity")).length, 1);
			await db.prepare("UPDATE sessions SET cwd = '/work/widgets/moved' WHERE id = 'ri-r'").run();
			await fw.run("ri-r", {});
			assert.equal((await readAnalyzerNodes(db, "repo-identity")).length, 2);
		} finally {
			await close();
		}
	});
});
