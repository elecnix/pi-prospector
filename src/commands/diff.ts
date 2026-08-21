/**
 * `prospect diff` — compare analysis nodes across versions, runs, and points in
 * time.
 *
 * Content-addressing makes a difference *attributable*, not merely visible:
 *   - same `input_key`, different `output_key` → identical recipe, the model
 *     reached a different conclusion;
 *   - different `input_key` → the recipe changed; its components (analyzer
 *     version, config fingerprint, source-set hash) say *why*.
 *
 * Modes (builds on as-of reads, see src/timepoint.ts):
 *   prospect diff --unit <analyzer> <source_set_hash>
 *       the `revises` chain of one logical unit, consecutive versions compared
 *   prospect diff --runs <A> <B>
 *       what two runs concluded differently (added/removed/changed nodes)
 *   prospect diff --as-of <T1> <T2>
 *       the graph at two points in time: per-unit added / removed / changed
 *
 * Default output is a per-analyzer summary of added/removed/changed counts;
 * `--full` (or a `--unit` selector) gives per-node structural detail. Node
 * content is canonical JSON, so comparison is structural (changed fields), not
 * line-based.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "../pi-stubs.js";
import { openAsyncDatabase, type AsyncDatabase } from "../db/async-db.js";
import { migrate } from "../db/schema.js";
import {
	getAllAnalysisNodes,
	getNodeVersions,
} from "../db/analysis-queries.js";
import { getDbPath } from "../config.js";
import { parseFlags, parseTimestamp } from "../timepoint.js";
import type { AnalysisNodeRow } from "../analyze/types.js";

function output(ctx: ExtensionCommandContext, text: string, level: "info" | "warning" | "error" = "info"): void {
	ctx.ui.notify(text, level);
	console.log(text);
}

function short(s: string, n = 8): string {
	return s.length > n ? s.slice(0, n) : s;
}

/** Top-level keys whose value (or presence) differs between two content objects. */
function structuralDiffFields(aJson: string, bJson: string): string[] {
	let a: Record<string, unknown>;
	let b: Record<string, unknown>;
	try {
		a = JSON.parse(aJson) as Record<string, unknown>;
	} catch {
		a = {};
	}
	try {
		b = JSON.parse(bJson) as Record<string, unknown>;
	} catch {
		b = {};
	}
	const fields = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
	const changed: string[] = [];
	for (const k of fields) {
		const so = JSON.stringify(a[k]);
		const st = JSON.stringify(b[k]);
		if (so !== st) changed.push(k);
	}
	return changed.sort();
}

interface ChangeSummary {
	analyzerId: string;
	added: number;
	removed: number;
	changed: number;
}

function summarize(entries: Array<{ analyzerId: string; kind: "added" | "removed" | "changed" }>): ChangeSummary[] {
	const by = new Map<string, ChangeSummary>();
	for (const e of entries) {
		let s = by.get(e.analyzerId);
		if (!s) {
			s = { analyzerId: e.analyzerId, added: 0, removed: 0, changed: 0 };
			by.set(e.analyzerId, s);
		}
		s[e.kind]++;
	}
	return [...by.values()].sort((a, b) => a.analyzerId.localeCompare(b.analyzerId));
}

function renderSummary(entries: Array<{ analyzerId: string; kind: "added" | "removed" | "changed" }>): string[] {
	const sums = summarize(entries);
	if (sums.length === 0) return ["  (no differences)"];
	return sums.map((s) => `  ${s.analyzerId}: +${s.added} added, -${s.removed} removed, ~${s.changed} changed`);
}

/** Latest node for each logical unit (analyzer + source set) at or before `t`. */
function latestByUnitAt(rows: AnalysisNodeRow[], t: string): Map<string, AnalysisNodeRow> {
	const byUnit = new Map<string, AnalysisNodeRow>();
	for (const n of rows) {
		if (!n.created_at || n.created_at > t) continue;
		const key = `${n.analyzer_id}\u0000${n.source_set_hash}`;
		const cur = byUnit.get(key);
		if (!cur || n.created_at > cur.created_at || (n.created_at === cur.created_at && n.output_key > cur.output_key)) {
			byUnit.set(key, n);
		}
	}
	return byUnit;
}

/**
 * The recipe "why" for a changed node pair with different input keys: which of
 * analyzer version / config fingerprint / source set moved.
 */
function recipeReason(a: AnalysisNodeRow, b: AnalysisNodeRow): string[] {
	const reasons: string[] = [];
	if (a.analyzer_version_id !== b.analyzer_version_id) reasons.push("analyzer-version");
	if (a.config_fingerprint !== b.config_fingerprint) reasons.push("config");
	if (a.source_set_hash !== b.source_set_hash) reasons.push("source-set");
	return reasons;
}

// ─────────────────────────── --unit ───────────────────────────

async function diffUnit(db: AsyncDatabase, analyzerId: string, sourceSetHash: string, full: boolean): Promise<string[]> {
	const versions = await getNodeVersions(db, analyzerId, sourceSetHash);
	if (versions.length === 0) return [`  no nodes for unit ${analyzerId} · ${short(sourceSetHash, 12)}`];
	const lines: string[] = [];
	for (let i = 1; i < versions.length; i++) {
		const older = versions[i - 1]!;
		const newer = versions[i]!;
		const sameRecipe = older.input_key === newer.input_key;
		if (sameRecipe) {
			lines.push(
				`  v${i} → v${i + 1}  same recipe (${short(older.input_key, 10)}) — different conclusion (same input_key, different output_key)`,
			);
		} else {
			const why = recipeReason(older, newer).join(", ") || "recipe";
			lines.push(`  v${i} → v${i + 1}  recipe changed (${why})`);
		}
		if (full) {
			const fields = structuralDiffFields(older.content_json, newer.content_json);
			if (fields.length === 0) lines.push(`      (no top-level field differences)`);
			else lines.push(`      changed fields: ${fields.join(", ")}`);
		}
	}
	if (versions.length === 1) lines.push("  single version — nothing to diff against");
	return lines;
}

// ─────────────────────────── --runs ───────────────────────────

async function diffRuns(db: AsyncDatabase, runA: string, runB: string, full: boolean): Promise<string[]> {
	const aNodes = (await db
		.prepare("SELECT * FROM analysis_nodes WHERE run_id = ?")
		.all(runA)) as AnalysisNodeRow[];
	const bNodes = (await db
		.prepare("SELECT * FROM analysis_nodes WHERE run_id = ?")
		.all(runB)) as AnalysisNodeRow[];
	const aByKey = new Map(aNodes.map((n) => [n.input_key, n]));
	const bByKey = new Map(bNodes.map((n) => [n.input_key, n]));

	const entries: Array<{ analyzerId: string; kind: "added" | "removed" | "changed" }> = [];
	const details: string[] = [];
	for (const [key, bn] of bByKey) {
		const an = aByKey.get(key);
		if (!an) {
			entries.push({ analyzerId: bn.analyzer_id, kind: "added" });
		} else if (an.output_key !== bn.output_key) {
			entries.push({ analyzerId: bn.analyzer_id, kind: "changed" });
			if (full) {
				const fields = structuralDiffFields(an.content_json, bn.content_json);
				details.push(`  changed ${bn.analyzer_id} ${short(key, 10)} fields: ${fields.join(", ") || "(none)"}`);
			}
		}
	}
	for (const [key, an] of aByKey) {
		if (!bByKey.has(key)) entries.push({ analyzerId: an.analyzer_id, kind: "removed" });
	}
	const lines = [`  run ${short(runA)} vs run ${short(runB)}:`];
	lines.push(...renderSummary(entries));
	if (full && details.length) lines.push("", ...details);
	return lines;
}

// ─────────────────────────── --as-of ───────────────────────────

async function diffAsOf(db: AsyncDatabase, t1: string, t2: string, full: boolean): Promise<string[]> {
	const at1 = latestByUnitAt(await getAllAnalysisNodes(db), t1);
	const at2 = latestByUnitAt(await getAllAnalysisNodes(db), t2);
	if (at1.size === 0 && at2.size === 0) return ["  no analysis nodes at either timepoint"];

	const entries: Array<{ analyzerId: string; kind: "added" | "removed" | "changed" }> = [];
	const details: string[] = [];
	const allKeys = new Set<string>([...at1.keys(), ...at2.keys()]);
	for (const key of allKeys) {
		const n1 = at1.get(key);
		const n2 = at2.get(key);
		if (n1 && n2) {
			if (n1.output_key !== n2.output_key) {
				entries.push({ analyzerId: n2.analyzer_id, kind: "changed" });
				if (full) {
					const sameRecipe = n1.input_key === n2.input_key;
					const why = sameRecipe ? "same recipe, different conclusion" : `recipe changed (${recipeReason(n1, n2).join(", ")})`;
					const fields = structuralDiffFields(n1.content_json, n2.content_json);
					details.push(`  changed ${n2.analyzer_id} ${short(n2.source_set_hash, 8)} — ${why}; fields: ${fields.join(", ") || "(none)"}`);
				}
			}
		} else if (n2) {
			entries.push({ analyzerId: n2.analyzer_id, kind: "added" });
			if (full) details.push(`  added   ${n2.analyzer_id} ${short(n2.source_set_hash, 8)} output=${short(n2.output_key, 10)}`);
		} else if (n1) {
			entries.push({ analyzerId: n1.analyzer_id, kind: "removed" });
			if (full) details.push(`  removed ${n1.analyzer_id} ${short(n1.source_set_hash, 8)}`);
		}
	}
	const lines = [`  $T_1$ vs $T_2$:`].map((l) => l.replace("$T_1$", short(t1, 10)).replace("$T_2$", short(t2, 10)));
	lines.push(...renderSummary(entries));
	if (full && details.length) lines.push("", ...details);
	return lines;
}

// ─────────────────────────── dispatch ───────────────────────────

export async function prospectDiff(rawArgs: string, ctx: ExtensionCommandContext): Promise<void> {
	const { positionals, flags } = parseFlags(rawArgs ?? "");
	const full = flags["full"] !== undefined;

	const db = openAsyncDatabase(getDbPath());
	await migrate(db);
	try {
		const header: string[] = [];
		let body: string[];

		if (flags["unit"] !== undefined) {
			const analyzerId = flags["unit"];
			const sset = positionals[0];
			if (!sset) {
				output(ctx, "Usage: prospect diff --unit <analyzer> <source_set_hash> [--full]", "warning");
				return;
			}
			body = await diffUnit(db, analyzerId, sset, full);
		} else if (flags["runs"] !== undefined) {
			const runIds = [flags["runs"], ...positionals].filter(Boolean);
			if (runIds.length !== 2) {
				output(ctx, "Usage: prospect diff --runs <runA> <runB> [--full]", "warning");
				return;
			}
			body = await diffRuns(db, runIds[0]!, runIds[1]!, full);
		} else if (flags["as-of"] !== undefined) {
			const pair = [flags["as-of"], ...positionals].filter(Boolean);
			if (pair.length !== 2) {
				output(ctx, "Usage: prospect diff --as-of <T1> <T2> [--full]  (ISO or relative like 7d)", "warning");
				return;
			}
			body = await diffAsOf(db, parseTimestamp(pair[0]!), parseTimestamp(pair[1]!), full);
		} else {
			output(
				ctx,
				"Usage: prospect diff --unit <analyzer> <source_set_hash> | --runs <A> <B> | --as-of <T1> <T2>  [--full]",
				"warning",
			);
			return;
		}

		output(ctx, [header.join(""), ...body].filter((l) => l !== "").join("\n"));
	} finally {
		await db.close();
	}
}

export function registerDiffCommand(pi: ExtensionAPI): void {
	pi.registerCommand("prospect-diff", {
		description:
			"Compare analysis nodes across versions, runs, and points in time. Modes: --unit <analyzer> <source_set_hash> (the revises chain), --runs <A> <B> (two runs' node sets), --as-of <T1> <T2> (graph at two times). Default shows per-analyzer added/removed/changed counts; add --full for structural per-node detail.",
		handler: prospectDiff,
	});
}
