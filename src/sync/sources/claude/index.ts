/**
 * ClaudeFileSource — discovers and parses Claude Code session JSONL files.
 *
 * Migrated from the inline syncClaudeSession() in src/sync/index.ts to a
 * SessionSourceAdapter behind the interface introduced in #138.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SessionSourceAdapter, ParsedSession } from "../../adapter.js";
import type { DiscoveredSession } from "../../../types.js";
import type { SessionInsert, MessageInsert } from "../../../db/queries.js";
import { parseClaudeRecord, parseClaudeSessionMeta, buildClaudeToolNameMap } from "../../parser.js";
import { STORED_EVENT_KINDS, claudeEventOf, claudeMessageExtras, elide, elideFields, flatFields, newExtrasState, newStickyCounts, observeFields, stickyKeys } from "../../claude-extras.js";
import type { MessageExtrasInsert, SessionEventInsert } from "../../../db/extras-queries.js";
import { extractBackgroundTasks } from "../../background-tasks.js";
import { walkSessionDir } from "../../scanner.js";
import { getClaudeSessionsDir } from "../../../config.js";

/**
 * Claude Code's session-file naming: `<session-uuid>.jsonl`, directly under a
 * project directory.
 */
const CLAUDE_SESSION_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

/**
 * Claude Code's child-agent transcripts: `agent-<id>.jsonl`, written under the
 * spawning session's `subagents/` directory, and one level deeper again under
 * `subagents/workflows/wf-<id>/` when the child belongs to a workflow.
 *
 * This harness records its own child agents, so they are part of this source
 * rather than an extension's data: the same host writes them, in the same format,
 * with the child's turns in full. On the pi side the equivalent records come from
 * an extension and are claimed by that extension's source instead.
 *
 * The name alone is not the whole shape, because Claude names the id part freely
 * (`agent-a60f1e9e536d5a637.jsonl`, and `agent-ahttpsgithubcom…-<id>.jsonl` for
 * some earlier runs), so a name test would also claim a file called
 * `agent-anything.jsonl` that no child run ever wrote. The shape is the name plus
 * the directory: every one of the 4262 child transcripts on a live machine sits
 * under a `subagents` directory, and `journal.jsonl`, which sits there too,
 * records lifecycle events (`{"type":"launched"}`) rather than turns, so the name
 * test excludes it.
 */
const CLAUDE_CHILD_AGENT_FILE_RE = /^agent-.+\.jsonl$/i;

/** True when `filePath` sits under a directory named `subagents`. */
function underSubagentsDir(filePath: string): boolean {
	return path.dirname(filePath).split(path.sep).includes("subagents");
}

/**
 * The session id of the session that spawned a child agent, taken from the
 * directory the child's transcript sits in: `<parent-uuid>/subagents/...`, with
 * `subagents`, `workflows` and `wf-<id>` between the file and its parent. Called
 * only for files named `agent-…`, so the nearest enclosing directory named like a
 * session is an ancestor session and never the file's own id.
 */
function parentSessionFromPath(filePath: string): string | null {
	let dir = path.dirname(filePath);
	while (dir !== path.dirname(dir)) {
		const name = path.basename(dir);
		if (CLAUDE_SESSION_FILE_RE.test(`${name}.jsonl`)) return name;
		dir = path.dirname(dir);
	}
	return null;
}

/** The sidecar a child agent's transcript has beside it: `agent-<id>.jsonl` → `agent-<id>.meta.json`. */
function sidecarPathFor(filePath: string): string | null {
	const name = path.basename(filePath);
	if (!CLAUDE_CHILD_AGENT_FILE_RE.test(name)) return null;
	return path.join(path.dirname(filePath), name.replace(/\.jsonl$/i, ".meta.json"));
}

export class ClaudeFileSource implements SessionSourceAdapter {
	readonly source = "claude";
	/** Claim order: the built-ins' fixed file shapes are disjoint, so the numbers only pin sync's long-standing claiming order. */
	readonly priority = 10;

	constructor(private claudeSessionsDir: string = getClaudeSessionsDir()) {}

	async discover(): Promise<DiscoveredSession[]> {
		return walkSessionDir(this.claudeSessionsDir, "claude", {
			matchFile: (fileName, _parentDirName, filePath) =>
				CLAUDE_SESSION_FILE_RE.test(fileName) ||
				(CLAUDE_CHILD_AGENT_FILE_RE.test(fileName) && underSubagentsDir(filePath)),
		});
	}

	async read(disc: DiscoveredSession, resumeLine: number): Promise<ParsedSession> {
		const content = await fs.readFile(disc.filePath, "utf-8");
		const lines = content.split("\n");

		// Derive session ID from file name (UUID, or `agent-<id>` for a child agent)
		const sessionId = path.basename(disc.filePath, ".jsonl");

		const meta = parseClaudeSessionMeta(lines);
		const startedAt = meta?.timestamp ?? null;
		const cwd = (meta?.cwd ?? disc.project) || "";

		// A child agent is attached to the session whose directory holds it. The
		// session itself is not: Claude Code records no parent for a top-level
		// session, and the enclosing directory of one is the project.
		const parentSession = CLAUDE_CHILD_AGENT_FILE_RE.test(path.basename(disc.filePath))
			? parentSessionFromPath(disc.filePath)
			: null;

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
			parent_session: parentSession,
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

		// The last element of the split is "" after a final newline, or a line the host is
		// still writing. Counting it as read made the next sync resume one line late and
		// skip the first line appended since. A last line that parses is complete.
		const last = lines[lines.length - 1]?.trim() ?? "";
		let lastIsComplete = false;
		if (last) {
			try {
				JSON.parse(last);
				lastIsComplete = true;
			} catch {
				lastIsComplete = false;
			}
		}
		const complete = Math.max(0, lines.length - 1 + (lastIsComplete ? 1 : 0));

		// First pass: decode each line, so the fields that repeat from record to record
		// can be told from the ones that do not before any extras are written.
		const items: Array<{ line: number; raw: string; obj: unknown; parsed: ReturnType<typeof parseClaudeRecord> }> = [];
		const counts = newStickyCounts();
		for (let i = resumeLine; i < complete; i++) {
			const raw = lines[i]?.trim();
			if (!raw) continue;
			let obj: unknown;
			try {
				obj = JSON.parse(raw);
			} catch {
				obj = undefined;
			}
			const parsed = obj !== null && typeof obj === "object" ? parseClaudeRecord(obj as Record<string, unknown>, toolNamesById) : null;
			items.push({ line: i, raw, obj, parsed });
			if (parsed?.kind === "message") {
				const o = obj as Record<string, unknown>;
				observeFields(counts, o["type"] === "assistant" ? "assistant" : "user", flatFields(o, parsed.entry.usage !== null));
			}
		}
		const state = newExtrasState(stickyKeys(counts));

		const messages: MessageInsert[] = [];
		const extras: MessageExtrasInsert[] = [];
		const events: SessionEventInsert[] = [];
		for (const { line: i, raw, obj, parsed } of items) {
			if (!parsed || parsed.kind !== "message") {
				const ev = claudeEventOf(obj, raw);
				if (!STORED_EVENT_KINDS.includes(ev.kind)) continue;
				events.push({ session_id: sessionId, line: i, kind: ev.kind, ref: null, payload: JSON.stringify(ev.payload) });
				continue;
			}

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
			const x = claudeMessageExtras(obj as Record<string, unknown>, state, entry.usage !== null);
			extras.push({ message_id: entry.id, line: i, extras: JSON.stringify(x) });
		}

		// A child agent's meta file sits beside its transcript and is stored whole.
		const sidecar = sidecarPathFor(disc.filePath);
		if (sidecar) {
			let text: string | null = null;
			try {
				text = await fs.readFile(sidecar, "utf-8");
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			}
			if (text !== null) {
				let payload: unknown;
				try {
					const json: unknown = JSON.parse(text);
					payload = json !== null && typeof json === "object" && !Array.isArray(json) ? elideFields(json as Record<string, unknown>) : { value: json };
				} catch {
					payload = { text: elide(text) };
				}
				const rel = path.relative(this.claudeSessionsDir, sidecar);
				events.push({ session_id: sessionId, line: -1, kind: "sidecar", ref: rel.startsWith("..") ? path.basename(sidecar) : rel.split(path.sep).join("/"), payload: JSON.stringify(payload) });
			}
		}

		return {
			session,
			messages,
			// A backgrounded call's completion is a separate record, not a message:
			// it carries no turn and sits between two messages in the file. Read
			// from ALL lines (not just the resume point) so a completion that
			// straddles the cursor is still found on an incremental sync.
			backgroundTasks: extractBackgroundTasks(lines, sessionId),
			extras,
			events,
			processedCount: complete,
			processedTimestamp: disc.mtime,
			forksResolved: 0,
		};
	}
}

export default ClaudeFileSource;
