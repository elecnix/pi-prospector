/**
 * Deterministic script detection for language-mismatch (issue #151).
 *
 * The detection is deliberately dependency-light: a Unicode-block heuristic
 * over letter counts, no per-language libraries, no LLM. A response in the
 * wrong language is almost always in a different *script* (English reply to a
 * French question; Cyrillic reply to an English prompt), and script is exactly
 * what code points reveal for free — so the cheap layer catches the material
 * mismatches without ever misjudging same-script pairs it cannot name.
 *
 * Code never speaks for the conversation: fenced blocks, inline code spans and
 * URLs are stripped before counting, because code identifiers and paths are
 * ASCII regardless of which language surrounds them. Emoji, digits,
 * punctuation and whitespace contribute nothing.
 */

import { Type, type Static } from "typebox";
import type { MessageRow } from "../../types.js";
import { type TurnPair } from "../turn-pair-core/build.js";
import type { LanguageMismatchConfig } from "./config.js";

/**
 * The scripts (and script-resolved languages) this analyzer can judge. CJK
 * resolves to three names: kana present means Japanese even when kanji
 * dominate; han alone means Chinese; hangul means Korean.
 */
export const SCRIPT_NAMES = [
	"latin",
	"cyrillic",
	"greek",
	"hebrew",
	"arabic",
	"devanagari",
	"thai",
	"japanese",
	"korean",
	"chinese",
] as const;
export type ScriptName = (typeof SCRIPT_NAMES)[number];

/** Raw Unicode-block groups counted before language resolution. */
type RawGroup =
	| "latin"
	| "greek"
	| "cyrillic"
	| "hebrew"
	| "arabic"
	| "devanagari"
	| "thai"
	| "kana"
	| "hangul"
	| "han";

/** Inclusive code-point ranges per raw group. Deliberately conservative: only
 * blocks that unambiguously carry that script's letters are listed. */
const RAW_RANGES: ReadonlyArray<readonly [RawGroup, ReadonlyArray<readonly [number, number]>]> = [
	["latin", [[0x41, 0x5a], [0x61, 0x7a], [0xc0, 0xd6], [0xd8, 0xf6], [0xf8, 0x24f]]],
	["greek", [[0x370, 0x3ff], [0x1f00, 0x1fff]]],
	["cyrillic", [[0x400, 0x4ff], [0x500, 0x52f]]],
	["hebrew", [[0x590, 0x5ff]]],
	["arabic", [[0x600, 0x6ff], [0x750, 0x77f]]],
	["devanagari", [[0x900, 0x97f]]],
	["thai", [[0xe00, 0xe7f]]],
	["kana", [[0x3040, 0x309f], [0x30a0, 0x30ff], [0x31f0, 0x31ff]]],
	["hangul", [[0x1100, 0x11ff], [0x3130, 0x318f], [0xac00, 0xd7af]]],
	[
		"han",
		[[0x2e80, 0x2eff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xf900, 0xfaff], [0x20000, 0x2a6df]],
	],
];

function classifyCodePoint(cp: number): RawGroup | null {
	for (const [group, ranges] of RAW_RANGES) {
		for (const [lo, hi] of ranges) {
			if (cp >= lo && cp <= hi) return group;
		}
	}
	return null;
}

/** Remove everything that does not speak for the conversation's language. */
export function stripNonProse(text: string): string {
	return text
		.replace(/```[\s\S]*?```/g, " ") // fenced code blocks
		.replace(/~~~[\s\S]*?~~~/g, " ") // tilde-fenced blocks
		.replace(/`[^`\n]*`/g, " ") // inline code spans
		.replace(/https?:\/\/\S+/g, " "); // URLs
}

function countScriptLetters(cleaned: string): Record<RawGroup, number> {
	const counts: Record<RawGroup, number> = {
		latin: 0,
		greek: 0,
		cyrillic: 0,
		hebrew: 0,
		arabic: 0,
		devanagari: 0,
		thai: 0,
		kana: 0,
		hangul: 0,
		han: 0,
	};
	for (const ch of cleaned) {
		const group = classifyCodePoint(ch.codePointAt(0)!);
		if (group) counts[group]++;
	}
	return counts;
}

/** What script detection concluded about one text. */
export interface ScriptJudgement {
	/** The judged script, or null when the text was skipped (too short or mixed). */
	script: ScriptName | null;
	/** Total script letters counted (after stripping non-prose). */
	letterCount: number;
}

/**
 * Judge which script a text is written in, under `config`.
 *
 * Returns `script: null` — a skip, not a judgement of "no script" — when the
 * text carries fewer than `minTextLength` letters, or when no single script
 * holds at least `dominantScriptRatio` of them (mixed text).
 */
export function detectScript(text: string, config: LanguageMismatchConfig): ScriptJudgement {
	const cleaned = stripNonProse(text);
	const raw = countScriptLetters(cleaned);
	const total = (Object.values(raw) as number[]).reduce((a, b) => a + b, 0);
	if (total < config.minTextLength) return { script: null, letterCount: total };

	const candidates: Array<{ name: ScriptName; count: number }> = [
		{ name: "latin", count: raw.latin },
		{ name: "greek", count: raw.greek },
		{ name: "cyrillic", count: raw.cyrillic },
		{ name: "hebrew", count: raw.hebrew },
		{ name: "arabic", count: raw.arabic },
		{ name: "devanagari", count: raw.devanagari },
		{ name: "thai", count: raw.thai },
	];
	// Kana presence settles Japanese even when kanji dominate its letter count;
	// han without kana is Chinese; hangul is Korean.
	if (raw.kana > 0) candidates.push({ name: "japanese", count: raw.kana + raw.han });
	else candidates.push({ name: "chinese", count: raw.han });
	candidates.push({ name: "korean", count: raw.hangul });

	let best = candidates[0]!;
	for (const c of candidates) if (c.count > best.count) best = c;
	const ratio = total === 0 ? 0 : best.count / total;
	return { script: ratio >= config.dominantScriptRatio ? best.name : null, letterCount: total };
}

// ─────────────────────────── session scan ───────────────────────────

export const TurnVerdictSchema = Type.Object({
	pair_index: Type.Number(),
	user_message_id: Type.String(),
	/** Judged script of the user's text; both sides must be judged for the verdict to exist. */
	user_script: Type.String(),
	assistant_script: Type.String(),
	mismatched: Type.Boolean(),
});
export type TurnVerdict = Static<typeof TurnVerdictSchema>;

export const CompactionVerdictSchema = Type.Object({
	message_id: Type.String(),
	/** Judged script of the compaction summary itself. */
	summary_script: Type.String(),
	/** Judged script of the user messages the summary compresses. */
	conversation_script: Type.String(),
	mismatched: Type.Boolean(),
});
export type CompactionVerdict = Static<typeof CompactionVerdictSchema>;

export interface SessionScan {
	turns: TurnVerdict[];
	compactions: CompactionVerdict[];
}

/**
 * Scan one session: judge every turn pair whose user and assistant texts are
 * both judgable, and every compaction summary against the user messages that
 * precede it (the conversation it compresses). Unjudgable texts — too short,
 * mixed-script — are skipped on either side rather than guessed at, so a
 * verdict exists exactly where two real judgements could be compared.
 */
export function scanSession(
	pairs: readonly TurnPair[],
	messages: readonly MessageRow[],
	config: LanguageMismatchConfig,
): SessionScan {
	const turns: TurnVerdict[] = [];
	for (const pair of pairs) {
		const user = detectScript(pair.userText, config);
		const assistant = detectScript(pair.assistantText, config);
		if (user.script === null || assistant.script === null) continue;
		turns.push({
			pair_index: pair.index,
			user_message_id: pair.userMessageId,
			user_script: user.script,
			assistant_script: assistant.script,
			mismatched: user.script !== assistant.script,
		});
	}

	const compactions: CompactionVerdict[] = [];
	if (config.checkCompaction) {
		const userTexts: string[] = [];
		for (const m of messages) {
			if (m.role === "user") {
				const t = m.content_text ?? "";
				if (t.trim().length > 0) userTexts.push(t);
				continue;
			}
			if (m.role !== "compactionSummary") continue;
			const conversation = detectScript(userTexts.join("\n"), config);
			const summary = detectScript(m.content_text ?? "", config);
			if (conversation.script === null || summary.script === null) continue;
			compactions.push({
				message_id: m.id,
				summary_script: summary.script,
				conversation_script: conversation.script,
				mismatched: conversation.script !== summary.script,
			});
		}
	}

	return { turns, compactions };
}
