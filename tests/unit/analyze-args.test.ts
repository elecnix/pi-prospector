import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseAnalyzeArgs } from "../../src/commands/analyze.js";

describe("analyze --revise-where", () => {
	it("collects repeatable key=value filters beside the revise reasons", () => {
		const args = parseAnalyzeArgs("--revise minor --revise-where category=profanity --revise-where language=en");
		assert.deepEqual(args.revise, ["minor"]);
		assert.deepEqual(args.reviseWhere, [
			{ key: "category", raw: "profanity" },
			{ key: "language", raw: "en" },
		]);
	});

	it("refuses a filter with no revise reason, which would narrow nothing", () => {
		assert.throws(() => parseAnalyzeArgs("--revise-where category=profanity"), /--revise-where narrows a revise/);
	});

	it("refuses a malformed filter, naming the flag", () => {
		assert.throws(() => parseAnalyzeArgs("--revise minor --revise-where profanity"), /malformed --revise-where/);
	});
});
