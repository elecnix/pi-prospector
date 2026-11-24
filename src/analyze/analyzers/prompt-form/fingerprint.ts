import type { FingerprintContributor, FingerprintRow } from "../../../fingerprint/contributor.js";
import { bucketLabels, labelBuckets } from "../../../fingerprint/buckets.js";
import { DEFAULT_PROMPT_FORM_CONFIG } from "./config.js";
import { PROMPT_KINDS } from "./question.js";

/** The default length buckets, by upper bound in characters (`0-20`, `20-80`, ..., `over-1000`): each bucket holds the prompts above its lower bound and up to its upper bound. */
const LENGTH_LABELS = bucketLabels(DEFAULT_PROMPT_FORM_CONFIG.lengthBoundsChars, String);

/**
 * The form of the prompts a person typed: how long they are and whether they
 * carry lists, headings or code blocks. Counted from text, so objective. Only
 * messages settled as typed are read, in the person's own words after pasted
 * and quoted text is cut.
 */
export const promptFormFingerprint: FingerprintContributor = {
	def: {
		id: "promptForm",
		label: "Prompt form",
		description:
			"The prompts a person typed: how many, their length in characters by bucket, and how many held a list, a markdown heading or a code block. Only messages settled as typed are read, in the person's own words after pasted and quoted text is cut. Characters are counted the same way in any language.",
		kind: "objective",
		analyzers: ["prompt-form", "message-origin"],
		measures: [
			{ kind: "total", id: "typedPrompts", metric: "prompt-form.prompt-length", field: "typed" },
			{ kind: "sessions", id: "sessionsWithTypedPrompts", metric: "prompt-form.prompt-length", field: "typed" },
			{ kind: "total", id: "characters", metric: "prompt-form.prompt-length", field: "chars" },
			{ kind: "groups", id: "byLength", metric: "prompt-form.prompt-length", dimensions: { length: [...LENGTH_LABELS.values()] }, countField: "count" },
			{ kind: "total", id: "withList", metric: "prompt-form.prompt-structure", field: "lists" },
			{ kind: "total", id: "withHeading", metric: "prompt-form.prompt-structure", field: "headings" },
			{ kind: "total", id: "withCodeBlock", metric: "prompt-form.prompt-structure", field: "codeBlocks" },
		],
	},
	async read(ctx) {
		const measured = new Set(await ctx.runs("prompt-form"));
		const ours = (r: FingerprintRow) => measured.has(String(r["session"]));
		const totals = await ctx.nodes("prompt-form", {
			typed: "$.typed_message_count",
			chars: "$.sum_chars",
			lists: "$.list_count",
			headings: "$.heading_count",
			codeBlocks: "$.code_block_count",
		});
		const buckets = await ctx.items("prompt-form", "$.length_buckets", { le: "$.le_chars", count: "$.count" });
		return { measured: [...measured], rows: [...totals.filter(ours), ...labelBuckets(buckets.filter(ours), LENGTH_LABELS, "length")] };
	},
};

/**
 * What the person was doing in each typed prompt: asking, instructing,
 * correcting, or something else. A decision model answers it through
 * message-answers, so the section is inferred. Without a configured decision
 * model every prompt is `unknown`, which is never read as `other`.
 */
export const promptKindFingerprint: FingerprintContributor = {
	def: {
		id: "promptKind",
		label: "Prompt kind",
		description:
			"Typed prompts by what the person was doing: question, instruction, correction, other, or unknown when no classifier answer reached the confidence floor. A decision model gives the answer, in any language.",
		kind: "inferred",
		analyzers: ["prompt-form", "message-answers"],
		measures: [{ kind: "groups", id: "byKind", metric: "prompt-form.prompt-kind", dimensions: { kind: [...PROMPT_KINDS, "unknown"] }, countField: "count" }],
	},
	async read(ctx) {
		const measured = new Set(await ctx.runs("prompt-form"));
		const kinds = [...PROMPT_KINDS, "unknown"];
		const nodes = await ctx.nodes("prompt-form", Object.fromEntries(kinds.map((k) => [k, `$.kinds.${k}`])));
		return {
			measured: [...measured],
			rows: nodes.filter((r) => measured.has(String(r["session"]))).flatMap((r) => kinds.map((kind) => ({ session: r["session"]!, kind, count: r[kind] ?? null }))),
		};
	},
};
