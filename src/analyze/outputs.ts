/**
 * The output runner — resolving `<analyzer>:<output>` addresses and rendering.
 *
 * Rendering is a pure read of the graph. Nothing here writes a node, a run, or a
 * proposal, so an output can be re-rendered as often as a reader likes and the
 * append-only history is untouched. That is the whole reason outputs are a
 * separate concept from analysis rather than a node kind: a node has to be
 * earned once and kept, a file should be cheap and thrown away.
 */

import type Database from "better-sqlite3";
import { getLatestNodesByAnalyzerAcrossSessions } from "../db/analysis-queries.js";
import type {
	Analyzer,
	AnalyzerOutput,
	AnalyzerOutputContext,
	AnalysisNodeRow,
	OutputArtifact,
} from "./types.js";

/** An output paired with the analyzer that owns it. */
export interface ResolvedOutput {
	analyzer: Analyzer;
	output: AnalyzerOutput;
	/** The canonical `<analyzer-id>:<output-id>` address. */
	address: string;
}

/** Every output every registered analyzer declares, in registration order. */
export function listOutputs(analyzers: readonly Analyzer[]): ResolvedOutput[] {
	const out: ResolvedOutput[] = [];
	for (const analyzer of analyzers) {
		for (const output of analyzer.outputs ?? []) {
			out.push({ analyzer, output, address: `${analyzer.def.id}:${output.def.id}` });
		}
	}
	return out;
}

/**
 * Resolve a caller's spec against the registered analyzers.
 *
 * Accepted forms, most specific first:
 *   `analyzer:output`  one output
 *   `analyzer`         every output that analyzer declares
 *   `output`           an output id, when exactly one analyzer declares it
 *
 * The bare-id form is a convenience that refuses to guess: if two analyzers
 * declare the same output id, it throws naming both addresses rather than
 * picking the first and rendering something the caller did not ask for.
 */
export function resolveOutputs(analyzers: readonly Analyzer[], spec: string): ResolvedOutput[] {
	const all = listOutputs(analyzers);
	const trimmed = spec.trim();
	if (!trimmed) throw new Error("No output requested. Pass an analyzer id, an output id, or 'analyzer:output'.");

	if (trimmed.includes(":")) {
		const idx = trimmed.indexOf(":");
		const analyzerId = trimmed.slice(0, idx);
		const outputId = trimmed.slice(idx + 1);
		const hit = all.filter((o) => o.analyzer.def.id === analyzerId && o.output.def.id === outputId);
		if (hit.length === 0) throw new Error(unknownMessage(trimmed, all));
		return hit;
	}

	const byAnalyzer = all.filter((o) => o.analyzer.def.id === trimmed);
	if (byAnalyzer.length > 0) return byAnalyzer;

	const byOutput = all.filter((o) => o.output.def.id === trimmed);
	if (byOutput.length > 1) {
		throw new Error(
			`Output id '${trimmed}' is declared by more than one analyzer (${byOutput.map((o) => o.address).join(", ")}). ` +
			`Name the one you want.`,
		);
	}
	if (byOutput.length === 1) return byOutput;

	throw new Error(unknownMessage(trimmed, all));
}

function unknownMessage(spec: string, all: ResolvedOutput[]): string {
	const known = all.length > 0 ? all.map((o) => o.address).join(", ") : "none are registered";
	return `Unknown output '${spec}'. Available: ${known}.`;
}

export interface RenderOptions {
	db: Database.Database;
	/** Caller-supplied knobs passed straight through to the output. */
	options?: Record<string, string>;
	/** Read the graph as it stood at this instant. */
	asOf?: string;
	/** Resolved analyzer configs by analyzer id; defaults are used when absent. */
	configs?: Record<string, Record<string, unknown>>;
}

export interface RenderResult {
	address: string;
	label: string;
	artifacts: OutputArtifact[];
}

/**
 * Render the resolved outputs. Node reads are memoised for the whole call, so a
 * report that folds three analyzers' nodes queries each of them once even when
 * several outputs run together.
 */
export async function renderOutputs(
	resolved: readonly ResolvedOutput[],
	opts: RenderOptions,
): Promise<RenderResult[]> {
	const cache = new Map<string, AnalysisNodeRow[]>();
	const getNodes = (analyzerId: string): AnalysisNodeRow[] => {
		const cached = cache.get(analyzerId);
		if (cached) return cached;
		const rows = getLatestNodesByAnalyzerAcrossSessions(opts.db, analyzerId, opts.asOf);
		cache.set(analyzerId, rows);
		return rows;
	};

	const results: RenderResult[] = [];
	for (const item of resolved) {
		const analyzerId = item.analyzer.def.id;
		const ctx: AnalyzerOutputContext = {
			db: opts.db,
			// Lazy: an output that only folds another analyzer's nodes — or none at
			// all — should not pay for a corpus-wide query it never reads.
			get ownNodes(): AnalysisNodeRow[] {
				return getNodes(analyzerId);
			},
			getNodes,
			config: opts.configs?.[analyzerId] ?? item.analyzer.defaultConfig.configJson ?? {},
			options: opts.options ?? {},
			asOf: opts.asOf,
		};
		const artifacts = await item.output.render(ctx);
		results.push({ address: item.address, label: item.output.def.label, artifacts });
	}
	return results;
}

/**
 * Keep only the newest node per session.
 *
 * Read this before folding node values into a total. `getNodes` returns the
 * newest node per *logical unit*, and a unit is a source set — not a session. An
 * analyzer whose `sourceSetHash` encodes how far a session had got (so that
 * appending turns produces a fresh node rather than leaving a stale total
 * standing) therefore has one live node per *generation* of that session, and
 * every one of them is legitimately current. Summing them counts the session
 * once per generation.
 *
 * That is invisible until a session is analysed twice, which is exactly what
 * happens to a session still running when the report is built — so it shows up
 * as a number that is quietly too high, on the days a reader cares most about.
 * Any output that sums per-session measurements wants this; one that is already
 * per-unit (a per-turn classification, say) does not.
 */
export function latestBySession(nodes: readonly AnalysisNodeRow[]): AnalysisNodeRow[] {
	const newest = new Map<string, AnalysisNodeRow>();
	for (const node of nodes) {
		const held = newest.get(node.session_id);
		// The corpus read is ordered oldest-first, but do not lean on that: compare.
		if (!held || node.created_at > held.created_at || (node.created_at === held.created_at && node.id > held.id)) {
			newest.set(node.session_id, node);
		}
	}
	return [...newest.values()];
}

/**
 * Reject a malformed `outputs` declaration at load time. Returns null when the
 * analyzer is fine, so it composes with the loader's other shape checks.
 */
export function validateOutputs(analyzer: Analyzer): string | null {
	const outputs = analyzer.outputs;
	if (outputs === undefined) return null;
	if (!Array.isArray(outputs)) return "outputs must be an array when present";

	const seen = new Set<string>();
	for (const [i, output] of outputs.entries()) {
		if (!output || typeof output !== "object") return `outputs[${i}] must be an object`;
		const def = output.def;
		if (!def || typeof def.id !== "string" || def.id.trim() === "") return `outputs[${i}].def.id must be a non-empty string`;
		if (def.id.includes(":")) return `outputs[${i}].def.id must not contain ':' (it separates analyzer from output)`;
		if (typeof def.label !== "string" || def.label.trim() === "") return `outputs[${i}].def.label must be a non-empty string`;
		if (typeof output.render !== "function") return `outputs[${i}].render must be a function`;
		if (seen.has(def.id)) return `duplicate output id '${def.id}'`;
		seen.add(def.id);
	}
	return null;
}
