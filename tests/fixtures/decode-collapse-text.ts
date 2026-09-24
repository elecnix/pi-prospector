/**
 * Synthetic assistant text for the decode-collapse suites (issue #277).
 *
 * Coherent documents are sentences built from a small hand-written phrase
 * grammar, so different sessions share phrasing the way real agent transcripts
 * do. Collapsed documents are pseudo-words, stray punctuation, CJK characters
 * and chat-template control tokens in an order that means nothing — the shape
 * the issue describes, with no real session content in it.
 *
 * Everything is driven by a seeded PRNG, so every run produces the same text.
 */

const OPENERS = ["I need to", "Let me", "Next I will", "Now I should", "First I want to", "I am going to"];
const VERBS = ["read", "check", "update", "open", "inspect", "fix", "test", "review"];
const OBJECTS = [
	"the config file",
	"the test suite",
	"the parser module",
	"the database schema",
	"the error handler",
	"the build script",
	"the migration",
	"the request handler",
];
const REASONS = [
	"before changing anything",
	"to see why it fails",
	"so the tests pass",
	"because the user asked for it",
	"to confirm the behaviour",
	"and then run the tests again",
];

/** mulberry32: a tiny deterministic PRNG. */
export function prng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function pick<T>(rand: () => number, items: readonly T[]): T {
	return items[Math.floor(rand() * items.length)]!;
}

/** A coherent reasoning block: `lines` sentences from the phrase grammar, one per line. */
export function coherentText(rand: () => number, lines = 5): string {
	const out: string[] = [];
	for (let i = 0; i < lines; i++) {
		out.push(`${pick(rand, OPENERS)} ${pick(rand, VERBS)} ${pick(rand, OBJECTS)} ${pick(rand, REASONS)}.`);
	}
	return out.join("\n");
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const FRAGMENTS = ["</arg_value>", "<arg_key>", "</tool_call>", "<|code_suffix|>", "这件", "代", "擦", ".spec.tsx", "\\_", "/window", "'map"];

/** A collapsed block: novel pseudo-words interleaved with fragments, corrupt from the first token. */
export function collapsedText(rand: () => number, lines = 4, wordsPerLine = 12): string {
	const out: string[] = [];
	for (let i = 0; i < lines; i++) {
		const words: string[] = [];
		for (let w = 0; w < wordsPerLine; w++) {
			if (rand() < 0.25) {
				words.push(pick(rand, FRAGMENTS));
				continue;
			}
			const len = 3 + Math.floor(rand() * 8);
			let word = "";
			for (let c = 0; c < len; c++) word += LETTERS[Math.floor(rand() * LETTERS.length)];
			words.push(word);
		}
		out.push(words.join(" "));
	}
	return out.join("\n");
}
