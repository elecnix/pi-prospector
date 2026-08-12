/**
 * Structured session digest for the session-overview analyzer.
 *
 * Rather than truncating raw transcript, we build a compact digest from the
 * deterministic per-pair metrics, the LLM classifications, any compaction
 * summaries, and aggregate statistics. Large sessions are split into segments
 * for a map-reduce summarisation.
 */

import type { AnalysisNodeRow, MessageRow } from "../../types.js";
import type { TurnPairCoreProperties } from "../turn-pair-core/index.js";
import type { TurnPairLLMProperties } from "../turn-pair-llm/prompt.js";
import type { ToolTrajectoryProperties } from "../tool-trajectory/index.js";
import type { TurnFrustrationProperties } from "../turn-frustration/index.js";
import { buildTurnPairs, type TurnPair } from "../turn-pair-core/build.js";

/** Properties stored in a user-reply-acts classification node. */
interface ReplyActProperties {
	user_message_id: string;
	pair_index: number;
	acceptances: Array<{ level: string; quote: string; rationale: string }>;
	refusals: Array<{ level: string; quote: string; rationale: string }>;
	questions: Array<{ purpose: string; quote: string; rationale: string }>;
	answers: Array<{ quote: string; rationale: string }>;
	commands: Array<{ quote: string; rationale: string }>;
	information_provisions: Array<{ quote: string; rationale: string }>;
	continuation: boolean;
	other: boolean;
}

export interface DigestSegment {
	index: number;
	text: string;
}

export interface SessionDigest {
	header: string;
	perPairLines: string[];
	trajectoryLines: string[];
	positiveSignals: string[];
	text: string;
	totalChars: number;
	pairCount: number;
	frictionCount: number;
	compactionCount: number;
	correctionCount: number;
	toolFailureCount: number;
	trajectorySignalCount: number;
	/** Turns carrying at least one learned-lexicon or lexicon-free frustration signal. */
	frustrationSignalCount: number;
	/** Distinct languages the learned lexicon matched in this session. */
	frustrationLanguages: string[];
	/** True when the session had at least one correction followed by a clean (no-friction) pair — a "good pivot". */
	cleanRecovery: boolean;
	/** True when the session completed all turns without any correction or high-signal friction. */
	taskCompletedWithoutCorrection: boolean;
	/** True when fewer than half the turns had a tool failure (density check). */
	lowToolFailureDensity: boolean;
	/** Number of user-reply-acts classification nodes folded into the digest. */
	replyActsCount: number;
	/** Per-reply act summary lines for the digest. */
	replyActsLines: string[];
}

export interface BuildDigestInput {
	sessionId: string;
	messages: MessageRow[];
	coreNodes: AnalysisNodeRow[];
	llmNodes: AnalysisNodeRow[];
	trajectoryNodes: AnalysisNodeRow[];
	frustrationNodes?: AnalysisNodeRow[];
	/** user-reply-acts classification nodes (custom analyzer). */
	replyActsNodes?: AnalysisNodeRow[];
}

function safeParse<T>(json: string): T | null {
	try {
		return JSON.parse(json) as T;
	} catch {
		return null;
	}
}

/** Max length for a user-text snippet included in the per-pair digest line. */
const USER_TEXT_SNIPPET_MAX = 200;

/** Fixed caps for the per-pair tool-evidence fragment (bounded, deterministic). */
const MAX_DIGEST_TOOL_CALLS = 8;
const MAX_DIGEST_TOOL_ERRORS = 4;
const TOOL_ARGS_SNIPPET_MAX = 120;
const TOOL_ERR_SNIPPET_MAX = 160;

/**
 * Build the compact tool-evidence fragment for a per-pair digest line: the tool
 * name + truncated arguments for each call, plus truncated error heads for
 * failed results. Emitted only for high-signal / failing pairs so the reduce
 * phase can attribute a root cause to a specific command rather than paraphrase
 * the user's wording. Bounded to fixed caps so content-addressing stays stable.
 */
function formatToolFragment(pair: TurnPair): string {
	const bits: string[] = [];
	for (const tc of pair.toolCalls.slice(0, MAX_DIGEST_TOOL_CALLS)) {
		const args = tc.argumentsPreview ? ` args="${truncateLine(tc.argumentsPreview, TOOL_ARGS_SNIPPET_MAX)}"` : "";
		bits.push(`tool=${tc.name}${args}`);
	}
	for (const tr of pair.toolResults.filter((r) => r.isError).slice(0, MAX_DIGEST_TOOL_ERRORS)) {
		if (tr.errorHead) bits.push(`err="${truncateLine(tr.errorHead, TOOL_ERR_SNIPPET_MAX)}"`);
	}
	return bits.join(" ");
}

export function buildDigest(input: BuildDigestInput): SessionDigest {
	const core = input.coreNodes
		.map((n) => safeParse<TurnPairCoreProperties>(n.content_json))
		.filter((p): p is TurnPairCoreProperties => p !== null)
		.sort((a, b) => a.pair_index - b.pair_index);

	// Map user_message_id → llm classification. turn-pair-llm records the anchor
	// user-message id in its content, so we merge enrichment by id (not by order).
	const llmByUser = new Map<string, TurnPairLLMProperties>();
	for (const node of input.llmNodes) {
		const props = safeParse<TurnPairLLMProperties>(node.content_json);
		if (props && props.user_message_id) llmByUser.set(props.user_message_id, props);
	}

	// Map message id → user text, so every pair can include a verbatim snippet
	// (not just pairs where the regex matched). This un-gates the synthesizer
	// from the deterministic correction regex: the regex is a ranking signal only.
	const userTextById = new Map<string, string>();
	for (const m of input.messages) {
		if (m.role === "user" && m.content_text) {
			userTextById.set(m.id, m.content_text);
		}
	}

	// Map user_message_id → turn pair, so high-signal / failing pairs can carry a
	// tool-evidence fragment (tool names + truncated args + failed-result error heads).
	const pairByUser = new Map<string, TurnPair>();
	for (const pair of buildTurnPairs(input.messages)) {
		pairByUser.set(pair.userMessageId, pair);
	}

	// Group learned-lexicon and lexicon-free hits by the turn they landed on.
	const frustrationByUser = new Map<string, TurnFrustrationProperties[]>();
	for (const node of input.frustrationNodes ?? []) {
		const props = safeParse<TurnFrustrationProperties>(node.content_json);
		if (!props?.user_message_id) continue;
		const list = frustrationByUser.get(props.user_message_id) ?? [];
		list.push(props);
		frustrationByUser.set(props.user_message_id, list);
	}

	// Parse trajectory signal nodes.
	const trajectory = input.trajectoryNodes
		.map((n) => safeParse<ToolTrajectoryProperties>(n.content_json))
		.filter((p): p is ToolTrajectoryProperties => p !== null);

	// Parse user-reply-acts classification nodes (custom analyzer).
	// Map user_message_id → reply act properties for per-turn enrichment.
	const replyActsByUser = new Map<string, ReplyActProperties>();
	for (const node of input.replyActsNodes ?? []) {
		const props = safeParse<ReplyActProperties>(node.content_json);
		if (props && props.user_message_id) replyActsByUser.set(props.user_message_id, props);
	}
	const replyActsCount = replyActsByUser.size;

	// Build per-reply act summary lines for the digest.
	const replyActsLines: string[] = [];
	for (const p of core) {
		const acts = replyActsByUser.get(p.user_message_id);
		if (!acts) continue;
		const bits: string[] = [`#${p.pair_index}`];
		if (acts.acceptances.length > 0) {
			bits.push(`accept=${acts.acceptances.map((a) => a.level).join(",")}`);
		}
		if (acts.refusals.length > 0) {
			bits.push(`refuse=${acts.refusals.map((r) => r.level).join(",")}`);
		}
		if (acts.questions.length > 0) {
			bits.push(`question=${acts.questions.map((q) => q.purpose).join(",")}`);
		}
		if (acts.answers.length > 0) {
			bits.push(`answer=${acts.answers.length}`);
		}
		if (acts.commands.length > 0) {
			bits.push(`command=${acts.commands.length}`);
		}
		if (acts.information_provisions.length > 0) {
			bits.push(`info_prov=${acts.information_provisions.length}`);
		}
		if (acts.continuation) bits.push("continuation");
		if (acts.other) bits.push("other");
		replyActsLines.push(bits.join(" "));
	}

	const compactions = input.messages
		.filter((m) => m.role === "compactionSummary" || m.role === "branch_summary")
		.map((m) => (m.content_text ?? "").trim())
		.filter((t) => t.length > 0);

	const frictionCount = core.filter((p) => p.high_signal).length;
	const correctionCount = core.filter((p) => p.correction_detected).length;
	const toolFailureCount = core.reduce((sum, p) => sum + p.tool_failure_count, 0);
	const trajectorySignalCount = trajectory.reduce((sum, t) => sum + (t.signals?.length ?? 0), 0);
	const frustrationSignalCount = [...frustrationByUser.values()].filter((hits) =>
		hits.some((h) => h.polarity === "frustration"),
	).length;
	const frustrationLanguages = [
		...new Set(
			[...frustrationByUser.values()]
				.flat()
				.filter((h) => h.signal_source === "lexicon" && h.polarity === "frustration" && h.language !== "und")
				.map((h) => h.language),
		),
	].sort();

	// ── Positive signals ──────────────────────────────────────────────────
	// task-completed-without-correction: zero corrections across all pairs.
	const taskCompletedWithoutCorrection = core.length > 0 && correctionCount === 0;

	// correction-then-clean-recovery: at least one correction followed by a
	// clean (low-friction, no correction) pair — the agent recovered gracefully.
	let cleanRecovery = false;
	for (let i = 0; i < core.length - 1; i++) {
		if (core[i]!.correction_detected) {
			const next = core[i + 1]!;
			if (!next.correction_detected && !next.high_signal) {
				cleanRecovery = true;
				break;
			}
		}
	}

	// low tool-failure density: fewer than half the pairs have a tool failure.
	const pairsWithToolFailure = core.filter((p) => p.tool_failure_count > 0).length;
	const lowToolFailureDensity = core.length > 0 && pairsWithToolFailure < core.length / 2;

	const positiveSignals: string[] = [];
	if (taskCompletedWithoutCorrection) positiveSignals.push("task-completed-without-correction");
	if (cleanRecovery) positiveSignals.push("correction-then-clean-recovery");
	if (lowToolFailureDensity) positiveSignals.push("low-tool-failure-density");

	const perPairLines = core.map((p) => {
		const llm = llmByUser.get(p.user_message_id);
		const bits = [
			`#${p.pair_index}`,
			`friction=${p.friction_score.toFixed(2)}`,
			p.correction_detected ? `correction=${p.correction_type}` : "correction=none",
			`tool_fail=${p.tool_failure_count}`,
		];
		if (llm) bits.push(`sentiment=${llm.sentiment}`, `type=${llm.friction_type}`, `sev=${llm.severity}`);
		if (p.correction_text) bits.push(`note="${p.correction_text.slice(0, 120)}"`);
		// Learned-lexicon and lexicon-free signals. These are what let the synthesiser
		// see frustration the shipped English regex cannot express — a French user's
		// wording, or a turn that only shouts.
		const frustration = frustrationByUser.get(p.user_message_id);
		if (frustration && frustration.length > 0) {
			const rendered = [...frustration]
				.sort((a, b) => (a.signal < b.signal ? -1 : a.signal > b.signal ? 1 : 0))
				.map((h) => `${h.signal}:${h.category}${h.language !== "und" ? `/${h.language}` : ""}`)
				.join(",");
			bits.push(`frustration=[${rendered}]`);
		}
		// Tool evidence for failing / high-signal pairs: lets the reduce phase attribute
		// the root cause to a specific command instead of paraphrasing user wording.
		if (p.high_signal || p.tool_failure_count > 0) {
			const pair = pairByUser.get(p.user_message_id);
			if (pair) {
				const fragment = formatToolFragment(pair);
				if (fragment) bits.push(fragment);
			}
		}
		// Un-gate: include a user-text snippet for every pair, not just regex-matched ones.
		// The correction regex is a ranking signal only; the synthesizer must see all text.
		const userText = userTextById.get(p.user_message_id);
		if (userText) {
			bits.push(`text="${truncateLine(userText, USER_TEXT_SNIPPET_MAX)}"`);
		}
		return bits.join(" ");
	});

	// Build trajectory signal lines. When a signal is priced, the dollar amount
	// is embedded in the digest line so the synthesizer can cite it verbatim in
	// proposal evidence (issue #71) — a loop reads as "$0.34" not "9×".
	const trajectoryLines = trajectory.flatMap((t) =>
		(t.signals ?? []).map((s) => {
			const cost = typeof s.cost_usd === "number"
				? ` cost=$${roundUsd(s.cost_usd)}`
				: "";
			return `trajectory:${s.pattern} tool=${s.tool} count=${s.count}${cost} ${s.description}`;
		}),
	);

	const headerLines = [
		`## Session ${input.sessionId}`,
		`pairs=${core.length} high_signal=${frictionCount} corrections=${correctionCount} tool_failures=${toolFailureCount} trajectory_signals=${trajectorySignalCount}`,
	];
	if (trajectory.length > 0) {
		headerLines.push(`trajectory_friction=${trajectory.reduce((max, t) => Math.max(max, t.trajectory_friction_score ?? 0), 0).toFixed(2)}`);
		// Pricing coverage: state what fraction of trajectory signals could
		// be priced and how much that priced subset cost. A trajectory priced from
		// partial data must say so — a cost line without the coverage would read as a
		// complete total when it is a lower bound.
		const priced = trajectory.reduce((acc, t) => acc + (t.priced_signal_count ?? 0), 0);
		const unpriced = trajectory.reduce((acc, t) => acc + (t.unpriced_signal_count ?? 0), 0);
		const pricedCost = trajectory.reduce(
			(acc, t) => acc + (typeof t.trajectory_cost_usd === "number" ? t.trajectory_cost_usd : 0),
			0,
		);
		const total = priced + unpriced;
		const coverage = total > 0 ? ` (${priced}/${total} priced)` : "";
		const costBit = priced > 0 ? ` cost=$${roundUsd(pricedCost)}` : " cost=unknown";
		headerLines.push(`trajectory_pricing:${coverage}${costBit}`);
	}
	if (positiveSignals.length > 0) {
		headerLines.push(`positive_signals=${positiveSignals.join(",")}`);
	}
	if (compactions.length > 0) {
		headerLines.push("", "### Compaction summaries (verbatim)");
		for (const c of compactions) headerLines.push(c.slice(0, 2000));
	}
	const header = headerLines.join("\n");

	const sections = [header, "", "### Per-pair signals", ...perPairLines];
	if (positiveSignals.length > 0) {
		sections.push("", "### Positive signals", ...positiveSignals.map((s) => `- ${s}`));
	}
	if (trajectoryLines.length > 0) {
		sections.push("", "### Trajectory signals", ...trajectoryLines);
	}
	if (replyActsLines.length > 0) {
		sections.push("", "### Reply acts", ...replyActsLines);
	}
	const text = sections.join("\n");

	return {
		header,
		perPairLines,
		trajectoryLines,
		positiveSignals,
		text,
		totalChars: text.length,
		pairCount: core.length,
		frictionCount,
		compactionCount: compactions.length,
		correctionCount,
		toolFailureCount,
		trajectorySignalCount,
		frustrationSignalCount,
		frustrationLanguages,
		cleanRecovery,
		taskCompletedWithoutCorrection,
		lowToolFailureDensity,
		replyActsCount,
		replyActsLines,
	};
}

/** Truncate a line to maxLen characters, replacing newlines with spaces. */
function truncateLine(s: string, maxLen: number): string {
	const flat = s.replace(/\n/g, " ");
	return flat.length > maxLen ? `${flat.slice(0, maxLen)}…` : flat;
}

/**
 * Format a dollar amount compactly for the digest: two decimals for whole-ish
 * amounts, two significant digits for sub-cent charges (a small read can cost
 * fractions of a cent, and $0.00 would read as free).
 */
function roundUsd(usd: number): string {
	return usd < 0.01 ? usd.toPrecision(2) : usd.toFixed(2);
}

/**
 * Split a digest's per-pair body into segments no larger than `segmentChars`,
 * each prefixed with the shared header. Returns at least one segment.
 */
export function splitDigest(digest: SessionDigest, segmentChars: number): DigestSegment[] {
	if (digest.totalChars <= segmentChars || digest.perPairLines.length === 0) {
		return [{ index: 0, text: digest.text }];
	}

	const trailingSection = [
		...(digest.positiveSignals.length > 0
			? ["", "### Positive signals", ...digest.positiveSignals.map((s) => `- ${s}`)]
			: []),
		...(digest.trajectoryLines.length > 0
			? ["", "### Trajectory signals", ...digest.trajectoryLines]
			: []),
		...(digest.replyActsLines.length > 0
			? ["", "### Reply acts", ...digest.replyActsLines]
			: []),
	];

	const segments: DigestSegment[] = [];
	let buffer: string[] = [];
	let bufferLen = digest.header.length;

	const flush = (): void => {
		if (buffer.length === 0) return;
		segments.push({
			index: segments.length,
			text: [digest.header, "", "### Per-pair signals", ...buffer].join("\n"),
		});
		buffer = [];
		bufferLen = digest.header.length;
	};

	for (const line of digest.perPairLines) {
		if (bufferLen + line.length > segmentChars && buffer.length > 0) flush();
		buffer.push(line);
		bufferLen += line.length + 1;
	}
	flush();

	// Append positive/trajectory sections to the last segment if they fit, or create a new segment.
	if (trailingSection.length > 0) {
		const trailingText = trailingSection.join("\n");
		if (segments.length > 0 && segments[segments.length - 1]!.text.length + 1 + trailingText.length <= segmentChars) {
			segments[segments.length - 1]!.text += `\n${trailingText}`;
		} else {
			segments.push({
				index: segments.length,
				text: [digest.header, ...trailingSection].join("\n"),
			});
		}
	}

	return segments;
}
