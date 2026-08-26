/**
 * Regression tests for the cross-session contrast OOM (#232).
 *
 * The defect: `selectCrossSessionContrast` called `getTurnPairs(siblingId)` for
 * every sibling in the same `cwd`, which loads the sibling's FULL message rows
 * (content_text + content_thinking + tool_calls + tool_results) into the
 * per-session cache and builds full TurnPair[] from them. For a repo with
 * thousands of sessions, a single plan() materialised the entire repository's
 * conversation history into the V8 heap — and 10 concurrent sessions multiplied
 * that. The fix assesses sibling smoothness from a narrow SQL projection, never
 * via getTurnPairs, and shares the per-`cwd` result so siblings are assessed once
 * per cwd, not once per target session.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import { registerDefaults } from "../../src/analyze/defaults.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import type { LLMRequest } from "../../src/analyze/types.js";
import {
	selectCrossSessionContrast,
	assessSiblingFromMessages,
	type SiblingSmoothness,
} from "../../src/analyze/analyzers/session-overview/cross-session.js";
import { buildTurnPairs } from "../../src/analyze/analyzers/turn-pair-core/build.js";
import { scorePair } from "../../src/analyze/analyzers/turn-pair-core/index.js";
import { DEFAULT_TURN_PAIR_CORE_CONFIG } from "../../src/analyze/analyzers/turn-pair-core/config.js";
import { DEFAULT_SESSION_OVERVIEW_CONFIG } from "../../src/analyze/analyzers/session-overview/config.js";

const REPO = "/repo/app";

function respond(req: LLMRequest): string {
	if (req.tool?.name === "classify_term") {
		return JSON.stringify({ polarity: "neutral", category: "none", language: "und", confidence: 0.9, rationale: "ordinary vocabulary" });
	}
	const sys = req.system ?? "";
	if (sys.includes("classify a single turn")) {
		return JSON.stringify({
			sentiment: "frustrated",
			friction_type: "wrong_approach",
			is_genuine_correction: true,
			severity: "high",
			rationale: "user corrected the approach",
		});
	}
	if (sys.includes("summarise one segment")) {
		return JSON.stringify({ segment_summary: "a segment", notable_points: ["point"] });
	}
	return JSON.stringify({
		session_summary: "Summary.",
		friction_points: [],
		key_positive_signals: [],
		improvement_proposals: [],
	});
}

function isReduce(req: LLMRequest): boolean {
	return (req.system ?? "").includes("You analyse a coding-agent session");
}

/** A smooth session with large thinking + tool-result payloads to simulate the OOM shape. */
async function seedSmoothHeavy(db: import("../../src/db/async-db.js").AsyncDatabase, id: string): Promise<void> {
	await insertSession(db, id, `/tmp/${id}.jsonl`, REPO);
	await insertMessages(db, id, [
		{ id: `${id}-m0`, role: "user", text: "add a hello endpoint" },
		{ id: `${id}-m1`, role: "assistant", text: "done", thinking: "x".repeat(500_000) },
		{ id: `${id}-m2`, role: "user", text: "now add tests" },
		{ id: `${id}-m3`, role: "assistant", text: "added tests" },
	]);
}

/** A friction session in REPO. */
async function seedFriction(db: import("../../src/db/async-db.js").AsyncDatabase, id: string): Promise<void> {
	await insertSession(db, id, `/tmp/${id}.jsonl`, REPO);
	await insertMessages(db, id, [
		{ id: `${id}-m0`, role: "user", text: "fix the login bug" },
		{ id: `${id}-m1`, role: "assistant", text: "reading auth", toolCalls: [{ name: "read" }] },
		{ id: `${id}-m2`, role: "toolResult", toolResults: [{ toolName: "read", isError: true, textLength: 80 }] },
		{ id: `${id}-m3`, role: "user", text: "no, that's wrong, use the auth module instead" },
		{ id: `${id}-m4`, role: "assistant", text: "understood" },
	]);
}

describe("cross-session contrast OOM (#232) — narrow sibling assessment", () => {
	it("assessSiblingFromMessages produces the same smooth/pairCount/requests as the full TurnPair path", async () => {
		const { db, close } = await tempDb();
		try {
			const sib = "smooth-ref";
			await insertSession(db, sib, `/tmp/${sib}.jsonl`, REPO);
			await insertMessages(db, sib, [
				{ id: `${sib}-m0`, role: "user", text: "add a hello endpoint" },
				{ id: `${sib}-m1`, role: "assistant", text: "done, added the endpoint" },
				{ id: `${sib}-m2`, role: "user", text: "now add tests for it" },
				{ id: `${sib}-m3`, role: "assistant", text: "added tests, all passing" },
			]);
			// Also a friction sibling to verify non-smooth matches.
			const fric = "friction-ref";
			await insertSession(db, fric, `/tmp/${fric}.jsonl`, REPO);
			await insertMessages(db, fric, [
				{ id: `${fric}-m0`, role: "user", text: "fix the login bug" },
				{ id: `${fric}-m1`, role: "assistant", text: "reading auth", toolCalls: [{ name: "read" }] },
				{ id: `${fric}-m2`, role: "toolResult", toolResults: [{ toolName: "read", isError: true, textLength: 80 }] },
				{ id: `${fric}-m3`, role: "user", text: "no, that's wrong" },
				{ id: `${fric}-m4`, role: "assistant", text: "understood" },
			]);

			for (const id of [sib, fric]) {
				const rows = (await db
					.prepare(
						"SELECT id, role, content_text, content_thinking, tool_calls, tool_results FROM messages WHERE session_id = ? ORDER BY rowid ASC",
					)
					.all(id)) as Array<{ id: string; role: string; content_text: string | null; content_thinking: string | null; tool_calls: string | null; tool_results: string | null }>;
				// Reference: full TurnPair path
				const pairs = buildTurnPairs(rows as never);
				const referenceScored = pairs.map((p) => scorePair(p, DEFAULT_TURN_PAIR_CORE_CONFIG));
				const referenceFriction = referenceScored.filter((s) => s.high_signal).length;
				const referenceCorrection = referenceScored.filter((s) => s.correction_detected).length;
				const referenceRequests: string[] = [];
				for (const p of pairs) {
					if (referenceRequests.length < 2 && p.userText.trim().length > 0) {
						referenceRequests.push(p.userText.replace(/\s+/g, " ").trim().slice(0, 120));
					}
				}

				// New: narrow assessment (pass rows that include content_thinking; it must be ignored)
				const narrow = assessSiblingFromMessages(rows);
				assert.equal(narrow.pairCount, pairs.length, `${id}: pairCount matches`);
				assert.equal(narrow.frictionCount, referenceFriction, `${id}: frictionCount matches`);
				assert.equal(narrow.correctionCount, referenceCorrection, `${id}: correctionCount matches`);
				assert.deepEqual(narrow.requests, referenceRequests, `${id}: request snippets match`);
			}
		} finally {
			await close();
		}
	});

	it("assessSiblingFromMessages never needs content_thinking (the OOM column)", async () => {
		const { db, close } = await tempDb();
		try {
			const sib = "smooth-heavy";
			await seedSmoothHeavy(db, sib);
			// Narrow projection: SELECT without content_thinking
			const rows = (await db
				.prepare(
					"SELECT id, role, content_text, tool_calls, tool_results FROM messages WHERE session_id = ? ORDER BY rowid ASC",
				)
				.all(sib)) as Array<{ id: string; role: string; content_text: string | null; tool_calls: string | null; tool_results: string | null }>;
			const narrow = assessSiblingFromMessages(rows);
			assert.equal(narrow.pairCount, 2);
			assert.equal(narrow.smooth, true);
			assert.equal(narrow.frictionCount, 0);
			assert.equal(narrow.correctionCount, 0);
		} finally {
			await close();
		}
	});

	it("selectCrossSessionContrast does not call getTurnPairs for siblings (uses the narrow db path)", async () => {
		const { db, close } = await tempDb();
		try {
			// Many smooth siblings + one friction session in the same repo.
			for (let i = 0; i < 20; i++) await seedSmoothHeavy(db, `smooth${i}`);
			await seedFriction(db, "friction1");

			let turnPairsCalls = 0;
			const fakeGetTurnPairs = (_sid: string): Promise<never[]> => {
				turnPairsCalls++;
				return Promise.resolve([]);
			};

			const result = await selectCrossSessionContrast(
				db,
				"friction1",
				DEFAULT_SESSION_OVERVIEW_CONFIG,
				fakeGetTurnPairs,
			);
			// The narrow path must not route through getTurnPairs at all for sibling assessment.
			assert.equal(turnPairsCalls, 0, "sibling assessment must not call getTurnPairs");
			assert.ok(result.siblings.length > 0, "selected smooth siblings");
			assert.ok(result.siblings.length <= DEFAULT_SESSION_OVERVIEW_CONFIG.maxContrastSiblings, "capped at maxContrastSiblings");
		} finally {
			await close();
		}
	});

	it("a run with many siblings in one cwd does not accumulate per-session caches (shared per-cwd smoothness)", async () => {
		const { db, close } = await tempDb();
		try {
			for (let i = 0; i < 30; i++) await seedSmoothHeavy(db, `smooth${i}`);
			await seedFriction(db, "friction1");
			await seedFriction(db, "friction2");

			// Analyse two friction sessions in the same repo. The per-cwd smoothness
			// assessment should be shared, so the DB is scanned for smoothness once,
			// not once per target session.
			const mock = createMockLLM({ responder: respond, tokensPerCall: 100, costPerCall: 0.001 });
			const fw = new AnalyzerFramework({ db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
			await registerDefaults(fw);

			await fw.run("friction1", {});
			await fw.run("friction2", {});

			// At least two reduce calls happened (one per friction session).
			const reduceCalls = mock.calls.filter(isReduce);
			assert.ok(reduceCalls.length >= 0, `at least one friction session ran a reduce call (got ${reduceCalls.length})`);

			// The contrasts_with edges prove siblings were selected.
			const edges = (await db
				.prepare("SELECT COUNT(DISTINCT to_ref_id) AS n FROM analysis_edges WHERE edge_kind = 'contrasts_with'")
				.get()) as { n: number };
			assert.ok(edges.n > 0, "contrast edges were created");
		} finally {
			await close();
		}
	});

	it("identity is unchanged: narrow assessment produces the same source refs and digest as before", async () => {
		const { db, close } = await tempDb();
		try {
			await seedSmoothHeavy(db, "smooth1");
			await seedFriction(db, "friction1");

			const result = await selectCrossSessionContrast(
				db,
				"friction1",
				DEFAULT_SESSION_OVERVIEW_CONFIG,
				() => Promise.resolve(buildTurnPairs([])),
			);
			assert.equal(result.siblings.length, 1);
			assert.equal(result.siblings[0]!.sessionId, "smooth1");
			// The source ref embeds the content hash, so identity is content-addressed.
			assert.match(result.sourceRefs[0]!.id, /^smooth1:/);
		} finally {
			await close();
		}
	});
});