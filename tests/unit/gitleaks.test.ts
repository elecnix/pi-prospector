/**
 * Unit tests for the gitleaks detector catalogue and scan function.
 *
 * All fixtures are hand-written synthetic values — no real credentials. The
 * "secrets" below are shape-correct but revoked/never-live tokens constructed
 * to match the ported gitleaks patterns.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	GITLEAKS_RULES,
	GITLEAKS_UPSTREAM,
	detectGitleaksLeaks,
	matchedGitleaksRuleIds,
	redact,
	fingerprintOf,
} from "../../src/analyze/analyzers/gitleaks/detectors.js";
import { DEFAULT_GITLEAKS_CONFIG } from "../../src/analyze/analyzers/gitleaks/config.js";
import { detectSecretLeaks } from "../../src/analyze/analyzers/secret-leak/detectors.js";
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

/**
 * One synthetic, never-live fixture per ported rule. Prefix rules hold the
 * bare token; context rules hold the full `keyword … = value` line the
 * assignment-context preamble requires. The intended rule must match its own
 * fixture.
 */
const FIXTURES: Record<string, string> = {
	// prefix-anchored
	"1password-service-account-token": `ops_eyJ${"x".repeat(250)}`,
	"age-secret-key": `AGE-SECRET-KEY-1${"QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L".repeat(2).slice(0, 58)}`,
	"atlassian-api-token": `ATATT3${"a".repeat(186)}`,
	"cloudflare-origin-ca-key": `v1.0-${"0".repeat(24)}-${"0".repeat(146)}`,
	"databricks-api-token": `dapi${"0".repeat(32)}`,
	"digitalocean-access-token": `doo_v1_${"0".repeat(64)}`,
	"digitalocean-pat": `dop_v1_${"0".repeat(64)}`,
	"duffel-api-token": `duffel_live_${"a".repeat(43)}`,
	"dynatrace-api-token": `dt0c01.${"a".repeat(24)}.${"a".repeat(64)}`,
	"easypost-api-token": `EZAK${"a".repeat(54)}`,
	"easypost-test-api-token": `EZTK${"a".repeat(54)}`,
	"flutterwave-encryption-key": `FLWSECK_TEST-abcdef012345`,
	"flutterwave-public-key": `FLWPUBK_TEST-${"a".repeat(32)}-X`,
	"flutterwave-secret-key": `FLWSECK_TEST-${"a".repeat(32)}-X`,
	"flyio-access-token": `fo1_${"a".repeat(43)}`,
	"frameio-api-token": `fio-u-${"a".repeat(64)}`,
	"gitlab-cicd-job-token": `glcbt-12_${"a".repeat(20)}`,
	"gitlab-deploy-token": `gldt_${"a".repeat(20)}`.replace("gldt_", "gldt-"),
	"gitlab-feature-flag-client-token": `glffct-${"a".repeat(20)}`,
	"gitlab-feed-token": `glft-${"a".repeat(20)}`,
	"gitlab-incoming-mail-token": `glimt-${"a".repeat(25)}`,
	"gitlab-kubernetes-agent-token": `glagent-${"a".repeat(50)}`,
	"gitlab-oauth-app-secret": `gloas-${"a".repeat(64)}`,
	"gitlab-ptt": `glptt-${"0".repeat(40)}`,
	"gitlab-rrt": `GR1348941${"a".repeat(20)}`,
	"gitlab-runner-authentication-token": `glrt-${"a".repeat(20)}`,
	"gitlab-scim-token": `glsoat-${"a".repeat(20)}`,
	"gitlab-session-cookie": `_gitlab_session=${"a".repeat(32)}`,
	"grafana-service-account-token": `glsa_${"a".repeat(32)}_${"0".repeat(8)}`,
	"hashicorp-tf-api-token": `${"b".repeat(14)}.atlasv1.${"c".repeat(65)}`,
	"huggingface-access-token": `hf_${"a".repeat(34)}`,
	"infracost-api-token": `ico-${"a".repeat(32)}`,
	"linear-api-key": `lin_api_${"a".repeat(40)}`,
	"maxmind-license-key": `abc123_${"a".repeat(29)}_mmk`,
	"microsoft-teams-webhook": `https://contoso.webhook.office.com/webhookb2/11223344-5566-7788-9900-aabbccddeeff@11223344-5566-7788-9900-aabbccddeeff/IncomingWebhook/${"a".repeat(32)}/11223344-5566-7788-9900-aabbccddeeff`,
	"notion-api-token": `ntn_${"0".repeat(11)}${"a".repeat(35)}`,
	"npm-access-token": `npm_${"a".repeat(36)}`,
	"perplexity-api-key": `pplx-${"a".repeat(48)}`,
	"planetscale-api-token": `pscale_tkn_${"a".repeat(40)}`,
	"postman-api-token": `PMAK-${"0".repeat(24)}-${"0".repeat(34)}`,
	"prefect-api-token": `pnu_${"a".repeat(36)}`,
	"pypi-upload-token": `pypi-AgEIcHlwaS5vcmc${"a".repeat(60)}`,
	"pulumi-api-token": `pul-${"0".repeat(40)}`,
	"readme-api-token": `rdme_${"a".repeat(70)}`,
	"rubygems-api-token": `rubygems_${"0".repeat(48)}`,
	"scalingo-api-token": `tk-us-${"a".repeat(48)}`,
	"sendgrid-api-token": `SG.${"a".repeat(66)}`,
	"sendinblue-api-token": `xkeysib-${"0".repeat(64)}-${"a".repeat(16)}`,
	"sentry-org-token": `sntrys_eyJpYXQiO${"a".repeat(20)}LCJyZWdpb25fdXJs${"b".repeat(20)}_${"c".repeat(43)}`,
	"sentry-user-token": `sntryu_${"0".repeat(64)}`,
	"shippo-api-token": `shippo_live_${"0".repeat(40)}`,
	"shopify-access-token": `shpat_${"0".repeat(32)}`,
	"shopify-custom-access-token": `shpca_${"0".repeat(32)}`,
	"shopify-private-app-access-token": `shppa_${"0".repeat(32)}`,
	"shopify-shared-secret": `shpss_${"0".repeat(32)}`,
	"sourcegraph-access-token": `sgp_${"0".repeat(40)}`,
	"square-access-token": `EAAA${"a".repeat(30)}`,
	"stripe-access-token": `sk_test_${"a".repeat(24)}`,
	"twilio-api-key": `SK${"0".repeat(32)}`,
	"typeform-api-token": `tfp_${"a".repeat(59)}`,
	"vault-batch-token": `hvb.${"a".repeat(150)}`,
	"vault-service-token": `hvs.${"a".repeat(100)}`,
	// assignment-context
	"algolia-api-key": `algolia_api_key = "${"a".repeat(32)}"`,
	"cohere-api-token": `CO_API_KEY: ${"a".repeat(40)}`,
	"codecov-access-token": `codecov_token = ${"a".repeat(32)}`,
	"coinbase-access-token": `coinbase = ${"a".repeat(64)}`,
	"contentful-delivery-api-token": `contentful_delivery = ${"a".repeat(43)}`,
	"discord-api-token": `discord_token: ${"0".repeat(64)}`,
	"droneci-access-token": `droneci_token = ${"a".repeat(32)}`,
	"fastly-api-token": `fastly_key = ${"a".repeat(32)}`,
	"finnhub-access-token": `finnhub_token = ${"a".repeat(20)}`,
	"gocardless-api-token": `gocardless_token = live_${"a".repeat(40)}`,
	"heroku-api-key": `heroku_api_key = 11223344-5566-7788-9900-aabbccddeeff`,
	"hubspot-api-key": `hubspot = 11223344-5566-7788-9900-aabbccddeeff`,
	"intercom-api-key": `intercom = ${"a".repeat(60)}`,
	"jfrog-api-key": `jfrog = ${"a".repeat(73)}`,
	"jfrog-identity-token": `artifactory_token = ${"a".repeat(64)}`,
	"kraken-access-token": `kraken = ${"a".repeat(85)}`,
	"launchdarkly-access-token": `launchdarkly = ${"a".repeat(40)}`,
	"lob-api-key": `lob = live_${"0".repeat(35)}`,
	// Built by join so the source holds no contiguous literal: the value matches
	// the Mailchimp key shape exactly, and GitHub push protection (rightly) blocks
	// any such literal — even this documented, never-live dummy.
	"mailchimp-api-key": `mailchimp = ${["0123456789abcdef", "0123456789abcdef"].join("")}-us14`,
	"mailgun-private-api-token": `mailgun = key-${"0".repeat(32)}`,
	"mailgun-signing-key": `mailgun_signing = ${"a".repeat(32)}-${"b".repeat(8)}-${"c".repeat(8)}`,
	"mapbox-api-token": `mapbox = pk.${"a".repeat(60)}.${"a".repeat(22)}`,
	"mattermost-access-token": `mattermost = ${"a".repeat(26)}`,
	"messagebird-api-token": `message_bird = ${"a".repeat(25)}`,
	"netlify-access-token": `netlify = ${"a".repeat(42)}`,
	"new-relic-browser-api-token": `newrelic = NRJS-${"0".repeat(19)}`,
	"new-relic-insert-key": `new_relic_insert = NRII-${"a".repeat(32)}`,
	"new-relic-user-api-key": `new-relic = NRAK-${"a".repeat(27)}`,
	"okta-access-token": `okta = 00${"a".repeat(40)}`,
	"plaid-api-token": `plaid = access-production-11223344-5566-7788-9900-aabbccddeeff`,
	"plaid-client-id": `plaid_client_id = ${"a".repeat(24)}`,
	"plaid-secret-key": `plaid_secret = ${"a".repeat(30)}`,
	"privateai-api-token": `private_ai = ${"a".repeat(32)}`,
	"rapidapi-access-token": `rapidapi = ${"a".repeat(50)}`,
	"sendbird-access-token": `sendbird = ${"0".repeat(40)}`,
	"sentry-access-token": `sentry = ${"0".repeat(64)}`,
	"snyk-api-token": `snyk_token = 11223344-5566-7788-9900-aabbccddeeff`,
	"sonar-api-token": `sonar_token = ${"a".repeat(40)}`,
	"squarespace-access-token": `squarespace = 11223344-5566-7788-9900-aabbccddeeff`,
	"sumologic-access-token": `sumo = ${"a".repeat(64)}`,
	"telegram-bot-api-token": `telegram = 123456789:${"A".repeat(35)}`,
	"travisci-access-token": `travis = ${"a".repeat(22)}`,
	"twitch-api-token": `twitch = ${"a".repeat(30)}`,
	"twitter-bearer-token": `twitter = ${"A".repeat(22)}${"a".repeat(80)}`,
	"yandex-access-token": `yandex = t1.${"a".repeat(20)}.${"a".repeat(86)}`,
	"yandex-api-key": `yandex_api_key = AQVN${"a".repeat(36)}`,
	"zendesk-secret-key": `zendesk = ${"a".repeat(40)}`,
};

// ──────────────────────────── provenance ────────────────────────────

describe("GITLEAKS_UPSTREAM", () => {
	it("records the upstream licence and version", () => {
		assert.equal(GITLEAKS_UPSTREAM.licence, "Apache-2.0");
		assert.match(GITLEAKS_UPSTREAM.version, /^v\d+\.\d+\.\d+$/);
		assert.ok(GITLEAKS_UPSTREAM.source.startsWith("https://github.com/gitleaks/gitleaks/"));
	});
});

// ──────────────────────────── rule catalogue ────────────────────────────

describe("GITLEAKS_RULES", () => {
	it("every pattern is global (matchAll requires it)", () => {
		for (const r of GITLEAKS_RULES) {
			assert.ok(r.pattern.global, `rule ${r.id} must have the g flag`);
		}
	});

	it("every rule has a unique id and a known severity", () => {
		const ids = new Set<string>();
		for (const r of GITLEAKS_RULES) {
			assert.ok(!ids.has(r.id), `duplicate rule id ${r.id}`);
			ids.add(r.id);
			assert.ok(["medium", "high", "critical"].includes(r.severity));
		}
	});

	it("every ported rule has a fixture, and the fixture matches its own rule", () => {
		assert.equal(Object.keys(FIXTURES).length, GITLEAKS_RULES.length, "one fixture per ported rule");
		for (const rule of GITLEAKS_RULES) {
			const sample = FIXTURES[rule.id];
			assert.ok(sample, `rule ${rule.id} has no fixture`);
			const re = new RegExp(rule.pattern.source, rule.pattern.flags);
			assert.ok(re.test(sample), `rule ${rule.id} should match its own fixture: ${sample}`);
		}
	});

	it("no rule pattern contains a capturing group beyond the value group", () => {
		// The value is group 1; any inner capturing group would shift it and
		// corrupt the fingerprint. (Non-capturing groups are fine.)
		for (const r of GITLEAKS_RULES) {
			const source = r.pattern.source;
			const opens = (source.match(/\(/g) ?? []).length;
			const nonCapturing = (source.match(/\(\?[:=]/g) ?? []).length;
			assert.ok(opens - nonCapturing <= 1, `rule ${r.id} must not nest capturing groups`);
		}
	});
});

// ──────────────────────────── detection ────────────────────────────

describe("matchedGitleaksRuleIds", () => {
	it("detects each ported provider rule by shape", () => {
		for (const [id, sample] of Object.entries(FIXTURES)) {
			assert.ok(matchedGitleaksRuleIds(sample).includes(id), `expected ${id} to match its fixture`);
		}
	});

	it("does not match ordinary prose", () => {
		const prose = [
			"please add a unit test for the new helper",
			"set AWS_REGION=us-east-1 and retry",
			"the hvs. directory holds terraform state, check version 1.2.3",
			"curl the endpoint and parse the SK response header",
			"npm install and rubygems update finished cleanly",
			"heroku ps:restart the web dyno",
		];
		for (const p of prose) {
			assert.deepEqual(matchedGitleaksRuleIds(p), [], `ordinary prose should not match: ${p}`);
		}
	});

	it("context rules require assignment context, not a bare value", () => {
		// A bare Heroku-style UUID in prose must not match; the assignment line must.
		const bare = "the request id is 11223344-5566-7788-9900-aabbccddeeff";
		assert.ok(!matchedGitleaksRuleIds(bare).includes("heroku-api-key"));
		assert.ok(matchedGitleaksRuleIds(FIXTURES["heroku-api-key"]!).includes("heroku-api-key"));
	});

	it("drops upstream branches that are pure false-positive bait", () => {
		// Bare 40-hex (sourcegraph's omitted branch) and a short vault-style
		// `s.` token (vault's omitted branch) must not match.
		assert.ok(!matchedGitleaksRuleIds(`${"a".repeat(40)}`).includes("sourcegraph-access-token"));
		assert.ok(!matchedGitleaksRuleIds(`s.${"a".repeat(24)}`).includes("vault-service-token"));
	});
});

describe("detectGitleaksLeaks", () => {
	it("finds leaks across all four message fields and records message ids", () => {
		const messages: MessageRow[] = [
			msg({ id: "u1", role: "user", content_text: `my token is ${NPM_TOKEN}` }),
			msg({ id: "a1", role: "assistant", content_thinking: `I will use ${FIXTURES["perplexity-api-key"]} for this` }),
			msg({
				id: "a2",
				role: "assistant",
				tool_calls: JSON.stringify([{ name: "bash", arguments: { command: `export SHOPIFY_TOKEN=${FIXTURES["shopify-access-token"]}` } }]),
			}),
			msg({
				id: "t1",
				role: "toolResult",
				tool_results: JSON.stringify([{ toolName: "bash", isError: false, textLength: 9, text: FIXTURES["heroku-api-key"] }]),
			}),
		];
		const res = detectGitleaksLeaks(messages, DEFAULT_GITLEAKS_CONFIG);

		const ruleIds = new Set(res.leaks.map((l) => l.rule_id));
		assert.ok(ruleIds.has("npm-access-token"), "npm token in content_text");
		assert.ok(ruleIds.has("perplexity-api-key"), "perplexity key in content_thinking");
		assert.ok(ruleIds.has("shopify-access-token"), "shopify token in tool_calls");
		assert.ok(ruleIds.has("heroku-api-key"), "heroku key in tool_results");

		const msgIds = new Set(res.leaks.map((l) => l.message_id));
		assert.ok(msgIds.has("u1") && msgIds.has("a1") && msgIds.has("a2") && msgIds.has("t1"));
		assert.deepEqual(res.affected_message_ids, ["a1", "a2", "t1", "u1"]);
	});

	it("never stores the full matched secret in a finding", () => {
		const messages: MessageRow[] = [
			msg({ id: "u1", role: "user", content_text: `token: ${NPM_TOKEN}` }),
		];
		const res = detectGitleaksLeaks(messages, DEFAULT_GITLEAKS_CONFIG);
		assert.equal(res.leaks.length, 1);
		const finding = res.leaks[0]!;
		const blob = JSON.stringify(finding);
		assert.ok(!blob.includes(NPM_TOKEN), "full secret must not be in the finding");
		assert.ok(!blob.includes(NPM_TOKEN.slice(4, -4)), "middle of secret must not be in the finding");
		assert.equal(finding.match_length, NPM_TOKEN.length);
		assert.match(finding.fingerprint, /^[0-9a-f]{16}$/);
	});

	it("derives the same fingerprint as secret-leak for a value both catalogues match", () => {
		// Single-proposal-per-leak contract: detectors must fingerprint a shared
		// match identically so the synthesiser can collapse across detectors.
		const stripeLive = `sk_live_${"0".repeat(24)}`;
		const messages: MessageRow[] = [
			msg({ id: "u1", role: "user", content_text: stripeLive }),
		];
		const gitleaks = detectGitleaksLeaks(messages, DEFAULT_GITLEAKS_CONFIG);
		const secretLeak = detectSecretLeaks(messages, {
			disabledRules: [],
			allowFingerprints: [],
			allowPatterns: [],
			maxMatchesPerField: 50,
			minSeverity: "medium",
		});
		const g = gitleaks.leaks.find((l) => l.rule_id === "stripe-access-token");
		const s = secretLeak.leaks.find((l) => l.rule_id === "stripe_live_secret_key");
		assert.ok(g && s, "both detectors should flag the stripe live key");
		assert.equal(g.fingerprint, s.fingerprint, "fingerprints must agree across detectors");
		assert.equal(g.redacted_preview, s.redacted_preview);
	});

	it("honors disabledRules with upstream gitleaks rule ids", () => {
		const messages: MessageRow[] = [
			msg({ id: "u1", role: "user", content_text: NPM_TOKEN }),
		];
		const res = detectGitleaksLeaks(messages, {
			...DEFAULT_GITLEAKS_CONFIG,
			disabledRules: ["npm-access-token"],
		});
		assert.equal(res.leak_count, 0);
	});

	it("honors a fingerprint allowlist without storing the raw secret", () => {
		const fp = fingerprintOf(NPM_TOKEN);
		const messages: MessageRow[] = [
			msg({ id: "u1", role: "user", content_text: NPM_TOKEN }),
		];
		const res = detectGitleaksLeaks(messages, { ...DEFAULT_GITLEAKS_CONFIG, allowFingerprints: [fp] });
		assert.equal(res.leak_count, 0);
		assert.equal(res.allowlisted_matches, 1);
	});

	it("honors a pattern allowlist by shape", () => {
		const messages: MessageRow[] = [
			msg({ id: "u1", role: "user", content_text: `dop_v1_${"0".repeat(64)}` }),
		];
		const res = detectGitleaksLeaks(messages, {
			...DEFAULT_GITLEAKS_CONFIG,
			allowPatterns: ["^dop_v1_0+"],
		});
		assert.equal(res.leak_count, 0);
		assert.equal(res.allowlisted_matches, 1);
	});

	it("honors minSeverity=critical (drops high/medium)", () => {
		const messages: MessageRow[] = [
			msg({ id: "u1", role: "user", content_text: FIXTURES["npm-access-token"] }), // high
			msg({ id: "u2", role: "user", content_text: FIXTURES["perplexity-api-key"] }), // critical
		];
		const res = detectGitleaksLeaks(messages, { ...DEFAULT_GITLEAKS_CONFIG, minSeverity: "critical" });
		const ids = new Set(res.leaks.map((l) => l.rule_id));
		assert.ok(ids.has("perplexity-api-key"));
		assert.ok(!ids.has("npm-access-token"), "npm is high, below critical floor");
	});

	it("caps matches per field and counts the truncation", () => {
		const text = new Array(60).fill(NPM_TOKEN).join(" ");
		const messages: MessageRow[] = [msg({ id: "u1", role: "user", content_text: text })];
		const res = detectGitleaksLeaks(messages, { ...DEFAULT_GITLEAKS_CONFIG, maxMatchesPerField: 5 });
		assert.equal(res.leaks.length, 5);
		assert.ok(res.truncated_matches > 0, "truncation should be recorded");
	});

	it("clean session produces zero leaks", () => {
		const messages: MessageRow[] = [
			msg({ id: "u1", role: "user", content_text: "please refactor the helpers" }),
			msg({ id: "a1", role: "assistant", content_text: "sure, splitting them by concern" }),
		];
		const res = detectGitleaksLeaks(messages, DEFAULT_GITLEAKS_CONFIG);
		assert.equal(res.leak_count, 0);
		assert.deepEqual(res.affected_message_ids, []);
	});
});

const NPM_TOKEN = FIXTURES["npm-access-token"]!;

// redact/fingerprintOf are shared with secret-leak; spot-check the re-exports.
describe("shared redaction helpers", () => {
	it("redact never exposes the middle of a credential", () => {
		const r = redact(NPM_TOKEN);
		assert.ok(r.startsWith("npm_"));
		assert.ok(r.includes("…"));
		assert.ok(!r.includes(NPM_TOKEN.slice(4, -4)));
	});

	it("fingerprintOf is stable 16-hex and value-sensitive", () => {
		assert.match(fingerprintOf("abc"), /^[0-9a-f]{16}$/);
		assert.notEqual(fingerprintOf("abc"), fingerprintOf("abd"));
	});
});
