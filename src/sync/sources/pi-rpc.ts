/**
 * PiRpcSource — ingests pi-rpc RPC event-stream transcripts (#263).
 *
 * Headless Pi agents driven over the RPC protocol write one directory per
 * agent under `<sessionsDir>/pi-rpc/<name>/`, whose `out.jsonl` is the
 * session's RPC/UI event stream — not a session log. It opens with an
 * `extension_ui_request` frame instead of a `{"type":"session"}` header, so
 * the file-based Pi source rejects every one of them with "No session header"
 * and the whole sub-agent fleet was invisible to the corpus.
 *
 * Identity: the directory name is the durable key the operator (and every
 * cursor row) already uses, so the session id is `pi-rpc/<name>` — stable
 * across re-syncs, and namespaced so it cannot collide with the UUID ids the
 * file-based sources record. The transcript itself records no session UUID,
 * no cwd, and no tool manifest: those stay empty/null (UNKNOWN), never guessed.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SessionSourceAdapter, ParsedSession } from "../adapter.js";
import type { DiscoveredSession } from "../../types.js";
import type { SessionInsert, MessageInsert } from "../../db/queries.js";
import { parseRpcFrame } from "./pi-rpc-parser.js";

/** The transcript file name inside each pi-rpc agent directory. */
const TRANSCRIPT_NAME = "out.jsonl";

export class PiRpcSource implements SessionSourceAdapter {
	readonly source = "pi-rpc";

	constructor(private sessionsDir: string) {}

	async discover(): Promise<DiscoveredSession[]> {
		const results: DiscoveredSession[] = [];
		const root = path.join(this.sessionsDir, "pi-rpc");
		let entries: string[];
		try {
			entries = await fs.readdir(root);
		} catch {
			return results;
		}
		for (const entry of entries) {
			if (entry.startsWith(".")) continue;
			const dirPath = path.join(root, entry);
			let stat: Awaited<ReturnType<typeof fs.stat>>;
			try {
				stat = await fs.stat(dirPath);
			} catch {
				continue;
			}
			if (!stat.isDirectory()) continue;
			const filePath = path.join(dirPath, TRANSCRIPT_NAME);
			let fileStat: Awaited<ReturnType<typeof fs.stat>>;
			try {
				fileStat = await fs.stat(filePath);
			} catch {
				continue;
			}
			results.push({
				filePath,
				// One fleet-wide namespace: pi-rpc directory names are free-form agent
				// names, not project-path encodings like the session-directory trees.
				project: "pi-rpc",
				mtime: fileStat.mtimeMs,
				size: fileStat.size,
				source: this.source,
			});
		}
		return results;
	}

	async read(disc: DiscoveredSession, resumeLine: number): Promise<ParsedSession> {
		const dirName = path.basename(path.dirname(disc.filePath));
		const content = await fs.readFile(disc.filePath, "utf-8");
		const lines = content.split("\n");

		// The human-readable session name, as recorded by the agent itself in
		// `session_info_changed` frames. The directory name is the fallback
		// (and the usual value — most agents never rename).
		let name: string | null = null;
		let startedAt: string | null = null;

		const messages: MessageInsert[] = [];
		for (let i = resumeLine; i < lines.length; i++) {
			const line = lines[i]?.trim();
			if (!line) continue;
			// Name and start-of-session can sit after a resume point, so they are
			// extracted during the same cheap scan that maps frames.
			if (name === null && line.startsWith('{"type":"session_info_changed"')) {
				try {
					const obj = JSON.parse(line) as { name?: unknown };
					if (typeof obj.name === "string" && obj.name.trim().length > 0) name = obj.name.trim();
				} catch {
					// a malformed metadata frame is transport noise; the fallback name stands
				}
			}
			if (startedAt === null && line.startsWith('{"type":"agent_start"')) {
				try {
					const obj = JSON.parse(line) as { timestamp?: unknown };
					if (typeof obj.timestamp === "number" && Number.isFinite(obj.timestamp) && obj.timestamp > 0) {
						startedAt = new Date(obj.timestamp).toISOString();
					}
				} catch {
					// a malformed lifecycle frame carries no start time; leave unknown
				}
			}
			const m = parseRpcFrame(line, { dirName, lineNo: i + 1 });
			if (m) messages.push(m);
		}

		if (messages.length === 0) {
			// An empty or transport-only stream records no conversation. Surfacing
			// it as an error keeps the sync report honest about what was skipped
			// and why, instead of writing a session row with no messages.
			throw new Error(`no message frames: ${disc.filePath}`);
		}

		const session: SessionInsert = {
			id: `pi-rpc/${dirName}`,
			file_path: disc.filePath,
			project: disc.project,
			source: disc.source,
			// The RPC stream records no working directory. An empty cwd is the
			// recorded absence, not a guess; the underlying session file the RPC
			// agent also writes could resolve it later, which is out of scope here.
			cwd: "",
			parent_session: null,
			started_at: startedAt ?? "",
			last_line: resumeLine,
			last_modified: disc.mtime,
			analyzed_at: null,
			message_count: 0,
			branch_count: 0,
			name: name ?? dirName,
			// No tool manifest exists anywhere in the RPC stream: UNKNOWN, and it
			// is never backfilled (the inventory's presence semantics are
			// load-bearing — see DESIGN.md).
			tool_inventory: null,
		};

		return {
			session,
			messages,
			processedCount: lines.length,
			processedTimestamp: disc.mtime,
			forksResolved: 0,
		};
	}
}
