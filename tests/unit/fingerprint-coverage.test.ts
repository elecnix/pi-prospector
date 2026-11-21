/**
 * The fingerprint's coverage of the built-in analyzers is exact: each one
 * either contributes a section or is listed in FINGERPRINT_EXCLUDED with a
 * reason, never both and never neither.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_ANALYZERS } from "../../src/analyze/defaults.js";
import { EXCLUSION_REASONS, FINGERPRINT_EXCLUDED } from "../../src/fingerprint/registry.js";

const contributing = BUILTIN_ANALYZERS.filter((a) => (a.fingerprint ?? []).length > 0).map((a) => a.def.id);
const silent = BUILTIN_ANALYZERS.filter((a) => (a.fingerprint ?? []).length === 0).map((a) => a.def.id);
const listed = Object.keys(FINGERPRINT_EXCLUDED);

describe("fingerprint coverage", () => {
	it("lists every built-in analyzer that contributes no section", () => {
		const missing = silent.filter((id) => !(id in FINGERPRINT_EXCLUDED));
		assert.deepEqual(missing, [], `contribute to the fingerprint or add to FINGERPRINT_EXCLUDED: ${missing.join(", ")}`);
	});

	it("lists no analyzer that contributes a section", () => {
		const stale = contributing.filter((id) => id in FINGERPRINT_EXCLUDED);
		assert.deepEqual(stale, [], `remove from FINGERPRINT_EXCLUDED, they now contribute: ${stale.join(", ")}`);
	});

	it("lists only built-in analyzers", () => {
		const ids = new Set(BUILTIN_ANALYZERS.map((a) => a.def.id));
		assert.deepEqual(listed.filter((id) => !ids.has(id)), []);
	});

	it("gives each listed analyzer one of the agreed reasons", () => {
		for (const [id, reason] of Object.entries(FINGERPRINT_EXCLUDED)) assert.ok(EXCLUSION_REASONS.includes(reason), `${id}: '${reason}'`);
	});
});
