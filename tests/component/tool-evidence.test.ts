/**
 * Regression fixture for the tool-evidence channel (issue #12).
 *
 * Reproduces the fork-PR misattribution case with hand-written synthetic data
 * (no real session): a single high-signal turn where `git push -u origin …`
 * succeeds and `gh pr create` runs WITHOUT `--repo` (so it defaults to the
 * upstream/parent repo — the actual bug). The push was always correct.
 *
 * Asserts the tool-evidence channel carries the `gh pr create (no --repo)`
 * evidence into both LLM prompts: the turn-pair-llm classifier input and the
 * session-overview reduce digest. Without this channel the analyzer only sees
 * the user's imprecise "YOU SHOULD HAVE PUSHED …" wording and misattributes the
 * fix to the git push target.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import { registerDefaults } from "../../src/analyze/defaults.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import type { LLMRequest } from "../../src/analyze/types.js";

/** The forced-tool-call classification returned for any classify request. */
function respond(req: LLMRequest): string {
	const sys = req.system ?? "";
	if (sys.includes("classify a single turn")) {
		return JSON.stringify({
			sentiment: "frustrated",
			friction_type: "tool_misuse",
			is_genuine_correction: true,
			severity: "high",
			rationale: "gh pr create ran without --repo and defaulted to the upstream repo",
		});
	}
	if (sys.includes("summarise one segment")) {
		return JSON.stringify({ segment_summary: "s", notable_points: ["p"] });
	}
	return JSON.stringify({
		session_summary: "gh pr create defaulted to the upstream repo because --repo was omitted.",
		friction_points: [{ description: "gh pr create missing --repo", what_to_change: "pass --repo on forks", evidence: "gh pr create (no --repo)", severity: "high" }],
		key_positive_signals: [],
		improvement_proposals: [
			{ target_type: "agents_md", target_path: "AGENTS.md", title: "Use gh pr create --repo on forks", summary: "s", detail: "d", evidence: "e", confidence: 0.7, severity: "correction" },
		],
	});
}

/** Seed the fork-PR turn: correct push + gh pr create with no --repo (the bug). */
function seed(db: import("better-sqlite3").Database, id: string): void {
	insertSession(db, id);
	insertMessages(db, id, [
		// The user's imprecise correction (a high-signal turn) — historically this
		// wording alone steered the analyzer to blame the git push target.
		{ id: `${id}-u`, role: "user", text: "YOU SHOULD HAVE PUSHED TO v2nic/gh-pr-review, that's wrong" },
		{
			id: `${id}-a`,
			role: "assistant",
			text: "pushing the branch and opening the PR",
			toolCalls: [
				{ name: "bash", arguments: { command: "git push -u origin fix/infer-repo-from-git" } },
				{ name: "bash", arguments: { command: "gh pr create --draft --title 'infer repo from git'" } },
			],
		},
		// The gh pr create defaulted to the upstream repo and 403'd — the actual bug,
		// which the tool evidence makes visible alongside the (correct) push.
		{ id: `${id}-t`, role: "toolResult", text: "GraphQL: agynio/gh-pr-review not found (403)", toolResults: [{ toolName: "bash", isError: true, textLength: 44 }] },
		{ id: `${id}-a2`, role: "assistant", text: "understood" },
	]);
}

describe("tool-evidence channel (fork-PR regression)", () => {
	it("carries `gh pr create (no --repo)` evidence into the classifier and digest prompts", async () => {
		const { db, close } = tempDb();
		try {
			seed(db, "fork1");
			const mock = createMockLLM({ responder: respond, tokensPerCall: 100, costPerCall: 0.001 });
			const fw = new AnalyzerFramework({ db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
			registerDefaults(fw);
			const summary = await fw.run("fork1", {});
			assert.equal(summary.errors.length, 0, summary.errors.join("; "));

			// The turn-pair-llm classifier prompt for the first (tool-bearing) turn.
			const classifyReqs = mock.calls.filter((c) => (c.system ?? "").includes("classify a single turn"));
			assert.ok(classifyReqs.length > 0, "at least one turn was enriched by the classifier");
			const classifyPrompt = classifyReqs.map((c) => c.user).join("\n---\n");
			assert.ok(classifyPrompt.includes("TOOL CALLS:"), "classifier prompt has a TOOL CALLS block");
			assert.ok(classifyPrompt.includes("gh pr create"), "classifier prompt carries the gh pr create command");
			assert.ok(classifyPrompt.includes("git push -u origin"), "classifier prompt carries the (correct) push command");
			// The load-bearing distinction: the gh pr create evidence has no --repo flag.
			assert.ok(!classifyPrompt.includes("gh pr create --repo"), "the evidence shows gh pr create WITHOUT --repo (the bug)");

			// The session-overview reduce prompt (built from the digest).
			const reduceReq = mock.calls.find((c) => (c.system ?? "").includes("propose concrete improvements"));
			assert.ok(reduceReq, "a reduce/session prompt was issued");
			assert.ok(reduceReq!.user.includes("gh pr create"), "digest carries the gh pr create evidence");
			assert.ok(reduceReq!.user.includes("tool=bash"), "digest carries a tool-evidence fragment");
			assert.ok(!reduceReq!.user.includes("gh pr create --repo"), "digest evidence shows no --repo on the failing command");
		} finally {
			close();
		}
	});
});
