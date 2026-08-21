/**
 * Ingestion of subagent artifact metadata — the durable record of *why* a child
 * run failed.
 *
 * When a subagent run fails at spawn level, no assistant message is written
 * anywhere: the child session has zero turns, and the only evidence that
 * anything happened at all is a `*_meta.json` file the host drops beside the
 * parent session, under `<project-dir>/subagent-artifacts/`. Nothing else in the
 * index can see these failures, so this module reads those files and upserts
 * them into `subagent_runs`.
 *
 * The join to the parent is by *directory nesting*, deliberately, not by text
 * matching: the artifacts directory sits inside the same project directory as
 * the parent session files, so recording the project is enough to attach a run
 * to its parent's corpus without parsing any transcript for markers.
 *
 * Incremental like sessions: a meta file is re-read and re-upserted only when
 * its mtime moved past the stored `file_mtime` (the session cursor pattern,
 * keyed by run id rather than file path). Meta files are tiny, so reading one
 * to learn its run id before the mtime check costs nothing.
 *
 * Deterministic: the raw `error` text is stored verbatim in the *source index*
 * — the same trust level as `messages.error_message` — but classification into
 * curated labels is the analyzer's job, never the ingest layer's.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type AsyncDatabase } from "../db/async-db.js";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import { getSubagentRunMtime, upsertSubagentRun } from "../db/queries.js";

/** How much of a run's task text is kept. The full task lives in the artifact. */
export const TASK_EXCERPT_CHARS = 300;

const Usage = Type.Object({
	input: Type.Optional(Type.Number()),
	output: Type.Optional(Type.Number()),
	cacheRead: Type.Optional(Type.Number()),
	cacheWrite: Type.Optional(Type.Number()),
	cost: Type.Optional(Type.Number()),
	turns: Type.Optional(Type.Number()),
});

const ModelAttempt = Type.Object({
	model: Type.String(),
	success: Type.Boolean(),
	exitCode: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
	error: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	usage: Type.Optional(Usage),
});

/**
 * The artifact metadata shape, as the host writes it. Extra fields are allowed:
 * the host may record more than we read, and refusing the file over an unknown
 * field would lose the failure it describes.
 */
const SubagentArtifactMeta = Type.Object({
	runId: Type.String({ minLength: 1 }),
	agent: Type.String({ minLength: 1 }),
	task: Type.Optional(Type.String()),
	exitCode: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
	error: Type.Optional(Type.Union([Type.String(), Type.Null()])),
	attemptedModels: Type.Optional(Type.Array(Type.String())),
	modelAttempts: Type.Optional(Type.Array(ModelAttempt)),
	usage: Type.Optional(Usage),
});

/** What ingestion stores for one artifact file — already shaped for the table. */
export interface ParsedSubagentArtifact {
	runId: string;
	agent: string | null;
	task_excerpt: string | null;
	exit_code: number | null;
	error: string | null;
	/** The modelAttempts array, re-serialised verbatim; null when unrecorded. */
	model_attempts: string | null;
	/** The usage object, re-serialised verbatim; null when unrecorded. */
	usage: string | null;
}

/**
 * Split an artifact file name of the form `<runId>_<agent>_meta.json`.
 *
 * The run id is a uuid, so the first underscore is the separator. Used only
 * when the file body does not name its own run — an older or truncated meta
 * still records *that* a run existed, which is worth keeping.
 */
export function splitArtifactFileName(fileName: string): { runId: string; agent: string } | null {
	if (!fileName.endsWith("_meta.json")) return null;
	const stem = fileName.slice(0, -"_meta.json".length);
	const sep = stem.indexOf("_");
	if (sep <= 0 || sep === stem.length - 1) return null;
	return { runId: stem.slice(0, sep), agent: stem.slice(sep + 1) };
}

function excerpt(task: string | undefined): string | null {
	if (typeof task !== "string") return null;
	const trimmed = task.trim();
	if (trimmed.length === 0) return null;
	return trimmed.slice(0, TASK_EXCERPT_CHARS);
}

function jsonString(value: unknown): string | null {
	return value === undefined ? null : JSON.stringify(value);
}

/**
 * Parse one `*_meta.json` body into a row, or null when it names no run.
 *
 * The strict path validates the full schema. The tolerant fallback accepts a
 * body that is at least an object naming a run (from its body or its file
 * name), carrying whatever fields are present — losing a failure because the
 * metadata was thinner than the schema would be the worse outcome.
 */
export function parseSubagentArtifact(text: string, fileName: string): ParsedSubagentArtifact | null {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;

	if (Check(SubagentArtifactMeta, value)) {
		const meta = value as Static<typeof SubagentArtifactMeta>;
		return {
			runId: meta.runId,
			agent: meta.agent,
			task_excerpt: excerpt(meta.task),
			exit_code: meta.exitCode ?? null,
			error: meta.error ?? null,
			model_attempts: jsonString(meta.modelAttempts),
			usage: jsonString(meta.usage),
		};
	}

	const record = value as Record<string, unknown>;
	const fromName = splitArtifactFileName(fileName);
	const runId = typeof record["runId"] === "string" && record["runId"] ? record["runId"] : fromName?.runId;
	if (!runId) return null;
	return {
		runId,
		agent: typeof record["agent"] === "string" && record["agent"] ? record["agent"] : fromName?.agent ?? null,
		task_excerpt: typeof record["task"] === "string" ? excerpt(record["task"]) : null,
		exit_code: typeof record["exitCode"] === "number" ? record["exitCode"] : null,
		error: typeof record["error"] === "string" ? record["error"] : null,
		model_attempts: Array.isArray(record["modelAttempts"]) ? JSON.stringify(record["modelAttempts"]) : null,
		usage: typeof record["usage"] === "object" && record["usage"] !== null ? JSON.stringify(record["usage"]) : null,
	};
}

/** One discovered artifact file. */
export interface DiscoveredArtifact {
	filePath: string;
	/** The project directory name the artifacts sit beside — the parent join key. */
	project: string;
	mtime: number;
}

/**
 * Find every `*_meta.json` under `<project-dir>/subagent-artifacts/` for each
 * project directory in the sessions root. A missing or unreadable directory
 * contributes nothing: a corpus with no subagent runs is normal, not an error.
 */
export async function discoverSubagentArtifacts(sessionsDir: string, projectFilter?: string): Promise<DiscoveredArtifact[]> {
	const out: DiscoveredArtifact[] = [];

	let projects: string[];
	try {
		projects = await fs.readdir(sessionsDir);
	} catch {
		return out;
	}

	for (const project of projects) {
		if (projectFilter && project !== projectFilter) continue;
		const artifactDir = path.join(sessionsDir, project, "subagent-artifacts");
		let files: string[];
		try {
			files = await fs.readdir(artifactDir);
		} catch {
			continue;
		}
		for (const file of files) {
			if (!file.endsWith("_meta.json")) continue;
			const filePath = path.join(artifactDir, file);
			let stat: Awaited<ReturnType<typeof fs.stat>>;
			try {
				stat = await fs.stat(filePath);
			} catch {
				continue;
			}
			if (!stat.isFile()) continue;
			out.push({ filePath, project, mtime: stat.mtimeMs });
		}
	}

	// Deterministic order: project, then file name. Ingestion is idempotent, but
	// a stable order keeps error lists and counters reproducible run to run.
	return out.sort((a, b) => (a.project !== b.project ? a.project.localeCompare(b.project) : a.filePath.localeCompare(b.filePath)));
}

export interface ArtifactIngestResult {
	processed: number;
	skipped: number;
	errors: string[];
}

/**
 * Discover and upsert every artifact under the sessions root.
 *
 * Unchanged files (stored `file_mtime` >= the file's mtime) are skipped, the
 * same incremental contract sessions get from their cursor. A file that cannot
 * be parsed is reported in `errors` and never silently dropped.
 */
export async function ingestSubagentArtifacts(
	db: AsyncDatabase,
	sessionsDir: string,
	projectFilter?: string,
): Promise<ArtifactIngestResult> {
	const result: ArtifactIngestResult = { processed: 0, skipped: 0, errors: [] };

	for (const disc of await discoverSubagentArtifacts(sessionsDir, projectFilter)) {
		try {
			const parsed = parseSubagentArtifact(await fs.readFile(disc.filePath, "utf-8"), path.basename(disc.filePath));
			if (!parsed) {
				result.errors.push(`${disc.filePath}: not recognisable subagent artifact metadata`);
				continue;
			}

			const storedMtime = await getSubagentRunMtime(db, parsed.runId);
			if (storedMtime !== undefined && storedMtime >= disc.mtime) {
				result.skipped++;
				continue;
			}

			await upsertSubagentRun(db, {
				run_id: parsed.runId,
				project: disc.project,
				agent: parsed.agent,
				task_excerpt: parsed.task_excerpt,
				exit_code: parsed.exit_code,
				error: parsed.error,
				model_attempts: parsed.model_attempts,
				usage: parsed.usage,
				file_mtime: disc.mtime,
			});
			result.processed++;
		} catch (err) {
			result.errors.push(`${disc.filePath}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	return result;
}
