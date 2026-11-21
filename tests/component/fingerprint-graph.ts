/**
 * Seeding for the fingerprint sections that read the analysis graph: top-level
 * sessions with a start date, and the runs and nodes an analyzer would have
 * written for them. Every string here is synthetic.
 */

import { tempDb, type TempDb } from "./helpers.js";
import { createRun, insertNode } from "../../src/db/analysis-queries.js";
import { buildFingerprint, parseFingerprintArgs } from "../../src/fingerprint/build.js";
import { collectContributors } from "../../src/fingerprint/registry.js";
import { BUILTIN_ANALYZERS } from "../../src/analyze/defaults.js";
import type { Fingerprint } from "../../src/fingerprint/schema.js";

export const ASOF = "2026-06-30T12:00:00.000Z";
export const contributors = collectContributors(BUILTIN_ANALYZERS);

export type Section = Record<string, unknown> & { status: string; sessionsMeasured?: number };

export class GraphSeed {
	private n = 0;
	private constructor(readonly t: TempDb) {}

	static async open(): Promise<GraphSeed> {
		return new GraphSeed(await tempDb());
	}

	close(): Promise<void> {
		return this.t.close();
	}

	async session(id: string, startedAt = "2026-03-01T10:00:00.000Z", parent: string | null = null): Promise<void> {
		await this.t.db
			.prepare(
				"INSERT INTO sessions (id, file_path, project, source, cwd, parent_session, name, started_at, last_line, last_modified, message_count, branch_count) VALUES (?, ?, 'SECRET-PROJECT', 'pi', '/home/secret/path', ?, 'Secret title', ?, 0, 0, 0, 0)",
			)
			.run(id, `/home/secret/path/${id}.jsonl`, parent, startedAt);
	}

	async run(sessionId: string, analyzerId: string, version = "1.0", at = "2026-05-01T00:00:00.000Z"): Promise<void> {
		this.n++;
		await createRun(this.t.db, { id: `run-${this.n}`, analyzerId, analyzerVersionId: version, configId: "c", sessionId, mode: "fill", promptBundleHash: "" });
		await this.t.db.prepare("UPDATE analysis_runs SET started_at = ? WHERE id = ?").run(at, `run-${this.n}`);
	}

	async node(sessionId: string, analyzerId: string, content: unknown, version = "1.0", at = "2026-05-01T00:00:00.000Z"): Promise<void> {
		this.n++;
		await insertNode(this.t.db, {
			id: `node-${this.n}`,
			sessionId,
			analyzerId,
			analyzerVersionId: version,
			configId: "c",
			runId: null,
			nodeKind: "metric",
			contentJson: JSON.stringify(content),
			sourceSetHash: `ssh-${this.n}`,
			inputKey: `ik-${this.n}`,
			outputKey: `ok-${this.n}`,
			createdAt: at,
		});
	}

	/** A session the analyzer ran on, with one node of the given content (none when `content` is null). */
	async analysed(id: string, analyzerId: string, content: unknown, version = "1.0"): Promise<void> {
		await this.session(id);
		await this.run(id, analyzerId, version);
		if (content !== null) await this.node(id, analyzerId, content, version);
	}

	fingerprint(): Promise<Fingerprint> {
		return buildFingerprint(this.t.db, parseFingerprintArgs(`--as-of ${ASOF}`, new Date(ASOF)), contributors);
	}

	async section(kind: "objective" | "inferred", id: string): Promise<Section> {
		return (await this.fingerprint())[kind][id] as Section;
	}
}

/** The strings a seeded corpus carries that a fingerprint must never print. */
export const SENTINELS = ["SECRET-PROJECT", "/home/secret/path", "Secret title", "hunter2"];
