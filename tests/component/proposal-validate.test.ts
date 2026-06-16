import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import { registerDefaults } from "../../src/analyze/defaults.js";
import { proposalValidateAnalyzer, PROPOSAL_VALIDATE_DEF } from "../../src/analyze/analyzers/proposal-validate/index.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import { listProposals } from "../../src/db/queries.js";
import { verifyNodes } from "../../src/commands/verify.js";
import { rankProposals } from "../../src/commands/proposals.js";
import type { LLMRequest } from "../../src/analyze/types.js";

const GOOD_TITLE = "Pass --repo to gh pr create";
const WRONG_TITLE = "Verify the git push target";

/**
 * Mock model. Two proposals are emitted by the reduce phase: a GOOD rule (about
 * `--repo`) and a WRONG rule (about `push`). In the replay phase the validator
 * (a) reproduces friction on the baseline turn, (b) judges the friction averted
 * only when the GOOD rule is the injected standing instruction.
 */
function respond(req: LLMRequest): string {
	const sys = req.system ?? "";
	const user = req.user ?? "";

	if (sys.includes("classify a single turn")) {
		if (user.includes("STANDING INSTRUCTION")) {
			// With-rule replay: averted only if the rule is the `--repo` one.
			if (user.includes("--repo")) {
				return JSON.stringify({ sentiment: "neutral", friction_type: "none", is_genuine_correction: false, severity: "low", rationale: "rule fixes it" });
			}
			return JSON.stringify({ sentiment: "frustrated", friction_type: "wrong_approach", is_genuine_correction: true, severity: "high", rationale: "rule irrelevant" });
		}
		// Baseline classify (also turn-pair-llm enrichment): friction present.
		return JSON.stringify({ sentiment: "frustrated", friction_type: "wrong_approach", is_genuine_correction: true, severity: "high", rationale: "friction" });
	}
	if (sys.includes("summarise one segment")) {
		return JSON.stringify({ segment_summary: "seg", notable_points: ["p"] });
	}
	// reduce → two competing proposals
	return JSON.stringify({
		session_summary: "The agent targeted the wrong repo on PR creation and was corrected.",
		friction_points: [
			{
				description: "wrong PR target",
				what_to_change: "target the fork explicitly when creating a PR",
				evidence: "user corrected the PR target",
				severity: "high",
			},
		],
		key_positive_signals: [],
		improvement_proposals: [
			{ target_type: "workflow", title: GOOD_TITLE, summary: "target the fork explicitly when creating a PR", detail: "Pass --repo owner/repo to gh pr create.", evidence: "user correction", confidence: 0.6, severity: "correction" },
			{ target_type: "workflow", title: WRONG_TITLE, summary: "check the git push remote", detail: "Run git remote -v before pushing.", evidence: "user correction", confidence: 0.95, severity: "correction" },
		],
	});
}

function seed(db: import("better-sqlite3").Database, id: string): string[] {
	insertSession(db, id);
	return insertMessages(db, id, [
		{ role: "user", text: "open a PR for this branch" },
		{ role: "assistant", text: "creating PR", toolCalls: [{ name: "bash" }] },
		{ role: "toolResult", toolResults: [{ toolName: "bash", isError: true, textLength: 80 }] },
		{ role: "user", text: "no, that's wrong, you targeted the upstream repo instead of my fork" },
		{ role: "assistant", text: "understood, fixing the target" },
	]);
}

describe("proposal-validate (replay validation, issue #6)", () => {
	it("grounds confidence: supports the rule that averts friction, rejects the one that doesn't", async () => {
		const { db, close } = tempDb();
		try {
			const ids = seed(db, "v1");

			// 1) analyze: materialise proposals (defaults only — validation is separate).
			const mock = createMockLLM({ responder: respond, tokensPerCall: 10, costPerCall: 0.001 });
			const fw = new AnalyzerFramework({ db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
			registerDefaults(fw);
			const analyzeSummary = await fw.run("v1", {});
			assert.equal(analyzeSummary.errors.length, 0, analyzeSummary.errors.join("; "));
			assert.equal(analyzeSummary.proposalsCreated, 2);

			// Prerequisite: every proposal carries the session's high-signal turn id.
			const correctionUserId = ids[3]!; // "no, that's wrong …"
			for (const p of listProposals(db)) {
				assert.deepEqual(JSON.parse(p.source_message_ids ?? "[]"), [correctionUserId], `proposal ${p.title} replay set`);
				assert.equal(p.validation_status, "unvalidated");
				assert.equal(p.validated_score, null);
			}

			// 2) validate: run only proposal-validate (deps already current).
			const fw2 = new AnalyzerFramework({ db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
			registerDefaults(fw2);
			fw2.register(proposalValidateAnalyzer);
			const valSummary = await fw2.run("v1", { analyzerIds: [PROPOSAL_VALIDATE_DEF.id] });
			assert.equal(valSummary.errors.length, 0, valSummary.errors.join("; "));

			const vNodes = db.prepare("SELECT COUNT(*) AS c FROM analysis_nodes WHERE node_kind = 'validation'").get() as { c: number };
			assert.equal(vNodes.c, 2, "one validation node per proposal");

			const byTitle = new Map(listProposals(db).map((p) => [p.title, p]));
			const good = byTitle.get(GOOD_TITLE)!;
			const wrong = byTitle.get(WRONG_TITLE)!;

			assert.equal(good.validation_status, "supported");
			assert.equal(good.validated_score, 1);
			assert.ok(good.validation_node_id, "supported proposal links its validation node");

			assert.equal(wrong.validation_status, "unsupported");
			assert.equal(wrong.validated_score, 0);

			// The headline: the WRONG proposal had the higher *model* confidence
			// (0.95 vs 0.6) yet now ranks below the replay-supported one.
			const ranked = [wrong, good].sort(rankProposals).map((p) => p.title);
			assert.deepEqual(ranked, [GOOD_TITLE, WRONG_TITLE]);

			// 3) integrity: validation nodes are content-addressed and verify clean.
			const { mismatches } = verifyNodes(db);
			assert.equal(mismatches.length, 0, JSON.stringify(mismatches));

			// 4) idempotency: re-validating produces no new nodes.
			const fw3 = new AnalyzerFramework({ db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
			registerDefaults(fw3);
			fw3.register(proposalValidateAnalyzer);
			const again = await fw3.run("v1", { analyzerIds: [PROPOSAL_VALIDATE_DEF.id] });
			const vr = again.analyzerResults.find((r) => r.analyzerId === PROPOSAL_VALIDATE_DEF.id)!;
			assert.equal(vr.nodesProduced, 0, "validation is idempotent");
		} finally {
			close();
		}
	});
});
