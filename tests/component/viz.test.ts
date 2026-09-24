/**
 * Component tests for `prospect viz` — the interactive HTML session render.
 *
 * The fixture DB is hand-written synthetic rows (no real session data): one
 * session, a few messages, nodes across three analyzers covering every node
 * kind, all seven relationship edge kinds the page must draw, a revises pair,
 * a retracted node, proposals with decisions grouped under one remediation.
 *
 * The contract under test:
 *   - the artifact embeds graph JSON that faithfully reflects nodes/kinds/edges;
 *   - a proposal's click-through lands on messages whose text appears verbatim;
 *   - rendering writes nothing to the DB and re-renders byte-identically;
 *   - retracted filtering and lineage collapse exist in the emitted structure;
 *   - the slash command works end-to-end through the extension registration.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type AsyncDatabase } from "../../src/db/async-db.js";
import {
	tempDb,
	insertSession,
	insertMessages,
	insertProposalRow,
	FIXTURES,
} from "./helpers.js";
import { insertEdge } from "../../src/db/analysis-queries.js";
import { EDGE_KINDS, REF_KINDS } from "../../src/analyze/edge-kinds.js";
import { assertionId, upsertAssertion } from "../../src/db/assertions.js";

// ───────────────────────── fixture constants ─────────────────────────

const SESS = "viz-fixture-session-0001";
const MSG_U1 = "viz-msg-u1";
const MSG_A1 = "viz-msg-a1";
const MSG_U2 = "viz-msg-u2";
const U1_TEXT = "Please deploy the staging service and tail its logs.";
const U2_TEXT = "That deploy failed again — fix the retry logic.";

const N_CORE = "viz-node-core-1";
const N_CLS_V1 = "viz-node-cls-v1";
const N_CLS_V2 = "viz-node-cls-v2";
const N_SUMMARY = "viz-node-summary-1";
const N_ERROR_RETRACTED = "viz-node-error-retracted";

const OK_CORE = "ok-core-0001";
const OK_CLS_V1 = "ok-cls-v1-0001";
const OK_CLS_V2 = "ok-cls-v2-0001";
const OK_SUMMARY = "ok-summary-0001";

const PROMPT_HASH = "aaaa1111bbbb2222";
const CONFIG_ID = "config-row-cccc3333";
const REMEDIATION_ID = "rem-fix-deploy-retries";
const P1_INPUT_KEY = "ik-proposal-one";
const P2_INPUT_KEY = "ik-proposal-two";

async function insertFixtureNode(
	db: AsyncDatabase,
	over: {
		id: string;
		analyzerId: string;
		version: string;
		nodeKind: string;
		contentJson: string;
		outputKey: string;
		inputKey?: string;
		createdAt?: string;
		retractedAt?: string | null;
	},
): Promise<void> {
	await db.prepare(
		"INSERT INTO analysis_nodes (id, session_id, analyzer_id, analyzer_version_id, config_id, node_kind, content_json, source_set_hash, input_key, output_key, created_at, retracted_at) " +
			"VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	).run(
		over.id,
		SESS,
		over.analyzerId,
		over.version,
		CONFIG_ID,
		over.nodeKind,
		over.contentJson,
		`sourceset-${over.id}`,
		over.inputKey ?? `ik-${over.id}`,
		over.outputKey,
		over.createdAt ?? new Date(1_700_000_100_000).toISOString(),
		over.retractedAt ?? null,
	);
}

/** Build the synthetic fixture DB. Returns the db (caller closes via tempDb cleanup). */
async function buildFixtureDb(): Promise<{ db: AsyncDatabase; close: () => Promise<void>; dbPath: string }> {
	const dbPath = path.join(os.tmpdir(), `prospect-viz-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
	const { db, close } = await tempDb(dbPath);

	await insertSession(db, SESS, `/tmp/${SESS}.jsonl`, "/home/tester/proj");
	await db.prepare("UPDATE sessions SET name = ?, started_at = ? WHERE id = ?")
		.run("Viz Fixture Session", new Date(1_700_000_000_000).toISOString(), SESS);

	const msgIds = await insertMessages(db, SESS, [
		{ id: MSG_U1, role: "user", text: U1_TEXT },
		{ id: MSG_A1, role: "assistant", text: "Deploying the staging service now." },
		{ id: MSG_U2, role: "user", text: U2_TEXT },
	]);
	assert.deepEqual(msgIds, [MSG_U1, MSG_A1, MSG_U2]);

	// provenance stores referenced by uses_prompt / uses_config edges
	await db.prepare("INSERT INTO prompt_registry (hash, content, role, created_at) VALUES (?, ?, ?, ?)")
		.run(PROMPT_HASH, "You are classifying a turn pair for friction.", "system", new Date().toISOString());
	await db.prepare("INSERT INTO analyzer_defs (id, label, description, anchor_span, dependencies, created_at) VALUES (?, ?, ?, ?, ?, ?)")
		.run("turn-pair-core", "Turn Pair Core", "fixture", "turn", "[]", new Date().toISOString());
	await db.prepare("INSERT INTO analyzer_configs (id, analyzer_id, config_hash, config_json, created_at) VALUES (?, ?, ?, ?, ?)")
		.run(CONFIG_ID, "turn-pair-core", "ch-0001", "{}", new Date().toISOString());

	await insertFixtureNode(db, { id: N_CORE, analyzerId: "turn-pair-core", version: "1.0", nodeKind: "metric", contentJson: JSON.stringify({ frictionScore: 0.4 }), outputKey: OK_CORE });
	await insertFixtureNode(db, { id: N_CLS_V1, analyzerId: "turn-pair-llm", version: "1.0", nodeKind: "classification", contentJson: JSON.stringify({ label: "correction" }), outputKey: OK_CLS_V1 });
	await insertFixtureNode(db, {
		id: N_CLS_V2, analyzerId: "turn-pair-llm", version: "1.1", nodeKind: "classification",
		contentJson: JSON.stringify({ label: "waste", note: "revised classifier" }), outputKey: OK_CLS_V2,
	});
	await insertFixtureNode(db, {
		id: N_SUMMARY, analyzerId: "session-overview", version: "2.0", nodeKind: "summary",
		contentJson: JSON.stringify({ digest: "deploy friction around retries", positives: [] }),
		outputKey: OK_SUMMARY,
	});
	await insertFixtureNode(db, {
		id: N_ERROR_RETRACTED, analyzerId: "session-overview", version: "1.9", nodeKind: "error",
		contentJson: JSON.stringify({ message: "provider unavailable" }), outputKey: "ok-error-retracted",
		retractedAt: new Date(1_700_000_200_000).toISOString(),
	});

	async function edge(fromNodeId: string, edgeKind: string, toRefKind: string, toRefId: string, ordinal = 0): Promise<void> {
		await insertEdge(db, { fromNodeId, toRefKind, toRefId, edgeKind, ordinal });
	}

	await edge(N_CORE, EDGE_KINDS.ANCHORS, REF_KINDS.SESSION, SESS);
	await edge(N_CORE, EDGE_KINDS.ANCHORS, REF_KINDS.MESSAGE, MSG_U1, 1);
	await edge(N_CLS_V1, EDGE_KINDS.CONSUMES, REF_KINDS.ANALYSIS_NODE, OK_CORE);
	await edge(N_CLS_V1, EDGE_KINDS.USES_PROMPT, REF_KINDS.PROMPT_VERSION, PROMPT_HASH);
	await edge(N_CLS_V1, EDGE_KINDS.USES_CONFIG, REF_KINDS.CONFIG_VERSION, CONFIG_ID);
	await edge(N_CLS_V2, EDGE_KINDS.CONSUMES, REF_KINDS.ANALYSIS_NODE, OK_CORE);
	await edge(N_CLS_V2, EDGE_KINDS.REVISES, REF_KINDS.ANALYSIS_NODE, OK_CLS_V1);
	const muteAssertionId = await upsertAssertion(db, { subjectKind: "term", subjectKey: "retry", verdict: "muted", reason: "retry complaints are expected here" });
	await edge(N_CLS_V2, EDGE_KINDS.MUTES, REF_KINDS.ASSERTION, muteAssertionId);
	await edge(N_SUMMARY, EDGE_KINDS.CONSUMES, REF_KINDS.ANALYSIS_NODE, OK_CLS_V2);
	await edge(N_SUMMARY, EDGE_KINDS.ANCHORS, REF_KINDS.SESSION, SESS);
	await edge(N_ERROR_RETRACTED, EDGE_KINDS.ANCHORS, REF_KINDS.SESSION, SESS);

	// proposals lifted from the summary, each with evidence back to a user message
	await insertProposalRow(db, {
		id: "viz-proposal-1", sessionId: SESS, title: "Add standing instruction for staging deploy retries",
		targetType: "standing_instruction", severity: "friction", status: "open", inputKey: P1_INPUT_KEY,
	});
	await db.prepare("UPDATE proposals SET source_node_id = ?, analyzer_id = ?, confidence = ?, source_message_ids = ?, validation_status = 'unvalidated' WHERE id = ?")
		.run(N_SUMMARY, "session-overview", 0.7, JSON.stringify([MSG_U2]), "viz-proposal-1");
	await insertProposalRow(db, {
		id: "viz-proposal-2", sessionId: SESS, title: "Document the log-tailing skill",
		targetType: "skill", severity: "suggestion", status: "applied", inputKey: P2_INPUT_KEY,
	});
	await db.prepare("UPDATE proposals SET source_node_id = ?, analyzer_id = ?, validated_score = ?, validation_status = 'supported' WHERE id = ?")
		.run(N_SUMMARY, "session-overview", 0.5, "viz-proposal-2");

	await edge(N_SUMMARY, EDGE_KINDS.PRODUCES, REF_KINDS.PROPOSAL, "viz-proposal-1", 0);
	await edge(N_SUMMARY, EDGE_KINDS.PRODUCES, REF_KINDS.PROPOSAL, "viz-proposal-2", 1);

	// external human input: two accepted decisions grouped under one remediation
	await upsertAssertion(db, { subjectKind: "proposal", subjectKey: P1_INPUT_KEY, verdict: "accepted", disposition: "done", actualChange: "AGENTS.md commit abc123", remediationId: REMEDIATION_ID });
	await upsertAssertion(db, { subjectKind: "proposal", subjectKey: P2_INPUT_KEY, verdict: "accepted_modified", disposition: "done_differently", remediationId: REMEDIATION_ID });
	await upsertAssertion(db, { subjectKind: "remediation", subjectKey: REMEDIATION_ID, verdict: "remediation", reason: "One PR updated AGENTS.md and the deploy skill together" });

	return { db, close, dbPath };
}

// ───────────────────────── shared helpers ─────────────────────────

function extractEmbeddedJson(html: string): Record<string, unknown> {
	const match = html.match(/<script id="viz-data" type="application\/json">([\s\S]*?)<\/script>/);
	assert.ok(match, "embedded viz-data script element present");
	return JSON.parse(match![1]!) as Record<string, unknown>;
}

async function tableCounts(db: AsyncDatabase): Promise<Record<string, number>> {
	const tables = ["sessions", "messages", "analysis_nodes", "analysis_edges", "proposals", "assertions", "analysis_runs", "analyze_runs", "prompt_registry", "analyzer_configs"];
	const counts: Record<string, number> = {};
	for (const t of tables) {
		const row = (await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()) as { n: number };
		counts[t] = row.n;
	}
	return counts;
}

// ───────────────────────── suite ─────────────────────────

describe("prospect viz", () => {
	let fx: Awaited<ReturnType<typeof buildFixtureDb>>;
	let outDir: string;

	before(async () => {
		fx = await buildFixtureDb();
		outDir = fs.mkdtempSync(path.join(os.tmpdir(), "prospector-viz-out-"));
	});

	after(async () => {
		await fx.close();
		fs.rmSync(outDir, { recursive: true, force: true });
	});

	it("renders a self-contained HTML artifact embedding faithful graph JSON", async () => {
		const { renderSessionPage } = await import("../../src/commands/viz.js");
		const file = await renderSessionPage(fx.db, SESS, outDir);
		assert.ok(fs.existsSync(file));
		const html = fs.readFileSync(file, "utf8");
		assert.ok(html.startsWith("<!doctype html>"), "an HTML document");
		assert.ok(!/<img[\s>]|<link[\s>]|src="https?:|href="https?:/.test(html), "no external resources — opens with no network access");

		const data = extractEmbeddedJson(html);

		// nodes faithfully reflect the DB, kinds included, retracted included
		const nodes = data["nodes"] as Array<{ id: string; nodeKind: string; analyzerId: string; retractedAt: string | null }>;
		const byId = new Map(nodes.map((n) => [n.id, n]));
		for (const [id, kind] of [
			[N_CORE, "metric"], [N_CLS_V1, "classification"], [N_CLS_V2, "classification"],
			[N_SUMMARY, "summary"], [N_ERROR_RETRACTED, "error"],
		] as const) {
			assert.equal(byId.get(id)?.nodeKind, kind, `node ${id} carries its DB kind ${kind}`);
		}
		assert.equal(byId.get(N_ERROR_RETRACTED)?.retractedAt, new Date(1_700_000_200_000).toISOString(), "retracted tombstone carried, not dropped");

		// edges faithfully reflect the edge table: every kind the fixture wrote appears
		const edges = data["edges"] as Array<{ edgeKind: string; toRefKind: string; toRefId: string }>;
		for (const kind of ["anchors", "consumes", "produces", "revises", "uses_prompt", "uses_config", "mutes"]) {
			assert.ok(edges.some((e) => e.edgeKind === kind), `edge kind ${kind} present`);
		}
		// consumes/revises targets resolve to in-session node ids (not raw output keys)
		const revises = edges.find((e) => e.edgeKind === "revises")!;
		assert.equal(revises.toRefId, N_CLS_V1);
		const consumes = edges.filter((e) => e.edgeKind === "consumes").map((e) => e.toRefId);
		assert.ok(consumes.includes(N_CORE) && consumes.includes(N_CLS_V2));

		// transcript rail reflects messages verbatim
		const messages = data["messages"] as Array<{ id: string; text: string | null }>;
		assert.ok(messages.some((m) => m.text === U1_TEXT));
		assert.ok(messages.some((m) => m.text === U2_TEXT));

		// proposals carry click-through evidence resolved through the edge table
		const proposals = data["proposals"] as Array<{ id: string; evidenceMessages: string[]; evidenceNodes: string[]; sourceMessageIds: string[] }>;
		const p1 = proposals.find((p) => p.id === "viz-proposal-1")!;
		assert.ok(p1.evidenceNodes.includes(N_SUMMARY) && p1.evidenceNodes.includes(N_CLS_V2) && p1.evidenceNodes.includes(N_CORE), "walk-back covers source node and consumed nodes");
		assert.ok(p1.evidenceMessages.includes(MSG_U1), "anchored message of a consumed node is on the trail");
		assert.ok(p1.sourceMessageIds.includes(MSG_U2) && p1.evidenceMessages.includes(MSG_U2), "source_message_ids ride along");

		// remediations group the decisions that carry their id
		const remediations = data["remediations"] as Array<{ id: string; decisionInputKeys: string[]; description: string | null }>;
		const rem = remediations.find((r) => r.id === REMEDIATION_ID)!;
		assert.ok(rem.decisionInputKeys.includes(P1_INPUT_KEY) && rem.decisionInputKeys.includes(P2_INPUT_KEY), "one action, N proposals, legible");
	});

	it("lands proposal click-through on anchored messages whose text appears verbatim", async () => {
		const file = path.join(outDir, `prospect-viz-${SESS}.html`);
		const html = fs.readFileSync(file, "utf8");
		assert.ok(html.includes(U1_TEXT), "anchored message text appears verbatim in the page");
		assert.ok(html.includes(U2_TEXT), "source-message text appears verbatim in the page");

		const data = extractEmbeddedJson(html);
		const messages = data["messages"] as Array<{ id: string; text: string | null }>;
		const u1 = messages.find((m) => m.id === MSG_U1)!;
		assert.equal(u1.text, U1_TEXT);

		// the client script highlights exactly the ids on the proposal's trail
		const script = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/)![1]!;
		assert.ok(script.includes("highlightEvidence"), "click-through handler wired");
		assert.ok(script.includes("evidenceMessages"), "trail drives highlighting");
	});

	it("writes nothing to the DB and re-renders byte-identically", async () => {
		const { collectVizData } = await import("../../src/viz/collect.js");
		const { renderVizHtml } = await import("../../src/viz/render.js");
		const { renderSessionPage } = await import("../../src/commands/viz.js");

		const before = await tableCounts(fx.db);
		const first = renderVizHtml(await collectVizData(fx.db, { sessionId: SESS }));
		const afterOne = await tableCounts(fx.db);
		const rerenderDir = fs.mkdtempSync(path.join(os.tmpdir(), "prospector-viz-rerender-"));
		await renderSessionPage(fx.db, SESS, rerenderDir);
		const afterTwo = await tableCounts(fx.db);

		for (const t of Object.keys(before)) {
			assert.equal(afterOne[t], before[t], `${t} untouched by render #1`);
			assert.equal(afterTwo[t], before[t], `${t} untouched by render #2`);
		}
		const secondFile = path.join(rerenderDir, `prospect-viz-${SESS}.html`);
		assert.equal(fs.readFileSync(secondFile, "utf8"), first, "re-render over the same DB is byte-identical (idempotent)");
		fs.rmSync(rerenderDir, { recursive: true, force: true });
	});

	it("emits retracted filtering and collapsible revises lineage in the page structure", async () => {
		const html = fs.readFileSync(path.join(outDir, `prospect-viz-${SESS}.html`), "utf8");
		const data = extractEmbeddedJson(html);

		// retracted nodes are filterable, not absent
		assert.ok(/id="toggle-retracted"[^>]*checked/.test(html), "'show retracted' filter control present and default-on");
		const lineageGroups = data["lineageGroups"] as Array<{ index: number; nodeIds: string[] }>;
		const clsGroup = lineageGroups.find((g) => g.nodeIds.length === 2);
		assert.ok(clsGroup, "the revises pair forms a collapsible lineage group");
		assert.deepEqual([...clsGroup!.nodeIds].sort(), [...[N_CLS_V1, N_CLS_V2]].sort());

		// per-node lineage membership lets the collapse keep the newest visible
		const nodes = data["nodes"] as Array<{ id: string; lineageGroup: number | null }>;
		assert.equal(nodes.find((n) => n.id === N_CLS_V1)?.lineageGroup, clsGroup!.index);
		assert.equal(nodes.find((n) => n.id === N_CLS_V2)?.lineageGroup, clsGroup!.index);
		assert.ok(/id="toggle-lineage"/.test(html), "global lineage-collapse control present");

		// depth-collapse ships as a slider over computed consumption depth
		assert.ok(/id="depth-range"/.test(html), "depth slider present");
		const coreDepth = (data["nodes"] as Array<{ id: string; depth: number }>).find((n) => n.id === N_CORE)!.depth;
		const summaryDepth = (data["nodes"] as Array<{ id: string; depth: number }>).find((n) => n.id === N_SUMMARY)!.depth;
		assert.ok(coreDepth < summaryDepth, "consumption depth increases toward the summary");
	});

	it("rejects an unknown session instead of rendering an empty page", async () => {
		const { collectVizData } = await import("../../src/viz/collect.js");
		await assert.rejects(() => collectVizData(fx.db, { sessionId: "no-such-session" }), /Unknown session/);
	});

	it("executes its client script against the page: clicks land, filters hide", async () => {
		// A minimal DOM stub — enough surface for the embedded vanilla-JS script to
		// run top-to-bottom against the real artifact, then simulated interactions:
		// node click fills the detail panel, proposal click highlights the evidence
		// trail onto the anchored messages, the retracted filter hides its node.
		const { collectVizData } = await import("../../src/viz/collect.js");
		const { renderVizHtml } = await import("../../src/viz/render.js");
		const html = renderVizHtml(await collectVizData(fx.db, { sessionId: SESS }));
		const dataJson = html.match(/<script id="viz-data" type="application\/json">([\s\S]*?)<\/script>/)![1]!;
		const script = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/)![1]!;

		interface StubEl {
			tag: string;
			children: StubEl[];
			parent: StubEl | null;
			attrs: Record<string, string>;
			attrsText: string;
			textContentValue: string | null;
			innerHTML: string;
			classNameValue: string;
			classSet: Set<string>;
			listeners: Map<string, Array<(ev?: unknown) => void>>;
			style: Record<string, string>;
			props: Record<string, unknown>;
			removed: boolean;
		}

		const allEls: StubEl[] = [];
		function makeEl(tag: string): StubEl {
			const el: StubEl = {
				tag,
				children: [],
				parent: null,
				attrs: {},
				attrsText: "",
				textContentValue: null,
				innerHTML: "",
				classNameValue: "",
				classSet: new Set(),
				listeners: new Map(),
				style: {},
				props: {},
				removed: false,
			};
			Object.defineProperties(el, {
				textContent: {
					get: () => el.textContentValue ?? el.children.filter((c) => c.tag === "_text").map((c) => c.textContentValue).join(""),
					set: (v: string | null) => { el.textContentValue = v; },
				},
				className: {
					get: () => el.classNameValue,
					set: (v: string) => { el.classNameValue = v; el.classSet = new Set(v.split(/\s+/).filter(Boolean)); },
				},
				firstChild: { get: () => el.children[0] ?? null },
				classList: {
					get: () => ({
						add: (...cs: string[]) => { cs.forEach((c) => el.classSet.add(c)); },
						remove: (...cs: string[]) => { cs.forEach((c) => el.classSet.delete(c)); },
						contains: (c: string) => el.classSet.has(c),
					}),
				},
			});
			(el as unknown as Record<string, unknown>).setAttribute = (k: string, v: string) => { el.attrs[k] = v; el.attrsText = `${k}="${v}"`; };
			(el as unknown as Record<string, unknown>).getAttribute = (k: string) => el.attrs[k];
			(el as unknown as Record<string, unknown>).appendChild = (c: StubEl) => { c.parent = el; el.children.push(c); return c; };
			(el as unknown as Record<string, unknown>).removeChild = (c: StubEl) => { el.children = el.children.filter((x) => x !== c); c.removed = true; };
			(el as unknown as Record<string, unknown>).remove = () => { el.removed = true; if (el.parent) el.parent.children = el.parent.children.filter((x) => x !== el); };
			(el as unknown as Record<string, unknown>).addEventListener = (kind: string, fn: (ev?: unknown) => void) => {
				const list = el.listeners.get(kind) ?? [];
				list.push(fn);
				el.listeners.set(kind, list);
			};
			(el as unknown as Record<string, unknown>).getBoundingClientRect = () => ({ width: 1400, height: 900, left: 0, top: 0 });
			el.classSet = new Set();
			allEls.push(el);
			return el;
		}

		const byId = new Map<string, StubEl>();
		const documentStub = {
			getElementById: (id: string): StubEl => {
				if (!byId.has(id)) {
					const el = makeEl(`#${id}`);
					if (id === "depth-range") { el.props["max"] = "99"; el.props["value"] = "99"; }
					byId.set(id, el);
				}
				return byId.get(id)!;
			},
			createElementNS: (_ns: string, tag: string) => makeEl(tag),
			createElement: (tag: string) => makeEl(tag),
			createTextNode: (text: string) => {
				const t = makeEl("_text");
				t.textContentValue = text;
				return t;
			},
			querySelectorAll: (sel: string) => {
				const cls = sel.slice(1);
				return allEls.filter((e) => !e.removed && e.classSet.has(cls));
			},
		};
		byId.set("viz-data", (() => { const e = makeEl("script"); e.textContentValue = dataJson; return e; })());
		const windowListeners: Array<[string, (ev?: unknown) => void]> = [];
		const windowStub = { addEventListener: (kind: string, fn: (ev?: unknown) => void) => { windowListeners.push([kind, fn]); } };

		// Run the page's own script. Any runtime error here fails the test.
		new Function("document", "window", script)(documentStub, windowStub);

		function fire(id: string, kind: string, ev?: unknown): void {
			for (const fn of byId.get(id)?.listeners.get(kind) ?? []) fn(ev);
		}
		function entityGroup(entityId: string): StubEl {
			return allEls.find((e) => e.tag === "g" && e.attrs["data-id"] === entityId)!;
		}
		function fireClick(el: StubEl): void {
			for (const fn of el.listeners.get("click") ?? []) fn();
		}

		// click a node → detail panel filled with content + outgoing edges
		const detail = byId.get("detail")!;
		fireClick(entityGroup(N_CLS_V1));
		const panelText = detail.children.map((c) => `${c.classNameValue} ${c.innerHTML}`).join("\n");
		assert.ok(panelText.includes("turn-pair-llm") && panelText.includes("outgoing edges"), "node click populates the detail panel");

		// click a proposal → evidence trail highlights the anchored messages
		fireClick(entityGroup("viz-proposal-1"));
		assert.ok(entityGroup(MSG_U1).classSet.has("hl"), "anchored transcript message highlighted");
		assert.ok(entityGroup(N_CORE).classSet.has("hl"), "consumed metric node highlighted");

		// retracted filter off → the retracted error node hides
		const errGroup = entityGroup(N_ERROR_RETRACTED);
		assert.notEqual(errGroup.style["display"], "none", "retracted node visible by default");
		fire("toggle-retracted", "change", { target: { checked: false } });
		assert.equal(errGroup.style["display"], "none", "retracted node hides when filtered");

		// lineage collapse keeps only the newest version visible
		fire("toggle-lineage", "change", { target: { checked: true } });
		assert.equal(entityGroup(N_CLS_V2).style["display"], "", "newest version stays visible under collapse");
		assert.equal(entityGroup(N_CLS_V1).style["display"], "none", "older alternative collapses");
	});

	it("works end-to-end through the registered prospect-viz command", async () => {
		process.env["PROSPECTOR_DB_PATH"] = fx.dbPath;
		process.env["PROSPECTOR_SESSIONS_DIR"] = FIXTURES;
		try {
			const mod = await import("../../src/index.js");
			const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>();
			const notes: string[] = [];
			mod.default({
				registerCommand: (name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(name, opts.handler),
				registerTool: () => {},
				registerFlag: () => {},
				getFlag: () => undefined,
				on: () => {},
			});
			const cmdDir = fs.mkdtempSync(path.join(os.tmpdir(), "prospector-viz-cmd-"));
			const ctx = { hasUI: false, ui: { notify: (m: string) => notes.push(m) } };

			// no id → the session picker lists what can be rendered
			await commands.get("prospect-viz")!("", ctx);
			assert.ok(notes.some((n) => n.includes("Sessions")), "picker lists sessions");
			assert.ok(notes.some((n) => n.includes(SESS)), "picker names the fixture session");

			// with an id → writes the self-contained artifact
			notes.length = 0;
			await commands.get("prospect-viz")!(`${SESS} --out ${cmdDir}`, ctx);
			const written = path.join(cmdDir, `prospect-viz-${SESS}.html`);
			assert.ok(fs.existsSync(written), "command wrote the artifact");
			const html = fs.readFileSync(written, "utf8");
			const data = extractEmbeddedJson(html);
			assert.equal(((data["session"] as Record<string, unknown>)["id"]), SESS);
		} finally {
			delete process.env["PROSPECTOR_DB_PATH"];
			delete process.env["PROSPECTOR_SESSIONS_DIR"];
		}
	});
});
