/**
 * Unit tests for the trufflehog detector analyzer: the self-written rule
 * catalogue, config validation, verifier response handling (production
 * verifiers against an injected fake transport — no network), and the
 * verification pass over a scan (mock seam, including error→unknown paths).
 *
 * All synthetic tokens are built by a deterministic PRNG over fixed charsets,
 * so no contiguous realistic credential literal exists in source.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	TRUFFLEHOG_RULES,
	TRUFFLEHOG_RULE_IDS,
	TRUFFLEHOG_CONCEPT,
	detectTrufflehogLeaks,
	verifyFindings,
	DEFAULT_TRUFFLEHOG_CONFIG,
	assertKnownRuleAndVerifierIds,
	fingerprintOf,
} from "../../src/analyze/analyzers/trufflehog/index.js";
import {
	makeProductionVerifiers,
	outcomeForProbe,
	VERIFIER_IDS,
	type FetchLike,
} from "../../src/analyze/analyzers/trufflehog/verifiers.js";
import { createMockVerifier } from "../../src/analyze/analyzers/trufflehog/mock-verifiers.js";

// ──────────────────────────── synthetic tokens ────────────────────────────

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
const TOKEN_CHARS = `${ALNUM}-_`;

// Built by concatenation so no contiguous realistic literal exists in source.
const FIGD = ["figd_", pseudo(36, 11, TOKEN_CHARS)].join("");
const XAI = ["xai-", pseudo(48, 22, ALNUM)].join("");
const R8 = ["r8_", pseudo(40, 33, ALNUM)].join("");
const SBP = ["sbp_", pseudo(44, 44, TOKEN_CHARS)].join("");

// ──────────────────────────── rules ────────────────────────────

describe("trufflehog rules", () => {
	it("carries the licence provenance: concept only, no AGPL material", () => {
		assert.equal(TRUFFLEHOG_CONCEPT.concept, "trufflehog");
		assert.equal(TRUFFLEHOG_CONCEPT.upstreamLicence, "AGPL-3.0");
		assert.equal(TRUFFLEHOG_CONCEPT.materialUsed, "none");
	});

	it("matches each self-written pattern and reports the right rule id", () => {
		const cases: Array<[string, string]> = [
			[FIGD, "figma-pat-figd"],
			[XAI, "xai-api-key"],
			[R8, "replicate-api-token"],
			[SBP, "supabase-management-token"],
		];
		for (const [token, ruleId] of cases) {
			const scan = detectTrufflehogLeaks(
				[{ id: "m1", content_text: `key is ${token} in text` } as never],
				DEFAULT_TRUFFLEHOG_CONFIG,
			);
			assert.equal(scan.leak_count, 1, token.slice(0, 5));
			assert.equal(scan.leaks[0]!.rule_id, ruleId);
			assert.equal(scan.leaks[0]!.fingerprint, fingerprintOf(token));
		}
	});

	it("does not match values below the conservative minimum length", () => {
		const short = ["figd_", pseudo(10, 55, TOKEN_CHARS)].join("");
		const scan = detectTrufflehogLeaks(
			[{ id: "m1", content_text: `short ${short}` } as never],
			DEFAULT_TRUFFLEHOG_CONFIG,
		);
		assert.equal(scan.leak_count, 0);
	});

	it("redacts findings — preview and fingerprint only", () => {
		const scan = detectTrufflehogLeaks(
			[{ id: "m1", content_text: `token ${SBP}` } as never],
			DEFAULT_TRUFFLEHOG_CONFIG,
		);
		const finding = scan.leaks[0]!;
		assert.ok(finding.redacted_preview.includes("…"));
		assert.ok(!finding.redacted_preview.includes(SBP.slice(4, -4)));
		assert.equal(finding.fingerprint.length, 16);
	});
});

// ──────────────────────────── config ────────────────────────────

describe("trufflehog config", () => {
	it("defaults to verification off", () => {
		assert.equal(DEFAULT_TRUFFLEHOG_CONFIG.verify, false);
		assert.deepEqual(DEFAULT_TRUFFLEHOG_CONFIG.enabledVerifiers, []);
	});

	it("rejects unknown rule and verifier ids loudly", () => {
		assert.throws(() =>
			assertKnownRuleAndVerifierIds({ ...DEFAULT_TRUFFLEHOG_CONFIG, disabledRules: ["bogus"] }),
		);
		assert.throws(() =>
			assertKnownRuleAndVerifierIds({ ...DEFAULT_TRUFFLEHOG_CONFIG, enabledVerifiers: ["bogus"] }),
		);
		assert.doesNotThrow(() => assertKnownRuleAndVerifierIds(DEFAULT_TRUFFLEHOG_CONFIG));
		assert.doesNotThrow(() =>
			assertKnownRuleAndVerifierIds({ ...DEFAULT_TRUFFLEHOG_CONFIG, enabledVerifiers: [...VERIFIER_IDS] }),
		);
	});

	it("honours disabledRules", () => {
		const scan = detectTrufflehogLeaks(
			[{ id: "m1", content_text: `token ${SBP}` } as never],
			{ ...DEFAULT_TRUFFLEHOG_CONFIG, disabledRules: ["supabase-management-token"] },
		);
		assert.equal(scan.leak_count, 0);
	});
});

// ──────────────────────────── verifier response handling ────────────────────────────

describe("outcomeForProbe", () => {
	it("maps 200 to verified with a fixed reason", () => {
		assert.deepEqual(outcomeForProbe({ kind: "http", status: 200 }), {
			verified: true,
			reason: "provider-accepted",
		});
	});

	it("maps 401/403 to rejected", () => {
		assert.deepEqual(outcomeForProbe({ kind: "http", status: 401 }), {
			verified: false,
			reason: "provider-rejected",
		});
		assert.deepEqual(outcomeForProbe({ kind: "http", status: 403 }), {
			verified: false,
			reason: "provider-rejected",
		});
	});

	it("maps unexpected statuses to unknown without provider text", () => {
		assert.deepEqual(outcomeForProbe({ kind: "http", status: 503 }), {
			verified: "unknown",
			reason: "http-503",
		});
	});

	it("maps timeout and network errors to unknown", () => {
		assert.deepEqual(outcomeForProbe({ kind: "timeout" }), { verified: "unknown", reason: "timeout" });
		assert.deepEqual(outcomeForProbe({ kind: "network-error" }), {
			verified: "unknown",
			reason: "network-error",
		});
	});
});

describe("production verifiers (injected fake transport — no network)", () => {
	function fakeFetch(status: number): { fetch: FetchLike; seen: Array<{ url: string; headers: Record<string, string> }> } {
		const seen: Array<{ url: string; headers: Record<string, string> }> = [];
		return {
			seen,
			fetch: async (url, init) => {
				seen.push({ url, headers: init.headers });
				return { status };
			},
		};
	}

	it("github verifier probes api.github.com/user with the bearer token only", async () => {
		const { fetch, seen } = fakeFetch(200);
		const [github] = makeProductionVerifiers(fetch);
		const outcome = await github!.verify(`ghp_${pseudo(36, 7, ALNUM)}`, 1000);
		assert.equal(outcome.verified, true);
		assert.equal(seen.length, 1);
		assert.equal(seen[0]!.url, "https://api.github.com/user");
		assert.match(seen[0]!.headers["Authorization"]!, /^Bearer ghp_/);
	});

	it("openai verifier probes the models list", async () => {
		const { fetch, seen } = fakeFetch(401);
		const [, openai] = makeProductionVerifiers(fetch);
		const outcome = await openai!.verify(["sk-", pseudo(30, 8, ALNUM)].join(""), 1000);
		assert.equal(outcome.verified, false);
		assert.equal(seen[0]!.url, "https://api.openai.com/v1/models");
	});

	it("figma verifier probes api.figma.com/v1/me with the X-Figma-Token header", async () => {
		const { fetch, seen } = fakeFetch(200);
		const [, , figma] = makeProductionVerifiers(fetch);
		const outcome = await figma!.verify(FIGD, 1000);
		assert.equal(outcome.verified, true);
		assert.equal(seen[0]!.url, "https://api.figma.com/v1/me");
		assert.equal(seen[0]!.headers["X-Figma-Token"], FIGD);
	});

	it("a thrown transport error becomes unknown, never a crash", async () => {
		const failing: FetchLike = async () => {
			throw new Error("ECONNREFUSED");
		};
		const [github] = makeProductionVerifiers(failing);
		const outcome = await github!.verify(`ghp_${pseudo(36, 9, ALNUM)}`, 1000);
		assert.deepEqual(outcome, { verified: "unknown", reason: "network-error" });
	});

	it("an abort named TimeoutError becomes unknown/timeout", async () => {
		const timingOut: FetchLike = async () => {
			const err = new Error("The operation was aborted due to timeout");
			err.name = "TimeoutError";
			throw err;
		};
		const [github] = makeProductionVerifiers(timingOut);
		const outcome = await github!.verify(`ghp_${pseudo(36, 10, ALNUM)}`, 5);
		assert.deepEqual(outcome, { verified: "unknown", reason: "timeout" });
	});

	it("each verifier claims exactly its provider's prefix shape", () => {
		const verifiers = makeProductionVerifiers(fakeFetch(200).fetch);
		const ghToken = `ghp_${pseudo(36, 12, ALNUM)}`;
		const oaiKey = ["sk-", pseudo(30, 13, ALNUM)].join("");
		for (const v of verifiers) {
			const re = new RegExp(v.appliesTo, "u");
			if (v.id === "github-token") assert.ok(re.test(ghToken));
			if (v.id === "openai-key") assert.ok(re.test(oaiKey));
			if (v.id === "figma-token") assert.ok(re.test(FIGD));
			// …and never claims another provider's shape.
			if (v.id !== "figma-token") assert.ok(!re.test(FIGD));
			if (v.id !== "github-token") assert.ok(!re.test(ghToken));
		}
	});
});

// ──────────────────────────── verification pass (mock seam) ────────────────────────────

function sessionWith(text: string): never[] {
	return [{ id: "m1", content_text: text }] as never[];
}

describe("verifyFindings (mock seam)", () => {
	it("attaches outcomes to matching findings and tallies them", async () => {
		const mock = createMockVerifier({
			id: "figma-token",
			appliesTo: "^figd_",
			outcomes: { [FIGD]: { verified: true, reason: "mock-live" } },
		});
		const scan = detectTrufflehogLeaks(sessionWith(`figma key ${FIGD}`), DEFAULT_TRUFFLEHOG_CONFIG);
		const { findings, summary } = await verifyFindings(
			sessionWith(`figma key ${FIGD}`),
			scan,
			DEFAULT_TRUFFLEHOG_CONFIG,
			[mock],
		);
		assert.equal(findings[0]!.verification!.verified, true);
		assert.equal(summary.verified_true, 1);
		assert.equal(summary.probes_issued, 1);
		assert.equal(mock.calls.length, 1);
		assert.equal(mock.calls[0]!.value, FIGD);
	});

	it("shares one probe across repeated leaks of the same credential", async () => {
		const mock = createMockVerifier({
			appliesTo: "^figd_",
			outcomes: { [FIGD]: { verified: false, reason: "mock-dead" } },
		});
		const messages = sessionWith(`first ${FIGD} then again ${FIGD}`);
		const scan = detectTrufflehogLeaks(messages, DEFAULT_TRUFFLEHOG_CONFIG);
		assert.equal(scan.leak_count, 2);
		const { summary } = await verifyFindings(messages, scan, DEFAULT_TRUFFLEHOG_CONFIG, [mock]);
		assert.equal(summary.probes_issued, 1);
		assert.equal(summary.verified_false, 2);
		assert.equal(mock.calls.length, 1);
	});

	it("counts shape-unclaimed findings as unverified", async () => {
		const mock = createMockVerifier({ appliesTo: "^nomatch", fallback: { verified: true, reason: "x" } });
		const messages = sessionWith(`key ${SBP}`);
		const scan = detectTrufflehogLeaks(messages, DEFAULT_TRUFFLEHOG_CONFIG);
		const { findings, summary } = await verifyFindings(messages, scan, DEFAULT_TRUFFLEHOG_CONFIG, [mock]);
		assert.equal(findings[0]!.verification, undefined);
		assert.equal(summary.unverified, 1);
		assert.equal(mock.calls.length, 0);
	});

	it("enabledVerifiers restricts which verifiers run", async () => {
		const figmaMock = createMockVerifier({
			id: "figma-token",
			appliesTo: "^figd_",
			outcomes: { [FIGD]: { verified: true, reason: "live" } },
		});
		const messages = sessionWith(`key ${FIGD}`);
		const scan = detectTrufflehogLeaks(messages, DEFAULT_TRUFFLEHOG_CONFIG);
		const restricted = { ...DEFAULT_TRUFFLEHOG_CONFIG, enabledVerifiers: ["github-token"] };
		const { findings, summary } = await verifyFindings(messages, scan, restricted, [figmaMock]);
		assert.equal(findings[0]!.verification, undefined);
		assert.equal(summary.unverified, 1);
		assert.equal(figmaMock.calls.length, 0);
	});

	it("an unknown verdict from the verifier lands as verified_unknown", async () => {
		const mock = createMockVerifier({
			appliesTo: "^figd_",
			outcomes: { [FIGD]: { verified: "unknown", reason: "network-error" } },
		});
		const messages = sessionWith(`key ${FIGD}`);
		const scan = detectTrufflehogLeaks(messages, DEFAULT_TRUFFLEHOG_CONFIG);
		const { summary } = await verifyFindings(messages, scan, DEFAULT_TRUFFLEHOG_CONFIG, [mock]);
		assert.equal(summary.verified_unknown, 1);
	});

	it("never returns raw values through the findings", async () => {
		const mock = createMockVerifier({
			appliesTo: "^figd_",
			outcomes: { [FIGD]: { verified: true, reason: "live" } },
		});
		const messages = sessionWith(`key ${FIGD}`);
		const scan = detectTrufflehogLeaks(messages, DEFAULT_TRUFFLEHOG_CONFIG);
		const { findings } = await verifyFindings(messages, scan, DEFAULT_TRUFFLEHOG_CONFIG, [mock]);
		assert.ok(!JSON.stringify(findings).includes(FIGD.slice(6, -6)));
	});
});

describe("trufflehog catalogue sanity", () => {
	it("rule ids are unique and every pattern carries the global flag", () => {
		assert.equal(new Set(TRUFFLEHOG_RULE_IDS).size, TRUFFLEHOG_RULES.length);
		for (const rule of TRUFFLEHOG_RULES) {
			assert.ok(rule.pattern.flags.includes("g"), rule.id);
		}
	});
});
