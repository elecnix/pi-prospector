import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compareFingerprints } from "../../src/fingerprint/compare.js";
import { checkContributorDef, type FingerprintContributor } from "../../src/fingerprint/contributor.js";
import type { Fingerprint } from "../../src/fingerprint/schema.js";

/** Corpus counts: figures about a corpus as a whole, which the comparison must not divide by its sessions. */

const contributor: FingerprintContributor = {
	def: {
		id: "lexicon",
		label: "Lexicon",
		description: "Terms judged.",
		kind: "inferred",
		measures: [
			{ kind: "corpusCount", id: "termsJudged", field: "judged", of: "terms" },
			{ kind: "corpusGroups", id: "byPolarity", dimensions: { polarity: ["praise", "neutral"] }, total: "termsJudged", of: "terms" },
		],
	},
	read: async () => ({ measured: [], rows: [] }),
};

const fingerprint = (sessions: number, section: unknown): Fingerprint => ({
	schemaVersion: 2,
	kind: "corpus-fingerprint",
	asOf: "2026-06-30",
	filter: { sources: null, from: null, to: null },
	minGroupSize: 5,
	sessions: { count: sessions },
	period: { from: "2026-03", to: "2026-06" },
	objective: {},
	inferred: { lexicon: section },
});
const a = fingerprint(100, {
	status: "ok",
	sessionsMeasured: 100,
	termsJudged: 400,
	byPolarity: [
		{ polarity: "neutral", count: 300, sessions: 100 },
		{ polarity: "praise", count: 40, sessions: 10 },
	],
});
const b = fingerprint(1000, { status: "ok", sessionsMeasured: 1000, termsJudged: 800, byPolarity: [{ polarity: "neutral", count: 400, sessions: 900 }] });
const rows = (x: Fingerprint, y: Fingerprint) => compareFingerprints({ label: "a", fingerprint: x }, { label: "b", fingerprint: y }, [contributor]).sections[0]!.rows;

describe("corpus measures in a comparison", () => {
	it("shows a corpus count as it is, not divided by the sessions", () => {
		const row = rows(a, b).find((r) => r.label === "terms judged (terms in the corpus)");
		assert.ok(row);
		assert.equal(row.a.text, "400");
		assert.equal(row.b.text, "800");
		assert.equal(row.diff, "×2.0");
	});

	it("shows a corpus group as a share of the count it names, not of the sessions", () => {
		const row = rows(a, b).find((r) => r.label === "by polarity: neutral (share of terms judged)");
		assert.ok(row);
		assert.equal(row.a.text, "75%");
		assert.equal(row.b.text, "50%");
		assert.equal(row.diff, "-25 pp");
	});

	it("marks a group one side lacks, and one that rests on few sessions", () => {
		const row = rows(a, b).find((r) => r.label === "by polarity: praise (share of terms judged)");
		assert.ok(row);
		assert.deepEqual(row.a.flags, ["low"]);
		assert.deepEqual(row.b.flags, ["absent"]);
	});

	it("withholds the shares when the count they divide by is withheld", () => {
		const withheld = fingerprint(100, { status: "ok", sessionsMeasured: 100, termsJudged: { status: "withheld", reason: "below-min-group-size" }, byPolarity: [] });
		const all = rows(withheld, b);
		assert.deepEqual(all.find((r) => r.label === "terms judged (terms in the corpus)")!.a.flags, ["withheld"]);
		assert.deepEqual(all.find((r) => r.label.startsWith("by polarity: neutral"))!.a.flags, ["withheld"]);
	});

	it("names the corpus count when neither side has it", () => {
		const empty = fingerprint(100, { status: "withheld", reason: "below-min-group-size" });
		assert.ok(rows(empty, empty).some((r) => r.label === "terms judged (terms in the corpus)"));
	});
});

describe("corpus measures in a definition", () => {
	it("refuses a group whose total is not a corpus count of the section", () => {
		const def = { ...contributor.def, measures: [contributor.def.measures[1]!] };
		assert.throws(() => checkContributorDef(def), /total 'termsJudged'/);
	});

	it("refuses a group that counts another unit than its total", () => {
		const groups = { ...contributor.def.measures[1]!, of: "commands" } as FingerprintContributor["def"]["measures"][number];
		assert.throws(() => checkContributorDef({ ...contributor.def, measures: [contributor.def.measures[0]!, groups] }), /total 'termsJudged'/);
	});
});
