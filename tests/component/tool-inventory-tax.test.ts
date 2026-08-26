/**
 * Component tests for the tool-inventory-tax analyzer, exercised end-to-end
 * through the real AnalyzerFramework (issue #70). No real session data, no
 * network: hand-written synthetic rows. The analyzer never touches the LLM
 * seam; the mock LLM exists only to satisfy the framework's construction and
 * prove the analyzer stays deterministic.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	tempDb,
	insertSession,
	insertMessages,
	mockFramework,
	readAnalyzerNodes,
	expectPlainRerunIsNoOpFill,
	expectConfigChangeRevises,
	sessionProposals,
	assertProposalEvidenceTrail,
	type TestMessage,
} from "./helpers.js";
import type { AsyncDatabase } from "../../src/db/async-db.js";
import { toolInventoryTaxAnalyzer } from "../../src/analyze/analyzers/tool-inventory-tax/index.js";

const ANALYZER_ID = "tool-inventory-tax";

/** Set a session's recorded tool manifest (insertSession leaves it NULL/UNKNOWN). */
async function setInventory(
	db: AsyncDatabase,
	sessionId: string,
	tools: Array<{ name: string; definitionChars?: number | null }>,
): Promise<void> {
	await db.prepare("UPDATE sessions SET tool_inventory = ? WHERE id = ?").run(
		JSON.stringify({ source: "pi-session-header", tools: tools.map((t) => ({ name: t.name, definitionChars: t.definitionChars ?? null })) }),
		sessionId,
	);
}

/** One billed assistant turn carrying a tool call plus its usage buckets. */
function billedTurn(id: string, toolName: string, usage?: Record<string, unknown>): TestMessage[] {
	return [
		{
			id,
			role: "assistant",
			text: `calling ${toolName}`,
			stopReason: "toolUse",
			toolCalls: [{ id: `${id}-call`, name: toolName, arguments: {} }],
			usage,
		},
		{
			role: "toolResult",
			text: "ok",
			toolResults: [{ toolCallId: `${id}-call`, toolName, isError: false, textLength: 2 }],
		},
	];
}

const INVENTORY_TOOLS = [
	{ name: "read", definitionChars: 350 },
	{ name: "bash", definitionChars: 350 },
	// Two heavyweight MCP tools that the sessions below never call — a realistic
	// oversized server whose definitions dominate the prefix.
	{ name: "mcp-docs.search", definitionChars: 70_000 },
	{ name: "mcp-docs.render", definitionChars: 70_000 },
];

/** Run one session end-to-end on a fresh framework; returns the analyzer's nodes. */
async function runTaxSession(
	db: AsyncDatabase,
	sessionId: string,
	messages: TestMessage[],
	inventory: Array<{ name: string; definitionChars?: number | null }> | null,
): Promise<Array<Record<string, unknown>>> {
	await insertSession(db, sessionId);
	if (inventory !== null) await setInventory(db, sessionId, inventory);
	await insertMessages(db, sessionId, messages);
	const fw = mockFramework(db);
	await fw.register(toolInventoryTaxAnalyzer);
	const summary = await fw.run(sessionId, {});
	assert.equal(summary.errors.length, 0, `run should have no errors: ${summary.errors.join("; ")}`);
	return readAnalyzerNodes(db, ANALYZER_ID) as unknown as Array<Record<string, unknown>>;
}

/**
 * A session with per-bucket dollar costs on every billed turn:
 * turn 1 rebuilds (input=1000, cacheWrite=500, cost.input=0.001, cost.cacheWrite=0.002
 *   → blended rate 0.003/1500 = 2e-6/token),
 * turns 2..101 carry (cacheRead=200_000, cost.cacheRead=0.01 → rate 5e-8/token).
 * Unused definitions: 140_000 chars ≈ 40_000 tokens at charsPerToken 3.5,
 * so the tax clears the default $0.10 gate:
 *   rebuild: 40_000 × 2e-6 = $0.08; carry: 100 × 40_000 × 5e-8 = $0.20; total $0.28.
 */
function mixedUsageSession(): TestMessage[] {
	const msgs: TestMessage[] = [{ role: "user", text: "Fix the build." }];
	msgs.push(...billedTurn("t1", "read", {
		input: 1000, output: 20, cacheRead: 0, cacheWrite: 500, totalTokens: 1520,
		cost: { input: 0.001, output: 0.0001, cacheRead: 0, cacheWrite: 0.002, total: 0.0031 },
	}));
	for (let i = 2; i <= 101; i++) {
		msgs.push(...billedTurn(`t${i}`, i === 2 ? "bash" : "read", {
			input: 50, output: 20, cacheRead: 200_000, cacheWrite: 0, totalTokens: 200_070,
			cost: { input: 0.001, output: 0.0001, cacheRead: 0.01, cacheWrite: 0, total: 0.0111 },
		}));
	}
	return msgs;
}

interface TaxContent {
	session_id: string;
	inventory_source: string;
	available_tools: number;
	invoked_tools: number;
	unused_tools: number;
	unused_tool_names: string[];
	unsized_unused_tools: number;
	unused_definition_chars: number;
	unused_prefix_tokens: number;
	billed_turns: number;
	priced_turns: number;
	unpriced_turns: number;
	estimated_tax_usd: number | null;
	pricing_method: string;
	unused_prefix_token_turns: number;
	improvement_proposals: Array<{ title: string; severity: string; evidence: string }>;
}

// ─────────────────────────── tests ───────────────────────────

describe("tool-inventory-tax component tests", () => {
	it("prices never-called tools end-to-end, emits a proposal node, and materialises it", async () => {
		const { db, close } = await tempDb();
		try {
			const nodes = (await runTaxSession(db, "tax-e2e", mixedUsageSession(), INVENTORY_TOOLS)) as Array<{ node_kind: string; content_json: string }>;
			assert.equal(nodes.length, 1, "one node per inventoried session");

			const node = nodes[0]!;
			assert.equal(node.node_kind, "proposal", "a material tax earns a proposal node");

			const content = JSON.parse(node.content_json) as TaxContent;
			assert.equal(content.session_id, "tax-e2e");
			assert.equal(content.inventory_source, "pi-session-header");
			assert.equal(content.available_tools, 4);
			assert.equal(content.invoked_tools, 2, "read and bash were invoked");
			assert.equal(content.unused_tools, 2, "the two mcp-docs.* tools were never called");
			assert.deepEqual(content.unused_tool_names.sort(), ["mcp-docs.render", "mcp-docs.search"]);
			assert.equal(content.unused_definition_chars, 140_000);

			// Pricing math: 140_000 chars / 3.5 = 40_000 prefix tokens.
			assert.equal(content.unused_prefix_tokens, 40_000);
			// Turn 1 (rebuild): 40_000 × (0.003 / 1500) = 0.08
			// Turns 2-101 (carry): 40_000 × (0.01 / 200_000) each = 0.002 × 100 = 0.20
			// Total: 0.28
			assert.equal(content.pricing_method, "per-turn-implied-rates");
			assert.equal(content.billed_turns, 101);
			assert.equal(content.priced_turns, 101);
			assert.equal(content.unpriced_turns, 0);
			assert.equal(content.estimated_tax_usd, 0.28);
			assert.equal(content.unused_prefix_token_turns, 4_040_000);

			assert.equal(content.improvement_proposals.length, 1);
			assert.match(content.improvement_proposals[0]!.title, /never called/i);
			assert.match(content.improvement_proposals[0]!.title, /\$0\.2800/);
			assert.equal(content.improvement_proposals[0]!.severity, "waste");
			assert.ok(content.improvement_proposals[0]!.evidence.includes("mcp-docs.search"));

			// Evidence trail: the session anchor + the produces edge into the fast
			// store. The finding is about the whole session, so there are no extra
			// message anchors.
			await assertProposalEvidenceTrail(db, node.id, { exactly: 0, note: "the finding is about the whole session" });

			const proposals = await sessionProposals(db, "tax-e2e", ANALYZER_ID);
			assert.equal(proposals.length, 1, "exactly one materialised proposal");
			assert.equal(proposals[0]!.status, "open");
			assert.equal(proposals[0]!.severity, "waste");
			assert.equal(proposals[0]!.target_type, "config");
		} finally {
			await close();
		}
	});

	it("sessions using every available tool stay a clean metric with no proposals", async () => {
		const { db, close } = await tempDb();
		try {
			const msgs: TestMessage[] = [{ role: "user", text: "Do it all." }];
			msgs.push(...billedTurn("c1", "read", {
				input: 800, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 810,
				cost: { input: 0.001, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
			}));
			msgs.push(...billedTurn("c2", "edit", {
				input: 10, output: 10, cacheRead: 50_000, cacheWrite: 0, totalTokens: 50_020,
				cost: { input: 0, output: 0, cacheRead: 0.002, cacheWrite: 0, total: 0.002 },
			}));

			const nodes = (await runTaxSession(db, "tax-clean", msgs, [
				{ name: "read", definitionChars: 350 },
				{ name: "edit", definitionChars: 350 },
			])) as Array<{ node_kind: string; content_json: string }>;
			assert.equal(nodes.length, 1);
			assert.equal(nodes[0]!.node_kind, "metric", "no tax means no proposal");

			const content = JSON.parse(nodes[0]!.content_json) as TaxContent;
			assert.equal(content.available_tools, 2);
			assert.equal(content.invoked_tools, 2);
			assert.equal(content.unused_tools, 0);
			assert.equal(content.estimated_tax_usd, 0, "every tool called → zero unused prefix to price");
			assert.equal(content.improvement_proposals.length, 0);

			const proposals = await sessionProposals(db, "tax-clean", ANALYZER_ID);
			assert.equal(proposals.length, 0, "nothing materialised");
		} finally {
			await close();
		}
	});

	it("skips sessions whose inventory was never captured (UNKNOWN), never reading NULL as empty", async () => {
		const { db, close } = await tempDb();
		try {
			// inventory = null leaves sessions.tool_inventory NULL = UNKNOWN by design.
			const nodes = await runTaxSession(db, "tax-unknown", mixedUsageSession(), null);
			assert.equal(nodes.length, 0, "UNKNOWN inventory produces no unit at all");
		} finally {
			await close();
		}
	});

	it("a captured-and-empty inventory is a clean zero metric, not UNKNOWN", async () => {
		const { db, close } = await tempDb();
		try {
			const nodes = (await runTaxSession(db, "tax-empty", mixedUsageSession(), [])) as Array<{ node_kind: string; content_json: string }>;
			assert.equal(nodes.length, 1);
			assert.equal(nodes[0]!.node_kind, "metric");
			const content = JSON.parse(nodes[0]!.content_json) as TaxContent;
			assert.equal(content.available_tools, 0);
			assert.equal(content.unused_tools, 0);
			assert.equal(content.improvement_proposals.length, 0);
		} finally {
			await close();
		}
	});

	it("falls back to token-turns-only when no billed turn carries a cost breakdown, gating on the fallback threshold", async () => {
		const { db, close } = await tempDb();
		try {
			const msgs: TestMessage[] = [{ role: "user", text: "Go." }];
			for (let i = 1; i <= 300; i++) {
				msgs.push(...billedTurn(`u${i}`, "read", {
					input: 900, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 910,
				}));
			}
			const nodes = (await runTaxSession(db, "tax-unpriced", msgs, INVENTORY_TOOLS)) as Array<{ node_kind: string; content_json: string }>;
			const content = JSON.parse(nodes[0]!.content_json) as TaxContent;
			assert.equal(content.pricing_method, "token-turns-only");
			assert.equal(content.estimated_tax_usd, null, "no invented dollars");
			// Only `read` is invoked here, so bash is unused too: 140_350 chars ≈ 40_100 tokens.
			assert.equal(content.unpriced_turns, 300);
			// 40_100 tokens × 300 billed turns = 12_030_000 token-turns ≥ 100_000 fallback gate.
			assert.equal(content.unused_prefix_token_turns, 12_030_000);
			assert.equal(nodes[0]!.node_kind, "proposal", "large unpriced tax still earns a proposal via the fallback gate");
		} finally {
			await close();
		}
	});

	it("re-running the same recipe is idempotent: no new nodes, keys unchanged", async () => {
		const { db, close } = await tempDb();
		try {
			await expectPlainRerunIsNoOpFill(db, toolInventoryTaxAnalyzer, "tax-idem", mixedUsageSession(), {
				prepareSession: (d) => setInventory(d, "tax-idem", INVENTORY_TOOLS),
			});
		} finally {
			await close();
		}
	});

	it("changing config marks nodes stale for the `config` reason and revises beside them", async () => {
		const { db, close } = await tempDb();
		try {
			// Raising the materiality gate above this session's $0.28 tax changes
			// the resolved config fingerprint → stale for the `config` reason; the
			// revise run recomputes beside its predecessor as a clean metric.
			const { after } = await expectConfigChangeRevises(db, toolInventoryTaxAnalyzer, "tax-config", mixedUsageSession(), { materialTaxUsd: 10 }, {
				prepareSession: (d) => setInventory(d, "tax-config", INVENTORY_TOOLS),
			});

			assert.deepEqual(
				after.map((n) => n.node_kind).sort(),
				["metric", "proposal"],
				"old proposal preserved as lineage beside the immaterial revision",
			);
		} finally {
			await close();
		}
	});
});
