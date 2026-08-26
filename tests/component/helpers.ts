import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import assert from "node:assert/strict";
import { type AsyncDatabase, openAsyncDatabase } from "../../src/db/async-db.js";
import { migrate } from "../../src/db/schema.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import type { AnalysisNodeRow, Analyzer } from "../../src/analyze/types.js";
import type { LLMRequest } from "../../src/analyze/types.js";

export const FIXTURES = path.resolve(import.meta.dirname, "..", "fixtures");

/**
 * A throwaway sessions root with cleanup, for suites that build their own
 * synthetic fixture trees on disk. The prefix keeps parallel-suite temp dirs
 * identifiable when one leaks.
 */
export function makeTempRoot(prefix: string): { root: string; cleanup: () => void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** Write one JSONL fixture file under `dir` (created as needed), newline-terminated like real session files. */
export function writeJsonl(dir: string, fileName: string, lines: string[]): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, fileName), lines.join("\n") + "\n");
}

/**
 * The Claude sessions root to pass when a test has no Claude fixtures of its own.
 *
 * `discoverSessions`/`runSync` require both roots precisely so a test cannot fall
 * back to the developer's real `~/.claude/projects`. Naming the absent directory
 * makes that intent explicit at each call site, rather than leaving a bare
 * `"/nonexistent"` to be misread as an accident.
 */
export const NO_CLAUDE_DIR = path.join(os.tmpdir(), "prospect-tests-no-claude-sessions");

export interface TempDb {
	db: AsyncDatabase;
	close: () => Promise<void>;
}

/** A migrated SQLite database backed by an async worker + unique temp file, with cleanup. */
export function tempDb(dbPath = path.join(os.tmpdir(), `prospect-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`)): Promise<TempDb> {
	const db = openAsyncDatabase(dbPath);
	return migrate(db).then(() => ({
		db,
		close: async () => {
			await db.close();
			for (const suffix of ["", "-wal", "-shm"]) {
				try {
					fs.unlinkSync(dbPath + suffix);
				} catch {
					/* ignore */
				}
			}
		},
	}));
}

/** Insert a minimal session row so foreign keys on messages/proposals are satisfied. */
export async function insertSession(db: AsyncDatabase, id: string, filePath = `/tmp/${id}.jsonl`, cwd = "", source = "pi"): Promise<void> {
	await db.prepare(
		"INSERT INTO sessions (id, file_path, project, source, cwd, started_at, last_line, last_modified, message_count, branch_count) " +
			"VALUES (?, ?, '', ?, ?, ?, 0, 0, 0, 0)",
	).run(id, filePath, source, cwd, new Date().toISOString());
}

let messageSeq = 0;

export interface TestMessage {
	role: string;
	text?: string;
	thinking?: string;
	toolCalls?: Array<{ id?: string; name: string; arguments?: Record<string, unknown> }>;
	toolResults?: Array<{ toolCallId?: string; toolName: string; isError: boolean; textLength: number }>;
	id?: string;
	/** The serving model for an assistant message. */
	model?: string | null;
	/** The billed dollar cost of an assistant message. */
	costUsd?: number | null;
	/** How the assistant generation ended, verbatim from the host, or null. */
	stopReason?: string | null;
	/** Why the generation failed, verbatim from the host, or null when it did not. */
	errorMessage?: string | null;
	/** The raw usage JSON stored in messages.usage (token buckets + per-bucket cost). */
	usage?: Record<string, unknown>;
}

/** Insert messages for a session in order, returning the inserted ids. */
export async function insertMessages(db: AsyncDatabase, sessionId: string, messages: TestMessage[]): Promise<string[]> {
	const stmt = db.prepare(
		"INSERT INTO messages (id, session_id, source, parent_id, timestamp, role, content_text, content_thinking, tool_calls, tool_results, model, cost_usd, stop_reason, error_message, usage) " +
			"VALUES (?, ?, 'pi', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
	);
	const ids: string[] = [];
	let parent: string | null = null;
	for (const m of messages) {
		const id = m.id ?? `msg-${sessionId}-${messageSeq++}`;
		await stmt.run(
			id,
			sessionId,
			parent,
			new Date(1_700_000_000_000 + messageSeq * 1000).toISOString(),
			m.role,
			m.text ?? null,
			m.thinking ?? null,
			m.toolCalls ? JSON.stringify(m.toolCalls) : null,
			m.toolResults ? JSON.stringify(m.toolResults) : null,
			m.model ?? null,
			m.costUsd ?? null,
			m.stopReason ?? null,
			m.errorMessage ?? null,
			m.usage ? JSON.stringify(m.usage) : null,
		);
		ids.push(id);
		parent = id;
	}
	return ids;
}

/** Synthetic v3 session-header line for one session id. */
export function sessionHeaderLine(
	sessionId: string,
	opts?: { timestamp?: string; cwd?: string },
): string {
	return JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: opts?.timestamp ?? "2026-08-19T01:02:17Z", cwd: opts?.cwd ?? "/home/user/proj" });
}

/** Synthetic turn line belonging to one session, with a unique per-turn message id. */
export function messageLine(sessionId: string, turn: number, role: string, content: string, timestamp: string): string {
	return JSON.stringify({ type: "message", id: `${sessionId}-m${turn}`, timestamp, message: { role, content } });
}

// ─────────────────────── lexicon mock scaffolding ───────────────────────────

/**
 * A mock LLM for the learned-lexicon suites: every `classify_term` call comes
 * back "frustration" exactly for entries in `frustratedEntries` (words or
 * multi-word phrases alike) and neutral otherwise, with French as the only
 * language the stub ever names.
 */
export function lexiconMock(
	frustratedEntries: ReadonlySet<string>,
	frustratedRationale = "expresses dissatisfaction",
) {
	return createMockLLM({
		responder: (req: LLMRequest) => {
			const entry = String((req.user.match(/TERM:\s*(.*)/) ?? [])[1] ?? "").trim();
			const frustrated = frustratedEntries.has(entry);
			return {
				text: "x",
				structured: {
					polarity: frustrated ? "frustration" : "neutral",
					category: frustrated ? "dissatisfaction" : "none",
					language: frustrated ? "fr" : "und",
					confidence: 0.9,
					rationale: frustrated ? frustratedRationale : "ordinary vocabulary",
				},
			};
		},
	});
}

/**
 * How many times the model was asked to adjudicate exactly this entry.
 *
 * Matched exactly, not by substring: now that phrases are judged too, a
 * `TERM: putain c'est` call would otherwise also count as a call for `putain`.
 */
export function classifyCallsFor(llm: ReturnType<typeof lexiconMock>, entry: string): number {
	return llm.calls.filter((c) => c.tool?.name === "classify_term" && c.user === `TERM: ${entry}`).length;
}

// ─────────────────── analyzer-framework scaffolding ──────────────────────────

/** Per-analyzer config overrides keyed by analyzer id (see FrameworkDeps). */
export interface MockFrameworkOptions {
	configOverrides?: Record<string, Record<string, unknown>>;
}

/**
 * An AnalyzerFramework wired to the deterministic mock LLM. For suites whose
 * analyzers never touch the LLM seam: the mock exists only to satisfy the
 * framework's construction.
 */
export function mockFramework(
	db: import("better-sqlite3").Database,
	options: MockFrameworkOptions = {},
): AnalyzerFramework {
	return new AnalyzerFramework({
		db,
		llm: createMockLLM({ responder: () => "unused by this analyzer" }).caller,
		modelTiers: DEFAULT_MODEL_TIERS,
		configOverrides: options.configOverrides,
	});
}

/**
 * An AnalyzerFramework wired to the deterministic mock LLM, with per-analyzer
 * config overrides keyed by analyzer id.
 */
export function mockFrameworkWithOverrides(
	db: import("better-sqlite3").Database,
	analyzerId: string,
	overrides: Record<string, unknown>,
): AnalyzerFramework {
	return new AnalyzerFramework({
		db,
		llm: createMockLLM({ responder: () => "unused by this analyzer" }).caller,
		modelTiers: DEFAULT_MODEL_TIERS,
		configOverrides: { [analyzerId]: overrides },
	});
}

/** Every analysis node of one analyzer, including lineage versions. */
export async function readAnalyzerNodes(db: import("better-sqlite3").Database, analyzerId: string): Promise<AnalysisNodeRow[]> {
	return (await db
		.prepare("SELECT id, node_kind, input_key, output_key, content_json, analyzer_id FROM analysis_nodes WHERE analyzer_id = ?")
		.all(analyzerId)) as unknown as AnalysisNodeRow[];
}

/** Every typed edge leaving a node (anchors, produces, revises, ...). */
export async function nodeEdges(db: import("better-sqlite3").Database, nodeId: string): Promise<Array<Record<string, unknown>>> {
	return (await db
		.prepare("SELECT * FROM analysis_edges WHERE from_node_id = ?")
		.all(nodeId)) as unknown as Array<Record<string, unknown>>;
}

/** Materialised proposals of one analyzer for one session. */
export async function sessionProposals(
	db: import("better-sqlite3").Database,
	sessionId: string,
	analyzerId: string,
): Promise<Array<Record<string, unknown>>> {
	return (await db
		.prepare("SELECT * FROM proposals WHERE session_id = ? AND analyzer_id = ?")
		.all(sessionId, analyzerId)) as unknown as Array<Record<string, unknown>>;
}

/** Tool-call fixture: one shell command. */
export function bashCall(command: string): TestMessage["toolCalls"] {
	return [{ name: "bash", arguments: { command } }];
}

/** Tool-call fixture: one file read. */
export function readCall(p: string): TestMessage["toolCalls"] {
	return [{ name: "read", arguments: { file_path: p } }];
}

/**
 * Seed a session row plus its messages in one step, returning the message ids.
 */
export async function seedSession(db: AsyncDatabase, sessionId: string, messages: TestMessage[]): Promise<string[]> {
	await insertSession(db, sessionId);
	return insertMessages(db, sessionId, messages);
}

/**
 * The plain-fill scenario: seed the session, register the analyzer on a fresh
 * default framework, run once, and return its nodes. Fails on run errors so
 * call sites can go straight to asserting node shape.
 */
export async function runAnalyzerOverSession(
	db: AsyncDatabase,
	analyzer: Analyzer,
	sessionId: string,
	messages: TestMessage[],
): Promise<AnalysisNodeRow[]> {
	await seedSession(db, sessionId, messages);
	const fw = mockFramework(db);
	await fw.register(analyzer);
	const summary = await fw.run(sessionId, {});
	assert.equal(summary.errors.length, 0, `run should have no errors: ${summary.errors.join("; ")}`);
	return readAnalyzerNodes(db, analyzer.def.id);
}

/**
 * The shared idempotency check over an ad-hoc seeded session: seed, then
 * {@link assertPlainRerunIsNoOpFill} — the second plain fill produced nothing
 * while every recipe identity stayed untouched.
 */
export async function expectPlainRerunIsNoOpFill(
	db: AsyncDatabase,
	analyzer: Analyzer,
	sessionId: string,
	messages: TestMessage[],
): Promise<void> {
	await seedSession(db, sessionId, messages);
	await assertPlainRerunIsNoOpFill(mockFramework(db), analyzer, sessionId, () => readAnalyzerNodes(db, analyzer.def.id));
}

/**
 * The standard config-change scenario: run once under defaults (asserting
 * exactly one unit), then under `overrides` via
 * {@link reviseBesidePredecessor}. Returns the pre- and post-revision nodes and
 * the override framework so call sites can keep asserting version-specific
 * content or re-run against the revised recipe.
 */
export async function expectConfigChangeRevises(
	db: AsyncDatabase,
	analyzer: Analyzer,
	sessionId: string,
	messages: TestMessage[],
	overrides: Record<string, unknown>,
): Promise<{ before: AnalysisNodeRow[]; after: AnalysisNodeRow[]; revised: AnalyzerFramework }> {
	await seedSession(db, sessionId, messages);

	const fw = mockFramework(db);
	await fw.register(analyzer);
	await fw.run(sessionId, {});
	const before = await readAnalyzerNodes(db, analyzer.def.id);
	assert.equal(before.length, 1);

	// A config change alters the resolved fingerprint → the unit goes stale for
	// the `config` reason; the revise run recomputes it beside its predecessor.
	const revised = mockFrameworkWithOverrides(db, analyzer.def.id, overrides);
	await revised.register(analyzer);
	const after = await reviseBesidePredecessor(db, revised, analyzer.def.id, sessionId, before);
	return { before, after, revised };
}

/**
 * The shared idempotency check: register the analyzer, run twice, and assert
 * the second plain fill produced nothing while leaving every recipe identity
 * (input/output keys) untouched.
 */
export async function assertPlainRerunIsNoOpFill(
	fw: AnalyzerFramework,
	analyzer: Analyzer,
	sessionId: string,
	readNodes: () => Promise<AnalysisNodeRow[]>,
): Promise<void> {
	await fw.register(analyzer);

	const first = await fw.run(sessionId, {});
	assert.equal(first.errors.length, 0);
	const before = await readNodes();
	assert.equal(before.length, 1);

	const second = await fw.run(sessionId, {});
	assert.equal(second.errors.length, 0);
	assert.equal(second.nodesProduced, 0, "second plain fill must produce nothing");
	assert.equal(second.nodesSkipped, 1, "the existing unit is current");

	const after = await readNodes();
	assert.deepEqual(after.map((n) => [n.input_key, n.output_key]), before.map((n) => [n.input_key, n.output_key]));
}

/**
 * Run a `config` revise pass on `fw` and assert the unit went stale for the
 * `config` reason and was recomputed beside its predecessor, preserving the old
 * version as lineage behind a `revises` edge. Returns the post-revision nodes
 * so call sites can keep asserting version-specific content.
 */
export async function reviseBesidePredecessor(
	db: import("better-sqlite3").Database,
	fw: AnalyzerFramework,
	analyzerId: string,
	sessionId: string,
	before: readonly AnalysisNodeRow[],
): Promise<AnalysisNodeRow[]> {
	const revised = await fw.run(sessionId, { revise: ["config"] });
	assert.equal(revised.errors.length, 0);
	assert.equal(revised.nodesRevised, 1, "the unit was revised under new config");

	const after = await readAnalyzerNodes(db, analyzerId);
	assert.equal(after.length, 2, "old version preserved as lineage beside the revision");
	const newNode = after.find((n) => n.input_key !== before[0]!.input_key);
	assert.ok(newNode, "revised node carries a new recipe identity");

	const reviseEdges = (await db
		.prepare("SELECT * FROM analysis_edges WHERE from_node_id = ? AND edge_kind = 'revises'")
		.all(newNode!.id)) as unknown as Array<Record<string, unknown>>;
	assert.equal(reviseEdges.length, 1, "a revises edge links the revision to its predecessor");
	return after;
}

/**
 * The standard proposal-node evidence trail: exactly one session anchor, the
 * message anchors carrying the findings, and the produces edge into the fast
 * store. Returns the edges so call sites can keep asserting beyond the common
 * shape.
 */
export async function assertProposalEvidenceTrail(
	db: import("better-sqlite3").Database,
	nodeId: string,
	messageAnchors:
		| number
		| { atLeast: number; note: string }
		| { exactly: number; note: string },
): Promise<Array<Record<string, unknown>>> {
	const edges = await nodeEdges(db, nodeId);
	assert.equal(
		edges.filter((e) => e["edge_kind"] === "anchors" && e["to_ref_kind"] === "session").length,
		1,
		"anchored to the session",
	);
	const anchors = edges.filter((e) => e["edge_kind"] === "anchors" && e["to_ref_kind"] === "message");
	if (typeof messageAnchors === "number") {
		assert.equal(anchors.length, messageAnchors);
	} else if ("atLeast" in messageAnchors) {
		assert.ok(anchors.length >= messageAnchors.atLeast, messageAnchors.note);
	} else {
		assert.equal(anchors.length, messageAnchors.exactly, messageAnchors.note);
	}
	assert.ok(edges.find((e) => e["edge_kind"] === "produces"), "proposal node must produce its proposal");
	return edges;
}

/** Insert a v2 proposal directly (bypassing materialisation), for query tests. */
export async function insertProposalRow(
	db: AsyncDatabase,
	p: {
		id: string;
		sessionId: string;
		targetType?: string;
		targetPath?: string;
		title: string;
		severity?: string;
		summary?: string;
		status?: string;
		inputKey?: string;
	},
): Promise<void> {
	const now = new Date().toISOString();
	await db.prepare(
		"INSERT INTO proposals (id, created_at, updated_at, session_id, source_node_id, analyzer_id, target_type, target_path, title, severity, summary, detail, evidence, confidence, status, input_key) " +
			"VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)",
	).run(
		p.id,
		now,
		now,
		p.sessionId,
		p.targetType ?? "config",
		p.targetPath ?? null,
		p.title,
		p.severity ?? "suggestion",
		p.summary ?? p.title,
		p.status ?? "open",
		p.inputKey ?? `ik-${p.id}`,
	);
}
