/**
 * The recall gain, end to end.
 *
 * The shipped correction patterns in `turn-pair-core/patterns.ts` are English
 * regexes. A French user correcting the agent — "Putain, c'est encore faux. Je
 * t'ai dit d'utiliser le module existant" — matches none of them, produces no
 * tool failure, and therefore scores zero friction. Nothing downstream ever looks
 * at that turn.
 *
 * These tests pin the before/after: the deterministic layer alone still misses
 * it (we are not weakening that layer), and the learned lexicon is what carries
 * it into enrichment and into the digest the synthesiser reads.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import { registerDefaults } from "../../src/analyze/defaults.js";
import { turnPairCoreAnalyzer, TURN_PAIR_CORE_DEF, type TurnPairCoreProperties } from "../../src/analyze/analyzers/turn-pair-core/index.js";
import { TURN_PAIR_LLM_DEF } from "../../src/analyze/analyzers/turn-pair-llm/index.js";
import { SESSION_OVERVIEW_DEF } from "../../src/analyze/analyzers/session-overview/index.js";
import { getNodesByAnalyzer } from "../../src/db/analysis-queries.js";
import type { LLMRequest } from "../../src/analyze/types.js";

/** A French correction: no English pattern, no tool call, no error. */
const FRENCH_SESSION = [
	{ role: "user", text: "Ajoute une fonction pour formater les dates." },
	{ role: "assistant", text: "Added a formatDate helper using the Intl API." },
	{ role: "user", text: "Putain, c'est encore faux. Je t'ai dit d'utiliser le module existant." },
	{ role: "assistant", text: "Rewritten to use the existing date module." },
];

const FRUSTRATION_TERMS = new Set(["putain", "faux", "encore", "pénible"]);

function respond(req: LLMRequest) {
	if (req.tool?.name === "classify_term") {
		const term = String((req.user.match(/TERM:\s*(.*)/) ?? [])[1] ?? "").trim();
		const frustrated = FRUSTRATION_TERMS.has(term);
		return {
			text: "x",
			structured: {
				polarity: frustrated ? "frustration" : "neutral",
				category: frustrated ? (term === "encore" ? "repetition" : "dissatisfaction") : "none",
				language: frustrated ? "fr" : "und",
				confidence: 0.9,
				rationale: "r",
			},
		};
	}
	if (req.tool?.name === "classify_turn") {
		return {
			text: "x",
			structured: {
				sentiment: "frustrated",
				friction_type: "missed_instruction",
				is_genuine_correction: true,
				severity: "high",
				rationale: "user restated an instruction",
			},
		};
	}
	if (req.tool?.name === "submit_segment_summary") {
		return { text: "x", structured: { segment_summary: "seg", notable_points: [] } };
	}
	return {
		text: "x",
		structured: {
			session_summary: "A French session with a repeated correction.",
			friction_points: [
				{ description: "instruction restated", what_to_change: "document the date-module convention", evidence: "turn 2", severity: "high" },
			],
			key_positive_signals: [],
			improvement_proposals: [
				{
					target_type: "agents_md",
					target_path: "AGENTS.md",
					title: "Document the date-module convention",
					summary: "Say which date module to use.",
					detail: "d",
					evidence: "e",
					confidence: 0.7,
					severity: "correction",
				},
			],
		},
	};
}

describe("multilingual friction recall", () => {
	it("the deterministic layer alone still sees no friction (the gap this closes)", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "fr1");
			await insertMessages(db, "fr1", FRENCH_SESSION);

			const llm = createMockLLM({ responder: respond });
			const framework = new AnalyzerFramework({ db, llm: llm.caller, modelTiers: DEFAULT_MODEL_TIERS });
			framework.register(turnPairCoreAnalyzer);
			await framework.run("fr1", { analyzerIds: [TURN_PAIR_CORE_DEF.id] });

			const core = ((await getNodesByAnalyzer(db, TURN_PAIR_CORE_DEF.id, "fr1")).map(
				(n) => JSON.parse(n.content_json) as TurnPairCoreProperties,
			);
			assert.equal(core.length, 2);
			assert.equal(
				core.some((p) => p.high_signal),
				false,
				"English correction patterns cannot see a French correction",
			);
		} finally {
await close();
		}
	});

	it("the learned lexicon carries the turn into enrichment and the digest", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "fr1");
			const ids = insertMessages(db, "fr1", FRENCH_SESSION);

			const llm = createMockLLM({ responder: respond });
			const framework = new AnalyzerFramework({ db, llm: llm.caller, modelTiers: DEFAULT_MODEL_TIERS });
			registerDefaults(framework);
			await framework.run("fr1");

			// The turn the deterministic layer scored at zero is now classified.
			const enriched = ((await getNodesByAnalyzer(db, TURN_PAIR_LLM_DEF.id, "fr1")).map(
				(n) => JSON.parse(n.content_json) as { user_message_id: string; sentiment: string },
			);
			assert.equal(enriched.length, 1, "exactly the frustrated turn was promoted");
			assert.equal(enriched[0]!.user_message_id, ids[2], "and it is the French correction");

			// The synthesiser sees the vocabulary that justified the promotion.
			const reduce = llm.calls.find((c) => c.tool?.name === "submit_session_analysis");
			assert.ok(reduce, "a session synthesis ran");
			assert.match(reduce!.user, /frustration=\[/, "the digest carries the lexicon fragment");
			assert.match(reduce!.user, /putain:dissatisfaction\/fr/);
			assert.match(reduce!.user, /"frustration_signals": 1/);
			assert.match(reduce!.user, /"frustration_languages": \[\s*"fr"\s*\]/);

			// And a proposal comes out the far end of the ordinary pipeline.
			const summaries = getNodesByAnalyzer(db, SESSION_OVERVIEW_DEF.id, "fr1");
			assert.equal(summaries.length, 1);
			const proposals = db.prepare("SELECT COUNT(*) AS n FROM proposals WHERE session_id = ?").get("fr1") as { n: number };
			assert.ok(proposals.n > 0, "the friction reaches a reviewable proposal");
		} finally {
await close();
		}
	});
});
