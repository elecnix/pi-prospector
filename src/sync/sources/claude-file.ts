/**
 * ClaudeFileSource — discovers and parses Claude Code session JSONL files.
 *
 * Migrated from the inline syncClaudeSession() in src/sync/index.ts to a
 * SessionSourceAdapter behind the interface introduced in #138.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SessionSourceAdapter, ParsedSession } from "../adapter.js";
import type { DiscoveredSession } from "../../types.js";
import type { SessionInsert, MessageInsert } from "../../db/queries.js";
import { parseLine, parseClaudeSessionMeta, buildClaudeToolNameMap } from "../parser.js";
import { walkSessionDir } from "../scanner.js";

export class ClaudeFileSource implements SessionSourceAdapter {
	readonly source = "claude";

	constructor(private claudeSessionsDir: string) {}

	async discover(): Promise<DiscoveredSession[]> {
		return walkSessionDir(this.claudeSessionsDir, "claude");
	}

	async read(disc: DiscoveredSession, resumeLine: number): Promise<ParsedSession> {
		const content = await fs.readFile(disc.filePath, "utf-8");
		const lines = content.split("\n");

		// Derive session ID from file name (UUID)
		const sessionId = path.basename(disc.filePath, ".jsonl");

		const meta = parseClaudeSessionMeta(lines);
		const startedAt = meta?.timestamp ?? null;
		const cwd = (meta?.cwd ?? disc.project) || "";

		// Claude tool_result blocks carry only a tool_use_id; resolve the tool
		// name from the matching tool_use in the preceding assistant message
		// (issue #30). Built from ALL lines (not just the resume point) so a
		// tool_use/tool_result pair that straddles the cursor still resolves on
		// an incremental sync.
		const toolNamesById = buildClaudeToolNameMap(lines);

		const session: SessionInsert = {
			id: sessionId,
			file_path: disc.filePath,
			project: disc.project,
			source: disc.source,
			cwd,
			parent_session: null,
			started_at: startedAt ?? "",
			last_line: resumeLine,
			last_modified: disc.mtime,
			analyzed_at: null,
			message_count: 0,
			branch_count: 0,
			// Claude Code records no session name; its AI-generated title is the
			// nearest equivalent identity marker, when one was written.
			name: meta?.title ?? null,
			tool_inventory: null, // Claude transcripts carry no tool manifest; UNKNOWN.
		};

		const messages: MessageInsert[] = [];
		for (let i = resumeLine; i < lines.length; i++) {
			const line = lines[i]?.trim();
			if (!line) continue;

			const parsed = parseLine(line, "claude", toolNamesById);
			if (!parsed || parsed.kind !== "message") continue;

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
			forksResolved: 0,
		};
	}
}
