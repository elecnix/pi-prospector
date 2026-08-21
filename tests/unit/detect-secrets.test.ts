/**
 * Unit tests for the detect-secrets detector: generators, exclusion filters,
 * and the generator→filter→findings pipeline.
 *
 * All fixtures are hand-written synthetic values — no real credentials. The
 * "secrets" below are shape-correct but revoked/never-live tokens built by a
 * deterministic PRNG (mulberry32) over fixed charsets, so no contiguous
 * realistic literal exists in source (GitHub push protection would rightly
 * block one) and every fixture is reproducible.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	DETECT_SECRETS_GENERATORS,
	DETECT_SECRETS_UPSTREAM,
	DETECT_SECRETS_PLUGINS,
	PLUGIN_RULE_IDS,
	calculateShannonEntropy,
	calculateHexShannonEntropy,
	detectDetectSecretsLeaks,
	matchedDetectSecretsRuleIds,
	fingerprintOf,
	redact,
	isTemplatedSecret,
	isPrefixedWithDollarSign,
	isNotAlphanumericString,
	isSequentialString,
	isPotentialUuid,
	isLowEntropy,
	isPlaceholderValue,
	isLikelyIdString,
	isIndirectReference,
	isDocumentationUrlContext,
	isInsideCodeSampleContext,
} from "../../src/analyze/analyzers/detect-secrets/detectors.js";
import {
	DEFAULT_DETECT_SECRETS_CONFIG,
	assertKnownPluginAndFilterIds,
} from "../../src/analyze/analyzers/detect-secrets/config.js";
import { EXCLUSION_FILTER_IDS } from "../../src/analyze/analyzers/detect-secrets/filters.js";
import { detectSecretLeaks } from "../../src/analyze/analyzers/secret-leak/detectors.js";
import { detectGitleaksLeaks } from "../../src/analyze/analyzers/gitleaks/detectors.js";
import { detectNoseyParkerLeaks } from "../../src/analyze/analyzers/nosey-parker/detectors.js";
import type { MessageRow } from "../../src/analyze/types.js";

// ──────────────────────────── helpers ────────────────────────────

/** Deterministic PRNG (mulberry32) so fixtures are reproducible. */
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

const BASE64_CHARSET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/-_";
const HEX_CHARSET = "0123456789abcdef";
const LOWER_CHARSET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** High-entropy synthetic credentials (verified > upstream thresholds). */
const RANDOM_B64 = pseudo(48, 42, BASE64_CHARSET); // entropy ≈ 4.97
const RANDOM_B64_ALT = pseudo(48, 123, BASE64_CHARSET); // entropy ≈ 5.05
const RANDOM_HEX = pseudo(40, 1042, HEX_CHARSET); // entropy ≈ 3.7
const NPM_TOKEN = `npm_${pseudo(36, 42, LOWER_CHARSET)}`;

let seq = 0;
function msg(partial: Partial<MessageRow> & { id?: string }): MessageRow {
	const id = partial.id ?? `m-${seq++}`;
	return {
		id,
		session_id: partial.session_id ?? "s1",
		parent_id: partial.parent_id ?? null,
		timestamp: partial.timestamp ?? null,
		role: partial.role ?? "user",
		content_text: partial.content_text ?? null,
		content_thinking: partial.content_thinking ?? null,
		tool_calls: partial.tool_calls ?? null,
		tool_results: partial.tool_results ?? null,
		model: partial.model ?? null,
		cost_usd: partial.cost_usd ?? null,
		stop_reason: partial.stop_reason ?? null,
		error_message: partial.error_message ?? null,
	};
}

function ctxFor(value: string, line = `password = ${value}`, text?: string, index?: number) {
	return {
		value,
		line,
		text: text ?? line,
		index: index ?? Math.max(0, line.indexOf(value)),
		ruleId: "base64-high-entropy-string",
	};
}

// ──────────────────────────── provenance ────────────────────────────

describe("DETECT_SECRETS_UPSTREAM", () => {
	it("records the upstream licence and version", () => {
		assert.equal(DETECT_SECRETS_UPSTREAM.licence, "BSD-3-Clause");
		assert.equal(DETECT_SECRETS_UPSTREAM.project, "detect-secrets");
		assert.match(DETECT_SECRETS_UPSTREAM.version, /^v\d+\.\d+\.\d+$/);
		assert.ok(DETECT_SECRETS_UPSTREAM.source.startsWith("https://github.com/Yelp/detect-secrets"));
	});
});

// ──────────────────────────── shannon entropy ────────────────────────────

describe("shannon entropy", () => {
	it("repeated characters have ~zero entropy", () => {
		assert.ok(calculateShannonEntropy("aaaaaaaaaaaaaaaaaaaa") < 0.01);
	});

	it("uniform two-symbol strings have ~1 bit per char", () => {
		assert.ok(Math.abs(calculateShannonEntropy("ababababab") - 1) < 0.01);
	});

	it("random-looking base64 clears the upstream 4.5 limit", () => {
		assert.ok(calculateShannonEntropy(RANDOM_B64) > 4.5);
		assert.ok(calculateShannonEntropy(RANDOM_B64_ALT) > 4.5);
	});

	it("hex entropy applies the all-digits penalty (upstream HexHighEntropyString)", () => {
		// "0123456789" repeated: raw entropy ≈ 3.32, penalty pulls it below 3.
		const digits = "0123456789";
		const raw = calculateShannonEntropy(digits, "0123456789abcdefABCDEF");
		const penalised = calculateHexShannonEntropy(digits);
		assert.ok(Math.abs(raw - 3.32) < 0.05);
		assert.ok(penalised < 3.0, `penalised digits entropy should fall below 3.0, got ${penalised}`);
		assert.ok(calculateHexShannonEntropy(RANDOM_HEX) > 3.0);
	});
});

// ──────────────────────────── generators ────────────────────────────

describe("DETECT_SECRETS_GENERATORS", () => {
	it("every pattern is global (matchAll requires it)", () => {
		for (const r of DETECT_SECRETS_GENERATORS) {
			assert.ok(r.pattern.global, `generator ${r.id} must have the g flag`);
		}
	});

	it("every generator has a unique id, a known severity, and a known confidence", () => {
		const ids = new Set<string>();
		for (const r of DETECT_SECRETS_GENERATORS) {
			assert.ok(!ids.has(r.id), `duplicate generator id ${r.id}`);
			ids.add(r.id);
			assert.ok(["medium", "high", "critical"].includes(r.severity));
			assert.ok(r.confidence === undefined || ["passive", "active"].includes(r.confidence));
		}
	});

	it("covers the three ported plugins, each mapping to existing rules", () => {
		assert.deepEqual([...DETECT_SECRETS_PLUGINS].sort(), [
			"base64-high-entropy",
			"hex-high-entropy",
			"keyword-context",
		]);
		const ruleIds = new Set(DETECT_SECRETS_GENERATORS.map((r) => r.id));
		for (const [plugin, rules] of Object.entries(PLUGIN_RULE_IDS)) {
			assert.ok(rules.length > 0, `plugin ${plugin} must map to at least one rule`);
			for (const id of rules) assert.ok(ruleIds.has(id), `plugin ${plugin} references unknown rule ${id}`);
		}
	});

	it("every generator has exactly one capturing group (the secret)", () => {
		for (const r of DETECT_SECRETS_GENERATORS) {
			const source = r.pattern.source.replace(/\\./g, "..").replace(/\[[^\]]*\]/g, "[]");
			const opens = (source.match(/\(/g) ?? []).length;
			const nonCapturing = (source.match(/\(\?[:=]/g) ?? []).length;
			assert.ok(opens - nonCapturing === 1, `generator ${r.id} must have exactly one capturing group`);
		}
	});

	it("keyword-assignment captures the value, not the keyword or operator", () => {
		const line = `my_password_secure = "${RANDOM_B64}"`;
		const rule = DETECT_SECRETS_GENERATORS.find((r) => r.id === "keyword-assignment")!;
		const m = new RegExp(rule.pattern.source, rule.pattern.flags).exec(line)!;
		assert.ok(m);
		assert.equal(m[1], RANDOM_B64);
	});

	it("keyword denylist covers the task-named keywords and upstream entries", () => {
		for (const kw of ["api_key", "apiKey", "password", "passwd", "pwd", "secret", "token", "private_key"]) {
			const line = `${kw} = "${RANDOM_B64}"`;
			assert.ok(
				matchedDetectSecretsRuleIds(line).includes("keyword-assignment"),
				`keyword ${kw} should trigger keyword-assignment`,
			);
		}
	});

	it("matches reverse comparisons ('value' == my_password)", () => {
		const line = `"${RANDOM_B64}" == admin_password`;
		assert.ok(matchedDetectSecretsRuleIds(line).includes("keyword-reverse-comparison"));
	});
});

// ──────────────────────────── exclusion filters ────────────────────────────

describe("exclusion filters (individually testable pure functions)", () => {
	describe("isTemplatedSecret", () => {
		it("rejects template placeholders", () => {
			for (const v of ["{secret}", "<your-token>", "${API_KEY}", "{x}"]) {
				assert.ok(isTemplatedSecret(v), `${v} is a template placeholder`);
			}
		});
		it("rejects one-character values outright (upstream IndexError behaviour)", () => {
			assert.ok(isTemplatedSecret("x"));
		});
		it("accepts real-looking secrets", () => {
			assert.ok(!isTemplatedSecret(RANDOM_B64));
		});
	});

	describe("isPrefixedWithDollarSign", () => {
		it("rejects variable references", () => {
			assert.ok(isPrefixedWithDollarSign("$SECRET_VALUE"));
		});
		it("accepts literals", () => {
			assert.ok(!isPrefixedWithDollarSign(RANDOM_B64));
		});
	});

	describe("isNotAlphanumericString", () => {
		it("rejects letterless values", () => {
			assert.ok(isNotAlphanumericString("1234567890"));
			assert.ok(isNotAlphanumericString("********"));
		});
		it("accepts values containing letters", () => {
			assert.ok(!isNotAlphanumericString(RANDOM_HEX));
		});
	});

	describe("isSequentialString", () => {
		it("rejects sequential runs", () => {
			for (const v of ["0123456789abcdef", "ABCDEFGHIJ", "abcdefghijklmnopqrstuvwxyz"]) {
				assert.ok(isSequentialString(v), `${v} is sequential`);
			}
			// Upstream's sequence tables contain no repeated character, so a
			// single-char run is not "sequential" — the placeholder filter (or the
			// entropy gate) catches those instead.
			assert.ok(!isSequentialString("00000000000"));
		});
		it("accepts random-looking values", () => {
			assert.ok(!isSequentialString(RANDOM_B64));
			assert.ok(!isSequentialString(RANDOM_HEX));
		});
	});

	describe("isLowEntropy", () => {
		it("rejects base64 candidates below the 4.5 limit", () => {
			assert.ok(isLowEntropy(ctxFor("a".repeat(48)), {}));
		});
		it("rejects hex candidates below the 3.0 limit including the digits penalty", () => {
			assert.ok(
				isLowEntropy({ ...ctxFor("0123456789"), ruleId: "hex-high-entropy-string" }, {}),
			);
		});
		it("accepts high-entropy candidates", () => {
			assert.ok(!isLowEntropy(ctxFor(RANDOM_B64), {}));
			assert.ok(!isLowEntropy({ ...ctxFor(RANDOM_HEX), ruleId: "hex-high-entropy-string" }, {}));
		});
		it("never gates keyword-context candidates", () => {
			assert.ok(!isLowEntropy({ ...ctxFor("a".repeat(48)), ruleId: "keyword-assignment" }, {}));
		});
		it("honours an entropyThreshold override", () => {
			// RANDOM_B64 (~4.97) passes at 4.5 but fails at 5.5.
			assert.ok(!isLowEntropy(ctxFor(RANDOM_B64), { entropyThreshold: 4.5 }));
			assert.ok(isLowEntropy(ctxFor(RANDOM_B64), { entropyThreshold: 5.5 }));
		});
	});

	describe("isPotentialUuid", () => {
		it("rejects UUID-shaped values", () => {
			assert.ok(isPotentialUuid("01234567-89ab-cdef-0123-456789abcdef"));
		});
		it("accepts non-UUIDs", () => {
			assert.ok(!isPotentialUuid(RANDOM_B64));
		});
	});

	describe("isPlaceholderValue", () => {
		it("rejects placeholder values", () => {
			for (const v of [
				"xxxxxxxxxxxxxxxx",
				"YOUR_API_KEY_HERE",
				"your_token_value",
				"example-key-123456",
				"test1234567890abcdef",
				"changeme-now",
				"CHANGEME",
				"sample_api_key_value",
				"dummy-password-123",
				"****",
				"aaaaaaaaaaaaaaaa", // one repeated character (port extension)
			]) {
				assert.ok(isPlaceholderValue(v), `${v} is a placeholder`);
			}
			// "<REDACTED>" is excluded by the templated-secret filter instead.
		});
		it("accepts real-looking secrets", () => {
			assert.ok(!isPlaceholderValue(RANDOM_B64));
			assert.ok(!isPlaceholderValue(NPM_TOKEN));
		});
	});

	describe("isLikelyIdString", () => {
		it("rejects values assigned to id-like variables", () => {
			const line = `user_id = "${RANDOM_B64}"`;
			assert.ok(isLikelyIdString({ ...ctxFor(RANDOM_B64, line), ruleId: "keyword-assignment" }));
		});
		it("accepts values assigned to credential variables", () => {
			const line = `password = "${RANDOM_B64}"`;
			assert.ok(!isLikelyIdString({ ...ctxFor(RANDOM_B64, line), ruleId: "keyword-assignment" }));
		});
	});

	describe("isIndirectReference", () => {
		it("rejects indirect references (value read from elsewhere)", () => {
			assert.ok(isIndirectReference(`secret = get_secret_key()`));
			assert.ok(isIndirectReference(`apikey = request.headers['apikey']`));
		});
		it("accepts literal assignments", () => {
			assert.ok(!isIndirectReference(`password = "${RANDOM_B64}"`));
		});
	});

	describe("isDocumentationUrlContext", () => {
		it("rejects values embedded in known documentation/example URLs", () => {
			for (const url of [
				`https://example.com/?api_key=${RANDOM_B64}`,
				`https://api.example.com/v1/tokens/${RANDOM_B64}`,
				`http://localhost:8080/callback?token=${RANDOM_B64}`,
				`https://jsonplaceholder.typicode.com/guide/${RANDOM_B64}`,
				`https://httpbin.org/get?key=${RANDOM_B64}`,
			]) {
				assert.ok(
					isDocumentationUrlContext({ ...ctxFor(RANDOM_B64, url), ruleId: "keyword-assignment" }),
					`${url} is documentation`,
				);
			}
		});
		it("accepts values in URLs on real hosts", () => {
			const line = `curl https://internal.company.com/hooks/${RANDOM_B64}`;
			assert.ok(!isDocumentationUrlContext({ ...ctxFor(RANDOM_B64, line), ruleId: "keyword-assignment" }));
		});
	});

	describe("isInsideCodeSampleContext", () => {
		const fenced = (info: string) =>
			`Here is how:\n\`\`\`${info}\npassword = "${RANDOM_B64}"\n\`\`\`\ndone.`;

		it("rejects candidates inside example-marked code fences", () => {
			for (const info of ["example", "js example", "documentation", "usage", "sample:yaml"]) {
				const text = fenced(info);
				const index = text.indexOf(RANDOM_B64);
				assert.ok(
					isInsideCodeSampleContext({ ...ctxFor(RANDOM_B64, undefined, text, index), ruleId: "keyword-assignment" }),
					`fence info '${info}' marks a code sample`,
				);
			}
		});
		it("accepts candidates inside plain code fences", () => {
			const text = fenced("");
			const index = text.indexOf(RANDOM_B64);
			assert.ok(!isInsideCodeSampleContext({ ...ctxFor(RANDOM_B64, undefined, text, index), ruleId: "keyword-assignment" }));
		});

		it("accepts candidates outside fences", () => {
			assert.ok(!isInsideCodeSampleContext(ctxFor(RANDOM_B64)));
		});

		it("rejects candidates on a line with a trailing example-marker comment", () => {
			const line = `password = "${RANDOM_B64}" # example`;
			assert.ok(
				isInsideCodeSampleContext({ ...ctxFor(RANDOM_B64, line), ruleId: "keyword-assignment" }),
			);
		});

		it("rejects candidates following a bare example-marker line", () => {
			const text = `# example\npassword = "${RANDOM_B64}"`;
			assert.ok(
				isInsideCodeSampleContext({
					value: RANDOM_B64,
					line: `password = "${RANDOM_B64}"`,
					text,
					index: text.indexOf(RANDOM_B64),
					ruleId: "keyword-assignment",
				}),
			);
		});

		it("accepts a real assignment after an unrelated comment line", () => {
			const text = `# rotate quarterly\npassword = "${RANDOM_B64}"`;
			assert.ok(
				!isInsideCodeSampleContext({
					value: RANDOM_B64,
					line: `password = "${RANDOM_B64}"`,
					text,
					index: text.indexOf(RANDOM_B64),
					ruleId: "keyword-assignment",
				}),
			);
		});
	});

	it("every filter id is stable and known to the config surface", () => {
		assert.ok(EXCLUSION_FILTER_IDS.length >= 10);
		assert.deepEqual(new Set(EXCLUSION_FILTER_IDS).size, EXCLUSION_FILTER_IDS.length);
	});
});

// ──────────────────────────── pipeline ────────────────────────────

describe("detectDetectSecretsLeaks", () => {
	it("finds leaks across all four message fields and records message ids", () => {
		// Values inside tool_calls/tool_results are JSON-encoded in the stored
		// field text, so fixtures keep them unquoted (escaped quotes would
		// otherwise be captured into the candidate value).
		const messages: MessageRow[] = [
			msg({ id: "u1", role: "user", content_text: `password = "${RANDOM_B64}"` }),
			msg({ id: "a1", role: "assistant", content_thinking: `the secret: ${RANDOM_B64_ALT}` }),
			msg({
				id: "a2",
				role: "assistant",
				tool_calls: JSON.stringify([{ name: "bash", arguments: { command: `export API_KEY=${RANDOM_HEX}` } }]),
			}),
			msg({
				id: "t1",
				role: "toolResult",
				tool_results: JSON.stringify([{ toolName: "bash", isError: false, textLength: 9, text: `token = ${RANDOM_B64}` }]),
			}),
		];
		const res = detectDetectSecretsLeaks(messages, DEFAULT_DETECT_SECRETS_CONFIG);

		for (const id of ["u1", "a1", "a2", "t1"]) {
			assert.ok(
				res.leaks.some((l) => l.message_id === id && l.rule_id === "keyword-assignment"),
				`message ${id} should carry a keyword-assignment finding`,
			);
		}
		assert.deepEqual(res.affected_message_ids, ["a1", "a2", "t1", "u1"]);
		assert.equal(res.leak_count, res.leaks.length);
	});

	it("REJECTS placeholder and documentation examples end-to-end (precision contract)", () => {
		const messages: MessageRow[] = [
			msg({ id: "p1", content_text: `password = "YOUR_API_KEY_HERE"` }),
			msg({ id: "p2", content_text: `api_key: xxxxxxxxxxxxxxxx` }),
			msg({ id: "p3", content_text: `see https://example.com/?token=${RANDOM_B64} for docs` }),
			msg({ id: "p4", content_text: `secret = get_secret_key()` }),
			msg({ id: "p5", content_text: `Example:\n\`\`\`example\npassword = "${RANDOM_B64}"\n\`\`\`` }),
			msg({ id: "p6", content_text: `user_id = "${RANDOM_B64}"` }),
			msg({ id: "p7", content_text: `password = "0123456789abcdef"` }),
			msg({ id: "p8", content_text: `password = "${"a".repeat(48)}"` }),
		];
		const res = detectDetectSecretsLeaks(messages, DEFAULT_DETECT_SECRETS_CONFIG);
		assert.equal(res.leak_count, 0, `expected zero findings, got ${JSON.stringify(res.leaks.map((l) => l.rule_id))}`);
		assert.ok(res.filtered_matches > 0, "the filters should have recorded rejections");
		assert.ok(Object.keys(res.filter_counts).length > 0);
	});

	it("keeps a real secret among placeholders (recall contract)", () => {
		const messages: MessageRow[] = [
			msg({ id: "p1", content_text: `password = "YOUR_API_KEY_HERE"` }),
			msg({ id: "real", content_text: `password = "${RANDOM_B64}"` }),
			msg({ id: "p2", content_text: `api_key: test1234567890123456` }),
		];
		const res = detectDetectSecretsLeaks(messages, DEFAULT_DETECT_SECRETS_CONFIG);
		assert.ok(res.leaks.length >= 1, "the real secret must survive");
		assert.ok(
			res.leaks.every((l) => l.message_id === "real"),
			`only the real message may leak, got ${JSON.stringify(res.leaks.map((l) => l.message_id))}`,
		);
		assert.ok(res.leaks.some((l) => l.rule_id === "keyword-assignment"));
		assert.equal(res.leaks.find((l) => l.rule_id === "keyword-assignment")!.confidence, "active");
	});

	it("flags quoted hex/base64 runs as passive medium findings", () => {
		const messages: MessageRow[] = [
			msg({ id: "h1", content_text: `checksum "${RANDOM_HEX}" verified` }),
			msg({ id: "b1", content_text: `payload "${RANDOM_B64_ALT}" decoded` }),
		];
		const res = detectDetectSecretsLeaks(messages, DEFAULT_DETECT_SECRETS_CONFIG);
		const ids = new Set(res.leaks.map((l) => l.rule_id));
		assert.ok(ids.has("hex-high-entropy-string"));
		assert.ok(ids.has("base64-high-entropy-string"));
		assert.equal(res.leaks.find((l) => l.rule_id === "hex-high-entropy-string")!.severity, "medium");
		assert.equal(res.leaks.find((l) => l.rule_id === "hex-high-entropy-string")!.confidence, "passive");
	});

	it("never stores the full matched secret in a finding", () => {
		// Unquoted: only the keyword generator fires, giving one finding.
		const messages: MessageRow[] = [
			msg({ id: "u1", content_text: `password = ${RANDOM_B64}` }),
		];
		const res = detectDetectSecretsLeaks(messages, DEFAULT_DETECT_SECRETS_CONFIG);
		assert.equal(res.leaks.length, 1);
		const blob = JSON.stringify(res.leaks);
		assert.ok(!blob.includes(RANDOM_B64), "full secret must not be in the finding");
		assert.ok(!blob.includes(RANDOM_B64.slice(4, -4)), "middle of secret must not be in the finding");
		assert.match(res.leaks[0]!.fingerprint, /^[0-9a-f]{16}$/);
		assert.equal(res.leaks[0]!.match_length, RANDOM_B64.length);
	});

	it("derives the same fingerprint as the other detectors for a shared match", () => {
		// Single-proposal-per-leak contract: the same leak found by several
		// detectors must carry an identical fingerprint. A quoted npm token
		// assignment is flagged by detect-secrets (keyword-context) and gitleaks
		// (npm-access-token); a quoted password assignment is flagged by
		// detect-secrets and nosey-parker (generic-password-quoted).
		const cfg = { disabledRules: [], allowFingerprints: [], allowPatterns: [], maxMatchesPerField: 50, minSeverity: "medium" as const };

		const npmMessages: MessageRow[] = [msg({ id: "u1", content_text: `NPM_TOKEN="${NPM_TOKEN}"` })];
		const ds = detectDetectSecretsLeaks(npmMessages, DEFAULT_DETECT_SECRETS_CONFIG);
		const gl = detectGitleaksLeaks(npmMessages, cfg);
		const d = ds.leaks.find((l) => l.rule_id === "keyword-assignment");
		const g = gl.leaks.find((l) => l.rule_id === "npm-access-token");
		assert.ok(d && g, "both detectors should flag the npm token assignment");
		assert.equal(d.fingerprint, g.fingerprint, "detect-secrets and gitleaks fingerprints must agree");
		assert.equal(d.fingerprint, fingerprintOf(NPM_TOKEN));

		const pwMessages: MessageRow[] = [msg({ id: "u2", content_text: `password = "${RANDOM_B64}"` })];
		const ds2 = detectDetectSecretsLeaks(pwMessages, DEFAULT_DETECT_SECRETS_CONFIG);
		const np = detectNoseyParkerLeaks(pwMessages, { ...cfg, minConfidence: "passive" });
		const d2 = ds2.leaks.find((l) => l.rule_id === "keyword-assignment");
		const n = np.leaks.find((l) => l.rule_id === "generic-password-quoted");
		assert.ok(d2 && n, "both detectors should flag the password assignment");
		assert.equal(d2.fingerprint, n.fingerprint, "detect-secrets and nosey-parker fingerprints must agree");

		// And both detect-secrets generators that fire on one value agree with
		// each other (keyword-context and base64-high-entropy).
		const both = detectDetectSecretsLeaks(pwMessages, DEFAULT_DETECT_SECRETS_CONFIG).leaks.filter(
			(l) => l.message_id === "u2",
		);
		const fps = new Set(both.map((l) => l.fingerprint));
		assert.equal(fps.size, 1, "all detect-secrets findings for one value share a fingerprint");
	});

	it("honors disabledPlugins", () => {
		const messages: MessageRow[] = [msg({ id: "u1", content_text: `password = "${RANDOM_B64}"` })];
		const res = detectDetectSecretsLeaks(messages, {
			...DEFAULT_DETECT_SECRETS_CONFIG,
			disabledPlugins: ["keyword-context"],
		});
		assert.ok(!res.leaks.some((l) => l.rule_id === "keyword-assignment"), "keyword plugin disabled");
		assert.ok(res.leaks.some((l) => l.rule_id === "base64-high-entropy-string"), "other plugins still run");
	});

	it("honors disabledFilters (disabling a heuristic lets its candidates through)", () => {
		const messages: MessageRow[] = [msg({ id: "p1", content_text: `password = "YOUR_API_KEY_HERE"` })];
		const def = detectDetectSecretsLeaks(messages, DEFAULT_DETECT_SECRETS_CONFIG);
		assert.equal(def.leak_count, 0);
		assert.equal(def.filter_counts["placeholder-value"], 1);

		const res = detectDetectSecretsLeaks(messages, {
			...DEFAULT_DETECT_SECRETS_CONFIG,
			disabledFilters: ["placeholder-value"],
		});
		assert.equal(res.leak_count, 1, "with the filter off, the placeholder becomes a finding");
		assert.equal(res.filter_counts["placeholder-value"], undefined);
	});

	it("honors allowFingerprints without storing the raw secret", () => {
		const fp = fingerprintOf(RANDOM_B64);
		const messages: MessageRow[] = [msg({ id: "u1", content_text: `password = "${RANDOM_B64}"` })];
		const res = detectDetectSecretsLeaks(messages, {
			...DEFAULT_DETECT_SECRETS_CONFIG,
			allowFingerprints: [fp],
		});
		assert.equal(res.leak_count, 0);
		assert.equal(
			res.allowlisted_matches,
			2,
			"keyword and base64 candidates share the value, hence the fingerprint",
		);
	});

	it("honors a pattern allowlist by shape", () => {
		const messages: MessageRow[] = [msg({ id: "u1", content_text: `password = "${RANDOM_B64}"` })];
		const res = detectDetectSecretsLeaks(messages, {
			...DEFAULT_DETECT_SECRETS_CONFIG,
			allowPatterns: [`^${RANDOM_B64.slice(0, 4)}.*${RANDOM_B64.slice(-4)}$`],
		});
		assert.equal(res.leak_count, 0);
		assert.equal(res.allowlisted_matches, 2);
	});

	it("honors minSeverity=critical (drops high/medium)", () => {
		const messages: MessageRow[] = [
			msg({ id: "u1", content_text: `password = "${RANDOM_B64}"` }), // high
			msg({ id: "u2", content_text: `checksum "${RANDOM_HEX}" ok` }), // medium
		];
		const res = detectDetectSecretsLeaks(messages, { ...DEFAULT_DETECT_SECRETS_CONFIG, minSeverity: "critical" });
		assert.equal(res.leak_count, 0);
	});

	it("caps survivors per field and counts the truncation after filtering", () => {
		const text = new Array(60).fill(`password = "${RANDOM_B64}"`).join("\n");
		const messages: MessageRow[] = [msg({ id: "u1", content_text: text })];
		const res = detectDetectSecretsLeaks(messages, { ...DEFAULT_DETECT_SECRETS_CONFIG, maxMatchesPerField: 5 });
		assert.equal(res.leaks.length, 5);
		assert.ok(res.truncated_matches > 0, "truncation should be recorded");
	});

	it("clean session produces zero leaks and zero filtered matches", () => {
		const messages: MessageRow[] = [
			msg({ id: "u1", content_text: "please refactor the helpers" }),
			msg({ id: "a1", content_text: "sure, splitting them by concern" }),
		];
		const res = detectDetectSecretsLeaks(messages, DEFAULT_DETECT_SECRETS_CONFIG);
		assert.equal(res.leak_count, 0);
		assert.equal(res.filtered_matches, 0);
		assert.deepEqual(res.affected_message_ids, []);
	});

	it("throws on unknown plugin or filter ids (no silent catches)", () => {
		assert.throws(() => assertKnownPluginAndFilterIds({ ...DEFAULT_DETECT_SECRETS_CONFIG, disabledPlugins: ["bogus"] }));
		assert.throws(() => assertKnownPluginAndFilterIds({ ...DEFAULT_DETECT_SECRETS_CONFIG, disabledFilters: ["bogus"] }));
		assert.doesNotThrow(() => assertKnownPluginAndFilterIds(DEFAULT_DETECT_SECRETS_CONFIG));
	});
});

// ──────────────────────────── shared redaction helpers ────────────────────────────

describe("shared redaction helpers", () => {
	it("redact never exposes the middle of a credential", () => {
		const r = redact(RANDOM_B64);
		assert.ok(r.includes("…"));
		assert.ok(!r.includes(RANDOM_B64.slice(4, -4)));
	});

	it("fingerprintOf is stable 16-hex and value-sensitive", () => {
		assert.match(fingerprintOf("abc"), /^[0-9a-f]{16}$/);
		assert.notEqual(fingerprintOf("abc"), fingerprintOf("abd"));
	});
});
