/**
 * Component test for the deliberation-paragraph feature end to end
 * (issue #104): turn-pair-core measures it, routing-opportunity consumes it,
 * and the version bumps on both analyzers revise cleanly with idempotent re-runs.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createThrowingLLM } from "../../src/analyze/mock-llm.js";
import { turnPairCoreAnalyzer, type TurnPairCoreProperties } from "../../src/analyze/analyzers/turn-pair-core/index.js";
import {
	routingOpportunityAnalyzer,
	type RoutingProperties,
} from "../../src/analyze/analyzers/routing-opportunity/index.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";

/** A thinking-heavy turn (several reasoning paragraphs) with a single tool call. */
async function seed(db: import("better-sqlite3").Database, sessionId: string, withThinking: boolean): Promise<void> {
	await insertSession(db, sessionId);
	await insertMessages(db, sessionId, [
		{ role: "user", text: "add the export" },
		{
			role: "assistant",
			thinking: withThinking ? "first consideration\n\nsecond consideration\n\nthird one\n\nfourth\n\nfifth point to weigh" : undefined,
			text: "here",
			toolCalls: [{ name: "edit" }],
		},
		{ role: "toolResult", toolResults: [{ toolName: "edit", isError: false, textLength: 40 }] },
	]);
}

function framework(db: import("better-sqlite3").Database): AnalyzerFramework {
	return new AnalyzerFramework({ db, llm: createThrowingLLM(), modelTiers: DEFAULT_MODEL_TIERS });
}

const OLD = { minor: 0 };

async function coreNodes(db: import("better-sqlite3").Database): Promise<TurnPairCoreProperties[]> {
	const rows = (await db
		.prepare("SELECT content_json FROM analysis_nodes WHERE analyzer_id = 'turn-pair-core' ORDER BY rowid")
		.all()) as unknown as Array<{ content_json: string }>;
	return rows.map((r) => JSON.parse(r.content_json) as TurnPairCoreProperties);
}

async function routingNodes(db: import("better-sqlite3").Database): Promise<RoutingProperties[]> {
	const rows = (await db
		.prepare("SELECT content_json FROM analysis_nodes WHERE analyzer_id = 'routing-opportunity' ORDER BY rowid")
		.all()) as unknown as Array<{ content_json: string }>;
	return rows.map((r) => JSON.parse(r.content_json) as RoutingProperties);
}

describe("deliberation paragraphs flow into routing labels across a version bump", () => {
	it("revises both analyzers cleanly and lets the feature change the label; re-runs are idempotent", async () => {
		const { db, close } = await tempDb();
		try {
			await seed(db, "s1", true);

			// Fill with pre-bump analyzers (minor: 0), as an older install would have.
			const oldFw = framework(db);
			await oldFw.register({ ...turnPairCoreAnalyzer, version: { ...turnPairCoreAnalyzer.version, ...OLD } });
			await oldFw.register({ ...routingOpportunityAnalyzer, version: { ...routingOpportunityAnalyzer.version, ...OLD } });
			await oldFw.run("s1", {});
			const oldRouting = await routingNodes(db);
			assert.equal(oldRouting.length, 1);

			// The bumped analyzers revise their stale units without crashing.
			const fw = framework(db);
			await fw.register(turnPairCoreAnalyzer);
			await fw.register(routingOpportunityAnalyzer);
			const revised = await fw.run("s1", { revise: ["minor"] });
			assert.ok(revised.nodesRevised >= 1, "the bump marks units for revision");
			assert.equal(revised.errors.length, 0, "revision produced no errors");

			// New core node carries the measurement; new routing node consumes it.
			const core = await coreNodes(db);
			const newestCore = core[core.length - 1]!;
			assert.equal(newestCore.deliberation_paragraphs, 5);
			const routing = await routingNodes(db);
			const newestRouting = routing[routing.length - 1]!;
			assert.equal(newestRouting.features.deliberation_paragraphs, 5);
			// Five deliberation paragraphs outweigh the single tool call: not easy.
			assert.equal(newestRouting.easy, false);
			assert.equal(newestRouting.hard, false);
			assert.equal(newestRouting.verdict, "neutral");

			// Core records revises lineage for the version bump. Routing's source set
			// also changed (it consumes the new core node's output key), so its new
			// label is a fresh recipe — appended beside the old, not revised in place.
			const edges = (await db.prepare("SELECT COUNT(*) AS c FROM analysis_edges WHERE edge_kind = 'revises'").get()) as { c: number };
			assert.ok(edges.c >= 1, "turn-pair-core recorded revises lineage");
			const routingAfterBump = await routingNodes(db);
			assert.equal(routingAfterBump.length, oldRouting.length + 1, "routing gained a node under the new recipe");

			// Idempotent re-run at the new versions adds nothing.
			const rerun = await fw.run("s1", {});
			assert.equal(rerun.nodesProduced + rerun.nodesRevised, 0);
			assert.equal((await coreNodes(db)).length, core.length);
			assert.equal(await routingNodes(db).then((r) => r.length), routingAfterBump.length);
		} finally {
			await close();
		}
	});

	it("an otherwise identical turn without recorded reasoning still downshifts", async () => {
		const { db, close } = await tempDb();
		try {
			await seed(db, "s1", false);
			const fw = framework(db);
			await fw.register(turnPairCoreAnalyzer);
			await fw.register(routingOpportunityAnalyzer);
			const run = await fw.run("s1", {});
			assert.equal(run.errors.length, 0);

			const core = await coreNodes(db);
			assert.equal(core[0]!.deliberation_paragraphs, null, "no reasoning recorded → null, not 0");
			const routing = await routingNodes(db);
			assert.equal(routing[0]!.features.deliberation_paragraphs, null);
			assert.equal(routing[0]!.easy, true, "absence of evidence never blocks easiness");
			assert.equal(routing[0]!.verdict, "downshift");
		} finally {
			await close();
		}
	});
});
