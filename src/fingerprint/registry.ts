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

/** The reasons a built-in analyzer may be left out of the fingerprint. */
export const EXCLUSION_REASONS: readonly string[] = [
	NOT_YET_DECIDED,
	SECRET_SCANNER,
	REGRESSION_ATTRIBUTION,
	MODEL_NAMED_CLASSES,
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
};
