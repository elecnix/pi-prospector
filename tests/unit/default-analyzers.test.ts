import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveDefaultAnalyzers } from "../../src/config.js";

const REGISTERED = ["alpha", "beta", "gamma"];

describe("resolveDefaultAnalyzers (#291)", () => {
	it("selects every registered analyzer when neither field is set", () => {
		assert.deepEqual(resolveDefaultAnalyzers(REGISTERED, {}), { ids: REGISTERED, unknown: [] });
	});

	it("narrows to the allowlist, in registration order", () => {
		const r = resolveDefaultAnalyzers(REGISTERED, { defaultAnalyzers: ["gamma", "alpha"] });
		assert.deepEqual(r, { ids: ["alpha", "gamma"], unknown: [] });
	});

	it("removes the denylist from every registered analyzer", () => {
		const r = resolveDefaultAnalyzers(REGISTERED, { disabledAnalyzers: ["beta"] });
		assert.deepEqual(r, { ids: ["alpha", "gamma"], unknown: [] });
	});

	it("applies the denylist after the allowlist", () => {
		const r = resolveDefaultAnalyzers(REGISTERED, { defaultAnalyzers: ["alpha", "beta"], disabledAnalyzers: ["beta"] });
		assert.deepEqual(r, { ids: ["alpha"], unknown: [] });
	});

	it("reports ids that match no registered analyzer, once per field", () => {
		const r = resolveDefaultAnalyzers(REGISTERED, {
			defaultAnalyzers: ["alpha", "alhpa", "alhpa"],
			disabledAnalyzers: ["alhpa", "delta", "beta"],
		});
		assert.deepEqual(r, {
			ids: ["alpha"],
			unknown: [
				{ field: "defaultAnalyzers", id: "alhpa" },
				{ field: "disabledAnalyzers", id: "alhpa" },
				{ field: "disabledAnalyzers", id: "delta" },
			],
		});
	});

	it("selects nothing for an empty allowlist", () => {
		assert.deepEqual(resolveDefaultAnalyzers(REGISTERED, { defaultAnalyzers: [] }), { ids: [], unknown: [] });
	});
});

describe("DEFAULT_ANALYZER_IDS matches what is registered", () => {
	// The list and the registry drifted once already: four analyzers were registered and the
	// id list still ended at the previous entry, so anything selecting the default set ran
	// 53 analyzers and never ran the regression graph. A list that must mirror a registry is
	// a thing to assert, not a thing to remember.
	it("includes every regression analyzer the registry defines", async () => {
		// Derive the set from the registry instead of restating four ids: a hardcoded list passes
		// when a fifth regression analyzer is registered and the default list is not extended,
		// which is exactly the drift that happened — all four were registered, the id list was
		// never extended, and a default run executed the other analyzers and none of these.
		//
		// Not an equality check: DEFAULT_ANALYZER_IDS draws from a wider id space than
		// BUILTIN_ANALYZERS, so the two are not the same set and never were.
		const { DEFAULT_ANALYZER_IDS, BUILTIN_ANALYZERS } = await import("../../src/analyze/defaults.js");
		const listed = DEFAULT_ANALYZER_IDS as readonly string[];
		const regression = BUILTIN_ANALYZERS.map((a: { def: { id: string } }) => a.def.id).filter((id: string) => id.startsWith("regression-"));

		assert.ok(regression.length >= 4, `expected four regression analyzers in the registry, found ${regression.length}`);
		for (const id of regression) {
			assert.ok(listed.includes(id), `${id} is registered but missing from DEFAULT_ANALYZER_IDS`);
		}
	});
});
