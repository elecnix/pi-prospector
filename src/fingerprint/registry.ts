import type { Analyzer } from "../analyze/types.js";
import type { FingerprintContributor } from "./contributor.js";
import { shapeContributor, sourcesContributor, usageContributor } from "./contributors/sessions.js";
import { checkContributorDef, METRIC_ID_PATTERN } from "./contributor.js";
import { ID_PATTERN, SECTION_FIELDS } from "./schema.js";

/**
 * The fingerprint's contributors, in the order their sections print: the ones
 * that read the session index, then the ones the built-in analyzers declare
 * through `Analyzer.fingerprint`, in the analyzers' registration order.
 *
 * Only the analyzers passed in contribute. The command passes the built-in set:
 * a locally authored analyzer chooses its own ids and shapes, and nothing about
 * it has been reviewed as shareable, so it adds no section unless the caller
 * hands it in on purpose.
 */
export const CORE_CONTRIBUTORS: readonly FingerprintContributor[] = [sourcesContributor, usageContributor, shapeContributor];

/**
 * Gather the contributors and check them: a section id is unique within its
 * kind, ids and measure ids have the shape of a short name, and a section
 * declares a measure id once. A violation throws at registration, not at
 * the first fingerprint.
 */
export function collectContributors(analyzers: readonly Analyzer[], core: readonly FingerprintContributor[] = CORE_CONTRIBUTORS): FingerprintContributor[] {
	const all = [...core, ...analyzers.flatMap((a) => a.fingerprint ?? [])];
	const seen = new Set<string>();
	for (const { def } of all) {
		if (!ID_PATTERN.test(def.id)) throw new Error(`fingerprint contributor id '${def.id}' must match ${ID_PATTERN}`);
		const key = `${def.kind}:${def.id}`;
		if (seen.has(key)) throw new Error(`fingerprint contributor '${def.id}' is registered twice under ${def.kind}`);
		seen.add(key);
		const measureIds = new Set<string>();
		for (const m of def.measures) {
			if ((SECTION_FIELDS as readonly string[]).includes(m.id)) throw new Error(`fingerprint contributor '${def.id}': measure id '${m.id}' is reserved (${SECTION_FIELDS.join(", ")})`);
			if (measureIds.has(m.id)) throw new Error(`fingerprint contributor '${def.id}' declares measure '${m.id}' twice`);
			measureIds.add(m.id);
			if (m.metric !== undefined && !new RegExp(METRIC_ID_PATTERN).test(m.metric)) {
				throw new Error(`fingerprint contributor '${def.id}' measure '${m.id}' has metric '${m.metric}', which is not <analyzer-id>.<metric-name>`);
			}
		}
		// The checks above name the problem; this one catches the rest of what the schema states.
		checkContributorDef(def);
	}
	return all;
}

const NOT_YET_DECIDED = "not yet decided";
const SECRET_SCANNER = "secret scanner: findings must never leave the machine";
const MODEL_NAMED_CLASSES = "free text: the model names its own request classes, so no fixed list can hold them";
/** regression-attribution resolves a blame only to a pull request a local session opened, which few blames are. */
const REGRESSION_ATTRIBUTION = "regression attribution: nodes on under 1% of sessions";
/** regression-prevention groups the verdicts into one corpus-wide node; the regressions section counts the same classes per session. */
const REGRESSION_PREVENTION = "corpus aggregate of regression-verdict: measured through it";
/** An analyzer whose output only feeds another one, whose section measures it. */
const inputTo = (analyzerId: string) => `input to ${analyzerId}: measured through it`;
const INPUT_TO_PROMPT_FORM = inputTo("prompt-form");
const INPUT_TO_FRUSTRATION_LEXICON = inputTo("frustration-lexicon");
const INPUT_TO_TURN_FRUSTRATION = inputTo("turn-frustration");
/** verification-commands judges distinct command lines, not sessions; stale-verification reads its verdicts. */
const INPUT_TO_STALE_VERIFICATION = inputTo("stale-verification");
const PROPOSAL_QUEUE = "judges the open proposals, not the sessions: its counts follow proposal review";
const POOLED_CLUSTERS = "pools a repository's sessions: a node's clusters are not its own session's, so no per-session figure";

/** The reasons a built-in analyzer may be left out of the fingerprint. */
export const EXCLUSION_REASONS: readonly string[] = [
	NOT_YET_DECIDED,
	SECRET_SCANNER,
	REGRESSION_ATTRIBUTION,
	REGRESSION_PREVENTION,
	INPUT_TO_STALE_VERIFICATION,
	MODEL_NAMED_CLASSES,
	INPUT_TO_PROMPT_FORM,
	INPUT_TO_FRUSTRATION_LEXICON,
	INPUT_TO_TURN_FRUSTRATION,
	PROPOSAL_QUEUE,
	POOLED_CLUSTERS,
];

/**
 * The built-in analyzers that contribute no fingerprint section, each with the
 * reason. An analyzer contributes only by declaring a non-empty `fingerprint`
 * list, so without this list a new analyzer would be left out without anyone
 * deciding it. `tests/unit/fingerprint-coverage.test.ts` fails when a built-in
 * analyzer neither contributes nor is listed here, and when a listed one starts
 * contributing. Removing an analyzer from this list means adding its
 * contributor in the same pull request.
 */
export const FINGERPRINT_EXCLUDED: Readonly<Record<string, string>> = {
	// It nominates the person's own words for the lexicon to judge; the words never leave the machine.
	"lexicon-candidates": INPUT_TO_FRUSTRATION_LEXICON,
	// It learns a per-person word list. turn-frustration publishes the categories of the hits, never the words.
	"frustration-lexicon": INPUT_TO_TURN_FRUSTRATION,
	// Its answers reach the fingerprint as prompt-form's `promptKind` section.
	"message-answers": INPUT_TO_PROMPT_FORM,
	"phase-trajectory": NOT_YET_DECIDED,
	"plan-compliance": NOT_YET_DECIDED,
	"grounded-claims": NOT_YET_DECIDED,
	"revive-chains": NOT_YET_DECIDED,
	"uncompleted-leads": NOT_YET_DECIDED,
	"compression-checklist": NOT_YET_DECIDED,
	"decode-collapse": NOT_YET_DECIDED,
	"repetition-collapse": NOT_YET_DECIDED,
	"session-ending": NOT_YET_DECIDED,
	"activity-windows": NOT_YET_DECIDED,
	// A session's node clusters the items of its repository's sibling sessions too, so the same cluster repeats
	// in every sibling's node and a session can carry a cluster none of its own messages belong to.
	"similarity-cluster": POOLED_CLUSTERS,
	"verification-commands": INPUT_TO_STALE_VERIFICATION,
	"friction-accumulation": NOT_YET_DECIDED,
	// It reads only rule-shaped proposals still open, so accepting or rejecting proposals changes its counts.
	// Its other fields are instruction-file paths and quotes.
	"rule-restatement": PROPOSAL_QUEUE,
	"request-classes": MODEL_NAMED_CLASSES,
	"secret-leak": SECRET_SCANNER,
	"gitleaks": SECRET_SCANNER,
	"nosey-parker": SECRET_SCANNER,
	"detect-secrets": SECRET_SCANNER,
	"trufflehog": SECRET_SCANNER,
	"secret-scanner": SECRET_SCANNER,
	"presidio": SECRET_SCANNER,
	"piicatcher": SECRET_SCANNER,
	"dataprofiler": SECRET_SCANNER,
	"regression-attribution": REGRESSION_ATTRIBUTION,
	"regression-prevention": REGRESSION_PREVENTION,
};
