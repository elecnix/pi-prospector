/**
 * request-classes — an LLM analyzer that lets the model name its own vocabulary
 * for the kinds of requests in a session.
 *
 * The point is the *absence* of a taxonomy. Every classifier in this repo hands
 * the model a fixed label set and asks it to pick; that measures how well the
 * corpus fits a taxonomy someone wrote in advance. This one asks the model to
 * name a set of classes describing the type of request made, and supplies no
 * candidate names, no examples of names, and no count. Whatever vocabulary comes
 * back is the finding — including the fact that it differs between sessions.
 *
 * The prompt therefore constrains only two things, neither of them vocabulary:
 * the output *shape* (so the classes can be attributed to token spend), and
 * coverage (every request lands in at least one class, so nothing is silently
 * dropped). Do not add examples to the prompt. An example name is a suggestion,
 * and the model will take it — at which point this analyzer is measuring the
 * example rather than the corpus.
 *
 * Attribution. The model also reports which numbered requests belong to each
 * class, which is what lets `token-units` MITE totals be split by class. A
 * request in several classes has its spend divided evenly among them, so a day's
 * class totals still sum to the day's total; the report says so rather than
 * hiding the convention.
 *
 * Cost. One cheap-tier call per session, cached in the analysis graph by session
 * content — re-running the report re-reads the node instead of re-classifying.
 * The request text is sent to whichever model the tier resolves to.
 */

import type {
	Analyzer,
	AnalyzerPlanContext,
	AnalyzerRunContext,
	AnalysisResult,
	AnalysisUnit,
} from "../../types.js";
import { resolveModelSpec } from "../../model-tiers.js";
import { EDGE_KINDS, REF_KINDS } from "../../edge-kinds.js";

// ── config ──

export interface RequestClassesConfig {
	/** Tier name (cheap/mid/expensive) or an explicit provider/model spec. */
	tier: string;
	/** Requests past this many are not sent; `truncated` records that. */
	max_requests: number;
	/** Each request is cut to this many characters. */
	max_chars_per_request: number;
	temperature: number;
}

/**
 * 300 requests × 400 characters is ~30k tokens of prompt, which the cheap tier
 * holds comfortably. It also truncates only 9 of the 1,863 indexed sessions —
 * a truncated request gets no class, so its spend would fall out of the class
 * totals, and the cap is set where that is rare rather than where it is tidy.
 */
export const DEFAULT_REQUEST_CLASSES_CONFIG: RequestClassesConfig = {
	tier: "cheap",
	max_requests: 300,
	max_chars_per_request: 400,
	temperature: 0,
};

// ── shapes ──

export interface RequestClass {
	/** The model's own name for the class, verbatim. */
	name: string;
	/** 1-based indices into the numbered request list. */
	requests: number[];
}

export interface RequestClassesProperties {
	session_id: string;
	/** The classes the model named, in the order it named them. */
	classes: RequestClass[];
	/** The user-message id behind each 1-based request number. */
	request_message_ids: string[];
	/** Requests omitted because the session exceeded `max_requests`. */
	truncated: number;
}

// ── prompt ──

/**
 * Deliberately minimal. It names no classes, gives no examples, and sets no
 * target count — see the module note before changing a word of it.
 */
const CLASSIFY_PROMPT = [
	"You are given a numbered list of requests made to an AI agent.",
	"",
	"Name a set of classes that describes the type of request made.",
	"Use your own words. There is no predefined list to choose from.",
	"",
	"Then report which request numbers belong to each class.",
	"Every request must appear in at least one class.",
].join("\n");

const CLASSIFY_TOOL = {
	name: "report_classes",
	description: "Report the set of classes you named and the requests belonging to each.",
	parameters: {
		type: "object",
		properties: {
			classes: {
				type: "array",
				items: {
					type: "object",
					properties: {
						name: { type: "string", description: "Your name for this class." },
						requests: {
							type: "array",
							items: { type: "integer" },
							description: "The 1-based request numbers in this class.",
						},
					},
					required: ["name", "requests"],
					additionalProperties: false,
				},
			},
		},
		required: ["classes"],
		additionalProperties: false,
	},
};

// ── helpers ──

interface RequestLine {
	messageId: string;
	text: string;
}

/** The user turns of a session, cleaned and capped. */
export function collectRequests(
	messages: Array<{ id: string; role: string; content_text: string | null }>,
	cfg: RequestClassesConfig,
): { lines: RequestLine[]; truncated: number } {
	const all: RequestLine[] = [];
	for (const m of messages) {
		if (m.role !== "user") continue;
		const text = (m.content_text ?? "").trim();
		if (!text) continue;
		all.push({ messageId: m.id, text: text.slice(0, cfg.max_chars_per_request) });
	}
	const lines = all.slice(0, cfg.max_requests);
	return { lines, truncated: all.length - lines.length };
}

function buildUserPrompt(lines: RequestLine[]): string {
	return lines.map((l, i) => `${i + 1}. ${l.text.replace(/\s+/g, " ")}`).join("\n");
}

/** Keep only well-formed classes whose request numbers are in range. */
export function parseClasses(raw: unknown, requestCount: number): RequestClass[] {
	const obj = raw as { classes?: unknown } | undefined;
	if (!obj || !Array.isArray(obj.classes)) return [];
	const out: RequestClass[] = [];
	for (const entry of obj.classes) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as { name?: unknown; requests?: unknown };
		const name = typeof e.name === "string" ? e.name.trim() : "";
		if (!name) continue;
		const requests = Array.isArray(e.requests)
			? [...new Set(e.requests.filter((n): n is number => Number.isInteger(n) && n >= 1 && n <= requestCount))]
			: [];
		if (requests.length === 0) continue;
		out.push({ name, requests });
	}
	return out;
}

// ── the analyzer ──

interface PlanMeta {
	lines: RequestLine[];
	truncated: number;
}

export const requestClassesAnalyzer: Analyzer = {
	def: {
		id: "request-classes",
		label: "Request Classes (LLM, open vocabulary)",
		description:
			"Asks the model to name its own set of classes describing the types of request in a session, with no taxonomy supplied, and to assign each request to them. The emergent vocabulary is the finding.",
		anchorSpan: "full_session",
		dependencies: [],
	},
	version: {
		analyzerId: "request-classes",
		major: 1,
		minor: 0,
		implementationKind: "in_process_llm",
		codeRef: "src/analyze/analyzers/request-classes/index.ts",
	},
	prompts: {
		classify: { hash: "", content: CLASSIFY_PROMPT, role: "system" },
	},
	defaultConfig: {
		id: "",
		analyzerId: "request-classes",
		configHash: "",
		configJson: DEFAULT_REQUEST_CLASSES_CONFIG as unknown as Record<string, unknown>,
		label: "default",
	},

	modelsForIdentity(config, modelTiers) {
		const cfg = (config as unknown as RequestClassesConfig) ?? DEFAULT_REQUEST_CLASSES_CONFIG;
		return [resolveModelSpec(cfg.tier ?? "cheap", modelTiers)];
	},

	plan(ctx: AnalyzerPlanContext): AnalysisUnit[] {
		const cfg = (ctx.config as unknown as RequestClassesConfig) ?? DEFAULT_REQUEST_CLASSES_CONFIG;
		const { lines, truncated } = collectRequests(ctx.messages, cfg);
		if (lines.length === 0) return [];

		const meta: PlanMeta = { lines, truncated };
		return [
			{
				sources: lines.map((l) => ({ kind: "message" as const, id: l.messageId })),
				// Identity follows the requests themselves: a session that gained a
				// turn is a new unit and gets re-classified, one that did not is a
				// cache hit.
				sourceSetHash: `request-classes:${ctx.sessionId}:${lines.length}:${lines[lines.length - 1]?.messageId ?? ""}`,
				anchorKind: "session",
				anchorRef: ctx.sessionId,
				meta: meta as unknown as Record<string, unknown>,
			},
		];
	},

	async analyze(unit: AnalysisUnit, ctx: AnalyzerRunContext): Promise<AnalysisResult> {
		const cfg = (ctx.config.configJson as unknown as RequestClassesConfig) ?? DEFAULT_REQUEST_CLASSES_CONFIG;
		const meta = unit.meta as unknown as PlanMeta;

		const response = await ctx.llm({
			model: resolveModelSpec(cfg.tier ?? "cheap", ctx.modelTiers),
			system: ctx.prompts["classify"] ?? CLASSIFY_PROMPT,
			user: buildUserPrompt(meta.lines),
			temperature: cfg.temperature ?? 0,
			maxTokens: 2000,
			tool: CLASSIFY_TOOL,
		});

		const properties: RequestClassesProperties = {
			session_id: ctx.sessionId,
			classes: parseClasses(response.structured, meta.lines.length),
			request_message_ids: meta.lines.map((l) => l.messageId),
			truncated: meta.truncated,
		};

		return {
			nodeKind: "classification",
			contentJson: properties as unknown as Record<string, unknown>,
			anchorKind: "session",
			anchorRef: ctx.sessionId,
			modelUsed: response.model,
			costUsd: response.costUsd,
			tokensUsed: response.tokensUsed,
			durationMs: response.durationMs,
			edges: [{ toRefKind: REF_KINDS.SESSION, toRefId: ctx.sessionId, edgeKind: EDGE_KINDS.ANCHORS, ordinal: 0 }],
		};
	},
};
