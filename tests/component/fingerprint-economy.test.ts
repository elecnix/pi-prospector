/**
 * The fingerprint sections of the economy and tool-use analyzers, over a
 * synthetic corpus of seven pi sessions. Each test seeds the nodes and runs
 * one analyzer would write, builds the fingerprint, and reads its section.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { Check } from "typebox/value";
import { tempDb, type TempDb } from "./helpers.js";
import { createRun, insertNode } from "../../src/db/analysis-queries.js";
import { buildFingerprint, parseFingerprintArgs } from "../../src/fingerprint/build.js";
import { fingerprintSchema, type Fingerprint } from "../../src/fingerprint/schema.js";
import { BUILTIN_ANALYZERS } from "../../src/analyze/defaults.js";
import { collectContributors } from "../../src/fingerprint/registry.js";
import type { AsyncDatabase } from "../../src/db/async-db.js";

const ASOF = "2026-06-30T12:00:00.000Z";
const SENTINELS = ["SECRET-PROJECT", "/home/secret/path", "secret-skill", "secret-tool", "secret-model"];
const contributors = collectContributors(BUILTIN_ANALYZERS);
const IDS = Array.from({ length: 7 }, (_, i) => `s${i + 1}`);

let t: TempDb;
let n = 0;

async function seedSession(db: AsyncDatabase, id: string, startedAt: string): Promise<void> {
	await db
		.prepare(
			"INSERT INTO sessions (id, file_path, project, source, cwd, parent_session, name, started_at, last_line, last_modified, message_count, branch_count) VALUES (?, ?, 'SECRET-PROJECT', 'pi', '/home/secret/path', NULL, 'Secret title', ?, 0, 0, 0, 0)",
		)
		.run(id, `/home/secret/path/${id}.jsonl`, startedAt);
}

async function seedNode(db: AsyncDatabase, sessionId: string, analyzerId: string, content: unknown, version = "1.0", at = "2026-05-01T00:00:00.000Z"): Promise<void> {
	n++;
	await insertNode(db, {
		id: `node-${n}`,
		sessionId,
		analyzerId,
		analyzerVersionId: version,
		configId: "c",
		runId: null,
		nodeKind: "metric",
		contentJson: JSON.stringify(content),
		sourceSetHash: `ssh-${n}`,
		inputKey: `ik-${n}`,
		outputKey: `ok-${n}`,
		createdAt: at,
	});
}

async function seedRun(db: AsyncDatabase, sessionId: string, analyzerId: string, version = "1.0"): Promise<void> {
	n++;
	await createRun(db, { id: `run-${n}`, analyzerId, analyzerVersionId: version, configId: "c", sessionId, mode: "fill", promptBundleHash: "" });
	await db.prepare("UPDATE analysis_runs SET started_at = ? WHERE id = ?").run("2026-05-01T00:00:00.000Z", `run-${n}`);
}

type Section = Record<string, unknown> & { status: string; sessionsMeasured?: number };

async function fingerprint(): Promise<Fingerprint> {
	const fp = await buildFingerprint(t.db, parseFingerprintArgs(`--as-of ${ASOF}`, new Date(ASOF)), contributors);
	assert.ok(Check(fingerprintSchema(contributors), fp), "fingerprint does not match the schema");
	const text = JSON.stringify(fp);
	for (const sentinel of SENTINELS) assert.ok(!text.includes(sentinel), `output contains ${sentinel}`);
	return fp;
}

const objective = (fp: Fingerprint, id: string) => fp.objective[id] as Section;

describe("economy and tool-use fingerprint sections", () => {
	before(async () => {
		t = await tempDb();
		for (const [i, id] of IDS.entries()) await seedSession(t.db, id, `2026-03-0${i + 1}T10:00:00.000Z`);
	});
	after(() => t.close());

	it("token-units: spend per session in MITE and the token mix, from the newest node of each session", async () => {
		await seedNode(t.db, "s1", "token-units", { totals: { mite: 100, calls: 50, input: 9e7, output: 0, cache_read: 0, cache_write: 0 } }, "1.0", "2026-04-01T00:00:00.000Z");
		for (const [i, id] of IDS.slice(0, 6).entries()) {
			await seedNode(t.db, id, "token-units", { totals: { mite: i + 2, calls: 10, input: 1_000_000, output: 20_000, cache_read: 3_000_000, cache_write: 400_000 }, by_model: { "secret-model": {} } });
		}
		const section = objective(await fingerprint(), "tokenSpend");
		assert.equal(section.status, "ok");
		assert.equal(section.sessionsMeasured, 6);
		assert.equal(section["totalMite"], 27);
		assert.equal(section["apiCalls"], 60);
		assert.equal(section["inputMillions"], 6);
		assert.equal(section["outputMillions"], 0.12);
		assert.equal(section["cacheReadMillions"], 18);
		assert.equal(section["cacheWriteMillions"], 2.4);
		assert.deepEqual((section["perSession"] as { sessions: number }).sessions, 6);
	});

	it("context-economy: carried context, read amplification and waste flags, only from runs at 2.1 or later", async () => {
		for (const [i, id] of IDS.slice(0, 5).entries()) {
			await seedRun(t.db, id, "context-economy", "2.2");
			const flags = [{ kind: "high-carry-result", tool: "secret-tool", tokens: 5000, turnsAfter: 10, carryTokenTurns: 50000, ordinal: 1 }];
			if (i === 0) flags.push({ kind: "redundant-read", path: "/home/secret/path/a.ts", count: 3 } as never);
			await seedNode(t.db, id, "context-economy", { billed: { output: 100 }, readAmplification: (i + 1) * 10, carry: { totalTokenTurns: 1_000_000, byTool: { "secret-tool": 1_000_000 } }, flags }, "2.2");
		}
		// No output billed, so no amplification: measured, but left out of the distribution rather than read as 0.
		await seedRun(t.db, "s7", "context-economy", "2.2");
		await seedNode(t.db, "s7", "context-economy", { billed: { output: 0 }, readAmplification: 0, carry: { totalTokenTurns: 0 }, flags: [] }, "2.2");
		// Measured by a version that over-counted redundant reads: not measured.
		await seedRun(t.db, "s6", "context-economy", "2.0");
		await seedNode(t.db, "s6", "context-economy", { readAmplification: 999, carry: { totalTokenTurns: 9e9 }, flags: [] }, "2.0");
		const section = objective(await fingerprint(), "contextCarry");
		assert.equal(section.status, "ok");
		assert.equal(section.sessionsMeasured, 6);
		assert.equal(section["carriedMillionTokenTurns"], 5);
		assert.equal((section["readAmplification"] as { sessions: number }).sessions, 5);
		assert.equal(section["sessionsFlagged"], 5);
		assert.deepEqual((section["flagsByKind"] as Array<Record<string, unknown>>).find((g) => g["kind"] === "high-carry-result"), { kind: "high-carry-result", count: 5, sessions: 5 });
	});

});
