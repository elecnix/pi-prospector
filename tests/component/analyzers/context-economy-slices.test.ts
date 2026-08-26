/**
 * Component test for context-economy's slice-aware redundant-read detection
 * (#156): paginated reads of one large file must not flag redundant-read;
 * only genuinely overlapping content reads do. Each case seeds billed turns so
 * carry math runs, but assertions target only the redundant-read flags.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AsyncDatabase } from "../../../src/db/async-db.js";
import { tempDb, insertSession, insertMessages, type TempDb } from "../helpers.js";
import { AnalyzerFramework } from "../../../src/analyze/framework.js";
import { createMockLLM } from "../../../src/analyze/mock-llm.js";
import { registerAll } from "../../../src/analyze/defaults.js";
import { DEFAULT_MODEL_TIERS } from "../../../src/analyze/model-tiers.js";
import { contextEconomyAnalyzer } from "../../../src/analyze/analyzers/context-economy/index.js";

type ReadCall = { name: "read"; arguments: Record<string, unknown> };

function read(path: string, args: Record<string, unknown> = {}): ReadCall {
	return { name: "read", arguments: { path, ...args } };
}

async function runAnalyzer(t: TempDb, sid: string, reads: ReadCall[]): Promise<{ flags: Array<{ kind: string; path?: string; count?: number }> }> {
	await insertSession(t.db, sid);
	const messages = [
		{ id: `${sid}-u0`, role: "user", text: "page through the file" },
		...reads.flatMap((toolCall) => [
			{ role: "assistant", text: "reading", toolCalls: [toolCall] },
			{ role: "toolResult", toolResults: [{ toolName: "read", isError: false, textLength: 350 }] },
		]),
	];
	await insertMessages(t.db, sid, messages);

	// Bill each assistant turn so turnsAfter/carry math is exercised.
	await t.db
		.prepare("UPDATE messages SET usage = ? WHERE session_id = ? AND role = 'assistant'")
		.run(JSON.stringify({ input: 100, output: 10, cacheRead: 1000, cacheWrite: 0, totalTokens: 1200 }), sid);

	const mock = createMockLLM({ responder: () => "{}", tokensPerCall: 0, costPerCall: 0 });
	const fw = new AnalyzerFramework({ db: t.db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
	const { errors } = await registerAll(fw, { builtins: [contextEconomyAnalyzer] });
	assert.deepEqual(errors, [], JSON.stringify(errors));

	const summary = await fw.run(sid, { analyzerIds: ["context-economy"] });
	assert.equal(summary.errors.length, 0, summary.errors.join("; "));

	const row = await t.db
		.prepare("SELECT content_json FROM analysis_nodes WHERE analyzer_id = 'context-economy'")
		.get() as { content_json: string } | undefined;
	assert.ok(row, "produced a node");
	const c = JSON.parse(row!.content_json);
	return { flags: c.flags };
}

describe("context-economy slice-aware redundant reads", () => {
	it("does NOT flag three disjoint slices of one file (issue #156 case 1)", async () => {
		const t = await tempDb();
		try {
			const { flags } = await runAnalyzer(t, "s-disjoint", [
				read("/big.ts", { offset: 0, limit: 200 }),
				read("/big.ts", { offset: 200, limit: 200 }),
				read("/big.ts", { offset: 400, limit: 200 }),
			]);
			const redundant = flags.filter((f) => f.kind === "redundant-read");
			assert.equal(redundant.length, 0, "disjoint slices must not be flagged");
		} finally {
			t.close();
		}
	});

	interface OverlapCase {
		name: string;
		sessionId: string;
		reads: ReadCall[];
		/** Assertion message for the flag count (undefined = default). */
		note?: string;
		/** Whether to also assert the flagged path. */
		expectPath?: boolean;
	}

	const overlapCases: OverlapCase[] = [
		{
			name: "flags two overlapping slices of one file",
			sessionId: "s-overlap",
			reads: [
				read("/big.ts", { offset: 0, limit: 200 }),
				read("/big.ts", { offset: 100, limit: 200 }),
			],
			expectPath: true,
		},
		{
			name: "flags a whole-file read after a slice (overlap detected)",
			sessionId: "s-whole-after",
			reads: [read("/big.ts", { offset: 500, limit: 200 }), read("/big.ts")],
			note: "whole-file read overlaps the earlier slice",
		},
		{
			name: "flags a slice after a whole-file read (overlap detected)",
			sessionId: "s-whole-before",
			reads: [read("/big.ts"), read("/big.ts", { offset: 500, limit: 200 })],
			note: "slice overlaps the earlier whole-file read",
		},
	];

	for (const c of overlapCases) {
		it(c.name, async () => {
			const t = await tempDb();
			try {
				const { flags } = await runAnalyzer(t, c.sessionId, c.reads);
				const redundant = flags.filter((f) => f.kind === "redundant-read");
				assert.equal(redundant.length, 1, c.note);
				if (c.expectPath) assert.equal(redundant[0]!.path, "/big.ts");
				assert.equal(redundant[0]!.count, 2);
			} finally {
				t.close();
			}
		});
	}

	it("idempotent re-run: disjoint-slice session produces no new node on re-analysis", async () => {
		const t = await tempDb();
		try {
			const sid = "s-idempotent";
			await runAnalyzer(t, sid, [
				read("/big.ts", { offset: 0, limit: 200 }),
				read("/big.ts", { offset: 200, limit: 200 }),
			]);
			const before = await t.db
				.prepare("SELECT COUNT(*) AS n FROM analysis_nodes WHERE analyzer_id = 'context-economy'")
				.get() as { n: number };

			const mock = createMockLLM({ responder: () => "{}", tokensPerCall: 0, costPerCall: 0 });
			const fw = new AnalyzerFramework({ db: t.db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
			const { errors } = await registerAll(fw, { builtins: [contextEconomyAnalyzer] });
			assert.deepEqual(errors, [], JSON.stringify(errors));
			const summary = await fw.run(sid, { analyzerIds: ["context-economy"] });
			assert.equal(summary.errors.length, 0, summary.errors.join("; "));
			assert.equal(summary.nodesProduced, 0, "already-correct case is current → nothing recomputed");

			const after = await t.db
				.prepare("SELECT COUNT(*) AS n FROM analysis_nodes WHERE analyzer_id = 'context-economy'")
				.get() as { n: number };
			assert.equal(after.n, before.n);
		} finally {
			t.close();
		}
	});
});
