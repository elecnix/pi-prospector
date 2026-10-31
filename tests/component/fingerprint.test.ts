import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { Check } from "typebox/value";
import { tempDb, insertMessages, type TempDb } from "./helpers.js";
import { createRun, insertNode } from "../../src/db/analysis-queries.js";
import { buildFingerprint, parseFingerprintArgs } from "../../src/fingerprint/build.js";
import { fingerprintSchema, MIN_GROUP_SIZE, type Fingerprint } from "../../src/fingerprint/schema.js";
import { BUILTIN_ANALYZERS } from "../../src/analyze/defaults.js";
import { collectContributors } from "../../src/fingerprint/registry.js";
import type { FingerprintContributor } from "../../src/fingerprint/contributor.js";
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
const contributors = collectContributors(BUILTIN_ANALYZERS);
const build = (db: AsyncDatabase, request: ReturnType<typeof parseFingerprintArgs>, extra: readonly FingerprintContributor[] = []) =>
	buildFingerprint(db, request, [...contributors, ...extra]);

type Section = Record<string, unknown> & { status: string };
const objective = (fp: Fingerprint, id: string) => fp.objective[id] as Section;
const inferred = (fp: Fingerprint, id: string) => fp.inferred[id] as Section;

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

	const at = (extra = "") => parseFingerprintArgs(`${extra} --as-of ${ASOF}`.trim(), new Date(ASOF));

	it("matches the schema its contributors compose and carries no identifying string", async () => {
		const fp = await build(t.db, at());
		assert.ok(Check(fingerprintSchema(contributors), fp), "fingerprint does not match the schema");
		const text = JSON.stringify(fp);
		for (const sentinel of SENTINELS) assert.ok(!text.includes(sentinel), `output contains ${sentinel}`);
		assert.ok(!text.includes("codex"), "a source under the minimum is named");
	});

	it("records the version, the as-of date, the filter and the session count", async () => {
		const fp = await build(t.db, at());
		assert.equal(fp.schemaVersion, 2);
		assert.equal(fp.asOf, "2026-06-30");
		assert.deepEqual(fp.filter, { sources: null, from: null, to: null });
		assert.equal(fp.minGroupSize, MIN_GROUP_SIZE);
		assert.equal(fp.sessions.count, 16);
		const sources = objective(fp, "sources");
		assert.equal(sources["sessionsMeasured"], 16);
		// Codex has 2 sessions, under the minimum, and `other` would be under it too.
		assert.deepEqual(sources["bySource"], [
			{ source: "pi", count: 8, sessions: 8 },
			{ source: "claude", count: 6, sessions: 6 },
		]);
	});

	it("restricts to the chosen sources", async () => {
		const fp = await build(t.db, at("--source claude"));
		assert.deepEqual(fp.filter.sources, ["claude"]);
		assert.equal(fp.sessions.count, 6);
	});

	it("restricts to a date range, inclusive of both days", async () => {
		const fp = await build(t.db, at("--from 2026-03-02 --to 2026-03-06"));
		assert.deepEqual([fp.filter.from, fp.filter.to], ["2026-03-02", "2026-03-06"]);
		assert.equal(fp.sessions.count, 5);
	});

	it("withholds every section when the corpus is under the minimum, and still reports the count", async () => {
		const fp = await build(t.db, at("--source codex"));
		assert.equal(fp.sessions.count, 2);
		for (const section of [...Object.values(fp.objective), ...Object.values(fp.inferred)]) {
			assert.deepEqual(section, { status: "withheld", reason: "below-min-group-size" });
		}
	});

	it("measures usage and shape from the transcript", async () => {
		const fp = await build(t.db, at("--source pi"));
		assert.equal(fp.sessions.count, 8);
		const usage = objective(fp, "usage");
		assert.equal(usage["activeDays"], 8);
		const duration = usage["duration"] as { status: string; sessions: number; buckets: Array<{ sessions: number }> };
		assert.equal(duration.status, "ok");
		assert.equal(duration.sessions, 8);
		for (const b of duration.buckets) assert.ok(b.sessions === 0 || b.sessions >= MIN_GROUP_SIZE);
		const shape = objective(fp, "shape");
		assert.equal((shape["promptsPerSession"] as { p50: number }).p50, 6.5);
		assert.equal((shape["toolCallsPerSession"] as { p50: number }).p50, 2);
	});

	it("measures active time from the time-economy nodes", async () => {
		const fp = await build(t.db, at("--source pi"));
		const active = objective(fp, "activeTime");
		assert.equal(active["sessionsMeasured"], 8);
		// 8 sessions at 600..1020 s, 60 s apart: 6480 s.
		assert.equal(active["totalHours"], 1.8);
		assert.equal(objective(await build(t.db, at("--source claude")), "activeTime").status, "ok");
	});

	it("withholds the sub-agent count when 1 to 4 sessions started one", async () => {
		const shape = objective(await build(t.db, at("--source pi")), "shape");
		assert.deepEqual(shape["sessionsWithSubAgents"], { status: "withheld", reason: "below-min-group-size" });
		assert.deepEqual(shape["subAgentSessions"], { status: "withheld", reason: "below-min-group-size" });
	});

	it("reads the current generation of the graph as of the date", async () => {
		const f = objective(await build(t.db, at("--source pi")), "failures");
		assert.equal(f.status, "ok");
		assert.equal(f["sessionsMeasured"], 8);
		assert.equal(f["turnFailures"], 8);
		assert.equal(f["toolFailures"], 16);
		assert.deepEqual(f["byClass"], [
			{ axis: "tool", classId: "path-not-found", count: 16, sessions: 8 },
			{ axis: "turn", classId: "rate-limit", count: 8, sessions: 8 },
		]);
	});

	it("counts only the frustration the person typed, and files it as inferred", async () => {
		const fp = await build(t.db, at("--source pi"));
		assert.ok(!("frustration" in fp.objective));
		const f = inferred(fp, "frustration");
		assert.equal(f["sessionsMeasured"], 8);
		assert.equal(f["signals"], 16);
		assert.deepEqual(f["byCategory"], [{ category: "profanity", count: 16, sessions: 8 }]);
		assert.equal(inferred(fp, "turnClassification")["turnsClassified"], 8);
	});

	it("withholds a graph section whose analyzer ran on too few sessions", async () => {
		const fp = await build(t.db, at("--source claude"));
		assert.equal(objective(fp, "failures").status, "withheld");
		assert.equal(inferred(fp, "frustration").status, "withheld");
	});

	it("writes nothing", async () => {
		const count = async () => ((await t.db.prepare("SELECT (SELECT COUNT(*) FROM analysis_nodes) + (SELECT COUNT(*) FROM analysis_runs) + (SELECT COUNT(*) FROM analysis_edges) + (SELECT COUNT(*) FROM sessions) + (SELECT COUNT(*) FROM messages) AS c").get()) as { c: number }).c;
		const before = await count();
		await build(t.db, parseFingerprintArgs("", new Date(ASOF)));
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

describe("registering a contributor", () => {
	let t2: TempDb;
	const SENTINEL_CLASS = "SECRET-CLASS-NAME";
	const hits = (sessions: number) =>
		Array.from({ length: sessions }, (_, i) => ({ id: `plug-${i}`, kind: i % 2 === 0 ? "alpha" : SENTINEL_CLASS }));

	before(async () => {
		t2 = await tempDb();
		for (const [i, h] of hits(8).entries()) {
			await seedSession(t2.db, h.id, "pi", `2026-03-0${i + 1}T10:00:00.000Z`, { prompts: 2, toolCalls: 1, minutes: 5 });
			await seedNode(t2.db, h.id, "my-private-analyzer", { score: i, kind: h.kind, text: "hunter2" });
		}
	});
	after(() => t2.close());

	const extra: FingerprintContributor = {
		def: {
			id: "plugged",
			label: "Plugged",
			description: "A section a new analyzer adds without editing the builder.",
			kind: "inferred",
			measures: [
				{ kind: "total", id: "scoreTotal", field: "score" },
				{ kind: "distribution", id: "scores", field: "score", unit: "prompts", edges: [0, 4] },
				{ kind: "groups", id: "byKind", dimensions: { kind: ["alpha", "beta"] } },
			],
		},
		async read(ctx) {
			const rows = await ctx.nodes("my-private-analyzer", { score: "$.score", kind: "$.kind", text: "$.text" });
			return { measured: rows.map((r) => String(r["session"])), rows };
		},
	};

	it("adds a section the builder never named, and applies the guard to it", async () => {
		const fp = await build(t2.db, parseFingerprintArgs(`--as-of ${ASOF}`, new Date(ASOF)), [extra]);
		const section = inferred(fp, "plugged");
		assert.equal(section.status, "ok");
		assert.equal(section["sessionsMeasured"], 8);
		assert.equal(section["scoreTotal"], 28);
		// 4 sessions use alpha, which is under the minimum, and so does the sentinel kind: they fold into other, which reaches it.
		assert.deepEqual(section["byKind"], [{ kind: "other", count: 8, sessions: 8 }]);
		const text = JSON.stringify(fp);
		for (const leaked of [SENTINEL_CLASS, "hunter2", "my-private-analyzer", "plug-1"]) assert.ok(!text.includes(leaked), `output contains ${leaked}`);
	});

	it("is checked against the schema the declarations compose", async () => {
		const schema = fingerprintSchema([...contributors, extra]);
		const fp = await build(t2.db, parseFingerprintArgs(`--as-of ${ASOF}`, new Date(ASOF)), [extra]);
		assert.ok(Check(schema, fp));
		const tampered = structuredClone(fp) as unknown as { inferred: { plugged: { byKind: Array<Record<string, unknown>> } } };
		tampered.inferred.plugged.byKind[0]!["kind"] = SENTINEL_CLASS;
		assert.ok(!Check(schema, tampered), "a value outside the fixed list passed the schema");
		const widened = structuredClone(fp) as unknown as { inferred: { plugged: Record<string, unknown> } };
		widened.inferred.plugged["note"] = "free text";
		assert.ok(!Check(schema, widened), "an undeclared field passed the schema");
	});

	it("withholds a distinct count that rests on 1 to 4 sessions", async () => {
		const distinct: FingerprintContributor = {
			def: { id: "kinds", label: "Kinds", description: "Distinct kinds.", kind: "inferred", measures: [{ kind: "distinct", id: "kindCount", field: "day" }] },
			async read(ctx) {
				const rows = await ctx.nodes("my-private-analyzer", { score: "$.score" });
				// Only one session has a day, though all eight are measured.
				return { measured: rows.map((r) => String(r["session"])), rows: rows.map((r, i) => ({ session: r["session"]!, day: i === 0 ? "2026-03-01" : null })) };
			},
		};
		const fp = await build(t2.db, parseFingerprintArgs(`--as-of ${ASOF}`, new Date(ASOF)), [distinct]);
		assert.deepEqual(inferred(fp, "kinds")["kindCount"], { status: "withheld", reason: "below-min-group-size" });
		assert.ok(Check(fingerprintSchema([...contributors, distinct]), fp));
	});

	it("reads an empty source list as matching no session instead of failing", async () => {
		const fp = await build(t2.db, { sources: [], from: null, to: null, asOf: ASOF });
		assert.equal(fp.sessions.count, 0);
	});

	it("does not touch the graph", async () => {
		const rows = async () => ((await t2.db.prepare("SELECT (SELECT COUNT(*) FROM analysis_nodes) + (SELECT COUNT(*) FROM analysis_runs) + (SELECT COUNT(*) FROM analysis_edges) AS c").get()) as { c: number }).c;
		const before = await rows();
		await build(t2.db, parseFingerprintArgs(`--as-of ${ASOF}`, new Date(ASOF)), [extra]);
		assert.equal(await rows(), before);
	});

	it("rejects a duplicate section id and a malformed id at registration", () => {
		assert.throws(() => collectContributors([], [extra, extra]), /registered twice/);
		assert.throws(() => collectContributors([], [{ ...extra, def: { ...extra.def, id: "Bad-Id" } }]), /must match/);
		assert.throws(
			() => collectContributors([], [{ ...extra, def: { ...extra.def, measures: [extra.def.measures[0]!, extra.def.measures[0]!] } }]),
			/declares measure 'scoreTotal' twice/,
		);
	});

	it("takes contributors from an analyzer's fingerprint list", () => {
		const analyzer = { ...BUILTIN_ANALYZERS[0]!, fingerprint: [extra] };
		assert.ok(collectContributors([analyzer]).some((c) => c.def.id === "plugged"));
	});
});
