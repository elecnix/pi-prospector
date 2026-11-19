/**
 * ClaudeFileSource — discovers and parses Claude Code session JSONL files.
 *
 * Migrated from the inline syncClaudeSession() in src/sync/index.ts to a
 * SessionSourceAdapter behind the interface introduced in #138.
 */
import { LEADING_RECORDS, isRebuiltTranscript } from "../../rebuilt.js";
import { firstLines, lineBatches } from "../../line-batches.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { collectBatches, type SessionSourceAdapter, type ParsedSession } from "../../adapter.js";
import type { DiscoveredSession } from "../../../types.js";
import type { SessionInsert, MessageInsert } from "../../../db/queries.js";
import { normalizeClaudeToolName, parseClaudeRecord } from "../../parser.js";
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
		return collectBatches(this.readBatches(disc, resumeLine));
	}

	/**
	 * The file is streamed from its first line, and only the lines from `resumeLine` on
	 * are turned into rows. What the earlier lines still teach (which tool a result
	 * answers, the first timestamp and cwd, the last title) is carried as small state, so
	 * nothing grows with the file: the tool-name map is bounded and a batch is dropped
	 * once written.
	 */
	async *readBatches(disc: DiscoveredSession, resumeLine: number): AsyncGenerator<ParsedSession> {
		// Derive session ID from file name (UUID, or `agent-<id>` for a child agent)
		const sessionId = path.basename(disc.filePath, ".jsonl");

		// A child agent is attached to the session whose directory holds it. The
		// session itself is not: Claude Code records no parent for a top-level
		// session, and the enclosing directory of one is the project.
		const parentSession = CLAUDE_CHILD_AGENT_FILE_RE.test(path.basename(disc.filePath))
			? parentSessionFromPath(disc.filePath)
			: null;

		const rebuilt = await isRebuiltTranscript(disc.filePath, await firstLines(disc.filePath, LEADING_RECORDS));
		const sidecarEvent = await this.sidecarEvent(disc, sessionId);

		// Claude tool_result blocks carry only a tool_use_id; resolve the tool name from the
		// matching tool_use in an earlier assistant message (issue #30). The map covers every
		// line read, so a pair that straddles the cursor still resolves, and it keeps the most
		// recent entries only: a result answers a call made shortly before it.
		const toolNamesById = new BoundedMap<string, string>(MAX_TOOL_NAMES);
		let title: string | null = null;
		let startedAt: string | null = null;
		let metaCwd: string | null = null;
		let state = newExtrasState(new Set());

		for await (const batch of lineBatches(disc.filePath)) {
			// Lines that hold a record, by the shared cursor rule. A last line the host is still
			// writing has no final newline and does not parse yet: it waits for the next sync
			// instead of becoming an event.
			let end = batch.start + batch.lines.length;
			if (batch.last) {
				const tail = batch.lines[batch.lines.length - 1] ?? "";
				if (tail === "") end -= 1;
				else {
					try {
						JSON.parse(tail.trim());
					} catch {
						end -= 1;
					}
				}
			}

			const items: Array<{ line: number; raw: string; obj: unknown; parsed: ReturnType<typeof parseClaudeRecord> }> = [];
			const counts = newStickyCounts();
			const fresh: string[] = [];
			for (let k = 0; k < batch.lines.length; k++) {
				const i = batch.start + k;
				if (i >= end) break;
				const raw = batch.lines[k]?.trim();
				if (!raw) continue;
				const inRange = i >= resumeLine;
				if (!inRange && !raw.includes('"tool_use"') && !raw.includes('"ai-title"') && startedAt !== null && metaCwd !== null) continue;
				let obj: unknown;
				try {
					obj = JSON.parse(raw);
				} catch {
					obj = undefined;
				}
				const rec = obj !== null && typeof obj === "object" ? (obj as Record<string, unknown>) : null;
				if (rec) {
					const type = rec["type"];
					if (type === "ai-title" && rec["aiTitle"]) title = String(rec["aiTitle"]);
					if (type === "user" || type === "assistant") {
						if (!startedAt && rec["timestamp"]) startedAt = String(rec["timestamp"]);
						if (!metaCwd && typeof rec["cwd"] === "string" && rec["cwd"]) metaCwd = rec["cwd"];
					}
					if (type === "assistant") recordToolNames(rec, toolNamesById);
				}
				if (!inRange) continue;
				fresh.push(raw);
				const parsed = rec ? parseClaudeRecord(rec, toolNamesById) : null;
				items.push({ line: i, raw, obj, parsed });
				if (parsed?.kind === "message") {
					const o = obj as Record<string, unknown>;
					observeFields(counts, o["type"] === "assistant" ? "assistant" : "user", flatFields(o, parsed.entry.usage !== null));
				}
			}
			// Sticky fields are told apart per batch; the first record of a batch carries the key list.
			state = newExtrasState(stickyKeys(counts));

			const messages: MessageInsert[] = [];
			const extras: MessageExtrasInsert[] = [];
			const events: SessionEventInsert[] = [];
			for (const { line: i, raw, obj, parsed } of items) {
				if (!parsed || parsed.kind !== "message") {
					const ev = claudeEventOf(obj, raw);
					if (!STORED_EVENT_KINDS.includes(ev.kind)) continue;
					events.push({ session_id: sessionId, line: i, kind: ev.kind, ref: "", payload: JSON.stringify(ev.payload) });
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
			if (batch.last && sidecarEvent) events.push(sidecarEvent);

			const session: SessionInsert = {
				id: sessionId,
				file_path: disc.filePath,
				project: disc.project,
				source: disc.source,
				cwd: (metaCwd ?? disc.project) || "",
				parent_session: parentSession,
				started_at: startedAt ?? "",
				last_line: end,
				last_modified: disc.mtime,
				analyzed_at: null,
				message_count: 0,
				branch_count: 0,
				// Claude Code records no session name; its AI-generated title is the
				// nearest equivalent identity marker, when one was written.
				name: title,
				tool_inventory: null, // Claude transcripts carry no tool manifest; UNKNOWN.
			};
			yield {
				session,
				messages,
				// A backgrounded call's completion is a separate record, not a message: it carries no
				// turn and sits between two messages in the file. Each batch finds its own.
				backgroundTasks: extractBackgroundTasks(fresh, sessionId),
				extras,
				events,
				rebuilt,
				lastBatch: batch.last,
				processedCount: Math.max(end, resumeLine),
				processedTimestamp: disc.mtime,
				forksResolved: 0,
			};
		}
	}

	/** A child agent's meta file sits beside its transcript and is stored whole. */
	private async sidecarEvent(disc: DiscoveredSession, sessionId: string): Promise<SessionEventInsert | null> {
		const sidecar = sidecarPathFor(disc.filePath);
		if (!sidecar) return null;
		let text: string;
		try {
			text = await fs.readFile(sidecar, "utf-8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			return null;
		}
		let payload: unknown;
		try {
			const json: unknown = JSON.parse(text);
			payload = json !== null && typeof json === "object" && !Array.isArray(json) ? elideFields(json as Record<string, unknown>) : { value: json };
		} catch {
			payload = { text: elide(text) };
		}
		const rel = path.relative(this.claudeSessionsDir, sidecar);
		return { session_id: sessionId, line: -1, kind: "sidecar", ref: rel.startsWith("..") ? path.basename(sidecar) : rel.split(path.sep).join("/"), payload: JSON.stringify(payload) };
	}
}

/** How many tool-use ids the name map keeps. */
const MAX_TOOL_NAMES = 100_000;

/** A map that drops its oldest entry past `max`, so it cannot grow with the file. */
class BoundedMap<K, V> extends Map<K, V> {
	constructor(private readonly max: number) {
		super();
	}
	override set(key: K, value: V): this {
		super.set(key, value);
		if (this.size > this.max) this.delete(this.keys().next().value as K);
		return this;
	}
}

function recordToolNames(rec: Record<string, unknown>, map: Map<string, string>): void {
	const content = (rec["message"] as Record<string, unknown> | undefined)?.["content"];
	if (!Array.isArray(content)) return;
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const p = part as Record<string, unknown>;
		if (p["type"] === "tool_use" && typeof p["id"] === "string" && p["id"]) map.set(p["id"], normalizeClaudeToolName(String(p["name"] ?? "")));
	}
}

export default ClaudeFileSource;
