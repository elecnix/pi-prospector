/**
 * A pi child run is a child agent's session, not a fork (#416).
 *
 * Both record a parent in `parent_session`. A fork copies the parent's history and
 * the person keeps typing in it; a child run's prompts are written by the parent
 * agent. `parent_kind` says which, so readers stop inferring "fork" from the pi
 * source. Synthetic fixtures only.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { lexiconMock, makeTempRoot, messageLine, piSessionFileName, sessionHeaderLine, tempDb, writeJsonl } from "./helpers.js";
import { runSync } from "../../src/sync/index.js";
import { PiFileSource } from "../../src/sync/sources/pi/index.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import { turnPairCoreAnalyzer } from "../../src/analyze/analyzers/turn-pair-core/index.js";
import { messageOriginAnalyzer, MESSAGE_ORIGIN_DEF, type MessageOriginProperties } from "../../src/analyze/analyzers/message-origin/index.js";
import { lexiconCandidatesAnalyzer } from "../../src/analyze/analyzers/lexicon-candidates/index.js";
import { frustrationLexiconAnalyzer } from "../../src/analyze/analyzers/frustration-lexicon/index.js";
import { turnFrustrationAnalyzer, TURN_FRUSTRATION_DEF, type TurnFrustrationProperties } from "../../src/analyze/analyzers/turn-frustration/index.js";
import { getNodesByAnalyzer } from "../../src/db/analysis-queries.js";
import { getChildSessionStats } from "../../src/db/queries.js";
import { sessionFacts } from "../../src/db/fingerprint-queries.js";
import type { AsyncDatabase } from "../../src/db/async-db.js";

const PARENT_ID = "aaaa1111-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const FORK_ID = "bbbb1111-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CHILD_ID = "cccc1111-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const PROJECT = "--Users-test--proj";

/** A parent session, a fork of it the person kept typing in, and a child run its agent started. */
async function withTree(check: (db: AsyncDatabase) => Promise<void>): Promise<void> {
	const { db, close } = await tempDb();
	const fx = makeTempRoot("prospect-child-lineage-");
	try {
		const projectDir = path.join(fx.root, PROJECT);
		const parentFile = piSessionFileName(PARENT_ID);
		writeJsonl(projectDir, parentFile, [sessionHeaderLine(PARENT_ID), messageLine(PARENT_ID, 1, "user", "start the work", "2026-08-19T01:00:05Z")]);
		writeJsonl(projectDir, piSessionFileName(FORK_ID, "2026-08-19T02-00-00"), [
			JSON.stringify({ type: "session", version: 3, id: FORK_ID, timestamp: "2026-08-19T02:00:00.000Z", cwd: "/home/user/proj", parentSession: path.join(projectDir, parentFile) }),
			messageLine(FORK_ID, 1, "user", "this is wrong, try again", "2026-08-19T02:00:05Z"),
		]);
		writeJsonl(path.join(projectDir, parentFile.slice(0, -".jsonl".length), "2b83bd26", "run-0"), "session.jsonl", [
			sessionHeaderLine(CHILD_ID),
			messageLine(CHILD_ID, 1, "user", "this is wrong, try again", "2026-08-19T01:10:05Z"),
		]);
		const sync = await runSync(db, [new PiFileSource(fx.root)]);
		assert.deepEqual(sync.errors, []);
		await check(db);
	} finally {
		await close();
		fx.cleanup();
	}
}

async function analyse(db: AsyncDatabase, sessionId: string): Promise<void> {
	const framework = new AnalyzerFramework({ db, llm: lexiconMock(new Set(["wrong"])).caller, modelTiers: DEFAULT_MODEL_TIERS });
	for (const a of [turnPairCoreAnalyzer, messageOriginAnalyzer, lexiconCandidatesAnalyzer, frustrationLexiconAnalyzer, turnFrustrationAnalyzer]) await framework.register(a);
	await framework.run(sessionId);
}

async function originOf(db: AsyncDatabase, sessionId: string): Promise<string> {
	const [node] = await getNodesByAnalyzer(db, MESSAGE_ORIGIN_DEF.id, sessionId);
	assert.ok(node, `expected a message-origin node on ${sessionId}`);
	const props = JSON.parse(node.content_json) as MessageOriginProperties;
	return `${props.origin}/${props.rule}`;
}

async function hitOriginOf(db: AsyncDatabase, sessionId: string): Promise<string | undefined> {
	const hits = (await getNodesByAnalyzer(db, TURN_FRUSTRATION_DEF.id, sessionId)).map((n) => JSON.parse(n.content_json) as TurnFrustrationProperties);
	const hit = hits.find((h) => h.signal === "wrong");
	assert.ok(hit, `expected a 'wrong' hit on ${sessionId}`);
	return hit.origin;
}

describe("child run lineage (#416)", () => {
	it("records a child run as a child and a fork as a fork", () =>
		withTree(async (db) => {
			const rows = (await db.prepare("SELECT id, parent_session, parent_kind FROM sessions ORDER BY id").all()) as Array<Record<string, unknown>>;
			assert.deepEqual(rows, [
				{ id: PARENT_ID, parent_session: null, parent_kind: null },
				{ id: FORK_ID, parent_session: PARENT_ID, parent_kind: "fork" },
				{ id: CHILD_ID, parent_session: PARENT_ID, parent_kind: "child" },
			]);
		}));

	it("message-origin and turn-frustration read a child run's prompt as an agent's, and a fork's as the person's", () =>
		withTree(async (db) => {
			await analyse(db, CHILD_ID);
			await analyse(db, FORK_ID);
			assert.equal(await originOf(db, CHILD_ID), "agent/child-session");
			assert.equal(await hitOriginOf(db, CHILD_ID), "agent");
			assert.equal(await originOf(db, FORK_ID), "typed/no-marker");
			assert.equal(await hitOriginOf(db, FORK_ID), "typed");
		}));

	it("counts a child run, not a fork, as work moved to children", () =>
		withTree(async (db) => {
			const stats = await getChildSessionStats(db, PARENT_ID);
			assert.equal(stats.child_session_count, 1);
			const facts = await sessionFacts(db, { sources: null, from: null, toExclusive: null, asOf: "2027-01-01T00:00:00.000Z" });
			assert.equal(facts.find((f) => f.id === PARENT_ID)?.subAgentSessions, 1);
		}));
});
