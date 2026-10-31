import type { Analyzer } from "../analyze/types.js";
import type { FingerprintContributor } from "./contributor.js";
import { shapeContributor, sourcesContributor, usageContributor } from "./contributors/sessions.js";
import { ID_PATTERN } from "./schema.js";

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
			if (measureIds.has(m.id)) throw new Error(`fingerprint contributor '${def.id}' declares measure '${m.id}' twice`);
			measureIds.add(m.id);
		}
	}
	return all;
}
