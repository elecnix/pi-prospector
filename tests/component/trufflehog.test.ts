/**
 * Component tests for the trufflehog detector analyzer, exercised end-to-end
 * through the real AnalyzerFramework. No real session data, no network, no
 * LLM — detection is deterministic, and verification runs against mock
 * verifiers injected through the analyzer factory (the verifier seam).
 *
 * These prove the analyzer plans, scans, persists a metric node, is idempotent
 * on re-run, anchors findings to the session and the leaked messages, keeps
 * verification off by default, attaches verification outcomes when enabled via
 * config (marking prior nodes stale/config), and never writes the full matched
 * secret into the analysis graph.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages, type TestMessage } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import {
	makeTruffleHogAnalyzer,
	TRUFFLEHOG_DEF,
	type TruffleHogProperties,
} from "../../src/analyze/analyzers/trufflehog/index.js";
import { createMockVerifier } from "../../src/analyze/analyzers/trufflehog/mock-verifiers.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";

// Shape-correct, never-live synthetic credentials, built by a deterministic
// PRNG over fixed charsets so no contiguous realistic literal exists in source.
function makeRng(seed: number): () => number {
	let a = seed >>> 0;
	return function () {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
function pseudo(len: number, seed: number, charset: string): string {
	const rng = makeRng(seed);
	let s = "";
	for (let i = 0; i < len; i++) s += charset[Math.floor(rng() * charset.length)];
	return s;
}
const TOKEN_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
const FIGD = ["figd_", pseudo(36, 101, TOKEN_CHARS)].join("");

const MOCK_VERIFIER = createMockVerifier({
	id: "figma-token",
	appliesTo: "^figd_",
	outcomes: { [FIGD]: { verified: true, reason: "mock-live" } },
});

/** Framework with the trufflehog analyzer registered under injected verifiers. */
function newFramework(
	db: import("better-sqlite3").Database,
	configOverrides?: Record<string, Record<string, unknown>>,
) {
	const fw = new AnalyzerFramework({
		db,
		// Unused by this analyzer (deterministic) but required by the framework ctor.
		llm: createMockLLM({ fallback: "" }).caller,
		modelTiers: DEFAULT_MODEL_TIERS,
		configOverrides,
	});
	fw.register(makeTruffleHogAnalyzer([MOCK_VERIFIER]));
	return fw;
}

function readNodes(db: import("better-sqlite3").Database): Array<Record<string, unknown>> {
	return db
		.prepare("SELECT * FROM analysis_nodes WHERE analyzer_id = ? ORDER BY created_at ASC")
		.all(TRUFFLEHOG_DEF.id) as Array<Record<string, unknown>>;
}

function newestProps(db: import("better-sqlite3").Database): TruffleHogProperties {
	const rows = readNodes(db);
	assert.ok(rows.length >= 1, "trufflehog analyzer should produce at least one node");
	const row = rows[rows.length - 1]!; // newest (append-only graph)
	return JSON.parse(row["content_json"] as string) as TruffleHogProperties;
}

describe("trufflehog component test", () => {
	it("detects a self-written pattern in a user message, anchors correctly, stores no full secret", async () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "th-1");
			const ids = insertMessages(db, "th-1", [
				{ role: "user", text: `deploy uses this figma token: ${FIGD}` },
				{ role: "assistant", text: "noted" },
			] satisfies TestMessage[]);

			const fw = newFramework(db);
			const first = await fw.run("th-1", { analyzerIds: ["trufflehog"] });
			assert.equal(first.nodesProduced, 1);
			assert.equal(first.errors.length, 0);

			const rows = readNodes(db);
			const row = rows[rows.length - 1]!;
			assert.equal(row["node_kind"], "metric");
			const props = JSON.parse(row["content_json"] as string) as TruffleHogProperties;

			assert.equal(props.has_leaks, true);
			assert.equal(props.leak_count, 1);
			assert.equal(props.leaks[0]!.rule_id, "figma-pat-figd");
			assert.equal(props.leaks[0]!.message_id, ids[0]);
			// Verification is off by default: no outcomes, no summary.
			assert.equal(props.verify_enabled, false);
			assert.equal(props.leaks[0]!.verification, undefined);
			assert.equal(props.verification, undefined);

			// The full secret must not be anywhere in the persisted node content.
			const contentJson = row["content_json"] as string;
			assert.ok(!contentJson.includes(FIGD), "full secret must not be persisted");
			assert.ok(!contentJson.includes(FIGD.slice(4, -4)), "middle of secret must not be persisted");

			// Anchors: one to the session, one to the leaked message.
			const edges = db
				.prepare("SELECT * FROM analysis_edges WHERE from_node_id = ?")
				.all(row["id"]) as Array<Record<string, unknown>>;
			const anchors = edges.filter((e) => e["edge_kind"] === "anchors");
			assert.equal(anchors.length, 2);
			const targets = anchors.map((e) => `${e["to_ref_kind"]}:${e["to_ref_id"]}`).sort();
			assert.deepEqual(targets, [`message:${ids[0]}`, "session:th-1"]);
		} finally {
			close();
		}
	});

	it("is idempotent: a second run produces no new node", async () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "th-2");
			insertMessages(db, "th-2", [
				{ role: "user", text: `token ${FIGD}` },
			] satisfies TestMessage[]);

			const fw = newFramework(db);
			const first = await fw.run("th-2", { analyzerIds: ["trufflehog"] });
			assert.equal(first.nodesProduced, 1);
			const second = await fw.run("th-2", { analyzerIds: ["trufflehog"] });
			assert.equal(second.nodesProduced, 0);
			assert.equal(second.nodesSkipped, 1);

			const count = (db
				.prepare("SELECT COUNT(*) as c FROM analysis_nodes WHERE analyzer_id = ?")
				.get(TRUFFLEHOG_DEF.id) as { c: number }).c;
			assert.equal(count, 1);
		} finally {
			close();
		}
	});

	it("with verify:true, findings carry verification outcomes and the mock is probed once per credential", async () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "th-3");
			insertMessages(db, "th-3", [
				{ role: "user", text: `key one ${FIGD}` },
			] satisfies TestMessage[]);

			const fw = newFramework(db, { trufflehog: { verify: true } });
			const run = await fw.run("th-3", { analyzerIds: ["trufflehog"] });
			assert.equal(run.errors.length, 0);
			assert.equal(run.nodesProduced, 1);

			const props = newestProps(db);
			assert.equal(props.verify_enabled, true);
			assert.equal(props.leaks[0]!.verification!.verified, true);
			assert.equal(props.leaks[0]!.verification!.reason, "mock-live");
			assert.deepEqual(props.verification, {
				verified_true: 1,
				verified_false: 0,
				verified_unknown: 0,
				unverified: 0,
				probes_issued: 1,
			});
			assert.equal(MOCK_VERIFIER.calls.length, 1);

			// The outcome must not smuggle the raw value into the graph.
			const contentJson = JSON.stringify(props);
			assert.ok(!contentJson.includes(FIGD));
		} finally {
			close();
		}
	});

	it("enabling verify marks prior nodes stale/config; a config-reason run revises them, preserving lineage", async () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "th-4");
			insertMessages(db, "th-4", [
				{ role: "user", text: `key ${FIGD}` },
			] satisfies TestMessage[]);

			// Detection-only run first.
			const plain = newFramework(db);
			await plain.run("th-4", { analyzerIds: ["trufflehog"] });
			assert.equal(readNodes(db).length, 1);

			// A frugal run under verify:true does NOT silently reuse or rewrite:
			// the unit is stale/config and stays untouched without the reason.
			const verifying = newFramework(db, { trufflehog: { verify: true } });
			const frugal = await verifying.run("th-4", { analyzerIds: ["trufflehog"] });
			assert.equal(frugal.nodesProduced, 0);
			assert.equal(readNodes(db).length, 1);

			// With the `config` revise reason it recomputes into a NEW version.
			const revised = await verifying.run("th-4", { analyzerIds: ["trufflehog"], revise: ["config"] });
			assert.equal(revised.nodesProduced, 1);
			const rows = readNodes(db);
			assert.equal(rows.length, 2, "append-only: old node preserved beside the new one");

			const oldProps = JSON.parse(rows[0]!["content_json"] as string) as TruffleHogProperties;
			const newProps = JSON.parse(rows[1]!["content_json"] as string) as TruffleHogProperties;
			assert.equal(oldProps.verify_enabled, false);
			assert.equal(newProps.verify_enabled, true);
			assert.equal(newProps.leaks[0]!.verification!.verified, true);

			// Lineage: the new node revises its predecessor (referenced by its
			// content-addressed output_key, like every typed edge).
			const priorOutputKey = rows[0]!["output_key"] as string;
			const revises = db
				.prepare(
					"SELECT COUNT(*) as c FROM analysis_edges WHERE edge_kind = 'revises' AND to_ref_id = ?",
				)
				.get(priorOutputKey) as { c: number };
			assert.equal(revises.c, 1);
		} finally {
			close();
		}
	});

	it("clean session produces a node with has_leaks=false and no verification", async () => {
		const { db, close } = tempDb();
		try {
			insertSession(db, "th-5");
			insertMessages(db, "th-5", [
				{ role: "user", text: "please refactor the scanner helpers" },
				{ role: "assistant", text: "splitting by concern" },
			] satisfies TestMessage[]);

			const summary = await newFramework(db).run("th-5", { analyzerIds: ["trufflehog"] });
			assert.equal(summary.errors.length, 0);
			assert.equal(summary.nodesProduced, 1);
			const props = newestProps(db);
			assert.equal(props.has_leaks, false);
			assert.equal(props.leak_count, 0);
			assert.equal(props.verify_enabled, false);
		} finally {
			close();
		}
	});
});
