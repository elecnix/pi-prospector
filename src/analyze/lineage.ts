/**
 * A session's parent link, as an input of the units that read it (#416).
 *
 * An analyzer whose result depends on the link (whether the session is a child
 * agent's, or which session a fork copied) puts this ref in each unit's source
 * set, so the link is part of the recipe. A link recorded or changed after the
 * analysis then gives the unit a new source set, and the scan finds it missing.
 * A session with no parent adds nothing, so its units keep the identity they had
 * before links were part of it.
 */
import type { SessionLineage } from "../db/queries.js";
import type { SourceRef } from "./types.js";

export function lineageSources(lineage: SessionLineage | undefined): SourceRef[] {
	const parent = lineage?.parent_session?.trim();
	if (!parent) return [];
	return [{ kind: "session", id: `parent-link:${lineage?.parent_kind ?? "unrecorded"}:${parent}` }];
}
