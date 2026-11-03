/**
 * Unit tests for repo-identity. Pure functions, no database, no mocks:
 * hand-written synthetic rows only.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { chooseRepo, findRepoHints, normaliseRepo } from "../../src/analyze/analyzers/repo-identity/detect.js";
import type { MessageRow } from "../../src/analyze/types.js";
import { makeMessageRow as row } from "./helpers.js";

const CWD = "/work/widgets/feat-x";

function step(id: string, command: string, text: string, isError = false): MessageRow[] {
	return [
		row({ id: `call-${id}`, role: "assistant", tool_calls: JSON.stringify([{ id, name: "bash", arguments: { command } }]) }),
		row({
			id: `result-${id}`,
			role: "toolResult",
			content_text: text,
			tool_results: JSON.stringify([{ toolCallId: id, toolName: "bash", isError, textLength: text.length }]),
		}),
	];
}

const repos = (messages: MessageRow[], cwd = CWD) => findRepoHints(messages, cwd).map((h) => `${h.basis}:${h.repo}`);

describe("normaliseRepo", () => {
	it("lowercases, drops .git and credentials", () => {
		assert.equal(normaliseRepo("GitHub.com", "Acme", "Widgets.git"), "github.com/acme/widgets");
		assert.equal(normaliseRepo("user:token@github.com", "acme", "widgets"), "github.com/acme/widgets");
	});
});

describe("findRepoHints", () => {
	it("reads the remote git printed, https or ssh, first remote only", () => {
		const https = step("a", "git remote -v", "origin\thttps://github.com/Acme/Widgets.git (fetch)\norigin\thttps://github.com/Acme/Widgets.git (push)\nfork\thttps://github.com/ana/widgets.git (fetch)");
		assert.deepEqual(repos(https), ["remote_output:github.com/acme/widgets"]);
		const ssh = step("b", "git remote get-url origin", "git@github.com:acme/widgets.git");
		assert.deepEqual(repos(ssh), ["remote_output:github.com/acme/widgets"]);
	});

	it("reads the address a push or a fetch reported", () => {
		assert.deepEqual(repos(step("a", "git push -u origin x", "To github.com:acme/widgets.git\n * [new branch] x -> x")), ["remote_output:github.com/acme/widgets"]);
		assert.deepEqual(repos(step("b", "git fetch origin", "From https://github.com/acme/widgets\n * branch main -> FETCH_HEAD")), ["remote_output:github.com/acme/widgets"]);
	});

	it("reads the pull request URL a gh pr command printed", () => {
		assert.deepEqual(repos(step("a", `gh pr create --title "x"`, "https://github.com/acme/widgets/pull/42")), ["pr_url:github.com/acme/widgets"]);
	});

	it("reads gh's --repo flag, quoted or not, with or without a host", () => {
		assert.deepEqual(repos(step("a", "gh pr view 3 -R acme/widgets", "ok")), ["gh_repo_flag:github.com/acme/widgets"]);
		assert.deepEqual(repos(step("b", `gh issue list --repo "git.example.com/acme/widgets"`, "ok")), ["gh_repo_flag:git.example.com/acme/widgets"]);
	});

	it("reads an address written in git clone or remote add", () => {
		assert.deepEqual(repos(step("a", "git clone https://github.com/acme/widgets.git /tmp/w", "")), ["command_url:github.com/acme/widgets"]);
		assert.deepEqual(repos(step("b", "git remote add up git@github.com:acme/widgets.git", "")), ["command_url:github.com/acme/widgets"]);
	});

	it("leaves out a command that ran outside the working directory", () => {
		const other = "To github.com:other/repo.git\n";
		assert.deepEqual(repos(step("a", "cd /somewhere/else && git push", other)), []);
		assert.deepEqual(repos(step("b", "git -C /somewhere/else push", other)), []);
		assert.deepEqual(repos(step("c", "git -C ~/x push", other)), []);
		assert.deepEqual(repos(step("d", `git -C ${CWD} push`, other)), ["remote_output:github.com/other/repo"]);
		assert.deepEqual(repos(step("e", `cd ${CWD}/sub && git push`, other)), ["remote_output:github.com/other/repo"]);
		assert.deepEqual(repos(step("f", "cd sub && git push", other)), ["remote_output:github.com/other/repo"]);
	});

	it("ignores a failed command, a mention in a quoted string, and other programs", () => {
		assert.deepEqual(repos(step("a", "git push", "To github.com:acme/widgets.git", true)), []);
		assert.deepEqual(repos(step("b", `echo "git push"`, "To github.com:acme/widgets.git")), []);
		assert.deepEqual(repos(step("c", "cat notes.md", "see https://github.com/acme/widgets/pull/9")), []);
	});

	it("never keeps credentials from an address", () => {
		const hints = findRepoHints(step("a", "git remote -v", "origin\thttps://ana:s3cret@github.com/acme/widgets.git (fetch)"), CWD);
		assert.deepEqual(hints.map((h) => h.repo), ["github.com/acme/widgets"]);
	});
});

describe("chooseRepo", () => {
	it("takes the strongest basis, then the most-supported address", () => {
		const hints = [
			{ repo: "github.com/a/one", basis: "gh_repo_flag" as const, message_id: "m1" },
			{ repo: "github.com/a/two", basis: "remote_output" as const, message_id: "m2" },
			{ repo: "github.com/a/three", basis: "remote_output" as const, message_id: "m3" },
			{ repo: "github.com/a/three", basis: "remote_output" as const, message_id: "m4" },
		];
		assert.deepEqual(chooseRepo(hints, CWD), {
			repo_key: "github.com/a/three",
			basis: "remote_output",
			hint_count: 2,
			candidate_count: 2,
			directory: "feat-x",
			evidence_message_id: "m3",
		});
	});

	it("gives a null key and says so when there is no hint", () => {
		assert.deepEqual(chooseRepo([], CWD), {
			repo_key: null,
			basis: "none",
			hint_count: 0,
			candidate_count: 0,
			directory: "feat-x",
			evidence_message_id: null,
		});
		assert.equal(chooseRepo([], "").directory, null);
	});
});
