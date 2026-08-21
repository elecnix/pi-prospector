import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createThrowingLLM } from "../../src/analyze/mock-llm.js";
import { getAnalyzerCoverage } from "../../src/db/analysis-queries.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import type { Analyzer, AnalysisUnit } from "../../src/analyze/types.js";
import type { AsyncDatabase } from "../../src/db/async-db.js";

/**
 * A minimal deterministic analyzer: exactly one session-level metric unit, no
 * LLM. The throwing LLM proves it never calls the model. Each test scenario
 * needs two independent analyzers so a "new analyzer ships" transition can be
 * staged against an already-analysed session.
 */
function metricAnalyzer(id: string): Analyzer {
	return {
		def: { id, label: id, description: "one metric per session", anchorSpan: "full_session", dependencies: [] },
		version: { analyzerId: id, major: 1, minor: 0, implementationKind: "deterministic" },
		prompts: {},
		defaultConfig: { id: "", analyzerId: id, configHash: "h", configJson: {}, label: "default" },
		plan: (ctx) =>
			[
				{
					sources: [{ kind: "session", id: ctx.sessionId }],
					// Fold the session into the source set: one logical unit per
					// session, not one corpus-wide unit every session shares.
					sourceSetHash: `${id}:${ctx.sessionId}`,
					anchorKind: "session",
					anchorRef: ctx.sessionId,
				},
			] as AnalysisUnit[],
		analyze: (unit) => ({
			nodeKind: "metric",
			contentJson: { analyzer: id, value: 1 },
			anchorKind: "session",
			anchorRef: unit.anchorRef,
			edges: [],
		}),
	};
}

async function frameworkFor(db: AsyncDatabase, ...analyzers: Analyzer[]): Promise<AnalyzerFramework> {
	const fw = new AnalyzerFramework({ db, llm: createThrowingLLM(), modelTiers: DEFAULT_MODEL_TIERS });
	for (const a of analyzers) await fw.register(a);
	return fw;
}

async function seedSession(db: AsyncDatabase, id: string): Promise<void> {
	await insertSession(db, id);
	await insertMessages(db, id, [
		{ role: "user", text: "fix the login bug" },
		{ role: "assistant", text: "done" },
	]);
}

async function nodeCount(db: AsyncDatabase, analyzerId: string, sessionId?: string): Promise<number> {
	const sql = "SELECT COUNT(*) AS c FROM live_nodes WHERE analyzer_id = ?" + (sessionId ? " AND session_id = ?" : "");
	const params = sessionId ? [analyzerId, sessionId] : [analyzerId];
	return ((await db.prepare(sql).get(...params)) as { c: number }).c;
}

describe("analyzer coverage (#195)", () => {
	it("reports per-analyzer coverage and per-session gaps", async () => {
		const { db, close } = await tempDb();
		try {
			await seedSession(db, "s1");
			await seedSession(db, "s2");
			const fw = await frameworkFor(db, metricAnalyzer("alpha"));
			// Only s1 is analysed, and only by `alpha`.
			const first = await fw.run("s1", { analyzerIds: ["alpha"] });
			assert.equal(first.errors.length, 0);
			await db.prepare("UPDATE sessions SET analyzed_at = ? WHERE id = 's1'").run(new Date().toISOString());

				const coverage = await getAnalyzerCoverage(db, ["alpha", "beta"], { onlyAnalyzed: true });
				assert.equal(coverage.sessionsConsidered, 1, "only analysed sessions are considered");
				const alpha = coverage.perAnalyzer.find((a) => a.analyzerId === "alpha");
				const beta = coverage.perAnalyzer.find((a) => a.analyzerId === "beta");
				assert.ok(alpha && beta);
				assert.equal(alpha.sessionsMissing, 0, "alpha covered s1");
				assert.equal(alpha.sessionsWithNodes, 1, "alpha emitted a node for s1");
				assert.equal(beta.sessionsMissing, 1, "beta has never run on s1");
				assert.equal(coverage.gaps.length, 1);
				assert.equal(coverage.gaps[0]!.sessionId, "s1");
				assert.deepEqual(coverage.gaps[0]!.missingAnalyzers, ["beta"]);
		} finally {
			await close();
		}
	});

	it("targeted backfill adds the missing analyzer's nodes without duplicating existing ones, and a re-run is a no-op", async () => {
		const { db, close } = await tempDb();
		try {
			await seedSession(db, "s1");
			await seedSession(db, "s2");

			// v1 world: only `alpha` exists; both sessions are analysed with it and
			// retired from the unanalysed queue.
			const v1 = await frameworkFor(db, metricAnalyzer("alpha"));
			for (const sid of ["s1", "s2"]) {
				const summary = await v1.run(sid, {});
				assert.equal(summary.errors.length, 0);
			}
			db.prepare("UPDATE sessions SET analyzed_at = ?").run(new Date().toISOString());
			const alphaNodesBefore = await nodeCount(db, "alpha");

			// A new analyzer ships. The unanalysed queue is empty, so a plain fill
			// would never meet it — but coverage sees the gap.
			const v2 = await frameworkFor(db, metricAnalyzer("alpha"), metricAnalyzer("beta"));
			const before = await getAnalyzerCoverage(db, ["alpha", "beta"], { onlyAnalyzed: true });
			assert.equal(before.gaps.length, 2, "every analysed session misses beta");

			// Targeted backfill: run each session only under its missing analyzers —
			// exactly what `--backfill-missing` does.
			let produced = 0;
			for (const gap of before.gaps) {
				const summary = await v2.run(gap.sessionId, { analyzerIds: gap.missingAnalyzers });
				assert.equal(summary.errors.length, 0);
				assert.equal(summary.nodesProduced, 1, "beta adds one node per session");
				assert.equal(summary.nodesSkipped, 0);
				produced += summary.nodesProduced;
			}
			assert.equal(produced, 2);

			// Nothing was duplicated: alpha's nodes are untouched, beta's are new.
			assert.equal(await nodeCount(db, "alpha"), alphaNodesBefore, "existing analyzer gained no nodes");
			assert.equal(await nodeCount(db, "beta"), 2);

			// Coverage is closed, and both a targeted re-run and a plain fill are no-ops.
			const after = await getAnalyzerCoverage(db, ["alpha", "beta"], { onlyAnalyzed: true });
			assert.equal(after.gaps.length, 0, "no coverage gaps remain");
			let rerun = 0;
			for (const sid of ["s1", "s2"]) {
				const targeted = await v2.run(sid, { analyzerIds: ["beta"] });
				const plain = await v2.run(sid, {});
				rerun += targeted.nodesProduced + plain.nodesProduced;
			}
			assert.equal(rerun, 0, "re-runs produce nothing new");

			// A retracted node re-opens coverage: live reads only, so a retracted
			// result is treated as absent and the next backfill recomputes it.
			const anyBeta = db.prepare("SELECT id FROM live_nodes WHERE analyzer_id = 'beta' LIMIT 1").get() as { id: string };
			db.prepare("UPDATE analysis_nodes SET retracted_at = ? WHERE id = ?").run(new Date().toISOString(), anyBeta.id);
			const afterRetract = await getAnalyzerCoverage(db, ["alpha", "beta"], { onlyAnalyzed: true });
			assert.equal(afterRetract.gaps.length, 0, "a recorded run still covers the session");
		} finally {
			await close();
		}
	});

	it("unanalysed sessions are excluded from onlyAnalyzed coverage but visible without the filter", async () => {
		const { db, close } = await tempDb();
		try {
			await seedSession(db, "s1");
			const fw = await frameworkFor(db, metricAnalyzer("alpha"));
			await fw.run("s1", { analyzerIds: ["alpha"] });
			await db.prepare("UPDATE sessions SET analyzed_at = ? WHERE id = 's1'").run(new Date().toISOString());
			await seedSession(db, "s2"); // never analysed

			const analysedOnly = await getAnalyzerCoverage(db, ["alpha"], { onlyAnalyzed: true });
			assert.equal(analysedOnly.sessionsConsidered, 1);
			assert.equal(analysedOnly.gaps.length, 0);

			const all = await getAnalyzerCoverage(db, ["alpha"]);
			assert.equal(all.sessionsConsidered, 2);
			assert.equal(all.gaps.length, 1);
			assert.equal(all.gaps[0]!.sessionId, "s2");
		} finally {
			await close();
		}
	});

	it("respects the source filter and handles an empty analyzer list", async () => {
		const { db, close } = await tempDb();
		try {
			await seedSession(db, "s1");
			db.prepare("UPDATE sessions SET source = 'claude' WHERE id = 's1'").run();
			const fw = await frameworkFor(db, metricAnalyzer("alpha"));
			await fw.run("s1", { analyzerIds: ["alpha"] });

			const pi = await getAnalyzerCoverage(db, ["alpha"], { source: "pi" });
			assert.equal(pi.sessionsConsidered, 0);
			assert.equal(pi.gaps.length, 0);

			const claude = await getAnalyzerCoverage(db, ["alpha"], { source: "claude" });
			assert.equal(claude.sessionsConsidered, 1);
			assert.equal(claude.perAnalyzer[0]!.sessionsMissing, 0);

			const empty = await getAnalyzerCoverage(db, []);
			assert.equal(empty.sessionsConsidered, 1);
			assert.deepEqual(empty.perAnalyzer, []);
			assert.equal(empty.gaps.length, 0, "no analyzers asked, no gaps named");
		} finally {
			await close();
		}
	});
});
