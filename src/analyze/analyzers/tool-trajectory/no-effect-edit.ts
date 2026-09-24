/**
 * Reading the replacements an edit call asked for, to spot the ones that
 * replace a string with itself (issue #255, after Graphectory's NoEffectEdit).
 *
 * A no-op edit is silent: the tool reports success, no error text exists for
 * failure-modes to match, and the turn looks productive. The only evidence is
 * the call's own arguments, so this is where it is read.
 *
 * "Identical" means byte-identical. Trimming first would call an indentation
 * fix or a trailing-newline change a no-op, and both change the file.
 */

import { Type, type Static } from "typebox";

export const EditReplacements = Type.Object({
	/** Replacements the call asked for. */
	total: Type.Integer({ minimum: 1 }),
	/** How many of them replace a string with itself. */
	identical: Type.Integer({ minimum: 0 }),
});
export type EditReplacements = Static<typeof EditReplacements>;

/** The argument-key pairs an edit tool names its old and new text by. */
const PAIR_KEYS: ReadonlyArray<readonly [string, string]> = [
	["oldText", "newText"], // pi's edit
	["old_string", "new_string"], // Claude Code's Edit
	["old_str", "new_str"], // str_replace editors
];

/**
 * The replacements a tool call asked for, or null when it asked for none.
 *
 * Structured edit tools are read by their argument shape; `bash` is read for
 * `sed -i` substitutions.
 */
export function editReplacements(name: string, args: Record<string, unknown>): EditReplacements | null {
	const pairs = name === "bash" ? sedPairs(args["command"]) : structuredPairs(args);
	if (pairs.length === 0) return null;
	return { total: pairs.length, identical: pairs.filter((p) => p.identical).length };
}

interface Pair {
	identical: boolean;
}

function structuredPairs(args: Record<string, unknown>): Pair[] {
	const entries: Record<string, unknown>[] = [args];
	const edits = args["edits"];
	if (Array.isArray(edits)) {
		for (const e of edits) if (e && typeof e === "object") entries.push(e as Record<string, unknown>);
	}
	const pairs: Pair[] = [];
	for (const entry of entries) {
		for (const [oldKey, newKey] of PAIR_KEYS) {
			const oldText = entry[oldKey];
			const newText = entry[newKey];
			if (typeof oldText === "string" && typeof newText === "string") {
				pairs.push({ identical: oldText === newText });
				break;
			}
		}
	}
	return pairs;
}

// ──────────────────────────── sed -i ────────────────────────────

/** Characters that make a sed pattern match something other than itself. */
const REGEX_META = /[\\.[\]*^$+?(){}|]/;

function sedPairs(command: unknown): Pair[] {
	if (typeof command !== "string") return [];
	const pairs: Pair[] = [];
	for (const words of simpleCommands(command)) {
		if (words[0] !== "sed") continue;
		let inPlace = false;
		const scripts: string[] = [];
		const operands: string[] = [];
		for (let i = 1; i < words.length; i++) {
			const w = words[i]!;
			if (w === "-e" || w === "--expression") {
				const next = words[++i];
				if (next !== undefined) scripts.push(next);
			} else if (w.startsWith("--expression=")) {
				scripts.push(w.slice("--expression=".length));
			} else if (w === "--in-place" || w.startsWith("--in-place=")) {
				inPlace = true;
			} else if (/^-[A-Za-z]*i/.test(w)) {
				inPlace = true;
				// BSD sed takes the backup suffix as a separate word: `sed -i '' …`.
				if (w === "-i" && words[i + 1] === "") i++;
			} else if (!w.startsWith("-")) {
				operands.push(w);
			}
		}
		if (!inPlace) continue;
		// Without -e, the first operand is the script and the rest are files.
		if (scripts.length === 0 && operands[0] !== undefined) scripts.push(operands[0]);
		for (const script of scripts) pairs.push(...substitutions(script));
	}
	return pairs;
}

/**
 * Every `s<d>pattern<d>replacement<d>flags` command in a sed script.
 *
 * Read left to right rather than split on `;`, because a `;` inside a pattern
 * (`s/;/;/`) is part of the pattern, not a command separator. A backslash
 * escapes the next character, delimiter included. Other sed commands are
 * skipped up to their `;` or newline.
 *
 * A substitution is a no-op only when the pattern can match nothing but itself
 * (no metacharacters), the replacement is that same literal (no `&`), and no
 * flag widens the match (only `g` and an occurrence number qualify).
 */
function substitutions(script: string): Pair[] {
	const pairs: Pair[] = [];
	let i = 0;
	const isEnd = (ch: string | undefined): boolean => ch === ";" || ch === "\n";
	const field = (d: string): string | null => {
		let out = "";
		while (i < script.length && script[i] !== d) {
			if (script[i] === "\\" && i + 1 < script.length) out += script[i++];
			out += script[i++];
		}
		if (i >= script.length) return null;
		i++; // the closing delimiter
		return out;
	};
	while (i < script.length) {
		while (i < script.length && (isEnd(script[i]) || /\s/.test(script[i]!))) i++;
		if (i >= script.length) break;
		const d = script[i + 1];
		if (script[i] === "s" && d !== undefined && !/[\s\\a-zA-Z0-9]/.test(d)) {
			i += 2;
			const pattern = field(d);
			const replacement = pattern === null ? null : field(d);
			if (pattern === null || replacement === null) break;
			let flags = "";
			while (i < script.length && !isEnd(script[i])) flags += script[i++];
			pairs.push({
				identical:
					pattern.length > 0 &&
					pattern === replacement &&
					!REGEX_META.test(pattern) &&
					!replacement.includes("&") &&
					/^(?:g|\d+)*$/.test(flags.trim()),
			});
		} else {
			while (i < script.length && !isEnd(script[i])) i++;
		}
	}
	return pairs;
}

/**
 * Split a shell command into simple commands, each a list of words with quotes
 * removed. Enough shell for finding `sed` and its arguments: quotes, backslash
 * escapes, and the `;` `&&` `||` `|` newline separators.
 */
function simpleCommands(command: string): string[][] {
	const out: string[][] = [];
	let words: string[] = [];
	let word = "";
	let inWord = false;
	let quote: "'" | '"' | null = null;
	const endWord = (): void => {
		if (inWord) words.push(word);
		word = "";
		inWord = false;
	};
	const endCommand = (): void => {
		endWord();
		if (words.length > 0) out.push(words);
		words = [];
	};
	for (let i = 0; i < command.length; i++) {
		const ch = command[i]!;
		if (quote) {
			if (ch === quote) quote = null;
			else if (ch === "\\" && quote === '"' && i + 1 < command.length) word += command[++i];
			else word += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			inWord = true;
		} else if (ch === "\\" && i + 1 < command.length) {
			word += command[++i];
			inWord = true;
		} else if (ch === ";" || ch === "\n" || ch === "|" || ch === "&") {
			endCommand();
			if ((ch === "|" || ch === "&") && command[i + 1] === ch) i++;
		} else if (/\s/.test(ch)) {
			endWord();
		} else {
			word += ch;
			inWord = true;
		}
	}
	endCommand();
	return out;
}
