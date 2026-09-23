/**
 * Unit tests for the rule-restatement check's pure parts (issue #265): which
 * instruction files are in scope for a session, how an over-budget corpus is
 * cut down, and how a model's claim that a rule exists is grounded.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	instructionCandidateGroups,
	readInstructionCorpus,
	selectCorpus,
	splitPassages,
	type InstructionFile,
} from "../../src/analyze/analyzers/rule-restatement/corpus.js";
import { extractJudgement, locateQuote, buildRestatementPrompt } from "../../src/analyze/analyzers/rule-restatement/prompt.js";
import { groundJudgement } from "../../src/analyze/analyzers/rule-restatement/index.js";
import { DEFAULT_RULE_RESTATEMENT_CONFIG } from "../../src/analyze/analyzers/rule-restatement/config.js";

const CONFIG = DEFAULT_RULE_RESTATEMENT_CONFIG;

function file(p: string, content: string): InstructionFile {
	return { path: p, scope: "project", content, contentHash: "h" };
}

describe("instructionCandidateGroups", () => {
	it("pi: global AGENTS.md, then one AGENTS.md-or-CLAUDE.md group per directory from the root down", () => {
		const groups = instructionCandidateGroups({ source: "pi", cwd: "/w/proj", home: "/h", config: CONFIG });
		assert.deepEqual(groups[0], [{ path: "/h/.pi/agent/AGENTS.md", scope: "global" }]);
		assert.deepEqual(
			groups.slice(1).map((g) => g.map((c) => c.path)),
			[
				["/AGENTS.md", "/CLAUDE.md"],
				["/w/AGENTS.md", "/w/CLAUDE.md"],
				["/w/proj/AGENTS.md", "/w/proj/CLAUDE.md"],
			],
		);
	});

	it("claude: global CLAUDE.md, then CLAUDE.md, .claude/CLAUDE.md and CLAUDE.local.md per directory", () => {
		const groups = instructionCandidateGroups({ source: "claude", cwd: "/w", home: "/h", config: CONFIG });
		assert.deepEqual(
			groups.map((g) => g.map((c) => c.path)),
			[
				["/h/.claude/CLAUDE.md"],
				["/CLAUDE.md"],
				["/.claude/CLAUDE.md"],
				["/CLAUDE.local.md"],
				["/w/CLAUDE.md"],
				["/w/.claude/CLAUDE.md"],
				["/w/CLAUDE.local.md"],
			],
		);
	});

	it("an unknown harness gets no harness files, only configured ones (with ~ expanded)", () => {
		const groups = instructionCandidateGroups({
			source: "",
			cwd: "/w",
			home: "/h",
			config: { ...CONFIG, instructionPaths: ["~/skills/x/SKILL.md", "relative/ignored.md", "/etc/protocol.md"] },
		});
		assert.deepEqual(groups, [
			[{ path: "/h/skills/x/SKILL.md", scope: "configured" }],
			[{ path: "/etc/protocol.md", scope: "configured" }],
		]);
	});

	it("honours includeHarnessGlobal and discoverProjectFiles", () => {
		const groups = instructionCandidateGroups({
			source: "pi",
			cwd: "/w",
			home: "/h",
			config: { ...CONFIG, includeHarnessGlobal: false, discoverProjectFiles: false },
		});
		assert.deepEqual(groups, []);
	});
});

describe("readInstructionCorpus", () => {
	it("reads the first existing file of each group, skips missing and empty files, and reads each path once", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rr-corpus-"));
		try {
			fs.writeFileSync(path.join(dir, "CLAUDE.md"), "claude rules\n");
			fs.writeFileSync(path.join(dir, "AGENTS.md"), "agents rules\n");
			fs.writeFileSync(path.join(dir, "EMPTY.md"), "  \n");
			const files = readInstructionCorpus([
				[
					{ path: path.join(dir, "AGENTS.md"), scope: "project" },
					{ path: path.join(dir, "CLAUDE.md"), scope: "project" },
				],
				[{ path: path.join(dir, "missing.md"), scope: "project" }],
				[{ path: path.join(dir, "EMPTY.md"), scope: "configured" }],
				[{ path: path.join(dir, "AGENTS.md"), scope: "configured" }],
			]);
			assert.deepEqual(
				files.map((f) => [path.basename(f.path), f.scope, f.content]),
				[["AGENTS.md", "project", "agents rules\n"]],
			);
			assert.equal(files[0]!.contentHash.length, 16);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("selectCorpus", () => {
	it("sends the corpus whole when it fits the budget", () => {
		const out = selectCorpus([file("/a.md", "one\n\ntwo")], "anything", 1000);
		assert.deepEqual(out, [{ path: "/a.md", text: "one\n\ntwo", excerpted: false }]);
	});

	it("over budget, keeps the passages sharing the most terms, in document order", () => {
		const content = [
			"# Tickets",
			"The agent that opens the pull request closes the ticket.",
			"Unrelated paragraph about formatting code with prettier.",
			"Never close a ticket from the orchestrator session.",
		].join("\n\n");
		const out = selectCorpus([file("/a.md", content)], "Orchestrator should never close ticket; the pull request opener closes it", 130);
		assert.equal(out.length, 1);
		assert.equal(out[0]!.excerpted, true);
		assert.ok(out[0]!.text.includes("orchestrator"), out[0]!.text);
		assert.ok(!out[0]!.text.includes("prettier"), "an unrelated passage is dropped");
	});

	it("keeps a heading with the paragraph under it", () => {
		assert.deepEqual(splitPassages("# H\n\nbody\n\n## Lone"), ["# H\nbody", "## Lone"]);
	});
});

describe("extractJudgement", () => {
	it("accepts the tool call", () => {
		const j = extractJudgement({ verdict: "restated", path: "/a.md", quote: "q", rationale: "r" }, "");
		assert.deepEqual(j, { verdict: "restated", path: "/a.md", quote: "q", rationale: "r" });
	});

	it("falls back to JSON in the text channel and fills absent strings", () => {
		const j = extractJudgement(undefined, 'Here: {"verdict":"gap"}');
		assert.deepEqual(j, { verdict: "gap", path: "", quote: "", rationale: "" });
	});

	it("returns null for a reply carrying no verdict", () => {
		assert.equal(extractJudgement({ polarity: "neutral" }, "no json here"), null);
		assert.equal(extractJudgement({ verdict: "maybe" }, ""), null);
	});
});

describe("locateQuote and groundJudgement", () => {
	const files = [
		file("/g/AGENTS.md", "- **Never** run interactive commands;\n  use `--yes` flags.\n"),
		file("/p/AGENTS.md", "Worktrees must use absolute paths.\n"),
	];

	it("finds a quote across whitespace and markdown differences", () => {
		assert.equal(locateQuote("Never run interactive commands; use --yes flags.", files, "/g/AGENTS.md"), "/g/AGENTS.md");
	});

	it("finds the quote in another file when the cited path is wrong", () => {
		assert.equal(locateQuote("Worktrees must use absolute paths.", files, "/g/AGENTS.md"), "/p/AGENTS.md");
	});

	it("rejects an invented or trivially short quote", () => {
		assert.equal(locateQuote("Always ask before deleting branches.", files, "/g/AGENTS.md"), null);
		assert.equal(locateQuote("paths", files, "/p/AGENTS.md"), null);
	});

	it("grounds a restatement, keeps a gap, and marks an unfound quote ungrounded", () => {
		const base = { proposalInputKey: "k", model: "m", files, excerpted: false };
		const restated = groundJudgement({
			...base,
			judgement: { verdict: "restated", path: "/p/AGENTS.md", quote: "Worktrees must use absolute paths.", rationale: "same rule" },
		});
		assert.equal(restated.rule_status, "restated");
		assert.equal(restated.rule_path, "/p/AGENTS.md");

		const gap = groundJudgement({ ...base, judgement: { verdict: "gap", path: "", quote: "", rationale: "absent" } });
		assert.equal(gap.rule_status, "gap");
		assert.equal(gap.rule_quote, null);

		const invented = groundJudgement({
			...base,
			judgement: { verdict: "partial", path: "/p/AGENTS.md", quote: "Always ask before deleting branches.", rationale: "?" },
		});
		assert.equal(invented.model_verdict, "partial");
		assert.equal(invented.rule_status, "ungrounded");
		assert.equal(invented.rule_path, null);
		assert.deepEqual(invented.corpus.map((c) => c.path), ["/g/AGENTS.md", "/p/AGENTS.md"]);
	});
});

describe("buildRestatementPrompt", () => {
	it("shows the proposal and each file under its path", () => {
		const prompt = buildRestatementPrompt(
			{ title: "T", summary: "S", detail: null, target_type: "agents_md", target_path: "AGENTS.md § Git" },
			[{ path: "/p/AGENTS.md", text: "rule text", excerpted: true }],
		);
		assert.ok(prompt.includes("Target: agents_md: AGENTS.md § Git"));
		assert.ok(prompt.includes("=== /p/AGENTS.md (relevant excerpts) ===\nrule text"));
		assert.ok(!prompt.includes("Detail:"));
	});
});
