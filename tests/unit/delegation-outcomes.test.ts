/**
 * Unit tests for delegation-outcomes detection. Pure functions, no database, no
 * mocks: hand-written synthetic rows only.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scanDelegations } from "../../src/analyze/analyzers/delegation-outcomes/detect.js";
import type { BackgroundTaskRow, MessageRow } from "../../src/analyze/types.js";
import { makeMessageRow as row } from "./helpers.js";

interface Opts {
	isError?: boolean;
	subagent?: { status: string; excerpt: string };
	answered?: boolean;
	args?: Record<string, unknown>;
}

function delegate(id: string, name: string, opts: Opts = {}): MessageRow[] {
	const call = row({
		id: `call-${id}`,
		role: "assistant",
		tool_calls: JSON.stringify([{ id, name, arguments: opts.args ?? { description: "x" } }]),
	});
	if (opts.answered === false) return [call];
	return [
		call,
		row({
			id: `result-${id}`,
			role: "toolResult",
			content_text: "done",
			tool_results: JSON.stringify([
				{ toolCallId: id, toolName: name, isError: opts.isError ?? false, textLength: 4, ...(opts.subagent ? { subagent: opts.subagent } : {}) },
			]),
		}),
	];
}

const task = (id: string, status: string): BackgroundTaskRow => ({
	session_id: "s1",
	tool_use_id: id,
	task_id: null,
	completed_at: "2026-10-01T10:00:00.000Z",
	status,
	summary: null,
});

describe("scanDelegations", () => {
	it("reads an unanswered call, an error, and a plain success", () => {
		const scan = scanDelegations(
			[...delegate("a", "Task", { answered: false }), ...delegate("b", "Task", { isError: true }), ...delegate("c", "Agent")],
			[],
		);
		assert.deepEqual(scan.events.map((e) => e.outcome), ["unanswered", "failed", "completed"]);
		assert.equal(scan.call_count, 3);
		assert.equal(scan.counts.failed, 1);
	});

	it("lets a background completion decide before the error flag", () => {
		const scan = scanDelegations(
			[...delegate("a", "Task"), ...delegate("b", "Task"), ...delegate("c", "Task", { isError: true })],
			[task("a", "failed"), task("b", "killed"), task("c", "completed")],
		);
		assert.deepEqual(scan.events.map((e) => e.outcome), ["failed", "killed", "completed"]);
		assert.ok(scan.events.every((e) => e.background));
	});

	it("records an unknown background status as other", () => {
		assert.equal(scanDelegations(delegate("a", "Task"), [task("a", "weird")]).events[0]?.outcome, "other");
	});

	it("reads Pi's orchestration classification", () => {
		const scan = scanDelegations(
			[
				...delegate("a", "subagent", { subagent: { status: "child_failed", excerpt: "" } }),
				...delegate("b", "subagent", { subagent: { status: "revived", excerpt: "" } }),
				...delegate("c", "subagent", { subagent: { status: "completed", excerpt: "" } }),
			],
			[],
		);
		assert.deepEqual(scan.events.map((e) => e.outcome), ["failed", "revived", "completed"]);
	});

	it("names the child agent type and flags a background run", () => {
		const [event] = scanDelegations(delegate("a", "Task", { args: { subagent_type: "reviewer", run_in_background: true } }), []).events;
		assert.equal(event?.agent, "reviewer");
		assert.equal(event?.background, true);
	});

	it("counts every call past the event cap and ignores other tools", () => {
		const messages = [...delegate("a", "Task"), ...delegate("b", "Task"), ...delegate("c", "bash")];
		const scan = scanDelegations(messages, [], { delegationToolNames: ["Task"], failedBackgroundStatuses: [], killedBackgroundStatuses: [], maxEvents: 1 });
		assert.equal(scan.call_count, 2);
		assert.equal(scan.events.length, 1);
		assert.equal(scan.tool_call_count, 3);
	});

	it("returns zero counts for a session that delegated nothing", () => {
		const scan = scanDelegations(delegate("a", "bash"), []);
		assert.equal(scan.call_count, 0);
		assert.deepEqual(scan.events, []);
	});
});
