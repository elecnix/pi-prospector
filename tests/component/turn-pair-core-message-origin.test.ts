/**
 * turn-pair-core reads the message-origin node of each turn.
 *
 * A correction or a rebuttal is something the person says to the agent. The same
 * words in a brief an orchestrator wrote, or in a harness notification, say
 * nothing about the agent's work. The fixture in `tests/fixtures/message-origin-core/`
 * is an invented Claude Code transcript where three turns carry the same
 * disputing words, typed, relayed by an agent, and injected by the harness.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { FIXTURES, tempDb } from "./helpers.js";
import { runSync } from "../../src/sync/index.js";
import { ClaudeFileSource } from "../../src/sync/sources/claude-file.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import { createThrowingLLM } from "../../src/analyze/mock-llm.js";
import { messageOriginAnalyzer, MESSAGE_ORIGIN_DEF } from "../../src/analyze/analyzers/message-origin/index.js";
import { turnPairCoreAnalyzer, TURN_PAIR_CORE_DEF, type TurnPairCoreProperties } from "../../src/analyze/analyzers/turn-pair-core/index.js";
import { getEdgesFrom, getNodesByAnalyzer } from "../../src/db/analysis-queries.js";
import type { AsyncDatabase } from "../../src/db/async-db.js";

const ROOT = path.join(FIXTURES, "message-origin-core");
const SESSION = "c0ffee00-0000-4000-a000-0000000000b1";

async function withAnalysis(check: (db: AsyncDatabase, core: Map<string, TurnPairCoreProperties>) => Promise<void>): Promise<void> {
	const { db, close } = await tempDb();
	try {
		const sync = await runSync(db, [new ClaudeFileSource(path.join(ROOT, "claude"))]);
		assert.deepEqual(sync.errors, []);
		const framework = new AnalyzerFramework({ db, llm: createThrowingLLM("deterministic analyzers must not call a model"), modelTiers: DEFAULT_MODEL_TIERS });
		await framework.register(messageOriginAnalyzer);
		await framework.register(turnPairCoreAnalyzer);
		await framework.run(SESSION);
		const rows = await getNodesByAnalyzer(db, TURN_PAIR_CORE_DEF.id, SESSION);
		await check(db, new Map(rows.map((n) => [(JSON.parse(n.content_json) as TurnPairCoreProperties).user_message_id, JSON.parse(n.content_json) as TurnPairCoreProperties])));
	} finally {
		await close();
	}
}

describe("turn-pair-core reads message-origin", () => {
	it("detects a correction and a rebuttal candidate in the person's words only", () =>
		withAnalysis(async (_db, core) => {
			assert.equal(core.get("c01")?.correction_detected, true);
			assert.equal(core.get("c01")?.rebuttal_candidate, true);
			for (const id of ["c03", "c05"]) {
				assert.equal(core.get(id)?.correction_detected, false, `${id}: not the person's words`);
				assert.equal(core.get(id)?.rebuttal_candidate, false, `${id}: not the person's words`);
				assert.equal(core.get(id)?.friction_score, 0, `${id}: no correction weight`);
			}
		}));

	it("records the origin it read on the node", () =>
		withAnalysis(async (_db, core) => {
			assert.deepEqual([core.get("c01")?.origin, core.get("c03")?.origin, core.get("c05")?.origin], ["typed", "agent", "notification"]);
		}));

	it("records the message-origin node as an input, by a consumes edge", () =>
		withAnalysis(async (db) => {
			const origin = (await getNodesByAnalyzer(db, MESSAGE_ORIGIN_DEF.id, SESSION)).find((n) => JSON.parse(n.content_json).user_message_id === "c03");
			const node = (await getNodesByAnalyzer(db, TURN_PAIR_CORE_DEF.id, SESSION)).find((n) => JSON.parse(n.content_json).user_message_id === "c03");
			assert.ok(origin && node);
			assert.ok((await getEdgesFrom(db, node.id)).some((e) => e.edge_kind === "consumes" && e.to_ref_id === origin.output_key));
		}));
});
