import { createRun, insertNode } from "../../src/db/analysis-queries.js";
import { buildFingerprint, parseFingerprintArgs } from "../../src/fingerprint/build.js";
import { collectContributors } from "../../src/fingerprint/registry.js";
import { BUILTIN_ANALYZERS } from "../../src/analyze/defaults.js";
import type { Fingerprint } from "../../src/fingerprint/schema.js";
import type { AsyncDatabase } from "../../src/db/async-db.js";

/**
 * Seeding for the tests of one analyzer's fingerprint section: top-level
 * sessions, runs and nodes, written straight to the graph so a test states
 * exactly what an analyzer left behind. Every identifying string a test seeds
 * is a sentinel the fingerprint must never carry.
 */

export const ASOF = "2026-06-30T12:00:00.000Z";
const AT = "2026-05-01T00:00:00.000Z";
export const SENTINELS = ["SECRET-PROJECT", "/home/secret/path", "Secret title", "hunter2", "github.com", "secret-owner"];
export const contributors = collectContributors(BUILTIN_ANALYZERS);

let n = 0;

export async function seedSession(db: AsyncDatabase, id: string, startedAt = "2026-03-01T10:00:00.000Z"): Promise<void> {
	await db
		.prepare(
			"INSERT INTO sessions (id, file_path, project, source, cwd, parent_session, name, started_at, last_line, last_modified, message_count, branch_count) VALUES (?, ?, 'SECRET-PROJECT', 'pi', '/home/secret/path', NULL, 'Secret title', ?, 0, 0, 0, 0)",
		)
		.run(id, `/home/secret/path/${id}.jsonl`, startedAt);
}

export async function seedRun(db: AsyncDatabase, sessionId: string, analyzerId: string, version = "1.0"): Promise<void> {
	n++;
	await createRun(db, { id: `run-${n}`, analyzerId, analyzerVersionId: version, configId: "c", sessionId, mode: "fill", promptBundleHash: "" });
	await db.prepare("UPDATE analysis_runs SET started_at = ? WHERE id = ?").run(AT, `run-${n}`);
}

/** One current node. The analyzer is recorded as repaired: these graphs are written under lineage by subject. */
export async function seedNode(db: AsyncDatabase, sessionId: string, analyzerId: string, content: unknown, version = "1.0", at = AT): Promise<void> {
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
		createdAt: at,
	});
	await db.prepare("INSERT OR IGNORE INTO lineage_repairs (analyzer_id, repaired_at, edges) VALUES (?, ?, 0)").run(analyzerId, at);
}

/** The fingerprint of the built-in contributors as of `ASOF`. The builder checks it against the schema they compose. */
export function fingerprintOf(db: AsyncDatabase): Promise<Fingerprint> {
	return buildFingerprint(db, parseFingerprintArgs(`--as-of ${ASOF}`, new Date(ASOF)), contributors);
}

export type Section = Record<string, unknown> & { status: string; sessionsMeasured?: number };

export function sectionOf(fp: Fingerprint, kind: "objective" | "inferred", id: string): Section {
	const section = fp[kind][id];
	if (section === undefined) throw new Error(`no ${kind} section '${id}'`);
	return section as Section;
}

/** The identifying sentinels the fingerprint text carries. */
export function leakedSentinels(fp: Fingerprint, extra: readonly string[] = []): string[] {
	const text = JSON.stringify(fp);
	return [...SENTINELS, ...extra].filter((s) => text.includes(s));
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
