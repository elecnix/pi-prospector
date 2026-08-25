/**
 * Unit tests for the uncompleted-leads extractor and completion matcher.
 *
 * Pure functions over hand-written synthetic message rows — no database, no
 * LLM, no real session content.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	extractCommands,
	extractLeads,
	extractPaths,
	extractUrls,
} from "../../src/analyze/analyzers/uncompleted-leads/extract.js";
import { scanSessionLeads } from "../../src/analyze/analyzers/uncompleted-leads/detect.js";
import { DEFAULT_UNCOMPLETED_LEADS_CONFIG, type UncompletedLeadsConfig } from "../../src/analyze/analyzers/uncompleted-leads/config.js";
import type { MessageRow } from "../../src/analyze/types.js";

const CONFIG: UncompletedLeadsConfig = { ...DEFAULT_UNCOMPLETED_LEADS_CONFIG };

// ──────────────────── message-row helpers ────────────────────

let seq = 0;

function assistantWithCalls(calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>): MessageRow {
	seq += 1;
	return bareRow(`a${seq}`, "assistant", null).withToolCalls(calls);
}

function toolResultRow(results: Array<{ toolCallId: string; isError?: boolean; textLength?: number }>, text: string | null): MessageRow {
	seq += 1;
	return bareRow(`t${seq}`, "toolResult", text).withToolResults(
		results.map((r) => ({ toolCallId: r.toolCallId, toolName: "bash", isError: r.isError ?? false, textLength: r.textLength ?? text?.length ?? 0 })),
	);
}

interface RowSpec {
	id: string;
	role: string;
	text: string | null;
}

function bareRow(id: string, role: string, text: string | null) {
	const row: MessageRow = {
		id,
		session_id: "s",
		parent_id: null,
		timestamp: new Date(1_700_000_000_000 + seq).toISOString(),
		role,
		content_text: text,
		content_thinking: null,
		tool_calls: null,
		tool_results: null,
		model: null,
		cost_usd: null,
		stop_reason: null,
		error_message: null,
	};
	return {
		...row,
		withToolCalls(calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>): MessageRow {
			return { ...this, tool_calls: JSON.stringify(calls) };
		},
		withToolResults(results: Array<{ toolCallId: string; toolName: string; isError: boolean; textLength: number }>): MessageRow {
			return { ...this, tool_results: JSON.stringify(results) };
		},
	} satisfies RowSpec & { withToolCalls(...args: never[]): unknown; withToolResults(...args: never[]): unknown };
}

/** A one-call exchange: bash call + single-result toolResult carrying `text`. */
function exchange(callId: string, command: string, resultText: string, isError = false): MessageRow[] {
	return [
		assistantWithCalls([{ id: callId, name: "bash", arguments: { command } }]),
		toolResultRow([{ toolCallId: callId, isError }], resultText),
	];
}

function laterCall(name: string, args: Record<string, unknown>): MessageRow {
	return assistantWithCalls([{ id: `c-later-${seq + 1}`, name, arguments: args }]);
}

// ──────────────────── extraction ────────────────────

describe("extractPaths", () => {
	it("extracts an absolute path from an error payload", () => {
		const leads = extractPaths("Error: ENOENT: no such file or directory, open '/src/auth/login.ts'");
		assert.deepEqual(leads.map((l) => l.value), ["/src/auth/login.ts"]);
	});

	it("extracts a relative path from a grep hit without the line-number tail", () => {
		const leads = extractPaths("src/db/queries.ts:42: export function loadSessions() {");
		assert.deepEqual(leads.map((l) => l.value), ["src/db/queries.ts"]);
	});

	it("extracts ./-prefixed paths", () => {
		const leads = extractPaths("Cannot resolve module ./config/settings.json");
		assert.ok(leads.some((l) => l.value === "./config/settings.json"), JSON.stringify(leads));
	});

	it("does not extract prose word/slash/word shapes like 'and/or'", () => {
		assert.deepEqual(extractPaths("read the docs and/or ask input/output questions"), []);
	});

	it("trims trailing punctuation", () => {
		const leads = extractPaths("Missing file src/app/main.ts.");
		assert.equal(leads[0]?.value, "src/app/main.ts");
	});

	it("dedupes within one result", () => {
		const leads = extractPaths("found in src/util.ts; also src/util.ts again");
		assert.equal(leads.filter((l) => l.value === "src/util.ts").length, 1);
	});
});

describe("extractUrls", () => {
	it("extracts a documentation URL", () => {
		const leads = extractUrls("See https://docs.example.com/guide/setup for details.");
		assert.deepEqual(leads.map((l) => l.value), ["https://docs.example.com/guide/setup"]);
	});

	it("extracts a URL wrapped in parentheses", () => {
		const leads = extractUrls("(see https://ci.example.dev/job/123#summary)");
		assert.deepEqual(leads.map((l) => l.value), ["https://ci.example.dev/job/123#summary"]);
	});
});

describe("extractCommands", () => {
	it("extracts a fenced suggested command", () => {
		const leads = extractCommands("Run `npm install left-pad` to fix this.");
		assert.deepEqual(leads.map((l) => l.value), ["npm install left-pad"]);
	});

	it("extracts a $-prompt line", () => {
		const leads = extractCommands("$ git status\nnothing staged");
		assert.deepEqual(leads.map((l) => l.value), ["git status"]);
	});

	it("ignores fenced prose that does not start with a known command", () => {
		assert.deepEqual(extractCommands("`some random words here` are not commands"), []);
	});
});

describe("extractLeads", () => {
	it("honours enabledTypes", () => {
		const config: UncompletedLeadsConfig = { ...CONFIG, enabledTypes: ["url"] };
		const leads = extractLeads("open /tmp/a.ts or see https://x.example.com/page", config);
		assert.deepEqual(leads.map((l) => l.type), ["url"]);
	});

	it("returns all three classes together", () => {
		const leads = extractLeads(
			"error in src/x.ts — see https://err.example.com/e1 — run `npm rebuild`",
			CONFIG,
		);
		assert.deepEqual(leads.map((l) => l.type), ["path", "url", "command"]);
	});
});

// ──────────────────── scan + completion matching ────────────────────

describe("scanSessionLeads", () => {
	it("flags a surfaced path as uncompleted when nothing pursues it", () => {
		const messages = [
			...exchange("c1", "grep -rn loadData src/", "src/db/store.ts:9: function loadData()"),
		];
		const scan = scanSessionLeads(messages, CONFIG);
		const lead = scan.leads.find((l) => l.type === "path");
		assert.ok(lead);
		assert.equal(lead.status, "uncompleted");
		assert.equal(lead.completed_by_message_id, null);
	});

	it("completes a path lead when a later read names it within the window", () => {
		const messages = [
			...exchange("c1", "grep -rn loadData src/", "src/db/store.ts:9: function loadData()"),
			laterCall("read", { file_path: "src/db/store.ts" }),
		];
		const scan = scanSessionLeads(messages, CONFIG);
		const lead = scan.leads.find((l) => l.type === "path");
		assert.ok(lead);
		assert.equal(lead.status, "completed");
		assert.ok(lead.completed_by_message_id);
	});

	it("does not complete a lead matched beyond the window", () => {
		const config: UncompletedLeadsConfig = { ...CONFIG, completionWindow: 2 };
		const messages = [
			...exchange("c1", "grep -rn loadData src/", "src/db/store.ts:9: function loadData()"),
			// three intervening calls: ordinals 1..3, first match would be ordinal 3 > 0+2
			laterCall("bash", { command: "echo one" }),
			laterCall("bash", { command: "echo two" }),
			laterCall("read", { file_path: "src/db/store.ts" }),
		];
		const scan = scanSessionLeads(messages, config);
		const lead = scan.leads.find((l) => l.type === "path");
		assert.ok(lead);
		assert.equal(lead.status, "uncompleted");
	});

	it("completes a lead matched at the last turn inside the window", () => {
		const config: UncompletedLeadsConfig = { ...CONFIG, completionWindow: 2 };
		const messages = [
			...exchange("c1", "grep -rn loadData src/", "src/db/store.ts:9: function loadData()"),
			laterCall("bash", { command: "echo one" }),
			laterCall("read", { file_path: "src/db/store.ts" }),
		];
		const scan = scanSessionLeads(messages, config);
		const lead = scan.leads.find((l) => l.type === "path");
		assert.ok(lead);
		assert.equal(lead.status, "completed");
	});

	it("never matches the lead against its own surfacing call", () => {
		// The producing command itself mentions the path; only strictly-later
		// invocations may complete.
		const messages = [
			...exchange("c1", "cat src/db/store.ts", "src/db/store.ts exists"),
			laterCall("bash", { command: "wc -l src/db/store.ts" }),
		];
		const scan = scanSessionLeads(messages, CONFIG);
		const lead = scan.leads.find((l) => l.type === "path");
		assert.ok(lead);
		assert.equal(lead.status, "completed");
		// The completing call is the later `wc` invocation, never the `cat` whose
		// own output surfaced the path.
		assert.equal(lead.tool_call_ordinal, 0);
		const completingRow = messages.find((m) => m.id === lead.completed_by_message_id);
		assert.ok(completingRow);
		assert.equal(completingRow.role, "assistant");
		assert.ok((completingRow.tool_calls ?? "").includes("wc -l"));
	});

	it("completes a URL lead when a later bash call fetches it", () => {
		const url = "https://docs.example.com/guide/setup";
		const messages = [
			...exchange("c1", "npm test", `failing. see ${url}`),
			laterCall("bash", { command: `curl -s ${url} | head` }),
		];
		const scan = scanSessionLeads(messages, CONFIG);
		const lead = scan.leads.find((l) => l.type === "url");
		assert.ok(lead);
		assert.equal(lead.status, "completed");
	});

	it("completes a command lead when the exact suggested command runs later", () => {
		const messages = [
			...exchange("c1", "npm install", "Run `npm rebuild` to fix native deps."),
			laterCall("bash", { command: "npm rebuild" }),
		];
		const scan = scanSessionLeads(messages, CONFIG);
		const lead = scan.leads.find((l) => l.type === "command");
		assert.ok(lead);
		assert.equal(lead.status, "completed");
	});

	it("leaves a command lead uncompleted when a different command runs instead", () => {
		const messages = [
			...exchange("c1", "npm install", "Run `npm audit fix` to resolve."),
			laterCall("bash", { command: "npm ci" }),
		];
		const scan = scanSessionLeads(messages, CONFIG);
		const lead = scan.leads.find((l) => l.type === "command");
		assert.ok(lead);
		assert.equal(lead.status, "uncompleted");
	});

	it("reads error-result text through the shared action stream", () => {
		const messages = [...exchange("c1", "cat /etc/hosts.allow", "Error: ENOENT, open '/missing/config.yaml'", true)];
		const scan = scanSessionLeads(messages, CONFIG);
		const lead = scan.leads.find((l) => l.type === "path");
		assert.ok(lead, "should surface the path named in the failed result");
		assert.equal(lead.value, "/missing/config.yaml");
	});

	it("claims nothing from an ambiguous multi-result row", () => {
		const messages = [
			assistantWithCalls([
				{ id: "c1", name: "bash", arguments: { command: "grep a ." } },
				{ id: "c2", name: "bash", arguments: { command: "grep b ." } },
			]),
			{
				...toolResultRow(
					[
						{ toolCallId: "c1" },
						{ toolCallId: "c2" },
					],
					"two results joined: src/one.ts src/two.ts",
				),
			},
		];
		const scan = scanSessionLeads(messages, CONFIG);
		assert.equal(scan.resultsWithText, 0);
		assert.equal(scan.leads.length, 0);
	});

	it("caps the lead list at maxLeads and counts the overflow", () => {
		const config: UncompletedLeadsConfig = { ...CONFIG, maxLeads: 3 };
		const many = Array.from({ length: 6 }, (_, i) => `src/file${i}.ts`).join("\n");
		const scan = scanSessionLeads([...exchange("c1", "ls", many)], config);
		assert.equal(scan.leads.length, 3);
		assert.equal(scan.truncatedLeads, 3);
	});

	it("is deterministic across re-runs over identical rows", () => {
		const messages = [
			...exchange("c1", "grep -rn x src/", "src/a.ts:1: x\nsee https://y.example.com/doc"),
			laterCall("read", { file_path: "src/a.ts" }),
		];
		const a = scanSessionLeads(messages, CONFIG);
		const b = scanSessionLeads(messages, CONFIG);
		assert.deepEqual(a, b);
	});
});
