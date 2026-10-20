/**
 * CodexFileSource — discovers and parses Codex rollout files.
 *
 * Codex writes one JSONL file per session under
 * `~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<uuid>.jsonl`. Unlike Pi
 * and Claude Code, Codex does not group its sessions by project: the tree is
 * organised by date, and the project a session belongs to is recorded in the
 * session's own `cwd`.
 *
 * Discovery claims the files Codex names and nothing else. The same tree holds
 * `history.jsonl` and other files that belong to other parts of Codex, and a
 * file no source names is never read.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SessionSourceAdapter, ParsedSession } from "../adapter.js";
import type { DiscoveredSession } from "../../types.js";
import type { SessionInsert, MessageInsert } from "../../db/queries.js";
import {
  parseCodexLine,
  codexToolName,
  codexFormatOf,
  type CodexFormat,
  type CodexLine,
} from "../codex-parser.js";
import { classifyToolError } from "../tool-errors.js";

/**
 * The name Codex gives a rollout file: `rollout-<timestamp>-<uuid>.jsonl`.
 *
 * The shape is the claim. A file in the same tree that is not named this way
 * belongs to another part of Codex and is never read.
 */
const CODEX_ROLLOUT_FILE_RE = /^rollout-.+\.jsonl$/;

/**
 * The session id a rollout file's name carries, or null when the name is not
 * one Codex gives its rollout files.
 *
 * The name is the id: Codex names a rollout file after the session it holds,
 * with the timestamp and the session's own uuid. So the id is recoverable from
 * the path even when the file's own `session_meta` is unreadable.
 */
export function codexSessionIdFromFileName(fileName: string): string | null {
  const match =
    /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
      fileName,
    );
  return match?.[1] ?? null;
}

/**
 * The id a rollout file's session is stored under.
 *
 * The host's own id is not enough: a session that was resumed is written to a
 * *second* file under the same id — measured on the live corpus, one session
 * spans two files — and the index keys a session row by its id. Two files
 * sharing an id would share one row, so the second would overwrite the first's
 * file path and cursor, and the first would be re-read on every sync.
 *
 * So the id is the host's id plus the file's own stamp, which is unique per
 * file. The host's id stays in the row, so the two files of one session remain
 * recognisable as the same session.
 */
export function codexSessionRowId(hostId: string, filePath: string): string {
  const name = filePath.split("/").pop() ?? filePath;
  return `${hostId}#${name}`;
}

/**
 * The project a Codex session belongs to, from the working directory it ran in.
 *
 * Codex's own tree carries no project name, so the directory is the only
 * record of where the session happened. The last path segment is the project
 * for a plain directory; a path under a `Source`-style checkout keeps the
 * repository and the worktree, the same shape the token report derives.
 */
export function codexProjectFromCwd(cwd: string): string {
  const parts = cwd.split("/").filter(Boolean);
  if (parts.length === 0) return "workspace";
  const srcIdx = parts.lastIndexOf("Source");
  if (srcIdx >= 0 && parts.length > srcIdx + 1) {
    const repo = parts[srcIdx + 1]!;
    const worktree = parts[srcIdx + 2];
    return worktree && worktree !== "main" ? `${repo}/${worktree}` : repo;
  }
  return parts[parts.length - 1]!;
}

/**
 * The state a parse carries from one line to the next.
 *
 * A Codex rollout is read as a sequence of **generations**: the model's one
 * response, which the host closes with a `token_usage_record`. A generation is
 * therefore assembled across several lines, and the state has to survive
 * between them — including across a sync's resume point, which is why the
 * state is an explicit object rather than locals.
 */
interface CodexState {
  /** How many generations have been closed so far. */
  generation: number;
  /** The id of the assistant row the generation in flight will be written as. */
  assistantRowId: string | null;
  /** The timestamp of that row's first item. */
  assistantTimestamp: string | null;
  /** The tool calls the generation in flight asked for. */
  toolCalls: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  /** What the model said in the generation in flight. */
  assistantText: string | null;
  /** What the model thought in the generation in flight. */
  assistantThinking: string | null;
  /** The model serving the generation in flight. */
  assistantModel: string | null;
  /** The turn the generation in flight belongs to. */
  assistantTurn: string | null;
  /** The calls made so far whose name a later result can be matched to. */
  pendingCalls: Map<string, string>;
  /**
   * The results the host has recorded, keyed by the call they answer.
   *
   * A result and the command that produced it carry the same id, so the two
   * are joined by it — the same way Claude Code's `tool_use_id` joins a
   * `tool_use` to its `tool_result`.
   */
  pendingResults: Map<string, { text: string; timestamp: string | null; ordinal: number }>;
  /**
   * The commands the host has recorded, keyed by the command's id.
   *
   * The command carries the exit code; the result carries the text. A
   * failure is read from whichever of the two records it.
   */
  pendingCommands: Map<
    string,
    {
      command: string;
      exitCode: number | null;
      output: string;
      timestamp: string | null;
    }
  >;
  /** The model serving each turn, from that turn's `turn_context`. */
  modelByTurn: Map<string, string>;
  /** The model of the turn currently open. */
  currentModel: string | null;
  /**
   * How many results have been seen.
   *
   * A call id is not unique inside one file: measured on the live corpus, 21
   * results share an id with another result in the same file. The counter is
   * what keeps their rows apart.
   */
  resultOrdinal: number;
}

/** A fresh parse state. */
function newState(): CodexState {
  return {
    generation: 0,
    assistantRowId: null,
    assistantTimestamp: null,
    toolCalls: [],
    assistantText: null,
    assistantThinking: null,
    assistantModel: null,
    assistantTurn: null,
    pendingCalls: new Map(),
    pendingResults: new Map(),
    resultOrdinal: 0,
    pendingCommands: new Map(),
    modelByTurn: new Map(),
    currentModel: null,
  };
}

export class CodexFileSource implements SessionSourceAdapter {
  readonly source = "codex";

  constructor(private codexSessionsDir: string) {}

  async discover(): Promise<DiscoveredSession[]> {
    const results: DiscoveredSession[] = [];

    // The tree is `YYYY/MM/DD/rollout-*.jsonl`: three levels of date
    // directories, then the file. Walked directly rather than through the
    // shared project-directory walker, because Codex has no project
    // directories — the project comes from each session's own cwd.
    await this.walk(this.codexSessionsDir, 0, results);
    return results;
  }

  /** Recurse into the date tree, collecting the files Codex names. */
  private async walk(
    dir: string,
    depth: number,
    results: DiscoveredSession[],
  ): Promise<void> {
    if (depth > 4) return;
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        await this.walk(full, depth + 1, results);
        continue;
      }
      if (!CODEX_ROLLOUT_FILE_RE.test(entry)) continue;
      results.push({
        filePath: full,
        project: "",
        mtime: stat.mtimeMs,
        size: stat.size,
        source: this.source,
      });
    }
  }

  async read(
    disc: DiscoveredSession,
    resumeLine: number,
  ): Promise<ParsedSession> {
    const content = await fs.readFile(disc.filePath, "utf-8");
    const lines = content.split("\n");

    // The session's own header: the first line of a rollout file is always
    // the `session_meta` record.
    let meta: Record<string, unknown> | null = null;
    let metaTimestamp: string | null = null;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        break;
      }
      if (obj["type"] !== "session_meta") break;
      meta = (obj["payload"] ?? {}) as Record<string, unknown>;
      metaTimestamp =
        typeof obj["timestamp"] === "string"
          ? (obj["timestamp"] as string)
          : null;
      break;
    }

    const hostId =
      metaSessionId(meta) ??
      codexSessionIdFromFileName(path.basename(disc.filePath));
    if (!hostId) {
      throw new Error(`No session id: ${disc.filePath}`);
    }
    // The row's id is the host's id plus the file's own stamp, so a session
    // that spans two files keeps one row per file.
    const sessionId = codexSessionRowId(hostId, disc.filePath);
    const cwd = metaString(meta, "cwd") ?? "";
    const startedAt = metaString(meta, "timestamp") ?? metaTimestamp ?? "";

    const session: SessionInsert = {
      id: sessionId,
      file_path: disc.filePath,
      project: codexProjectFromCwd(cwd),
      source: disc.source,
      cwd,
      // A delegated agent's session names the session it was spawned from.
      parent_session: metaString(meta, "parent_thread_id"),
      started_at: startedAt,
      last_line: resumeLine,
      last_modified: disc.mtime,
      analyzed_at: null,
      message_count: 0,
      branch_count: 0,
      // Codex records no human-readable session name.
      name: null,
      // Codex records no tool manifest, so the inventory stays UNKNOWN.
      tool_inventory: null,
    };

    const messages = this.parseMessages(
      lines,
      resumeLine,
      sessionId,
      disc.source,
    );
    return {
      session,
      messages,
      processedCount: codexProcessedCount(content, lines.length),
      processedTimestamp: disc.mtime,
      forksResolved: 0,
    };
  }

  /**
   * Parse the rollout's items into message rows.
   *
   * A generation is assembled across several lines, and the line that closes
   * it — its `token_usage_record` — often comes after the cursor of an
   * incremental sync. So the lines before the resume point are read first, to
   * reconstruct the generation in flight; without that, the generation's
   * usage would be billed to nothing and its text would be lost.
   *
   * The rows themselves are written only for the lines at or after the resume
   * point, so a re-sync inserts what is new and nothing else.
   */
  private parseMessages(
    lines: string[],
    resumeLine: number,
    sessionId: string,
    source: string,
  ): MessageInsert[] {
    const messages: MessageInsert[] = [];
    // The turn each assistant row belongs to, so an aborted turn can be
    // marked on the rows it produced.
    const turnByRow = new Map<number, string | null>();
    // The turns the host abandoned.
    const abortedTurns = new Set<string>();

    const state = newState();
    // Which stream the conversation is read from. The whole file is read to
    // decide: the older format's first records are the same ones the current
    // format writes, so the answer is not knowable from the first lines.
    const format = codexFormatOf(lines);

    // The lines before the cursor: read for their effect on the state, not
    // for the rows they produce.
    for (let i = 0; i < resumeLine && i < lines.length; i++) {
      const parsed = this.parseLine(lines[i] ?? "", format, sessionId);
      if (!parsed) continue;
      this.apply(
        parsed,
        state,
        null,
        sessionId,
        source,
        turnByRow,
        abortedTurns,
        i,
      );
    }

    // The lines from the cursor on: these produce the rows.
    for (let i = resumeLine; i < lines.length; i++) {
      const parsed = this.parseLine(lines[i] ?? "", format, sessionId);
      if (!parsed) continue;
      this.apply(
        parsed,
        state,
        messages,
        sessionId,
        source,
        turnByRow,
        abortedTurns,
        i,
      );
    }

    // The generation in flight at the end of the file: the host never
    // closed it, so it is written with whatever it holds. Its usage, if the
    // host records one later, is not recoverable — the row already exists
    // and the store never rewrites a row. The text is worth more than the
    // usage, and the loss is one generation per session.
    this.flush(state, messages, sessionId, source, turnByRow);
    this.emitResults(state, messages, sessionId, source);

    // An abandoned turn is the host's own verdict on the generations it
    // produced, kept verbatim: classifying it is an analyzer's job.
    for (const [rowIndex, turn] of turnByRow) {
      if (turn && abortedTurns.has(turn)) {
        const row = messages[rowIndex];
        if (row) row.stop_reason = "aborted";
      }
    }

    return messages;
  }

  /** Parse one line, with its own timestamp. */
  private parseLine(line: string, format: CodexFormat, sessionId: string): CodexLine | null {
    const trimmed = line?.trim();
    if (!trimmed) return null;
    let lineTimestamp: string | null = null;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      lineTimestamp =
        typeof obj["timestamp"] === "string"
          ? (obj["timestamp"] as string)
          : null;
    } catch {
      return null;
    }
    return parseCodexLine(trimmed, lineTimestamp, format, sessionId);
  }

  /**
   * Apply one parsed line to the state, writing its rows when the pass is
   * the one that emits.
   *
   * `messages` is null for the pre-pass, which reads the lines before the
   * cursor for their effect on the state alone.
   */
  private apply(
    parsed: CodexLine,
    state: CodexState,
    messages: MessageInsert[] | null,
    sessionId: string,
    source: string,
    turnByRow: Map<number, string | null>,
    abortedTurns: Set<string>,
    lineIndex: number,
  ): void {
    switch (parsed.kind) {
      case "model": {
        state.currentModel = parsed.entry.model;
        if (parsed.entry.turnId)
          state.modelByTurn.set(parsed.entry.turnId, parsed.entry.model);
        break;
      }
      case "message": {
        const entry = parsed.entry;
        if (entry.role === "user") {
          // A human turn closes the generation in flight: the model
          // answered the previous one.
          this.flush(state, messages, sessionId, source, turnByRow);
          this.emitResults(state, messages, sessionId, source);
          if (messages) {
            messages.push({
              id: entry.id ?? `${sessionId}-user-${lineIndex}`,
              session_id: sessionId,
              source,
              parent_id: null,
              timestamp: entry.timestamp,
              role: "user",
              content_text: entry.text,
              content_thinking: null,
              tool_calls: null,
              tool_results: null,
              usage: null,
              model: null,
              cost_usd: null,
              provider_message_id: null,
              stop_reason: null,
              error_message: null,
            });
          }
          break;
        }
        // An assistant message. Reasoning is the model's private
        // thinking and belongs on the same row as what it said.
        if (entry.thinking !== null) {
          state.assistantThinking =
            state.assistantThinking === null
              ? entry.thinking
              : `${state.assistantThinking}\n${entry.thinking}`;
        } else {
          state.assistantText =
            state.assistantText === null
              ? entry.text
              : `${state.assistantText}\n${entry.text ?? ""}`;
        }
        if (state.assistantRowId === null) {
          state.assistantRowId =
            entry.id ?? `${sessionId}-assistant-${lineIndex}`;
          // The host's own id is not unique: measured on the live corpus, one
          // reasoning id names two different items in the same file. A row id
          // that repeats would drop the second one, so the generation's
          // ordinal is what keeps them apart.
          state.assistantRowId = `${state.assistantRowId}-${state.generation}`;
          state.assistantTimestamp = entry.timestamp;
          state.assistantModel = entry.turnId
            ? (state.modelByTurn.get(entry.turnId) ?? null)
            : state.currentModel;
          state.assistantTurn = entry.turnId;
        }
        break;
      }
      case "tool-call": {
        const entry = parsed.entry;
        const name = codexToolName(entry.name);
        state.toolCalls.push({
          id: entry.callId,
          name,
          arguments: entry.arguments,
        });
        state.pendingCalls.set(entry.callId, name);
        if (state.assistantRowId === null) {
          state.assistantRowId = `${sessionId}-gen-${state.generation}`;
          state.assistantTimestamp = entry.timestamp;
          state.assistantModel = entry.turnId
            ? (state.modelByTurn.get(entry.turnId) ?? null)
            : state.currentModel;
          state.assistantTurn = entry.turnId;
        }
        break;
      }
      case "command": {
        // The host's record of a command it ran. In the current format
        // the result arrives as a separate item that carries the same
        // id, so the exit code is held until that item is read; in the
        // older format there is no result item at all, and the command
        // is the whole record.
        const entry = parsed.entry;
        state.pendingCommands.set(entry.callId, {
          command: entry.command,
          exitCode: entry.exitCode,
          output: entry.output,
          timestamp: entry.timestamp,
        });
        // A command whose result the host never recorded is still a
        // thing the tool did.
        if (!state.pendingResults.has(entry.callId)) {
          state.pendingResults.set(entry.callId, {
            text: "",
            timestamp: entry.timestamp,
            ordinal: state.resultOrdinal++,
          });
        }
        break;
      }
      case "tool-result": {
        const entry = parsed.entry;
        state.pendingResults.set(entry.callId, {
          text: entry.text,
          timestamp: entry.timestamp,
          ordinal: state.resultOrdinal++,
        });
        break;
      }
      case "compaction": {
        const entry = parsed.entry;
        this.flush(state, messages, sessionId, source, turnByRow);
        this.emitResults(state, messages, sessionId, source);
        if (messages) {
          messages.push({
            id: `${sessionId}-compaction-${lineIndex}`,
            session_id: sessionId,
            source,
            parent_id: null,
            timestamp: entry.timestamp,
            role: "compactionSummary",
            content_text: entry.text,
            content_thinking: null,
            tool_calls: null,
            tool_results: null,
            usage: null,
            model: null,
            cost_usd: null,
            provider_message_id: null,
            stop_reason: null,
            error_message: null,
          });
        }
        break;
      }
      case "aborted": {
        // The host's own record that a turn was abandoned. Kept
        // verbatim: classifying an abort as the operator's doing
        // rather than a defect is an analyzer's job.
        const turnId = parsed.entry.turnId;
        if (turnId) abortedTurns.add(turnId);
        break;
      }
      case "usage": {
        const entry = parsed.entry;
        const row = this.flush(state, messages, sessionId, source, turnByRow);
        this.emitResults(state, messages, sessionId, source);
        // The usage belongs to the generation that just closed, so it
        // is written onto that row.
        if (row) {
          row.usage = JSON.stringify(entry.usage);
          row.provider_message_id = entry.responseId;
          const model = entry.turnId
            ? state.modelByTurn.get(entry.turnId)
            : undefined;
          if (model) row.model = model;
        }
        break;
      }
    }
  }

  /**
   * Write the tool results the host has recorded, joined to the calls they
   * answer.
   *
   * A result is written once both of its halves are known: the call, which
   * names the tool, and the result or the command, which says what happened.
   * The command's exit code is the failure marker when the result's own text
   * does not carry one — the two agree on every one of the 1 321 results the
   * live corpus records both for.
   *
   * A result is written *after* the assistant row that asked for it: the
   * result answers a call, so it belongs to the turn the call was made in,
   * and a reader that walks the rows in order must meet the call first.
   */
  private emitResults(
    state: CodexState,
    messages: MessageInsert[] | null,
    sessionId: string,
    source: string,
  ): void {
    for (const [callId, result] of [...state.pendingResults]) {
      const call = state.pendingCalls.get(callId);
      const command = state.pendingCommands.get(callId);
      // A result with neither a call nor a command is not a result yet:
      // the host has written one half of it.
      if (!call && !command) continue;
      state.pendingResults.delete(callId);

      const toolName = call ?? "bash";
      const text = result.text || command?.output || "";
      // Codex does not say whether a result failed. A shell result
      // carries its exit code in the text, and the host's own command
      // event carries it separately, so the failure is read from
      // whichever records it.
      const isError = codexResultFailed(text, command?.exitCode ?? null);
      const errorClass = classifyToolError(isError, text);
      const entry: Record<string, unknown> = {
        toolCallId: callId,
        toolName,
        isError,
        textLength: text.length,
      };
      if (errorClass) entry["errorClass"] = errorClass;
      if (!messages) continue;
      messages.push({
        id: `${sessionId}-result-${callId}-${result.ordinal}`,
        session_id: sessionId,
        source,
        parent_id: null,
        timestamp: result.timestamp ?? command?.timestamp ?? null,
        role: "toolResult",
        // The result's text is kept so a failure's cause can be read
        // out of it; the tool stream reads the error head from here.
        content_text: text,
        content_thinking: null,
        tool_calls: null,
        tool_results: JSON.stringify([entry]),
        usage: null,
        model: null,
        cost_usd: null,
        provider_message_id: null,
        stop_reason: null,
        error_message: null,
      });
    }
  }

  /**
   * Close the generation in flight and write it as an assistant row.
   *
   * Returns the row, so the caller that closes the generation can attach the
   * generation's usage to it. A generation that carried nothing — neither
   * words nor tool calls — produces no row, and its usage is lost with it.
   */
  private flush(
    state: CodexState,
    messages: MessageInsert[] | null,
    sessionId: string,
    source: string,
    turnByRow: Map<number, string | null>,
  ): MessageInsert | null {
    const hasContent =
      state.assistantText !== null || state.assistantThinking !== null;
    if (
      state.assistantRowId === null &&
      state.toolCalls.length === 0 &&
      !hasContent
    ) {
      state.generation++;
      return null;
    }
    const row: MessageInsert = {
      id: state.assistantRowId ?? `${sessionId}-gen-${state.generation}`,
      session_id: sessionId,
      source,
      parent_id: null,
      timestamp: state.assistantTimestamp,
      role: "assistant",
      content_text: state.assistantText,
      content_thinking: state.assistantThinking,
      tool_calls:
        state.toolCalls.length > 0 ? JSON.stringify(state.toolCalls) : null,
      tool_results: null,
      usage: null,
      model: state.assistantModel,
      cost_usd: null,
      provider_message_id: null,
      stop_reason: null,
      error_message: null,
    };
    if (messages) {
      turnByRow.set(messages.length, state.assistantTurn);
      messages.push(row);
    }
    state.generation++;
    state.assistantRowId = null;
    state.assistantTimestamp = null;
    state.toolCalls = [];
    state.assistantText = null;
    state.assistantThinking = null;
    state.assistantModel = null;
    state.assistantTurn = null;
    return row;
  }
}

/**
 * How many lines of a rollout file the cursor should advance past.
 *
 * The cursor is the index of the first line not yet processed, and a rollout
 * file always ends with a newline — so `content.split("\n")` leaves a trailing
 * empty element that holds no record. Counting it would put the cursor one
 * past the file's last record, and the next record the host appends would land
 * exactly on that index and be skipped.
 *
 * The count is therefore the number of lines that hold a record: the split
 * length, less the trailing empty element when the file ends with a newline.
 */
export function codexProcessedCount(
  content: string,
  splitLength: number,
): number {
  return content.endsWith("\n") ? Math.max(0, splitLength - 1) : splitLength;
}

/**
 * Whether a Codex tool result records a failure.
 *
 * Codex does not say so in the record. A shell result carries its exit code in
 * the text, and the two rollout formats word it differently: the current
 * format writes `Process exited with code 1`, the older one `Command exited
 * with code 1`. Measured on the live corpus, the exit code in the text and the
 * one in the host's own `CommandExecution` event agree on every one of the
 * 1 321 results that carry both.
 *
 * A result with no exit code in its text succeeded: nothing in the corpus
 * suggests otherwise, and calling every result a failure would report the whole
 * corpus as broken.
 */
export function codexResultFailed(
  text: string,
  exitCode: number | null = null,
): boolean {
  if (exitCode !== null) return exitCode !== 0;
  const match = /(?:process|command) exited with code (\d+)/i.exec(text);
  if (match) return Number(match[1]) !== 0;
  const exit = /^Exit code: (\d+)/m.exec(text);
  if (exit) return Number(exit[1]) !== 0;
  return false;
}

/** The session id a `session_meta` payload carries. */
function metaSessionId(meta: Record<string, unknown> | null): string | null {
  if (!meta) return null;
  for (const key of ["id", "session_id"]) {
    const value = meta[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

/** A string field of the `session_meta` payload, or null. */
function metaString(
  meta: Record<string, unknown> | null,
  key: string,
): string | null {
  if (!meta) return null;
  const value = meta[key];
  return typeof value === "string" && value ? value : null;
}
