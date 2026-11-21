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

	it("cache-economy: hit rate per session, turns by cache class, write churn and cold-miss cost", async () => {
		for (const [i, id] of IDS.slice(0, 6).entries()) {
			const recorded = i < 5 ? 4 : 0;
			await seedNode(t.db, id, "cache-economy", {
				usage_recorded_turn_count: recorded,
				aggregate_hit_ratio: recorded > 0 ? 0.5 + i * 0.1 : 0,
				classification_counts: { hit: 3, "cold-ttl": 1, "cold-prefix": 0, "cold-start": 0, partial: 0, unbilled: recorded > 0 ? 0 : 4 },
				write_churn_tokens: 200_000,
				cold_miss_cost_usd: i < 5 ? 0.25 : null,
			});
		}
		const section = objective(await fingerprint(), "promptCache");
		assert.equal(section.status, "ok");
		assert.equal(section.sessionsMeasured, 6);
		// The session that recorded no usage has no hit rate, not a rate of 0.
		assert.equal((section["hitRate"] as { sessions: number }).sessions, 5);
		const byClass = section["turnsByClass"] as Array<Record<string, unknown>>;
		assert.deepEqual(byClass.find((g) => g["class"] === "hit"), { class: "hit", count: 18, sessions: 6 });
		assert.deepEqual(byClass.find((g) => g["class"] === "cold-ttl"), { class: "cold-ttl", count: 6, sessions: 6 });
		assert.equal(section["writeChurnMillions"], 1.2);
		assert.equal(section["coldMissUsd"], 1.25);
	});

	it("routing-opportunity: turns by verdict and the cost a cheaper model could have saved, only from runs at 1.4 or later", async () => {
		for (const id of IDS.slice(0, 5)) {
			await seedRun(t.db, id, "routing-opportunity", "1.4");
			for (const [verdict, cost] of [["neutral", 0.1], ["neutral", 0.1], ["downshift", 0.5], ["escalate", null]] as const) {
				await seedNode(t.db, id, "routing-opportunity", { model: "secret-model", verdict, turn_cost_usd: cost }, "1.4");
			}
		}
		// Its frustration features counted words the person pasted, not typed: not measured.
		await seedRun(t.db, "s6", "routing-opportunity", "1.2");
		await seedNode(t.db, "s6", "routing-opportunity", { model: "secret-model", verdict: "escalate", turn_cost_usd: 9 }, "1.2");
		const section = objective(await fingerprint(), "routing");
		assert.equal(section.status, "ok");
		assert.equal(section.sessionsMeasured, 5);
		assert.deepEqual(section["turnsByVerdict"], [
			{ verdict: "neutral", count: 10, sessions: 5 },
			{ verdict: "downshift", count: 5, sessions: 5 },
			{ verdict: "escalate", count: 5, sessions: 5 },
		]);
		assert.equal(section["turnCostUsd"], 3.5);
		assert.equal(section["downshiftCostUsd"], 2.5);
	});

	it("tool-inventory-tax: tools carried and left unused, from sessions with a recorded inventory", async () => {
		for (const id of IDS.slice(0, 5)) {
			await seedNode(t.db, id, "tool-inventory-tax", {
				available_tools: 20,
				invoked_tools: 4,
				unused_tools: 16,
				unused_tool_names: ["secret-tool"],
				unused_prefix_tokens: 3000,
				unused_prefix_token_turns: 600_000,
				estimated_tax_usd: 0.4,
			});
		}
		const section = objective(await fingerprint(), "toolInventory");
		assert.equal(section.status, "ok");
		assert.equal(section.sessionsMeasured, 5);
		assert.equal(section["availableTools"], 100);
		assert.equal(section["invokedTools"], 20);
		assert.equal(section["unusedTools"], 80);
		assert.equal(section["unusedPrefixMillionTokenTurns"], 3);
		assert.equal(section["estimatedTaxUsd"], 2);
	});

	it("task-tool-mismatch: sessions whose agent avoided the tool its task named, from sessions with a recorded inventory", async () => {
		for (const [i, id] of IDS.slice(0, 6).entries()) {
			const found = i < 5;
			await seedNode(t.db, id, "task-tool-mismatch", { mismatch_found: found, substitute_calls: found ? 12 : 0, substitute_tool_names: ["secret-tool"], available_tools: 20 });
		}
		const section = objective(await fingerprint(), "toolAvoidance");
		assert.equal(section.status, "ok");
		assert.equal(section.sessionsMeasured, 6);
		assert.equal(section["sessionsWithMismatch"], 5);
		assert.equal(section["substituteCalls"], 60);
	});

	it("tool-trajectory: trajectory signals by pattern and the tool calls they come from, only from runs at 7.0 or later", async () => {
		for (const id of IDS.slice(0, 5)) {
			await seedRun(t.db, id, "tool-trajectory", "7.1");
			await seedNode(t.db, id, "tool-trajectory", { tool_call_count: 40, pattern_counts: { "stuck-loop": 2, "pre-flight-gap": 1 }, signals: [{ pattern: "stuck-loop", tool: "secret-tool" }] }, "7.1");
		}
		// Before the no-effect-edit detector existed: not measured.
		await seedRun(t.db, "s6", "tool-trajectory", "3.0");
		await seedNode(t.db, "s6", "tool-trajectory", { tool_call_count: 999, pattern_counts: { "stuck-loop": 99 }, signals: [] }, "3.0");
		const section = objective(await fingerprint(), "toolTrajectory");
		assert.equal(section.status, "ok");
		assert.equal(section.sessionsMeasured, 5);
		assert.equal(section["toolCalls"], 200);
		assert.equal(section["signals"], 15);
		assert.equal(section["sessionsWithSignal"], 5);
		assert.deepEqual(section["signalsByPattern"], [
			{ pattern: "stuck-loop", count: 10, sessions: 5 },
			{ pattern: "pre-flight-gap", count: 5, sessions: 5 },
		]);
	});
});
