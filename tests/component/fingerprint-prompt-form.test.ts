import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { tempDb, type TempDb } from "./helpers.js";
import { countsOf, fingerprintOf, ids, sectionOf, seedNode, seedRun, seedSession } from "./fingerprint-seed.js";

/**
 * The prompt-form sections: the form of the prompts a person typed (objective)
 * and what each prompt was doing (inferred). Five sessions ran the analyzer at
 * the default buckets and one ran it with other bounds.
 */

let t: TempDb;
const DEFAULT_BUCKETS = [20, 80, 300, 1000, null];

function node(over: { typed?: number; buckets?: Array<number | null>; counts?: number[]; question?: number; unknown?: number } = {}) {
	const bounds = over.buckets ?? DEFAULT_BUCKETS;
	const counts = over.counts ?? [1, 2, 0, 0, 1];
	return {
		session_id: "hunter2",
		typed_message_count: over.typed ?? 4,
		no_own_words_count: 0,
		undecided_message_count: 1,
		kinds: { question: over.question ?? 1, instruction: 2, correction: 1, other: 0, unknown: over.unknown ?? 1 },
		sum_chars: 400,
		median_chars: 50,
		p90_chars: 300,
		max_chars: 1200,
		length_buckets: bounds.map((le, i) => ({ le_chars: le, count: counts[i] ?? 0 })),
		list_count: 1,
		heading_count: 0,
		code_block_count: 2,
	};
}

describe("prompt-form fingerprint", () => {
	before(async () => {
		t = await tempDb();
		for (const id of ids("s", 5)) {
			await seedSession(t.db, id);
			await seedRun(t.db, id, "prompt-form", "1.0");
			await seedNode(t.db, id, "prompt-form", node(), "1.0");
		}
		await seedSession(t.db, "custom");
		await seedRun(t.db, "custom", "prompt-form", "1.0");
		await seedNode(t.db, "custom", "prompt-form", node({ buckets: [50, null], counts: [3, 1] }), "1.0");
		await seedSession(t.db, "never-ran");
	});
	after(() => t.close());

	it("counts typed prompts, their length buckets and their structure, ", async () => {
		const section = sectionOf(await fingerprintOf(t.db), "objective", "promptForm");
		assert.equal(section.status, "ok");
		assert.equal(section.sessionsMeasured, 6);
		assert.equal(section["typedPrompts"], 24);
		assert.equal(section["sessionsWithTypedPrompts"], 6);
		assert.equal(section["characters"], 2400);
		assert.equal(section["withList"], 6);
		assert.equal(section["withCodeBlock"], 12);
		// The session with other bounds has 4 prompts, under the minimum on its own: folded and withheld.
		assert.deepEqual(countsOf(section["byLength"], ["length"]), { "0-20": 5, "20-80": 10, "over-1000": 5 });
	});

	it("counts the kind of each typed prompt, unknown apart", async () => {
		const section = sectionOf(await fingerprintOf(t.db), "inferred", "promptKind");
		assert.equal(section.status, "ok");
		assert.deepEqual(countsOf(section["byKind"], ["kind"]), { question: 6, instruction: 12, correction: 6, unknown: 6 });
	});
});
