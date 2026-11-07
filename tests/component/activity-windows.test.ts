/**
 * Component tests for the activity-windows analyzer and its concurrency output,
 * exercised end-to-end through the real AnalyzerFramework. Hand-written
 * synthetic rows, no network.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	tempDb,
	insertSession,
	insertMessages,
	mockFramework,
	readAnalyzerNodes,
	runAnalyzerOverSession,
	expectPlainRerunIsNoOpFill,
	expectConfigChangeRevises,
	type TestMessage,
} from "./helpers.js";
import { activityWindowsAnalyzer, type ActivityWindowsProperties } from "../../src/analyze/analyzers/activity-windows/index.js";
import { renderOutputs, resolveOutputs } from "../../src/analyze/outputs.js";

const T = (s: string) => `2026-10-01T${s}.000Z`;

function session(from: string, to: string): TestMessage[] {
	return [
		{ role: "user", text: "Go.", timestamp: T(from) },
		{ role: "assistant", text: "Done.", timestamp: T(to) },
	];
}

describe("activity-windows component test", () => {
	it("records the windows of a session on a metric node anchored to it", async () => {
		const { db, close } = await tempDb();
		try {
			const nodes = await runAnalyzerOverSession(db, activityWindowsAnalyzer, "aw-1", session("10:00:00", "10:01:00"));
			assert.equal(nodes.length, 1);
			assert.equal(nodes[0]!.node_kind, "metric");
			const content = JSON.parse(nodes[0]!.content_json) as ActivityWindowsProperties;
			assert.deepEqual(content.windows, [{ start: T("10:00:00"), end: T("10:01:00") }]);
			assert.equal(content.active_seconds, 60);
		} finally {
			await close();
		}
	});

	it("plans nothing for an empty transcript", async () => {
		const { db, close } = await tempDb();
		try {
			assert.equal((await runAnalyzerOverSession(db, activityWindowsAnalyzer, "aw-empty", [])).length, 0);
		} finally {
			await close();
		}
	});

	it("a plain re-run is a no-op fill", async () => {
		const { db, close } = await tempDb();
		try {
			await expectPlainRerunIsNoOpFill(db, activityWindowsAnalyzer, "aw-rerun", session("10:00:00", "10:01:00"));
		} finally {
			await close();
		}
	});

	it("a config change revises beside the old node", async () => {
		const { db, close } = await tempDb();
		try {
			const { before, after } = await expectConfigChangeRevises(db, activityWindowsAnalyzer, "aw-cfg", session("10:00:00", "10:20:00"), {
				idleCapSeconds: 1200,
			});
			assert.equal(before.length, 1);
			assert.ok(after.length >= 2);
		} finally {
			await close();
		}
	});

	it("the concurrency output folds two overlapping sessions into one row", async () => {
		const { db, close } = await tempDb();
		try {
			const fw = mockFramework(db);
			await fw.register(activityWindowsAnalyzer);
			for (const [id, from, to] of [["aw-x", "10:00:00", "10:04:00"], ["aw-y", "10:02:00", "10:06:00"]] as const) {
				await insertSession(db, id);
				await insertMessages(db, id, session(from, to));
				await fw.run(id, {});
			}
			const resolved = resolveOutputs([activityWindowsAnalyzer], "activity-windows:concurrency");
			const [result] = await renderOutputs(resolved, { db, options: {} });
			const artifact = result!.artifacts[0]!;
			assert.equal(artifact.mediaType, "text/csv");
			assert.equal(artifact.content, `bucket_start,sessions,peak_concurrent,active_minutes\n${T("10:00:00")},2,2,8\n`);
			assert.equal((await readAnalyzerNodes(db, "activity-windows")).length, 2);
		} finally {
			await close();
		}
	});

	it("the concurrency output rejects a bad bucket", async () => {
		const { db, close } = await tempDb();
		try {
			const resolved = resolveOutputs([activityWindowsAnalyzer], "activity-windows:concurrency");
			await assert.rejects(renderOutputs(resolved, { db, options: { bucket: "week" } }), /bucket must be/);
		} finally {
			await close();
		}
	});
});
