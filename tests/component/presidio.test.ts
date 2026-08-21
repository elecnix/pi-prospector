/**
 * Component tests for the Presidio-method PII detector analyzer, exercised
 * end-to-end through the real AnalyzerFramework. Real SQLite (temp file), no
 * network, no LLM — detection is deterministic.
 *
 * These prove the analyzer plans, detects PII across all four message fields,
 * persists a metric node, is idempotent on re-run, anchors findings to the
 * session and the affected messages, honours config (entity-type filter,
 * allow/deny fingerprints), and never writes a full PII value into the
 * analysis graph.
 *
 * All fixture values are synthetic: reserved-for-documentation ranges and
 * clearly invented identifiers (Ada Lovelace at example.com, Ofcom/555-01xx
 * fictional numbers, RFC 5737 TEST-NET addresses, the public Luhn test card,
 * Wikipedia's worked IBAN example).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AsyncDatabase } from "../src/db/async-db.js";
import { tempDb, insertSession, insertMessages, type TestMessage } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createMockLLM } from "../../src/analyze/mock-llm.js";
import {
	PRESIDIO_DEF,
	presidioAnalyzer,
	type PresidioProperties,
} from "../../src/analyze/analyzers/presidio/index.js";
import { fingerprintOf } from "../../src/analyze/analyzers/presidio/detectors.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";

// Synthetic PII fixture values.
const EMAIL = "ada.lovelace@example.com";
const PHONE = "+1 (415) 555-0132"; // 555-01xx: reserved for fiction
const PUBLIC_IP = "203.0.113.7"; // RFC 5737 TEST-NET-3
const PRIVATE_IP = "192.168.1.10"; // RFC 1918 — below the default score floor
const CARD = "4111 1111 1111 1111"; // the standard public Luhn test card
const IBAN = "GB82 WEST 1234 5698 7654 32"; // worked mod-97 example
const SSN = "876-54-3210"; // valid shape, invented

/** Framework with the presidio analyzer registered. */
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
	await fw.register(presidioAnalyzer);
	return fw;
}

async function readNodes(db: AsyncDatabase): Promise<Array<Record<string, unknown>>>  {
	return await db
		.prepare("SELECT * FROM analysis_nodes WHERE analyzer_id = ? ORDER BY created_at ASC")
		.all(PRESIDIO_DEF.id) as Array<Record<string, unknown>>;
}

async function newestProps(db: AsyncDatabase): PresidioProperties  {
	const rows = await readNodes(db);
	assert.ok(rows.length >= 1, "presidio analyzer should produce at least one node");
	const row = rows[rows.length - 1]!; // newest (append-only graph)
	return JSON.parse(row["content_json"] as string) as PresidioProperties;
}

describe("presidio component test", () => {
	it("detects PII across fields, anchors correctly, stores no full value", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "pii-1");
			const ids = await insertMessages(db, "pii-1", [
				// User pastes contact details into prose.
				{ role: "user", text: `reach me at ${EMAIL} or ${PHONE}, box ${PUBLIC_IP}` },
				// Card number surfaces in the assistant's private reasoning.
				{ role: "assistant", thinking: `customer card on file: ${CARD}` },
				// Financial identifiers captured through a write tool's arguments (JSON field).
				{
					role: "assistant",
					toolCalls: [{ name: "write", arguments: { path: "kyc.txt", content: `IBAN ${IBAN}\nSSN ${SSN}` } }],
				},
				// Private-range IP only: judged but below the default score floor.
				{ role: "user", text: `dev server ${PRIVATE_IP}` },
			] satisfies TestMessage[]);

			const fw = await newFramework(db);
			const first = await fw.run("pii-1", { analyzerIds: ["presidio"] });
			assert.equal(first.nodesProduced, 1);
			assert.equal(first.errors.length, 0);

			const rows = await readNodes(db);
			const row = rows[rows.length - 1]!;
			assert.equal(row["node_kind"], "metric");
			const props = JSON.parse(row["content_json"] as string) as PresidioProperties;

			assert.equal(props.has_pii, true);
			assert.equal(props.message_count, 4);
			// Email + phone + public IP + card + IBAN + SSN; private IP below floor.
			assert.equal(props.pii_count, 6);
			assert.equal(props.below_score_matches, 1);
			assert.equal(props.entity_counts["EMAIL_ADDRESS"], 1);
			assert.equal(props.entity_counts["PHONE_NUMBER"], 1);
			assert.equal(props.entity_counts["IP_ADDRESS"], 1);
			assert.equal(props.entity_counts["CREDIT_CARD"], 1);
			assert.equal(props.entity_counts["IBAN_CODE"], 1);
			assert.equal(props.entity_counts["US_SSN"], 1);

			const byType = new Map(props.piis.map((p) => [p.entity_type, p]));
			const email = byType.get("EMAIL_ADDRESS")!;
			assert.equal(email.message_id, ids[0]);
			assert.equal(email.field, "content_text");
			assert.equal(email.validated, true);
			assert.ok(!email.redacted_preview.includes(EMAIL));

			const card = byType.get("CREDIT_CARD")!;
			assert.equal(card.message_id, ids[1]);
			assert.equal(card.field, "content_thinking");
			assert.equal(card.score, 1); // Luhn-validated
			assert.equal(card.severity, "critical");

			const iban = byType.get("IBAN_CODE")!;
			assert.equal(iban.message_id, ids[2]);
			assert.equal(iban.field, "tool_calls");
			assert.equal(iban.score, 1); // mod-97 validated

			// No full PII value may appear anywhere in the persisted node content.
			const contentJson = row["content_json"] as string;
			for (const value of [EMAIL, PHONE, PUBLIC_IP, PRIVATE_IP, CARD, CARD.replace(/ /g, ""), IBAN, SSN]) {
				assert.ok(!contentJson.includes(value), `full value must not be persisted: ${value}`);
			}

			// Anchors: one to the session, one per message with a finding.
			const edges = await db
				.prepare("SELECT * FROM analysis_edges WHERE from_node_id = ?")
				.all(row["id"]) as Array<Record<string, unknown>>;
			const anchors = edges.filter((e) => e["edge_kind"] === "anchors");
			assert.equal(anchors.length, 4);
			const targets = anchors.map((e) => `${e["to_ref_kind"]}:${e["to_ref_id"]}`).sort();
			assert.deepEqual(targets, [`message:${ids[0]}`, `message:${ids[1]}`, `message:${ids[2]}`, "session:pii-1"]);
		} finally {
			await close();
		}
	});

	it("is idempotent: a second run produces no new node", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "pii-2");
			await insertMessages(db, "pii-2", [{ role: "user", text: `mail ${EMAIL}` }] satisfies TestMessage[]);

			const fw = await newFramework(db);
			const first = await fw.run("pii-2", { analyzerIds: ["presidio"] });
			assert.equal(first.nodesProduced, 1);
			const second = await fw.run("pii-2", { analyzerIds: ["presidio"] });
			assert.equal(second.nodesProduced, 0);
			assert.equal(second.nodesSkipped, 1);

			const count = ((await db
				.prepare("SELECT COUNT(*) as c FROM analysis_nodes WHERE analyzer_id = ?")
				.get(PRESIDIO_DEF.id)) as { c: number }).c;
			assert.equal(count, 1);
		} finally {
			await close();
		}
	});

	it("config overrides apply: entity filter, allowlist, denylist", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "pii-3");
			await insertMessages(db, "pii-3", [
				{ role: "user", text: `mail ${EMAIL} card ${CARD} ip ${PUBLIC_IP}` },
			] satisfies TestMessage[]);

			// Baseline: three findings.
			const fw1 = await newFramework(db);
			await fw1.run("pii-3", { analyzerIds: ["presidio"] });
			assert.equal((await newestProps(db)).pii_count, 3);

			// Entity-type filter: cards only. Config change → stale/config → revise.
			const fw2 = await newFramework(db, { presidio: { entityTypes: ["CREDIT_CARD"] } });
			await fw2.run("pii-3", { analyzerIds: ["presidio"], revise: ["config"] });
			const filtered = await newestProps(db);
			assert.deepEqual(filtered.piis.map((p) => p.entity_type), ["CREDIT_CARD"]);

			// Allowlist the card by its fingerprint (dropped); force-flag the public
			// IP via the deny list. Email is untouched and stays an ordinary finding.
			const cardFp = fingerprintOf(CARD);
			const ipFp = fingerprintOf(PUBLIC_IP);
			const fw3 = await newFramework(db, {
				presidio: { allowFingerprints: [cardFp], denyFingerprints: [ipFp] },
			});
			await fw3.run("pii-3", { analyzerIds: ["presidio"], revise: ["config"] });
			const final = await newestProps(db);
			assert.deepEqual(final.piis.map((p) => p.entity_type).sort(), ["EMAIL_ADDRESS", "IP_ADDRESS"]);
			const ip = final.piis.find((p) => p.entity_type === "IP_ADDRESS")!;
			assert.equal(ip.denied, true);
			const email = final.piis.find((p) => p.entity_type === "EMAIL_ADDRESS")!;
			assert.equal(email.denied, false);
		} finally {
			await close();
		}
	});
});
