/**
 * Component tests for the verification-commands analyzer and its use by
 * stale-verification, exercised end-to-end through the real AnalyzerFramework.
 * No real session data, no network: hand-written synthetic rows with explicit
 * timestamps, and a deterministic mock decision model.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import { createMockDecisionModel } from "../../src/analyze/mock-decision-model.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import { verificationCommandsAnalyzer } from "../../src/analyze/analyzers/verification-commands/index.js";
import { staleVerificationAnalyzer } from "../../src/analyze/analyzers/stale-verification/index.js";
import type { AsyncDatabase } from "../../src/db/async-db.js";
import type { DecisionAnswer } from "../../src/analyze/decision-model.js";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();

function call(id: string, name: string, args: Record<string, unknown>, s: number) {
	return { role: "assistant" as const, text: "", timestamp: at(s), toolCalls: [{ id, name, arguments: args }] };
}

function done(id: string, name: string, s: number) {
	return { role: "toolResult" as const, timestamp: at(s), toolResults: [{ toolCallId: id, toolName: name, isError: false, textLength: 12 }] };
}

/** A session that runs a gate script, edits, runs it again, and commits. */
function gateSession() {
	return [
		{ role: "user" as const, text: "Fix the date parser.", timestamp: at(0) },
		call("v1", "bash", { command: "tools/ci/verify-all" }, 10),
		done("v1", "bash", 130),
		call("e1", "edit", { path: "src/date.ts" }, 140),
		done("e1", "edit", 141),
		call("v2", "bash", { command: "tools/ci/verify-all" }, 200),
		done("v2", "bash", 320),
		call("c1", "bash", { command: "git commit -m 'fix: parse dates'" }, 330),
		done("c1", "bash", 331),
	];
}

const FULL: Record<string, DecisionAnswer> = {
	verifies: { type: "choice", choice: "full", confidence: 0.92, probabilities: { full: 0.92, narrow: 0.05, not_verification: 0.03 } },
};

async function seed(db: AsyncDatabase, sessionId: string, messages: ReturnType<typeof gateSession>): Promise<void> {
	await insertSession(db, sessionId);
	await insertMessages(db, sessionId, messages);
}

async function framework(db: AsyncDatabase, decisionModel?: string) {
	const llm = createMockLLM({ responder: () => "unused" });
	const decision = createMockDecisionModel({ responder: () => FULL, inputTokensPerCall: 200 });
	const fw = new AnalyzerFramework({
		db,
		llm: llm.caller,
		decide: decision.caller,
		modelTiers: DEFAULT_MODEL_TIERS,
		configOverrides: decisionModel ? { "verification-commands": { decisionModel } } : undefined,
	});
	await fw.register(verificationCommandsAnalyzer);
	await fw.register(staleVerificationAnalyzer);
	return { fw, decision };
}

describe("verification-commands component test", () => {
	it("judges a nominated command once and stores the verdict", async () => {
		const { db, close } = await tempDb();
		try {
			await seed(db, "vc-1", gateSession());
			const { fw, decision } = await framework(db, "jev/jev-1.13.0");
			await fw.run("vc-1", {});

			assert.equal(decision.calls.length, 1, "one request for the one distinct command");
			const state = decision.calls[0]!.state as { command: string };
			assert.equal(state.command, "tools/ci/verify-all");

			const nodes = (await db
				.prepare("SELECT content_json FROM analysis_nodes WHERE analyzer_id = 'verification-commands'")
				.all()) as Array<{ content_json: string }>;
			assert.equal(nodes.length, 1);
			const content = JSON.parse(nodes[0]!.content_json) as Record<string, unknown>;
			assert.equal(content["command"], "tools/ci/verify-all");
			assert.equal(content["verdict"], "full");
		} finally {
			await close();
		}
	});

	it("nominates nothing without a decision model, and the pattern list stands alone", async () => {
		const { db, close } = await tempDb();
		try {
			await seed(db, "vc-2", gateSession());
			const { fw, decision } = await framework(db);
			await fw.run("vc-2", {});

			assert.equal(decision.calls.length, 0, "no model call without a decision model");
			const nodes = (await db.prepare("SELECT id FROM analysis_nodes WHERE analyzer_id = 'verification-commands'").all()) as unknown[];
			assert.equal(nodes.length, 0);
		} finally {
			await close();
		}
	});

	it("sends only the command line, and never the session text", async () => {
		const { db, close } = await tempDb();
		try {
			await seed(db, "vc-5", gateSession());
			const { fw, decision } = await framework(db, "jev/jev-1.13.0");
			await fw.run("vc-5", {});

			assert.equal(decision.calls.length, 1);
			const request = decision.calls[0]!;
			// The whole state is the command line. Nothing else about the
			// session rides along.
			assert.deepEqual(Object.keys(request.state as Record<string, unknown>), ["command"]);
			const state = request.state as { command: string };
			assert.equal(state.command, "tools/ci/verify-all");

			// The session's own words never appear in the request. The question's
			// own examples name paths of their own, so the check is on the
			// strings the session carried.
			const serialised = JSON.stringify(request);
			assert.ok(!serialised.includes("Fix the date parser"), "the user's prompt is not sent");
			assert.ok(!serialised.includes("the parser"), "the assistant's words are not sent");
			assert.ok(!serialised.includes("2026-01-01"), "no timestamp from the session is sent");
		} finally {
			await close();
		}
	});

	it("redacts an obvious secret before the command line is sent", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "vc-6");
			await insertMessages(db, "vc-6", [
				call("v1", "bash", { command: "API_TOKEN=s3cretvalue123 tools/ci/verify-all" }, 10),
				done("v1", "bash", 130),
				call("c1", "bash", { command: "git commit -m 'chore: bump'" }, 140),
				done("c1", "bash", 141),
			]);
			const { fw, decision } = await framework(db, "jev/jev-1.13.0");
			await fw.run("vc-6", {});

			assert.equal(decision.calls.length, 1);
			const state = decision.calls[0]!.state as { command: string };
			assert.ok(!state.command.includes("s3cretvalue123"), "the secret is not sent");
			assert.match(state.command, /API_TOKEN=<redacted>/);
			assert.match(state.command, /tools\/ci\/verify-all/, "the command itself is sent");
		} finally {
			await close();
		}
	});

	it("the node stores the redacted command, not the raw one", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "vc-8");
			await insertMessages(db, "vc-8", [
				call("v1", "bash", { command: "API_TOKEN=s3cretvalue123 tools/ci/verify-all" }, 10),
				done("v1", "bash", 130),
				call("c1", "bash", { command: "git commit -m 'chore: bump'" }, 140),
				done("c1", "bash", 141),
			]);
			const { fw } = await framework(db, "jev/jev-1.13.0");
			await fw.run("vc-8", {});

			const nodes = (await db
				.prepare("SELECT content_json FROM analysis_nodes WHERE analyzer_id = 'verification-commands'")
				.all()) as Array<{ content_json: string }>;
			assert.equal(nodes.length, 1);
			const content = JSON.parse(nodes[0]!.content_json) as Record<string, unknown>;
			assert.ok(!JSON.stringify(content).includes("s3cretvalue123"), "the node holds no secret");
			assert.match(content["command"] as string, /API_TOKEN=<redacted>/);
		} finally {
			await close();
		}
	});

	it("the off-switch keeps every command line on the machine", async () => {
		const { db, close } = await tempDb();
		try {
			await seed(db, "vc-7", gateSession());
			const llm = createMockLLM({ responder: () => "unused" });
			const decision = createMockDecisionModel({ responder: () => FULL, inputTokensPerCall: 200 });
			const fw = new AnalyzerFramework({
				db,
				llm: llm.caller,
				decide: decision.caller,
				modelTiers: DEFAULT_MODEL_TIERS,
				configOverrides: {
					"verification-commands": { decisionModel: "jev/jev-1.13.0", allowRemoteVerdicts: false },
				},
			});
			await fw.register(verificationCommandsAnalyzer);
			await fw.register(staleVerificationAnalyzer);
			await fw.run("vc-7", {});

			assert.equal(decision.calls.length, 0, "no command line left the machine");
			const nodes = (await db
				.prepare("SELECT id FROM analysis_nodes WHERE analyzer_id = 'verification-commands'")
				.all()) as unknown[];
			assert.equal(nodes.length, 0, "no verdict was sought");

			// The local pattern list still works.
			const stale = (await db
				.prepare("SELECT content_json FROM analysis_nodes WHERE analyzer_id = 'stale-verification'")
				.all()) as Array<{ content_json: string }>;
			assert.equal(stale.length, 1);
			const content = JSON.parse(stale[0]!.content_json) as Record<string, unknown>;
			assert.equal(content["passing_run_count"], 0, "the gate script no default pattern covers is not measured");
		} finally {
			await close();
		}
	});

	it("a second session that ran the same command reuses the verdict for free", async () => {
		const { db, close } = await tempDb();
		try {
			await seed(db, "vc-3a", gateSession());
			await seed(db, "vc-3b", gateSession());
			const { fw, decision } = await framework(db, "jev/jev-1.13.0");
			await fw.run("vc-3a", {});
			await fw.run("vc-3b", {});

			assert.equal(decision.calls.length, 1, "the corpus paid for the command once");
			const nodes = (await db
				.prepare("SELECT COUNT(*) c FROM analysis_nodes WHERE analyzer_id = 'verification-commands'")
				.get()) as { c: number };
			assert.equal(nodes.c, 1, "one verdict node, not one per session");
		} finally {
			await close();
		}
	});

	it("the verdict is a function of the command alone, so it reproduces on another machine", async () => {
		const { db, close } = await tempDb();
		try {
			await seed(db, "vc-4a", gateSession());
			await seed(db, "vc-4b", gateSession());
			const { fw } = await framework(db, "jev/jev-1.13.0");
			await fw.run("vc-4a", {});
			await fw.run("vc-4b", {});

			const nodes = (await db
				.prepare("SELECT output_key, content_json FROM analysis_nodes WHERE analyzer_id = 'verification-commands'")
				.all()) as Array<{ output_key: string; content_json: string }>;
			assert.equal(nodes.length, 1);
			const content = JSON.parse(nodes[0]!.content_json) as Record<string, unknown>;
			assert.equal(content["command"], "tools/ci/verify-all");
			// Nothing session-specific rides along: the content is the verdict and
			// the command, nothing a second session would change.
			assert.deepEqual(Object.keys(content).sort(), ["command", "confidence", "probabilities", "verdict"]);
		} finally {
			await close();
		}
	});

	it("stale-verification counts a run of a command the pattern list does not cover", async () => {
		const { db, close } = await tempDb();
		try {
			await seed(db, "sv-1", gateSession());
			const { fw } = await framework(db, "jev/jev-1.13.0");
			await fw.run("sv-1", {});

			const nodes = (await db
				.prepare("SELECT content_json, node_kind FROM analysis_nodes WHERE analyzer_id = 'stale-verification'")
				.all()) as Array<{ content_json: string; node_kind: string }>;
			assert.equal(nodes.length, 1);
			const content = JSON.parse(nodes[0]!.content_json) as Record<string, unknown>;
			assert.equal(content["passing_run_count"], 2, "both gate runs counted");
			assert.equal((content["stale_runs"] as unknown[]).length, 1, "the first run went stale");
		} finally {
			await close();
		}
	});

	it("stale-verification ignores a command the pattern list does not cover when nothing judged it", async () => {
		const { db, close } = await tempDb();
		try {
			await seed(db, "sv-2", gateSession());
			const { fw } = await framework(db);
			await fw.run("sv-2", {});

			const nodes = (await db
				.prepare("SELECT content_json FROM analysis_nodes WHERE analyzer_id = 'stale-verification'")
				.all()) as Array<{ content_json: string }>;
			assert.equal(nodes.length, 1);
			const content = JSON.parse(nodes[0]!.content_json) as Record<string, unknown>;
			assert.equal(content["passing_run_count"], 0, "an unjudged command is not a verification run");
		} finally {
			await close();
		}
	});

	it("a newly learned command marks the stale-verification node stale for config", async () => {
		const { db, close } = await tempDb();
		try {
			await seed(db, "sv-3", gateSession());
			const { fw } = await framework(db, "jev/jev-1.13.0");
			await fw.run("sv-3", {});

			const before = (await db
				.prepare("SELECT id, content_json FROM analysis_nodes WHERE analyzer_id = 'stale-verification'")
				.all()) as Array<{ id: string; content_json: string }>;
			assert.equal(JSON.parse(before[0]!.content_json)["passing_run_count"], 2);

			// A second corpus learns another command, so the judged set changes.
			await insertSession(db, "sv-3-other");
			await insertMessages(db, "sv-3-other", [
				call("v9", "bash", { command: "tox -e lint" }, 10),
				done("v9", "bash", 130),
				call("c9", "bash", { command: "git commit -m x" }, 140),
				done("c9", "bash", 141),
			]);
			const other = await framework(db, "jev/jev-1.13.0");
			await other.fw.run("sv-3-other", {});

			const scanned = (await other.fw.scan("sv-3")).filter((c) => c.analyzerId === "stale-verification");
			assert.ok(scanned.length > 0 && scanned.every((c) => c.status === "stale" && c.reasons.includes("config")));
		} finally {
			await close();
		}
	});
});
