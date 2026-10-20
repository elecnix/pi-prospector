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
import type { Analyzer, LLMRequest } from "../../src/analyze/types.js";

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

	it("keeps every bumped analyzer's earlier verdicts through a revises edge", async () => {
		// Each analyzer that changed ships a new version, and each one's earlier
		// verdict must stay reachable beside the revision. The three cases share
		// one shape, so they are driven from one table rather than written out
		// three times.
		const { turnPairCoreAnalyzer } = await import("../../src/analyze/analyzers/turn-pair-core/index.js");
		const { turnPairLLMAnalyzer } = await import("../../src/analyze/analyzers/turn-pair-llm/index.js");
		const { assistantCognitionAnalyzer } = await import("../../src/analyze/analyzers/assistant-cognition/index.js");

		interface LineageCase {
			/** The analyzer under test. */
			analyzer: Analyzer;
			/** The version an older install would have shipped. */
			oldVersion: { major: number; minor: number };
			/** The analyzers that must run alongside it, at their current version. */
			also: Analyzer[];
			/** The analyzer id the nodes are read back under. */
			analyzerId: string;
			/** What the earlier verdict said, and what the revision must say. */
			oldVerdict: string;
			newVerdict: string;
			/** The model the old install answered with, and the one the new one does. */
			oldFrictionType: string;
			newFrictionType: string;
		}

		const cases: LineageCase[] = [
			{
				analyzer: turnPairCoreAnalyzer,
				oldVersion: { major: 1, minor: 1 },
				also: [],
				analyzerId: TURN_PAIR_CORE_DEF.id,
				oldVerdict: "no rebuttal candidate",
				newVerdict: "a rebuttal candidate",
				oldFrictionType: "rebuttal",
				newFrictionType: "rebuttal",
			},
			{
				analyzer: turnPairLLMAnalyzer,
				oldVersion: { major: 1, minor: 5 },
				also: [turnPairCoreAnalyzer],
				analyzerId: TURN_PAIR_LLM_DEF.id,
				oldVerdict: "wrong_approach",
				newVerdict: "rebuttal",
				oldFrictionType: "wrong_approach",
				newFrictionType: "rebuttal",
			},
			{
				analyzer: assistantCognitionAnalyzer,
				oldVersion: { major: 1, minor: 0 },
				also: [turnPairCoreAnalyzer],
				analyzerId: ASSISTANT_COGNITION_DEF.id,
				oldVerdict: "no apology array",
				newVerdict: "an apology",
				oldFrictionType: "rebuttal",
				newFrictionType: "rebuttal",
			},
		];

		for (const c of cases) {
			const { db, close } = await tempDb();
			try {
				const sessionId = `s318-lineage-${c.analyzerId}`;
				await insertSession(db, sessionId);
				await insertMessages(db, sessionId, [
					{ id: "u1", role: "user", text: "use --repo to open the pull request" },
					{ id: "a1", role: "assistant", text: "Opened it with --repository.", thinking: THINKING },
					{ id: "u2", role: "user", text: "that's wrong, the flag is --repo" },
					{ id: "a2", role: "assistant", text: "Checking the help output now.", thinking: THINKING },
				]);

				// Fill with the pre-bump analyzer, as an older install would have.
				// The analyzers that also run are registered at their *current*
				// version in both passes, so their output keys — and therefore this
				// analyzer's source set — stay stable and the unit goes stale
				// rather than re-identifying as missing.
				const oldFw = new AnalyzerFramework({ db, llm: mockWith(c.oldFrictionType, null).caller, modelTiers: DEFAULT_MODEL_TIERS });
				for (const a of c.also) await oldFw.register(a);
				await oldFw.register({ ...c.analyzer, version: { ...c.analyzer.version, major: c.oldVersion.major, minor: c.oldVersion.minor } });
				await oldFw.run(sessionId, {});

				const before = await nodesOf(db, c.analyzerId, sessionId);
				assert.ok(before.length > 0, `${c.analyzerId}: the old install produced a verdict`);

				const fw = new AnalyzerFramework({ db, llm: mockWith(c.newFrictionType, "Sorry, my mistake").caller, modelTiers: DEFAULT_MODEL_TIERS });
				for (const a of c.also) await fw.register(a);
				await fw.register(c.analyzer);
				const revised = await fw.run(sessionId, { revise: ["minor"] });
				assert.ok(revised.nodesRevised >= 1, `${c.analyzerId}: the version bump marks its units for revision`);

				const after = await nodesOf(db, c.analyzerId, sessionId);
				assert.ok(after.length > before.length, `${c.analyzerId}: the earlier verdict is preserved beside the revision`);

				const revisesEdges = (await db
					.prepare("SELECT COUNT(*) AS c FROM analysis_edges WHERE edge_kind = 'revises'")
					.get()) as { c: number };
				assert.ok(revisesEdges.c >= 1, `${c.analyzerId}: the revision carries a revises edge back to its predecessor`);

				// The revision carries the new signal the bump was for.
				if (c.analyzerId === TURN_PAIR_LLM_DEF.id) {
					const llm = await contentsOf<LlmContent>(after);
					assert.ok(llm.some((l) => l.friction_type === c.newVerdict), `${c.analyzerId}: the revision names the rebuttal`);
					assert.ok(llm.some((l) => l.friction_type === c.oldVerdict), `${c.analyzerId}: the earlier verdict is still readable`);
				}
			} finally {
				await close();
			}
		}
	});
});
