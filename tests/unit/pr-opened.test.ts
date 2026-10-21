/**
 * Unit tests for the pr-opened analyzer's detection. Pure functions, no
 * database, no mocks, no real session data: hand-written synthetic rows only.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_PR_OPENED_CONFIG } from "../../src/analyze/analyzers/pr-opened/config.js";
import {
	findOpenedPullRequests,
	ghPrCreateTitles,
	parsePullRequestUrl,
	stackedCreatedUrls,
} from "../../src/analyze/analyzers/pr-opened/detect.js";
import type { MessageRow } from "../../src/analyze/types.js";

let seq = 0;
function row(partial: Partial<MessageRow> & { role: string }): MessageRow {
	return {
		id: partial.id ?? `row-${seq++}`,
		session_id: "s",
		parent_id: null,
		timestamp: null,
		content_text: null,
		content_thinking: null,
		tool_calls: null,
		tool_results: null,
		model: null,
		cost_usd: null,
		stop_reason: null,
		error_message: null,
		...partial,
	};
}

/** An assistant row issuing one call, and the row carrying its result. */
function exchange(id: string, name: string, args: Record<string, unknown>, text: string, isError = false): MessageRow[] {
	return [
		row({ id: `call-${id}`, role: "assistant", tool_calls: JSON.stringify([{ id, name, arguments: args }]) }),
		row({
			id: `result-${id}`,
			role: "toolResult",
			content_text: text,
			tool_results: JSON.stringify([{ toolCallId: id, toolName: name, isError, textLength: text.length }]),
		}),
	];
}

const URL = "https://github.com/acme/widgets/pull/42";

describe("parsePullRequestUrl", () => {
	it("splits a pull request URL into host, owner, repo, and number", () => {
		assert.deepEqual(parsePullRequestUrl(URL), { url: URL, host: "github.com", owner: "acme", repo: "widgets", number: 42 });
	});

	it("accepts an Enterprise host and rejects an issue URL", () => {
		assert.equal(parsePullRequestUrl("https://git.example.com/a/b/pull/7")?.host, "git.example.com");
		assert.equal(parsePullRequestUrl("https://github.com/acme/widgets/issues/42"), null);
	});
});

describe("ghPrCreateTitles", () => {
	it("returns an empty list for a command that does not open a pull request", () => {
		assert.deepEqual(ghPrCreateTitles("gh pr view 42"), []);
		assert.deepEqual(ghPrCreateTitles(`grep -n "gh pr create" src/index.ts`), []);
		assert.deepEqual(ghPrCreateTitles(`echo 'gh pr create --title x'`), []);
	});

	it("reads the title from --title, -t, and --title=", () => {
		assert.deepEqual(ghPrCreateTitles(`gh pr create --title "sync: parse entries" --body x`), ["sync: parse entries"]);
		assert.deepEqual(ghPrCreateTitles(`gh pr create -t 'fix it' -b ''`), ["fix it"]);
		assert.deepEqual(ghPrCreateTitles(`gh pr create --title="a \\"quoted\\" word"`), [`a "quoted" word`]);
	});

	it("finds the call after cd, env assignments, and a line continuation", () => {
		const command = `cd /repo && GH_PROMPT_DISABLED=1 gh pr create \\\n  --base main \\\n  --title "docs: fix typo"`;
		assert.deepEqual(ghPrCreateTitles(command), ["docs: fix typo"]);
	});

	it("keeps a multi-line body inside quotes from splitting the command", () => {
		const command = `gh pr create --title "t" --body "$(cat <<'EOF'\nline one; gh pr create\nEOF\n)"`;
		assert.deepEqual(ghPrCreateTitles(command), ["t"]);
	});

	it("reports an unknown title when gh fills it or a shell expansion builds it", () => {
		assert.deepEqual(ghPrCreateTitles("gh pr create --fill"), [null]);
		assert.deepEqual(ghPrCreateTitles(`gh pr create --title "$TITLE"`), [null]);
		assert.deepEqual(ghPrCreateTitles(`gh pr create --title "$(git log -1 --format=%s)"`), [null]);
		assert.deepEqual(ghPrCreateTitles(`gh pr create --title '$literal'`), ["$literal"]);
	});
});

describe("stackedCreatedUrls", () => {
	const STACK_OUTPUT = [
		"Checking existing stacks...",
		"Pushing 1 branch to origin...",
		"Looking up PRs for 1 branch...",
		"Creating 1 PR...",
		`\u2713 Created PR #2351 (${URL}) for feat/ghcr-images (base: feat/sha-groups)`,
		"\u2713 Added 1 PR to stack #2350",
	].join("\n");

	it("reads the URL from the Created PR line", () => {
		assert.deepEqual(stackedCreatedUrls(STACK_OUTPUT), [URL]);
	});

	it("reads nothing when the run only linked an existing pull request", () => {
		const linked = "Checking existing stacks...\n\u2713 Added 1 PR to stack #2350";
		assert.deepEqual(stackedCreatedUrls(linked), []);
	});

	it("reads nothing from output that mentions creating a pull request without a URL", () => {
		assert.deepEqual(stackedCreatedUrls("Creating 1 PR...\nCreated PR #2351"), []);
	});

	it("reads every pull request a run created, in order", () => {
		const second = "https://github.com/acme/widgets/pull/43";
		const two = `${STACK_OUTPUT}\n\u2713 Created PR #43 (${second}) for two (base: one)`;
		assert.deepEqual(stackedCreatedUrls(two), [URL, second]);
	});
});

describe("findOpenedPullRequests", () => {
	it("records the URL gh printed and the title the command passed", () => {
		const messages = exchange(
			"c1",
			"bash",
			{ command: `gh pr create --title "feat: add widgets" --body "x"` },
			`\nCreating pull request for feat into main in acme/widgets\n\n${URL}\n`,
		);
		const found = findOpenedPullRequests(messages, DEFAULT_PR_OPENED_CONFIG);
		assert.equal(found.length, 1);
		assert.deepEqual(found[0]!.pull_request, {
			url: URL,
			host: "github.com",
			owner: "acme",
			repo: "widgets",
			number: 42,
			title: "feat: add widgets",
			via: "gh_pr_create",
			call_message_id: "call-c1",
			result_message_id: "result-c1",
		});
	});

	it("ignores a failed call, and a pull request that already existed", () => {
		const failed = exchange("f1", "bash", { command: `gh pr create --title "x"` }, `GraphQL: something went wrong\n${URL}`, true);
		const existing = exchange(
			"f2",
			"bash",
			{ command: `gh pr create --title "x" || true` },
			`a pull request for branch "feat" into branch "main" already exists:\n${URL}\n`,
		);
		assert.deepEqual(findOpenedPullRequests([...failed, ...existing], DEFAULT_PR_OPENED_CONFIG), []);
	});

	it("ignores a URL that only appears inside other output", () => {
		const messages = exchange(
			"g1",
			"bash",
			{ command: `gh pr create --title "x" ; grep -rn pull README.md` },
			`README.md:3: see ${URL} for details`,
		);
		assert.deepEqual(findOpenedPullRequests(messages, DEFAULT_PR_OPENED_CONFIG), []);
	});

	it("ignores a session that only reads an existing pull request", () => {
		const messages = exchange("v1", "bash", { command: "gh pr view 42 --json url -q .url" }, `${URL}\n`);
		assert.deepEqual(findOpenedPullRequests(messages, DEFAULT_PR_OPENED_CONFIG), []);
	});

	it("reads an MCP create_pull_request call: title from its arguments, URL from its result", () => {
		const messages = exchange(
			"m1",
			"mcp__github__create_pull_request",
			{ owner: "acme", repo: "widgets", title: "feat: from MCP", head: "feat", base: "main" },
			JSON.stringify({ number: 42, html_url: URL, base: { repo: { html_url: "https://github.com/acme/widgets" } } }),
		);
		const found = findOpenedPullRequests(messages, DEFAULT_PR_OPENED_CONFIG);
		assert.equal(found.length, 1);
		assert.equal(found[0]!.pull_request.url, URL);
		assert.equal(found[0]!.pull_request.title, "feat: from MCP");
		assert.equal(found[0]!.pull_request.via, "tool");
	});

	it("records each pull request once, in session order", () => {
		const second = "https://github.com/acme/widgets/pull/43";
		const messages = [
			...exchange("a", "bash", { command: `gh pr create --title "one"` }, `${URL}\n`),
			...exchange("b", "bash", { command: `gh pr create --title "two"` }, `${second}\n`),
			...exchange("c", "bash", { command: `gh pr create --title "one again"` }, `${URL}\n`),
		];
		const found = findOpenedPullRequests(messages, DEFAULT_PR_OPENED_CONFIG);
		assert.deepEqual(found.map((f) => [f.pull_request.url, f.pull_request.title]), [
			[URL, "one"],
			[second, "two"],
		]);
	});

	it("records a pull request the gh stack extension opened, leaving the title unknown", () => {
		const command = "cd /repo && gh stack link --open 2350 feat/ghcr-images < /dev/null 2>&1 | tail -15";
		const output = [
			"Checking existing stacks...",
			"Creating 1 PR...",
			`\u2713 Created PR #2351 (${URL}) for feat/ghcr-images (base: feat/sha-groups)`,
		].join("\n");
		const found = findOpenedPullRequests(exchange("s1", "bash", { command }, output), DEFAULT_PR_OPENED_CONFIG);
		assert.equal(found.length, 1);
		assert.equal(found[0]!.pull_request.url, URL);
		assert.equal(found[0]!.pull_request.via, "stacked");
		assert.equal(found[0]!.pull_request.title, null, "gh stack derives the title, so the command does not state one");
	});

	it("ignores a gh stack run that only linked an existing pull request", () => {
		const messages = exchange(
			"l1",
			"bash",
			{ command: "gh stack link 2270 feat/x" },
			"Checking existing stacks...\n\u2713 Added 1 PR to stack #2270\n" + URL,
		);
		assert.deepEqual(findOpenedPullRequests(messages, DEFAULT_PR_OPENED_CONFIG), []);
	});

	it("ignores a gh stack listing the agent only read", () => {
		const messages = exchange(
			"L1",
			"bash",
			{ command: "gh stack view 2350 --json pull_requests" },
			JSON.stringify({ pull_requests: [{ number: 42, url: URL }] }),
		);
		assert.deepEqual(findOpenedPullRequests(messages, DEFAULT_PR_OPENED_CONFIG), []);
	});

	it("changes the evidence hash when the result text changes", () => {
		const a = findOpenedPullRequests(exchange("h", "bash", { command: `gh pr create --title "x"` }, `${URL}\n`), DEFAULT_PR_OPENED_CONFIG);
		const b = findOpenedPullRequests(exchange("h", "bash", { command: `gh pr create --title "y"` }, `${URL}\n`), DEFAULT_PR_OPENED_CONFIG);
		assert.notEqual(a[0]!.evidence_hash, b[0]!.evidence_hash);
	});
});
