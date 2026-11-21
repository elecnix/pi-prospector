import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compareFingerprints, parseCompareArgs, parseFingerprintText, resolveCompareRenderer, type ComparedSection } from "../../src/fingerprint/compare.js";
import type { FingerprintContributor } from "../../src/fingerprint/contributor.js";
import type { Fingerprint } from "../../src/fingerprint/schema.js";

/**
 * Two synthetic fingerprints of different sizes: a small corpus `a` (100
 * sessions) and a large one `b` (400). Every figure is made up.
 */

const noRead = async () => ({ measured: [], rows: [] });
const contributors: FingerprintContributor[] = [
	{
		def: {
			id: "failures",
			label: "Failures",
			description: "Failed tool calls.",
			kind: "objective",
			analyzers: ["failure-modes"],
			measures: [
				{ kind: "total", id: "toolFailures", field: "toolFailures" },
				{ kind: "sessions", id: "sessionsWithFailures", field: "toolFailures" },
				{ kind: "groups", id: "byClass", dimensions: { axis: ["tool"], classId: ["command-failed", "path-not-found"] }, countField: "count" },
			],
		},
		read: noRead,
	},
	{
		def: {
			id: "shape",
			label: "Session shape",
			description: "Prompts per session.",
			kind: "objective",
			measures: [{ kind: "distribution", id: "promptsPerSession", field: "prompts", unit: "prompts", edges: [0, 2, 8] }],
		},
		read: noRead,
	},
	{
		def: { id: "mood", label: "Mood", description: "Judged by a model.", kind: "inferred", measures: [{ kind: "total", id: "signals", field: "signals" }] },
		read: noRead,
	},
];

const a: Fingerprint = {
	schemaVersion: 2,
	kind: "corpus-fingerprint",
	asOf: "2026-06-30",
	filter: { sources: null, from: null, to: null },
	minGroupSize: 5,
	sessions: { count: 100 },
	period: { from: "2026-03", to: "2026-06" },
	objective: {
		failures: {
			status: "ok",
			sessionsMeasured: 100,
			toolFailures: 50,
			sessionsWithFailures: 25,
			byClass: [
				{ axis: "tool", classId: "command-failed", count: 30, sessions: 20 },
				{ axis: "tool", classId: "path-not-found", count: 8, sessions: 6 },
			],
		},
		shape: {
			status: "ok",
			sessionsMeasured: 100,
			promptsPerSession: { status: "ok", sessions: 100, unit: "prompts", p50: 2, p90: 9, buckets: [{ from: 0, to: 2, sessions: 50 }, { from: 2, to: 8, sessions: 30 }, { from: 8, to: null, sessions: 20 }] },
		},
	},
	inferred: { mood: { status: "ok", sessionsMeasured: 60, signals: 30 } },
};

const b: Fingerprint = {
	...a,
	asOf: "2026-07-01",
	sessions: { count: 400 },
	period: { from: "2026-05", to: "2026-07" },
	objective: {
		failures: {
			status: "ok",
			sessionsMeasured: 200,
			toolFailures: 400,
			sessionsWithFailures: 100,
			byClass: [{ axis: "tool", classId: "command-failed", count: 120, sessions: 40 }],
		},
		shape: {
			status: "ok",
			sessionsMeasured: 400,
			promptsPerSession: { status: "ok", sessions: 400, unit: "prompts", p50: 4, p90: 9, buckets: [{ from: 0, to: 8, sessions: 300 }, { from: 8, to: null, sessions: 100 }] },
		},
	},
	inferred: { mood: { status: "withheld", reason: "below-min-group-size" } },
};

const sides = [
	{ label: "small", fingerprint: a },
	{ label: "large", fingerprint: b },
] as const;

function section(id: string): ComparedSection {
	const found = compareFingerprints(sides[0], sides[1], contributors).sections.find((s) => s.id === id);
	assert.ok(found, `section ${id}`);
	return found;
}

function row(s: ComparedSection, label: string) {
	const found = s.rows.find((r) => r.label === label);
	assert.ok(found, `row '${label}' in ${s.rows.map((r) => r.label).join(" | ")}`);
	return found;
}

describe("fingerprint compare", () => {
	it("states each side's coverage and the section's share of it", () => {
		const comparison = compareFingerprints(sides[0], sides[1], contributors);
		assert.deepEqual(
			comparison.sides.map((s) => [s.label, s.sessions, s.asOf]),
			[
				["small", 100, "2026-06-30"],
				["large", 400, "2026-07-01"],
			],
		);
		const measured = row(section("failures"), "sessions measured");
		assert.equal(measured.a.text, "100 (100%)");
		assert.equal(measured.b.text, "200 (50%)");
	});

	it("states each side's period and how to rebuild both over the months they share", () => {
		const comparison = compareFingerprints(sides[0], sides[1], contributors);
		assert.deepEqual(
			comparison.sides.map((s) => s.period),
			["2026-03 to 2026-06", "2026-05 to 2026-07"],
		);
		assert.ok(
			comparison.notes.includes("The periods differ; they share 2026-05 to 2026-06. To compare like for like, rebuild both with --from 2026-05-01 --to 2026-06-30."),
			comparison.notes.join("\n"),
		);
		const disjoint = compareFingerprints(sides[0], { label: "later", fingerprint: { ...b, period: { from: "2026-08", to: "2026-09" } } }, contributors);
		assert.ok(disjoint.notes.includes("The periods do not overlap."));
		const unstated = compareFingerprints(sides[0], { label: "old", fingerprint: { ...b, period: undefined } }, contributors);
		assert.equal(unstated.sides[1].period, "not stated");
	});

	it("names the unit of a distribution once, in its quantile rows and bucket rows", () => {
		const timed: FingerprintContributor = {
			def: { id: "usage", label: "Usage", description: "Duration.", kind: "objective", measures: [{ kind: "distribution", id: "duration", field: "m", unit: "minutes", edges: [0, 5] }] },
			read: noRead,
		};
		const usage = { status: "ok", sessionsMeasured: 10, duration: { status: "ok", sessions: 10, unit: "minutes", p50: 4, p90: 9, buckets: [{ from: 0, to: 5, sessions: 5 }, { from: 5, to: null, sessions: 5 }] } };
		const fp: Fingerprint = { ...a, objective: { usage } };
		const s = compareFingerprints({ label: "x", fingerprint: fp }, { label: "y", fingerprint: fp }, [timed]).sections[0]!;
		assert.deepEqual(
			s.rows.map((r) => r.label),
			["sessions measured", "duration p50 (minutes)", "duration p90 (minutes)", "duration: 0–5 minutes", "duration: 5+ minutes"],
		);
		assert.equal(row(section("shape"), "prompts per session p50").label, "prompts per session p50", "a name that holds its unit is not repeated");
	});

	it("notes a source mix that differs by more than ten points, and names the source to compare on", () => {
		const mix = (fp: Fingerprint, pi: number, claude: number): Fingerprint => ({
			...fp,
			objective: {
				...fp.objective,
				sources: {
					status: "ok",
					sessionsMeasured: pi + claude,
					bySource: [
						{ source: "pi", count: pi, sessions: pi },
						{ source: "claude", count: claude, sessions: claude },
					],
				},
			},
		});
		const notes = compareFingerprints({ label: "small", fingerprint: mix(a, 80, 20) }, { label: "large", fingerprint: mix(b, 120, 280) }, contributors).notes;
		assert.ok(
			notes.includes("The source mix differs (small: pi 80%, claude 20%; large: claude 70%, pi 30%), and figures vary by harness. To compare like for like, rebuild both with --source pi."),
			notes.join("\n"),
		);
		const close = compareFingerprints({ label: "small", fingerprint: mix(a, 80, 20) }, { label: "large", fingerprint: mix(b, 300, 100) }, contributors).notes;
		assert.ok(!close.some((n) => n.startsWith("The source mix")), close.join("\n"));
	});

	it("turns a total into a rate per measured session, so corpora of different sizes compare", () => {
		const r = row(section("failures"), "tool failures per session");
		assert.equal(r.a.text, "0.50");
		assert.equal(r.b.text, "2.00");
		assert.equal(r.diff, "×4.0");
	});

	it("turns a session count into a share of the measured sessions", () => {
		const r = row(section("failures"), "sessions with failures");
		assert.equal(r.a.text, "25%");
		assert.equal(r.b.text, "50%");
		assert.equal(r.diff, "+25 pp");
	});

	it("matches groups by their values, not by their position, and marks a group one side does not publish", () => {
		const s = section("failures");
		const shared = row(s, "by class: tool / command-failed");
		assert.equal(shared.a.text, "20%");
		assert.equal(shared.b.text, "20%");
		const missing = row(s, "by class: tool / path-not-found");
		assert.equal(missing.b.text, "–");
		assert.ok(missing.a.flags.includes("low"), "6 sessions is a low count");
	});

	it("marks a rate and a quantile low when they rest on few sessions", () => {
		const few = (fp: Fingerprint): Fingerprint => ({
			...fp,
			objective: {
				failures: { status: "ok", sessionsMeasured: 6, toolFailures: 12, sessionsWithFailures: 6, byClass: [] },
				shape: {
					status: "ok",
					sessionsMeasured: 6,
					promptsPerSession: { status: "ok", sessions: 6, unit: "prompts", p50: 3, p90: 9, buckets: [{ from: 0, to: null, sessions: 6 }] },
				},
			},
		});
		const compared = compareFingerprints({ label: "few", fingerprint: few(a) }, sides[1], contributors).sections;
		const of = (id: string) => compared.find((s) => s.id === id)!;
		assert.ok(row(of("failures"), "tool failures per session").a.flags.includes("low"), "a rate over 6 sessions is low");
		assert.ok(!row(of("failures"), "tool failures per session").b.flags.includes("low"), "a rate over 200 sessions is not low");
		for (const q of ["p50", "p90"]) {
			const r = row(of("shape"), `prompts per session ${q}`);
			assert.ok(r.a.flags.includes("low"), `a ${q} over 6 sessions is low`);
			assert.ok(!r.b.flags.includes("low"), `a ${q} over 400 sessions is not low`);
		}
	});

	it("compares distributions by their quantiles and by the share of sessions in each declared bucket", () => {
		const s = section("shape");
		assert.equal(row(s, "prompts per session p50").diff, "×2.0");
		assert.equal(row(s, "prompts per session: 0–2").a.text, "50%");
		const merged = row(s, "prompts per session: 0–2").b;
		assert.equal(merged.text, "75% (0–8)");
		assert.ok(merged.flags.includes("merged"));
		assert.equal(row(s, "prompts per session: 8+").b.text, "25%");
	});

	it("notes a section whose two sides were measured by different analyzer versions, and a side that mixes versions", () => {
		const versioned = (fp: Fingerprint, versions: unknown[]): Fingerprint => ({
			...fp,
			objective: { ...fp.objective, failures: { ...(fp.objective["failures"] as object), versions } },
		});
		const left = versioned(a, [{ analyzer: "failure-modes", version: "1.2", sessions: 100 }]);
		const right = versioned(b, [
			{ analyzer: "failure-modes", version: "1.3", sessions: 150 },
			{ analyzer: "failure-modes", version: "1.2", sessions: 50 },
		]);
		const failures = compareFingerprints({ label: "small", fingerprint: left }, { label: "large", fingerprint: right }, contributors).sections.find((s) => s.id === "failures");
		assert.deepEqual(failures?.notes, ["Analyzer versions differ: small failure-modes 1.2 (100%); large failure-modes 1.3 (75%), 1.2 (25%)."]);
		const same = compareFingerprints({ label: "small", fingerprint: left }, { label: "again", fingerprint: left }, contributors).sections.find((s) => s.id === "failures");
		assert.deepEqual(same?.notes, []);
	});

	it("notes a side measured on under half its sessions", () => {
		const thin: Fingerprint = {
			...a,
			objective: {
				...a.objective,
				shape: {
					status: "ok",
					sessionsMeasured: 40,
					promptsPerSession: { status: "ok", sessions: 40, unit: "prompts", p50: 2, p90: 9, buckets: [{ from: 0, to: null, sessions: 40 }] },
				},
			},
		};
		const shape = compareFingerprints({ label: "thin", fingerprint: thin }, sides[1], contributors).sections.find((s) => s.id === "shape");
		assert.deepEqual(shape?.notes, ["thin is measured on 40% of its sessions; its figures describe that subset."]);
	});

	it("says a withheld section is withheld rather than dropping it", () => {
		const s = section("mood");
		assert.equal(s.kind, "inferred");
		assert.equal(row(s, "signals per session").b.text, "withheld");
	});

	it("reads a fingerprint file and refuses anything else, naming the problem", () => {
		assert.deepEqual(parseFingerprintText(JSON.stringify(a), "a.json"), a);
		assert.throws(() => parseFingerprintText("{", "x.json"), /x\.json is not JSON/);
		assert.throws(() => parseFingerprintText(JSON.stringify({ kind: "other" }), "x.json"), /x\.json is not a corpus fingerprint/);
		assert.throws(() => parseFingerprintText(JSON.stringify({ ...a, schemaVersion: 1 }), "x.json"), /x\.json has schema version 1; this build reads version 2/);
	});

	it("renders text and markdown tables with both labels and a legend", () => {
		const comparison = compareFingerprints(sides[0], sides[1], contributors);
		const text = resolveCompareRenderer("text").render(comparison);
		assert.match(text, /small/);
		assert.match(text, /large/);
		assert.match(text, /tool failures per session\s+0\.50\s+2\.00\s+×4\.0/);
		const md = resolveCompareRenderer("markdown").render(comparison);
		assert.match(md, /\| tool failures per session \| 0\.50 \| 2\.00 \| ×4\.0 \|/);
		assert.throws(() => resolveCompareRenderer("xml"), /unknown format 'xml' \(use text, markdown\)/);
	});
});

describe("fingerprint compare arguments", () => {
	it("takes two files, labels them by file name, and reads --labels, --format and --out", () => {
		assert.deepEqual(parseCompareArgs("/x/laptop.json other/desk.json"), { files: ["/x/laptop.json", "other/desk.json"], labels: ["laptop", "desk"], format: undefined, out: undefined });
		assert.deepEqual(parseCompareArgs("a.json b.json --labels one,two --format markdown --out c.md"), {
			files: ["a.json", "b.json"],
			labels: ["one", "two"],
			format: "markdown",
			out: "c.md",
		});
	});

	it("names what is wrong with the arguments", () => {
		assert.throws(() => parseCompareArgs("a.json"), /compare takes two fingerprint files/);
		assert.throws(() => parseCompareArgs("a.json b.json c.json"), /compare takes two fingerprint files/);
		assert.throws(() => parseCompareArgs("a.json b.json --labels one"), /--labels takes two labels/);
		assert.throws(() => parseCompareArgs("a.json b.json --source pi"), /unknown flag --source \(use --labels, --format, --out\)/);
	});
});
