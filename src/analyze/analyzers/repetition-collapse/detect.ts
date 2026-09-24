/**
 * Pure repetition measures for the repetition-collapse analyzer (issue #278).
 *
 * Two cheap ratios over one text, neither of which sees what the other sees:
 *
 *   - word — the share of the text's words that fall inside a repeated word
 *     n-gram beyond its first occurrence. A sentence repeated until the budget
 *     runs out scores near one; a text repeated twice scores one half.
 *   - char — the longest run of one short repeating motif, as a share of the
 *     text. A loop is often sub-word (`CustomCustomCustom…`, `-_-_-_…`): the
 *     whole run is one "word", so the word measure scores it zero.
 *
 * A step's score is the stronger of the two. Length is only a floor below which
 * nothing is judged: most long steps are long analyses, and score near zero.
 */

import { Type, type Static } from "typebox";
import type { MessageRow } from "../../types.js";
import type { TurnPair } from "../turn-pair-core/build.js";
import type { RepetitionCollapseConfig } from "./config.js";

/** Longest motif kept on a node: the repeating unit, never the surrounding text. */
const MOTIF_MAX_CHARS = 80;

const round3 = (x: number): number => Math.round(x * 1000) / 1000;

function wordMeasure(text: string, n: number): { ratio: number; motif: string } {
	const tokens = text.split(/\s+/).filter((t) => t.length > 0);
	if (tokens.length < n) return { ratio: 0, motif: "" };
	const grams: string[] = [];
	const counts = new Map<string, number>();
	for (let i = 0; i + n <= tokens.length; i++) {
		const g = tokens.slice(i, i + n).join(" ");
		grams.push(g);
		counts.set(g, (counts.get(g) ?? 0) + 1);
	}
	// A token is repetition when it sits inside a later occurrence of an
	// n-gram already seen; the first occurrence is the original, not the loop.
	const covered = new Uint8Array(tokens.length);
	const seen = new Set<string>();
	grams.forEach((g, i) => {
		if (seen.has(g)) covered.fill(1, i, i + n);
		else seen.add(g);
	});
	let coveredCount = 0;
	for (const c of covered) coveredCount += c;
	let motif = "";
	let best = 1;
	for (const [g, c] of counts) {
		if (c > best) {
			best = c;
			motif = g;
		}
	}
	return { ratio: coveredCount / tokens.length, motif };
}

function charMeasure(text: string, maxMotif: number): { ratio: number; motif: string } {
	const n = text.length;
	let bestLen = 0;
	let motif = "";
	for (let p = 1; p <= maxMotif && p < n; p++) {
		let run = 0;
		// A run of `run` positions each equal to the character `p` before it is
		// a region of `run + p` characters made of one motif of length `p`.
		const close = (end: number): void => {
			if (run < p) return; // fewer than two full copies is not a repetition
			const start = end - run - p;
			const unit = text.slice(start, start + p);
			if (!/\S/.test(unit)) return; // indentation and blank padding are not loops
			if (run + p > bestLen) {
				bestLen = run + p;
				motif = unit;
			}
		};
		for (let i = p; i < n; i++) {
			if (text.charCodeAt(i) === text.charCodeAt(i - p)) run++;
			else {
				close(i);
				run = 0;
			}
		}
		close(n);
	}
	return { ratio: n === 0 ? 0 : bestLen / n, motif };
}

/** Word-level repetition ratio, 0–1. */
export function wordRepetition(text: string, n: number): number {
	return wordMeasure(text, n).ratio;
}

/** Character-level repetition ratio, 0–1. */
export function charRepetition(text: string, maxMotif: number): number {
	return charMeasure(text, maxMotif).ratio;
}

export const TextMeasureSchema = Type.Object({
	chars: Type.Number(),
	word: Type.Number(),
	char: Type.Number(),
	/** The stronger of `word` and `char`. */
	score: Type.Number(),
	/** The repeating unit behind the score (capped), or "" when nothing repeats. */
	motif: Type.String(),
});
export type TextMeasure = Static<typeof TextMeasureSchema>;

export function measureText(text: string, config: RepetitionCollapseConfig): TextMeasure {
	const w = wordMeasure(text, config.wordNgram);
	const c = charMeasure(text, config.maxMotifChars);
	const word = round3(w.ratio);
	const char = round3(c.ratio);
	const motif = (word >= char ? w.motif : c.motif).slice(0, MOTIF_MAX_CHARS);
	return { chars: text.length, word, char, score: Math.max(word, char), motif };
}

export const CollapseChannel = Type.Union([Type.Literal("reasoning"), Type.Literal("answer")]);

/** One step whose own text loops. */
export const CollapsedStepSchema = Type.Object({
	/** The assistant message (the step) that looped. */
	message_id: Type.String(),
	/** The turn's anchoring user message. */
	user_message_id: Type.String(),
	pair_index: Type.Number(),
	/** Which of the step's texts looped hardest. */
	channel: CollapseChannel,
	measure: TextMeasureSchema,
	/** Characters of reasoning the step produced, looping or not — context for the cost. */
	reasoning_chars: Type.Number(),
	/** Whether the step produced anything usable: a tool call, or answer text that is not itself the loop. */
	delivered: Type.Boolean(),
	model: Type.Union([Type.String(), Type.Null()]),
	/** Billed dollar cost of the step, or null when unrecorded. */
	cost_usd: Type.Union([Type.Number(), Type.Null()]),
	/** How the generation ended, verbatim from the host — `length` is the budget running out. */
	stop_reason: Type.Union([Type.String(), Type.Null()]),
});
export type CollapsedStep = Static<typeof CollapsedStepSchema>;

export const StepScanSchema = Type.Object({
	judged_step_count: Type.Number(),
	collapsed: Type.Array(CollapsedStepSchema),
});
export type StepScan = Static<typeof StepScanSchema>;

function hasToolCalls(json: string | null): boolean {
	if (!json) return false;
	try {
		const arr = JSON.parse(json) as unknown;
		return Array.isArray(arr) && arr.length > 0;
	} catch {
		return false;
	}
}

/** Judge every assistant step in the session's turns. */
export function scanSteps(
	pairs: readonly TurnPair[],
	messages: readonly MessageRow[],
	config: RepetitionCollapseConfig,
): StepScan {
	const pairByMessage = new Map<string, TurnPair>();
	for (const p of pairs) for (const id of p.messageIds) pairByMessage.set(id, p);

	let judged = 0;
	const collapsed: CollapsedStep[] = [];
	for (const m of messages) {
		if (m.role !== "assistant") continue;
		const pair = pairByMessage.get(m.id);
		if (!pair) continue;
		const reasoning = m.content_thinking ?? "";
		const answer = m.content_text ?? "";
		const r = reasoning.length >= config.minTextChars ? measureText(reasoning, config) : null;
		const a = answer.length >= config.minTextChars ? measureText(answer, config) : null;
		if (!r && !a) continue;
		judged++;

		const answerLoops = a !== null && a.score >= config.repetitionThreshold;
		const worst = a && (!r || a.score > r.score) ? { channel: "answer" as const, measure: a } : { channel: "reasoning" as const, measure: r! };
		if (worst.measure.score < config.repetitionThreshold) continue;

		collapsed.push({
			message_id: m.id,
			user_message_id: pair.userMessageId,
			pair_index: pair.index,
			channel: worst.channel,
			measure: worst.measure,
			reasoning_chars: reasoning.length,
			delivered: hasToolCalls(m.tool_calls) || (answer.trim().length > 0 && !answerLoops),
			model: m.model,
			cost_usd: m.cost_usd,
			stop_reason: m.stop_reason,
		});
	}
	return { judged_step_count: judged, collapsed };
}
