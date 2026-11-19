/**
 * PiFileSource — discovers and parses Pi agent session JSONL files.
 *
 * Migrated from the inline syncPiSession() in src/sync/index.ts to a
 * SessionSourceAdapter behind the interface introduced in #138.
 */
import { SyncFault } from "../../faults.js";
import { lineBatches } from "../../line-batches.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { collectBatches, type SessionSourceAdapter, type ParsedSession } from "../../adapter.js";
import type { DiscoveredSession } from "../../../types.js";
import type { SessionInsert, MessageInsert } from "../../../db/queries.js";
import { parseLine, extractSessionName } from "../../parser.js";
import { resolveFork } from "../../forks.js";
import { walkSessionDir } from "../../scanner.js";
import { getSessionsDir } from "../../../config.js";

/**
 * Pi's own session-file naming, as the harness's session store writes it:
 * `<timestamp>_<uuid>.jsonl`, wherever below a project directory pi put it.
 *
 * The timestamp is written with dashes, not with the colons and dot of the ISO
 * 8601 string it comes from: the session that started at `19:00:24.951Z` is stored
 * as `2026-09-11T19-00-24-951Z_01a091d7-…jsonl`. Hence `[\d-]+` between the `T`
 * and the `Z` rather than a looser class: discovery claims the shape the harness
 * writes, and every one of the 4262 session files on a live machine matches it.
 *
 * The stem is also the name pi gives the directory holding a session's child runs,
 * which is how those attach to their parent: see
 * {@link parentSessionFromRunPath}.
 *
 * Discovery claims nothing by extension, so this is the whole of "a pi session
 * file" for this source.
 */
const PI_SESSION_STEM_RE = /^\d{4}-\d{2}-\d{2}T[\d-]+Z_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * The session id pi's own file name carries, or null when the name is not one pi
 * gives its session files. Pi names a session file after the session it holds, so
 * the name is a record of the id wherever the file itself has gone.
 */
export function piSessionIdFromFileName(fileName: string): string | null {
	if (!fileName.endsWith(".jsonl")) return null;
	return PI_SESSION_STEM_RE.exec(fileName.slice(0, -".jsonl".length))?.[1] ?? null;
}

/** True when a file name is one pi gives its own session files. */
export function isPiSessionFileName(fileName: string): boolean {
	return piSessionIdFromFileName(fileName) !== null;
}

/**
 * The session that spawned a child run, from the run's path.
 *
 * Pi keeps a session's child runs inside a directory named after the session file
 * itself: `<project>/<timestamp>_<uuid>/<runhash>/run-N/session.jsonl`. So the
 * nearest ancestor directory carrying that naming holds the parent's session id,
 * while everything between it and the file (the `run-N` directory, the run's own
 * hash) belongs to the run and names no session.
 */
export function parentSessionFromRunPath(filePath: string): string | null {
	let dir = path.dirname(filePath);
	while (dir !== path.dirname(dir)) {
		const id = piSessionIdFromFileName(`${path.basename(dir)}.jsonl`);
		if (id) return id;
		dir = path.dirname(dir);
	}
	return null;
}

/**
 * A child run's session directory, named `run-N` by the pi-subagents extension.
 * The file inside it is a pi session — pi's format, pi's header — so this source
 * claims it; the extension's own artifacts (`*_transcript.jsonl`, `*_meta.json`)
 * are its data and are claimed by its own source instead.
 */
const RUN_DIR_RE = /^run-\d+$/;

export class PiFileSource implements SessionSourceAdapter {
	readonly source = "pi";
	/**
	 * Claim order, just after pi-subagent: both sources discover a child run's
	 * `session.jsonl`, and this one parses strictly less (it does not recover the
	 * parent session id), so the subagent source must claim those files first.
	 */
	readonly priority = 60;
	/** Child-run artifacts live under the same root as the sessions themselves. */
	readonly artifactsRoot: string;

	constructor(sessionsDir: string = getSessionsDir()) {
		this.artifactsRoot = sessionsDir;
	}

	async discover(): Promise<DiscoveredSession[]> {
		return walkSessionDir(this.artifactsRoot, "pi", {
			matchFile: (fileName, parentDirName) =>
				isPiSessionFileName(fileName) || (fileName === "session.jsonl" && RUN_DIR_RE.test(parentDirName)),
		});
	}

	async read(disc: DiscoveredSession, resumeLine: number): Promise<ParsedSession> {
		return collectBatches(this.readBatches(disc, resumeLine));
	}

	/** The file is streamed from its first line; only the lines from `resumeLine` on become rows, one batch at a time. */
	async *readBatches(disc: DiscoveredSession, resumeLine: number): AsyncGenerator<ParsedSession> {
		let sessionId = "";
		let cwd = "";
		let startedAt = "";
		let parsedHeader: import("../../../types.js").SessionHeader | null = null;
		let parentSessionId: string | null = null;
		let branchCount = 0;
		let forksResolved = 0;
		let name: string | null = null;
		let initialised = false;
		let forksReported = 0;

		for await (const batch of lineBatches(disc.filePath)) {
			if (!initialised) {
				// The header is the file's first non-empty line, wherever it falls: a batch of only
				// blank lines is passed over and the next one is looked at.
				const firstReal = batch.lines.findIndex((l) => l.trim() !== "");
				if (firstReal === -1) {
					if (batch.last) throw new SyncFault("no-session-header", `No session header: ${disc.filePath}`);
					continue;
				}
				let parentSession: string | null = null;
				const parsed = parseLine(batch.lines[firstReal]!);
				if (parsed && parsed.kind === "session") {
					parsedHeader = parsed.header;
					sessionId = parsed.header.id;
					parentSession = parsed.header.parentSession ?? null;
					cwd = parsed.header.cwd ?? "";
					startedAt = parsed.header.timestamp ?? "";
				}
				if (!sessionId) {
					throw new SyncFault("no-session-header", `No session header: ${disc.filePath}`);
				}
				// Resolve fork. The header names the parent as a *path*, and this column holds a
				// session id everywhere else, so the resolved id is what gets stored. Reading
				// the parent's own header is authoritative; when that file is gone, pi's naming
				// still records the id in the file name (#327).
				if (parentSession) {
					const forkInfo = await resolveFork(parentSession, this.artifactsRoot);
					if (forkInfo) {
						branchCount = 1;
						forksResolved = 1;
						parentSessionId = forkInfo.parentSessionId;
					} else {
						parentSessionId = piSessionIdFromFileName(path.basename(parentSession));
					}
				}
				initialised = true;
			}

			let end = batch.start + batch.lines.length;
			if (batch.last && batch.lines[batch.lines.length - 1] === "") end -= 1;

			const messages: MessageInsert[] = [];
			for (let k = 0; k < batch.lines.length; k++) {
				const i = batch.start + k;
				const line = batch.lines[k]?.trim();
				if (!line) continue;
				// The session name sits in `session_info` records that can be anywhere in the file, after the resume point too.
				const inRange = i >= resumeLine;
				if (!inRange && !line.includes("session_info")) continue;
				const parsed = parseLine(line);
				if (parsed?.kind === "session-info" && parsed.name) name = parsed.name;
				if (!inRange || !parsed || parsed.kind === "session" || parsed.kind === "session-info") continue;

				const entry = parsed.entry;
				messages.push({
					id: entry.id,
					session_id: sessionId,
					source: disc.source,
					parent_id: entry.parentId,
					timestamp: entry.timestamp,
					role: entry.role,
					content_text: entry.text,
					content_thinking: entry.thinking,
					tool_calls: entry.tool_calls ? JSON.stringify(entry.tool_calls) : null,
					tool_results: entry.tool_results ? JSON.stringify(entry.tool_results) : null,
					usage: entry.usage ? JSON.stringify(entry.usage) : null,
					model: entry.model,
					cost_usd: entry.costUsd,
					provider_message_id: entry.providerMessageId,
					stop_reason: entry.stopReason,
					error_message: entry.errorMessage,
				});
			}

			const session: SessionInsert = {
				id: sessionId,
				file_path: disc.filePath,
				project: disc.project,
				source: disc.source,
				cwd,
				parent_session: parentSessionId,
				started_at: startedAt,
				last_line: end,
				last_modified: disc.mtime,
				analyzed_at: null,
				message_count: 0,
				branch_count: branchCount,
				name,
				tool_inventory: buildToolInventory(parsedHeader),
			};
			yield { session, messages, lastBatch: batch.last, processedCount: Math.max(end, resumeLine), processedTimestamp: disc.mtime, forksResolved: forksReported++ === 0 ? forksResolved : 0 };
		}
	}
}

/**
 * Serialize a session's active tool manifest into the persisted ToolInventory
 * JSON, or null when the session carried no manifest (UNKNOWN).
 *
 * Presence semantics are load-bearing (the data is not backfillable):
 *   - no `tools` key on the header  -> null (UNKNOWN; never treat as "no tools")
 *   - `tools: []`                  -> '{"tools":[]}' (captured AND empty)
 *   - `tools: [...]`               -> populated inventory with per-tool sizing
 */
export function buildToolInventory(header: import("../../../types.js").SessionHeader | null): string | null {
	if (!header || header.tools === undefined) return null;
	const inventory = {
		source: "pi-session-header",
		tools: header.tools.map((t) => ({ name: t.name, definitionChars: t.definitionChars ?? null })),
	};
	return JSON.stringify(inventory);
}

export default PiFileSource;
