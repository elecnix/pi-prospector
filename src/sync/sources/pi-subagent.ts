/**
 * PiSubagentSource — discovers nested Pi subagent session files under
 * <sessionsDir>/<project>/<parent-dir>/[<short-id>/]<run-N>/session.jsonl
 * that the flat top-level scanner misses (#140).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SessionSourceAdapter, ParsedSession } from "../adapter.js";
import type { DiscoveredSession } from "../../types.js";
import type { SessionInsert, MessageInsert } from "../../db/queries.js";
import { parseLine, extractSessionName } from "../parser.js";
import { buildToolInventory } from "./pi-file.js";
import { walkSessionDir } from "../scanner.js";

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN_DIR_RE = /^run-\d+$/;

export class PiSubagentSource implements SessionSourceAdapter {
	readonly source = "pi-subagent";

	constructor(private sessionsDir: string) {}

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
		const content = await fs.readFile(disc.filePath, "utf-8");
		const lines = content.split("\n");

		let sessionId = "";
		let cwd = "";
		let startedAt = "";
		let parsedHeader: import("../../types.js").SessionHeader | null = null;
		for (const line of lines) {
			if (!line.trim()) continue;
			const p = parseLine(line);
			if (p && p.kind === "session") {
				parsedHeader = p.header;
				sessionId = p.header.id;
				cwd = p.header.cwd ?? "";
				startedAt = p.header.timestamp ?? "";
				break;
			}
			break;
		}
		if (!sessionId) throw new Error(`No session header: ${disc.filePath}`);

		const parentSession = extractParent(disc.filePath, this.sessionsDir);
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
			branch_count: 0,
			name: extractSessionName(lines),
			tool_inventory: buildToolInventory(parsedHeader),
		};

		const messages: MessageInsert[] = [];
		for (let i = resumeLine; i < lines.length; i++) {
			const line = lines[i]?.trim();
			if (!line) continue;
			const p = parseLine(line);
			if (!p || p.kind === "session" || p.kind === "session-info") continue;
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
		return {
			session,
			messages,
			processedCount: lines.length,
			processedTimestamp: disc.mtime,
			forksResolved: 0,
		};
	}
}

/** The nearest enclosing session-directory UUID above the run dir is the parent. */
function extractParent(fp: string, root: string): string | null {
	let cur = path.dirname(path.dirname(fp));
	while (cur.length > root.length && cur !== path.dirname(cur)) {
		const m = path.basename(cur).match(UUID_RE);
		if (m?.[0]) return m[0];
		cur = path.dirname(cur);
	}
	return null;
}
