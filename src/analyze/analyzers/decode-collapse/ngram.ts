/**
 * A word n-gram language model small enough to train in-process: a count table
 * plus interpolated absolute discounting. No model download, no neural runtime.
 *
 * Perplexity measures how improbable a text is under the model. Coherent text —
 * including dense technical text, once the model has been trained on the same
 * kind of transcripts — scores low; text that stopped being language scores
 * orders of magnitude higher, because its word order occurs nowhere.
 *
 * Everything here is a pure function of its inputs, so a score reproduces on any
 * machine.
 */

import { Type, type Static } from "typebox";

/** One document: an ordered list of lines, each an ordered list of tokens. */
export const TokenizedDocument = Type.Array(Type.Array(Type.String()));
export type TokenizedDocument = Static<typeof TokenizedDocument>;

const TOKEN_RE =
	/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{M}\p{N}_]+|[^\s\p{Cc}\p{L}\p{M}\p{N}_]/gu;

/**
 * Split text into lines of lowercased tokens: word runs, single punctuation
 * marks, and single CJK characters (which carry no spaces to split on). Control
 * characters are never tokens: n-gram keys are joined on one, so a token that
 * contained it would split into the wrong context. Empty lines are dropped. At
 * most `maxTokens` tokens are kept, from the start.
 */
export function tokenize(text: string, maxTokens: number): TokenizedDocument {
	const lines: TokenizedDocument = [];
	let kept = 0;
	for (const raw of text.split("\n")) {
		if (kept >= maxTokens) break;
		const tokens = raw.toLowerCase().match(TOKEN_RE);
		if (!tokens || tokens.length === 0) continue;
		const room = maxTokens - kept;
		const line = tokens.length > room ? tokens.slice(0, room) : tokens;
		lines.push(line);
		kept += line.length;
	}
	return lines;
}

export function tokenCount(doc: TokenizedDocument): number {
	let n = 0;
	for (const line of doc) n += line.length;
	return n;
}

const BOS = "<s>";
const EOS = "</s>";
const SEP = "\u0001";

/**
 * Raw n-gram counts of orders 1..order, plus each context's total and its number
 * of distinct continuations — everything interpolated absolute discounting reads.
 * Lines are padded with `order - 1` start markers and closed by an end marker.
 */
export class NgramCounts {
	readonly grams = new Map<string, number>();
	readonly contexts = new Map<string, number>();
	readonly continuations = new Map<string, number>();

	constructor(readonly order: number) {}

	addDocument(doc: TokenizedDocument): void {
		for (const line of doc) this.addLine(line);
	}

	private addLine(line: readonly string[]): void {
		const padded = [...Array<string>(this.order - 1).fill(BOS), ...line, EOS];
		for (let i = this.order - 1; i < padded.length; i++) {
			for (let k = 1; k <= this.order; k++) {
				const context = padded.slice(i - k + 1, i).join(SEP);
				const gram = context === "" ? padded[i]! : context + SEP + padded[i]!;
				const prev = this.grams.get(gram) ?? 0;
				this.grams.set(gram, prev + 1);
				this.contexts.set(context, (this.contexts.get(context) ?? 0) + 1);
				if (prev === 0) this.continuations.set(context, (this.continuations.get(context) ?? 0) + 1);
			}
		}
	}
}

/**
 * The model: a count table, optionally with another table's counts subtracted.
 *
 * Subtraction is how a session is scored by a model that never saw it without
 * retraining: the reference counts stay shared and untouched, and the view reads
 * `base - excluded` everywhere. A model that scores a document it trained on has
 * memorised it and reports it as ordinary, so this is not an optimisation.
 */
export class NgramModel {
	private readonly droppedContinuations = new Map<string, number>();

	constructor(
		private readonly base: NgramCounts,
		private readonly discount: number,
		private readonly excluded?: NgramCounts,
	) {
		if (excluded) {
			if (excluded.order !== base.order) throw new Error("excluded counts must share the model's order");
			for (const [gram, c] of excluded.grams) {
				const baseCount = base.grams.get(gram) ?? 0;
				if (c > baseCount) throw new Error("excluded counts are not a subset of the model's counts");
				if (c === baseCount) {
					const cut = gram.lastIndexOf(SEP);
					const context = cut < 0 ? "" : gram.slice(0, cut);
					this.droppedContinuations.set(context, (this.droppedContinuations.get(context) ?? 0) + 1);
				}
			}
		}
	}

	get order(): number {
		return this.base.order;
	}

	private gram(key: string): number {
		return (this.base.grams.get(key) ?? 0) - (this.excluded?.grams.get(key) ?? 0);
	}

	private context(key: string): number {
		return (this.base.contexts.get(key) ?? 0) - (this.excluded?.contexts.get(key) ?? 0);
	}

	private continuations(key: string): number {
		return (this.base.continuations.get(key) ?? 0) - (this.droppedContinuations.get(key) ?? 0);
	}

	/**
	 * P(word | history), interpolating every order down to a uniform floor that
	 * reserves one slot for unseen words, so the distribution stays proper and an
	 * unseen word is improbable rather than impossible.
	 */
	probability(history: readonly string[], word: string): number {
		const vocabulary = this.continuations("");
		let p = 1 / (vocabulary + 1);
		for (let k = 1; k <= this.order; k++) {
			if (history.length < k - 1) break;
			const ctx = history.slice(history.length - (k - 1)).join(SEP);
			const total = this.context(ctx);
			if (total <= 0) continue;
			const seen = this.gram(ctx === "" ? word : ctx + SEP + word);
			p = (Math.max(seen - this.discount, 0) + this.discount * this.continuations(ctx) * p) / total;
		}
		return p;
	}

	/** Perplexity of one line, end marker included, as the model was trained. */
	linePerplexity(line: readonly string[]): number {
		const padded = [...Array<string>(this.order - 1).fill(BOS), ...line, EOS];
		let logSum = 0;
		let n = 0;
		for (let i = this.order - 1; i < padded.length; i++) {
			logSum += Math.log(this.probability(padded.slice(i - this.order + 1, i), padded[i]!));
			n++;
		}
		return Math.exp(-logSum / n);
	}

	/**
	 * A document's score: the median perplexity of its lines of at least
	 * `minLineTokens` tokens, or the whole document as one line when none
	 * qualifies. The median, not the average, because a coherent turn that quotes
	 * one block of something foreign should read as the coherent turn it is.
	 */
	documentScore(doc: TokenizedDocument, minLineTokens: number): number {
		const lines = doc.filter((l) => l.length >= minLineTokens);
		const scored = lines.length > 0 ? lines : [doc.flat()];
		return median(scored.map((l) => this.linePerplexity(l)));
	}
}

export function median(values: readonly number[]): number {
	if (values.length === 0) throw new Error("median of an empty list");
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Nearest-rank quantile, q in [0, 1]. */
export function quantile(values: readonly number[], q: number): number {
	if (values.length === 0) throw new Error("quantile of an empty list");
	const sorted = [...values].sort((a, b) => a - b);
	const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
	return sorted[rank]!;
}

/** Every contiguous run of `width` tokens across the document, lines concatenated. */
export function shingles(doc: TokenizedDocument, width: number): string[] {
	const flat = doc.flat();
	const out: string[] = [];
	for (let i = 0; i + width <= flat.length; i++) out.push(flat.slice(i, i + width).join(SEP));
	return out;
}
