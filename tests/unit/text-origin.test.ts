/**
 * Text origin: which parts of a turn's user text the person typed.
 *
 * A "user" message often carries words the person never wrote: a pasted log, a
 * quoted line, a prompt another agent relayed, a harness notification, or a copy
 * a fork took from its parent. These tests pin the labelling rules one label at a
 * time, then the mixed cases where one message holds several origins.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	labelUserText,
	isForkCopy,
	PASTE_MIN_LINES,
	type TextSpan,
	type TurnOriginContext,
} from "../../src/analyze/text-origin.js";

const USER: TurnOriginContext = { role: "user", childAgent: false, forkCopy: false };

/** The spans as `origin: text` pairs, which reads better in a failure diff. */
function shape(spans: TextSpan[]): string[] {
	return spans.map((s) => `${s.origin}: ${s.text.trim()}`);
}

describe("labelUserText", () => {
	it("labels a plain message typed", () => {
		assert.deepEqual(shape(labelUserText("this is wrong", USER)), ["typed: this is wrong"]);
	});

	it("never loses or reorders text: the spans concatenate to the message", () => {
		const text = "> it is broken\nthat is wrong\n\n```\nstack trace\n```\n<system-reminder>x</system-reminder> ok";
		assert.equal(labelUserText(text, USER).map((s) => s.text).join(""), text);
	});

	it("labels a line that starts with > as quoted, and keeps the reply typed", () => {
		assert.deepEqual(shape(labelUserText("> it is broken\nthat is wrong", USER)), [
			"quoted: > it is broken",
			"typed: that is wrong",
		]);
	});

	it("labels an indented quote quoted too", () => {
		assert.deepEqual(shape(labelUserText("   > it is broken", USER)), ["quoted: > it is broken"]);
	});

	it("labels a fenced block pasted", () => {
		assert.deepEqual(shape(labelUserText("see this:\n```\nerror: garbage in\n```\nwhy", USER)), [
			"typed: see this:",
			"pasted: ```\nerror: garbage in\n```",
			"typed: why",
		]);
	});

	it("labels a pasted-content block pasted", () => {
		const text = 'look <pasted_content id="p1">garbage everywhere</pasted_content> fix it';
		assert.deepEqual(shape(labelUserText(text, USER)), [
			"typed: look",
			'pasted: <pasted_content id="p1">garbage everywhere</pasted_content>',
			"typed: fix it",
		]);
	});

	it("labels a pasted-text placeholder line pasted", () => {
		assert.deepEqual(shape(labelUserText("[Pasted text #1 +40 lines]\nthis is wrong", USER)), [
			"pasted: [Pasted text #1 +40 lines]",
			"typed: this is wrong",
		]);
	});

	it(`labels a paragraph of ${PASTE_MIN_LINES} or more lines pasted, and a shorter one typed`, () => {
		const log = Array.from({ length: PASTE_MIN_LINES }, (_, i) => `2026-03-01 10:00:0${i} ERROR garbage`).join("\n");
		const short = Array.from({ length: PASTE_MIN_LINES - 1 }, (_, i) => `step ${i}`).join("\n");
		assert.deepEqual(
			labelUserText(`${log}\n\nthis is wrong`, USER).map((s) => s.origin),
			["pasted", "typed"],
		);
		assert.deepEqual(labelUserText(short, USER).map((s) => s.origin), ["typed"]);
	});

	it("labels harness tags notification and leaves the text around them typed", () => {
		const text = "this is wrong <system-reminder>awful reminder</system-reminder>";
		assert.deepEqual(shape(labelUserText(text, USER)), [
			"typed: this is wrong",
			"notification: <system-reminder>awful reminder</system-reminder>",
		]);
	});

	for (const tag of ["task-notification", "local-command-stdout", "bash-stdout", "channel", "command-name"]) {
		it(`labels a <${tag}> block notification`, () => {
			const spans = labelUserText(`<${tag}>awful</${tag}>`, USER);
			assert.deepEqual(spans.map((s) => s.origin), ["notification"]);
		});
	}

	it("labels a compaction continuation notification as a whole", () => {
		const text = "This session is being continued from a previous conversation that ran out of context.\n> the user said it was wrong";
		assert.deepEqual(labelUserText(text, USER).map((s) => s.origin), ["notification"]);
	});

	for (const role of ["custom_message", "branch_summary", "bashExecution"]) {
		it(`labels a ${role} turn notification as a whole`, () => {
			assert.deepEqual(labelUserText("awful output", { ...USER, role }).map((s) => s.origin), ["notification"]);
		});
	}

	it("labels a message signed by an agent handle agent as a whole", () => {
		for (const sig of ["— swift-koala-42", "— cc-eager-owl-07", "-- calm-river-3"]) {
			const spans = labelUserText(`the build is useless\n\n${sig}`, USER);
			assert.deepEqual(spans.map((s) => s.origin), ["agent"], sig);
		}
	});

	it("does not take a dash in prose for a signature", () => {
		assert.deepEqual(labelUserText("this is wrong — again", USER).map((s) => s.origin), ["typed"]);
	});

	it("labels a teammate message block agent", () => {
		const text = 'ok <teammate-message teammate_id="t1">useless</teammate-message>';
		assert.deepEqual(labelUserText(text, USER).map((s) => s.origin), ["typed", "agent"]);
	});

	it("labels every turn of a child agent's session agent", () => {
		assert.deepEqual(labelUserText("> quoted\ntyped", { ...USER, childAgent: true }).map((s) => s.origin), ["agent"]);
	});

	it("labels a fork's copy fork-copy, ahead of every other rule", () => {
		const ctx = { ...USER, childAgent: true, forkCopy: true };
		assert.deepEqual(labelUserText("> quoted\n<system-reminder>x</system-reminder>", ctx).map((s) => s.origin), ["fork-copy"]);
	});

	it("returns no spans for empty text", () => {
		assert.deepEqual(labelUserText("", USER), []);
	});
});

describe("isForkCopy", () => {
	const parent = [{ text: "this is wrong", timestamp: "2026-03-01T10:00:05.000Z" }];

	it("is a copy when the parent holds the same text at the same time", () => {
		assert.equal(isForkCopy({ text: "this is wrong", timestamp: "2026-03-01T10:00:05.000Z" }, null, parent), true);
	});

	it("is a copy when the parent holds the same text and the message predates the fork", () => {
		assert.equal(
			isForkCopy({ text: "this is wrong", timestamp: "2026-03-01T10:00:06.000Z" }, "2026-03-01T11:00:00.000Z", parent),
			true,
		);
	});

	it("is not a copy when the person types the same words again after the fork", () => {
		assert.equal(
			isForkCopy({ text: "this is wrong", timestamp: "2026-03-01T11:30:00.000Z" }, "2026-03-01T11:00:00.000Z", parent),
			false,
		);
	});

	it("is not a copy when the parent never held that text", () => {
		assert.equal(isForkCopy({ text: "something new", timestamp: "2026-03-01T10:00:05.000Z" }, null, parent), false);
	});
});
