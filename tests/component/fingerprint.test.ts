import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { Check } from "typebox/value";
import { tempDb, insertMessages, type TempDb } from "./helpers.js";
import { createRun, insertNode } from "../../src/db/analysis-queries.js";
import { buildFingerprint, parseFingerprintArgs } from "../../src/fingerprint/build.js";
import { Fingerprint, MIN_GROUP_SIZE } from "../../src/fingerprint/schema.js";
import type { AsyncDatabase } from "../../src/db/async-db.js";

/**
 * The fingerprint over a synthetic corpus: eight pi sessions, six Claude
 * sessions, two Codex sessions (under the minimum), and one sub-agent session.
 * Every identifying string below is a sentinel the output must never contain.
 */

const SENTINELS = ["SECRET-PROJECT", "/home/secret/path", "Secret title", "my-private-analyzer", "hunter2", "pi-session-1", "claude-session-1"];
const ASOF = "2026-06-30T12:00:00.000Z";

let t: TempDb;
let n = 0;

async function seedSession(db: AsyncDatabase, id: string, source: string, startedAt: string, opts: { parent?: string; prompts: number; toolCalls: number; minutes: number }): Promise<void> {
	await db
		.prepare(
			"INSERT INTO sessions (id, file_path, project, source, cwd, parent_session, name, started_at, last_line, last_modified, message_count, branch_count) VALUES (?, ?, 'SECRET-PROJECT', ?, '/home/secret/path', ?, 'Secret title', ?, 0, 0, 0, 0)",
		)
		.run(id, `/home/secret/path/${id}.jsonl`, source, opts.parent ?? null, startedAt);
	const start = Date.parse(startedAt);
	const messages = [];
	for (let i = 0; i < opts.prompts; i++) {
		messages.push({ role: "user", text: "hunter2", timestamp: new Date(start + i * 1000).toISOString() });
		messages.push({
			role: "assistant",
			text: "ok",
			timestamp: new Date(start + i * 1000 + 500).toISOString(),
			toolCalls: i < opts.toolCalls ? [{ name: "bash", arguments: { command: "hunter2" } }] : undefined,
		});
	}
	messages.push({ role: "assistant", text: "end", timestamp: new Date(start + opts.minutes * 60_000).toISOString() });
	await insertMessages(db, id, messages);
}

async function seedNode(db: AsyncDatabase, sessionId: string, analyzerId: string, content: unknown, at = "2026-05-01T00:00:00.000Z"): Promise<void> {
	n++;
	await insertNode(db, {
		id: `node-${n}`,
		sessionId,
		analyzerId,
		analyzerVersionId: "1",
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

async function seedRun(db: AsyncDatabase, sessionId: string, analyzerId: string): Promise<void> {
	n++;
	await createRun(db, { id: `run-${n}`, analyzerId, analyzerVersionId: "1", configId: "c", sessionId, mode: "fill", promptBundleHash: "" });
	await db.prepare("UPDATE analysis_runs SET started_at = ? WHERE id = ?").run("2026-05-01T00:00:00.000Z", `run-${n}`);
}

describe("buildFingerprint", () => {
	const piIds = Array.from({ length: 8 }, (_, i) => `pi-session-${i + 1}`);
	const claudeIds = Array.from({ length: 6 }, (_, i) => `claude-session-${i + 1}`);

	before(async () => {
		t = await tempDb();
		const { db } = t;
		for (const [i, id] of piIds.entries()) {
			await seedSession(db, id, "pi", `2026-03-0${i + 1}T10:00:00.000Z`, { prompts: 3 + i, toolCalls: 2, minutes: 10 + i * 20 });
			await seedNode(db, id, "time-economy", { active_seconds: 600 + i * 60 });
			await seedNode(db, id, "failure-modes", {
				turn_failure_count: 1,
				tool_failure_count: 2,
				groups: [
					{ axis: "tool", class_id: "path-not-found", tool: "bash", count: 2 },
					{ axis: "turn", class_id: "rate-limit", tool: "", count: 1 },
				],
			});
			await seedRun(db, id, "turn-frustration");
			await seedNode(db, id, "turn-frustration", { signal_source: "lexicon", category: "profanity", polarity: "frustration", signal: "hunter2", count: 2, origin: "typed", origins: { typed: 2 } });
			await seedNode(db, id, "turn-frustration", { signal_source: "lexicon", category: "profanity", polarity: "frustration", signal: "pasted-word", count: 3, origin: "pasted", origins: { pasted: 3 } });
			await seedRun(db, id, "turn-pair-llm");
			await seedNode(db, id, "turn-pair-llm", { sentiment: "frustrated", friction_type: "wrong_approach", rationale: "hunter2" });
		}
		for (const [i, id] of claudeIds.entries()) {
			await seedSession(db, id, "claude", `2026-04-0${i + 1}T10:00:00.000Z`, { prompts: 2, toolCalls: 1, minutes: 3 });
			await seedNode(db, id, "time-economy", { active_seconds: 120 });
		}
		await seedSession(db, "codex-1", "codex", "2026-04-10T10:00:00.000Z", { prompts: 1, toolCalls: 0, minutes: 1 });
		await seedSession(db, "codex-2", "codex", "2026-04-11T10:00:00.000Z", { prompts: 1, toolCalls: 0, minutes: 1 });
		await seedSession(db, "child-1", "pi", "2026-03-01T10:05:00.000Z", { parent: "pi-session-1", prompts: 1, toolCalls: 1, minutes: 1 });
		// A sub-agent is only counted under `subAgents`, and a custom analyzer is not a figure at all.
		await seedNode(db, "pi-session-1", "my-private-analyzer", { score: 9 });
		// Written after the as-of date, so the as-of fingerprint must not see it.
		await seedNode(db, "pi-session-2", "failure-modes", { turn_failure_count: 99, tool_failure_count: 99, groups: [{ axis: "tool", class_id: "path-not-found", tool: "bash", count: 99 }] }, "2026-09-01T00:00:00.000Z");
	});
	after(() => t.close());

	it("matches its schema and carries no identifying string", async () => {
		const fp = await buildFingerprint(t.db, parseFingerprintArgs(`--as-of ${ASOF}`, new Date(ASOF)));
		assert.ok(Check(Fingerprint, fp), "fingerprint does not match the schema");
		const text = JSON.stringify(fp);
		for (const sentinel of SENTINELS) assert.ok(!text.includes(sentinel), `output contains ${sentinel}`);
		assert.ok(!text.includes("codex"), "a source under the minimum is named");
	});

	it("records the version, the as-of date, the filter and the session count", async () => {
		const fp = await buildFingerprint(t.db, parseFingerprintArgs(`--as-of ${ASOF}`, new Date(ASOF)));
		assert.equal(fp.schemaVersion, 1);
		assert.equal(fp.asOf, "2026-06-30");
		assert.deepEqual(fp.filter, { sources: null, from: null, to: null });
		assert.equal(fp.minGroupSize, MIN_GROUP_SIZE);
		assert.equal(fp.sessions.count, 16);
		assert.deepEqual(fp.sessions.bySource, [
			{ key: "pi", count: 8, sessions: 8 },
			{ key: "claude", count: 6, sessions: 6 },
		]);
	});

	it("folds a source under the minimum into nothing, because other is under it too", async () => {
		const fp = await buildFingerprint(t.db, parseFingerprintArgs(`--as-of ${ASOF}`, new Date(ASOF)));
		assert.ok(!fp.sessions.bySource.some((g) => g.key === "other"));
	});

	it("restricts to the chosen sources", async () => {
		const fp = await buildFingerprint(t.db, parseFingerprintArgs(`--source claude --as-of ${ASOF}`, new Date(ASOF)));
		assert.deepEqual(fp.filter.sources, ["claude"]);
		assert.equal(fp.sessions.count, 6);
	});

	it("restricts to a date range, inclusive of both days", async () => {
		const fp = await buildFingerprint(t.db, parseFingerprintArgs(`--from 2026-03-02 --to 2026-03-06 --as-of ${ASOF}`, new Date(ASOF)));
		assert.deepEqual([fp.filter.from, fp.filter.to], ["2026-03-02", "2026-03-06"]);
		assert.equal(fp.sessions.count, 5);
	});

	it("withholds every figure when the corpus is under the minimum, and still reports the count", async () => {
		const fp = await buildFingerprint(t.db, parseFingerprintArgs(`--source codex --as-of ${ASOF}`, new Date(ASOF)));
		assert.equal(fp.sessions.count, 2);
		assert.deepEqual(fp.sessions.bySource, []);
		assert.equal(fp.objective.usage.duration.status, "withheld");
		assert.equal(fp.objective.shape.promptsPerSession.status, "withheld");
		assert.equal(fp.objective.failures.status, "withheld");
		assert.equal(fp.inferred.frustration.status, "withheld");
	});

	it("measures usage and shape from the transcript", async () => {
		const fp = await buildFingerprint(t.db, parseFingerprintArgs(`--source pi --as-of ${ASOF}`, new Date(ASOF)));
		assert.equal(fp.sessions.count, 8);
		const { duration, activeTime } = fp.objective.usage;
		assert.equal(duration.status, "ok");
		if (duration.status === "ok") {
			assert.equal(duration.sessions, 8);
			for (const b of duration.buckets) assert.ok(b.sessions === 0 || b.sessions >= MIN_GROUP_SIZE);
		}
		assert.equal(activeTime.status, "ok");
		if (activeTime.status === "ok") {
			assert.equal(activeTime.sessionsMeasured, 8);
			// 8 sessions at 600..1020 s, 60 s apart: 6480 s.
			assert.equal(activeTime.totalHours, 1.8);
		}
		assert.equal(fp.objective.usage.activeDays, 8);
		const prompts = fp.objective.shape.promptsPerSession;
		assert.equal(prompts.status === "ok" && prompts.p50, 6.5);
		const tools = fp.objective.shape.toolCallsPerSession;
		assert.equal(tools.status === "ok" && tools.p50, 2);
	});

	it("counts sub-agent sessions apart from sessions", async () => {
		const fp = await buildFingerprint(t.db, parseFingerprintArgs(`--source pi --as-of ${ASOF}`, new Date(ASOF)));
		// One session started a sub-agent: under the minimum, so it is withheld rather than published as 1.
		assert.deepEqual(fp.objective.shape.subAgents, { status: "withheld", reason: "below-min-group-size" });
	});

	it("reads the current generation of the graph as of the date", async () => {
		const fp = await buildFingerprint(t.db, parseFingerprintArgs(`--source pi --as-of ${ASOF}`, new Date(ASOF)));
		const f = fp.objective.failures;
		assert.equal(f.status, "ok");
		if (f.status !== "ok") return;
		assert.equal(f.sessionsMeasured, 8);
		assert.equal(f.turnFailures, 8);
		assert.equal(f.toolFailures, 16);
		assert.deepEqual(f.byClass, [
			{ axis: "tool", classId: "path-not-found", count: 16, sessions: 8 },
			{ axis: "turn", classId: "rate-limit", count: 8, sessions: 8 },
		]);
	});

	it("counts only the frustration the person typed, and labels it inferred", async () => {
		const fp = await buildFingerprint(t.db, parseFingerprintArgs(`--source pi --as-of ${ASOF}`, new Date(ASOF)));
		const f = fp.inferred.frustration;
		assert.equal(f.status, "ok");
		if (f.status !== "ok") return;
		assert.equal(f.sessionsMeasured, 8);
		assert.equal(f.signals, 16);
		assert.deepEqual(f.byCategory, [{ key: "profanity", count: 16, sessions: 8 }]);
		const c = fp.inferred.turnClassification;
		assert.equal(c.status === "ok" && c.turnsClassified, 8);
	});

	it("withholds a graph section whose analyzer ran on too few sessions", async () => {
		const fp = await buildFingerprint(t.db, parseFingerprintArgs(`--source claude --as-of ${ASOF}`, new Date(ASOF)));
		assert.equal(fp.objective.failures.status, "withheld");
		assert.equal(fp.inferred.frustration.status, "withheld");
		assert.equal(fp.objective.usage.activeTime.status, "ok");
	});

	it("writes nothing", async () => {
		const count = async () => ((await t.db.prepare("SELECT (SELECT COUNT(*) FROM analysis_nodes) + (SELECT COUNT(*) FROM analysis_runs) + (SELECT COUNT(*) FROM analysis_edges) + (SELECT COUNT(*) FROM sessions) + (SELECT COUNT(*) FROM messages) AS c").get()) as { c: number }).c;
		const before = await count();
		await buildFingerprint(t.db, parseFingerprintArgs("", new Date(ASOF)));
		assert.equal(await count(), before);
	});
});

describe("parseFingerprintArgs", () => {
	const now = new Date("2026-06-30T12:00:00.000Z");

	it("takes everything when given no arguments", () => {
		const s = parseFingerprintArgs("", now);
		assert.deepEqual([s.sources, s.from, s.to, s.out], [null, null, null, undefined]);
		assert.equal(s.asOf, now.toISOString());
	});

	it("accepts several sources, comma separated or repeated", () => {
		assert.deepEqual(parseFingerprintArgs("--source pi,claude --source codex", now).sources, ["pi", "claude", "codex"]);
	});

	it("rejects an unknown source, a bad date, and a reversed range", () => {
		assert.throws(() => parseFingerprintArgs("--source vim", now), /unknown source/);
		assert.throws(() => parseFingerprintArgs("--from yesterday", now), /--from/);
		assert.throws(() => parseFingerprintArgs("--from 2026-05-02 --to 2026-05-01", now), /before/);
	});

	it("reads --out", () => {
		assert.equal(parseFingerprintArgs("--out fp.json", now).out, "fp.json");
	});
});
