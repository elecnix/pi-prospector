/**
 * Component test for the rule-restatement check (issue #265): a full analyze
 * over a synthetic session whose harness has a global and a project instruction
 * file on disk. The synthesizer emits four proposals — a rule the global file
 * already states (in other words), a genuine gap, a claim the model backs with
 * a quote the corpus does not contain, and a non-rule workflow proposal — and
 * the check must tell them apart and write the result onto each proposal.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { tempDb, insertSession, insertMessages } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM, type MockLLMReply } from "../../src/analyze/mock-llm.js";
import { registerDefaults } from "../../src/analyze/defaults.js";
import { RULE_RESTATEMENT_DEF } from "../../src/analyze/analyzers/rule-restatement/index.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import { listProposals } from "../../src/db/queries.js";
import { verifyNodes } from "../../src/commands/verify.js";
import { statusLabel } from "../../src/commands/proposals.js";
import type { LLMRequest } from "../../src/analyze/types.js";

const RESTATED = "Delegate ticket-closing to the PR-opening agent";
const GAP = "Prefer find over bash globs";
const INVENTED = "Confirm before force-pushing";
const WORKFLOW = "Batch CI polling";

const GLOBAL_RULE = "The orchestrator never closes tickets; whoever opens the pull request closes its ticket.";

function respond(req: LLMRequest): MockLLMReply {
	if (req.tool?.name === "classify_term") {
		return JSON.stringify({ polarity: "neutral", category: "none", language: "und", confidence: 0.9, rationale: "ordinary" });
	}
	if (req.tool?.name === "judge_restatement") {
		const user = req.user;
		if (user.includes(RESTATED)) {
			return { structured: { verdict: "restated", path: "", quote: GLOBAL_RULE, rationale: "same rule from the other end" } };
		}
		if (user.includes(INVENTED)) {
			return { structured: { verdict: "restated", path: "", quote: "Always confirm before any force push.", rationale: "?" } };
		}
		return { structured: { verdict: "gap", path: "", quote: "", rationale: "not stated" } };
	}
	const sys = req.system ?? "";
	if (sys.includes("classify a single turn")) {
		return JSON.stringify({ sentiment: "frustrated", friction_type: "wrong_approach", is_genuine_correction: true, severity: "high", rationale: "friction" });
	}
	if (sys.includes("summarise one segment")) {
		return JSON.stringify({ segment_summary: "seg", notable_points: ["p"] });
	}
	const proposal = (title: string, target_type: string) => ({
		target_type,
		title,
		summary: `${title}.`,
		detail: "",
		evidence: "user correction",
		confidence: 0.9,
		severity: "correction",
	});
	return JSON.stringify({
		session_summary: "The agent closed a ticket it did not own and was corrected.",
		friction_points: [{ description: "closed the ticket", what_to_change: "leave it", evidence: "correction", severity: "high" }],
		key_positive_signals: [],
		improvement_proposals: [
			proposal(RESTATED, "agents_md"),
			proposal(GAP, "agents_md"),
			proposal(INVENTED, "skill"),
			proposal(WORKFLOW, "workflow"),
		],
	});
}

function withInstructionHome<T>(home: string, fn: () => Promise<T>): Promise<T> {
	const prior = process.env["PROSPECTOR_INSTRUCTIONS_HOME"];
	process.env["PROSPECTOR_INSTRUCTIONS_HOME"] = home;
	return fn().finally(() => {
		if (prior === undefined) delete process.env["PROSPECTOR_INSTRUCTIONS_HOME"];
		else process.env["PROSPECTOR_INSTRUCTIONS_HOME"] = prior;
	});
}

describe("rule-restatement (issue #265)", () => {
	it("separates restated rules from gaps, grounds every claim, and re-checks when a file changes", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "rr-e2e-"));
		const home = path.join(root, "home");
		const project = path.join(root, "work", "proj");
		fs.mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
		fs.mkdirSync(project, { recursive: true });
		const globalFile = path.join(home, ".pi", "agent", "AGENTS.md");
		const projectFile = path.join(project, "AGENTS.md");
		fs.writeFileSync(globalFile, `# Tickets\n\n${GLOBAL_RULE}\n`);
		fs.writeFileSync(projectFile, "# Project\n\nRun npm test before pushing.\n");

		const { db, close } = await tempDb();
		try {
			await withInstructionHome(home, async () => {
				await insertSession(db, "rr1", "/tmp/rr1.jsonl", project, "pi");
				await insertMessages(db, "rr1", [
					{ role: "user", text: "open a PR for this branch" },
					{ role: "assistant", text: "done, and I closed the ticket", toolCalls: [{ name: "bash" }] },
					{ role: "toolResult", toolResults: [{ toolName: "bash", isError: false, textLength: 20 }] },
					{ role: "user", text: "no, don't close the ticket, that's not your job" },
					{ role: "assistant", text: "understood, reopening it" },
				]);

				const mock = createMockLLM({ responder: respond, tokensPerCall: 10, costPerCall: 0.001 });
				const fw = new AnalyzerFramework({ db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
				await registerDefaults(fw);
				const summary = await fw.run("rr1", {});
				assert.equal(summary.errors.length, 0, summary.errors.join("; "));
				assert.equal(summary.proposalsCreated, 4);

				const judged = mock.calls.filter((c) => c.tool?.name === "judge_restatement");
				assert.equal(judged.length, 3, "one judgement per rule-shaped proposal; the workflow proposal is not a rule");
				for (const call of judged) {
					assert.ok(call.user.includes(`=== ${globalFile} ===`), "the harness's global file is in scope");
					assert.ok(call.user.includes(`=== ${projectFile} ===`), "the project file on the cwd path is in scope");
				}

				const byTitle = new Map((await listProposals(db)).map((p) => [p.title, p]));
				const restated = byTitle.get(RESTATED)!;
				assert.equal(restated.rule_status, "restated");
				assert.equal(restated.rule_path, globalFile, "the quote was located in the file that holds it");
				assert.equal(restated.rule_quote, GLOBAL_RULE);
				assert.ok(restated.restatement_node_id);
				assert.match(statusLabel(restated), /already a rule/);

				assert.equal(byTitle.get(GAP)!.rule_status, "gap");
				assert.equal(byTitle.get(INVENTED)!.rule_status, "ungrounded", "a quote the corpus does not contain is not believed");
				assert.equal(byTitle.get(INVENTED)!.rule_path, null);
				assert.equal(byTitle.get(WORKFLOW)!.rule_status, "unchecked");

				const { mismatches } = await verifyNodes(db);
				assert.equal(mismatches.length, 0, JSON.stringify(mismatches));

				// Idempotent: nothing changed, nothing is re-judged.
				const again = await fw.run("rr1", { analyzerIds: [RULE_RESTATEMENT_DEF.id] });
				const r1 = again.analyzerResults.find((r) => r.analyzerId === RULE_RESTATEMENT_DEF.id)!;
				assert.equal(r1.nodesProduced, 0);

				// Editing an instruction file is a change of input: every check that read
				// it is missing again, and the next run re-judges against the new text.
				fs.appendFileSync(projectFile, "\nPrefer find over bash globs.\n");
				const after = await fw.run("rr1", { analyzerIds: [RULE_RESTATEMENT_DEF.id] });
				const r2 = after.analyzerResults.find((r) => r.analyzerId === RULE_RESTATEMENT_DEF.id)!;
				assert.equal(r2.nodesProduced, 3);
			});
		} finally {
			await close();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("reads configured instructionPaths into the corpus (plan receives the resolved config)", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "rr-cfg-"));
		const skill = path.join(root, "skills", "ship", "SKILL.md");
		fs.mkdirSync(path.dirname(skill), { recursive: true });
		fs.writeFileSync(skill, `# Ship\n\n${GLOBAL_RULE}\n`);
		const { db, close } = await tempDb();
		try {
			await withInstructionHome(path.join(root, "empty-home"), async () => {
				await insertSession(db, "rr3", "/tmp/rr3.jsonl", path.join(root, "nowhere"), "pi");
				await insertMessages(db, "rr3", [
					{ role: "user", text: "open a PR" },
					{ role: "assistant", text: "done, ticket closed" },
					{ role: "user", text: "no, don't close the ticket" },
					{ role: "assistant", text: "reopening" },
				]);
				const mock = createMockLLM({ responder: respond });
				const fw = new AnalyzerFramework({
					db,
					llm: mock.caller,
					modelTiers: DEFAULT_MODEL_TIERS,
					configOverrides: { [RULE_RESTATEMENT_DEF.id]: { instructionPaths: [skill], targetTypes: ["agents_md"] } },
				});
				await registerDefaults(fw);
				const summary = await fw.run("rr3", {});
				assert.equal(summary.errors.length, 0, summary.errors.join("; "));
				const judged = mock.calls.filter((c) => c.tool?.name === "judge_restatement");
				assert.equal(judged.length, 2, "configured targetTypes narrow the check to agents_md proposals");
				assert.ok(judged.every((c) => c.user.includes(`=== ${skill} ===`)), "the configured file is the corpus");
				const restated = (await listProposals(db)).find((p) => p.title === RESTATED)!;
				assert.equal(restated.rule_status, "restated");
				assert.equal(restated.rule_path, skill);
			});
		} finally {
			await close();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	it("plans nothing when the session has no instruction file on disk", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "rr-empty-"));
		const { db, close } = await tempDb();
		try {
			await withInstructionHome(root, async () => {
				await insertSession(db, "rr2", "/tmp/rr2.jsonl", path.join(root, "nowhere"), "pi");
				await insertMessages(db, "rr2", [
					{ role: "user", text: "open a PR" },
					{ role: "assistant", text: "done" },
					{ role: "user", text: "no, that's wrong" },
					{ role: "assistant", text: "fixing" },
				]);
				const mock = createMockLLM({ responder: respond });
				const fw = new AnalyzerFramework({ db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
				await registerDefaults(fw);
				const summary = await fw.run("rr2", {});
				assert.equal(summary.errors.length, 0, summary.errors.join("; "));
				assert.equal(mock.calls.filter((c) => c.tool?.name === "judge_restatement").length, 0);
				for (const p of await listProposals(db)) assert.equal(p.rule_status, "unchecked");
			});
		} finally {
			await close();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
