import type { ExtensionAPI, ExtensionCommandContext } from "../pi-stubs.js";
import Database from "better-sqlite3";
import { migrate } from "../db/schema.js";
import { listProposals, acceptProposal, rejectProposal, getSessionLabels } from "../db/queries.js";
import type { DecisionInput } from "../db/queries.js";
import { getNode } from "../db/analysis-queries.js";
import { getDbPath } from "../config.js";
import type { Proposal } from "../types.js";
import { homedir } from "node:os";

function output(ctx: ExtensionCommandContext, text: string, level: "info" | "warning" | "error" = "info"): void {
	ctx.ui.notify(text, level);
	console.log(text);
}

const PROPOSAL_STATUSES = new Set(["open", "applied", "rejected", "duplicate"]);

/**
 * Parse the `proposals` argument string into an optional status filter and a
 * `full` flag. Accepts a status word (open|applied|rejected|duplicate) and/or
 * `--full`/`-v`/`--verbose`, in any order; unknown tokens are ignored.
 */
export function parseProposalsArgs(args: string): { status?: string; full: boolean } {
	let status: string | undefined;
	let full = false;
	for (const tok of (args ?? "").trim().split(/\s+/).filter(Boolean)) {
		const t = tok.toLowerCase();
		if (t === "--full" || t === "-v" || t === "--verbose") full = true;
		else if (PROPOSAL_STATUSES.has(t)) status = t;
	}
	return { status, full };
}

/**
 * Parse `<id> [--planned|--done|--done-differently] [rationale...]` for the
 * accept/reject commands. The first token is the proposal id; an optional
 * disposition flag may appear anywhere; everything else is the free-text
 * rationale. id-only invocations remain valid (empty decision payload).
 */
export function parseDecisionArgs(args: string): { id?: string; input: DecisionInput } {
	const toks = (args ?? "").trim().split(/\s+/).filter(Boolean);
	const id = toks.shift();
	let disposition: DecisionInput["disposition"] = null;
	const rest: string[] = [];
	for (const tok of toks) {
		const t = tok.toLowerCase();
		if (t === "--planned") disposition = "planned";
		else if (t === "--done") disposition = "done";
		else if (t === "--done-differently" || t === "--done_differently") disposition = "done_differently";
		else rest.push(tok);
	}
	const rationale = rest.join(" ").trim();
	return { id, input: { disposition, rationale: rationale.length > 0 ? rationale : null } };
}

function formatConfidence(confidence: number | null): string {
	return confidence == null ? "n/a" : `${Math.round(confidence * 100)}%`;
}

function formatTarget(p: Proposal): string {
	return p.target_path ? `${p.target_type}: ${p.target_path}` : p.target_type;
}

/**
 * The headline score label for a proposal. A replay-validated proposal shows its
 * grounded outcome (`supported`/`unsupported`) and score; an unvalidated one
 * falls back to the model's self-rated confidence, clearly marked as such so the
 * two are never confused.
 */
export function statusLabel(p: Proposal): string {
	if (p.validation_status === "supported" || p.validation_status === "unsupported") {
		const pct = p.validated_score == null ? "n/a" : `${Math.round(p.validated_score * 100)}%`;
		return `replay-validated:${p.validation_status} ${pct}`;
	}
	return `model-rated ${formatConfidence(p.confidence)}`;
}

/**
 * Tiered ranking so the user acts on the most trustworthy proposals first:
 *   supported (by validated score)  >  unvalidated (by model confidence)  >
 *   unsupported (by validated score).
 * A replay-validated failure therefore sinks below an untested proposal, and a
 * replay-validated success rises above everything. Ties broken by newest.
 */
function rankKey(p: Proposal): number {
	if (p.validation_status === "supported") return 2 + (p.validated_score ?? 0);
	if (p.validation_status === "unsupported") return p.validated_score ?? 0;
	return 1 + (p.confidence ?? 0);
}

export function rankProposals(a: Proposal, b: Proposal): number {
	const ka = rankKey(a);
	const kb = rankKey(b);
	if (kb !== ka) return kb - ka;
	if (a.created_at === b.created_at) return 0;
	return a.created_at < b.created_at ? 1 : -1;
}

function severityLabel(severity: string): string {
	if (severity === "reinforcement") return "reinforce";
	return severity;
}

function conciseEntry(p: Proposal): string {
	return `  [${p.status}] ${statusLabel(p)} · ${severityLabel(p.severity)} · ${formatTarget(p)}\n    ${p.title}\n    ${p.summary}\n    id: ${p.id}  ·  prospect show ${p.id}`;
}

/** A one-line with/without replay summary, read from the validation node. */
function validationDeltaLine(db: Database.Database, p: Proposal): string | null {
	if (!p.validation_node_id) return null;
	const node = getNode(db, p.validation_node_id);
	if (!node) return null;
	try {
		const c = JSON.parse(node.content_json) as {
			replay_turn_count?: number;
			baseline_friction_turns?: number;
			averted_turns?: number;
			validator_model?: string;
		};
		return (
			`validation: ${c.averted_turns ?? 0}/${c.baseline_friction_turns ?? 0} friction turn(s) averted ` +
			`across ${c.replay_turn_count ?? 0} replayed (model ${c.validator_model ?? "?"})`
		);
	} catch {
		return null;
	}
}

function fullEntry(db: Database.Database, p: Proposal): string {
	const lines = [conciseEntry(p)];
	const delta = validationDeltaLine(db, p);
	if (delta) lines.push(`    ${delta}`);
	if (p.detail && p.detail.trim()) lines.push(`    detail:   ${p.detail.trim()}`);
	if (p.evidence && p.evidence.trim()) lines.push(`    evidence: ${p.evidence.trim()}`);
	lines.push(`    source:   ${p.analyzer_id ?? "?"} · node ${p.source_node_id ?? "?"}`);
	return lines.join("\n");
}

/** A short, readable session label: cwd (with $HOME → ~), else project, else id. */
export function sessionLabel(s: { project: string; cwd: string } | undefined, id: string): string {
	const home = homedir();
	if (s?.cwd) return s.cwd.startsWith(home) ? `~${s.cwd.slice(home.length)}` : s.cwd;
	if (s?.project) return s.project;
	return id.slice(0, 8);
}

export async function prospectProposals(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const db = new Database(getDbPath());
	migrate(db);
	try {
		const { status, full } = parseProposalsArgs(args);
		const proposals = listProposals(db, status).sort(rankProposals);

		if (proposals.length === 0) {
			output(ctx, status ? `No ${status} proposals found.` : "No proposals found.");
			return;
		}

		const labels = new Map(getSessionLabels(db).map((s) => [s.id, s]));

		// Group by session. Because `proposals` is already globally ranked by
		// confidence, first-seen order puts the session with the strongest single
		// recommendation first, and each group stays confidence-ranked within.
		const groups = new Map<string, Proposal[]>();
		for (const p of proposals) {
			const bucket = groups.get(p.session_id);
			if (bucket) bucket.push(p);
			else groups.set(p.session_id, [p]);
		}

		const format = full ? (p: Proposal) => fullEntry(db, p) : conciseEntry;
		const blocks: string[] = [];
		for (const [sessionId, group] of groups) {
			const label = sessionLabel(labels.get(sessionId), sessionId);
			const header = `═══ ${sessionId.slice(0, 8)} · ${label} · ${group.length} proposal(s) ═══`;
			blocks.push(`${header}\n${group.map(format).join("\n\n")}`);
		}

		const headline = `Proposals (${proposals.length}${status ? `, ${status}` : ""}) in ${groups.size} session(s), ranked by validated score then confidence:`;
		output(ctx, `${headline}\n\n${blocks.join("\n\n")}`);
	} finally {
		db.close();
	}
}

export async function prospectAccept(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const { id, input } = parseDecisionArgs(args);
	if (!id) {
		output(ctx, "Usage: /prospect-accept <id> [--planned|--done|--done-differently] [rationale...]", "warning");
		return;
	}
	const db = new Database(getDbPath());
	migrate(db);
	try {
		const ok = acceptProposal(db, id, input);
		output(ctx, ok ? `Proposal ${id} applied.` : `Proposal ${id} not found or not open.`, ok ? "info" : "warning");
	} finally {
		db.close();
	}
}

export async function prospectReject(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const { id, input } = parseDecisionArgs(args);
	if (!id) {
		output(ctx, "Usage: /prospect-reject <id> [rationale...]", "warning");
		return;
	}
	const db = new Database(getDbPath());
	migrate(db);
	try {
		const ok = rejectProposal(db, id, input);
		output(ctx, ok ? `Proposal ${id} rejected.` : `Proposal ${id} not found or not open.`, ok ? "info" : "warning");
	} finally {
		db.close();
	}
}

export function registerProposalsCommand(pi: ExtensionAPI): void {
	pi.registerCommand("prospect-proposals", {
		description:
			"List proposals, ranked by confidence. Optional status filter (open|applied|rejected|duplicate) and --full for evidence/source.",
		handler: prospectProposals,
	});

	pi.registerCommand("prospect-accept", {
		description: "Accept (apply) a proposal by ID",
		handler: prospectAccept,
	});

	pi.registerCommand("prospect-reject", {
		description: "Reject a proposal by ID",
		handler: prospectReject,
	});
}
