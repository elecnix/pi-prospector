import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createThrowingLLM } from "../../src/analyze/mock-llm.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import { computeConfigHash, computeSourceSetHash } from "../../src/analyze/input-hash.js";
import type { AsyncDatabase } from "../../src/db/async-db.js";
import type { Analyzer, AnalysisUnit, AnalyzerPlanContext, SourceRef } from "../../src/analyze/types.js";

/**
 * Lineage follows the subject of a unit, not its source set (DESIGN.md,
 * "Subject"). A session-level unit that reads every message gets a new source
 * set when the session grows; its new node must revise the node drawn from the
 * shorter session, so the current generation holds one node per subject.
 */

function frameworkFor(db: AsyncDatabase): AnalyzerFramework {
	return new AnalyzerFramework({ db, llm: createThrowingLLM(), modelTiers: DEFAULT_MODEL_TIERS });
}

function syntheticAnalyzer(
	id: string,
	plan: (ctx: AnalyzerPlanContext) => AnalysisUnit[],
	subjectOfNode?: Analyzer["subjectOfNode"],
): Analyzer {
	const configJson = {};
	return {
		def: { id, label: id, description: "test analyzer", anchorSpan: "session", dependencies: [] },
		version: { analyzerId: id, major: 1, minor: 0, implementationKind: "deterministic", codeRef: "test" },
		prompts: {},
		defaultConfig: { id: `${id}-cfg`, analyzerId: id, configHash: computeConfigHash(configJson), configJson, label: "default" },
		plan,
		analyze: (unit) => ({
			nodeKind: "metric",
			contentJson: { messages: unit.sources.length, finding: unit.meta?.["finding"] ?? null },
			anchorKind: unit.anchorKind,
			anchorRef: unit.anchorRef,
			edges: [{ toRefKind: unit.anchorKind, toRefId: unit.anchorRef, edgeKind: "anchors" }],
		}),
		...(subjectOfNode ? { subjectOfNode } : {}),
	};
}

/** One unit per session whose source set is every message: it changes as the session grows. */
const wholeSession = syntheticAnalyzer("whole-session", (ctx) => {
	const sources: SourceRef[] = ctx.messages.map((m) => ({ kind: "message", id: m.id }));
	return [{ sources, sourceSetHash: computeSourceSetHash(sources), anchorKind: "session", anchorRef: ctx.sessionId }];
});

/** Two findings on the session anchor, each named as its subject, each reading every message. */
function findingsAnalyzer(id: string, named: boolean): Analyzer {
	return syntheticAnalyzer(
		id,
		(ctx) =>
			["alpha", "beta"].map((finding) => {
				const sources: SourceRef[] = [
					{ kind: "term", id: finding },
					...ctx.messages.map((m) => ({ kind: "message" as const, id: m.id })),
				];
				return {
					sources,
					sourceSetHash: computeSourceSetHash(sources),
					anchorKind: "session" as const,
					anchorRef: ctx.sessionId,
					meta: { finding },
					...(named ? { subject: finding } : {}),
				};
			}),
		named ? (content) => (typeof content["finding"] === "string" ? content["finding"] : undefined) : undefined,
	);
}

async function seed(db: AsyncDatabase, id: string): Promise<void> {
	await insertSession(db, id);
	await insertMessages(db, id, [
		{ role: "user", text: "fix the login bug" },
		{ role: "assistant", text: "looking" },
	]);
}

async function grow(db: AsyncDatabase, id: string): Promise<void> {
	await insertMessages(db, id, [
		{ role: "user", text: "also add a test" },
		{ role: "assistant", text: "added" },
	]);
}

async function count(db: AsyncDatabase, view: "live_nodes" | "current_nodes", analyzerId: string, sessionId: string): Promise<number> {
	const row = (await db
		.prepare(`SELECT COUNT(*) AS n FROM ${view} WHERE analyzer_id = ? AND session_id = ? AND node_kind != 'error'`)
		.get(analyzerId, sessionId)) as { n: number };
	return row.n;
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

describe("lineage by subject", () => {
	it("a grown session's new node revises the node drawn from the shorter session", async () => {
		const { db, close } = await tempDb();
		try {
			await seed(db, "s1");
			const fw = frameworkFor(db);
			await fw.register(wholeSession);
			await fw.run("s1", {});
			await grow(db, "s1");
			await tick();
			const second = await fw.run("s1", {});

			assert.equal(second.nodesProduced, 1, "a plain fill computes the grown session");
			assert.equal(second.nodesRevised, 1, "and records the new node as a revision");
			assert.equal(await count(db, "live_nodes", "whole-session", "s1"), 2, "the old node stays: the graph is append-only");
			assert.equal(await count(db, "current_nodes", "whole-session", "s1"), 1, "one current node per subject");
			const head = (await db
				.prepare("SELECT content_json FROM current_nodes WHERE analyzer_id = 'whole-session' AND session_id = 's1'")
				.get()) as { content_json: string };
			assert.equal((JSON.parse(head.content_json) as { messages: number }).messages, 4, "the current node covers the whole session");
		} finally {
			await close();
		}
	});

	it("a fill run at a newer analyzer version on a grown session leaves only the new version current", async () => {
		const { db, close } = await tempDb();
		try {
			await seed(db, "s1");
			const v1 = frameworkFor(db);
			await v1.register(wholeSession);
			await v1.run("s1", {});
			await grow(db, "s1");
			await tick();
			const v2 = frameworkFor(db);
			await v2.register({ ...wholeSession, version: { ...wholeSession.version, major: 2 } });
			const fill = await v2.run("s1", {});

			assert.equal(fill.nodesProduced, 1, "a plain fill computes the grown session");
			assert.equal(await count(db, "current_nodes", "whole-session", "s1"), 1, "one current node per subject");
			const versions = (await db
				.prepare("SELECT COUNT(DISTINCT analyzer_version_id) AS n FROM current_nodes WHERE analyzer_id = 'whole-session' AND session_id = 's1'")
				.get()) as { n: number };
			assert.equal(versions.n, 1, "the older version's node is no longer current");
		} finally {
			await close();
		}
	});

	it("an older analyzer version leaves a subject held by a newer version alone", async () => {
		const { db, close } = await tempDb();
		try {
			await seed(db, "s1");
			const v2 = frameworkFor(db);
			await v2.register({ ...wholeSession, version: { ...wholeSession.version, major: 2 } });
			await v2.run("s1", {});
			await grow(db, "s1");
			await tick();
			const v1 = frameworkFor(db);
			await v1.register(wholeSession);
			const downgraded = await v1.run("s1", {});

			assert.equal(downgraded.nodesProduced, 0, "a downgrade never replaces a newer conclusion, as gradeStale grades it");
			const heads = (await db
				.prepare("SELECT analyzer_version_id AS v FROM current_nodes WHERE analyzer_id = 'whole-session' AND session_id = 's1'")
				.all()) as Array<{ v: string }>;
			assert.deepEqual(heads.map((h) => h.v), ["2.0"]);
		} finally {
			await close();
		}
	});

	it("a corpus-wide term re-judged in another session revises the first verdict", async () => {
		const { db, close } = await tempDb();
		try {
			await seed(db, "s1");
			await seed(db, "s2");
			const termAnalyzer = (major: number): Analyzer => {
				const base = syntheticAnalyzer(
					"term-verdict",
					(ctx) => {
						const sources: SourceRef[] = [{ kind: "term", id: "ugh" }];
						return [{ sources, sourceSetHash: computeSourceSetHash(sources), anchorKind: "session", anchorRef: ctx.sessionId, subject: "ugh" }];
					},
					() => "ugh",
				);
				return { ...base, version: { ...base.version, major } };
			};
			const v1 = frameworkFor(db);
			await v1.register(termAnalyzer(1));
			await v1.run("s1", {});
			const v2 = frameworkFor(db);
			await v2.register(termAnalyzer(2));
			await v2.run("s2", { revise: ["major"] });
			await v2.run("s1", { revise: ["major"] });

			const current = (await db.prepare("SELECT COUNT(*) AS n FROM current_nodes WHERE analyzer_id = 'term-verdict'").get()) as { n: number };
			assert.equal(current.n, 1, "the verdict is about the term, wherever it was judged");
		} finally {
			await close();
		}
	});

	it("a named subject revises only its own predecessor", async () => {
		const { db, close } = await tempDb();
		try {
			await seed(db, "s1");
			const fw = frameworkFor(db);
			await fw.register(findingsAnalyzer("findings", true));
			await fw.run("s1", {});
			await grow(db, "s1");
			await tick();
			await fw.run("s1", {});

			assert.equal(await count(db, "current_nodes", "findings", "s1"), 2, "one current node per finding");
			const edges = (await db
				.prepare(
					`SELECT json_extract(f.content_json, '$.finding') AS from_finding, json_extract(t.content_json, '$.finding') AS to_finding
					 FROM analysis_edges e JOIN analysis_nodes f ON f.id = e.from_node_id JOIN analysis_nodes t ON t.output_key = e.to_ref_id
					 WHERE e.edge_kind = 'revises' ORDER BY from_finding`,
				)
				.all()) as Array<{ from_finding: string; to_finding: string }>;
			assert.deepEqual(edges, [
				{ from_finding: "alpha", to_finding: "alpha" },
				{ from_finding: "beta", to_finding: "beta" },
			]);
		} finally {
			await close();
		}
	});

	it("units that share an anchor without a subject keep the lineage of their source set", async () => {
		const { db, close } = await tempDb();
		try {
			await seed(db, "s1");
			const fw = frameworkFor(db);
			await fw.register(findingsAnalyzer("unnamed", false));
			await fw.run("s1", {});
			await grow(db, "s1");
			await tick();
			const second = await fw.run("s1", {});

			assert.equal(second.nodesRevised, 0, "nothing says which old node a new one replaces");
			assert.equal(await count(db, "current_nodes", "unnamed", "s1"), 4);
		} finally {
			await close();
		}
	});

	it("leaves other sessions' lineages alone", async () => {
		const { db, close } = await tempDb();
		try {
			await seed(db, "s1");
			await seed(db, "s2");
			const fw = frameworkFor(db);
			await fw.register(wholeSession);
			await fw.run("s1", {});
			await fw.run("s2", {});
			await grow(db, "s1");
			await tick();
			await fw.run("s1", {});

			assert.equal(await count(db, "current_nodes", "whole-session", "s1"), 1);
			assert.equal(await count(db, "current_nodes", "whole-session", "s2"), 1);
		} finally {
			await close();
		}
	});
});

describe("dependency reads", () => {
	it("a consumer reads its dependency's current generation only", async () => {
		const { db, close } = await tempDb();
		try {
			await seed(db, "s1");
			const seen: number[] = [];
			const consumer: Analyzer = {
				...syntheticAnalyzer("consumer", (ctx) => {
					const upstream = ctx.dependencyNodes["whole-session"] ?? [];
					seen.push(upstream.length);
					const sources: SourceRef[] = upstream.map((n) => ({ kind: "analysis_node", id: n.output_key }));
					return [{ sources, sourceSetHash: computeSourceSetHash(sources), anchorKind: "session", anchorRef: ctx.sessionId }];
				}),
				def: { id: "consumer", label: "consumer", description: "test consumer", anchorSpan: "session", dependencies: ["whole-session"] },
			};
			const fw = frameworkFor(db);
			await fw.register(wholeSession);
			await fw.register(consumer);
			await fw.run("s1", {});
			await grow(db, "s1");
			await tick();
			await fw.run("s1", {});

			assert.deepEqual(seen, [1, 1], "the superseded generation is not read as a second conclusion");
			assert.equal(await count(db, "current_nodes", "consumer", "s1"), 1);
		} finally {
			await close();
		}
	});
});

describe("lineage repair", () => {
	/** Remove every revises edge and repair record, as a graph written before lineage followed the subject has none. */
	async function forgetLineage(db: AsyncDatabase): Promise<void> {
		await db.prepare("DELETE FROM analysis_edges WHERE edge_kind = 'revises'").run();
		await db.prepare("DELETE FROM lineage_repairs").run();
	}

	/** A framework started after the upgrade: it has repaired nothing yet. */
	async function upgraded(db: AsyncDatabase, ...analyzers: Analyzer[]): Promise<AnalyzerFramework> {
		const fw = frameworkFor(db);
		for (const a of analyzers) await fw.register(a);
		return fw;
	}

	it("links each older current node of a subject to the newest, and is idempotent", async () => {
		const { db, close } = await tempDb();
		try {
			await seed(db, "s1");
			const fw = frameworkFor(db);
			await fw.register(wholeSession);
			await fw.register(findingsAnalyzer("findings", true));
			await fw.run("s1", {});
			await grow(db, "s1");
			await tick();
			await fw.run("s1", {});
			await grow(db, "s1");
			await tick();
			await fw.run("s1", {});
			await forgetLineage(db);
			assert.equal(await count(db, "current_nodes", "whole-session", "s1"), 3, "legacy graph: every generation current");

			const repaired = await (await upgraded(db, wholeSession, findingsAnalyzer("findings", true))).repairLineage();
			assert.deepEqual(repaired, [
				{ analyzerId: "whole-session", edges: 2 },
				{ analyzerId: "findings", edges: 4 },
			]);
			assert.equal(await count(db, "current_nodes", "whole-session", "s1"), 1);
			assert.equal(await count(db, "current_nodes", "findings", "s1"), 2);
			const head = (await db
				.prepare("SELECT content_json FROM current_nodes WHERE analyzer_id = 'whole-session' AND session_id = 's1'")
				.get()) as { content_json: string };
			assert.equal((JSON.parse(head.content_json) as { messages: number }).messages, 6, "the newest generation stays current");

			assert.deepEqual(await (await upgraded(db, wholeSession, findingsAnalyzer("findings", true))).repairLineage(), [], "a second repair appends nothing");
		} finally {
			await close();
		}
	});

	it("repairs each analyzer once, including one registered only on a later run", async () => {
		const { db, close } = await tempDb();
		try {
			await seed(db, "s1");
			const both = frameworkFor(db);
			const findings = findingsAnalyzer("findings", true);
			await both.register(wholeSession);
			await both.register(findings);
			await both.run("s1", {});
			await grow(db, "s1");
			await tick();
			await both.run("s1", {});
			await forgetLineage(db);

			const onlyWhole = frameworkFor(db);
			await onlyWhole.register(wholeSession);
			assert.deepEqual(await onlyWhole.repairLineage(), [{ analyzerId: "whole-session", edges: 1 }]);
			assert.equal(await count(db, "current_nodes", "findings", "s1"), 4, "an analyzer this run did not load keeps its nodes until it is repaired");

			const later = frameworkFor(db);
			await later.register(wholeSession);
			await later.register(findings);
			assert.deepEqual(await later.repairLineage(), [{ analyzerId: "findings", edges: 2 }], "the later run repairs the analyzer it now loads, and only that one");
			assert.equal(await count(db, "current_nodes", "findings", "s1"), 2);
			assert.deepEqual(await later.repairLineage(), [], "and a repaired analyzer is not repaired again");
		} finally {
			await close();
		}
	});

	it("repairs an analyzer before a run writes its nodes, whichever command runs it", async () => {
		const { db, close } = await tempDb();
		try {
			await seed(db, "s1");
			await seed(db, "s2");
			const fw = frameworkFor(db);
			await fw.register(wholeSession);
			await fw.run("s1", {});
			await grow(db, "s1");
			await tick();
			await fw.run("s1", {});
			await forgetLineage(db);

			const later = frameworkFor(db);
			await later.register(wholeSession);
			await later.run("s2", {});
			assert.equal(await count(db, "current_nodes", "whole-session", "s1"), 1, "the legacy duplicates are linked");
			const rows = (await db.prepare("SELECT analyzer_id FROM lineage_repairs").all()) as Array<{ analyzer_id: string }>;
			assert.deepEqual(rows.map((r) => r.analyzer_id), ["whole-session"]);
		} finally {
			await close();
		}
	});

	it("leaves a subject alone when one run wrote two of its nodes", async () => {
		const { db, close } = await tempDb();
		try {
			await seed(db, "s1");
			const fw = frameworkFor(db);
			await fw.register(findingsAnalyzer("unnamed", false));
			await fw.run("s1", {});
			await grow(db, "s1");
			await tick();
			await fw.run("s1", {});
			await forgetLineage(db);

			assert.deepEqual(await (await upgraded(db, findingsAnalyzer("unnamed", false))).repairLineage(), []);
			assert.equal(await count(db, "current_nodes", "unnamed", "s1"), 4);
		} finally {
			await close();
		}
	});
});
