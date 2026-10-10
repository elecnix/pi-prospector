import { Type, type Static } from "typebox";

/**
 * The anonymous usage report (#290). pi-prospector sends it to a deployment of
 * [usage-tracker](https://github.com/elecnix/usage-tracker), which stores only
 * the dimensions and counts that `telemetry/tracker.config.json` lists. Every
 * value is a number or comes from a fixed list, so a report has no place for
 * conversation text, paths, or ids that point back at a session.
 *
 * `tests/unit/telemetry-config.test.ts` keeps this file and the tracker config
 * in step.
 */

/** The app name in the tracker config. */
export const TRACKER_APP = "pi-prospector";

/**
 * Analyzer ids a report may name. The client reports any other analyzer (a
 * locally authored one, whose id the user chose) as `custom`. The tracker
 * stores an id its config doesn't list as `other`, so a newer client keeps
 * working against an older deployment.
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
] as const;

export const HARNESSES = ["pi", "claude"] as const;

/** Most rows one report may carry. */
export const MAX_ROWS = 100;
/** Largest value any count may take. */
export const MAX_COUNT = 10_000_000;

/** The counts of a row, in the tracker config's order. */
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
] as const;

const Count = Type.Integer({ minimum: 0, maximum: MAX_COUNT });

type KnownAnalyzer = (typeof KNOWN_ANALYZER_IDS)[number];
type Harness = (typeof HARNESSES)[number];
const AnalyzerDimension = Type.Unsafe<KnownAnalyzer>(Type.Union(KNOWN_ANALYZER_IDS.map((id) => Type.Literal(id))));
const HarnessDimension = Type.Unsafe<Harness>(Type.Union(HARNESSES.map((h) => Type.Literal(h))));

/** One analyzer's totals for one harness over the reporting window. */
export const UsageRow = Type.Object(
	{
		analyzer: Type.String(),
		harness: Type.String(),
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

/** A report as usage-tracker's `POST /v1/report` takes it. */
export const UsageReport = Type.Object(
	{
		app: Type.Literal(TRACKER_APP),
		installId: Type.String({ pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$" }),
		version: Type.String({ pattern: "^[0-9]{1,4}\\.[0-9]{1,4}\\.[0-9]{1,4}$" }),
		rows: Type.Array(
			Type.Object(
				{
					dimensions: Type.Object(
						{
							analyzer: AnalyzerDimension,
							harness: HarnessDimension,
						},
						{ additionalProperties: false },
					),
					counts: Type.Unsafe<Record<(typeof COUNT_FIELDS)[number], number>>(
						Type.Object(Object.fromEntries(COUNT_FIELDS.map((field) => [field, Count])), { additionalProperties: false }),
					),
				},
				{ additionalProperties: false },
			),
			{ maxItems: MAX_ROWS },
		),
	},
	{ additionalProperties: false },
);
export type UsageReport = Static<typeof UsageReport>;

const KNOWN = new Set<string>(KNOWN_ANALYZER_IDS);

/** The id a report may carry for an analyzer: its own when shipped, `custom` otherwise. */
export function reportedAnalyzer(id: string): KnownAnalyzer {
	return KNOWN.has(id) ? (id as KnownAnalyzer) : "custom";
}

/** Turn flat rows into the tracker's dimensions-and-counts shape. */
export function toReport(installId: string, version: string, rows: UsageRow[]): UsageReport {
	return {
		app: TRACKER_APP,
		installId,
		version,
		rows: rows.slice(0, MAX_ROWS).map((row) => ({
			dimensions: { analyzer: reportedAnalyzer(row.analyzer), harness: row.harness === "claude" ? "claude" : "pi" },
			counts: Object.fromEntries(COUNT_FIELDS.map((field) => [field, row[field]])) as Record<(typeof COUNT_FIELDS)[number], number>,
		})),
	};
}
