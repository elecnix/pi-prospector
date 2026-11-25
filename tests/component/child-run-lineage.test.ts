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
import { getNodesByAnalyzer, isLineageRepaired } from "../../src/db/analysis-queries.js";
import { getChildSessionStats, getUnanalyzedSessions, markAnalyzed } from "../../src/db/queries.js";
import { migrate } from "../../src/db/schema.js";
import { delegationOutcomesAnalyzer, DELEGATION_OUTCOMES_DEF, type DelegationOutcomesProperties } from "../../src/analyze/analyzers/delegation-outcomes/index.js";
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
	for (const a of [turnPairCoreAnalyzer, messageOriginAnalyzer, lexiconCandidatesAnalyzer, frustrationLexiconAnalyzer, turnFrustrationAnalyzer, delegationOutcomesAnalyzer]) await framework.register(a);
	await framework.run(sessionId);
}

/** A session's nodes of one analyzer, newest first. */
async function newest(db: AsyncDatabase, analyzerId: string, sessionId: string) {
	return (await getNodesByAnalyzer(db, analyzerId, sessionId)).sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
}

async function originOf(db: AsyncDatabase, sessionId: string): Promise<string> {
	const [node] = await newest(db, MESSAGE_ORIGIN_DEF.id, sessionId);
	assert.ok(node, `expected a message-origin node on ${sessionId}`);
	const props = JSON.parse(node.content_json) as MessageOriginProperties;
	return `${props.origin}/${props.rule}`;
}

async function hitOriginOf(db: AsyncDatabase, sessionId: string): Promise<string | undefined> {
	const hits = (await newest(db, TURN_FRUSTRATION_DEF.id, sessionId)).map((n) => JSON.parse(n.content_json) as TurnFrustrationProperties);
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

	/** Current nodes per anchor and signal: one key per subject, so every count must be 1. */
	async function currentPerSubject(db: AsyncDatabase, analyzerId: string, sessionId: string): Promise<number[]> {
		const rows = (await db
			.prepare("SELECT content_json FROM current_nodes WHERE analyzer_id = ? AND session_id = ? AND node_kind != 'error'")
			.all(analyzerId, sessionId)) as Array<{ content_json: string }>;
		const counts = new Map<string, number>();
		for (const row of rows) {
			const c = JSON.parse(row.content_json) as Record<string, unknown>;
			const key = `${String(c["user_message_id"])}|${String(c["signal"])}`;
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		return [...counts.values()];
	}

	for (const repaired of [true, false]) {
		it(`redraws a run on a database migrated before parent_kind existed, lineage ${repaired ? "repaired" : "not yet repaired"}: one current node per subject`, () =>
			withTree(async (db) => {
				// The run as the older schema holds it: no parent, no kind column, no triggers.
				await db.prepare("UPDATE sessions SET parent_session = NULL, parent_kind = NULL WHERE id = ?").run(CHILD_ID);
				await analyse(db, CHILD_ID);
				await analyse(db, PARENT_ID);
				for (const id of [CHILD_ID, PARENT_ID]) await markAnalyzed(db, id);
				await db.exec("DROP TRIGGER sessions_parent_link_ai; DROP TRIGGER sessions_parent_link_au; ALTER TABLE sessions DROP COLUMN parent_kind;");
				if (!repaired) await db.exec("DELETE FROM lineage_repairs");
				assert.equal(await isLineageRepaired(db, MESSAGE_ORIGIN_DEF.id), repaired);

				await migrate(db);
				const pending = new Set((await getUnanalyzedSessions(db)).map((x) => x.id));
				assert.ok(pending.has(CHILD_ID) && pending.has(PARENT_ID));
				const kinds = (await db.prepare("SELECT id, parent_kind FROM sessions ORDER BY id").all()) as Array<Record<string, unknown>>;
				assert.deepEqual(kinds, [{ id: PARENT_ID, parent_kind: null }, { id: FORK_ID, parent_kind: "fork" }, { id: CHILD_ID, parent_kind: "child" }]);

				await analyse(db, CHILD_ID);
				await analyse(db, PARENT_ID);
				for (const id of [MESSAGE_ORIGIN_DEF.id, TURN_FRUSTRATION_DEF.id, DELEGATION_OUTCOMES_DEF.id]) assert.ok(await isLineageRepaired(db, id));
				assert.deepEqual(await currentPerSubject(db, MESSAGE_ORIGIN_DEF.id, CHILD_ID), [1]);
				assert.deepEqual(await currentPerSubject(db, TURN_FRUSTRATION_DEF.id, CHILD_ID), [1]);
				assert.deepEqual(await currentPerSubject(db, DELEGATION_OUTCOMES_DEF.id, PARENT_ID), [1]);
				const [current] = (await db.prepare("SELECT content_json FROM current_nodes WHERE analyzer_id = ? AND session_id = ?").all(MESSAGE_ORIGIN_DEF.id, CHILD_ID)) as Array<{ content_json: string }>;
				assert.equal((JSON.parse(current!.content_json) as MessageOriginProperties).origin, "agent");
				assert.equal((await getNodesByAnalyzer(db, MESSAGE_ORIGIN_DEF.id, CHILD_ID)).length, 2, "the replaced node stays in the graph");
			}));
	}

	it("a link recorded after analysis queues the run and its parent, and their units take the new lineage", () =>
		withTree(async (db) => {
			// The run as a database indexed before #416 holds it: no parent.
			await db.prepare("UPDATE sessions SET parent_session = NULL, parent_kind = NULL WHERE id = ?").run(CHILD_ID);
			for (const id of [CHILD_ID, PARENT_ID]) {
				await analyse(db, id);
				await markAnalyzed(db, id);
			}
			assert.equal(await originOf(db, CHILD_ID), "typed/no-marker");
			const pending = async () => new Set((await getUnanalyzedSessions(db)).map((s) => s.id));
			assert.ok(!(await pending()).has(CHILD_ID));
			assert.ok(!(await pending()).has(PARENT_ID));

			await migrate(db);
			assert.ok((await pending()).has(CHILD_ID), "the run's lineage changed, so its units changed");
			assert.ok((await pending()).has(PARENT_ID), "the parent gained a child, so its work moved to children changed");

			await analyse(db, CHILD_ID);
			await analyse(db, PARENT_ID);
			assert.equal(await originOf(db, CHILD_ID), "agent/child-session");
			assert.equal(await hitOriginOf(db, CHILD_ID), "agent");
			const [delegation] = await newest(db, DELEGATION_OUTCOMES_DEF.id, PARENT_ID);
			assert.equal((JSON.parse(delegation!.content_json) as DelegationOutcomesProperties).child_session_count, 1);
		}));
});
