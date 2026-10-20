/**
 * Component tests for the two speech acts named in issue #318 — the assistant's
 * **apology** and the user's **rebuttal** — exercised end-to-end through the
 * analyzer framework over real SQLite with synthetic fixtures and a mock LLM.
 *
 * No network, no API keys, no real session data: every session below is
 * hand-written synthetic JSONL-shaped rows.
 *
 * The scenarios are the ones the issue names: an apology after a rebuttal, an
 * apology with no rebuttal before it, a rebuttal the assistant disputes, and an
 * "I told you to use X" instruction that stays a correction and never becomes
 * a rebuttal.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import { registerDefaults } from "../../src/analyze/defaults.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import { ASSISTANT_COGNITION_DEF } from "../../src/analyze/analyzers/assistant-cognition/index.js";
import { TURN_PAIR_CORE_DEF } from "../../src/analyze/analyzers/turn-pair-core/index.js";
import { TURN_PAIR_LLM_DEF } from "../../src/analyze/analyzers/turn-pair-llm/index.js";
import type { AnalysisNodeRow } from "../../src/analyze/types.js";
import type { LLMRequest } from "../../src/analyze/types.js";

/** A turn's assistant response that concedes a mistake, with a thinking trace. */
const APOLOGY_RESPONSE = "Sorry, my mistake — the flag is --repo, not --repository.";

/** The same concession, but the turn carries no thinking trace at all. */
const APOLOGY_RESPONSE_NO_THINKING = "Sorry, my mistake — the flag is --repo, not --repository.";

const THINKING = "The user asked me to open a pull request. I should check the repository flag before running the command.";

/**
 * A mock LLM that answers the cognition tool call with a fixed apology payload
 * and the classify tool call with a fixed friction type. Every other analyzer
 * gets a benign answer.
 */
function mockWith(classifyFrictionType: string, apologyQuote: string | null) {
	return createMockLLM({
		responder: (req: LLMRequest) => {
			if (req.tool?.name === "record_cognition") {
				return {
					structured: {
						confusion: [],
						indecision: [],
						surprise: [],
						apology: apologyQuote
							? [{ quote: apologyQuote, severity: "high", rationale: "the assistant conceded the mistake" }]
							: [],
					},
				};
			}
			if (req.tool?.name === "classify_turn") {
				return {
					structured: {
						sentiment: "frustrated",
						friction_type: classifyFrictionType,
						is_genuine_correction: true,
						severity: "high",
						rationale: "the user disputed the assistant",
					},
				};
			}
			if (req.tool?.name === "classify_term") {
				return { structured: { polarity: "neutral", category: "none", language: "und", confidence: 0.9, rationale: "ordinary vocabulary" } };
			}
			if ((req.system ?? "").includes("classify a single turn")) {
				return {
					text: JSON.stringify({
						sentiment: "frustrated",
						friction_type: classifyFrictionType,
						is_genuine_correction: true,
						severity: "high",
						rationale: "the user disputed the assistant",
					}),
				};
			}
			if ((req.system ?? "").includes("summarise one segment")) {
				return { text: JSON.stringify({ segment_summary: "a segment", notable_points: ["point"] }) };
			}
			return {
				text: JSON.stringify({
					session_summary: "The session went as recorded.",
					friction_points: [],
					key_positive_signals: [],
					improvement_proposals: [],
				}),
			};
		},
		tokensPerCall: 10,
		costPerCall: 0.0001,
	});
}

async function nodesOf(
	db: Awaited<ReturnType<typeof tempDb>>["db"],
	analyzerId: string,
	sessionId: string,
): Promise<AnalysisNodeRow[]> {
	return (await db
		.prepare("SELECT * FROM analysis_nodes WHERE analyzer_id = ? AND session_id = ?")
		.all(analyzerId, sessionId)) as unknown as AnalysisNodeRow[];
}

interface CoreContent {
	user_message_id: string;
	correction_detected: boolean;
	correction_type: string | null;
	rebuttal_candidate: boolean;
	rebuttal_patterns: string[];
	rebuttal_text: string | null;
}

interface CognitionContent {
	user_message_id: string;
	confusion: unknown[];
	indecision: unknown[];
	surprise: unknown[];
	apology: Array<{ quote: string; severity: string; rationale: string }>;
}

interface LlmContent {
	user_message_id: string;
	friction_type: string;
}

/** Parse every node of one analyzer into its content object. */
async function contentsOf<T>(rows: AnalysisNodeRow[]): Promise<T[]> {
	return rows.map((r) => JSON.parse(r.content_json) as T);
}

describe("issue #318 — apology and rebuttal", () => {
	it("marks a rebuttal candidate on the user's dispute and confirms it as a friction type", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s318-rebuttal");
			await insertMessages(db, "s318-rebuttal", [
				{ id: "u1", role: "user", text: "use --repo to open the pull request" },
				{ id: "a1", role: "assistant", text: "Opened it with --repository.", thinking: THINKING },
				// The user disputes a claim the assistant made.
				{ id: "u2", role: "user", text: "that's wrong, the flag is --repo" },
				{ id: "a2", role: "assistant", text: "Checking the help output now.", thinking: THINKING },
			]);

			const mock = mockWith("rebuttal", null);
			const fw = new AnalyzerFramework({ db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
			await registerDefaults(fw);
			const summary = await fw.run("s318-rebuttal", {});
			assert.equal(summary.errors.length, 0, summary.errors.join("; "));

			// The deterministic layer marked the candidate…
			const core = await contentsOf<CoreContent>(await nodesOf(db, TURN_PAIR_CORE_DEF.id, "s318-rebuttal"));
			const disputed = core.find((c) => c.user_message_id === "u2")!;
			assert.equal(disputed.rebuttal_candidate, true, "the dispute is a rebuttal candidate");
			assert.ok(disputed.rebuttal_patterns.length > 0, "the candidate names the pattern that fired");
			assert.match(disputed.rebuttal_text ?? "", /that's wrong/);
			// …and the first turn, which disputes nothing, is not a candidate.
			const first = core.find((c) => c.user_message_id === "u1")!;
			assert.equal(first.rebuttal_candidate, false);

			// …and the model layer confirmed it.
			const llm = await contentsOf<LlmContent>(await nodesOf(db, TURN_PAIR_LLM_DEF.id, "s318-rebuttal"));
			assert.ok(llm.length > 0, "the disputed turn reached the classifier");
			assert.equal(llm.find((l) => l.user_message_id === "u2")?.friction_type, "rebuttal");
		} finally {
			await close();
		}
	});

	it("keeps an 'I told you to use X' instruction a correction and never a rebuttal", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s318-instruction");
			await insertMessages(db, "s318-instruction", [
				{ id: "u1", role: "user", text: "open a pull request please" },
				{ id: "a1", role: "assistant", text: "Done.", thinking: THINKING },
				// An instruction: it asks for different behaviour and leaves the
				// assistant's stated fact unchallenged.
				{ id: "u2", role: "user", text: "I told you to use --repo, not --repository" },
				{ id: "a2", role: "assistant", text: "Redoing it with --repo.", thinking: THINKING },
			]);

			const mock = mockWith("missed_instruction", null);
			const fw = new AnalyzerFramework({ db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
			await registerDefaults(fw);
			const summary = await fw.run("s318-instruction", {});
			assert.equal(summary.errors.length, 0, summary.errors.join("; "));

			const core = await contentsOf<CoreContent>(await nodesOf(db, TURN_PAIR_CORE_DEF.id, "s318-instruction"));
			const instructed = core.find((c) => c.user_message_id === "u2")!;
			assert.equal(instructed.correction_detected, true, "the instruction is still a correction");
			assert.equal(instructed.correction_type, "explicit");
			assert.equal(instructed.rebuttal_candidate, false, "an instruction is never a rebuttal candidate");
		} finally {
			await close();
		}
	});

	it("analyses a turn with an empty thinking trace whose response apologises", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s318-no-thinking");
			await insertMessages(db, "s318-no-thinking", [
				{ id: "u1", role: "user", text: "open a pull request please" },
				// No thinking trace at all: the deterministic apology match is the
				// second way in, and it must reach the analyzer.
				{ id: "a1", role: "assistant", text: APOLOGY_RESPONSE_NO_THINKING },
			]);

			const mock = mockWith("none", "Sorry, my mistake");
			const fw = new AnalyzerFramework({ db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
			await registerDefaults(fw);
			const summary = await fw.run("s318-no-thinking", {});
			assert.equal(summary.errors.length, 0, summary.errors.join("; "));

			const cognition = await contentsOf<CognitionContent>(await nodesOf(db, ASSISTANT_COGNITION_DEF.id, "s318-no-thinking"));
			assert.equal(cognition.length, 1, "the apologetic turn was analysed despite the empty thinking trace");
			assert.equal(cognition[0]!.apology.length, 1, "the apology was recorded");
			assert.equal(cognition[0]!.apology[0]!.quote, "Sorry, my mistake");
			assert.equal(cognition[0]!.apology[0]!.severity, "high");
		} finally {
			await close();
		}
	});

	it("does not analyse a turn with an empty thinking trace and no apology", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s318-no-thinking-no-apology");
			await insertMessages(db, "s318-no-thinking-no-apology", [
				{ id: "u1", role: "user", text: "open a pull request please" },
				{ id: "a1", role: "assistant", text: "Opened the pull request with --repo." },
			]);

			const mock = mockWith("none", null);
			const fw = new AnalyzerFramework({ db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
			await registerDefaults(fw);
			const summary = await fw.run("s318-no-thinking-no-apology", {});
			assert.equal(summary.errors.length, 0, summary.errors.join("; "));

			const cognition = await nodesOf(db, ASSISTANT_COGNITION_DEF.id, "s318-no-thinking-no-apology");
			assert.equal(cognition.length, 0, "the gate still holds for a turn with neither reasoning nor apology");
		} finally {
			await close();
		}
	});

	it("drops an apology quote that is not an exact substring of the response text", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s318-bad-quote");
			await insertMessages(db, "s318-bad-quote", [
				{ id: "u1", role: "user", text: "open a pull request please" },
				{ id: "a1", role: "assistant", text: APOLOGY_RESPONSE, thinking: THINKING },
			]);

			// A paraphrase, not the assistant's words.
			const mock = mockWith("none", "the assistant apologised for the mistake");
			const fw = new AnalyzerFramework({ db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
			await registerDefaults(fw);
			const summary = await fw.run("s318-bad-quote", {});
			assert.equal(summary.errors.length, 0, summary.errors.join("; "));

			const cognition = await contentsOf<CognitionContent>(await nodesOf(db, ASSISTANT_COGNITION_DEF.id, "s318-bad-quote"));
			assert.equal(cognition.length, 1, "the node is still produced");
			assert.deepEqual(cognition[0]!.apology, [], "the unverifiable quote does not enter the graph");
		} finally {
			await close();
		}
	});

	it("records an apology after a rebuttal and an apology with no rebuttal in the same session", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s318-both");
			await insertMessages(db, "s318-both", [
				{ id: "u1", role: "user", text: "use --repo to open the pull request" },
				{ id: "a1", role: "assistant", text: "Opened it with --repository.", thinking: THINKING },
				// A rebuttal, then the assistant concedes.
				{ id: "u2", role: "user", text: "that's wrong, the flag is --repo" },
				{ id: "a2", role: "assistant", text: APOLOGY_RESPONSE, thinking: THINKING },
				// A later turn the assistant gets wrong on its own and concedes.
				{ id: "u3", role: "user", text: "now check the CI status" },
				{ id: "a3", role: "assistant", text: "Sorry, my mistake — the workflow name is wrong.", thinking: THINKING },
			]);

			const mock = mockWith("rebuttal", "Sorry, my mistake");
			const fw = new AnalyzerFramework({ db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
			await registerDefaults(fw);
			const summary = await fw.run("s318-both", {});
			assert.equal(summary.errors.length, 0, summary.errors.join("; "));

			const cognition = await contentsOf<CognitionContent>(await nodesOf(db, ASSISTANT_COGNITION_DEF.id, "s318-both"));
			// A cognition node is anchored to the turn's user message, so the
			// apology after a rebuttal lands on the disputed turn (u2) and the
			// standalone apology on the later turn (u3).
			const apologised = cognition.filter((c) => c.apology.length > 0).map((c) => c.user_message_id);
			assert.deepEqual(apologised.sort(), ["u2", "u3"], "both the apology after a rebuttal and the standalone apology were recorded");

			const core = await contentsOf<CoreContent>(await nodesOf(db, TURN_PAIR_CORE_DEF.id, "s318-both"));
			const disputed = core.find((c) => c.user_message_id === "u2")!;
			assert.equal(disputed.rebuttal_candidate, true, "the rebuttal before the apology is marked");
			// The apology itself is the assistant's side; the turn the assistant
			// conceded on its own carries no rebuttal candidate.
			const standalone = core.find((c) => c.user_message_id === "u3")!;
			assert.equal(standalone.rebuttal_candidate, false, "an apology with no rebuttal before it");
		} finally {
			await close();
		}
	});

	it("records a rebuttal the assistant disputes back", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s318-disputed");
			await insertMessages(db, "s318-disputed", [
				{ id: "u1", role: "user", text: "open a pull request please" },
				{ id: "a1", role: "assistant", text: "Opened it with --repository.", thinking: THINKING },
				// The user disputes the assistant; the assistant disputes back.
				{ id: "u2", role: "user", text: "that's wrong, the flag is --repo" },
				{ id: "a2", role: "assistant", text: "You're wrong — --repository is the real flag here, as the help output shows.", thinking: THINKING },
			]);

			const mock = mockWith("rebuttal", null);
			const fw = new AnalyzerFramework({ db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
			await registerDefaults(fw);
			const summary = await fw.run("s318-disputed", {});
			assert.equal(summary.errors.length, 0, summary.errors.join("; "));

			const core = await contentsOf<CoreContent>(await nodesOf(db, TURN_PAIR_CORE_DEF.id, "s318-disputed"));
			const disputed = core.find((c) => c.user_message_id === "u2")!;
			assert.equal(disputed.rebuttal_candidate, true, "the user's dispute is still a rebuttal candidate");

			// The assistant's answer contains "You're wrong", which is a rebuttal
			// *pattern* — but the matcher reads the user's message, so the
			// assistant's own words never mark a candidate on the user's turn.
			const llm = await contentsOf<LlmContent>(await nodesOf(db, TURN_PAIR_LLM_DEF.id, "s318-disputed"));
			assert.equal(llm.find((l) => l.user_message_id === "u2")?.friction_type, "rebuttal");
		} finally {
			await close();
		}
	});

	it("keeps the core's earlier verdicts through its version bump and links them by a revises edge", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s318-lineage-core");
			await insertMessages(db, "s318-lineage-core", [
				{ id: "u1", role: "user", text: "use --repo to open the pull request" },
				{ id: "a1", role: "assistant", text: "Opened it with --repository.", thinking: THINKING },
				{ id: "u2", role: "user", text: "that's wrong, the flag is --repo" },
				{ id: "a2", role: "assistant", text: "Checking the help output now.", thinking: THINKING },
			]);

			const { turnPairCoreAnalyzer } = await import("../../src/analyze/analyzers/turn-pair-core/index.js");

			// Fill with the pre-bump core (minor 1), as an older install would
			// have. The core's source set is the turn's message ids, which do not
			// change, so the unit goes stale and is revised beside its predecessor.
			const oldFw = new AnalyzerFramework({ db, llm: mockWith("rebuttal", null).caller, modelTiers: DEFAULT_MODEL_TIERS });
			await oldFw.register({ ...turnPairCoreAnalyzer, version: { ...turnPairCoreAnalyzer.version, minor: 1 } });
			await oldFw.run("s318-lineage-core", {});

			const before = await contentsOf<CoreContent>(await nodesOf(db, TURN_PAIR_CORE_DEF.id, "s318-lineage-core"));
			assert.equal(before.length, 2, "the old install filled each turn once");
			assert.equal(before[0]!.rebuttal_candidate, false, "the old install had no rebuttal field");

			const fw = new AnalyzerFramework({ db, llm: mockWith("rebuttal", null).caller, modelTiers: DEFAULT_MODEL_TIERS });
			await fw.register(turnPairCoreAnalyzer);
			const revised = await fw.run("s318-lineage-core", { revise: ["minor"] });
			assert.ok(revised.nodesRevised >= 1, "the version bump marks the core's units for revision");

			const after = await contentsOf<CoreContent>(await nodesOf(db, TURN_PAIR_CORE_DEF.id, "s318-lineage-core"));
			assert.equal(after.length, 4, "the earlier verdicts are preserved beside the revisions");
			assert.ok(after.some((c) => c.rebuttal_candidate), "the revision carries the new signal");

			const revisesEdges = (await db
				.prepare("SELECT COUNT(*) AS c FROM analysis_edges WHERE edge_kind = 'revises'")
				.get()) as { c: number };
			assert.ok(revisesEdges.c >= 1, "the new node carries a revises edge back to its predecessor");
		} finally {
			await close();
		}
	});

	it("keeps the cognition's earlier verdicts through its version bump", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s318-lineage-cognition");
			await insertMessages(db, "s318-lineage-cognition", [
				{ id: "u1", role: "user", text: "use --repo to open the pull request" },
				{ id: "a1", role: "assistant", text: "Opened it with --repository.", thinking: THINKING },
				{ id: "u2", role: "user", text: "that's wrong, the flag is --repo" },
				{ id: "a2", role: "assistant", text: "Checking the help output now.", thinking: THINKING },
			]);

			const { assistantCognitionAnalyzer } = await import("../../src/analyze/analyzers/assistant-cognition/index.js");
			const { turnPairCoreAnalyzer } = await import("../../src/analyze/analyzers/turn-pair-core/index.js");

			// The core runs at its current version in both passes, so the core's
			// output key — and therefore the cognition unit's source set — is
			// stable and the unit goes stale rather than re-identifying.
			const oldFw = new AnalyzerFramework({ db, llm: mockWith("rebuttal", null).caller, modelTiers: DEFAULT_MODEL_TIERS });
			await oldFw.register(turnPairCoreAnalyzer);
			await oldFw.register({ ...assistantCognitionAnalyzer, version: { ...assistantCognitionAnalyzer.version, minor: 0 } });
			await oldFw.run("s318-lineage-cognition", {});

			const before = await nodesOf(db, ASSISTANT_COGNITION_DEF.id, "s318-lineage-cognition");
			assert.ok(before.length > 0, "the old install graded the turns");

			const fw = new AnalyzerFramework({ db, llm: mockWith("rebuttal", "Sorry, my mistake").caller, modelTiers: DEFAULT_MODEL_TIERS });
			await fw.register(turnPairCoreAnalyzer);
			await fw.register(assistantCognitionAnalyzer);
			const revised = await fw.run("s318-lineage-cognition", { revise: ["minor"] });
			assert.ok(revised.nodesRevised >= 1, "the version bump marks the cognition unit for revision");

			const after = await nodesOf(db, ASSISTANT_COGNITION_DEF.id, "s318-lineage-cognition");
			assert.ok(after.length > before.length, "the earlier verdict is preserved beside the revision");
			const revisesEdges = (await db
				.prepare("SELECT COUNT(*) AS c FROM analysis_edges WHERE edge_kind = 'revises'")
				.get()) as { c: number };
			assert.ok(revisesEdges.c >= 1, "the revision carries a revises edge back to its predecessor");
		} finally {
			await close();
		}
	});

	it("keeps the classifier's earlier verdicts through its version bump", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s318-lineage-llm");
			await insertMessages(db, "s318-lineage-llm", [
				{ id: "u1", role: "user", text: "use --repo to open the pull request" },
				{ id: "a1", role: "assistant", text: "Opened it with --repository.", thinking: THINKING },
				{ id: "u2", role: "user", text: "that's wrong, the flag is --repo" },
				{ id: "a2", role: "assistant", text: "Checking the help output now.", thinking: THINKING },
			]);

			const { turnPairCoreAnalyzer } = await import("../../src/analyze/analyzers/turn-pair-core/index.js");
			const { turnPairLLMAnalyzer } = await import("../../src/analyze/analyzers/turn-pair-llm/index.js");

			const oldFw = new AnalyzerFramework({ db, llm: mockWith("wrong_approach", null).caller, modelTiers: DEFAULT_MODEL_TIERS });
			await oldFw.register(turnPairCoreAnalyzer);
			await oldFw.register({ ...turnPairLLMAnalyzer, version: { ...turnPairLLMAnalyzer.version, minor: 5 } });
			await oldFw.run("s318-lineage-llm", {});

			const before = await contentsOf<LlmContent>(await nodesOf(db, TURN_PAIR_LLM_DEF.id, "s318-lineage-llm"));
			assert.ok(before.length > 0, "the old install enriched the disputed turn");
			assert.equal(before[0]!.friction_type, "wrong_approach", "the old install had no rebuttal type");

			const fw = new AnalyzerFramework({ db, llm: mockWith("rebuttal", null).caller, modelTiers: DEFAULT_MODEL_TIERS });
			await fw.register(turnPairCoreAnalyzer);
			await fw.register(turnPairLLMAnalyzer);
			const revised = await fw.run("s318-lineage-llm", { revise: ["minor"] });
			assert.ok(revised.nodesRevised >= 1, "the version bump marks the classifier unit for revision");

			const after = await contentsOf<LlmContent>(await nodesOf(db, TURN_PAIR_LLM_DEF.id, "s318-lineage-llm"));
			assert.ok(after.length > before.length, "the earlier verdict is preserved beside the revision");
			assert.ok(after.some((l) => l.friction_type === "rebuttal"), "the revision carries the new signal");

			const revisesEdges = (await db
				.prepare("SELECT COUNT(*) AS c FROM analysis_edges WHERE edge_kind = 'revises'")
				.get()) as { c: number };
			assert.ok(revisesEdges.c >= 1, "the revision carries a revises edge back to its predecessor");
		} finally {
			await close();
		}
	});
});
