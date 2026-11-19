/**
 * PiSubagentSource — discovers nested Pi subagent session files under
 * <sessionsDir>/<project>/<parent-dir>/[<short-id>/]<run-N>/session.jsonl
 * that the flat top-level scanner misses (#140).
 */
import { SyncFault } from "../../faults.js";
import { lineBatches } from "../../line-batches.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { collectBatches, type SessionSourceAdapter, type ParsedSession } from "../../adapter.js";
import type { DiscoveredSession } from "../../../types.js";
import type { SessionInsert, MessageInsert } from "../../../db/queries.js";
import { parseLine, extractSessionName } from "../../parser.js";
import { buildToolInventory, parentSessionFromRunPath } from "../pi/index.js";
import { walkSessionDir } from "../../scanner.js";
import { getSessionsDir } from "../../../config.js";

const RUN_DIR_RE = /^run-\d+$/;

export class PiSubagentSource implements SessionSourceAdapter {
	readonly source = "pi-subagent";
	/**
	 * Claim order, just before pi: both sources discover a child run's
	 * `session.jsonl`, and this one parses strictly more (it additionally recovers
	 * the parent session id), so it must claim those files first.
	 */
	readonly priority = 50;
	/** Opt-in: sync loads this source only when config `sources` names it. */
	readonly enabledByDefault = false;

	constructor(private sessionsDir: string = getSessionsDir()) {}

	async discover(): Promise<DiscoveredSession[]> {
		// The shared walker owns the traversal itself — directory error handling,
		// the depth bound (#157), project naming. This source only narrows what
		// counts as a session file: a `session.jsonl` sitting directly inside a
		// run-N directory, which the plain Pi source would claim differently.
		return walkSessionDir(this.sessionsDir, this.source, {
			matchFile: (fileName, parentDirName) => fileName === "session.jsonl" && RUN_DIR_RE.test(parentDirName),
			leafDirPattern: RUN_DIR_RE,
		});
	}

	async read(disc: DiscoveredSession, resumeLine: number): Promise<ParsedSession> {
		return collectBatches(this.readBatches(disc, resumeLine));
	}

	async *readBatches(disc: DiscoveredSession, resumeLine: number): AsyncGenerator<ParsedSession> {
		let sessionId = "";
		let cwd = "";
		let startedAt = "";
		let parsedHeader: import("../../../types.js").SessionHeader | null = null;
		let name: string | null = null;
		let initialised = false;
		// The session whose directory holds this run's tree, read from the path.
		const parentSession = parentSessionFromRunPath(disc.filePath);

		for await (const batch of lineBatches(disc.filePath)) {
			if (!initialised) {
				// The header is the file's first non-empty line, wherever it falls.
				const firstReal = batch.lines.findIndex((l) => l.trim() !== "");
				if (firstReal === -1) {
					if (batch.last) throw new SyncFault("no-session-header", `No session header: ${disc.filePath}`);
					continue;
				}
				const p = parseLine(batch.lines[firstReal]!);
				if (p && p.kind === "session") {
					parsedHeader = p.header;
					sessionId = p.header.id;
					cwd = p.header.cwd ?? "";
					startedAt = p.header.timestamp ?? "";
				}
				if (!sessionId) throw new SyncFault("no-session-header", `No session header: ${disc.filePath}`);
				initialised = true;
			}

			let end = batch.start + batch.lines.length;
			if (batch.last && batch.lines[batch.lines.length - 1] === "") end -= 1;

			const messages: MessageInsert[] = [];
			for (let k = 0; k < batch.lines.length; k++) {
				const i = batch.start + k;
				const line = batch.lines[k]?.trim();
				if (!line) continue;
				const inRange = i >= resumeLine;
				if (!inRange && !line.includes("session_info")) continue;
				const p = parseLine(line);
				if (p?.kind === "session-info" && p.name) name = p.name;
				if (!inRange || !p || p.kind === "session" || p.kind === "session-info") continue;
				const e = p.entry;
				messages.push({
					id: e.id,
					session_id: sessionId,
					source: disc.source,
					parent_id: e.parentId,
					timestamp: e.timestamp,
					role: e.role,
					content_text: e.text,
					content_thinking: e.thinking,
					tool_calls: e.tool_calls ? JSON.stringify(e.tool_calls) : null,
					tool_results: e.tool_results ? JSON.stringify(e.tool_results) : null,
					usage: e.usage ? JSON.stringify(e.usage) : null,
					model: e.model,
					cost_usd: e.costUsd,
					provider_message_id: e.providerMessageId,
					stop_reason: e.stopReason,
					error_message: e.errorMessage,
				});
			}
			const session: SessionInsert = {
				id: sessionId,
				file_path: disc.filePath,
				project: disc.project,
				source: disc.source,
				cwd,
				parent_session: parentSession,
				started_at: startedAt,
				last_line: end,
				last_modified: disc.mtime,
				analyzed_at: null,
				message_count: 0,
				branch_count: 0,
				name,
				tool_inventory: buildToolInventory(parsedHeader),
			};
			yield { session, messages, lastBatch: batch.last, processedCount: Math.max(end, resumeLine), processedTimestamp: disc.mtime, forksResolved: 0 };
		}
	}
}

export default PiSubagentSource;
