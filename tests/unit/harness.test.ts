import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { harnessLabel, isHarnessSource, parseHarnessSource, HARNESS_SOURCES } from "../../src/harness.js";

describe("harnessLabel", () => {
	it("labels the three harnesses", () => {
		assert.equal(harnessLabel("pi"), "Pi");
		assert.equal(harnessLabel("claude"), "Claude");
		assert.equal(harnessLabel("codex"), "Codex");
	});

	it("renders a missing or unknown source as 'unknown', never Pi", () => {
		assert.equal(harnessLabel(null), "unknown");
		assert.equal(harnessLabel(undefined), "unknown");
		assert.equal(harnessLabel(""), "unknown");
		assert.equal(harnessLabel("bogus"), "unknown");
	});
});

describe("isHarnessSource / HARNESS_SOURCES", () => {
	it("accepts only the three real sources", () => {
		assert.deepEqual(HARNESS_SOURCES, ["pi", "claude", "codex"]);
		assert.equal(isHarnessSource("pi"), true);
		assert.equal(isHarnessSource("claude"), true);
		assert.equal(isHarnessSource("codex"), true);
		assert.equal(isHarnessSource(""), false);
		assert.equal(isHarnessSource(null), false);
		assert.equal(isHarnessSource("bogus"), false);
	});
});

describe("parseHarnessSource", () => {
	it("returns undefined when absent or empty", () => {
		assert.equal(parseHarnessSource(undefined), undefined);
		assert.equal(parseHarnessSource(""), undefined);
	});

	it("normalises case and whitespace", () => {
		assert.equal(parseHarnessSource(" pi "), "pi");
		assert.equal(parseHarnessSource("CLAUDE"), "claude");
		assert.equal(parseHarnessSource("Codex"), "codex");
	});

	it("throws on an unknown source so a typo fails loudly", () => {
		assert.throws(() => parseHarnessSource("claude code"), /unknown source/);
		assert.throws(() => parseHarnessSource("codex-cli"), /unknown source/);
	});
});
