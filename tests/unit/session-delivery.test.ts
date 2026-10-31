/**
 * Unit tests for session-delivery detection. Pure functions, no database, no
 * mocks: hand-written synthetic rows only.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deliveryKindsOf, findDeliveryEvents } from "../../src/analyze/analyzers/session-delivery/detect.js";
import { DEFAULT_SESSION_DELIVERY_CONFIG } from "../../src/analyze/analyzers/session-delivery/config.js";
import type { MessageRow } from "../../src/analyze/types.js";
import { makeMessageRow as row } from "./helpers.js";

function shell(id: string, command: string, text: string, isError = false): MessageRow[] {
	return [
		row({
			id: `call-${id}`,
			role: "assistant",
			timestamp: "2026-10-01T10:00:00.000Z",
			tool_calls: JSON.stringify([{ id, name: "bash", arguments: { command } }]),
		}),
		row({
			id: `result-${id}`,
			role: "toolResult",
			content_text: text,
			tool_results: JSON.stringify([{ toolCallId: id, toolName: "bash", isError, textLength: text.length }]),
		}),
	];
}

describe("deliveryKindsOf", () => {
	it("reads commit, push, and merge, one per segment", () => {
		assert.deepEqual(deliveryKindsOf(`git add -A && git commit -m "x" && git push origin x`), ["commit", "push"]);
		assert.deepEqual(deliveryKindsOf("gh pr merge 12 --squash"), ["pr_merge"]);
	});

	it("reads git with global options", () => {
		assert.deepEqual(deliveryKindsOf(`git -C /repo commit -m x`), ["commit"]);
	});

	it("ignores mentions, dry runs, and an armed merge", () => {
		assert.deepEqual(deliveryKindsOf(`echo "git commit"`), []);
		assert.deepEqual(deliveryKindsOf("git log --grep commit"), []);
		assert.deepEqual(deliveryKindsOf("git push --dry-run"), []);
		assert.deepEqual(deliveryKindsOf("git push -n origin x"), []);
		assert.deepEqual(deliveryKindsOf("gh pr merge 12 --auto --squash"), []);
	});

	it("ignores an unquoted mention of a command that does not run it", () => {
		assert.deepEqual(deliveryKindsOf("echo git commit"), []);
		assert.deepEqual(deliveryKindsOf("grep -l git push notes.txt"), []);
		assert.deepEqual(deliveryKindsOf("echo gh pr merge 12"), []);
	});

	it("reads a command behind a wrapper, an environment assignment, or a leading cd", () => {
		assert.deepEqual(deliveryKindsOf("cd /repo && GIT_AUTHOR_NAME=a git commit -m x"), ["commit"]);
		assert.deepEqual(deliveryKindsOf("timeout 60 git push origin x"), ["push"]);
	});

	it("reads a git command whose option value is quoted", () => {
		assert.deepEqual(deliveryKindsOf(`git -C "my repo" commit -m x`), ["commit"]);
		assert.deepEqual(deliveryKindsOf(`git -c 'user.name=a b' push`), ["push"]);
	});

	it("reads each line of a multi-line command", () => {
		assert.deepEqual(deliveryKindsOf("git add -A\ngit commit -m x\ngit push"), ["commit", "push"]);
	});

	it("ignores a merge that only arms or cancels auto-merge", () => {
		assert.deepEqual(deliveryKindsOf("gh pr merge 12 --disable-auto"), []);
		assert.deepEqual(deliveryKindsOf("gh pr merge --auto 12"), []);
	});

	it("counts git commit -n, which is --no-verify", () => {
		assert.deepEqual(deliveryKindsOf(`git commit -n -m x`), ["commit"]);
	});
});

describe("findDeliveryEvents", () => {
	it("marks a host-reported success as succeeded, with its time", () => {
		const events = findDeliveryEvents(shell("a", `git commit -m x`, "[main abc1234] x\n 1 file changed"));
		assert.deepEqual(events, [
			{ kind: "commit", succeeded: true, at: "2026-10-01T10:00:00.000Z", call_message_id: "call-a", result_message_id: "result-a" },
		]);
	});

	it("marks a host-reported error as failed", () => {
		const [event] = findDeliveryEvents(shell("a", "git push", "boom", true));
		assert.equal(event?.succeeded, false);
	});

	it("marks a success whose text says nothing happened as failed", () => {
		const [commit] = findDeliveryEvents(shell("a", `git commit -m x | tail -3`, "On branch main\nnothing to commit, working tree clean"));
		assert.equal(commit?.succeeded, false);
		const [push] = findDeliveryEvents(shell("b", "git push 2>&1 | tail", " ! [rejected]        main -> main (fetch first)"));
		assert.equal(push?.succeeded, false);
	});

	it("marks an unanswered call as not succeeded, with no result row", () => {
		const [event] = findDeliveryEvents([shell("a", "git commit -m x", "")[0]!]);
		assert.equal(event?.succeeded, false);
		assert.equal(event?.result_message_id, null);
	});

	it("names the pattern when a configured failure marker is not a valid regex", () => {
		assert.throws(
			() => findDeliveryEvents(shell("a", "git commit -m x", "ok"), { ...DEFAULT_SESSION_DELIVERY_CONFIG, commitFailureMarkers: ["("] }),
			/session-delivery: invalid failure marker "\("/,
		);
	});

	it("finds nothing in a session that ran no delivery command", () => {
		assert.deepEqual(findDeliveryEvents(shell("a", "ls", "a b")), []);
	});
});
