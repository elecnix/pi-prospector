import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { Check } from "typebox/value";
import { tempDb, insertMessages, type TempDb } from "./helpers.js";
import { createRun, insertNode } from "../../src/db/analysis-queries.js";
import { currentNodeItems, currentNodeRows } from "../../src/db/fingerprint-queries.js";
import { buildFingerprint, parseFingerprintArgs } from "../../src/fingerprint/build.js";
import { fingerprintSchema, MIN_GROUP_SIZE, type Fingerprint } from "../../src/fingerprint/schema.js";
import { hasMetric } from "../../src/analyze/metrics/registry.js";
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

async function seedNode(db: AsyncDatabase, sessionId: string, analyzerId: string, content: unknown, at = "2026-05-01T00:00:00.000Z", version = "1"): Promise<void> {
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

async function seedRun(db: AsyncDatabase, sessionId: string, analyzerId: string, version = "1", at = "2026-05-01T00:00:00.000Z"): Promise<void> {
	n++;
	await createRun(db, { id: `run-${n}`, analyzerId, analyzerVersionId: version, configId: "c", sessionId, mode: "fill", promptBundleHash: "" });
	await db.prepare("UPDATE analysis_runs SET started_at = ? WHERE id = ?").run(at, `run-${n}`);
}

describe("buildFingerprint", () => {
	const piIds = Array.from({ length: 8 }, (_, i) => `pi-session-${i + 1}`);
	const claudeIds = Array.from({ length: 6 }, (_, i) => `claude-session-${i + 1}`);

	before(async () => {
		t = await tempDb();
		const { db } = t;
		for (const [i, id] of piIds.entries()) {
			await seedSession(db, id, "pi", `2026-03-0${i + 1}T10:00:00.000Z`, { prompts: 3 + i, toolCalls: 2, minutes: 10 + i * 20 });
			// The first five pi sessions were timed by a later version of the analyzer.
			await seedNode(db, id, "time-economy", { active_seconds: 600 + i * 60 }, undefined, i < 5 ? "2.0" : "1");
			await seedNode(db, id, "failure-modes", {
				turn_failure_count: 1,
				tool_failure_count: 2,
				groups: [
					{ axis: "tool", class_id: "path-not-found", tool: "bash", count: 2 },
					{ axis: "turn", class_id: "rate-limit", tool: "", count: 1 },
				],
			});
			await seedRun(db, id, "turn-frustration", "1.11");
			await seedNode(db, id, "turn-frustration", { signal_source: "lexicon", category: "profanity", polarity: "frustration", signal: "hunter2", count: 2, origin: "typed", origins: { typed: 2 }, typed_count: 2 }, undefined, "1.11");
			await seedNode(db, id, "turn-frustration", { signal_source: "lexicon", category: "profanity", polarity: "frustration", signal: "pasted-word", count: 3, origin: "pasted", origins: { pasted: 3 }, typed_count: 0 }, undefined, "1.11");
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
		// A session that grew between runs: time-economy wrote a node per run under different output keys,
		// so all three are current. Inserted out of creation order; the newest (2026-05-02) is the whole session.
		await seedNode(db, "pi-session-8", "time-economy", { active_seconds: 4620 }, "2026-05-02T00:00:00.000Z");
		await seedNode(db, "pi-session-8", "time-economy", { active_seconds: 300 }, "2026-04-30T00:00:00.000Z");
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

	it("reads a fingerprint written before sections published their analyzer versions", async () => {
		const fp = structuredClone(await build(t.db, at()));
		for (const kind of ["objective", "inferred"] as const) {
			for (const section of Object.values(fp[kind]) as Section[]) delete section["versions"];
		}
		assert.ok(Check(fingerprintSchema(contributors), fp), "a fingerprint without versions does not match the schema");
	});

	it("states the period as the first and last month holding at least the minimum of sessions", async () => {
		assert.deepEqual((await build(t.db, at())).period, { from: "2026-03", to: "2026-04" });
		assert.deepEqual((await build(t.db, at("--source claude"))).period, { from: "2026-04", to: "2026-04" });
		// Two Codex sessions in April: no month holds five.
		assert.deepEqual((await build(t.db, at("--source codex"))).period, { status: "withheld", reason: "below-min-group-size" });
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

	it("keeps every session when --to is the last day of year 9999", async () => {
		const all = await build(t.db, at(""));
		const fp = await build(t.db, at("--to 9999-12-31"));
		assert.equal(fp.sessions.count, all.sessions.count);
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
		// 7 sessions at 600..960 s, 60 s apart (5460 s), and pi-session-8 at its newest node, 4620 s: 10080 s.
		assert.equal(active["totalHours"], 2.8);
		assert.equal((active["perSession"] as { sessions: number }).sessions, 8);
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

	it("publishes the versions of the analyzer behind a section, folding a version under the minimum", async () => {
		const all = await build(t.db, at());
		assert.deepEqual(objective(all, "activeTime")["versions"], [
			{ analyzer: "time-economy", version: "1", sessions: 9 },
			{ analyzer: "time-economy", version: "2.0", sessions: 5 },
		]);
		assert.deepEqual(objective(all, "failures")["versions"], [{ analyzer: "failure-modes", version: "1", sessions: 8 }]);
		assert.ok(!("versions" in objective(all, "shape")), "a section over the session index reads no analyzer");
		const pi = await build(t.db, at("--source pi"));
		assert.deepEqual(objective(pi, "activeTime")["versions"], [{ analyzer: "time-economy", version: "2.0", sessions: 5 }]);
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

describe("frustration from a turn-frustration version that did not label origins", () => {
	// turn-frustration before 1.10 wrote no `typed_count`: its hits cannot be told
	// from pasted text, and a session it found nothing in may hide typed hits a
	// later version would find. Neither counts as measured.
	let u: TempDb;
	const hit = (typed?: number) => ({
		signal_source: "lexicon",
		category: "profanity",
		signal: "hunter2",
		count: 2,
		...(typed === undefined ? {} : { origin: "typed", origins: { typed }, typed_count: typed }),
	});
	const asOf = parseFingerprintArgs(`--as-of ${ASOF}`, new Date(ASOF));

	before(async () => {
		u = await tempDb();
		for (let i = 1; i <= 6; i++) {
			const id = `old-${i}`;
			await seedSession(u.db, id, "pi", `2026-03-0${i}T10:00:00.000Z`, { prompts: 2, toolCalls: 0, minutes: 5 });
			await seedRun(u.db, id, "turn-frustration", "1.7");
			// Half the sessions had hits; the rest had none.
			if (i <= 3) await seedNode(u.db, id, "turn-frustration", hit(), undefined, "1.7");
		}
	});
	after(() => u.close());

	it("withholds the section rather than report 0 signals when no session was measured by a labelling version", async () => {
		const f = inferred(await buildFingerprint(u.db, asOf, contributors), "frustration");
		assert.equal(f.status, "withheld");
	});

	it("measures only the sessions whose latest run labels origins, and drops a session with an unlabelled hit", async () => {
		for (let i = 1; i <= 5; i++) {
			const id = `new-${i}`;
			await seedSession(u.db, id, "claude", `2026-04-0${i}T10:00:00.000Z`, { prompts: 2, toolCalls: 0, minutes: 5 });
			await seedRun(u.db, id, "turn-frustration", "1.11");
			await seedNode(u.db, id, "turn-frustration", hit(1), undefined, "1.11");
		}
		// A session re-run at 1.11 that still carries a hit the old version drew.
		await seedSession(u.db, "mixed", "claude", "2026-04-09T10:00:00.000Z", { prompts: 2, toolCalls: 0, minutes: 5 });
		await seedRun(u.db, "mixed", "turn-frustration", "1.7", "2026-04-30T00:00:00.000Z");
		await seedRun(u.db, "mixed", "turn-frustration", "1.11");
		await seedNode(u.db, "mixed", "turn-frustration", hit(), undefined, "1.7");
		const f = inferred(await buildFingerprint(u.db, asOf, contributors), "frustration");
		assert.equal(f.status, "ok");
		assert.equal(f["sessionsMeasured"], 5);
		assert.equal(f["signals"], 5);
		// An old session re-run at 1.11 is measured from then on.
		await seedRun(u.db, "old-6", "turn-frustration", "1.11", "2026-05-02T00:00:00.000Z");
		assert.equal(inferred(await buildFingerprint(u.db, asOf, contributors), "frustration")["sessionsMeasured"], 6);
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

	it("resolves a relative --as-of against the clock it is given", () => {
		assert.equal(parseFingerprintArgs("--as-of 7d", new Date("2020-01-08T00:00:00.000Z")).asOf, "2020-01-01T00:00:00.000Z");
	});

	it("rejects an as-of day that is not on the calendar", () => {
		assert.throws(() => parseFingerprintArgs("--as-of 2025-13-01", now), /--as-of/);
		assert.equal(parseFingerprintArgs("--as-of 2025-12-01", now).asOf, "2025-12-01T23:59:59.999Z");
	});

	it("rejects a day the month does not have, which Date.parse would roll into the next month", () => {
		for (const flag of ["--as-of", "--from", "--to"]) {
			for (const day of ["2026-02-30", "2026-02-29", "2026-04-31", "2026-06-00"]) {
				assert.throws(() => parseFingerprintArgs(`${flag} ${day}`, now), new RegExp(`${flag} takes a date as YYYY-MM-DD, got '${day}'`));
			}
		}
		// 2028 is a leap year.
		assert.equal(parseFingerprintArgs("--from 2028-02-29", now).from, "2028-02-29");
		assert.equal(parseFingerprintArgs("--to 2026-01-31", now).to, "2026-01-31");
		assert.equal(parseFingerprintArgs("--as-of 2028-02-29", now).asOf, "2028-02-29T23:59:59.999Z");
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

	it("refuses to compose a schema for a section that declares a measure id twice", () => {
		const twice = { ...extra, def: { ...extra.def, measures: [extra.def.measures[0]!, extra.def.measures[0]!] } };
		assert.throws(() => fingerprintSchema([twice]), /declares measure 'scoreTotal' twice/);
	});

	it("refuses a measure id that would replace a field every section has", () => {
		for (const id of ["status", "sessionsMeasured"]) {
			const clash = { ...extra, def: { ...extra.def, measures: [{ kind: "total" as const, id, field: "score" }] } };
			assert.throws(() => fingerprintSchema([clash]), new RegExp(`measure id '${id}' is reserved`));
		}
	});

	it("refuses a definition its schema rejects, such as a distribution with no edges, before reading anything", async () => {
		const noEdges: FingerprintContributor = {
			...extra,
			def: { ...extra.def, id: "noEdges", measures: [{ kind: "distribution", id: "scores", field: "score", unit: "prompts", edges: [] }] },
		};
		await assert.rejects(build(t2.db, parseFingerprintArgs(`--as-of ${ASOF}`, new Date(ASOF)), [noEdges]), /contributor 'noEdges' is not a valid definition: \/measures\/0\/edges/);
		assert.throws(() => collectContributors([], [noEdges]), /contributor 'noEdges' is not a valid definition/);
	});

	it("reads an object or an array in node content as no value, never as its JSON text", async () => {
		await seedNode(t2.db, "plug-0", "nested-analyzer", { n: 3, list: [1, 2], obj: { a: 1 }, items: [[1], { a: 1 }, 2, "x"] });
		const scope = { sources: null, from: null, toExclusive: null, asOf: ASOF };
		const rows = await currentNodeRows(t2.db, scope, "nested-analyzer", { n: "$.n", list: "$.list", obj: "$.obj" });
		assert.deepEqual(rows, [{ session: "plug-0", n: 3, list: null, obj: null }]);
		const items = await currentNodeItems(t2.db, scope, "nested-analyzer", "$.items", { v: "$" }, { list: "$.list" });
		assert.deepEqual(items.map((r) => [r["v"], r["list"]]), [[null, null], [null, null], [2, null], ["x", null]]);
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

	it("refuses a distribution fed several rows per session, because it could rest on fewer sessions than it shows", async () => {
		const several: FingerprintContributor = {
			def: { id: "several", label: "Several", description: "Bad.", kind: "inferred", measures: [{ kind: "distribution", id: "d", field: "score", unit: "prompts", edges: [0] }] },
			async read(ctx) {
				const rows = await ctx.nodes("my-private-analyzer", { score: "$.score" });
				return { measured: rows.map((r) => String(r["session"])), rows: [...rows, ...rows] };
			},
		};
		await assert.rejects(build(t2.db, parseFingerprintArgs(`--as-of ${ASOF}`, new Date(ASOF)), [several]), /more than one row per session/);
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
		assert.throws(
			() => collectContributors([], [{ ...extra, def: { ...extra.def, measures: [{ kind: "total", id: "versions", field: "score" }] } }]),
			/measure id 'versions' is reserved/,
		);
	});

	it("checks the metric id a measure points at", () => {
		const withMetric = (metric: string) => ({ ...extra, def: { ...extra.def, measures: [{ ...extra.def.measures[0]!, metric }] } }) as FingerprintContributor;
		assert.doesNotThrow(() => collectContributors([], [withMetric("failure-modes.tool-failure")]));
		assert.throws(() => collectContributors([], [withMetric("Not A Metric")]), /not <analyzer-id>\.<metric-name>/);
	});

	it("points every built-in measure at a metric the registry defines", () => {
		const unknown = contributors.flatMap((c) => c.def.measures.filter((m) => m.metric !== undefined && !hasMetric(m.metric)).map((m) => `${c.def.id}.${m.id}: ${m.metric}`));
		assert.deepEqual(unknown, []);
	});

	it("points every built-in measure at its metric definition", () => {
		const missing = contributors.flatMap((c) => c.def.measures.filter((m) => m.metric === undefined).map((m) => `${c.def.id}.${m.id}`));
		assert.deepEqual(missing, []);
	});

	it("takes contributors from an analyzer's fingerprint list", () => {
		const analyzer = { ...BUILTIN_ANALYZERS[0]!, fingerprint: [extra] };
		assert.ok(collectContributors([analyzer]).some((c) => c.def.id === "plugged"));
	});
});
