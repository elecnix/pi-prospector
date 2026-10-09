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

	it("reports ids that match no registered analyzer, once each", () => {
		const r = resolveDefaultAnalyzers(REGISTERED, {
			defaultAnalyzers: ["alpha", "alhpa"],
			disabledAnalyzers: ["alhpa", "delta"],
		});
		assert.deepEqual(r, { ids: ["alpha"], unknown: ["alhpa", "delta"] });
	});

	it("selects nothing for an empty allowlist", () => {
		assert.deepEqual(resolveDefaultAnalyzers(REGISTERED, { defaultAnalyzers: [] }), { ids: [], unknown: [] });
	});
});
