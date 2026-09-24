/**
 * Component test for context-economy's dollar carry reporting (issue #78).
 *
 * Seeds a session with one big early read re-billed across later billed turns,
 * some of which carry a per-bucket cost breakdown (input/output/cacheRead/
 * cacheWrite dollars) and one of which does not — then asserts, with all
 * expected numbers hand-computed:
 *
 *   - carryUsd is priced from cacheRead dollars specifically (the result's own
 *     tokens × each carry turn's implied cacheRead $/token), not from a single
 *     billed total;
 *   - turns lacking the breakdown are excluded and counted, never zero-priced;
 *   - the token-turn figure survives alongside the dollar figure, and the
 *     proposal title/evidence surface "($X)";
 *   - an idempotent re-run through the framework recomputes nothing.
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

async function setUsage(
	db: AsyncDatabase,
	id: string,
	buckets: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number },
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } | null,
): Promise<void> {
	await db.prepare("UPDATE messages SET usage = ? WHERE id = ?").run(
		JSON.stringify(cost ? { ...buckets, cost } : buckets),
		id,
	);
}

/** One big read (35 000 chars → 10 000 tokens) trailed by four billed assistant turns. */
async function seedCarrySession(t: TempDb, sid: string): Promise<void> {
	await insertSession(t.db, sid);
	await insertMessages(t.db, sid, [
		{ id: "u0", role: "user", text: "do a thing" },
		{ id: "a1", role: "assistant", text: "reading", toolCalls: [{ name: "read", arguments: { path: "/big.ts" } }] },
		{ id: "r1", role: "toolResult", toolResults: [{ toolName: "read", isError: false, textLength: 35000 }] },
		{ id: "a2", role: "assistant", text: "working" },
		{ id: "a3", role: "assistant", text: "working more" },
		{ id: "a4", role: "assistant", text: "finishing" },
	]);
}

describe("context-economy dollar carry (#78)", () => {
	it("prices carryUsd from per-bucket cacheRead dollars across the carry window, excluding unpriced turns", async () => {
		const t: TempDb = await tempDb();
		try {
			const sid = "s-carry-usd";
			await seedCarrySession(t, sid);

			// Billed turn 1 (a1): priced. Its window contribution to r1's carry is
			// zero (r1 sits after it), but it exercises the multi-turn window.
			await setUsage(t.db, "a1",
				{ input: 1200, output: 50, cacheRead: 100_000, cacheWrite: 300, totalTokens: 101_550 },
				{ input: 0.0048, output: 0.0001, cacheRead: 0.03, cacheWrite: 0.0012, total: 0.0361 });
			// Billed turn 2 (a2): cacheRead $0.03 over 100 000 tokens → rate 3e-7.
			await setUsage(t.db, "a2",
				{ input: 100, output: 50, cacheRead: 100_000, cacheWrite: 0, totalTokens: 100_150 },
				{ input: 0.0004, output: 0.0001, cacheRead: 0.03, cacheWrite: 0, total: 0.0305 });
			// Billed turn 3 (a3): cacheRead $0.02 over 200 000 tokens → rate 1e-7.
			await setUsage(t.db, "a3",
				{ input: 100, output: 50, cacheRead: 200_000, cacheWrite: 0, totalTokens: 200_150 },
				{ input: 0.0004, output: 0.0001, cacheRead: 0.02, cacheWrite: 0, total: 0.0205 });
			// Billed turn 4 (a4): NO per-bucket breakdown — excluded and counted.
			await setUsage(t.db, "a4",
				{ input: 100, output: 50, cacheRead: 150_000, cacheWrite: 0, totalTokens: 150_150 },
				null);

			const mock = createMockLLM({ responder: () => "{}", tokensPerCall: 0, costPerCall: 0 });
			const fw = new AnalyzerFramework({
				db: t.db,
				llm: mock.caller,
				modelTiers: DEFAULT_MODEL_TIERS,
				configOverrides: { "context-economy": { highCarryTokenTurns: 1000 } },
			});
			const { errors } = await registerAll(fw, { builtins: [contextEconomyAnalyzer] });
			assert.deepEqual(errors, [], JSON.stringify(errors));

			const summary = await fw.run(sid, { analyzerIds: ["context-economy"] });
			assert.equal(summary.errors.length, 0, summary.errors.join("; "));

			const row = await t.db
				.prepare("SELECT content_json FROM analysis_nodes WHERE analyzer_id = 'context-economy'")
				.get() as { content_json: string } | undefined;
			assert.ok(row, "produced a node");
			const c = JSON.parse(row!.content_json);

			// ── token-turn math unchanged: 10 000 tok × 3 billed turns after = 30 000 ──
			assert.equal(c.carry.totalTokenTurns, 30_000);
			assert.equal(c.carry.byTool.read, 30_000);

			// ── dollar math: only a2 + a3 are priced ──
			//   10 000 × (0.03 / 100_000) = 0.003
			//   10 000 × (0.02 / 200_000) = 0.001
			//   → carryUsd = 0.004 exactly. a4 contributes NOTHING (not zero-priced).
			assert.equal(c.flags.filter((f: { kind: string }) => f.kind === "high-carry-result").length, 1);
			const highCarry = c.flags.find((f: { kind: string }) => f.kind === "high-carry-result");
			assert.equal(highCarry!.carryTokenTurns, 30_000);
			assert.equal(highCarry!.carryUsd, 0.004);

			assert.deepEqual(c.topResults[0], {
				tool: "read",
				tokens: 10_000,
				turnsAfter: 3,
				carryTokenTurns: 30_000,
				carryUsd: 0.004,
				ordinal: 2,
			});

			assert.equal(c.carry.totalCarryUsd, 0.004);
			assert.equal(c.carry.pricedTurns, 2, "a2 + a3 priced");
			assert.equal(c.carry.unpricedTurns, 1, "a4 excluded-and-counted");

			// ── proposal carries ($X) where the token-turn figure appears ──
			const proposal = c.improvement_proposals.find((p: { title: string }) =>
				p.title.includes("result at ordinal"),
			);
			assert.ok(proposal, "high-carry proposal emitted");
			for (const field of ["title", "summary", "evidence"] as const) {
				assert.ok(proposal![field].includes("($0.0040)"), `${field} carries the ($X) figure: ${proposal![field]}`);
				assert.match(proposal![field], /30[,\s\u00a0\u202f]000 token-turns/, `${field} keeps the token-turn figure: ${proposal![field]}`);
			}
			assert.ok(!proposal!.evidence.includes("no per-bucket cost"), "priced proposal does not claim missing cost");
		} finally {
			t.close();
		}
	});

	it("reports null dollars and says so when no carry turn has a per-bucket breakdown", async () => {
		const t: TempDb = await tempDb();
		try {
			const sid = "s-carry-unpriced";
			await seedCarrySession(t, sid);
			for (const id of ["a1", "a2", "a3", "a4"]) {
				await setUsage(t.db, id,
					{ input: 1200, output: 50, cacheRead: 100_000, cacheWrite: 0, totalTokens: 101_250 },
					null);
			}

			const mock = createMockLLM({ responder: () => "{}", tokensPerCall: 0, costPerCall: 0 });
			const fw = new AnalyzerFramework({
				db: t.db,
				llm: mock.caller,
				modelTiers: DEFAULT_MODEL_TIERS,
				configOverrides: { "context-economy": { highCarryTokenTurns: 1000 } },
			});
			const { errors } = await registerAll(fw, { builtins: [contextEconomyAnalyzer] });
			assert.deepEqual(errors, [], JSON.stringify(errors));

			const summary = await fw.run(sid, { analyzerIds: ["context-economy"] });
			assert.equal(summary.errors.length, 0, summary.errors.join("; "));

			const row = await t.db
				.prepare("SELECT content_json FROM analysis_nodes WHERE analyzer_id = 'context-economy'")
				.get() as { content_json: string } | undefined;
			assert.ok(row, "produced a node");
			const c = JSON.parse(row!.content_json);

			// Token-turns still computed; dollars honestly absent, never zero.
			assert.equal(c.carry.totalTokenTurns, 30_000);
			assert.equal(c.carry.totalCarryUsd, null);
			assert.equal(c.carry.pricedTurns, 0);
			assert.equal(c.carry.unpricedTurns, 3);

			const highCarry = c.flags.find((f: { kind: string }) => f.kind === "high-carry-result");
			assert.equal(highCarry!.carryUsd, null);

			const proposal = c.improvement_proposals.find((p: { title: string }) =>
				p.title.includes("result at ordinal"),
			);
			assert.ok(proposal, "high-carry proposal still emitted on token-turns alone");
			assert.ok(!proposal!.title.includes("$"), `unpriced proposal title carries no dollar figure: ${proposal!.title}`);
			assert.ok(proposal!.evidence.includes("no per-bucket cost recorded to price dollars"), proposal!.evidence);
		} finally {
			t.close();
		}
	});

	it("idempotent re-run through the framework: no new node, no changed result", async () => {
		const t: TempDb = await tempDb();
		try {
			const sid = "s-carry-usd-idempotent";
			await seedCarrySession(t, sid);
			await setUsage(t.db, "a1",
				{ input: 1200, output: 50, cacheRead: 100_000, cacheWrite: 300, totalTokens: 101_550 },
				{ input: 0.0048, output: 0.0001, cacheRead: 0.03, cacheWrite: 0.0012, total: 0.0361 });
			await setUsage(t.db, "a2",
				{ input: 100, output: 50, cacheRead: 100_000, cacheWrite: 0, totalTokens: 100_150 },
				{ input: 0.0004, output: 0.0001, cacheRead: 0.03, cacheWrite: 0, total: 0.0305 });

			const mkFramework = () => {
				const mock = createMockLLM({ responder: () => "{}", tokensPerCall: 0, costPerCall: 0 });
				const fw = new AnalyzerFramework({
					db: t.db,
					llm: mock.caller,
					modelTiers: DEFAULT_MODEL_TIERS,
					configOverrides: { "context-economy": { highCarryTokenTurns: 1000 } },
				});
				return registerAll(fw, { builtins: [contextEconomyAnalyzer] }).then(() => fw);
			};

			const fw1 = await mkFramework();
			const first = await fw1.run(sid, { analyzerIds: ["context-economy"] });
			assert.equal(first.errors.length, 0, first.errors.join("; "));
			assert.equal(first.nodesProduced, 1);

			const before = await t.db
				.prepare("SELECT COUNT(*) AS n, GROUP_CONCAT(output_key) AS keys FROM analysis_nodes WHERE analyzer_id = 'context-economy'")
				.get() as { n: number; keys: string };

			const fw2 = await mkFramework();
			const second = await fw2.run(sid, { analyzerIds: ["context-economy"] });
			assert.equal(second.errors.length, 0, second.errors.join("; "));
			assert.equal(second.nodesProduced, 0, "already-current unit → nothing recomputed");

			const after = await t.db
				.prepare("SELECT COUNT(*) AS n, GROUP_CONCAT(output_key) AS keys FROM analysis_nodes WHERE analyzer_id = 'context-economy'")
				.get() as { n: number; keys: string };
			assert.equal(after.n, before.n);
			assert.equal(after.keys, before.keys, "output key identical → same node content");
		} finally {
			t.close();
		}
	});
});
