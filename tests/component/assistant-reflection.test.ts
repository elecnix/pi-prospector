/**
 * Component test for the `assistant-reflection` custom analyzer (loaded from
 * .prospector/analyzers/ on disk). Seeds a multi-turn session with thinking
 * traces and assistant responses that exercise all four signal types —
 * memories, mistakes, user frustration, user acceptance — then runs the
 * analyzer with a scripted mock LLM and asserts the graph, anchoring, the
 * consumes edge, and idempotent re-runs.
 *
 * Real SQLite (temp file), hand-written synthetic messages, mock LLM keyed on
 * the thinking/response text. No network, no API key.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as url from "node:url";
import { tempDb, insertSession, insertMessages, type TempDb } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM, type MockLLMReply } from "../../src/analyze/mock-llm.js";
import { registerAll } from "../../src/analyze/defaults.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import { turnPairCoreAnalyzer } from "../../src/analyze/analyzers/turn-pair-core/index.js";
import type { LLMRequest } from "../../src/analyze/types.js";
import type { AssistantReflectionProperties } from "../../.prospector/analyzers/assistant-reflection.analyzer.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ANALYZER_DIR = path.resolve(__dirname, "..", "..", ".prospector", "analyzers");

/** Scripted mock keyed on the thinking text. */
function responder(req: LLMRequest): MockLLMReply {
	const schemaName = req.responseSchema?.name ?? req.tool?.name ?? "";
	if (schemaName !== "classify_reflection" && schemaName !== "classify_reflection_retry") return { text: "{}" };
	const thinkingText = extractThinkingText(req.user);
	const base = { memories: [], mistakes: [], user_frustration: [], user_acceptance: [] };

	if (thinkingText.toLowerCase().includes("the user prefers tabs")) {
		return {
			text: "ok",
			structured: {
				...base,
				memories: [{ candidate_text: "User prefers tabs over spaces", scope: "global", confidence: 0.85, rationale: "noticed in thinking" }],
			},
		};
	}
	if (thinkingText.toLowerCase().includes("i should have known that")) {
		return {
			text: "ok",
			structured: {
				...base,
				mistakes: [{ quote: "I should have known that", severity: "large", rationale: "missed an obvious instruction" }],
				memories: [{ candidate_text: "Always check existing instructions before guessing", scope: "global", confidence: 0.7, rationale: "lesson from mistake" }],
			},
		};
	}
	if (thinkingText.toLowerCase().includes("the user seems frustrated")) {
		return {
			text: "ok",
			structured: {
				...base,
				user_frustration: [{ level: "moderate", rationale: "user seems frustrated with repeated clarifications" }],
			},
		};
	}
	if (thinkingText.toLowerCase().includes("the user is happy")) {
		return {
			text: "ok",
			structured: {
				...base,
				user_acceptance: [{ level: "high", rationale: "user is happy with the result" }],
			},
		};
	}
	if (thinkingText.toLowerCase().includes("this project uses vitest")) {
		return {
			text: "ok",
			structured: {
				...base,
				memories: [{ candidate_text: "Project uses vitest as test runner", scope: "project", confidence: 0.9, rationale: "convention observed in thinking" }],
			},
		};
	}
	return { text: "ok", structured: base };
}

function extractThinkingText(prompt: string): string {
	const marker = "THINKING:";
	const idx = prompt.indexOf(marker);
	return idx < 0 ? "" : prompt.slice(idx + marker.length).trim();
}

interface ReflectionNode {
	user_message_id: string;
	memories: Array<{ candidate_text: string; scope: string; confidence: number }>;
	mistakes: Array<{ quote: string; severity: string }>;
	user_frustration: Array<{ level: string }>;
	user_acceptance: Array<{ level: string }>;
}

describe("assistant-reflection custom analyzer", () => {
	it("classifies thinking traces into memories, mistakes, frustration, acceptance", async () => {
		const t: TempDb = tempDb();
		try {
			const sid = "s1";
			insertSession(t.db, sid);
			insertMessages(t.db, sid, [
				{ id: "u0", role: "user", text: "Fix the login bug." },
				{ id: "a0", role: "assistant", text: "Looking at the login code.", thinking: "I notice the user prefers tabs over spaces in the config." },
				{ id: "u1", role: "user", text: "That didn't work." },
				{ id: "a1", role: "assistant", text: "Sorry, let me fix that.", thinking: "I should have known that the auth module needs the env var first." },
				{ id: "u2", role: "user", text: "Why isn't this working yet?" },
				{ id: "a2", role: "assistant", text: "Let me investigate.", thinking: "The user seems frustrated with the slow progress." },
				{ id: "u3", role: "user", text: "Great, that fixed it!" },
				{ id: "a3", role: "assistant", text: "Glad it works.", thinking: "The user is happy with the result." },
				{ id: "u4", role: "user", text: "Now add tests." },
				{ id: "a4", role: "assistant", text: "Adding tests.", thinking: "This project uses vitest, so I'll use that." },
			]);

			const mock = createMockLLM({ responder, tokensPerCall: 10, costPerCall: 0.0001 });
			const fw = new AnalyzerFramework({ db: t.db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
			const { customRegistered, errors } = await registerAll(fw, { builtins: [turnPairCoreAnalyzer], paths: [ANALYZER_DIR] });
			assert.deepEqual(errors, [], JSON.stringify(errors));
			assert.ok(customRegistered.includes("assistant-reflection"));

			const summary = await fw.run(sid, { analyzerIds: ["assistant-reflection"] });
			assert.equal(summary.errors.length, 0, summary.errors.join("; "));
			assert.ok(summary.nodesProduced > 0);

			const rows = t.db
				.prepare("SELECT content_json, node_kind FROM analysis_nodes WHERE analyzer_id = 'assistant-reflection' ORDER BY created_at")
				.all() as Array<{ content_json: string; node_kind: string }>;
			// 5 turns have thinking text, all should be classified
			assert.ok(rows.length >= 5, `expected ≥5 reflection nodes, got ${rows.length}`);
			for (const r of rows) assert.equal(r.node_kind, "classification");

			const byMsg = new Map(rows.map((r) => [((JSON.parse(r.content_json)) as ReflectionNode).user_message_id, JSON.parse(r.content_json) as ReflectionNode]));

			// Turn 0: memory about tabs
			const n0 = byMsg.get("u0");
			assert.ok(n0, "node for u0");
			assert.equal(n0!.memories.length, 1);
			assert.equal(n0!.memories[0]!.scope, "global");
			assert.equal(n0!.memories[0]!.candidate_text, "User prefers tabs over spaces");

			// Turn 1: mistake + memory (lesson from mistake)
			const n1 = byMsg.get("u1");
			assert.ok(n1, "node for u1");
			assert.equal(n1!.mistakes.length, 1);
			assert.equal(n1!.mistakes[0]!.severity, "large");
			assert.equal(n1!.mistakes[0]!.quote, "I should have known that");
			assert.equal(n1!.memories.length, 1);

			// Turn 2: user frustration
			const n2 = byMsg.get("u2");
			assert.ok(n2, "node for u2");
			assert.equal(n2!.user_frustration.length, 1);
			assert.equal(n2!.user_frustration[0]!.level, "moderate");

			// Turn 3: user acceptance
			const n3 = byMsg.get("u3");
			assert.ok(n3, "node for u3");
			assert.equal(n3!.user_acceptance.length, 1);
			assert.equal(n3!.user_acceptance[0]!.level, "high");

			// Turn 4: project-scoped memory
			const n4 = byMsg.get("u4");
			assert.ok(n4, "node for u4");
			assert.equal(n4!.memories.length, 1);
			assert.equal(n4!.memories[0]!.scope, "project");
			assert.equal(n4!.memories[0]!.candidate_text, "Project uses vitest as test runner");

			// ── edges: anchors, consumes, uses_prompt ──
			const anchors = (t.db.prepare("SELECT COUNT(*) AS c FROM analysis_edges e JOIN analysis_nodes n ON e.from_node_id=n.id WHERE n.analyzer_id='assistant-reflection' AND e.edge_kind='anchors'").get() as { c: number }).c;
			assert.equal(anchors, rows.length);

			const consumes = (t.db.prepare("SELECT COUNT(*) AS c FROM analysis_edges e JOIN analysis_nodes n ON e.from_node_id=n.id WHERE n.analyzer_id='assistant-reflection' AND e.edge_kind='consumes'").get() as { c: number }).c;
			assert.ok(consumes >= 5, `expected ≥5 consumes, got ${consumes}`);

			const usesPrompt = (t.db.prepare("SELECT COUNT(*) AS c FROM analysis_edges e JOIN analysis_nodes n ON e.from_node_id=n.id WHERE n.analyzer_id='assistant-reflection' AND e.edge_kind='uses_prompt'").get() as { c: number }).c;
			assert.equal(usesPrompt, rows.length);

			// ── idempotent re-run ──
			const fw2 = new AnalyzerFramework({ db: t.db, llm: createMockLLM({ responder }).caller, modelTiers: DEFAULT_MODEL_TIERS });
			await registerAll(fw2, { builtins: [turnPairCoreAnalyzer], paths: [ANALYZER_DIR] });
			const summary2 = await fw2.run(sid, { analyzerIds: ["assistant-reflection"] });
			assert.equal(summary2.errors.length, 0, summary2.errors.join("; "));
			assert.equal(summary2.nodesProduced, 0, "re-run should produce no new nodes");

			// row count unchanged
			const rows2 = t.db
				.prepare("SELECT COUNT(*) AS c FROM analysis_nodes WHERE analyzer_id = 'assistant-reflection'")
				.get() as { c: number };
			assert.equal(rows2.c, rows.length);
		} finally {
			t.close();
		}
	});

	it("skips turns with no thinking or assistant text", async () => {
		const t: TempDb = tempDb();
		try {
			const sid = "s2";
			insertSession(t.db, sid);
			insertMessages(t.db, sid, [
				{ id: "u0", role: "user", text: "Hello." },
				{ id: "u1", role: "user", text: "Are you there?" },
			]);

			const mock = createMockLLM({ responder, tokensPerCall: 10, costPerCall: 0.0001 });
			const fw = new AnalyzerFramework({ db: t.db, llm: mock.caller, modelTiers: DEFAULT_MODEL_TIERS });
			const { errors } = await registerAll(fw, { builtins: [turnPairCoreAnalyzer], paths: [ANALYZER_DIR] });
			assert.deepEqual(errors, [], JSON.stringify(errors));

			const summary = await fw.run(sid, { analyzerIds: ["assistant-reflection"] });
			assert.equal(summary.errors.length, 0);

			const rows = t.db
				.prepare("SELECT COUNT(*) AS c FROM analysis_nodes WHERE analyzer_id = 'assistant-reflection'")
				.get() as { c: number };
			assert.equal(rows.c, 0, "no thinking/assistant text → no nodes");
		} finally {
			t.close();
		}
	});
});