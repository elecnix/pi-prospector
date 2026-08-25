/**
 * files-in-play — deterministic session-level file-churn detection
 * (issue #103).
 *
 * Tracks which files a session has *in play*: the set of paths its read /
 * edit / write tool calls touch, with per-file handling counts over time, so
 * churn over the same small set becomes visible — repeated read→edit→read
 * cycling where the agent keeps re-opening what it already has open instead of
 * moving forward.
 *
 * Distinct from `uncompleted-leads` (#216), which detects valuable work that
 * never happened (surfaced leads nobody pursued); this analyzer detects the
 * opposite waste: over-handling of files already in play. Both read the same
 * shared action stream but measure different things.
 *
 * Extraction and matching are fully deterministic (no LLM); the heuristic is
 * documented in `detect.ts`. One node per session: metric by default; when the
 * churn score and re-read recurrence both clear their config thresholds, the
 * node carries `improvement_proposals` and is emitted as kind `proposal`,
 * following the failure-modes/uncompleted-leads convention for deterministic
 * analyzers — the framework materialises those into the proposal store.
 */

import type {
	Analyzer,
	AnalyzerDef,
	AnalyzerPlanContext,
	AnalyzerRunContext,
	AnalyzerVersion,
	AnalysisResult,
	AnalysisUnit,
	MessageRow,
	PromptVersion,
	SourceRef,
} from "../../types.js";
import { computeConfigHash, shortHash } from "../../input-hash.js";
import {
	DEFAULT_FILES_IN_PLAY_CONFIG,
	type FilesInPlayConfig,
} from "./config.js";
import { extractFileInteractions, scanSessionChurn, churnRelevantMessageIds } from "./detect.js";
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";
import { Type, type Static } from "typebox";

/** A proposal this analyzer embeds in its node; materialised by the framework. */
export const FilesInPlayRawProposal = Type.Object({
	target_type: Type.String(),
	target_path: Type.Optional(Type.String()),
	title: Type.String(),
	summary: Type.String(),
	detail: Type.String(),
	evidence: Type.String(),
	confidence: Type.Number(),
	severity: Type.String(),
});
export type FilesInPlayRawProposal = Static<typeof FilesInPlayRawProposal>;

const TopFileSchema = Type.Object({
	path: Type.String(),
	reads: Type.Number(),
	edits: Type.Number(),
	writes: Type.Number(),
	rereads: Type.Number(),
	cycles: Type.Number(),
});

/** The properties a files-in-play node carries in its `contentJson`. */
export const FILES_IN_PLAY_PROPERTIES = Type.Object({
	session_id: Type.String(),
	/** How many distinct files the session had in play. */
	distinct_files: Type.Number(),
	/** Total file interactions extracted (reads + edits + writes). */
	interaction_count: Type.Number(),
	read_count: Type.Number(),
	edit_count: Type.Number(),
	write_count: Type.Number(),
	/** Reads of files already read before, across all files. */
	reread_events: Type.Number(),
	/** Read→edit→read cycles across all files. */
	edit_reread_cycles: Type.Number(),
	churn_windows: Type.Number(),
	churning_windows: Type.Number(),
	/** Fraction of evaluated windows classified as churning, 0–1. */
	churn_score: Type.Number(),
	top_files: Type.Array(TopFileSchema),
	improvement_proposals: Type.Array(FilesInPlayRawProposal),
});
export type FilesInPlayProperties = Static<typeof FILES_IN_PLAY_PROPERTIES>;

export const FILES_IN_PLAY_DEF: AnalyzerDef = {
	id: "files-in-play",
	label: "Files In Play (deterministic)",
	description:
		"Tracks which files each session has in play — the set of paths its read/edit/write tool calls touch — and detects churn over that set: repeated read→edit→read cycles and windowed re-read concentration where the agent keeps reopening files it already holds instead of progressing. No LLM.",
	anchorSpan: "full_session",
	dependencies: [],
	outputSchema: FILES_IN_PLAY_PROPERTIES,
};

export const FILES_IN_PLAY_VERSION: AnalyzerVersion = {
	analyzerId: FILES_IN_PLAY_DEF.id,
	// 1.0 (issue #103): path extraction from structured tool arguments and bash
	// commands over the shared action stream, per-file handling counts, a
	// windowed repeat-ratio churn score, and a recurrence-gated proposal.
	major: 1,
	minor: 0,
	implementationKind: "deterministic",
	codeRef: "src/analyze/analyzers/files-in-play/index.ts",
};

function resolveConfig(raw: unknown): FilesInPlayConfig {
	return (raw as FilesInPlayConfig) ?? DEFAULT_FILES_IN_PLAY_CONFIG;
}

/**
 * Fingerprint of everything this analyzer reads: the ordered interaction
 * stream (ordinal : tool : path). Hashing the paths themselves makes a re-sync
 * that changes tool-call content re-identify as missing and recompute — the
 * same trade the other deterministic analyzers make.
 *
 * Deliberately conversation-only: config (window size, thresholds) is NOT
 * folded in here — it belongs to the framework's config-fingerprint identity
 * axis, so changing a threshold marks prior nodes stale for the `config`
 * reason with lineage preserved, instead of re-identifying as missing.
 */
function interactionFingerprint(messages: readonly MessageRow[]): string {
	const interactions = extractFileInteractions(messages);
	const lines = interactions.map((it) => `${it.ordinal}:${it.tool}:${it.direction}:${it.path}`);
	lines.push(`n:${interactions.length}`);
	return shortHash(lines.join("\n"));
}

/**
 * Build at most one proposal. The gate is two-fold and documented on the
 * config knobs: the session-wide churn score must reach
 * `proposalChurnThreshold`, AND re-read events must recur at least
 * `minRereadsForProposal` times — a single warm window is noise, and proposing
 * on noise trains the reader to ignore the output.
 */
function buildProposal(
	scan: ReturnType<typeof scanSessionChurn>,
	config: FilesInPlayConfig,
): FilesInPlayRawProposal | null {
	if (scan.churnScore < config.proposalChurnThreshold) return null;
	if (scan.rereadEvents < config.minRereadsForProposal) return null;

	const top = scan.topFiles.slice(0, 3);
	const evidence = top
		.map((f) => `${f.path} (reads=${f.reads}, edits=${f.edits}, rereads=${f.rereads}, cycles=${f.cycles})`)
		.join("; ");
	return {
		target_type: "agents_md",
		title: "Repeated read-edit cycling over the same small file set",
		summary:
			`The agent churned over ${scan.distinctFiles} file${scan.distinctFiles === 1 ? "" : "s"}: ` +
			`${scan.rereadEvents} re-read${scan.rereadEvents === 1 ? "" : "s"} and ${scan.editRereadCycles} read→edit→read ` +
			`cycle${scan.editRereadCycles === 1 ? "" : "s"} concentrated on files it already had in play.`,
		detail:
			"Add a standing instruction to keep edited-file context alive (track what was learned from each read, batch edits before verifying) " +
			"so verification does not devolve into re-reading the same few files after every small change. The work happened, repeatedly — " +
			"that is what distinguishes this churn from leads that were never pursued.",
		evidence: `Churn score ${scan.churnScore.toFixed(2)} over ${scan.churningWindows}/${scan.churnWindows} churning windows; top churned: ${evidence}`,
		confidence: 0.6,
		severity: "waste",
	};
}

export const filesInPlayAnalyzer: Analyzer = {
	def: FILES_IN_PLAY_DEF,
	version: FILES_IN_PLAY_VERSION,
	prompts: {} as Record<string, PromptVersion>,
	defaultConfig: {
		id: "",
		analyzerId: FILES_IN_PLAY_DEF.id,
		configHash: computeConfigHash(DEFAULT_FILES_IN_PLAY_CONFIG),
		configJson: DEFAULT_FILES_IN_PLAY_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
		// No conversation → no action stream → no files in play. (A clean session
		// with tool traffic still gets a node; only an empty one gets none.)
		if (ctx.messages.length === 0) return [];

		const fingerprint = interactionFingerprint(ctx.messages);
		const sources: SourceRef[] = [{ kind: "session", id: `${ctx.sessionId}#files-in-play=${fingerprint}` }];
		return [
			{
				sources,
				sourceSetHash: shortHash(`files-in-play(${ctx.sessionId}|${fingerprint})`),
				anchorKind: "session",
				anchorRef: ctx.sessionId,
			},
		];
	},

	async analyze(_unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const config = resolveConfig(ctx.config.configJson);
		const messages = await ctx.getSessionMessages(ctx.sessionId);
		const scan = scanSessionChurn(messages, config);
		const proposal = buildProposal(scan, config);

		const properties: FilesInPlayProperties = {
			session_id: ctx.sessionId,
			distinct_files: scan.distinctFiles,
			interaction_count: scan.interactions.length,
			read_count: scan.readCount,
			edit_count: scan.editCount,
			write_count: scan.writeCount,
			reread_events: scan.rereadEvents,
			edit_reread_cycles: scan.editRereadCycles,
			churn_windows: scan.churnWindows,
			churning_windows: scan.churningWindows,
			churn_score: scan.churnScore,
			top_files: scan.topFiles,
			improvement_proposals: proposal ? [proposal] : [],
		};

		const edges: AnalysisResult["edges"] = [
			{ toRefKind: REF_KINDS.SESSION, toRefId: ctx.sessionId, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 },
		];
		// Anchor to the messages whose calls re-touched files already in play, so
		// the finding walks back to the exact turns where the churn happened.
		let ordinal = 1;
		for (const messageId of churnRelevantMessageIds(scan.interactions).slice(0, 8)) {
			edges.push({ toRefKind: REF_KINDS.MESSAGE, toRefId: messageId, edgeKind: EDGE_KINDS.ANCHORS, ordinal: ordinal++ });
		}

		return {
			nodeKind: proposal ? "proposal" : "metric",
			contentJson: properties as unknown as Record<string, unknown>,
			anchorKind: "session",
			anchorRef: ctx.sessionId,
			edges,
		};
	},
};
