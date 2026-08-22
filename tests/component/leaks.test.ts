/**
 * Component tests for the leak report (`prospect leaks`, issue #196) — the
 * read surface over the credential-detector family's metric nodes.
 *
 * Real SQLite (temp file), hand-written synthetic credentials that match the
 * detector catalogue's shapes but are never live values, no network, no LLM
 * (the detectors are deterministic). Proves the report lists which sessions
 * contain detected secrets, tallies per rule, anchors every finding to its
 * message, honours the severity floor / source / limit filters, and never
 * emits a full secret value.
 */

import { describe, it } from "node:test";
import * as os from "node:os";
import * as path from "node:path";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import { secretLeakAnalyzer } from "../../src/analyze/analyzers/secret-leak/index.js";
import { gitleaksAnalyzer } from "../../src/analyze/analyzers/gitleaks/index.js";
import { insertNode } from "../../src/db/analysis-queries.js";
import {
	parseLeaksArgs,
	readLeaks,
	renderLeaks,
	prospectLeaks,
	type LeakReport,
} from "../../src/commands/leaks.js";
import type { ExtensionCommandContext } from "../../src/pi-stubs.js";

// Shape-correct, never-live synthetic credentials (same convention as
// secret-leak.test.ts). The two detector families have disjoint catalogues for
// these shapes, so the scenario plants one per detector in the same session to
// exercise the cross-detector join.
const GITHUB_PAT = "ghp_" + "0".repeat(36);
const GITLAB_PIPELINE_TOKEN = "glptt-" + "a".repeat(40);
const SYNTHETIC_JWT =
	"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0." + "a".repeat(20);

const notes: string[] = [];
const ctx: ExtensionCommandContext = {
	modelRegistry: { find: () => undefined, getAll: () => [], getAvailable: () => [], getApiKeyAndHeaders: async () => ({ ok: false, error: "x" }) },
	hasUI: false,
	ui: { notify: (m) => notes.push(m) },
};

interface Scenario {
	db: Awaited<ReturnType<typeof tempDb>>["db"];
	close: () => Promise<void>;
	patMessageId: string;
}

/**
 * Two leaking pi sessions (one found by two detectors), one leaking claude
 * session, one clean session — so session grouping, cross-detector joins, the
 * source filter and the "no such thing as a clean hit" case are all exercised.
 */
async function buildScenario(dbPath?: string): Promise<Scenario> {
	const { db, close } = await tempDb(dbPath);
	await insertSession(db, "leak-pi-1", "/tmp/leak-pi-1.jsonl", "", "pi");
	await insertSession(db, "leak-pi-2", "/tmp/leak-pi-2.jsonl", "", "pi");
	await insertSession(db, "leak-claude-1", "/tmp/leak-claude-1.jsonl", "", "claude");
	await insertSession(db, "clean-pi", "/tmp/clean-pi.jsonl", "", "pi");

	const [patMessageId] = await insertMessages(db, "leak-pi-1", [
		{ role: "user", text: `deploying with this token: ${GITHUB_PAT}` },
		{ role: "assistant", text: `acknowledged, pipeline token: ${GITLAB_PIPELINE_TOKEN}` },
	]);
	await insertMessages(db, "leak-pi-2", [
		{ role: "user", text: `the api returned this jwt: ${SYNTHETIC_JWT}` },
		{ role: "assistant", text: "noted" },
	]);
	await insertMessages(db, "leak-claude-1", [
		{ role: "user", text: `use ${GITHUB_PAT} for the clone` },
		{ role: "assistant", text: "ok" },
	]);
	await insertMessages(db, "clean-pi", [
		{ role: "user", text: "fix the login bug, nothing sensitive here" },
		{ role: "assistant", text: "on it" },
	]);

	const fw = new AnalyzerFramework({ db, llm: createMockLLM({ fallback: "" }).caller });
	await fw.register(secretLeakAnalyzer);
	await fw.register(gitleaksAnalyzer);
	for (const sessionId of ["leak-pi-1", "leak-pi-2", "leak-claude-1", "clean-pi"]) {
		const summary = await fw.run(sessionId, { analyzerIds: ["secret-leak", "gitleaks"] });
		assert.equal(summary.errors.length, 0, summary.errors.join("; "));
	}
	return { db, close, patMessageId: patMessageId! };
}

describe("prospect leaks (issue #196)", () => {
	it("parses its flags and rejects malformed input", () => {
		assert.deepEqual(parseLeaksArgs(""), {});
		assert.deepEqual(parseLeaksArgs("--severity critical --limit 5"), { minSeverity: "critical", limit: 5 });
		assert.deepEqual(parseLeaksArgs("--source claude"), { source: "claude" });
		assert.throws(() => parseLeaksArgs("--severity urgent"), /unknown --severity/);
		assert.throws(() => parseLeaksArgs("--limit 0"), /positive integer/);
		assert.throws(() => parseLeaksArgs("--source bitbucket"), /unknown --source/);
		assert.throws(() => parseLeaksArgs("--bogus"), /unknown flag or stray argument/);
	});

	it("lists which sessions contain detected secrets, anchored to messages, across detectors", async () => {
		const s = await buildScenario();
		try {
			const { text, report } = await readLeaks(s.db, {});
			assert.equal(report.total_findings >= 3, true, "at least the three planted leaks");
			const sessionIds = report.sessions.map((g) => g.session_id);
			assert.ok(sessionIds.includes("leak-pi-1"));
			assert.ok(sessionIds.includes("leak-pi-2"));
			assert.ok(sessionIds.includes("leak-claude-1"));
			assert.ok(!sessionIds.includes("clean-pi"), "a session without findings is not reported");

			// Cross-detector join: leak-pi-1 carries a secret-leak-only PAT and a
			// gitleaks-only pipeline token; the report joins both into one view.
			const group = report.sessions.find((g) => g.session_id === "leak-pi-1")!;
			const analyzers = new Set(group.entries.map((e) => e.analyzer_id));
			assert.deepEqual([...analyzers].sort(), ["gitleaks", "secret-leak"]);

			// Evidence anchors: message id, field, redacted preview, fingerprint.
			const patFindings = group.entries.filter((e) => e.rule_id === "github_pat_classic");
			assert.equal(patFindings.length >= 1, true);
			const first = patFindings[0]!;
			assert.equal(first.message_id, s.patMessageId);
			assert.equal(first.field, "content_text");
			assert.match(text, new RegExp(`message ${s.patMessageId}`));
			assert.match(text, /github_pat_classic/);
			assert.match(text, /fp [0-9a-f]{16}/);
			assert.equal(report.rule_counts["github_pat_classic"], 2, "per-rule tally counts the PAT in both pi sessions");
		} finally {
			await s.close();
		}
	});

	it("never emits a full secret value — only the stored redacted preview", async () => {
		const s = await buildScenario();
		try {
			const { text, report } = await readLeaks(s.db, {});
			for (const secret of [GITHUB_PAT, SYNTHETIC_JWT]) {
				assert.ok(!text.includes(secret), "report must not contain the full secret");
				const middle = secret.slice(6, -6);
				assert.ok(!text.includes(middle), "report must not contain the middle of a secret");
			}
			for (const group of report.sessions) {
				for (const e of group.entries) {
					assert.ok(e.redacted_preview.length <= 12, "preview stays redacted");
					assert.match(e.fingerprint, /^[0-9a-f]{16}$/);
					assert.ok(!JSON.stringify(report).includes(GITHUB_PAT));
				}
			}
		} finally {
			await s.close();
		}
	});

	it("--severity is a floor: critical excludes the high-severity JWT, high keeps both", async () => {
		const s = await buildScenario();
		try {
			const critical = await readLeaks(s.db, { minSeverity: "critical" });
			for (const g of critical.report.sessions)
				for (const e of g.entries) assert.equal(e.severity, "critical");
			assert.ok(!JSON.stringify(critical.report).includes("jwt"), "high-severity findings excluded by the critical floor");

			const high = await readLeaks(s.db, { minSeverity: "high" });
			const severities = new Set(high.report.sessions.flatMap((g) => g.entries.map((e) => e.severity)));
			assert.deepEqual([...severities].sort(), ["critical", "high"]);
			assert.match(high.text, /severity ≥ high/);

			// The JWT finding is present somewhere in the graph at all:
			const all = await readLeaks(s.db, {});
			const rules = Object.keys(all.report.rule_counts);
			assert.ok(rules.includes("jwt"), "jwt rule appears without a floor");
		} finally {
			await s.close();
		}
	});

	it("--source restricts the report to one harness", async () => {
		const s = await buildScenario();
		try {
			const claude = await readLeaks(s.db, { source: "claude" });
			const ids = claude.report.sessions.map((g) => g.session_id);
			assert.deepEqual(ids, ["leak-claude-1"]);
			assert.equal(claude.report.sessions[0]!.source, "claude");

			const pi = await readLeaks(s.db, { source: "pi" });
			const piIds = pi.report.sessions.map((g) => g.session_id);
			assert.ok(piIds.includes("leak-pi-1") && piIds.includes("leak-pi-2"));
			assert.ok(!piIds.includes("leak-claude-1"));
		} finally {
			await s.close();
		}
	});

	it("--limit truncates honestly and reports what was omitted", async () => {
		const s = await buildScenario();
		try {
			const all = await readLeaks(s.db, {});
			const total = all.report.total_findings;
			assert.ok(total >= 3, "scenario has enough findings to truncate");
			const limited = await readLeaks(s.db, { limit: 1 });
			assert.equal(limited.report.sessions.length, 1);
			assert.equal(limited.report.total_findings, total, "total still reports the untruncated count");
			assert.equal(limited.report.omitted_by_limit, total - 1);
			assert.match(limited.text, new RegExp(`omitted by --limit 1`));

			const within = await readLeaks(s.db, { limit: 10_000 });
			assert.equal(within.report.omitted_by_limit, 0);
		} finally {
			await s.close();
		}
	});

	it("counts schema-malformed findings instead of dropping or rendering them", async () => {
		const s = await buildScenario();
		try {
			await insertNode(s.db, {
				id: "bad-node",
				sessionId: "leak-pi-1",
				analyzerId: "secret-leak",
				analyzerVersionId: "secret-leak-v1",
				configId: "cfg",
				runId: null,
				nodeKind: "metric",
				contentJson: JSON.stringify({ leaks: [{ nonsense: true }, "not even an object"], leak_count: 2 }),
				sourceSetHash: "sset-bad",
				inputKey: "ik-bad",
				outputKey: "ok-bad-node",
				createdAt: "2026-01-01T00:00:00.000Z",
			});
			const { text, report } = await readLeaks(s.db, {});
			assert.equal(report.malformed_findings, 2);
			assert.match(text, /note: 2 finding\(s\).*do not match the declared finding schema/);
		} finally {
			await s.close();
		}
	});

	it("renders an honest empty state when no findings exist", () => {
		const empty: LeakReport = { sessions: [], rule_counts: {}, total_findings: 0, omitted_by_limit: 0, malformed_findings: 0 };
		const text = renderLeaks(empty, {});
		assert.match(text, /No detected secrets/);
		const floored = renderLeaks(empty, { minSeverity: "critical" });
		assert.match(floored, /No detected secrets \(severity ≥ critical\)/);
	});

	it("the slash command prints the report through ctx.ui.notify", async () => {
		const dbPath = path.join(os.tmpdir(), `leak-slash-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
		process.env["PROSPECTOR_DB_PATH"] = dbPath;
		const s = await buildScenario(dbPath);
		try {
			notes.length = 0;
			await prospectLeaks("--severity critical", ctx);
			assert.equal(notes.length, 1);
			assert.match(notes[0]!, /Leaks — \d+ finding\(s\) across \d+ session\(s\) \(severity ≥ critical\)/);
			delete process.env["PROSPECTOR_DB_PATH"];
		} finally {
			delete process.env["PROSPECTOR_DB_PATH"];
			await s.close();
		}
	});
});
