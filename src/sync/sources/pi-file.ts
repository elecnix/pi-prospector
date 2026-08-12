/**
 * PiFileSource — discovers and parses Pi agent session JSONL files.
 *
 * Migrated from the inline syncPiSession() in src/sync/index.ts to a
 * SessionSourceAdapter behind the interface introduced in #138.
 */
import * as fs from "node:fs/promises";
import type { SessionSourceAdapter, ParsedSession } from "../adapter.js";
import type { DiscoveredSession } from "../../types.js";
import type { SessionInsert, MessageInsert } from "../../db/queries.js";
import { parseLine, extractSessionName } from "../parser.js";
import { resolveFork } from "../forks.js";
import { walkSessionDir } from "../scanner.js";

export class PiFileSource implements SessionSourceAdapter {
	readonly source = "pi";
	/** Child-run artifacts live under the same root as the sessions themselves. */
	readonly artifactsRoot: string;

	constructor(sessionsDir: string) {
		this.artifactsRoot = sessionsDir;
	}

	async discover(): Promise<DiscoveredSession[]> {
		return walkSessionDir(this.artifactsRoot, "pi");
	}

	async read(disc: DiscoveredSession, resumeLine: number): Promise<ParsedSession> {
		const content = await fs.readFile(disc.filePath, "utf-8");
		const lines = content.split("\n");

		// Parse session header (must be first non-empty line)
		let sessionId = "";
		let parentSession: string | null = null;
		let cwd = "";
		let startedAt = "";
		let parsedHeader: import("../../types.js").SessionHeader | null = null;

		for (const line of lines) {
			if (!line.trim()) continue;
			const parsed = parseLine(line);
			if (parsed && parsed.kind === "session") {
				parsedHeader = parsed.header;
				sessionId = parsed.header.id;
				parentSession = parsed.header.parentSession ?? null;
				cwd = parsed.header.cwd ?? "";
				startedAt = parsed.header.timestamp ?? "";
				break;
			}
			break; // First non-empty line wasn't a header — malformed
		}

		if (!sessionId) {
			throw new Error(`No session header: ${disc.filePath}`);
		}

		// Resolve fork
		let branchCount = 0;
		let forksResolved = 0;
		if (parentSession) {
			const forkInfo = await resolveFork(parentSession, this.artifactsRoot);
			if (forkInfo) {
				branchCount = 1;
				forksResolved = 1;
			}
		}

		// The human-readable session name, written in `session_info` records that can
		// sit anywhere in the file (and after the resume point), so scan everything.
		const name = extractSessionName(lines);

		const session: SessionInsert = {
			id: sessionId,
			file_path: disc.filePath,
			project: disc.project,
			source: disc.source,
			cwd,
			parent_session: parentSession,
			started_at: startedAt,
			last_line: resumeLine,
			last_modified: disc.mtime,
			analyzed_at: null,
			message_count: 0,
			branch_count: branchCount,
			name,
			tool_inventory: buildToolInventory(parsedHeader),
		};

		const messages: MessageInsert[] = [];
		for (let i = resumeLine; i < lines.length; i++) {
			const line = lines[i]?.trim();
			if (!line) continue;

			const parsed = parseLine(line);
			if (!parsed || parsed.kind === "session" || parsed.kind === "session-info") continue;

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

		return {
			session,
			messages,
			processedCount: lines.length,
			processedTimestamp: disc.mtime,
			forksResolved,
		};
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
export function buildToolInventory(header: import("../../types.js").SessionHeader | null): string | null {
	if (!header || header.tools === undefined) return null;
	const inventory = {
		source: "pi-session-header",
		tools: header.tools.map((t) => ({ name: t.name, definitionChars: t.definitionChars ?? null })),
	};
	return JSON.stringify(inventory);
}
