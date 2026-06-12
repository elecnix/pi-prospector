import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toolCallPreview, renderAnchoredTurns, formatAmbiguousMatches } from "../../src/commands/show.js";
import type { TurnPair } from "../../src/analyze/analyzers/turn-pair-core/build.js";
import type { MessageRow } from "../../src/analyze/types.js";

function msg(over: Partial<MessageRow> & { id: string; role: string }): MessageRow {
	return {
		session_id: "s",
		parent_id: null,
		timestamp: null,
		content_text: null,
		content_thinking: null,
		tool_calls: null,
		tool_results: null,
		...over,
	};
}

describe("toolCallPreview", () => {
	it("prefers the most salient argument and collapses whitespace", () => {
		assert.match(toolCallPreview("bash", { command: "git push  origin\n  main" }), /^bash {2}git push origin main$/);
		assert.equal(toolCallPreview("read", { path: "/a/b.ts" }), "read  /a/b.ts");
		assert.equal(toolCallPreview("grep", { pattern: "foo" }), "grep  foo");
	});

	it("falls back to JSON when no salient key is present", () => {
		assert.match(toolCallPreview("custom", { foo: 1 }), /custom {2}\{"foo":1\}/);
	});

	it("truncates long arguments", () => {
		const long = "x".repeat(500);
		const p = toolCallPreview("bash", { command: long });
		assert.ok(p.length < 200 && p.endsWith("…"));
	});
});

describe("renderAnchoredTurns", () => {
	const pairs: TurnPair[] = [
		{ index: 0, userMessageId: "u0", messageIds: ["u0", "a0", "r0"], userText: "do the thing", assistantText: "", thinkingText: "", toolCalls: [], toolResults: [], priorUserText: null, timestamp: null },
		{ index: 1, userMessageId: "u1", messageIds: ["u1", "a1"], userText: "no, that's wrong", assistantText: "", thinkingText: "", toolCalls: [], toolResults: [], priorUserText: "do the thing", timestamp: null },
	];
	const byId = new Map<string, MessageRow>([
		["u0", msg({ id: "u0", role: "user", content_text: "do the thing" })],
		["a0", msg({ id: "a0", role: "assistant", content_text: "on it", tool_calls: JSON.stringify([{ name: "bash", arguments: { command: "git push origin main" } }]) })],
		["r0", msg({ id: "r0", role: "toolResult", content_text: "fatal: remote rejected", tool_results: JSON.stringify([{ isError: true }]) })],
		["u1", msg({ id: "u1", role: "user", content_text: "no, that's wrong" })],
		["a1", msg({ id: "a1", role: "assistant", content_text: "sorry" })],
	]);
	const coreByUser = new Map<string, Record<string, unknown>>([
		["u0", { user_message_id: "u0", friction_score: 0.9, tool_failure_count: 1, tool_call_count: 1, correction_detected: false, high_signal: true }],
		["u1", { user_message_id: "u1", friction_score: 0.6, tool_failure_count: 0, tool_call_count: 0, correction_detected: true, correction_type: "explicit", high_signal: true }],
	]);
	const llmByUser = new Map<string, Record<string, unknown>>([
		["u1", { user_message_id: "u1", sentiment: "frustrated", friction_type: "wrong_approach", severity: "medium" }],
	]);

	it("renders verbatim user text, tool-call args, and tool errors", () => {
		const text = renderAnchoredTurns(pairs, byId, new Set(["u0", "u1"]), coreByUser, llmByUser).join("\n");
		assert.match(text, /pair #0 · friction=0\.90 · tool_fail=1\/1/);
		assert.match(text, /git push origin main/); // tool-call argument is surfaced
		assert.match(text, /✗ fatal: remote rejected/); // tool error surfaced
		assert.match(text, /no, that's wrong/); // verbatim user text
		assert.match(text, /sentiment=frustrated type=wrong_approach sev=medium/);
		assert.match(text, /correction=explicit/);
	});

	it("orders by pair index and respects maxTurns with a remainder note", () => {
		const text = renderAnchoredTurns(pairs, byId, new Set(["u0", "u1"]), coreByUser, llmByUser, 1).join("\n");
		assert.match(text, /pair #0/);
		assert.doesNotMatch(text, /pair #1/);
		assert.match(text, /…1 more turn\(s\) not shown\./);
	});
});

describe("formatAmbiguousMatches", () => {
	// Same-run uuidv7 ids share a long timestamp prefix; only chars ≥15 differ.
	const matches = [
		{ id: "019eb958-b8ce-72f1-178e-4d5d544a1aac", title: "Create a git-push skill" },
		{ id: "019eb958-b8ce-7531-28eb-42e0c470bb52", title: "Add explicit git push target verification" },
		{ id: "019eb958-b8ce-7a86-9bda-c851849149a3", title: "Add repetition-loop escape hatch rule" },
	];

	it("lists every match with its title and a uniquely-resolvable, non-identical id prefix", () => {
		const text = formatAmbiguousMatches("019eb958", matches);
		// Every title is shown so the user can tell the proposals apart.
		for (const m of matches) assert.ok(text.includes(m.title), `missing title: ${m.title}`);
		// Regression guard for the old `id.slice(0, 8)` bug: the per-match id
		// fragments must NOT all be identical.
		const frags = text
			.split("\n")
			.filter((l) => /^\s+0/.test(l))
			.map((l) => l.trim().split(/\s{2,}/)[0]!.replace(/…$/, ""));
		assert.equal(frags.length, matches.length);
		assert.equal(new Set(frags).size, matches.length, `id fragments not distinct: ${frags.join(", ")}`);
		// Each displayed fragment uniquely resolves its proposal via startsWith.
		for (const frag of frags) {
			assert.equal(matches.filter((m) => m.id.startsWith(frag)).length, 1, `fragment not unique: ${frag}`);
		}
	});
});
