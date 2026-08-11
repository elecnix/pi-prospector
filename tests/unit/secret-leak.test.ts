/**
 * Unit tests for the secret-leak detector functions.
 *
 * All fixtures are hand-written synthetic values — no real credentials. The
 * "secrets" below are shape-correct but revoked/never-live tokens constructed to
 * match the detector patterns.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	SECRET_LEAK_RULES,
	detectSecretLeaks,
	matchedRuleIds,
	redact,
	fingerprintOf,
} from "../../src/analyze/analyzers/secret-leak/detectors.js";
import { DEFAULT_SECRET_LEAK_CONFIG } from "../../src/analyze/analyzers/secret-leak/config.js";
import type { MessageRow } from "../../src/analyze/types.js";

// ──────────────────────────── helpers ────────────────────────────

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
	};
}

// Shape-correct, never-live synthetic credentials.
const FIXTURES = {
	awsAccessKey: "AKIAIOSFODNN7EXAMPLE",
	awsSecret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
	githubPat: "ghp_" + "0".repeat(36),
	githubFine: "github_pat_" + "0".repeat(82),
	googleKey: "AIza" + "0".repeat(35),
	slack: "xoxb-" + "0".repeat(20),
	stripeLive: "sk_live_" + "0".repeat(24),
	gitlab: "glpat-" + "0".repeat(20),
	anthropic: "sk-ant-" + "0".repeat(93),
	openai: "sk-" + "0".repeat(48),
	pem: "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...",
	jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c",
};

// ──────────────────────────── redaction ────────────────────────────

describe("redact", () => {
	it("fully masks short values", () => {
		assert.equal(redact("abcd"), "••••");
		assert.equal(redact("12345678"), "••••");
	});

	it("shows first/last 2 for medium values and never the middle", () => {
		const r = redact("0123456789abcdef");
		assert.equal(r, "01••••ef");
		assert.ok(!r.includes("23456789abcd"));
	});

	it("shows first/last 4 for long values", () => {
		const r = redact(FIXTURES.githubPat);
		assert.ok(r.startsWith("ghp_"), `preview should keep the prefix, got ${r}`);
		assert.ok(r.endsWith("0000"), `preview should keep the last 4, got ${r}`);
		assert.ok(r.includes("…"));
		// The full secret must not survive in the preview.
		assert.ok(!r.includes(FIXTURES.githubPat.slice(4, -4)));
	});
});

describe("fingerprintOf", () => {
	it("is a 16-char hex string and stable", () => {
		const fp = fingerprintOf(FIXTURES.githubPat);
		assert.match(fp, /^[0-9a-f]{16}$/);
		assert.equal(fp, fingerprintOf(FIXTURES.githubPat));
	});

	it("differs across distinct values", () => {
		assert.notEqual(fingerprintOf(FIXTURES.githubPat), fingerprintOf(FIXTURES.openai));
	});
});

// ──────────────────────────── rule catalogue ────────────────────────────

describe("SECRET_LEAK_RULES", () => {
	it("every pattern is global (matchAll requires it)", () => {
		for (const r of SECRET_LEAK_RULES) {
			assert.ok(r.pattern.global, `rule ${r.id} must have the g flag`);
		}
	});

	it("every rule has a unique id and a known severity", () => {
		const ids = new Set<string>();
		for (const r of SECRET_LEAK_RULES) {
			assert.ok(!ids.has(r.id), `duplicate rule id ${r.id}`);
			ids.add(r.id);
			assert.ok(["medium", "high", "critical"].includes(r.severity));
		}
	});
});

// ──────────────────────────── detection ────────────────────────────

describe("matchedRuleIds", () => {
	it("detects each provider token by shape", () => {
		assert.ok(matchedRuleIds(FIXTURES.awsAccessKey).includes("aws_access_key_id"));
		assert.ok(matchedRuleIds(FIXTURES.githubPat).includes("github_pat_classic"));
		assert.ok(matchedRuleIds(FIXTURES.githubFine).includes("github_pat_fine_grained"));
		assert.ok(matchedRuleIds(FIXTURES.googleKey).includes("google_api_key"));
		assert.ok(matchedRuleIds(FIXTURES.slack).includes("slack_token"));
		assert.ok(matchedRuleIds(FIXTURES.stripeLive).includes("stripe_live_secret_key"));
		assert.ok(matchedRuleIds(FIXTURES.gitlab).includes("gitlab_pat"));
		assert.ok(matchedRuleIds(FIXTURES.anthropic).includes("anthropic_api_key"));
		assert.ok(matchedRuleIds(FIXTURES.openai).includes("openai_api_key"));
		assert.ok(matchedRuleIds(FIXTURES.pem).includes("private_key_block"));
		assert.ok(matchedRuleIds(FIXTURES.jwt).includes("jwt"));
	});

	it("does not match ordinary prose", () => {
		const prose = [
			"please add a unit test for the new helper",
			"the key insight is that idempotency holds",
			"set AWS_REGION=us-east-1 and retry",
			"sk- is a common prefix for stripe and openai, careful",
			"BEGIN PRIVATE PROJECT, not a key",
		];
		for (const p of prose) {
			assert.deepEqual(matchedRuleIds(p), [], `ordinary prose should not match: ${p}`);
		}
	});

	it("distinguishes openai sk- from stripe sk_live_ (no cross-match)", () => {
		assert.ok(!matchedRuleIds(FIXTURES.stripeLive).includes("openai_api_key"));
		// Stripe live key must not be misread as an OpenAI key.
		assert.ok(matchedRuleIds(FIXTURES.stripeLive).includes("stripe_live_secret_key"));
	});
});

describe("detectSecretLeaks", () => {
	it("finds leaks across all four message fields and records message ids", () => {
		const messages: MessageRow[] = [
			msg({ id: "u1", role: "user", content_text: `my token is ${FIXTURES.githubPat}` }),
			msg({
				id: "a1",
				role: "assistant",
				content_thinking: `I will use ${FIXTURES.anthropic} for this`,
			}),
			msg({
				id: "a2",
				role: "assistant",
				tool_calls: JSON.stringify([{ name: "bash", arguments: { command: `export AWS_KEY=${FIXTURES.awsAccessKey}` } }]),
			}),
			msg({
				id: "t1",
				role: "toolResult",
				tool_results: JSON.stringify([{ toolName: "bash", isError: false, textLength: 9, text: FIXTURES.pem }]),
			}),
		];
		// tool_results fixture: the helpers store a JSON string; detectors scan the
		// raw string, so the PEM header inside it is caught.
		const res = detectSecretLeaks(messages, DEFAULT_SECRET_LEAK_CONFIG);

		const ruleIds = new Set(res.leaks.map((l) => l.rule_id));
		assert.ok(ruleIds.has("github_pat_classic"), "github pat in content_text");
		assert.ok(ruleIds.has("anthropic_api_key"), "anthropic key in content_thinking");
		assert.ok(ruleIds.has("aws_access_key_id"), "aws key in tool_calls");
		assert.ok(ruleIds.has("private_key_block"), "pem header in tool_results");

		const msgIds = new Set(res.leaks.map((l) => l.message_id));
		assert.ok(msgIds.has("u1") && msgIds.has("a1") && msgIds.has("a2") && msgIds.has("t1"));
		assert.deepEqual(res.affected_message_ids, ["a1", "a2", "t1", "u1"]);
	});

	it("never stores the full matched secret in a finding", () => {
		const messages: MessageRow[] = [
			msg({ id: "u1", role: "user", content_text: `token: ${FIXTURES.githubPat}` }),
		];
		const res = detectSecretLeaks(messages, DEFAULT_SECRET_LEAK_CONFIG);
		assert.equal(res.leaks.length, 1);
		const finding = res.leaks[0]!;
		// The full secret must not appear in any stored field of the finding.
		const blob = JSON.stringify(finding);
		assert.ok(!blob.includes(FIXTURES.githubPat), "full secret must not be in the finding");
		assert.ok(!blob.includes(FIXTURES.githubPat.slice(4, -4)), "middle of secret must not be in the finding");
		assert.equal(finding.match_length, FIXTURES.githubPat.length);
		assert.match(finding.fingerprint, /^[0-9a-f]{16}$/);
	});

	it("captures the AWS secret only in assignment context, not the bare 40-char string", () => {
		// In context → detected, via the capture group (group 1 is the secret).
		const withCtx = msg({
			id: "m1",
			role: "user",
			content_text: `aws_secret_access_key=${FIXTURES.awsSecret}`,
		});
		const r1 = detectSecretLeaks([withCtx], DEFAULT_SECRET_LEAK_CONFIG);
		const aws = r1.leaks.find((l) => l.rule_id === "aws_secret_access_key");
		assert.ok(aws, "aws secret detected in assignment context");
		assert.equal(aws!.match_length, FIXTURES.awsSecret.length, "captured group length is the secret length");
		assert.ok(!JSON.stringify(aws).includes(FIXTURES.awsSecret), "full aws secret not stored");

		// Bare 40-char base64 in prose must NOT trigger the aws secret rule.
		const bare = msg({ id: "m2", role: "user", content_text: `some base64 ${FIXTURES.awsSecret} here` });
		const r2 = detectSecretLeaks([bare], DEFAULT_SECRET_LEAK_CONFIG);
		assert.ok(!r2.leaks.some((l) => l.rule_id === "aws_secret_access_key"), "bare 40-char string must not match");
	});

	it("honors disabledRules", () => {
		const messages: MessageRow[] = [
			msg({ id: "u1", role: "user", content_text: `${FIXTURES.githubPat}` }),
		];
		const res = detectSecretLeaks(messages, { ...DEFAULT_SECRET_LEAK_CONFIG, disabledRules: ["github_pat_classic"] });
		assert.equal(res.leak_count, 0);
	});

	it("honors a fingerprint allowlist without storing the raw secret", () => {
		const fp = fingerprintOf(FIXTURES.githubPat);
		const messages: MessageRow[] = [
			msg({ id: "u1", role: "user", content_text: `${FIXTURES.githubPat}` }),
		];
		const res = detectSecretLeaks(messages, { ...DEFAULT_SECRET_LEAK_CONFIG, allowFingerprints: [fp] });
		assert.equal(res.leak_count, 0);
		assert.equal(res.allowlisted_matches, 1);
	});

	it("honors a pattern allowlist by shape", () => {
		const messages: MessageRow[] = [
			msg({ id: "u1", role: "user", content_text: `AKIATESTFAKE00000000` }),
		];
		// AKIATESTFAKE00000000 has 20 chars and starts AKIA → would match
		// aws_access_key_id. Allow it by a shape pattern.
		const res = detectSecretLeaks(messages, { ...DEFAULT_SECRET_LEAK_CONFIG, allowPatterns: ["^AKIATEST"] });
		assert.equal(res.leak_count, 0);
		assert.equal(res.allowlisted_matches, 1);
	});

	it("honors minSeverity=critical (drops high/medium)", () => {
		const messages: MessageRow[] = [
			msg({ id: "u1", role: "user", content_text: `jwt: ${FIXTURES.jwt}` }), // high
			msg({ id: "u2", role: "user", content_text: `${FIXTURES.githubPat}` }), // critical
		];
		const res = detectSecretLeaks(messages, { ...DEFAULT_SECRET_LEAK_CONFIG, minSeverity: "critical" });
		const ids = new Set(res.leaks.map((l) => l.rule_id));
		assert.ok(ids.has("github_pat_classic"));
		assert.ok(!ids.has("jwt"), "jwt is high, below critical floor");
	});

	it("caps matches per field and counts the truncation", () => {
		const text = new Array(60).fill(FIXTURES.githubPat).join(" ");
		const messages: MessageRow[] = [msg({ id: "u1", role: "user", content_text: text })];
		const res = detectSecretLeaks(messages, { ...DEFAULT_SECRET_LEAK_CONFIG, maxMatchesPerField: 5 });
		assert.equal(res.leaks.length, 5);
		assert.ok(res.truncated_matches > 0, "truncation should be recorded");
	});

	it("clean session produces zero leaks", () => {
		const messages: MessageRow[] = [
			msg({ id: "u1", role: "user", content_text: "please refactor the helpers" }),
			msg({ id: "a1", role: "assistant", content_text: "sure, splitting them by concern" }),
		];
		const res = detectSecretLeaks(messages, DEFAULT_SECRET_LEAK_CONFIG);
		assert.equal(res.leak_count, 0);
		assert.equal(res.leaks.length, 0);
		assert.deepEqual(res.affected_message_ids, []);
	});
});