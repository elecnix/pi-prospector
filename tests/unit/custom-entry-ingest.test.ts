/**
 * Role-agnostic ingestion of custom-typed session entries (issue #272).
 *
 * Pi session files carry `type:"custom"` entries (a harness event, a plugin
 * note, or a human annotation; the ingester must not enumerate roles) and
 * `type:"custom_message"` notifications. Both should reach `content_text` so
 * they are indexed in `messages_fts` and visible to the analyzers; today they
 * are stored as message rows with every content field empty.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseLine } from "../../src/sync/parser.js";

describe("custom entry ingestion (issue #272)", () => {
	it("extracts data.text from a custom entry as its dominant text field", () => {
		const line = JSON.stringify({
			type: "custom",
			customType: "private-note",
			data: { text: "the spawn call should have returned an error", createdAt: 1768812345000 },
			id: "c1",
			parentId: "m9",
			timestamp: "2026-01-20T09:05:00.000Z",
		});
		const result = parseLine(line);
		assert.ok(result && result.kind === "message");
		if (result.kind !== "message") return;
		assert.equal(result.entry.text, "the spawn call should have returned an error");
		assert.equal(result.entry.role, "custom/private-note");
		assert.equal(result.entry.id, "c1");
		assert.equal(result.entry.tool_calls, null);
	});

	it("extracts a data object's content field when text is absent", () => {
		const line = JSON.stringify({
			type: "custom",
			customType: "harness-event",
			data: { content: "the daemon restarted the fleet", level: "warn" },
			id: "c2",
			timestamp: "2026-01-20T09:06:00.000Z",
		});
		const result = parseLine(line);
		assert.ok(result && result.kind === "message");
		if (result.kind !== "message") return;
		assert.equal(result.entry.text, "the daemon restarted the fleet");
		assert.equal(result.entry.role, "custom/harness-event");
	});

	it("extracts a raw string data payload", () => {
		const line = JSON.stringify({
			type: "custom",
			customType: "sticky-note",
			data: "plain string annotation",
			id: "c3",
			timestamp: "2026-01-20T09:06:30.000Z",
		});
		const result = parseLine(line);
		assert.ok(result && result.kind === "message");
		if (result.kind !== "message") return;
		assert.equal(result.entry.text, "plain string annotation");
		assert.equal(result.entry.role, "custom/sticky-note");
	});

	it("keeps the raw type as role when no customType discriminator exists", () => {
		const line = JSON.stringify({ type: "custom", id: "c4", timestamp: "2026-01-20T09:07:00.000Z", data: { text: "untyped note" } });
		const result = parseLine(line);
		assert.ok(result && result.kind === "message");
		if (result.kind !== "message") return;
		assert.equal(result.entry.role, "custom");
		assert.equal(result.entry.text, "untyped note");
	});

	it("ingests a custom_message body from top-level content", () => {
		const line = JSON.stringify({
			type: "custom_message",
			customType: "subagent-notify",
			content: "Background task completed: workflow run-ab12",
			display: false,
			id: "cm1",
			timestamp: "2026-01-20T09:08:00.000Z",
		});
		const result = parseLine(line);
		assert.ok(result && result.kind === "message");
		if (result.kind !== "message") return;
		assert.equal(result.entry.role, "custom_message");
		assert.equal(result.entry.text, "Background task completed: workflow run-ab12");
	});

	it("joins content-array text parts of a custom_message", () => {
		const line = JSON.stringify({
			type: "custom_message",
			content: [
				{ type: "text", text: "first part" },
				{ type: "text", text: "second part" },
			],
			id: "cm2",
			timestamp: "2026-01-20T09:08:30.000Z",
		});
		const result = parseLine(line);
		assert.ok(result && result.kind === "message");
		if (result.kind !== "message") return;
		assert.equal(result.entry.text, "first part\nsecond part");
	});

	it("leaves text null when an entry carries no text-shaped field", () => {
		const line = JSON.stringify({
			type: "custom",
			customType: "opaque-event",
			data: { level: "info", code: "E-42" },
			id: "c5",
			timestamp: "2026-01-20T09:09:00.000Z",
		});
		const result = parseLine(line);
		assert.ok(result && result.kind === "message");
		if (result.kind !== "message") return;
		assert.equal(result.entry.text, null);
		assert.equal(result.entry.role, "custom/opaque-event");
	});

	it("preserves existing non-custom fallback behavior", () => {
		const compaction = parseLine(JSON.stringify({ type: "compaction", id: "k1", summary: "context was compacted here", timestamp: "2026-01-20T09:10:00.000Z" }));
		assert.ok(compaction && compaction.kind === "message");
		if (compaction.kind !== "message") return;
		assert.equal(compaction.entry.role, "compactionSummary");
		assert.equal(compaction.entry.text, "context was compacted here");

		const modelChange = parseLine(JSON.stringify({ type: "model_change", id: "k2", modelId: "model-x", timestamp: "2026-01-20T09:10:30.000Z" }));
		assert.ok(modelChange && modelChange.kind === "message");
		if (modelChange.kind !== "message") return;
		assert.equal(modelChange.entry.text, null);
	});
});