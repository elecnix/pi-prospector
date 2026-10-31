/**
 * turn-frustration reads the message-origin node of each turn.
 *
 * The span labeller alone sees only tags and blocks. A brief an orchestrator
 * wrote for a worker carries none, and a short terminal capture is too short to
 * count as a paste block. The fixture in `tests/fixtures/message-origin-hits/`
 * is an invented Claude Code transcript with one frustration word in each kind
 * of message, and every hit must take the label the message-origin node gives
 * its message.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { FIXTURES, lexiconMock, tempDb } from "./helpers.js";
import { runSync } from "../../src/sync/index.js";
import { ClaudeFileSource } from "../../src/sync/sources/claude-file.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import { turnPairCoreAnalyzer } from "../../src/analyze/analyzers/turn-pair-core/index.js";
import { messageOriginAnalyzer, MESSAGE_ORIGIN_DEF } from "../../src/analyze/analyzers/message-origin/index.js";
import { lexiconCandidatesAnalyzer } from "../../src/analyze/analyzers/lexicon-candidates/index.js";
import { frustrationLexiconAnalyzer } from "../../src/analyze/analyzers/frustration-lexicon/index.js";
import { turnFrustrationAnalyzer, TURN_FRUSTRATION_DEF, type TurnFrustrationProperties } from "../../src/analyze/analyzers/turn-frustration/index.js";
import { getEdgesFrom, getNodesByAnalyzer } from "../../src/db/analysis-queries.js";
import type { AsyncDatabase } from "../../src/db/async-db.js";

const ROOT = path.join(FIXTURES, "message-origin-hits");
const SESSION = "c0ffee00-0000-4000-a000-0000000000a1";
const FRUSTRATED = new Set(["wrong", "useless", "garbage", "stupid", "broken"]);

async function withAnalysis(check: (db: AsyncDatabase) => Promise<void>): Promise<void> {
	const { db, close } = await tempDb();
	try {
		const sync = await runSync(db, [new ClaudeFileSource(path.join(ROOT, "claude"))]);
		assert.deepEqual(sync.errors, []);
		const framework = new AnalyzerFramework({ db, llm: lexiconMock(FRUSTRATED).caller, modelTiers: DEFAULT_MODEL_TIERS });
		await framework.register(turnPairCoreAnalyzer);
		await framework.register(messageOriginAnalyzer);
		await framework.register(lexiconCandidatesAnalyzer);
		await framework.register(frustrationLexiconAnalyzer);
		await framework.register(turnFrustrationAnalyzer);
		await framework.run(SESSION);
		await check(db);
	} finally {
		await close();
	}
}

async function hitOn(db: AsyncDatabase, messageId: string, signal: string): Promise<TurnFrustrationProperties> {
	const rows = await getNodesByAnalyzer(db, TURN_FRUSTRATION_DEF.id, SESSION);
	const hit = rows.map((n) => JSON.parse(n.content_json) as TurnFrustrationProperties).find((h) => h.user_message_id === messageId && h.signal === signal);
	assert.ok(hit, `expected a '${signal}' hit on ${messageId}`);
	return hit;
}

describe("turn-frustration reads message-origin", () => {
	it("labels each hit with the message's origin when the message is not the person's", () =>
		withAnalysis(async (db) => {
			assert.equal((await hitOn(db, "c01", "wrong")).origin, "typed");
			assert.equal((await hitOn(db, "c03", "useless")).origin, "agent", "a relayed message carries no tag a span rule could see");
			assert.equal((await hitOn(db, "c05", "garbage")).origin, "pasted", "a short capture is no paste block, but the message is a paste");
			assert.equal((await hitOn(db, "c07", "stupid")).origin, "agent");
		}));

	it("keeps the count and the typed count consistent with the label", () =>
		withAnalysis(async (db) => {
			const garbage = await hitOn(db, "c05", "garbage");
			assert.equal(garbage.count, 3);
			assert.deepEqual(garbage.origins, { pasted: 3 });
			assert.equal(garbage.typed_count, 0);
		}));

	it("records the message-origin node as an input, by a consumes edge", () =>
		withAnalysis(async (db) => {
			const origin = (await getNodesByAnalyzer(db, MESSAGE_ORIGIN_DEF.id, SESSION)).find((n) => JSON.parse(n.content_json).user_message_id === "c03");
			const hit = (await getNodesByAnalyzer(db, TURN_FRUSTRATION_DEF.id, SESSION)).find((n) => JSON.parse(n.content_json).user_message_id === "c03");
			assert.ok(origin && hit);
			const edges = await getEdgesFrom(db, hit.id);
			assert.ok(edges.some((e) => e.edge_kind === "consumes" && e.to_ref_id === origin.output_key));
		}));
});
