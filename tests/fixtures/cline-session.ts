/**
 * Synthetic Cline session directories.
 *
 * Cline 4.x (the SDK runtime) keeps each session in a directory of its own
 * under its sessions root (`~/.cline/data/sessions/` by default):
 *
 *   <root>/<sessionId>/<sessionId>.json           the manifest
 *   <root>/<sessionId>/<sessionId>.messages.json  the conversation
 *   <root>/<sessionId>/<agentId>.messages.json    a child agent's conversation
 *
 * The messages file is one JSON document, rewritten whole after every agent
 * iteration: `{ version: 1, updated_at, agent, sessionId, origin, messages }`.
 * The shapes follow Cline v4.1.25 (sdk/packages/core/src/services/session-data.ts
 * and sdk/packages/shared/src/llms/messages.ts at that tag). Every id, path,
 * model name and prompt here is invented. Nothing is copied from a real session.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Type, type Static } from "typebox";

/** The working directory every fixture session ran in unless a test names another. */
export const CLINE_FIXTURE_CWD = "/home/tester/workspace/notes-app";

const JsonObject = Type.Record(Type.String(), Type.Unknown());

export const ClineSessionFixture = Type.Object({
	sessionId: Type.String(),
	messages: Type.Array(JsonObject),
	/** Absent for a child agent, whose manifest is its root session's. */
	manifest: Type.Optional(JsonObject),
	/** The root session a child agent belongs to; its file sits in that directory. */
	rootSessionId: Type.Optional(Type.String()),
	/** The child agent's id, which names its messages file. */
	agentId: Type.Optional(Type.String()),
});
export type ClineSessionFixture = Static<typeof ClineSessionFixture>;

/** The manifest Cline writes beside a root session's messages. */
export function clineManifest(sessionId: string, options: { title?: string; cwd?: string; startedAt?: string } = {}): Record<string, unknown> {
	return {
		version: 1,
		session_id: sessionId,
		source: "vscode",
		pid: 4242,
		started_at: options.startedAt ?? "2026-03-04T09:15:00.000Z",
		status: "completed",
		interactive: true,
		provider: "fixture-provider",
		model: "fixture-model-1",
		cwd: options.cwd ?? CLINE_FIXTURE_CWD,
		workspace_root: options.cwd ?? CLINE_FIXTURE_CWD,
		enable_tools: true,
		enable_spawn: true,
		enable_teams: false,
		prompt: "add a note titled groceries",
		metadata: options.title === undefined ? {} : { title: options.title },
	};
}

/** The path of a fixture's messages file, as Cline names it. */
export function clineMessagesPath(root: string, fixture: ClineSessionFixture): string {
	const dir = path.join(root, fixture.rootSessionId ?? fixture.sessionId);
	const stem = fixture.agentId ?? fixture.sessionId;
	return path.join(dir, `${stem}.messages.json`);
}

/** Write one session's files, as Cline's session store does. */
export function writeClineSession(root: string, fixture: ClineSessionFixture): string {
	const file = clineMessagesPath(root, fixture);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const child = fixture.rootSessionId !== undefined;
	const payload = {
		version: 1,
		updated_at: "2026-03-04T09:20:00.000Z",
		agent: child ? "subagent" : "lead",
		sessionId: fixture.sessionId,
		...(child ? { taskType: "subagent_task" } : {}),
		origin: {
			source: "vscode",
			mode: "user",
			sessionId: fixture.sessionId,
			...(child ? { parentThreadId: fixture.rootSessionId, subagent: fixture.agentId } : {}),
		},
		messages: fixture.messages,
	};
	fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
	if (fixture.manifest) {
		fs.writeFileSync(path.join(path.dirname(file), `${fixture.sessionId}.json`), `${JSON.stringify(fixture.manifest, null, 2)}\n`);
	}
	return file;
}

export function clineUser(id: string, text: string, ts: number, metadata?: Record<string, unknown>): Record<string, unknown> {
	return { id, role: "user", content: [{ type: "text", text }], ts, ...(metadata ? { metadata } : {}) };
}

export function clineAssistant(
	id: string,
	content: Array<Record<string, unknown>>,
	ts: number,
	options: { metrics?: Record<string, number>; metadata?: Record<string, unknown> } = {},
): Record<string, unknown> {
	return {
		id,
		role: "assistant",
		content,
		ts,
		modelInfo: { id: "fixture-model-1", provider: "fixture-provider" },
		...(options.metrics ? { metrics: options.metrics } : {}),
		...(options.metadata ? { metadata: options.metadata } : {}),
	};
}

export function clineToolUse(id: string, name: string, input: Record<string, unknown>): Record<string, unknown> {
	return { type: "tool_use", id, name, input };
}

/** A tool's result, which Cline files as a `user` message. */
export function clineToolResults(
	id: string,
	results: Array<{ callId: string; name: string; text: string; isError?: boolean }>,
	ts: number,
): Record<string, unknown> {
	return {
		id,
		role: "user",
		content: results.map((r) => ({
			type: "tool_result",
			tool_use_id: r.callId,
			name: r.name,
			content: [{ type: "text", text: r.text }],
			...(r.isError ? { is_error: true } : {}),
		})),
		ts,
	};
}
