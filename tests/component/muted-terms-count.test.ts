/**
 * A muted lexicon term stops counting (issue #321, alongside #325).
 *
 * A mute is the operator's judgement that a term is not a signal. Two halves
 * follow from it, and this file covers the second:
 *
 *   - **Future matches.** `turn-frustration`'s `plan()` skips a muted term, so
 *     no new hit node is produced for it. (Covered in `mutes.test.ts`.)
 *   - **Past hits.** The term's existing hit nodes stay in the graph — it is
 *     append-only, and no node is ever deleted — but they must stop *counting*.
 *     A reader that summed them would report the operator's rejected term as
 *     one of the corpus's loudest signals, which is the opposite of what the
 *     mute was for.
 *
 * The count is filtered at the point the number is computed, in
 * `friction-accumulation` (the accumulated friction) and in the session digest
 * (the frustration signal count and the terms listed). Unmuting restores the
 * count, symmetrically, with nothing recomputed.
 *
 * Retracting the hit nodes themselves is issue #325's work and is deliberately
 * not duplicated here.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import { turnPairCoreAnalyzer } from "../../src/analyze/analyzers/turn-pair-core/index.js";
import { lexiconCandidatesAnalyzer } from "../../src/analyze/analyzers/lexicon-candidates/index.js";
import { frustrationLexiconAnalyzer, FRUSTRATION_LEXICON_DEF } from "../../src/analyze/analyzers/frustration-lexicon/index.js";
import { turnFrustrationAnalyzer, TURN_FRUSTRATION_DEF } from "../../src/analyze/analyzers/turn-frustration/index.js";
import { frictionAccumulationAnalyzer, FRICTION_ACCUMULATION_DEF } from "../../src/analyze/analyzers/friction-accumulation/index.js";
import { buildDigest } from "../../src/analyze/analyzers/session-overview/digest.js";
import { readNodes } from "../../src/commands/nodes.js";
import {
	getNodesByAnalyzer,
	listAnalysisNodes,
	getSessionMessageRows,
} from "../../src/db/analysis-queries.js";
import { muteTerm, unmuteTerm } from "../../src/commands/mutes.js";
import { getMutedTerms } from "../../src/db/assertions.js";
import type { LLMRequest } from "../../src/analyze/types.js";

/** The one term our stub model calls frustration. */
const FRUSTRATED_TERMS = new Set(["putain"]);

/** A session whose only lexicon hit is the term the operator will mute. */
const MESSAGES = [
	{ role: "user" as const, text: "putain the parser is broken" },
	{ role: "assistant" as const, text: "Fixed." },
];

async function build(db: Parameters<typeof getNodesByAnalyzer>[0]) {
	const llm = createMockLLM({
		responder: (req: LLMRequest) => {
			const term = String((req.user.match(/TERM:\s*(.*)/) ?? [])[1] ?? "").trim();
			const frustrated = FRUSTRATED_TERMS.has(term);
			return {
				text: "x",
				structured: {
					polarity: frustrated ? "frustration" : "neutral",
					category: frustrated ? "dissatisfaction" : "none",
					language: frustrated ? "fr" : "und",
					confidence: 0.9,
					rationale: "r",
				},
			};
		},
	});
	const framework = new AnalyzerFramework({ db, llm: llm.caller, modelTiers: DEFAULT_MODEL_TIERS });
	await framework.register(turnPairCoreAnalyzer);
	await framework.register(lexiconCandidatesAnalyzer);
	await framework.register(frustrationLexiconAnalyzer);
	await framework.register(turnFrustrationAnalyzer);
	await framework.register(frictionAccumulationAnalyzer);
	return framework;
}

/**
 * The accumulated friction the analyzer currently reports for a session.
 *
 * Reads the *current* generation, and the **newest** of them. A `--revise config`
 * run produces a new node and leaves its predecessor in the graph as lineage; the
 * newest current node is the head of that chain and the current answer.
 *
 * After an unmute there can be more than one current node: the accumulation's
 * source set references its upstream hit nodes by output key, and an unmute
 * recomputes those upstream nodes under a new recipe, so the accumulation is
 * re-identified rather than revised. That is the graph's ordinary downstream
 * behaviour — an upstream content change re-identifies its consumer — and it is
 * why the newest node is the one to read. Retracting a node rather than
 * superseding it is issue #325's work.
 */
async function accumulation(
	db: Parameters<typeof getNodesByAnalyzer>[0],
	sessionId: string,
): Promise<{ accumulated: number; frustrationWeight: number; current: number }> {
	const nodes = await listAnalysisNodes(db, { analyzerId: FRICTION_ACCUMULATION_DEF.id, sessionId });
	assert.ok(nodes.length > 0, "the session has a current friction-accumulation node");
	const newest = nodes[0]!;
	const props = JSON.parse(newest.content_json) as {
		accumulated_friction: number;
		turn_contributions: Array<{ frustration_weight: number }>;
	};
	return {
		accumulated: props.accumulated_friction,
		frustrationWeight: props.turn_contributions.reduce((sum, c) => sum + c.frustration_weight, 0),
		current: nodes.length,
	};
}

describe("a muted term stops counting", () => {
	it("contributes nothing to the accumulated friction, and unmuting restores it", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", MESSAGES);

			const framework = await build(db);
			await framework.run("s1");

			// The lexicon hit exists and the friction is real to begin with.
			const hits = await getNodesByAnalyzer(db, TURN_FRUSTRATION_DEF.id, "s1");
			assert.ok(hits.length > 0, "the term produced a hit node");
			const before = await accumulation(db, "s1");
			assert.ok(before.frustrationWeight > 0, "the hit contributed weight to the accumulation");

			// The operator mutes the term. The hit nodes stay in the graph…
			await muteTerm(db, { term: "putain", reason: "not a signal for this corpus", by: "operator" });
			assert.deepEqual(await getMutedTerms(db), ["putain"]);
			assert.ok(
				(await getNodesByAnalyzer(db, TURN_FRUSTRATION_DEF.id, "s1")).length > 0,
				"the hit node is not deleted — the graph is append-only",
			);

			// …but it no longer counts. The accumulation is recomputed for the
			// session, and the muted term's weight is gone from it.
			await framework.run("s1", { revise: ["config"] });
			const after = await accumulation(db, "s1");
			assert.equal(after.current, 1, "the muted-era accumulation revises its predecessor");
			assert.equal(after.frustrationWeight, 0, "a muted term contributes no weight to the accumulation");
			assert.ok(after.accumulated < before.accumulated, "and the accumulated friction drops accordingly");

			// Unmuting restores the count, symmetrically.
			await unmuteTerm(db, "putain");
			await framework.run("s1", { revise: ["config"] });
			const restored = await accumulation(db, "s1");
			assert.equal(restored.frustrationWeight, before.frustrationWeight, "unmuting restores the term's contribution");
			assert.equal(restored.accumulated, before.accumulated);
		} finally {
			await close();
		}
	});

	it("leaves an unmuted term's contribution untouched", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", MESSAGES);

			const framework = await build(db);
			await framework.run("s1");
			const before = await accumulation(db, "s1");

			// Muting a term the session never used changes nothing.
			await muteTerm(db, { term: "never", by: "operator" });
			await framework.run("s1", { revise: ["config"] });
			const after = await accumulation(db, "s1");
			assert.equal(after.frustrationWeight, before.frustrationWeight);
			assert.equal(after.accumulated, before.accumulated);
		} finally {
			await close();
		}
	});

	it("lists a signal once in the digest, even after an unmute leaves two live generations of the hit", async () => {
		// The unmute does not retract the muted-era hit node; it produces a *new*
		// one under a new recipe, and the graph is append-only. Both generations
		// are live, so a reader that takes every live hit counts the same
		// frustration signal twice and renders it twice in the digest line.
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", MESSAGES);

			const framework = await build(db);
			await framework.run("s1");

			await muteTerm(db, { term: "putain", by: "operator" });
			await framework.run("s1", { revise: ["config"] });
			await unmuteTerm(db, "putain");
			await framework.run("s1", { revise: ["config"] });

			const live = await listAnalysisNodes(db, {
				analyzerId: TURN_FRUSTRATION_DEF.id,
				sessionId: "s1",
				allVersions: true,
			});
			assert.equal(live.length, 2, "the unmute leaves both hit generations live");

			const core = await getNodesByAnalyzer(db, "turn-pair-core", "s1");
			const digest = buildDigest({
				sessionId: "s1",
				messages: (await getSessionMessageRows(db, "s1")) as never,
				coreNodes: core,
				llmNodes: [],
				trajectoryNodes: [],
				failureNodes: [],
				frustrationNodes: live,
			});
			assert.equal(digest.frustrationSignalCount, 1, "one turn carries the signal");
			const line = digest.text.split("\n").find((l) => l.includes("frustration=["));
			assert.ok(line, "the digest carries a frustration line");
			const fragment = line.match(/frustration=\[([^\]]*)\]/)?.[1] ?? "";
			assert.equal(
				fragment.split(",").filter((s) => s.includes("putain")).length,
				1,
				`the digest lists the signal once, not once per generation: ${fragment}`,
			);
		} finally {
			await close();
		}
	});

	it("keeps a muted term out of the frustration ranking, and unmuting puts it back", async () => {
		// The ranking is the operator-facing view of the corpus's loudest signals.
		// A muted term must not appear in it, or the mute achieves nothing the
		// operator can see.
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", MESSAGES);

			const framework = await build(db);
			await framework.run("s1");

			const ranking = async () => {
				const result = await readNodes(db, {
					analyzerId: TURN_FRUSTRATION_DEF.id,
					filters: [],
					counts: "signal",
				});
				return result.text
					.split("\n")
					.map((l) => l.trim())
					.filter((l) => l.startsWith("putain:"))
					.map((l) => l.split(":")[0]!);
			};
			assert.deepEqual(await ranking(), ["putain"], "the term is ranked before the mute");

			await muteTerm(db, { term: "putain", by: "operator" });
			await framework.run("s1", { revise: ["config"] });
			assert.deepEqual(await ranking(), [], "a muted term is not ranked");

			await unmuteTerm(db, "putain");
			await framework.run("s1", { revise: ["config"] });
			assert.deepEqual(await ranking(), ["putain"], "unmuting puts the term back, exactly once");
		} finally {
			await close();
		}
	});

	it("keeps a muted term out of a listing across every analyzer", async () => {
		// `prospect nodes --all` reads every analyzer's nodes, so the mute has to
		// be honoured there too, or the operator sees the term in one listing and
		// not in the other.
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");
			await insertMessages(db, "s1", MESSAGES);

			const framework = await build(db);
			await framework.run("s1");
			await muteTerm(db, { term: "putain", by: "operator" });
			await framework.run("s1", { revise: ["config"] });

			const result = await readNodes(db, { all: true, filters: [] });
			const signals = result.rows
				.filter((r) => r.analyzer_id === TURN_FRUSTRATION_DEF.id)
				.map((r) => (JSON.parse(r.content_json) as { signal: string }).signal);
			assert.deepEqual(signals, [], "a muted term appears in no listing");
		} finally {
			await close();
		}
	});
});
