/**
 * Component tests for the file-reads analyzer and its graph output, driven
 * through the real AnalyzerFramework. Hand-written synthetic rows, no network.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages, mockFramework, readAnalyzerNodes, expectPlainRerunIsNoOpFill, type TestMessage } from "./helpers.js";
import { fileReadsAnalyzer, type FileReadsProperties } from "../../src/analyze/analyzers/file-reads/index.js";
import { renderOutputs, resolveOutputs } from "../../src/analyze/outputs.js";

let n = 0;
function readOf(path: string, chars = 400): TestMessage[] {
	const id = `call-${n++}`;
	return [
		{ role: "assistant", toolCalls: [{ id, name: "read", arguments: { path } }] },
		{ role: "toolResult", toolResults: [{ toolCallId: id, toolName: "read", isError: false, textLength: chars }] },
	];
}

function sessionReading(...paths: string[]): TestMessage[] {
	return [{ role: "user", text: "Go." }, ...paths.flatMap((p) => readOf(p))];
}

describe("file-reads component test", () => {
	it("stores the session's reads relative to its working directory", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "fr-1", "/tmp/fr-1.jsonl", "/work/app");
			await insertMessages(db, "fr-1", sessionReading("/work/app/AGENTS.md", "src/a.ts", "/home/u/notes.md"));
			const fw = mockFramework(db);
			await fw.register(fileReadsAnalyzer);
			await fw.run("fr-1", {});
			const [node] = await readAnalyzerNodes(db, "file-reads");
			assert.equal(node!.node_kind, "metric");
			const content = JSON.parse(node!.content_json) as FileReadsProperties;
			assert.equal(content.cwd, "/work/app");
			assert.deepEqual(content.reads.map((r) => [r.path, r.in_repo, r.rank]), [["AGENTS.md", true, 1], ["src/a.ts", true, 2], ["/home/u/notes.md", false, 3]]);
		} finally {
			await close();
		}
	});

	it("a plain re-run is a no-op fill", async () => {
		const { db, close } = await tempDb();
		try {
			await expectPlainRerunIsNoOpFill(db, fileReadsAnalyzer, "fr-rerun", sessionReading("a.ts"));
		} finally {
			await close();
		}
	});

	it("the graph output folds sessions of one directory into one repository", async () => {
		const { db, close } = await tempDb();
		try {
			const fw = mockFramework(db);
			await fw.register(fileReadsAnalyzer);
			for (const id of ["fr-a", "fr-b", "fr-c"]) {
				await insertSession(db, id, `/tmp/${id}.jsonl`, "/work/app");
				await insertMessages(db, id, sessionReading("AGENTS.md", "src/core.ts"));
				await fw.run(id, {});
			}
			const [result] = await renderOutputs(resolveOutputs([fileReadsAnalyzer], "file-reads:graph"), { db, options: {} });
			const byName = new Map(result!.artifacts.map((a) => [a.filename, a.content]));
			assert.deepEqual([...byName.keys()], ["file-reads-files.csv", "file-reads-edges.csv", "file-reads-report.md"]);
			assert.match(byName.get("file-reads-files.csv")!, /^dir:\/work\/app,AGENTS\.md,3,3,3,3,1,400,1\.00,0$/m);
			assert.match(byName.get("file-reads-edges.csv")!, /^dir:\/work\/app,\(session start\),AGENTS\.md,3,3$/m);
			assert.match(byName.get("file-reads-report.md")!, /`AGENTS\.md`: among the first 5 files in 3 of 3 sessions \(100%\)/);
		} finally {
			await close();
		}
	});

	it("the graph output refuses a repo filter that matches nothing", async () => {
		const { db, close } = await tempDb();
		try {
			await assert.rejects(renderOutputs(resolveOutputs([fileReadsAnalyzer], "file-reads:graph"), { db, options: { repo: "nope" } }), /No repository key contains 'nope'/);
		} finally {
			await close();
		}
	});
});
