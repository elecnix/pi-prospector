/**
 * Component tests for the SecretScanner-style container/filesystem evidence
 * detector analyzer, exercised end-to-end through the real AnalyzerFramework.
 * No real session data, no network, no LLM — detection is deterministic.
 *
 * These prove the analyzer plans, extracts artifact contexts from message
 * fields (including JSON-embedded tool calls), persists a metric node, is
 * idempotent on re-run, anchors findings to the session and the leaked
 * messages, and never writes the full matched secret into the analysis graph.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AsyncDatabase } from "../src/db/async-db.js";
import { tempDb, insertSession, insertMessages, type TestMessage } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import {
	SECRET_SCANNER_DEF,
	secretScannerAnalyzer,
	type SecretScannerProperties,
} from "../../src/analyze/analyzers/secret-scanner/index.js";
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
const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
/** Matches the github_pat_classic catalogue family (secret-leak catalogue). */
const GHP = ["ghp_", pseudo(36, 4242, ALNUM)].join("");
/** Credential-shaped value no catalogue rule matches → structural finding. */
const RANDOM_SECRET = pseudo(32, 77, ALNUM);

const DOCKERFILE = ["FROM node:22-alpine", `ENV GITHUB_TOKEN=${GHP}`].join("\n");
const ENV_FILE = ["$ cat .env", `DEPLOY_TOKEN=${RANDOM_SECRET}`].join("\n");

/** Framework with the secret-scanner analyzer registered. */
async function newFramework(
	db: AsyncDatabase,
	configOverrides?: Record<string, Record<string, unknown>>,
) {
	const fw = new AnalyzerFramework({
		db,
		// Unused by this analyzer (deterministic) but required by the framework ctor.
		llm: createMockLLM({ fallback: "" }).caller,
		modelTiers: DEFAULT_MODEL_TIERS,
		configOverrides,
	});
	await fw.register(secretScannerAnalyzer);
	return fw;
}

async function readNodes(db: AsyncDatabase): Promise<Array<Record<string, unknown>>>  {
	return await db
		.prepare("SELECT * FROM analysis_nodes WHERE analyzer_id = ? ORDER BY created_at ASC")
		.all(SECRET_SCANNER_DEF.id) as Array<Record<string, unknown>>;
}

async function newestProps(db: AsyncDatabase): SecretScannerProperties  {
	const rows = await readNodes(db);
	assert.ok(rows.length >= 1, "secret-scanner analyzer should produce at least one node");
	const row = rows[rows.length - 1]!; // newest (append-only graph)
	return JSON.parse(row["content_json"] as string) as SecretScannerProperties;
}

describe("secret-scanner component test", () => {
	it("detects leaks in container evidence across fields, anchors correctly, stores no full secret", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "ss-1");
			const ids = await insertMessages(db, "ss-1", [
				// Dockerfile content pasted into a user message.
				{ role: "user", text: `here is my Dockerfile:\n${DOCKERFILE}` },
				// .env content captured through a write tool's arguments (JSON field).
				{
					role: "assistant",
					toolCalls: [{ name: "write", arguments: { path: ".env", content: ENV_FILE } }],
				},
				{ role: "user", text: "thanks" },
			] satisfies TestMessage[]);

			const fw = await newFramework(db);
			const first = await fw.run("ss-1", { analyzerIds: ["secret-scanner"] });
			assert.equal(first.nodesProduced, 1);
			assert.equal(first.errors.length, 0);

			const rows = await readNodes(db);
			const row = rows[rows.length - 1]!;
			assert.equal(row["node_kind"], "metric");
			const props = JSON.parse(row["content_json"] as string) as SecretScannerProperties;

			assert.equal(props.has_leaks, true);
			assert.equal(props.leak_count, 2);
			assert.equal(props.message_count, 3);

			const byKey = new Map(props.leaks.map((l) => [l.key_name, l]));
			const ghpLeak = byKey.get("GITHUB_TOKEN")!;
			assert.equal(ghpLeak.rule_id, "github_pat_classic");
			assert.equal(ghpLeak.severity, "critical");
			assert.equal(ghpLeak.artifact_kind, "dockerfile");
			assert.equal(ghpLeak.artifact_location, "ENV in Dockerfile");
			assert.equal(ghpLeak.field, "content_text");
			assert.equal(ghpLeak.message_id, ids[0]);

			const structLeak = byKey.get("DEPLOY_TOKEN")!;
			assert.equal(structLeak.rule_id, "artifact-sensitive-name");
			assert.equal(structLeak.confidence, "active");
			assert.equal(structLeak.artifact_kind, "dotenv");
			assert.equal(structLeak.field, "tool_calls");

			assert.deepEqual(props.rule_counts, { github_pat_classic: 1, "artifact-sensitive-name": 1 });
			assert.equal(props.artifact_counts["dockerfile"], 1);
			assert.equal(props.artifact_counts["dotenv"], 1);
			assert.deepEqual(props.affected_message_ids, [ids[0], ids[1]].sort());

			// The full secrets must not be anywhere in the persisted node content.
			const contentJson = row["content_json"] as string;
			for (const secret of [GHP, RANDOM_SECRET]) {
				assert.ok(!contentJson.includes(secret), "full secret must not be persisted");
				assert.ok(!contentJson.includes(secret.slice(4, -4)), "middle of secret must not be persisted");
			}

			// Anchors: one to the session, one per leaked message.
			const edges = await db
				.prepare("SELECT * FROM analysis_edges WHERE from_node_id = ?")
				.all(row["id"]) as Array<Record<string, unknown>>;
			const anchors = edges.filter((e) => e["edge_kind"] === "anchors");
			assert.equal(anchors.length, 3);
			const targets = anchors.map((e) => `${e["to_ref_kind"]}:${e["to_ref_id"]}`).sort();
			assert.deepEqual(targets, [`message:${ids[0]}`, `message:${ids[1]}`, "session:ss-1"]);
		} finally {
			await close();
		}
	});

	it("is idempotent: a second run produces no new node", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "ss-2");
			await insertMessages(db, "ss-2", [
				{ role: "user", text: `Dockerfile:\n${DOCKERFILE}` },
			] satisfies TestMessage[]);

			const fw = await newFramework(db);
			const first = await fw.run("ss-2", { analyzerIds: ["secret-scanner"] });
			assert.equal(first.nodesProduced, 1);
			const second = await fw.run("ss-2", { analyzerIds: ["secret-scanner"] });
			assert.equal(second.nodesProduced, 0);
			assert.equal(second.nodesSkipped, 1);

			const count = ((await db
				.prepare("SELECT COUNT(*) as c FROM analysis_nodes WHERE analyzer_id = ?")
				.get(SECRET_SCANNER_DEF.id)) as { c: number }).c;
			assert.equal(count, 1);
		} finally {
			await close();
		}
	});

	it("config overrides apply: allowlisting by fingerprint and disabling an extractor", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "ss-3");
			await insertMessages(db, "ss-3", [
				{ role: "user", text: `Dockerfile:\n${DOCKERFILE}\n${ENV_FILE}` },
			] satisfies TestMessage[]);

			const propsBefore = (async () => {
				const fw = await newFramework(db);
				await fw.run("ss-3", { analyzerIds: ["secret-scanner"] });
				return await newestProps(db);
			})();
			const base = await propsBefore;
			assert.equal(base.leak_count, 2);

			// Allowlist the structural finding's fingerprint via config override.
			const fp = base.leaks.find((l) => l.key_name === "DEPLOY_TOKEN")!.fingerprint;
			const fw2 = await newFramework(db, {
				"secret-scanner": { allowFingerprints: [fp], extractDotenv: false },
			});
			// A config change makes the unit stale/config; revise to recompute.
			await fw2.run("ss-3", { analyzerIds: ["secret-scanner"], revise: ["config"] });
			const after = await newestProps(db);
			assert.equal(after.leak_count, 1);
			assert.equal(after.leaks[0]!.key_name, "GITHUB_TOKEN");
			assert.equal(after.allowlisted_matches, 0); // dotenv extractor off → candidate never generated
		} finally {
			await close();
		}
	});

	it("clean session produces a node with has_leaks=false", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "ss-4");
			await insertMessages(db, "ss-4", [
				{ role: "user", text: "please refactor the scanner helpers" },
				{ role: "assistant", text: "splitting by concern" },
			] satisfies TestMessage[]);

			const summary = await (await newFramework(db)).run("ss-4", { analyzerIds: ["secret-scanner"] });
			assert.equal(summary.errors.length, 0);
			assert.equal(summary.nodesProduced, 1);
			const props = await newestProps(db);
			assert.equal(props.has_leaks, false);
			assert.equal(props.leak_count, 0);
		} finally {
			await close();
		}
	});
});
