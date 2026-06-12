import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createThrowingLLM } from "../../src/analyze/mock-llm.js";
import { turnPairCoreAnalyzer } from "../../src/analyze/analyzers/turn-pair-core/index.js";
import { getNodeVersions, getRevisedNode, getRevisions } from "../../src/db/analysis-queries.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import type { Analyzer, AnalysisResult, AnalyzerPlanContext, AnalyzerRunContext } from "../../src/analyze/types.js";

function frameworkFor(db: import("better-sqlite3").Database): AnalyzerFramework {
	return new AnalyzerFramework({ db, llm: createThrowingLLM(), modelTiers: DEFAULT_MODEL_TIERS });
}

function seedSession(db: import("better-sqlite3").Database, id = "s1"): void {
	insertSession(db, id);
	insertMessages(db, id, [
		{ role: "user", text: "fix the login bug" },
		{ role: "assistant", text: "looking", toolCalls: [{ name: "read" }] },
		{ role: "toolResult", toolResults: [{ toolName: "read", isError: true, textLength: 50 }] },
		{ role: "user", text: "no, that's wrong, use the auth module" },
		{ role: "assistant", text: "fixing" },
	]);
}

describe("framework: incremental scan + fill run", () => {
	it("classifies all units as missing, then current after a run", async () => {
		const { db, close } = tempDb();
		try {
			seedSession(db);
			const fw = frameworkFor(db);
			fw.register(turnPairCoreAnalyzer);

			const before = await fw.scan("s1");
			assert.ok(before.length >= 2);
			assert.ok(before.every((c) => c.status === "missing"));

			const summary = await fw.run("s1", {});
			assert.equal(summary.nodesProduced, before.length);
			assert.equal(summary.nodesRevised, 0);

			const after = await fw.scan("s1");
			assert.ok(after.every((c) => c.status === "current"));
		} finally {
			close();
		}
	});

	it("is idempotent: re-running a fill produces nothing new", async () => {
		const { db, close } = tempDb();
		try {
			seedSession(db);
			const fw = frameworkFor(db);
			fw.register(turnPairCoreAnalyzer);
			await fw.run("s1", {});
			const second = await fw.run("s1", {});
			assert.equal(second.nodesProduced, 0);
			assert.ok(second.nodesSkipped > 0);
		} finally {
			close();
		}
	});

	it("deterministic analyzer never calls the LLM", async () => {
		const { db, close } = tempDb();
		try {
			seedSession(db);
			const fw = frameworkFor(db); // throwing LLM
			fw.register(turnPairCoreAnalyzer);
			const summary = await fw.run("s1", {});
			assert.equal(summary.errors.length, 0);
			assert.ok(summary.nodesProduced > 0);
		} finally {
			close();
		}
	});
});

describe("framework: version lineage (revise)", () => {
	it("re-analyses stale units into new versions linked by revises edges", async () => {
		const { db, close } = tempDb();
		try {
			seedSession(db);

			const v1 = frameworkFor(db);
			v1.register(turnPairCoreAnalyzer);
			await v1.run("s1", {});

			// A new major version over the same logical units.
			const v2Analyzer: Analyzer = {
				...turnPairCoreAnalyzer,
				version: { ...turnPairCoreAnalyzer.version, major: 2 },
			};
			const v2 = frameworkFor(db);
			v2.register(v2Analyzer);

			const scan = await v2.scan("s1");
			assert.ok(scan.every((c) => c.status === "stale"));
			assert.ok(scan.every((c) => c.reasons.includes("major")), "a major bump grades as a major reason");

			// A plain fill ignores stale units.
			const fill = await v2.run("s1", {});
			assert.equal(fill.nodesProduced, 0);

			// --revise major re-analyses.
			const reviseRun = await v2.run("s1", { revise: ["major"] });
			assert.ok(reviseRun.nodesProduced > 0);
			assert.equal(reviseRun.nodesRevised, reviseRun.nodesProduced);

			// Both versions coexist for the same logical unit, newest revises oldest.
			const firstUnit = scan[0]!;
			const versions = getNodeVersions(db, "turn-pair-core", firstUnit.unit.sourceSetHash);
			assert.equal(versions.length, 2);

			const newest = versions[versions.length - 1]!;
			const oldest = versions[0]!;
			const revised = getRevisedNode(db, newest.id);
			assert.equal(revised!.id, oldest.id);
			assert.equal(getRevisions(db, oldest.id)[0]!.id, newest.id);
		} finally {
			close();
		}
	});
});

describe("framework: dependency visibility & ordering", () => {
	it("throws when an analyzer reads an undeclared dependency", async () => {
		const { db, close } = tempDb();
		try {
			seedSession(db);
			const sneaky: Analyzer = {
				def: { id: "sneaky", label: "Sneaky", description: "", anchorSpan: "full_session", dependencies: [] },
				version: { analyzerId: "sneaky", major: 1, minor: 0, implementationKind: "deterministic" },
				prompts: {},
				defaultConfig: { id: "", analyzerId: "sneaky", configHash: "h", configJson: {}, label: "default" },
				plan: (_ctx: AnalyzerPlanContext) => [
					{ sources: [{ kind: "session" as const, id: "s1" }], sourceSetHash: "sneaky-ssh", anchorKind: "session" as const, anchorRef: "s1" },
				],
				analyze: (_unit, ctx: AnalyzerRunContext): AnalysisResult => {
					ctx.getDependencyNodes("turn-pair-core"); // not declared → throws
					return { nodeKind: "summary", contentJson: {}, anchorKind: "session", anchorRef: "s1", edges: [] };
				},
			};
			const fw = frameworkFor(db);
			fw.register(sneaky);
			const summary = await fw.run("s1");
			assert.equal(summary.errors.length, 1);
			assert.match(summary.errors[0]!, /without declaring it/);

			// The failure is recorded as an append-only error node (visibility + history),
			// carrying the message.
			const errNode = db
				.prepare("SELECT * FROM analysis_nodes WHERE node_kind = 'error'")
				.get() as { content_json: string; input_key: string } | undefined;
			assert.ok(errNode);
			assert.match(JSON.parse(errNode!.content_json).error, /without declaring it/);

			// But the error node uses a decoupled identity and does NOT occupy the recipe
			// identity, so the unit stays `missing` (not `current`) and will be recomputed.
			const after = (await fw.scan("s1")).filter((c) => c.analyzerId === "sneaky");
			assert.ok(after.length >= 1);
			assert.ok(after.every((c) => c.status === "missing"));
			assert.notEqual(errNode!.input_key, after[0]!.inputKey);
		} finally {
			close();
		}
	});

	it("self-heals: a failed unit stays missing and is recomputed on the next run, keeping the error node", async () => {
		const { db, close } = tempDb();
		try {
			seedSession(db);
			let attempts = 0;
			const flaky: Analyzer = {
				def: { id: "flaky", label: "Flaky", description: "", anchorSpan: "full_session", dependencies: [] },
				version: { analyzerId: "flaky", major: 1, minor: 0, implementationKind: "deterministic" },
				prompts: {},
				defaultConfig: { id: "", analyzerId: "flaky", configHash: "h", configJson: {}, label: "default" },
				plan: (_ctx: AnalyzerPlanContext) => [
					{ sources: [{ kind: "session" as const, id: "s1" }], sourceSetHash: "flaky-ssh", anchorKind: "session" as const, anchorRef: "s1" },
				],
				analyze: (_unit, _ctx: AnalyzerRunContext): AnalysisResult => {
					attempts++;
					if (attempts === 1) throw new Error("transient boom");
					return { nodeKind: "metric", contentJson: { ok: true }, anchorKind: "session", anchorRef: "s1", edges: [] };
				},
			};
			const fw = frameworkFor(db);
			fw.register(flaky);

			const countErr = () => (db.prepare("SELECT COUNT(*) c FROM analysis_nodes WHERE node_kind='error'").get() as { c: number }).c;
			const countOk = () => (db.prepare("SELECT COUNT(*) c FROM analysis_nodes WHERE analyzer_id='flaky' AND node_kind='metric'").get() as { c: number }).c;

			// First run fails: error node recorded, no result, unit still missing.
			const run1 = await fw.run("s1", {});
			assert.equal(run1.errors.length, 1);
			assert.equal(run1.nodesProduced, 0);
			assert.equal(countErr(), 1);
			assert.equal(countOk(), 0);
			const scan1 = (await fw.scan("s1")).filter((c) => c.analyzerId === "flaky");
			assert.ok(scan1.every((c) => c.status === "missing"));

			// Second plain run heals it: result produced, error node retained (append-only).
			const run2 = await fw.run("s1", {});
			assert.equal(run2.errors.length, 0);
			assert.equal(run2.nodesProduced, 1);
			assert.equal(countErr(), 1);
			assert.equal(countOk(), 1);
			const scan2 = (await fw.scan("s1")).filter((c) => c.analyzerId === "flaky");
			assert.ok(scan2.every((c) => c.status === "current"));
		} finally {
			close();
		}
	});

	it("orders analyzers by dependency and detects cycles", () => {
		const { db, close } = tempDb();
		try {
			const fw = frameworkFor(db);
			fw.register(turnPairCoreAnalyzer);
			const order = fw.topologicalSort();
			assert.deepEqual(order, ["turn-pair-core"]);

			const cyclicA: Analyzer = {
				def: { id: "A", label: "A", description: "", anchorSpan: "pair", dependencies: ["B"] },
				version: { analyzerId: "A", major: 1, minor: 0, implementationKind: "deterministic" },
				prompts: {},
				defaultConfig: { id: "", analyzerId: "A", configHash: "h", configJson: {} },
				plan: () => [],
				analyze: () => ({ nodeKind: "metric", contentJson: {}, anchorKind: "session", anchorRef: "s", edges: [] }),
			};
			const cyclicB: Analyzer = { ...cyclicA, def: { ...cyclicA.def, id: "B", dependencies: ["A"] }, version: { analyzerId: "B", major: 1, minor: 0, implementationKind: "deterministic" }, defaultConfig: { id: "", analyzerId: "B", configHash: "h", configJson: {} } };
			fw.register(cyclicA);
			fw.register(cyclicB);
			assert.throws(() => fw.topologicalSort(["A"]), /cycle/i);
		} finally {
			close();
		}
	});
});
