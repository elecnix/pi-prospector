import type { ExtensionAPI, ExtensionCommandContext } from "../pi-stubs.js";
import Database from "better-sqlite3";
import { migrate } from "../db/schema.js";
import { listProposals, listProposalsAsOf, acceptProposal, rejectProposal, acceptProposalsWithRemediation, getSessionLabels, getLatestDecision } from "../db/queries.js";
import type { DecisionInput } from "../db/queries.js";
import { getNode } from "../db/analysis-queries.js";
import { getDbPath } from "../config.js";
import { parseFlags, resolveTimepoint } from "../timepoint.js";
import type { Proposal, ProposalDecision } from "../types.js";
import { parseHarnessSource, harnessLabel } from "../harness.js";
import { homedir } from "node:os";

function output(ctx: ExtensionCommandContext, text: string, level: "info" | "warning" | "error" = "info"): void {
	ctx.ui.notify(text, level);
	console.log(text);
}

const PROPOSAL_STATUSES = new Set(["open", "applied", "rejected", "duplicate"]);
const PROPOSAL_SEVERITIES = new Set<string>(["friction", "correction", "waste", "suggestion", "reinforcement"]);

/**
 * Parse the `proposals` argument string into optional status/severity filters
 * and a `full` flag. Accepts a status word (open|applied|rejected|duplicate),
 * `--severity <friction|correction|waste|suggestion|reinforcement>`, and/or
 * `--full`/`-v`/`--verbose`, in any order. Unknown tokens — and an unknown
 * `--severity` value — are ignored, mirroring the status filter.
 */
export function parseProposalsArgs(args: string): { status?: string; severity?: string; full: boolean } {
	let status: string | undefined;
	let severity: string | undefined;
	let full = false;
	const toks = (args ?? "").trim().split(/\s+/).filter(Boolean);
	for (let i = 0; i < toks.length; i++) {
		const t = toks[i]!.toLowerCase();
		if (t === "--full" || t === "-v" || t === "--verbose") full = true;
		else if (t === "--severity") {
			// The following token is the value; consume it even when invalid so it
			// is never mistaken for a status word.
			const val = toks[i + 1]?.toLowerCase();
			if (val && PROPOSAL_SEVERITIES.has(val)) severity = val;
			i++;
		} else if (PROPOSAL_STATUSES.has(t)) status = t;
	}
	return { status, severity, full };
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

/**
 * A token counts as a proposal id when it is made of id characters AND carries
 * at least one digit — every uuidv7 does, while the words a remediation
 * description starts with ("added", "capped", …) almost never do. This is what
 * lets `/prospect-remediate` take ids and free text without a separator.
 */
function looksLikeProposalId(token: string): boolean {
	return /^[0-9a-z-]+$/i.test(token) && /\d/.test(token);
}

/**
 * Parse `<id> <id>... [--planned|--done|--done-differently] <description...>`
 * for the remediate command. Leading id-like tokens are the proposal ids; the
 * first wordy token switches to description mode (all later tokens join it,
 * id-like or not); the disposition flag is recognised anywhere, as in
 * parseDecisionArgs.
 */
export function parseRemediateArgs(args: string): {
	ids: string[];
	disposition: DecisionInput["disposition"];
	description: string | null;
} {
	const toks = (args ?? "").trim().split(/\s+/).filter(Boolean);
	const ids: string[] = [];
	let disposition: DecisionInput["disposition"] = null;
	const rest: string[] = [];
	let inDescription = false;
	for (const tok of toks) {
		const t = tok.toLowerCase();
		if (t === "--planned") disposition = "planned";
		else if (t === "--done") disposition = "done";
		else if (t === "--done-differently" || t === "--done_differently") disposition = "done_differently";
		else if (!inDescription && looksLikeProposalId(tok)) ids.push(tok);
		else {
			inDescription = true;
			rest.push(tok);
		}
	}
	const description = rest.join(" ").trim();
	return { ids, disposition, description: description.length > 0 ? description : null };
}

function formatConfidence(confidence: number | null): string {
	return confidence == null ? "n/a" : `${Math.round(confidence * 100)}%`;
}

/** Format a billed dollar amount compactly: two decimals, sub-cent at precision 2. */
export function formatUsd(usd: number): string {
	return `$${usd < 0.01 ? usd.toPrecision(2) : usd.toFixed(2)}`;
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
	let label: string;
	if (p.validation_status === "supported" || p.validation_status === "unsupported") {
		const pct = p.validated_score == null ? "n/a" : `${Math.round(p.validated_score * 100)}%`;
		label = `replay-validated:${p.validation_status} ${pct}`;
	} else {
		label = `model-rated ${formatConfidence(p.confidence)}`;
	}
	// Money is a headline signal (issue #71): surface the billed cost of the
	// proposal's source turns when one is recorded, so a user can see at a glance
	// what a finding cost.
	if (p.cost_usd != null) label += ` · ${formatUsd(p.cost_usd)}`;
	return label;
}

/**
 * Tiered ranking so the user acts on the most trustworthy proposals first:
 *   supported (by validated score)  >  unvalidated (by model confidence)  >
 *   unsupported (by validated score).
 * A replay-validated failure therefore sinks below an untested proposal, and a
 * replay-validated success rises above everything.
 *
 * Within a tier (issue #71), money is the tie-breaker: a replay-validated
 * finding is still better evidence than an expensive unvalidated one, so the
 * trust tier stays authoritative — but once two proposals share a tier, the
 * pricier one sorts first. A stuck loop stops being "repeated 9×" and becomes
 * an amount. Unpriced proposals (null) rank below priced ones in their tier.
 * Final ties broken by newest.
 */
function rankTier(p: Proposal): number {
	if (p.validation_status === "supported") return 2;
	if (p.validation_status === "unsupported") return 0;
	return 1;
}
function scoreKey(p: Proposal): number {
	if (p.validation_status === "supported" || p.validation_status === "unsupported") return p.validated_score ?? 0;
	return p.confidence ?? 0;
}

export function rankProposals(a: Proposal, b: Proposal): number {
	const ta = rankTier(a);
	const tb = rankTier(b);
	if (tb !== ta) return tb - ta;
	// Trust tier equal → money is the tie-breaker: pricier first, unpriced last.
	const ca = a.cost_usd ?? -1;
	const cb = b.cost_usd ?? -1;
	if (cb !== ca) return cb - ca;
	const sa = scoreKey(a);
	const sb = scoreKey(b);
	if (sb !== sa) return sb - sa;
	if (a.created_at === b.created_at) return 0;
	return a.created_at < b.created_at ? 1 : -1;
}

function severityLabel(severity: string): string {
	if (severity === "reinforcement") return "reinforce";
	return severity;
}

export function conciseEntry(p: Proposal, decision?: ProposalDecision): string {
	const base = `  [${p.status}] ${statusLabel(p)} · ${severityLabel(p.severity)} · ${formatTarget(p)}\n    ${p.title}\n    ${p.summary}\n    id: ${p.id}  ·  prospect show ${p.id}`;
	return decision ? `${base}\n    ${formatDecisionLine(decision)}` : base;
}

/**
 * One-line render of the latest human decision on a proposal — the durable
 * memory that survives recompute. Shows the verdict, how it was acted on
 * (disposition), the reasoning, and what was actually changed.
 */
export function formatDecisionLine(d: ProposalDecision): string {
	const disp = d.disposition ? ` (${d.disposition})` : "";
	const why = d.rationale ? ` — ${d.rationale}` : "";
	const change = d.actual_change ? ` [${d.actual_change}]` : "";
	// The shared remediation id groups this decision with the other proposals
	// that were addressed by the same action.
	const rem = d.remediation_id ? ` · remediation ${d.remediation_id}` : "";
	return `decision: ${d.decision}${disp}${why}${change}${rem}`;
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

function fullEntry(db: Database.Database, p: Proposal, decision?: ProposalDecision): string {
	const lines = [conciseEntry(p, decision)];
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

/**
 * The group header for a session's proposals, with the coding harness shown as
 * `[Pi]`/`[Claude]` so a reader always knows which host the proposals came from.
 * A session with no recorded source shows `[unknown]` rather than being guessed.
 */
export function sessionGroupHeader(s: { project: string; cwd: string; source?: string } | undefined, id: string, count: number): string {
	const harness = `[${harnessLabel(s?.source)}]`;
	const label = sessionLabel(s, id);
	return `═══ ${id.slice(0, 8)} ${harness} · ${label} · ${count} proposal(s) ═══`;
}

export async function prospectProposals(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const db = new Database(getDbPath());
	migrate(db);
	try {
		const { status, severity, full } = parseProposalsArgs(args);
		const { flags } = parseFlags(args ?? "");
		// Optional harness filter: --source pi|claude. Unknown values throw, so a
		// typo fails loudly rather than silently matching nothing.
		const source = parseHarnessSource(flags["source"]);
		let asOfLabel: string | undefined;
		let proposals: Proposal[] = [];
		const tp = resolveTimepoint(db, flags);
		if (tp) {
			asOfLabel = tp.source;
			const all = listProposalsAsOf(db, tp.at, source);
			proposals = all.filter((p) => (!status || p.status === status) && (!severity || p.severity === severity));
		} else {
			proposals = listProposals(db, status, severity, undefined, undefined, source);
		}
		proposals = proposals.sort(rankProposals);
		const filterDesc = [status, severity, source ? `source ${source}` : undefined].filter(Boolean).join(" ");

		if (proposals.length === 0) {
			output(ctx, filterDesc ? `No ${filterDesc} proposals found.` : "No proposals found.");
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

		const format = full
			? (p: Proposal) => fullEntry(db, p, getLatestDecision(db, p.input_key))
			: (p: Proposal) => conciseEntry(p, getLatestDecision(db, p.input_key));
		const blocks: string[] = [];
		for (const [sessionId, group] of groups) {
			const header = sessionGroupHeader(labels.get(sessionId), sessionId, group.length);
			blocks.push(`${header}\n${group.map(format).join("\n\n")}`);
		}

		const headline = `Proposals (${proposals.length}${filterDesc ? `, ${filterDesc}` : ""}) in ${groups.size} session(s), ranked by validation, then cost, then confidence:${asOfLabel ? `\n  (VIEW ${asOfLabel} — status reconstructed from decisions, not current state)` : ""}`;
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

export async function prospectRemediate(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const { ids, disposition, description } = parseRemediateArgs(args);
	if (ids.length === 0 || !description) {
		output(
			ctx,
			"Usage: /prospect-remediate <id> <id>... [--planned|--done|--done-differently] <description of the one action that addresses them all>",
			"warning",
		);
		return;
	}
	const db = new Database(getDbPath());
	migrate(db);
	try {
		const res = acceptProposalsWithRemediation(db, ids, { description }, { disposition });
		if (!res.remediationId) {
			output(ctx, `No open proposal among: ${ids.join(", ")}. Nothing applied.`, "warning");
			return;
		}
		const lines = [`Remediation ${res.remediationId} applied to ${res.accepted.length} proposal(s): ${res.accepted.join(", ")}`];
		if (res.skipped.length > 0) lines.push(`Skipped (not found or not open): ${res.skipped.join(", ")}`);
		output(ctx, lines.join("\n"));
	} finally {
		db.close();
	}
}

export function registerProposalsCommand(pi: ExtensionAPI): void {
	pi.registerCommand("prospect-proposals", {
		description:
			"List proposals, ranked by trust tier (replay-validated) then billed cost, then confidence. Optional status filter (open|applied|rejected|duplicate), --severity <friction|correction|waste|suggestion|reinforcement>, --source <pi|claude>, and --full for evidence/source.",
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

	pi.registerCommand("prospect-remediate", {
		description: "Accept many proposals at once under ONE shared remediation action: <id> <id>... [--planned|--done|--done-differently] <description>",
		handler: prospectRemediate,
	});
}
