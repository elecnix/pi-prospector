/**
 * Unit tests for git-commands detection. Pure functions, no database, no
 * mocks: hand-written synthetic rows only.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { gitCommandKindsOf, findGitCommandEvents } from "../../src/analyze/analyzers/git-commands/detect.js";
import { DEFAULT_GIT_COMMANDS_CONFIG } from "../../src/analyze/analyzers/git-commands/config.js";
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

describe("gitCommandKindsOf", () => {
	it("reads commit, push, and merge, one per segment", () => {
		assert.deepEqual(gitCommandKindsOf(`git add -A && git commit -m "x" && git push origin x`), ["commit", "push"]);
		assert.deepEqual(gitCommandKindsOf("gh pr merge 12 --squash"), ["pr_merge"]);
	});

	it("reads git with global options", () => {
		assert.deepEqual(gitCommandKindsOf(`git -C /repo commit -m x`), ["commit"]);
	});

	it("ignores mentions, dry runs, and an armed merge", () => {
		assert.deepEqual(gitCommandKindsOf(`echo "git commit"`), []);
		assert.deepEqual(gitCommandKindsOf("git log --grep commit"), []);
		assert.deepEqual(gitCommandKindsOf("git push --dry-run"), []);
		assert.deepEqual(gitCommandKindsOf("git push -n origin x"), []);
		assert.deepEqual(gitCommandKindsOf("git push -vn origin x"), []);
		assert.deepEqual(gitCommandKindsOf("git push -nv origin x"), []);
		assert.deepEqual(gitCommandKindsOf("gh pr merge 12 --auto --squash"), []);
	});

	it("ignores an unquoted mention of a command that does not run it", () => {
		assert.deepEqual(gitCommandKindsOf("echo git commit"), []);
		assert.deepEqual(gitCommandKindsOf("grep -l git push notes.txt"), []);
		assert.deepEqual(gitCommandKindsOf("echo gh pr merge 12"), []);
	});

	it("reads a command behind a wrapper, an environment assignment, or a leading cd", () => {
		assert.deepEqual(gitCommandKindsOf("cd /repo && GIT_AUTHOR_NAME=a git commit -m x"), ["commit"]);
		assert.deepEqual(gitCommandKindsOf("timeout 60 git push origin x"), ["push"]);
	});

	it("reads a git command whose option value is quoted", () => {
		assert.deepEqual(gitCommandKindsOf(`git -C "my repo" commit -m x`), ["commit"]);
		assert.deepEqual(gitCommandKindsOf(`git -c 'user.name=a b' push`), ["push"]);
	});

	it("reads each line of a multi-line command", () => {
		assert.deepEqual(gitCommandKindsOf("git add -A\ngit commit -m x\ngit push"), ["commit", "push"]);
	});

	it("ignores a merge that only arms or cancels auto-merge", () => {
		assert.deepEqual(gitCommandKindsOf("gh pr merge 12 --disable-auto"), []);
		assert.deepEqual(gitCommandKindsOf("gh pr merge --auto 12"), []);
	});

	it("ignores a help invocation", () => {
		assert.deepEqual(gitCommandKindsOf("git push -h"), []);
		assert.deepEqual(gitCommandKindsOf("git commit --help"), []);
		assert.deepEqual(gitCommandKindsOf("gh pr merge --help"), []);
		assert.deepEqual(gitCommandKindsOf("gh pr merge -h"), []);
	});

	it("counts git commit -n, which is --no-verify", () => {
		assert.deepEqual(gitCommandKindsOf(`git commit -n -m x`), ["commit"]);
	});
});

describe("findGitCommandEvents", () => {
	it("marks a host-reported success as succeeded, with its time", () => {
		const events = findGitCommandEvents(shell("a", `git commit -m x`, "[main abc1234] x\n 1 file changed"));
		assert.deepEqual(events, [
			{ kind: "commit", succeeded: true, result_checked: true, at: "2026-10-01T10:00:00.000Z", call_message_id: "call-a", result_message_id: "result-a" },
		]);
	});

	it("marks a host-reported error as failed", () => {
		const [event] = findGitCommandEvents(shell("a", "git push", "boom", true));
		assert.equal(event?.succeeded, false);
	});

	it("marks a success whose text says nothing happened as failed", () => {
		const [commit] = findGitCommandEvents(shell("a", `git commit -m x | tail -3`, "On branch main\nnothing to commit, working tree clean"));
		assert.equal(commit?.succeeded, false);
		const [push] = findGitCommandEvents(shell("b", "git push 2>&1 | tail", " ! [rejected]        main -> main (fetch first)"));
		assert.equal(push?.succeeded, false);
	});

	it("says when the result text could not be checked", () => {
		const call = row({ id: "call-m", role: "assistant", tool_calls: JSON.stringify([{ id: "m", name: "bash", arguments: { command: "git commit -m x" } }, { id: "n", name: "bash", arguments: { command: "ls" } }]) });
		const both = row({
			id: "result-mn",
			role: "toolResult",
			content_text: "nothing to commit\nfile",
			tool_results: JSON.stringify([
				{ toolCallId: "m", toolName: "bash", isError: false, textLength: 17 },
				{ toolCallId: "n", toolName: "bash", isError: false, textLength: 4 },
			]),
		});
		const [event] = findGitCommandEvents([call, both]);
		assert.equal(event?.succeeded, true, "the host's verdict stands when the text cannot be attributed");
		assert.equal(event?.result_checked, false);
		assert.equal(findGitCommandEvents(shell("a", "git commit -m x", "[main abc1234] x"))[0]?.result_checked, true);
	});

	it("marks an unanswered call as not succeeded, with no result row", () => {
		const [event] = findGitCommandEvents([shell("a", "git commit -m x", "")[0]!]);
		assert.equal(event?.succeeded, false);
		assert.equal(event?.result_message_id, null);
	});

	it("names the pattern when a configured failure marker is not a valid regex", () => {
		assert.throws(
			() => findGitCommandEvents(shell("a", "git commit -m x", "ok"), { ...DEFAULT_GIT_COMMANDS_CONFIG, commitFailureMarkers: ["("] }),
			/git-commands: invalid failure marker "\("/,
		);
	});

	it("finds nothing in a session that ran no git command", () => {
		assert.deepEqual(findGitCommandEvents(shell("a", "ls", "a b")), []);
	});
});
