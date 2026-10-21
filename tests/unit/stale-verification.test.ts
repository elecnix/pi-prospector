/**
 * Unit tests for the stale-verification analyzer's deterministic detection.
 * Pure functions, no database, no mocks, no real session data — hand-written
 * synthetic rows only.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_STALE_VERIFICATION_CONFIG,
	type StaleVerificationConfig,
} from "../../src/analyze/analyzers/stale-verification/config.js";
import { classifyCall, findStaleVerifications } from "../../src/analyze/analyzers/stale-verification/detect.js";
import { buildProposals, resolveConfig } from "../../src/analyze/analyzers/stale-verification/index.js";
import type { MessageRow } from "../../src/analyze/types.js";
import { makeMessageRow as row } from "./helpers.js";

const CONFIG: StaleVerificationConfig = { ...DEFAULT_STALE_VERIFICATION_CONFIG };

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
function at(s: number): string {
	return new Date(T0 + s * 1000).toISOString();
}


/** An assistant row issuing one tool call at second `s`. */
function call(id: string, name: string, args: Record<string, unknown>, s: number): MessageRow {
	return row({ id: `call-${id}`, role: "assistant", timestamp: at(s), tool_calls: JSON.stringify([{ id, name, arguments: args }]) });
}

/** The tool-result row answering call `id` at second `s`. */
function result(id: string, name: string, s: number, isError = false, text: string | null = null): MessageRow {
	return row({
		id: `res-${id}`,
		role: "toolResult",
		timestamp: at(s),
		content_text: text,
		tool_results: JSON.stringify([{ toolCallId: id, toolName: name, isError, textLength: text?.length ?? 10 }]),
	});
}

/** A shell call and its result, `seconds` long. */
function sh(id: string, command: string, s: number, seconds: number, isError = false, text: string | null = null): MessageRow[] {
	return [call(id, "bash", { command }, s), result(id, "bash", s + seconds, isError, text)];
}

/** An edit-tool call on `path` and its result. */
function edit(id: string, path: string, s: number, isError = false): MessageRow[] {
	return [call(id, "edit", { path }, s), result(id, "edit", s + 1, isError)];
}

function user(text: string, s: number): MessageRow {
	return row({ role: "user", content_text: text, timestamp: at(s) });
}

// ─────────────────────────── classification ───────────────────────────

describe("classifyCall", () => {
	const shell = (command: string) => classifyCall("bash", { command }, CONFIG);

	it("recognises common test, lint, build, and gate commands as verification", () => {
		for (const c of [
			"npm test",
			"cd /repo && pnpm run lint",
			"go test ./...",
			"python3 -m pytest -x tests",
			"cargo clippy --all-targets",
			"make check",
			"tools/ci/run-pr-gates.sh",
			"./scripts/lint.sh 2>&1 | tail -20",
			"npx tsc --noEmit",
		]) {
			assert.equal(shell(c).kind, "verification", c);
		}
	});

	it("does not take ordinary commands for verification", () => {
		for (const c of ["git status", "cat test.sh", "ls tests/", "grep -rn 'npm test' README.md", "rg pytest"]) {
			assert.equal(shell(c).kind, "other", c);
		}
	});

	it("ignores a verification command written into a heredoc", () => {
		assert.equal(shell("cat > run.sh <<'EOF'\nnpm test\nEOF").kind, "other");
	});

	it("classifies a commit before verification, even when the message mentions a test command", () => {
		assert.equal(shell('git commit -m "fix: make npm test pass"').kind, "commit");
		assert.equal(shell("git -C /repo commit -F msg.txt").kind, "commit");
		assert.equal(shell("git commit --dry-run").kind, "other");
	});

	it("reads edit tools by their path argument and skips scratch paths", () => {
		assert.deepEqual(classifyCall("Edit", { file_path: "/repo/src/a.ts" }, CONFIG), { kind: "edit", target: "/repo/src/a.ts" });
		assert.deepEqual(classifyCall("write", { path: "src/b.ts" }, CONFIG), { kind: "edit", target: "src/b.ts" });
		assert.equal(classifyCall("Write", { file_path: "/tmp/notes.md" }, CONFIG).kind, "other");
		assert.equal(classifyCall("Write", { file_path: "/private/tmp/x/scratchpad/a.py" }, CONFIG).kind, "other");
	});

	it("counts in-place shell edits on repository files", () => {
		assert.equal(shell("sed -i '' 's/a/b/' src/a.go").kind, "edit");
		assert.equal(shell("perl -pi -e 's/a/b/' README.md").kind, "edit");
		assert.equal(shell("sed -i '' 's/a/b/' /tmp/out.txt").kind, "other");
	});

	it("skips an in-place edit on a scratch path set in a variable", () => {
		assert.equal(shell("S=/private/tmp/x; sed -i '' 's/a/b/' $S/notes.md").kind, "other");
	});

	it("records the matching command and the directory a run or a shell edit changed into", () => {
		const v = shell("python3 - <<'EOF'\nopen('a','w')\nEOF\ncd /repo/admin && pnpm test 2>&1 | tail -5");
		assert.equal(v.kind, "verification");
		assert.equal(v.kind === "verification" && v.command, "pnpm test 2>&1");
		assert.equal(v.kind === "verification" && v.dir, "/repo/admin");
		const e = shell("cd ~/src/app && sed -i '' 's/a/b/' x.go");
		assert.equal(e.kind === "edit" && e.dir, "~/src/app");
		const later = shell("sed -n 1,5p a.go; sed -i '' 's/a/b/' b.go");
		assert.equal(later.kind === "edit" && later.target, "sed -i '' 's/a/b/' b.go");
	});

	it("recognises subagent tools", () => {
		assert.equal(classifyCall("Agent", { prompt: "review" }, CONFIG).kind, "subagent");
		assert.equal(classifyCall("Workflow", {}, CONFIG).kind, "subagent");
	});
});

// ─────────────────────────── detection ───────────────────────────

describe("findStaleVerifications", () => {
	it("flags a passing run that a later edit made stale, and the rerun that followed", () => {
		const scan = findStaleVerifications(
			[
				user("Fix the parser.", 0),
				...sh("v1", "npm test", 10, 120),
				...edit("e1", "src/parser.ts", 140),
				...sh("v2", "npm test", 150, 120),
				...sh("c1", "git commit -m fix", 280, 1),
			],
			CONFIG,
		);
		assert.equal(scan.passing_run_count, 2);
		assert.equal(scan.stale_runs.length, 1);
		const s = scan.stale_runs[0]!;
		assert.equal(s.message_id, "call-v1");
		assert.equal(s.seconds, 120);
		assert.equal(s.cause, "agent");
		assert.equal(s.edit_message_id, "call-e1");
		assert.equal(s.edit_target, "src/parser.ts");
		assert.equal(s.outcome, "rerun");
		assert.equal(scan.stale_seconds, 120);
	});

	it("does not flag a run whose result the commit used", () => {
		const scan = findStaleVerifications(
			[...sh("v1", "npm test", 0, 120), ...sh("c1", "git commit -m x", 130, 1), ...edit("e1", "src/a.ts", 140)],
			CONFIG,
		);
		assert.equal(scan.stale_runs.length, 0);
	});

	it("does not flag a failing run: editing after a failure is the fix loop", () => {
		const scan = findStaleVerifications([...sh("v1", "npm test", 0, 120, true), ...edit("e1", "src/a.ts", 130)], CONFIG);
		assert.equal(scan.stale_runs.length, 0);
		assert.equal(scan.passing_run_count, 0);
	});

	it("treats a run that exited 0 but printed a failure as failing, and counts it as a zero-exit failure", () => {
		const scan = findStaleVerifications(
			[
				...sh("v1", "tools/ci/run-gates.sh 2>&1 | tail -5", 0, 120, false, "go-test   PASS\ngofmt     FAIL\n"),
				...edit("e1", "src/a.go", 130),
				...sh("v2", "npm test | tail -3", 140, 90, false, "Tests: 2 failed, 40 passed"),
			],
			CONFIG,
		);
		assert.equal(scan.stale_runs.length, 0);
		assert.equal(scan.passing_run_count, 0);
		assert.equal(scan.zero_exit_failures.count, 2);
		assert.deepEqual(scan.zero_exit_failures.message_ids, ["call-v1", "call-v2"]);
	});

	it("does not count a run the harness timed out as passing", () => {
		const scan = findStaleVerifications(
			[
				...sh("v1", "tools/ci/run-pr-gates.sh", 0, 600, false, "Command did not complete within its 600s timeout and was moved to the background (ID: b1)."),
				...edit("e1", "src/a.go", 610),
			],
			CONFIG,
		);
		assert.equal(scan.passing_run_count, 0);
		assert.equal(scan.timed_out_run_count, 1);
		assert.equal(scan.stale_runs.length, 0);
	});

	it("does not read failure words in prose or a zero count as a failure", () => {
		const scan = findStaleVerifications(
			[...sh("v1", "npm test", 0, 120, false, "the check is fail-closed\nTests: 0 failed, 40 passed"), ...edit("e1", "src/a.ts", 130)],
			CONFIG,
		);
		assert.equal(scan.stale_runs.length, 1);
		assert.equal(scan.zero_exit_failures.count, 0);
	});

	it("ignores runs shorter than the minimum, so a quick test-edit loop is not waste", () => {
		const scan = findStaleVerifications([...sh("v1", "npm test", 0, 5), ...edit("e1", "src/a.ts", 10)], CONFIG);
		assert.equal(scan.stale_runs.length, 0);
	});

	it("does not count a failed edit or a scratch-file edit as invalidating", () => {
		const scan = findStaleVerifications(
			[...sh("v1", "npm test", 0, 120), ...edit("e1", "src/a.ts", 130, true), ...edit("e2", "/tmp/notes.md", 140)],
			CONFIG,
		);
		assert.equal(scan.stale_runs.length, 0);
	});

	it("does not let an edit outside the run's directory make it stale", () => {
		const scan = findStaleVerifications(
			[
				...sh("v1", "cd /work/repo-a && npm test", 0, 120),
				...edit("e1", "/work/repo-b/src/a.ts", 130),
				...sh("e2", "cd /work/repo-c && sed -i '' 's/a/b/' x.ts", 140, 1),
			],
			CONFIG,
		);
		assert.equal(scan.stale_runs.length, 0);
	});

	it("matches a home-relative run directory against an absolute edit path", () => {
		const scan = findStaleVerifications(
			[...sh("v1", "cd ~/work/repo && npm test", 0, 120), ...edit("e1", "/Users/dev/work/repo/src/a.ts", 130)],
			CONFIG,
		);
		assert.equal(scan.stale_runs.length, 1);
		assert.equal(scan.stale_runs[0]!.command, "npm test");
	});

	it("blames a human prompt between the run and the edit on the user", () => {
		const scan = findStaleVerifications(
			[...sh("v1", "npm test", 0, 120), user("Rename that function.", 130), ...edit("e1", "src/a.ts", 140)],
			CONFIG,
		);
		assert.equal(scan.stale_runs[0]!.cause, "user");
	});

	it("does not take an injected harness message for a human prompt", () => {
		const scan = findStaleVerifications(
			[...sh("v1", "npm test", 0, 120), user("<task-notification>done</task-notification>", 130), ...edit("e1", "src/a.ts", 140)],
			CONFIG,
		);
		assert.equal(scan.stale_runs[0]!.cause, "agent");
	});

	it("blames a subagent that ran between the run and the edit", () => {
		const scan = findStaleVerifications(
			[
				...sh("v1", "npm test", 0, 120),
				call("a1", "Agent", { prompt: "review the diff" }, 130),
				result("a1", "Agent", 200),
				...edit("e1", "src/a.ts", 210),
			],
			CONFIG,
		);
		assert.equal(scan.stale_runs[0]!.cause, "subagent");
	});

	it("records a commit that took the edit without a rerun as unverified", () => {
		const scan = findStaleVerifications(
			[...sh("v1", "npm test", 0, 120), ...edit("e1", "src/a.ts", 130), ...sh("c1", "git commit -m x", 140, 1)],
			CONFIG,
		);
		assert.equal(scan.stale_runs[0]!.outcome, "committed_unverified");
		assert.equal(scan.unverified_commit_count, 1);
	});

	it("records a session that ended after the edit with no rerun or commit", () => {
		const scan = findStaleVerifications([...sh("v1", "npm test", 0, 120), ...edit("e1", "src/a.ts", 130)], CONFIG);
		assert.equal(scan.stale_runs[0]!.outcome, "unverified_at_end");
		assert.equal(scan.unverified_commit_count, 0);
	});

	it("flags every passing run before one edit, not only the last", () => {
		const scan = findStaleVerifications(
			[...sh("v1", "npm run lint", 0, 60), ...sh("v2", "npm test", 70, 120), ...edit("e1", "src/a.ts", 200), ...sh("v3", "npm test", 210, 120)],
			CONFIG,
		);
		assert.deepEqual(
			scan.stale_runs.map((s) => s.message_id),
			["call-v1", "call-v2"],
		);
		assert.equal(scan.stale_seconds, 180);
	});

	it("counts an untimed verification run instead of costing it as zero", () => {
		const scan = findStaleVerifications([call("v1", "bash", { command: "npm test" }, 0)], CONFIG);
		assert.equal(scan.untimed_run_count, 1);
		assert.equal(scan.passing_run_count, 0);
	});

	it("sums stale seconds per cause", () => {
		const scan = findStaleVerifications(
			[
				...sh("v1", "npm test", 0, 100),
				...edit("e1", "src/a.ts", 110),
				...sh("v2", "npm test", 120, 100),
				user("One more change.", 230),
				...edit("e2", "src/a.ts", 240),
			],
			CONFIG,
		);
		assert.deepEqual(scan.stale_seconds_by_cause, { agent: 100, user: 100, subagent: 0 });
	});
});

// ─────────────────────────── proposals ───────────────────────────

describe("buildProposals", () => {
	const staleBy = (cause: "agent" | "user" | "subagent", n: number, seconds: number) =>
		findStaleVerifications(
			Array.from({ length: n }, (_, i) => [
				...sh(`v${i}`, "npm test", i * 1000, seconds),
				...(cause === "user" ? [user("Change it.", i * 1000 + seconds + 5)] : []),
				...(cause === "subagent" ? [call(`a${i}`, "Agent", {}, i * 1000 + seconds + 5), result(`a${i}`, "Agent", i * 1000 + seconds + 6)] : []),
				...edit(`e${i}`, "src/a.ts", i * 1000 + seconds + 10),
			]).flat(),
			CONFIG,
		);

	it("proposes running the slow check after the last edit when the agent made its own runs stale", () => {
		const proposals = buildProposals(staleBy("agent", 3, 300), CONFIG);
		assert.equal(proposals.length, 1);
		assert.match(proposals[0]!.title, /3 passing verification runs/);
		assert.equal(proposals[0]!.severity, "waste");
	});

	it("proposes reviewing before verifying when subagent findings made runs stale", () => {
		const proposals = buildProposals(staleBy("subagent", 3, 300), CONFIG);
		assert.equal(proposals.length, 1);
		assert.match(proposals[0]!.detail, /review/i);
	});

	it("proposes nothing for stale time a human prompt caused", () => {
		assert.equal(buildProposals(staleBy("user", 3, 300), CONFIG).length, 0);
	});

	it("proposes nothing under the threshold", () => {
		assert.equal(buildProposals(staleBy("agent", 1, 200), CONFIG).length, 0);
	});

	it("warns when commits took edits made after the last passing run", () => {
		const scan = findStaleVerifications(
			[0, 1].flatMap((i) => [
				...sh(`v${i}`, "npm test", i * 1000, 120),
				...edit(`e${i}`, "src/a.ts", i * 1000 + 130),
				...sh(`c${i}`, "git commit -m x", i * 1000 + 140, 1),
			]),
			CONFIG,
		);
		const proposals = buildProposals(scan, CONFIG);
		const unverified = proposals.find((p) => /without a rerun/.test(p.title));
		assert.ok(unverified, proposals.map((p) => p.title).join(" | "));
		assert.equal(unverified!.severity, "medium");
	});

	it("names the full check the corpus learned, rather than a generic check", () => {
		const learned = new Map([["tools/ci/verify-all", { verdict: "full", confidence: 0.9, command: "tools/ci/verify-all" }]]);
		const scan = findStaleVerifications(
			[0, 1, 2].flatMap((i) => [
				...sh(`v${i}`, "tools/ci/verify-all", i * 1000, 300),
				...edit(`e${i}`, "src/a.ts", i * 1000 + 310),
			]),
			CONFIG,
			new Set(learned.keys()),
		);
		const proposals = buildProposals(scan, CONFIG, learned);
		const agent = proposals.find((p) => /the agent's own edits/.test(p.title));
		assert.ok(agent, proposals.map((p) => p.title).join(" | "));
		assert.match(agent!.detail, /tools\/ci\/verify-all/);
	});

	it("says nothing about a command the corpus has not judged", () => {
		const scan = findStaleVerifications(
			[0, 1, 2].flatMap((i) => [
				...sh(`v${i}`, "npm test", i * 1000, 300),
				...edit(`e${i}`, "src/a.ts", i * 1000 + 310),
			]),
			CONFIG,
		);
		const proposals = buildProposals(scan, CONFIG, {});
		const agent = proposals.find((p) => /the agent's own edits/.test(p.title));
		assert.ok(agent);
		assert.doesNotMatch(agent!.detail, /npm test/);
	});
});

describe("resolveConfig", () => {
	it("fills a partial config from the defaults", () => {
		const c = resolveConfig({ minRunSeconds: 5 });
		assert.equal(c.minRunSeconds, 5);
		assert.deepEqual(c.verificationPatterns, DEFAULT_STALE_VERIFICATION_CONFIG.verificationPatterns);
	});
});
