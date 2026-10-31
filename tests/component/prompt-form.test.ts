/**
 * Component tests for the prompt-form analyzer, exercised end-to-end through the
 * real AnalyzerFramework with its dependencies. Hand-written synthetic rows, no
 * network.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages, mockFramework, readAnalyzerNodes, nodeEdges, type TestMessage } from "./helpers.js";
import { turnPairCoreAnalyzer } from "../../src/analyze/analyzers/turn-pair-core/index.js";
import { messageOriginAnalyzer } from "../../src/analyze/analyzers/message-origin/index.js";
import { promptFormAnalyzer, type PromptFormProperties } from "../../src/analyze/analyzers/prompt-form/index.js";

function conversation(): TestMessage[] {
	return [
		{ role: "user", text: "Please fix the failing build." },
		{ role: "assistant", text: "Fixed." },
		{ role: "user", text: "Why did it fail in the first place?" },
		{ role: "assistant", text: "A missing import." },
		{ role: "user", text: "- add a test\n- run the suite\n- report the result" },
		{ role: "assistant", text: "Done." },
	];
}

async function run(db: import("better-sqlite3").Database, id: string, messages: TestMessage[]) {
	await insertSession(db, id);
	await insertMessages(db, id, messages);
	const fw = mockFramework(db);
	await fw.register(turnPairCoreAnalyzer);
	await fw.register(messageOriginAnalyzer);
	await fw.register(promptFormAnalyzer);
	const summary = await fw.run(id, {});
	assert.equal(summary.errors.length, 0, summary.errors.join("; "));
	return fw;
}

describe("prompt-form component test", () => {
	it("folds the typed prompts and consumes the origin and core nodes", async () => {
		const { db, close } = await tempDb();
		try {
			await run(db, "pf-1", conversation());
			const nodes = await readAnalyzerNodes(db, "prompt-form");
			assert.equal(nodes.length, 1);
			assert.equal(nodes[0]!.node_kind, "metric");
			const content = JSON.parse(nodes[0]!.content_json) as PromptFormProperties;
			assert.equal(content.typed_message_count, 3);
			assert.equal(content.kinds.question, 1);
			assert.equal(content.kinds.instruction + content.kinds.correction, 2);
			assert.equal(content.list_count, 1);

			const edges = await nodeEdges(db, nodes[0]!.id);
			assert.equal(edges.filter((e) => e["edge_kind"] === "anchors" && e["to_ref_kind"] === "session").length, 1);
			assert.equal(edges.filter((e) => e["edge_kind"] === "consumes").length, 6, "three origin nodes and three core nodes");
			const proposals = (await db
				.prepare("SELECT COUNT(*) AS c FROM proposals WHERE analyzer_id = 'prompt-form'")
				.get()) as unknown as { c: number };
			assert.equal(proposals.c, 0);
		} finally {
			await close();
		}
	});

	it("does not read a prompt another agent wrote", async () => {
		const { db, close } = await tempDb();
		try {
			await run(db, "pf-agent", [
				{ role: "user", text: "Do the task." },
				{ role: "assistant", text: "Working." },
				{ role: "user", text: "<system-reminder>The task tool was not used recently.</system-reminder>" },
				{ role: "assistant", text: "Noted." },
			]);
			const content = JSON.parse((await readAnalyzerNodes(db, "prompt-form"))[0]!.content_json) as PromptFormProperties;
			assert.equal(content.typed_message_count, 1);
		} finally {
			await close();
		}
	});

	it("a plain re-run is a no-op fill", async () => {
		const { db, close } = await tempDb();
		try {
			const fw = await run(db, "pf-rerun", conversation());
			const before = (await readAnalyzerNodes(db, "prompt-form")).map((n) => n.output_key);
			await fw.run("pf-rerun", {});
			assert.deepEqual((await readAnalyzerNodes(db, "prompt-form")).map((n) => n.output_key), before);
		} finally {
			await close();
		}
	});

	it("gives a session with no user-role message a zero-count node", async () => {
		const { db, close } = await tempDb();
		try {
			await run(db, "pf-agent-only", [
				{ role: "assistant", text: "Scheduled run started." },
				{ role: "assistant", text: "Scheduled run finished." },
			]);
			const nodes = await readAnalyzerNodes(db, "prompt-form");
			assert.equal(nodes.length, 1);
			assert.equal((JSON.parse(nodes[0]!.content_json) as PromptFormProperties).typed_message_count, 0);
		} finally {
			await close();
		}
	});

	it("plans nothing for an empty transcript", async () => {
		const { db, close } = await tempDb();
		try {
			await run(db, "pf-empty", []);
			assert.equal((await readAnalyzerNodes(db, "prompt-form")).length, 0);
		} finally {
			await close();
		}
	});
});
