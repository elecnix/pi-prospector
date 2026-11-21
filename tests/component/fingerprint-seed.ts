import { createRun, insertNode } from "../../src/db/analysis-queries.js";
import { buildFingerprint, parseFingerprintArgs } from "../../src/fingerprint/build.js";
import { collectContributors } from "../../src/fingerprint/registry.js";
import { BUILTIN_ANALYZERS } from "../../src/analyze/defaults.js";
import type { Fingerprint } from "../../src/fingerprint/schema.js";
import type { AsyncDatabase } from "../../src/db/async-db.js";

/**
 * Seeding for the tests of one analyzer's fingerprint section: sessions with no
 * messages, and the runs and nodes the section reads. Every string a test seeds
 * that is not a fixed value is a sentinel the output must never contain.
 */

export const ASOF = "2026-06-30T12:00:00.000Z";
const AT = "2026-05-01T00:00:00.000Z";

let n = 0;

export async function seedSession(db: AsyncDatabase, id: string): Promise<void> {
	await db
		.prepare(
			"INSERT INTO sessions (id, file_path, project, source, cwd, parent_session, name, started_at, last_line, last_modified, message_count, branch_count) VALUES (?, ?, 'SECRET-PROJECT', 'pi', '/home/secret/path', NULL, 'Secret title', '2026-03-01T10:00:00.000Z', 0, 0, 0, 0)",
		)
		.run(id, `/home/secret/path/${id}.jsonl`);
}

export async function seedRun(db: AsyncDatabase, sessionId: string, analyzerId: string, version: string): Promise<void> {
	n++;
	await createRun(db, { id: `run-${n}`, analyzerId, analyzerVersionId: version, configId: "c", sessionId, mode: "fill", promptBundleHash: "" });
	await db.prepare("UPDATE analysis_runs SET started_at = ? WHERE id = ?").run(AT, `run-${n}`);
}

export async function seedNode(db: AsyncDatabase, sessionId: string, analyzerId: string, content: unknown, version: string): Promise<void> {
	n++;
	await insertNode(db, {
		id: `node-${n}`,
		sessionId,
		analyzerId,
		analyzerVersionId: version,
		configId: "c",
		runId: null,
		nodeKind: "metric",
		contentJson: JSON.stringify(content),
		sourceSetHash: `ssh-${n}`,
		inputKey: `ik-${n}`,
		outputKey: `ok-${n}`,
		createdAt: AT,
	});
}

/** The fingerprint of the whole corpus as of ASOF, from the built-in contributors. */
export function fingerprintOf(db: AsyncDatabase): Promise<Fingerprint> {
	return buildFingerprint(db, parseFingerprintArgs(`--as-of ${ASOF}`, new Date(ASOF)), collectContributors(BUILTIN_ANALYZERS));
}

export type Section = Record<string, unknown> & { status: string; sessionsMeasured?: number };

export function sectionOf(fp: Fingerprint, kind: "objective" | "inferred", id: string): Section {
	const section = fp[kind][id];
	if (section === undefined) throw new Error(`no ${kind} section '${id}'`);
	return section as Section;
}

/** A breakdown measure without its per-group session counts, keyed by its dimension values. */
export function countsOf(measure: unknown, dimensions: readonly string[]): Record<string, number> {
	if (!Array.isArray(measure)) throw new Error(`not a breakdown: ${JSON.stringify(measure)}`);
	return Object.fromEntries((measure as Array<Record<string, unknown>>).map((g) => [dimensions.map((d) => String(g[d])).join("/"), Number(g["count"])]));
}

/** Session ids `<prefix>-1` to `<prefix>-<count>`. */
export function ids(prefix: string, count: number): string[] {
	return Array.from({ length: count }, (_, i) => `${prefix}-${i + 1}`);
}
