import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAnalyzerConfigOverrides } from "../../src/config.js";
import { normalizeDictionary } from "../../src/analyze/analyzers/turn-frustration/dictionary.js";

afterEach(() => {
	delete process.env["PROSPECTOR_CONFIG"];
});

describe("lexicon dictionary config", () => {
	it("injects the mode and the normalised, sorted dictionary into turn-frustration", () => {
		const overrides = getAnalyzerConfigOverrides({
			analyzers: { "turn-frustration": { minConfidence: 0.7 } },
			lexicon: {
				mode: "both",
				dictionary: [
					{ term: "Zut", category: "profanity" },
					{ term: "laisse tomber", category: "dissatisfaction", language: "fr" },
					{ term: "nickel", category: "praise" },
				],
			},
		});
		assert.deepEqual(overrides, {
			"turn-frustration": {
				minConfidence: 0.7,
				lexiconMode: "both",
				dictionary: [
					{ term: "laisse tomber", polarity: "frustration", category: "dissatisfaction", language: "fr" },
					{ term: "nickel", polarity: "praise", category: "praise", language: "und" },
					{ term: "zut", polarity: "frustration", category: "profanity", language: "und" },
				],
			},
		});
	});

	it("turns off adjudication in dictionary mode, and only there", () => {
		const dictionary = [{ term: "zut", category: "profanity" }];
		assert.deepEqual(getAnalyzerConfigOverrides({ lexicon: { mode: "dictionary", dictionary } })["frustration-lexicon"], { adjudicate: false });
		assert.equal(getAnalyzerConfigOverrides({ lexicon: { mode: "both", dictionary } })["frustration-lexicon"], undefined);
	});

	it("reads the dictionary from a JSON file, relative to the config file", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lexdict-"));
		try {
			fs.writeFileSync(path.join(dir, "words.json"), JSON.stringify([{ term: "zut", category: "profanity" }]));
			process.env["PROSPECTOR_CONFIG"] = path.join(dir, "prospector.json");
			const overrides = getAnalyzerConfigOverrides({ lexicon: { mode: "dictionary", dictionary: "words.json" } });
			assert.deepEqual(overrides["turn-frustration"]?.["dictionary"], [
				{ term: "zut", polarity: "frustration", category: "profanity", language: "und" },
			]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("rejects an unknown mode", () => {
		assert.throws(
			() => getAnalyzerConfigOverrides({ lexicon: { mode: "dict" as never, dictionary: [{ term: "zut", category: "profanity" }] } }),
			/lexicon\.mode/,
		);
	});

	it("rejects a dictionary mode with no entries", () => {
		assert.throws(() => getAnalyzerConfigOverrides({ lexicon: { mode: "dictionary" } }), /lexicon\.dictionary/);
	});

	it("rejects an entry the tokeniser cannot match as written", () => {
		assert.throws(() => normalizeDictionary([{ term: "v2", category: "profanity" }]), /v2/);
		assert.throws(() => normalizeDictionary([{ term: "à bout", category: "dissatisfaction" }]), /à bout/);
	});

	it("rejects two entries for the same term", () => {
		assert.throws(
			() => normalizeDictionary([{ term: "zut", category: "profanity" }, { term: "ZUT", category: "dissatisfaction" }]),
			/zut/,
		);
	});

	it("rejects an entry with no category", () => {
		assert.throws(() => normalizeDictionary([{ term: "zut" } as never]), /category/);
	});
});
