import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { queryTerms, matchExpression, windowText, overlapScore, formatRecallContext } from "../../src/analyze/analyzers/session-overview/recall.js";

describe("recall windowing", () => {
	it("keeps short text as one window and drops blank text", () => {
		assert.deepEqual(windowText("short", 100, 10), ["short"]);
		assert.deepEqual(windowText("   ", 100, 10), []);
	});

	it("overlaps consecutive windows and covers the whole text", () => {
		const text = "abcdefghijklmnopqrstuvwxyz";
		const w = windowText(text, 10, 3);
		assert.deepEqual(w, ["abcdefghij", "hijklmnopq", "opqrstuvwx", "vwxyz"]);
		for (let i = 1; i < w.length; i++) assert.equal(w[i - 1]!.slice(-3), w[i]!.slice(0, 3));
		assert.ok(w.join("").length >= text.length);
	});

	it("refuses an impossible window shape instead of looping", () => {
		assert.throws(() => windowText("x".repeat(50), 10, 10), /recallOverlapChars/);
		assert.throws(() => windowText("x".repeat(50), 0, 0), /recallWindowChars/);
	});
});

describe("recall query", () => {
	it("takes distinct terms of four or more characters, longest first, deterministically", () => {
		assert.deepEqual(queryTerms("no, use the auth module; auth AUTH"), ["module", "auth"]);
		assert.deepEqual(queryTerms("a b c"), []);
	});

	it("quotes every term so FTS operators in user text stay literal", () => {
		assert.equal(matchExpression(["near", 'a"b']), 'content_text : ("near" OR "a""b")');
		assert.equal(matchExpression([]), null);
	});

	it("scores a window by the share of query terms it contains", () => {
		assert.equal(overlapScore("Use the AUTH module", ["auth", "module", "login", "token"]), 0.5);
		assert.equal(overlapScore("anything", []), 0);
	});
});

describe("recall context", () => {
	it("is empty when nothing was recalled and cites session and time otherwise", () => {
		assert.equal(formatRecallContext([]), "");
		const out = formatRecallContext([
			{ messageId: "m1", sessionId: "abcdef123456", role: "user", timestamp: "2026-01-01T00:00:00Z", text: "use auth", contentHash: "h", overlap: 1 },
		]);
		assert.match(out, /session abcdef12 · 2026-01-01T00:00:00Z · user/);
		assert.match(out, /use auth/);
	});
});
