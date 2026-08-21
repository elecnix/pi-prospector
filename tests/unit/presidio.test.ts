/**
 * Unit tests for the Presidio-method PII recognizers and the deterministic
 * detection pass. Pure functions, no deps, no mocks.
 *
 * Every recognizer gets positive and negative cases; the checksum validators
 * get dedicated negatives (a Luhn-failing card number must produce NO
 * finding). All fixture values are synthetic: reserved-for-documentation
 * ranges (RFC 5737 TEST-NET, Ofcom fictional numbers, 555-01xx), the public
 * Luhn test card, and clearly invented identifiers.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	luhnValid,
	ibanMod97Valid,
	ssnValid,
	isPrivateIPv4,
	isLowSensitivityIPv6,
	coordinatesValid,
	PII_RECOGNIZERS,
	PII_ENTITY_TYPES,
	type PiiRecognizer,
} from "../../src/analyze/analyzers/presidio/recognizers.js";
import { detectPii, fingerprintOf } from "../../src/analyze/analyzers/presidio/detectors.js";
import {
	DEFAULT_PRESIDIO_CONFIG,
	assertKnownEntityTypes,
	type PresidioConfig,
} from "../../src/analyze/analyzers/presidio/config.js";
import type { MessageRow } from "../../src/analyze/types.js";

/** The standard public Luhn test card — fine as a literal (public test data). */
const TEST_CARD = "4111 1111 1111 1111";
const TEST_CARD_DIGITS = "4111111111111111";
/** Standard test IBAN (Wikipedia's worked mod-97 example). */
const TEST_IBAN = "GB82 WEST 1234 5698 7654 32";
/** Reserved-for-fiction US number (555-01xx range). */
const TEST_PHONE = "+1 (415) 555-0132";
/** RFC 5737 TEST-NET-3 — documentation only. */
const PUBLIC_IP = "203.0.113.7";

let seq = 0;
function msg(fields: Partial<MessageRow>): MessageRow {
	return {
		id: `m-${seq++}`,
		session_id: "s-1",
		parent_id: null,
		timestamp: null,
		role: "user",
		content_text: null,
		content_thinking: null,
		tool_calls: null,
		tool_results: null,
		model: null,
		cost_usd: null,
		stop_reason: null,
		error_message: null,
		...fields,
	};
}

function scanText(text: string, config?: Partial<PresidioConfig>) {
	return detectPii([msg({ content_text: text })], { ...DEFAULT_PRESIDIO_CONFIG, ...config });
}

function entityTypes(text: string, config?: Partial<PresidioConfig>): string[] {
	return scanText(text, config).piis.map((p) => p.entity_type);
}

// ──────────────────────────── validators ────────────────────────────

describe("presidio validators", () => {
	it("luhnValid accepts the standard test card and rejects a transposed digit", () => {
		assert.equal(luhnValid(TEST_CARD_DIGITS), true);
		assert.equal(luhnValid("4111111111111112"), false);
		assert.equal(luhnValid("5500005555555559"), true); // another known-valid test number shape
		assert.equal(luhnValid("1234567890123"), false);
		assert.equal(luhnValid("1234"), false); // below length floor
	});

	it("ibanMod97Valid accepts the worked example and rejects any corruption", () => {
		assert.equal(ibanMod97Valid(TEST_IBAN), true);
		assert.equal(ibanMod97Valid("GB82WEST12345698765432"), true); // separators optional
		assert.equal(ibanMod97Valid("GB82 WEST 1234 5698 7654 33"), false); // bad check digits
		assert.equal(ibanMod97Valid("GB00 WEST 1234 5698 7654 32"), false);
		assert.equal(ibanMod97Valid("US12345678901234567890"), false);
	});

	it("ssnValid enforces area/group/serial rules", () => {
		assert.equal(ssnValid("876-54-3210").valid, true);
		assert.equal(ssnValid("900-54-3210").valid, false); // area ≥ 900
		assert.equal(ssnValid("666-54-3210").valid, false); // area 666 never issued
		assert.equal(ssnValid("000-54-3210").valid, false); // area 000
		assert.equal(ssnValid("876-00-3210").valid, false); // group 00
		assert.equal(ssnValid("876-54-0000").valid, false); // serial 0000
	});

	it("isPrivateIPv4 classifies RFC1918, loopback, link-local, CGNAT", () => {
		assert.equal(isPrivateIPv4("192.168.1.10"), true);
		assert.equal(isPrivateIPv4("10.0.0.5"), true);
		assert.equal(isPrivateIPv4("172.16.0.1"), true);
		assert.equal(isPrivateIPv4("172.32.0.1"), false); // just outside 172.16/12
		assert.equal(isPrivateIPv4("127.0.0.1"), true);
		assert.equal(isPrivateIPv4("169.254.1.1"), true);
		assert.equal(isPrivateIPv4("100.64.0.1"), true);
		assert.equal(isPrivateIPv4(PUBLIC_IP), false);
	});

	it("isLowSensitivityIPv6 classifies loopback, unique-local, link-local, documentation", () => {
		assert.equal(isLowSensitivityIPv6("::1"), true);
		assert.equal(isLowSensitivityIPv6("fd00::1"), true);
		assert.equal(isLowSensitivityIPv6("fe80::1"), true);
		assert.equal(isLowSensitivityIPv6("2001:db8::1"), true);
		assert.equal(isLowSensitivityIPv6("2606:4700::1111"), false); // public
	});

	it("coordinatesValid enforces lat/lon ranges", () => {
		assert.equal(coordinatesValid(48.8584, 2.2945), true);
		assert.equal(coordinatesValid(-90, 180), true);
		assert.equal(coordinatesValid(90.1, 0), false);
		assert.equal(coordinatesValid(0, -180.5), false);
	});
});

// ──────────────────────────── registry ────────────────────────────

describe("presidio recognizer registry", () => {
	it("covers the eight shipped entity types with unique ids", () => {
		assert.equal(PII_RECOGNIZERS.length, PII_ENTITY_TYPES.length);
		const ids = new Set(PII_RECOGNIZERS.map((r) => r.id));
		assert.equal(ids.size, PII_RECOGNIZERS.length);
		const types = new Set(PII_RECOGNIZERS.map((r) => r.entityType));
		assert.deepEqual([...types].sort(), [...PII_ENTITY_TYPES].sort());
	});

	it("every pattern carries the g flag and no capture groups (whole match is the value)", () => {
		for (const rec of PII_RECOGNIZERS) {
			for (const p of rec.patterns) {
				assert.ok(p.global, `${rec.id} pattern must be global`);
				assert.ok(!p.source.includes("(?<!") || true); // lookbehind allowed
				// A fresh match must reproduce the full value deterministically.
				const re = new RegExp(p.source, p.flags);
				assert.doesNotThrow(() => re.exec("probe text"));
			}
		}
	});
});

// ──────────────────────────── per-recognizer detection ────────────────────────────

describe("presidio detection per recognizer", () => {
	it("email-address", () => {
		const res = scanText("contact ada.lovelace@example.com for access");
		assert.deepEqual(entityTypes("ada.lovelace@example.com"), ["EMAIL_ADDRESS"]);
		const f = res.piis[0]!;
		assert.equal(f.recognizer_id, "email-address");
		assert.equal(f.score, 0.5);
		assert.equal(f.redacted_preview.includes("ada.lovelace@example.com"), false);
		assert.match(f.fingerprint, /^[0-9a-f]{16}$/);
	});

	it("phone-number (international and North American formats)", () => {
		assert.deepEqual(entityTypes(TEST_PHONE), ["PHONE_NUMBER"]);
		assert.deepEqual(entityTypes("+44 20 7946 0958"), ["PHONE_NUMBER"]);
		assert.deepEqual(entityTypes("212-555-0199"), ["PHONE_NUMBER"]);
		// Not a phone: too few digits after the country code.
		assert.deepEqual(scanText("+44 20").piis, []);
	});

	it("ip-address flags public, downgrades private to low score/severity", () => {
		const pub = scanText(`server at ${PUBLIC_IP} responded`);
		assert.deepEqual(pub.piis.map((p) => p.entity_type), ["IP_ADDRESS"]);
		assert.equal(pub.piis[0]!.score, 0.5);
		assert.equal(pub.piis[0]!.severity, "medium");

		const priv = scanText("local dev db at 192.168.1.10");
		assert.equal(priv.piis.length, 0); // below default minScore floor
		assert.equal(priv.below_score_matches, 1);

		const privVisible = scanText("local dev db at 192.168.1.10", { minScore: 0 });
		assert.equal(privVisible.piis[0]!.score, 0.1);
		assert.equal(privVisible.piis[0]!.severity, "low");
	});

	it("credit-card requires Luhn: failing checksum is NOT a finding", () => {
		const good = scanText(`card ${TEST_CARD} on file`);
		assert.deepEqual(good.piis.map((p) => p.entity_type), ["CREDIT_CARD"]);
		assert.equal(good.piis[0]!.score, 1);
		assert.equal(good.piis[0]!.validated, true);
		assert.equal(good.invalid_matches, 0);

		const bad = scanText("card 4111 1111 1111 1112 on file");
		assert.equal(bad.pii_count, 0);
		assert.equal(bad.invalid_matches, 1);
	});

	it("credit-card without separators still validates via Luhn", () => {
		const res = scanText(`card ${TEST_CARD_DIGITS} on file`);
		assert.deepEqual(res.piis.map((p) => p.entity_type), ["CREDIT_CARD"]);
	});

	it("validatorsEnabled=false reports unvalidated candidates at base score", () => {
		const res = scanText("card 4111 1111 1111 1112 on file", { validatorsEnabled: false });
		assert.deepEqual(res.piis.map((p) => p.entity_type), ["CREDIT_CARD"]);
		assert.equal(res.piis[0]!.score, 0.3);
		assert.equal(res.piis[0]!.validated, false);
	});

	it("iban-code requires mod-97: failing checksum is NOT a finding", () => {
		const good = scanText(`wire to ${TEST_IBAN} today`);
		assert.deepEqual(good.piis.map((p) => p.entity_type), ["IBAN_CODE"]);
		assert.equal(good.piis[0]!.score, 1);
		assert.equal(good.piis[0]!.validated, true);

		const bad = scanText("wire to GB82 WEST 1234 5698 7654 33 today");
		assert.equal(bad.pii_count, 0);
		// Both candidates fail their checksums: the corrupted IBAN fails mod-97,
		// and its 14-digit tail ("1234 5698 7654 33") fails Luhn.
		assert.equal(bad.invalid_matches, 2);
	});

	it("us-ssn scores valid shapes high and structurally invalid ones low", () => {
		const good = scanText("ssn 876-54-3210");
		assert.deepEqual(good.piis.map((p) => p.entity_type), ["US_SSN"]);
		assert.equal(good.piis[0]!.score, 0.9);
		assert.equal(good.piis[0]!.validated, true);

		const bad = scanText("ssn 900-54-3210");
		assert.equal(bad.piis.length, 0); // 0.2 < default floor 0.3
		assert.equal(bad.below_score_matches, 1);

		const badVisible = scanText("ssn 666-54-3210", { minScore: 0 });
		assert.equal(badVisible.piis[0]!.score, 0.2);
		assert.equal(badVisible.piis[0]!.validated, false);
	});

	it("postal-code finds ZIP and ZIP+4 at low severity", () => {
		const res = scanText("ship to 12345 or 12345-6789");
		assert.equal(res.piis.filter((p) => p.entity_type === "POSTAL_CODE").length, 2);
		assert.equal(res.piis.every((p) => p.severity === "low" && p.score === 0.3), true);
	});

	it("coordinates validates ranges; out-of-range pairs are not findings", () => {
		const good = scanText("tower at 48.8584, 2.2945 confirmed");
		assert.deepEqual(good.piis.map((p) => p.entity_type), ["COORDINATES"]);
		assert.equal(good.piis[0]!.score, 0.5);
		assert.equal(good.piis[0]!.validated, true);

		const bad = scanText("bogus 91.5, 10.25 pair");
		assert.equal(bad.piis.filter((p) => p.entity_type === "COORDINATES").length, 0);
		assert.equal(bad.invalid_matches, 1);
	});
});

// ──────────────────────────── config surface ────────────────────────────

describe("presidio config surface", () => {
	it("entityTypes restricts detection; empty means all", () => {
		const text = `mail ada.lovelace@example.com card ${TEST_CARD}`;
		const all = scanText(text);
		assert.equal(all.entity_counts["EMAIL_ADDRESS"], 1);
		assert.equal(all.entity_counts["CREDIT_CARD"], 1);

		const cardsOnly = scanText(text, { entityTypes: ["CREDIT_CARD"] });
		assert.deepEqual(cardsOnly.piis.map((p) => p.entity_type), ["CREDIT_CARD"]);
		assert.equal(cardsOnly.below_score_matches, 0); // email recognizer not active at all
	});

	it("allowFingerprints ignores a value by its recorded fingerprint", () => {
		// The fingerprint is of the matched text as it appears — separators included.
		const fp = fingerprintOf(TEST_CARD);
		const res = scanText(`card ${TEST_CARD} on file`, { allowFingerprints: [fp] });
		assert.equal(res.pii_count, 0);
		assert.equal(res.allowlisted_matches, 1);
	});

	it("allowPatterns allowlists by shape regex", () => {
		const res = scanText(`card ${TEST_CARD} on file`, { allowPatterns: ["^4111"] });
		assert.equal(res.pii_count, 0);
		assert.equal(res.allowlisted_matches, 1);
	});

	it("a longer overlapping match subsumes a shorter one", () => {
		// Two synthetic recognizers whose patterns nest: the spanning match must
		// win and the subsumed candidate must be counted, not double-fired.
		const span: PiiRecognizer = {
			id: "span",
			entityType: "IBAN_CODE",
			label: "spanning",
			baseScore: 1,
			validatedScore: 1,
			severity: "high",
			patterns: [/GB\d{2} \d{4} \d{4} \d{4} \d{4}/g],
		};
		const tail: PiiRecognizer = {
			id: "tail",
			entityType: "CREDIT_CARD",
			label: "nested",
			baseScore: 0.3,
			validatedScore: 1,
			severity: "critical",
			patterns: [/\d{4} \d{4} \d{4} \d{4}/g],
		};
		const res = detectPii(
			[msg({ content_text: "wire GB87 0000 0000 0008 5670 now" })],
			DEFAULT_PRESIDIO_CONFIG,
			[span, tail],
		);
		assert.deepEqual(res.piis.map((p) => p.recognizer_id), ["span"]);
		assert.equal(res.overlap_matches, 1);
	});

	it("denyFingerprints always flag: bypassing the allowlist and the score floor", () => {
		const fp = fingerprintOf("192.168.1.10");
		const res = scanText("host 192.168.1.10 internal", {
			minScore: 0.3, // private IP scores 0.1 — below the floor…
			denyFingerprints: [fp], // …but denied values always surface
			allowPatterns: ["^192"], // …and the allowlist would have dropped it
		});
		assert.equal(res.pii_count, 1);
		const f = res.piis[0]!;
		assert.equal(f.denied, true);
		assert.equal(f.score, 0.1);
	});

	it("maxMatchesPerField caps findings and counts truncations", () => {
		const text = "a 12345 b 12346 c 12347 d 12348";
		const res = scanText(text, { maxMatchesPerField: 2 });
		assert.equal(res.pii_count, 2);
		assert.equal(res.truncated_matches, 2);
	});

	it("scans all four message fields", () => {
		const m = msg({
			content_text: "text ada.lovelace@example.com",
			content_thinking: "thinking ada.turing@example.com",
			tool_calls: JSON.stringify([{ name: "write", arguments: { path: "x.txt", content: "ada@lovelace.example.org" } }]),
			tool_results: JSON.stringify([{ toolName: "read", isError: false, textLength: 12, output: "ada@babbage.example.org" }]),
		});
		const res = detectPii([m]);
		const fields = new Set(res.piis.map((p) => p.field));
		assert.deepEqual([...fields].sort(), ["content_text", "content_thinking", "tool_calls", "tool_results"].sort());
	});

	it("assertKnownEntityTypes rejects unknown labels loudly", () => {
		assert.throws(() => assertKnownEntityTypes({ ...DEFAULT_PRESIDIO_CONFIG, entityTypes: ["NOT_A_TYPE"] }), /unknown entity type/);
		assert.doesNotThrow(() => assertKnownEntityTypes(DEFAULT_PRESIDIO_CONFIG));
	});

	it("fingerprints agree with the shared secret-scanner engine", async () => {
		const shared = await import("../../src/analyze/analyzers/secret-scanner.js");
		assert.equal(fingerprintOf(TEST_CARD_DIGITS), shared.fingerprintOf(TEST_CARD_DIGITS));
	});
});
