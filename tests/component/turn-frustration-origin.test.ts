/**
 * turn-frustration labels where each hit's words came from.
 *
 * The fixtures in `tests/fixtures/text-origin/` are invented pi and Claude Code
 * transcripts. Each turn carries one frustration word in one kind of text:
 * typed, quoted, pasted, signed by an agent, injected by the harness, or copied
 * by a fork. The sync reads them with the real parsers, the framework runs the
 * real analyzers, and every hit must carry the label of the text it matched.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { FIXTURES, lexiconMock, tempDb } from "./helpers.js";
import { runSync } from "../../src/sync/index.js";
import { PiFileSource } from "../../src/sync/sources/pi-file.js";
import { ClaudeFileSource } from "../../src/sync/sources/claude-file.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import { turnPairCoreAnalyzer } from "../../src/analyze/analyzers/turn-pair-core/index.js";
import { messageOriginAnalyzer } from "../../src/analyze/analyzers/message-origin/index.js";
import { lexiconCandidatesAnalyzer } from "../../src/analyze/analyzers/lexicon-candidates/index.js";
import { frustrationLexiconAnalyzer } from "../../src/analyze/analyzers/frustration-lexicon/index.js";
import {
	turnFrustrationAnalyzer,
	TURN_FRUSTRATION_DEF,
	type TurnFrustrationProperties,
} from "../../src/analyze/analyzers/turn-frustration/index.js";
import { getNodesByAnalyzer } from "../../src/db/analysis-queries.js";
import type { AsyncDatabase } from "../../src/db/async-db.js";

const ROOT = path.join(FIXTURES, "text-origin");
const PI_PARENT = "0190aaaa-0000-7000-8000-000000000001";
const PI_FORK = "0190aaaa-0000-7000-8000-000000000002";
const CLAUDE = "c0ffee00-0000-4000-a000-000000000001";
const CLAUDE_CHILD = "agent-a0001";

const FRUSTRATED = new Set(["wrong", "broken", "garbage", "useless", "awful", "terrible", "stupid"]);

/** Sync both fixture trees and run the lexicon pipeline over every session. */
async function analyzeFixtures(db: AsyncDatabase): Promise<void> {
	const sync = await runSync(db, [new PiFileSource(path.join(ROOT, "pi")), new ClaudeFileSource(path.join(ROOT, "claude"))]);
	assert.deepEqual(sync.errors, []);
	const framework = new AnalyzerFramework({ db, llm: lexiconMock(FRUSTRATED).caller, modelTiers: DEFAULT_MODEL_TIERS });
	await framework.register(turnPairCoreAnalyzer);
	await framework.register(messageOriginAnalyzer);
	await framework.register(lexiconCandidatesAnalyzer);
	await framework.register(frustrationLexiconAnalyzer);
	await framework.register(turnFrustrationAnalyzer);
	for (const id of [PI_PARENT, PI_FORK, CLAUDE, CLAUDE_CHILD]) await framework.run(id);
}

/** Run `check` against a fresh database holding the analysed fixtures. */
async function withFixtures(check: (db: AsyncDatabase) => Promise<void>): Promise<void> {
	const { db, close } = await tempDb();
	try {
		await analyzeFixtures(db);
		await check(db);
	} finally {
		await close();
	}
}

async function hits(db: AsyncDatabase, sessionId: string): Promise<TurnFrustrationProperties[]> {
	return (await getNodesByAnalyzer(db, TURN_FRUSTRATION_DEF.id, sessionId)).map(
		(n) => JSON.parse(n.content_json) as TurnFrustrationProperties,
	);
}

/** The hit for one term on one turn. */
function hitOn(found: TurnFrustrationProperties[], messageId: string, signal: string): TurnFrustrationProperties {
	const hit = found.find((h) => h.user_message_id === messageId && h.signal === signal);
	assert.ok(hit, `expected a '${signal}' hit on ${messageId}; got ${JSON.stringify(found.map((h) => [h.user_message_id, h.signal]))}`);
	return hit;
}

describe("turn-frustration text origin", () => {
	it("labels each pi hit with the origin of the text it matched", () =>
		withFixtures(async (db) => {
			const parent = await hits(db, PI_PARENT);
			assert.equal(hitOn(parent, "p03", "broken").origin, "quoted");
			assert.equal(hitOn(parent, "p05", "garbage").origin, "pasted");
			assert.equal(hitOn(parent, "p07", "useless").origin, "agent");
			assert.equal(hitOn(parent, "p09", "awful").origin, "notification");
			assert.equal(hitOn(parent, "p11", "terrible").origin, "typed");
		}));

	it("splits one message that mixes a quote and a reply", () =>
		withFixtures(async (db) => {
			const parent = await hits(db, PI_PARENT);
			const broken = hitOn(parent, "p13", "broken");
			const wrong = hitOn(parent, "p13", "wrong");
			assert.equal(broken.origin, "quoted");
			assert.equal(broken.typed_count, 0);
			assert.deepEqual(broken.origins, { quoted: 1 });
			assert.equal(wrong.origin, "typed");
			assert.equal(wrong.typed_count, 1);
		}));

	it("labels a fork's copy of a parent turn fork-copy, and keeps the fork's own words typed", () =>
		withFixtures(async (db) => {
			const fork = await hits(db, PI_FORK);
			assert.equal(hitOn(fork, "f03", "terrible").origin, "fork-copy");
			assert.equal(hitOn(fork, "f05", "stupid").origin, "typed");
		}));

	it("counts a turn the fork copied under the parent's id once, across both sessions", () =>
		withFixtures(async (db) => {
			const all = [...(await hits(db, PI_PARENT)), ...(await hits(db, PI_FORK))];
			const copies = all.filter((h) => h.user_message_id === "p01" && h.signal === "wrong");
			assert.equal(copies.length, 1, "the index stores a message id once, so its words are counted once");
		}));

	it("labels each Claude Code hit with the origin of the text it matched", () =>
		withFixtures(async (db) => {
			const found = await hits(db, CLAUDE);
			assert.equal(hitOn(found, "c01", "wrong").origin, "typed");
			assert.equal(hitOn(found, "c03", "awful").origin, "notification");
			assert.equal(hitOn(found, "c05", "garbage").origin, "pasted");
			assert.equal(hitOn(found, "c07", "broken").origin, "quoted");
			assert.equal(hitOn(found, "c09", "useless").origin, "agent");
			assert.equal(found.some((h) => h.user_message_id === "c11"), false, "a task notification's words never match");
		}));

	it("labels a child agent's turns agent", () =>
		withFixtures(async (db) => {
			assert.equal(hitOn(await hits(db, CLAUDE_CHILD), "a01", "stupid").origin, "agent");
		}));

	it("keeps every hit and its count: labelling adds a field, it removes nothing", () =>
		withFixtures(async (db) => {
			const parent = await hits(db, PI_PARENT);
			// p01 belongs to whichever of the parent and the fork the sync read first.
			assert.equal(parent.filter((h) => h.signal_source === "lexicon" && h.user_message_id !== "p01").length, 7);
			for (const h of parent) {
				const labelled = Object.values(h.origins).reduce((a, b) => a + (b ?? 0), 0);
				assert.equal(labelled, h.count, `${h.signal} on ${h.user_message_id}: every occurrence carries a label`);
			}
		}));
});
