import type { SessionFacts } from "../../db/fingerprint-queries.js";
import type { FingerprintContributor } from "../contributor.js";
import { SOURCE_GROUPS } from "../schema.js";

/**
 * The contributors that read the session index itself rather than an analyzer's
 * nodes: which harnesses, how long and how often, and what a session looks like.
 * Every figure is counted or timed from the transcript, so all are objective.
 */

const DURATION_EDGES_MINUTES = [0, 5, 15, 30, 60, 120, 240];
const PROMPT_EDGES = [0, 2, 4, 8, 16, 32];
const TOOL_CALL_EDGES = [0, 1, 10, 25, 50, 100, 250];

function minutesBetween(first: string | null, last: string | null): number | null {
	if (first === null || last === null) return null;
	const ms = Date.parse(last) - Date.parse(first);
	return Number.isNaN(ms) || ms < 0 ? null : Math.round((ms / 60_000) * 100) / 100;
}

const ids = (sessions: readonly SessionFacts[]) => sessions.map((s) => s.id);

/** Sessions per harness. A session whose source is none of the known ones is `unknown`. */
export const sourcesContributor: FingerprintContributor = {
	def: {
		id: "sources",
		label: "Sources",
		description: "How many sessions each coding harness produced.",
		kind: "objective",
		measures: [{ kind: "groups", id: "bySource", dimensions: { source: [...SOURCE_GROUPS] } }],
	},
	async read({ sessions }) {
		return { measured: ids(sessions), rows: sessions.map((s) => ({ session: s.id, source: s.source })) };
	},
};

/** How often and how long: the days sessions started on, and wall-clock duration. */
export const usageContributor: FingerprintContributor = {
	def: {
		id: "usage",
		label: "Usage",
		description: "Distinct days a session started on, and the distribution of session duration (first message to last).",
		kind: "objective",
		measures: [
			{ kind: "distinct", id: "activeDays", field: "startDay" },
			{ kind: "distribution", id: "duration", field: "durationMinutes", unit: "minutes", edges: DURATION_EDGES_MINUTES },
		],
	},
	async read({ sessions }) {
		return {
			measured: ids(sessions),
			rows: sessions.map((s) => ({
				session: s.id,
				startDay: s.startedAt === null ? null : s.startedAt.slice(0, 10),
				durationMinutes: minutesBetween(s.firstTimestamp, s.lastTimestamp),
			})),
		};
	},
};

/** What a session looks like: prompts, tool calls, and sub-agents. */
export const shapeContributor: FingerprintContributor = {
	def: {
		id: "shape",
		label: "Session shape",
		description: "Prompts and tool calls per session, and the sub-agent sessions a session started.",
		kind: "objective",
		measures: [
			{ kind: "distribution", id: "promptsPerSession", field: "prompts", unit: "prompts", edges: PROMPT_EDGES },
			{ kind: "distribution", id: "toolCallsPerSession", field: "toolCalls", unit: "tool-calls", edges: TOOL_CALL_EDGES },
			{ kind: "sessions", id: "sessionsWithSubAgents", field: "subAgentSessions" },
			{ kind: "total", id: "subAgentSessions", field: "subAgentSessions" },
		],
	},
	async read({ sessions }) {
		return {
			measured: ids(sessions),
			rows: sessions.map((s) => ({ session: s.id, prompts: s.prompts, toolCalls: s.toolCalls, subAgentSessions: s.subAgentSessions })),
		};
	},
};
