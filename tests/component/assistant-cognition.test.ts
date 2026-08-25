/**
 * Component tests for the assistant-cognition analyzer, exercised end-to-end
 * through the analyzer framework over real SQLite with synthetic fixtures and a
 * mock LLM. No network, no API keys, no real session data.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import { registerDefaults } from "../../src/analyze/defaults.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import { ASSISTANT_COGNITION_DEF } from "../../src/analyze/analyzers/assistant-cognition/index.js";
import type { AnalysisNodeRow } from "../../src/analyze/types.js";

const THINKING = "The user wants me to add a parser. Hmm, that's odd — the schema has no id field. Let me look again.";
const RESPONSE = "Looking at the schema now. Actually, let's go back to approach A.";

/** Structured cognition payload mixing one valid and one invalid surprise quote. */
function cognitionStructured() {
	return {
		structured: {
			confusion: [{ level: "moderate", rationale: "re-reading the same schema without progress" }],
			indecision: [{ level: "high", rationale: "switched back to approach A mid-turn" }],
			surprise: [
				{ quote: "Hmm, that's odd", severity: "mild", rationale: "verbatim in thinking trace" },
				{ quote: "the schema lacks an identifier entirely", severity: "high", rationale: "fabricated, not verbatim" },
			],
		},
	};
}

function makeResponder(cognitionReplies?: () => object) {
	return (req: { tool?: { name?: string }; system?: string }): object => {
		if (req.tool?.name === "record_cognition") {
			return cognitionReplies ? cognitionReplies() : cognitionStructured();
		}
		if (req.tool?.name === "classify_term") {
			return { structured: { polarity: "neutral", category: "none", language: "und", confidence: 0.9, rationale: "ordinary vocabulary" } };
		}
		const sys = req.system ?? "";
		if (sys.includes("classify a single turn")) {
			return { text: JSON.stringify({ sentiment: "neutral", friction_type: "none", is_genuine_correction: false, severity: "low", rationale: "ordinary turn" }) };
		}
		if (sys.includes("summarise one segment")) {
			return { text: JSON.stringify({ segment_summary: "s", notable_points: ["p"] }) };
		}
		return {
			text: JSON.stringify({
				session_summary: "session went fine.",
				friction_points: [],
				key_positive_signals: [],
				improvement_proposals: [],
			}),
		};
	};
}

async function cognitionNodes(db: Awaited<ReturnType<typeof tempDb>>["db"], sessionId: string): Promise<AnalysisNodeRow[]> {
	const rows = await db.prepare(
		"SELECT * FROM analysis_nodes WHERE analyzer_id = ? AND session_id = ? AND node_kind = 'classification'",
	).all(ASSISTANT_COGNITION_DEF.id, sessionId) as unknown as AnalysisNodeRow[];
	return rows;
}

async function seedThinkingTurn(db: Awaited<ReturnType<typeof tempDb>>["db"], sessionId: string, opts: { thinking?: string; response?: string; secondTurnWithoutThinking?: boolean } = {}): Promise<string> {
	await insertSession(db, sessionId);
	const messages: Parameters<typeof insertMessages>[2] = [
		{ id: `${sessionId}-u`, role: "user", text: "add a parser for the config schema please" },
		{ id: `${sessionId}-a`, role: "assistant", text: opts.response ?? RESPONSE, thinking: opts.thinking ?? THINKING },
	];
	if (opts.secondTurnWithoutThinking) {
		messages.push({ id: `${sessionId}-u2`, role: "user", text: "now also update the docs" });
		messages.push({ id: `${sessionId}-a2`, role: "assistant", text: "docs updated." });
	}
	await insertMessages(db, sessionId, messages);
	return `${sessionId}-u`;
}

describe("assistant-cognition (component)", () => {
	it("emits one classification node per gated turn with validated signals and evidence edges", async () => {
		const { db, close } = await tempDb();
		try {
			const userId = await seedThinkingTurn(db, "cog1");
			const mock = createMockLLM({ responder: makeResponder(), tokensPerCall: 100, costPerCall: 0.001 });
			const fw = new AnalyzerFramework({ db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
			await registerDefaults(fw);
			const summary = await fw.run("cog1", {});
			assert.equal(summary.errors.length, 0, summary.errors.join("; "));

			const nodes = await cognitionNodes(db, "cog1");
			assert.equal(nodes.length, 1, "one cognition node for the one thinking-bearing turn");
			const props = JSON.parse(nodes[0]!.content_json) as Record<string, unknown>;
			assert.deepEqual(props.user_message_id, userId);

			// Confusion and indecision carry grades and rationales.
			assert.deepEqual((props.confusion as Array<{ level: string }>).map((e) => e.level), ["moderate"]);
			assert.deepEqual((props.indecision as Array<{ level: string }>).map((e) => e.level), ["high"]);
			// Quote validation: only the verbatim quote survives; the fabricated one is dropped.
			const surprises = props.surprise as Array<{ quote: string; severity: string }>;
			assert.equal(surprises.length, 1);
			assert.equal(surprises[0]!.quote, "Hmm, that's odd");
			assert.equal(surprises[0]!.severity, "mild");

			// Anchored to the user message, consumes the core metric node, uses its prompt.
			const edges = await db.prepare(
				"SELECT e.edge_kind, e.to_ref_kind, e.to_ref_id FROM analysis_edges e JOIN analysis_nodes n ON e.from_node_id = n.id WHERE n.analyzer_id = ?",
			).all(ASSISTANT_COGNITION_DEF.id) as Array<{ edge_kind: string; to_ref_kind: string; to_ref_id: string }>;
			assert.ok(edges.some((e) => e.edge_kind === "anchors" && e.to_ref_kind === "message" && e.to_ref_id === userId), "anchors to user message");
			assert.ok(edges.some((e) => e.edge_kind === "consumes" && e.to_ref_kind === "analysis_node"), "consumes the turn-pair-core node");
			assert.ok(edges.some((e) => e.edge_kind === "uses_prompt"), "uses_prompt recorded");
		} finally {
			await close();
		}
	});

	it("gates on minimum thinking length: turns without substantive thinking are never planned", async () => {
		const { db, close } = await tempDb();
		try {
			await seedThinkingTurn(db, "cog2", { secondTurnWithoutThinking: true });
			const mock = createMockLLM({ responder: makeResponder(), tokensPerCall: 10, costPerCall: 0.0001 });
			const fw = new AnalyzerFramework({ db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
			await registerDefaults(fw);
			const summary = await fw.run("cog2", {});
			assert.equal(summary.errors.length, 0, summary.errors.join("; "));

			const cognitionCalls = mock.calls.filter((c) => c.tool?.name === "record_cognition");
			assert.equal(cognitionCalls.length, 1, "only the thinking-bearing turn reaches the model");
			// The separately labeled inputs reach the prompt.
			assert.ok(cognitionCalls[0]!.user.includes("THINKING TRACE:"));
			assert.ok(cognitionCalls[0]!.user.includes("RESPONSE TEXT:"));
		} finally {
			await close();
		}
	});

	it("is idempotent: a second identical run produces no new cognition nodes", async () => {
		const { db, close } = await tempDb();
		try {
			await seedThinkingTurn(db, "cog3");
			const mock = createMockLLM({ responder: makeResponder(), tokensPerCall: 10, costPerCall: 0.0001 });
			const fw = new AnalyzerFramework({ db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
			await registerDefaults(fw);
			await fw.run("cog3", {});
			const first = (await db.prepare("SELECT COUNT(*) AS c FROM analysis_nodes WHERE analyzer_id = ?").get(ASSISTANT_COGNITION_DEF.id) as { c: number }).c;

			const cognitionCallsBefore = mock.calls.filter((c) => c.tool?.name === "record_cognition").length;
			const summary = await fw.run("cog3", {});
			const second = (await db.prepare("SELECT COUNT(*) AS c FROM analysis_nodes WHERE analyzer_id = ?").get(ASSISTANT_COGNITION_DEF.id) as { c: number }).c;
			assert.equal(first, second, "re-running the same recipe adds no nodes");
			assert.equal(mock.calls.filter((c) => c.tool?.name === "record_cognition").length - cognitionCallsBefore, 0, "no new model calls");
			const cogResult = summary.analyzerResults.find((r) => r.analyzerId === ASSISTANT_COGNITION_DEF.id);
			assert.ok(cogResult, "cognition run result present");
			assert.ok((cogResult!.nodesSkipped ?? 0) >= 1, "the existing node was skipped as current");
		} finally {
			await close();
		}
	});

	it("retries once after an unparseable response, then succeeds", async () => {
		const { db, close } = await tempDb();
		try {
			await seedThinkingTurn(db, "cog4");
			let cognitionCalls = 0;
			const mock = createMockLLM({
				responder: (req: { tool?: { name?: string }; system?: string }) => {
					if (req.tool?.name === "record_cognition") {
						cognitionCalls++;
						if (cognitionCalls === 1) return "I will not call the tool.";
						return cognitionStructured();
					}
					return makeResponder()(req);
				},
				tokensPerCall: 10,
				costPerCall: 0.0001,
			});
			const fw = new AnalyzerFramework({ db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
			await registerDefaults(fw);
			const summary = await fw.run("cog4", {});
			assert.equal(summary.errors.length, 0, summary.errors.join("; "));
			assert.ok(cognitionCalls >= 2, "a second attempt was made");

			const nodes = await cognitionNodes(db, "cog4");
			assert.equal(nodes.length, 1, "the retry still produces exactly one node");
			const props = JSON.parse(nodes[0]!.content_json) as { confusion: unknown[] };
			assert.equal(props.confusion.length, 1, "content came from the successful retry");
		} finally {
			await close();
		}
	});

	it("abstains cleanly after two unparseable responses: empty arrays, no error node", async () => {
		const { db, close } = await tempDb();
		try {
			await seedThinkingTurn(db, "cog5");
			const mock = createMockLLM({
				responder: (req: { tool?: { name?: string }; system?: string }) => {
					if (req.tool?.name === "record_cognition") return "No comment.";
					return makeResponder()(req);
				},
				tokensPerCall: 10,
				costPerCall: 0.0001,
			});
			const fw = new AnalyzerFramework({ db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
			await registerDefaults(fw);
			const summary = await fw.run("cog5", {});
			assert.equal(summary.errors.length, 0, summary.errors.join("; "));

			const nodes = await cognitionNodes(db, "cog5");
			assert.equal(nodes.length, 1, "an abstention is still a valid classification node");
			const props = JSON.parse(nodes[0]!.content_json) as { confusion: unknown[]; indecision: unknown[]; surprise: unknown[] };
			assert.deepEqual(props.confusion, []);
			assert.deepEqual(props.indecision, []);
			assert.deepEqual(props.surprise, []);

			const errorNodes = (await db.prepare("SELECT COUNT(*) AS c FROM analysis_nodes WHERE analyzer_id = ? AND node_kind = 'error'").get(ASSISTANT_COGNITION_DEF.id) as { c: number }).c;
			assert.equal(errorNodes, 0, "no error node recorded for an abstention");
		} finally {
			await close();
		}
	});
});
