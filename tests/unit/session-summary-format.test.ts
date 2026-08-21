import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatSummaryContent } from "../../src/commands/show.js";

describe("formatSummaryContent", () => {
	const content = {
		session_summary: "The session fixed a login bug.\nA wrong approach was corrected in turn 2.",
		friction_points: [
			{
				description: "guessed the module path",
				what_to_change: "discover the path before reading",
				evidence: "user corrected after the failed read",
				severity: "high",
			},
			{ description: "second friction", what_to_change: "", evidence: "", severity: "low" },
		],
		key_positive_signals: [{ description: "clean recovery after correction", signal: "correction-then-clean-recovery" }],
		stats: { pairs: 2, high_signal: 1, positive_signals: 1 },
	};

	it("renders the summary, every friction gradient, positive signals, and stats", () => {
		const text = formatSummaryContent(content).join("\n");
		assert.match(text, /what happened:/);
		assert.match(text, /fixed a login bug/);
		assert.match(text, /Friction \(2\):/);
		assert.match(text, /\u2022 \[high\] guessed the module path/);
		assert.match(text, /change: discover the path before reading/);
		assert.match(text, /evidence: user corrected after the failed read/);
		assert.match(text, /\u2022 \[low\] second friction/); // fields absent → no change/evidence lines
		assert.doesNotMatch(text, /change: $/m);
		assert.match(text, /What went well \(1\):/);
		assert.match(text, /clean recovery after correction \(correction-then-clean-recovery\)/);
		assert.match(text, /Stats: pairs=2 high_signal=1 positive_signals=1/);
	});

	it("renders honest empties instead of dropping sections", () => {
		const text = formatSummaryContent({}).join("\n");
		assert.match(text, /\(no summary text recorded\)/);
		assert.match(text, /Friction \(0\):\n\s*\(none enumerated\)/);
		assert.match(text, /What went well \(0\):\n\s*\(none recorded\)/);
		assert.doesNotMatch(text, /Stats:/); // absent stats are absent, not zero
	});
});
