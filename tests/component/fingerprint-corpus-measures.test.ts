import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GraphSeed } from "./fingerprint-graph.js";
import { ASOF, seedSession } from "./fingerprint-seed.js";
import { buildFingerprint, parseFingerprintArgs } from "../../src/fingerprint/build.js";
import type { FingerprintContributor, FingerprintRow, MeasureSpec } from "../../src/fingerprint/contributor.js";

/** The builder's side of the corpus measures: distinct counts and the minimum group size. */

async function measure(rows: FingerprintRow[], measures: MeasureSpec[]): Promise<Record<string, unknown>> {
	const g = await GraphSeed.open();
	try {
		for (let i = 0; i < 6; i++) await seedSession(g.t.db, `s${i}`);
		const contributor: FingerprintContributor = {
			def: { id: "corpus", label: "Corpus", description: "d", kind: "objective", measures },
			read: async () => ({ measured: ["s0", "s1", "s2", "s3", "s4", "s5"], rows }),
		};
		const fp = await buildFingerprint(g.t.db, parseFingerprintArgs(`--as-of ${ASOF}`, new Date(ASOF)), [contributor]);
		return fp.objective["corpus"] as Record<string, unknown>;
	} finally {
		await g.close();
	}
}

const COUNT: MeasureSpec = { kind: "corpusCount", id: "clusters", field: "seen", key: "shape", of: "clusters" };
const GROUPS: MeasureSpec = { kind: "corpusGroups", id: "byMatch", dimensions: { match: ["exact", "near"] }, key: "shape", total: "clusters", of: "clusters" };

describe("fingerprint: corpus measures", () => {
	it("counts a thing that several sessions report once, and never prints its key", async () => {
		const rows = [0, 1, 2, 3, 4].map((i) => ({ session: `s${i}`, seen: 1, shape: "hunter2", match: "exact" }));
		const s = await measure(rows, [COUNT, GROUPS]);
		assert.equal(s["clusters"], 1);
		assert.deepEqual(s["byMatch"], [{ match: "exact", count: 1, sessions: 5 }]);
		assert.ok(!JSON.stringify(s).includes("hunter2"));
	});

	it("sums the field when there is no key", async () => {
		const rows = [0, 1, 2, 3, 4].map((i) => ({ session: `s${i}`, seen: 2 }));
		const { key: _key, ...sum } = COUNT as { key?: string } & MeasureSpec;
		assert.equal((await measure(rows, [sum as MeasureSpec]))["clusters"], 10);
	});

	it("withholds a count that rests on fewer than five sessions", async () => {
		const rows = [0, 1, 2, 3].map((i) => ({ session: `s${i}`, seen: 1, shape: `x${i}`, match: "exact" }));
		const s = await measure(rows, [COUNT, GROUPS]);
		assert.deepEqual(s["clusters"], { status: "withheld", reason: "below-min-group-size" });
		assert.deepEqual(s["byMatch"], []);
	});

	it("folds a value outside the list into other", async () => {
		const rows = [0, 1, 2, 3, 4].map((i) => ({ session: `s${i}`, seen: 1, shape: `x${i}`, match: "hunter2" }));
		assert.deepEqual((await measure(rows, [COUNT, GROUPS]))["byMatch"], [{ match: "other", count: 5, sessions: 5 }]);
	});
});
