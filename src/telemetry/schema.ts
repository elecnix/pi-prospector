import { Type, type Static } from "typebox";

/**
 * The anonymous usage payload (#290), shared by the client that builds it and
 * the Cloudflare Worker that stores it. Every value is a number or comes from a
 * fixed list, so the payload has no place for conversation text, paths, or ids
 * that point back at a session.
 */

/**
 * Analyzer ids a payload may name. The client reports any other analyzer (a
 * locally authored one, whose id the user chose) as `custom`. The Worker stores
 * an id it doesn't know as `other`, so a newer client keeps working against an
 * older Worker.
 */
export const KNOWN_ANALYZER_IDS = [
	"turn-pair-core",
	"lexicon-candidates",
	"frustration-lexicon",
	"turn-frustration",
	"turn-pair-llm",
	"assistant-cognition",
	"tool-trajectory",
	"phase-trajectory",
	"plan-compliance",
	"task-tool-mismatch",
	"failure-modes",
	"grounded-claims",
	"revive-chains",
	"uncompleted-leads",
	"compression-checklist",
	"language-mismatch",
	"decode-collapse",
	"repetition-collapse",
	"session-ending",
	"time-economy",
	"files-in-play",
	"navigation-efficiency",
	"similarity-cluster",
	"friction-accumulation",
	"tool-inventory-tax",
	"context-economy",
	"cache-economy",
	"routing-opportunity",
	"secret-leak",
	"gitleaks",
	"nosey-parker",
	"detect-secrets",
	"trufflehog",
	"secret-scanner",
	"presidio",
	"piicatcher",
	"dataprofiler",
	"token-units",
	"request-classes",
	"session-overview",
	"rule-restatement",
	"proposal-validate",
	"custom",
	"other",
] as const;

/** Largest request body the Worker reads, in bytes. */
export const MAX_BODY_BYTES = 8192;
/** Most rows one payload may carry. */
export const MAX_ROWS = 100;
/** Largest value any count may take. */
export const MAX_COUNT = 10_000_000;

const Count = Type.Integer({ minimum: 0, maximum: MAX_COUNT });

/** An analyzer id: kebab-case, short. The Worker maps one it doesn't know to `other`. */
const AnalyzerId = Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,47}$" });

/** One analyzer's totals for one harness over the reporting window. */
export const UsageRow = Type.Object(
	{
		analyzer: AnalyzerId,
		harness: Type.Union([Type.Literal("pi"), Type.Literal("claude")]),
		runs: Count,
		runsFailed: Count,
		sessions: Count,
		nodes: Count,
		durationSec: Count,
		proposals: Count,
		friction: Count,
		correction: Count,
		waste: Count,
		suggestion: Count,
		reinforcement: Count,
		accepted: Count,
		rejected: Count,
		acceptedModified: Count,
	},
	{ additionalProperties: false },
);
export type UsageRow = Static<typeof UsageRow>;

/** What the client POSTs once a day. */
export const UsagePayload = Type.Object(
	{
		schema: Type.Literal(1),
		installId: Type.String({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" }),
		version: Type.String({ pattern: "^[0-9]{1,4}\\.[0-9]{1,4}\\.[0-9]{1,4}$" }),
		rows: Type.Array(UsageRow, { maxItems: MAX_ROWS }),
	},
	{ additionalProperties: false },
);
export type UsagePayload = Static<typeof UsagePayload>;

/** The count columns of a row, in storage order. */
export const COUNT_FIELDS = [
	"runs",
	"runsFailed",
	"sessions",
	"nodes",
	"durationSec",
	"proposals",
	"friction",
	"correction",
	"waste",
	"suggestion",
	"reinforcement",
	"accepted",
	"rejected",
	"acceptedModified",
] as const satisfies ReadonlyArray<keyof UsageRow>;
