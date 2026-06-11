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

describe("framework: incremental scan + shallow run", () => {
	it("classifies all units as missing, then current after a run", async () => {
		const { db, close } = tempDb();
		try {
			seedSession(db);
			const fw = frameworkFor(db);
			fw.register(turnPairCoreAnalyzer);

			const before = await fw.scan("s1");
			assert.ok(before.length >= 2);
			assert.ok(before.every((c) => c.status === "missing"));

			const summary = await fw.run("s1", { mode: "shallow" });
			assert.equal(summary.nodesProduced, before.length);
			assert.equal(summary.nodesRevised, 0);

			const after = await fw.scan("s1");
			assert.ok(after.every((c) => c.status === "current"));
		} finally {
			close();
		}
	});

	it("is idempotent: re-running shallow produces nothing new", async () => {
		const { db, close } = tempDb();
		try {
			seedSession(db);
			const fw = frameworkFor(db);
			fw.register(turnPairCoreAnalyzer);
			await fw.run("s1", { mode: "shallow" });
			const second = await fw.run("s1", { mode: "shallow" });
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
			const summary = await fw.run("s1", { mode: "shallow" });
			assert.equal(summary.errors.length, 0);
			assert.ok(summary.nodesProduced > 0);
		} finally {
			close();
		}
	});
});

describe("framework: version lineage (deep mode)", () => {
	it("re-analyses stale units into new versions linked by revises edges", async () => {
		const { db, close } = tempDb();
		try {
			seedSession(db);

			const v1 = frameworkFor(db);
			v1.register(turnPairCoreAnalyzer);
			await v1.run("s1", { mode: "shallow" });

			// A new analyzer version over the same logical units.
			const v2Analyzer: Analyzer = {
				...turnPairCoreAnalyzer,
				version: { ...turnPairCoreAnalyzer.version, versionId: "2.0.0" },
			};
			const v2 = frameworkFor(db);
			v2.register(v2Analyzer);

			const scan = await v2.scan("s1");
			assert.ok(scan.every((c) => c.status === "stale"));

			// Shallow ignores stale.
			const shallow = await v2.run("s1", { mode: "shallow" });
			assert.equal(shallow.nodesProduced, 0);

			// Deep re-analyses.
			const deep = await v2.run("s1", { mode: "deep" });
			assert.ok(deep.nodesProduced > 0);
			assert.equal(deep.nodesRevised, deep.nodesProduced);

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
				version: { analyzerId: "sneaky", versionId: "1.0.0", implementationKind: "deterministic" },
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

			// An error node is recorded so the unit isn't silently retried as missing.
			const errNode = db.prepare("SELECT * FROM analysis_nodes WHERE node_kind = 'error'").get();
			assert.ok(errNode);
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
				version: { analyzerId: "A", versionId: "1", implementationKind: "deterministic" },
				prompts: {},
				defaultConfig: { id: "", analyzerId: "A", configHash: "h", configJson: {} },
				plan: () => [],
				analyze: () => ({ nodeKind: "metric", contentJson: {}, anchorKind: "session", anchorRef: "s", edges: [] }),
			};
			const cyclicB: Analyzer = { ...cyclicA, def: { ...cyclicA.def, id: "B", dependencies: ["A"] }, version: { analyzerId: "B", versionId: "1", implementationKind: "deterministic" }, defaultConfig: { id: "", analyzerId: "B", configHash: "h", configJson: {} } };
			fw.register(cyclicA);
			fw.register(cyclicB);
			assert.throws(() => fw.topologicalSort(["A"]), /cycle/i);
		} finally {
			close();
		}
	});
});
