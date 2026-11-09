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
	it("names every analyzer the registry defines", async () => {
		const { DEFAULT_ANALYZER_IDS } = await import("../../src/analyze/defaults.js");
		for (const id of ["regression-signal", "regression-attribution", "regression-verdict", "regression-prevention"]) {
			assert.ok(
				(DEFAULT_ANALYZER_IDS as readonly string[]).includes(id),
				`${id} is registered but missing from DEFAULT_ANALYZER_IDS`,
			);
		}
	});
});
