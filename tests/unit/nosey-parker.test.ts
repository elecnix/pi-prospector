/**
 * Unit tests for the nosey-parker detector catalogue and scan function.
 *
 * All fixtures are hand-written synthetic values — no real credentials. The
 * "secrets" below are shape-correct but revoked/never-live tokens constructed
 * to match the ported Nosey Parker patterns. Values are built by
 * concatenation/repetition so no contiguous realistic literal exists in
 * source (GitHub push protection would rightly block one).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	NOSEY_PARKER_RULES,
	NOSEY_PARKER_UPSTREAM,
	detectNoseyParkerLeaks,
	matchedNoseyParkerRuleIds,
	redact,
	fingerprintOf,
	meetsMinConfidence,
	CONFIDENCE_RANK,
} from "../../src/analyze/analyzers/nosey-parker/detectors.js";
import { DEFAULT_NOSEY_PARKER_CONFIG } from "../../src/analyze/analyzers/nosey-parker/config.js";
import { detectSecretLeaks } from "../../src/analyze/analyzers/secret-leak/detectors.js";
import { detectGitleaksLeaks } from "../../src/analyze/analyzers/gitleaks/detectors.js";
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
 * One synthetic, never-live fixture per ported rule. The intended rule must
 * match its own fixture, and the fixture must exercise the rule's capture
 * (group 1) where the rule declares one.
 */
const FIXTURES: Record<string, string> = {
	// ── passive ──
	"adafruit-io-key": `aio_${"a".repeat(28)}`,
	"adobe-client-secret": `p8e-${"a".repeat(32)}`,
	"amazon-mws-auth-token": `amzn.mws.${["01234567", "89ab", "cdef", "0123", "456789abcdef"].join("-")}`,
	"aws-appsync-api-key": `da2-${"a".repeat(26)}`,
	"dockerhub-personal-access-token": `dckr_pat_${"a".repeat(27)}`,
	"doppler-audit-token": `dp.audit.${"a".repeat(40)}`,
	"doppler-cli-token": `dp.ct.${"a".repeat(40)}`,
	"doppler-personal-token": `dp.pt.${"a".repeat(40)}`,
	"doppler-scim-token": `dp.scim.${"a".repeat(40)}`,
	"doppler-service-account-token": `dp.sa.${"a".repeat(40)}`,
	"doppler-service-token": `dp.st.dev.${"a".repeat(40)}`,
	"dropbox-access-token": `sl.${"a".repeat(130)}`,
	"facebook-access-token": `EAACEdEose0cBA${"a".repeat(20)}`,
	"figma-personal-access-token": `figma pat: ${["0123", "01234567", "89ab", "cdef", "0123", "456789abcdef"].join("-")}`,
	"firecrawl-api-key": `fc-${"0".repeat(32)}`,
	"google-oauth-access-token": `ya29.${"a".repeat(20)}`,
	"google-oauth-client-secret": `GOCSPX-${"a".repeat(28)}`,
	"grafana-service-token": `eyJrIjoi${"a".repeat(60)}`,
	"groq-api-key": `gsk_${"a".repeat(50)}`,
	"jina-api-key": `jina_${"a".repeat(60)}`,
	"nuget-api-key": `oy2${"a".repeat(43)}`,
	"password-hash-bcrypt": `$2b$12$${"a".repeat(53)}`,
	"password-hash-md5crypt": `$1$saltsalt$${"a".repeat(22)}`,
	"password-hash-sha256crypt": `$5$saltsalt$${"a".repeat(43)}`,
	"password-hash-sha512crypt": `$6$saltsalt$${"a".repeat(86)}`,
	"salesforce-access-token": `00${"a".repeat(13)}!${"a".repeat(96)}`,
	"segment-public-api-token": `sgp_${"a".repeat(64)}`,
	"stackhawk-api-key": `hawk.${"a".repeat(20)}.${"a".repeat(20)}`,
	"tavily-api-key": `tvly-${"a".repeat(32)}`,
	"teamcity-api-token": `eyJ0eXAiOiAiVENWMiJ9.${"a".repeat(36)}.${"a".repeat(48)}`,
	"truenas-api-key": `1-${"a".repeat(64)}`,
	"vault-recovery-token": `hvr.${"a".repeat(24)}`,
	// ── active ──
	"auth0-application-credentials": [
		"AUTH0_DOMAIN='dev-abc123.us.auth0.com'",
		`AUTH0_CLIENT_ID='${"a".repeat(32)}'`,
		`AUTH0_CLIENT_SECRET='${"a".repeat(40)}'`,
	].join("\n"),
	"aws-api-credentials": `AKIAABCDEFGHIJKLMNOP secret: ${"a".repeat(40)}.`,
	"aws-session-token": `export AWS_SESSION_TOKEN=${"a".repeat(40)};`,
	"azure-storage-connection-string": `DefaultEndpointsProtocol=https;AccountName=testaccount;AccountKey=${"a".repeat(24)}==;BlobEndpoint=http://x`,
	"django-secret-key": `# SECURITY WARNING: keep the secret key used in production secret!\nSECRET_KEY = '${"a".repeat(20)}'`,
	"generic-password-quoted": `password = "s3cret-value"`,
	"generic-password-stated": `the default password is 's3cret'`,
	"gitalk-oauth-credentials": `new Gitalk({ clientID: '0123456789abcdef0123', clientSecret: '${"a".repeat(40)}',`,
	"google-oauth-credentials": `client_id '123456789012-aabbccddeeffgghhiiijjkkkllmmnnnn.apps.googleusercontent.com', client_secret: ${"a".repeat(24)};`,
	"gradle-hardcoded-credentials": `credentials {\n username 'user'\n password 'pass1234'\n}`,
	"http-basic-auth": `Authorization: Basic QWxhZGRpbjpvcGVu`,
	"http-bearer-token": `Authorization: Bearer npm_${"a".repeat(36)}`,
	"jenkins-token-or-crumb": `jenkins_token = ${"a".repeat(32)};`,
	"kagi-api-key": `my kagi key: abcde123456.${"a".repeat(43)}`,
	"kubernetes-bootstrap-token": `bootstrap token abcdef.${"a".repeat(16)}`,
	"mongodb-connection-string": `mongodb://user:passw0rd@cluster0.example.net/`,
	"netrc-credentials": `machine example.com login myuser password s3cret-value`,
	"odbc-connection-string": `User=myuser; Pwd=s3cret;`,
	"particleio-access-token": `curl https://api.particle.io/v1/devices -d access_token=${"a".repeat(40)}`,
	"phpmailer-credentials": `$mail->Host = 'smtp.example.com';\n$mail->Username = 'user@example.com';\n$mail->Password = 's3cret';`,
	"postgres-connection-uri": `postgresql://dbuser:s3cret@db.example.com:5432/app`,
	"postmark-api-token": `X-Postmark-Server-Token: 01234567-89ab-cdef-0123-456789abcdef`,
	"psexec-invocation-credentials": `psexec \\\\srv -u administrator -p Sup3rSecret!`,
	"react-app-password": `REACT_APP_API_PASSWORD=s3cret-value`,
	"sauce-token": `sauce access key: 01234567-89ab-cdef-0123-456789abcdef`,
	"thingsboard-access-token": `https://thingsboard.cloud/api/v1/${"a".repeat(20)}`,
	"vmware-viserver-credentials": `Connect-VIServer -Server vcenter.example.com -User administrator -Password s3cret`,
	"wireguard-preshared-key": `PresharedKey = ${"a".repeat(43)}=`,
	"wireguard-private-key": `PrivateKey = ${"a".repeat(43)}=`,
};

// ──────────────────────────── provenance ────────────────────────────

describe("NOSEY_PARKER_UPSTREAM", () => {
	it("records the upstream licence and version", () => {
		assert.equal(NOSEY_PARKER_UPSTREAM.licence, "MIT OR Apache-2.0");
		assert.match(NOSEY_PARKER_UPSTREAM.version, /^v\d+\.\d+\.\d+$/);
		assert.ok(NOSEY_PARKER_UPSTREAM.source.startsWith("https://github.com/praetorian-inc/noseyparker"));
	});
});

// ──────────────────────────── rule catalogue ────────────────────────────

describe("NOSEY_PARKER_RULES", () => {
	it("every pattern is global (matchAll requires it)", () => {
		for (const r of NOSEY_PARKER_RULES) {
			assert.ok(r.pattern.global, `rule ${r.id} must have the g flag`);
		}
	});

	it("every rule has a unique id, a known severity, and a known confidence", () => {
		const ids = new Set<string>();
		for (const r of NOSEY_PARKER_RULES) {
			assert.ok(!ids.has(r.id), `duplicate rule id ${r.id}`);
			ids.add(r.id);
			assert.ok(["medium", "high", "critical"].includes(r.severity));
			assert.ok(r.confidence === undefined || ["passive", "active"].includes(r.confidence));
		}
	});

	it("declares both passive and active rules", () => {
		const passive = NOSEY_PARKER_RULES.filter((r) => (r.confidence ?? "passive") === "passive");
		const active = NOSEY_PARKER_RULES.filter((r) => r.confidence === "active");
		assert.ok(passive.length > 0, "the passive tier must not be empty");
		assert.ok(active.length > 0, "the active tier must not be empty");
	});

	it("every ported rule has a fixture, and the fixture matches its own rule", () => {
		assert.equal(Object.keys(FIXTURES).length, NOSEY_PARKER_RULES.length, "one fixture per ported rule");
		for (const rule of NOSEY_PARKER_RULES) {
			const sample = FIXTURES[rule.id];
			assert.ok(sample, `rule ${rule.id} has no fixture`);
			const re = new RegExp(rule.pattern.source, rule.pattern.flags);
			assert.ok(re.test(sample), `rule ${rule.id} should match its own fixture: ${sample}`);
		}
	});

	it("every rule's secret is exactly one capture group (group 1)", () => {
		// The shared engine reads group 1 as the secret; any additional capturing
		// group would shift it and corrupt the fingerprint. Backslash-escaped
		// literals and character classes are stripped before counting so literal
		// `(` inside them doesn't count.
		for (const r of NOSEY_PARKER_RULES) {
			const source = r.pattern.source.replace(/\\./g, "..").replace(/\[[^\]]*\]/g, "[]");
			const opens = (source.match(/\(/g) ?? []).length;
			const nonCapturing = (source.match(/\(\?[:=]/g) ?? []).length;
			assert.ok(opens - nonCapturing === 1, `rule ${r.id} must have exactly one capturing group`);
		}
	});

	it("captures the credential, not the surrounding context, for active rules", () => {
		// Spot-check the capture invariant: the captured group must be the secret
		// alone, never the keyword or binder around it.
		const bearer = FIXTURES["http-bearer-token"]!;
		const re = new RegExp(
			NOSEY_PARKER_RULES.find((r) => r.id === "http-bearer-token")!.pattern.source,
			NOSEY_PARKER_RULES.find((r) => r.id === "http-bearer-token")!.pattern.flags,
		);
		const m = re.exec(bearer)!;
		assert.ok(m);
		assert.equal(m[1], `npm_${"a".repeat(36)}`, "the bearer value, not the header, is captured");
		assert.ok(m[0].length > m[1].length, "the whole match includes the context");
	});
});

// ──────────────────────────── confidence model ────────────────────────────

describe("passive/active confidence", () => {
	it("ranks active above passive", () => {
		assert.ok(CONFIDENCE_RANK.active > CONFIDENCE_RANK.passive);
		assert.ok(meetsMinConfidence("active", "passive"));
		assert.ok(meetsMinConfidence("passive", "passive"));
		assert.ok(!meetsMinConfidence("passive", "active"));
	});

	it("the default config floor is passive (everything reported)", () => {
		assert.equal(DEFAULT_NOSEY_PARKER_CONFIG.minConfidence, "passive");
	});

	it("minConfidence=active filters out passive-rule matches", () => {
		const messages: MessageRow[] = [
			msg({ id: "u1", role: "user", content_text: FIXTURES["groq-api-key"] }), // passive
			msg({ id: "u2", role: "user", content_text: FIXTURES["wireguard-private-key"] }), // active
		];
		const all = detectNoseyParkerLeaks(messages, DEFAULT_NOSEY_PARKER_CONFIG);
		const ids = new Set(all.leaks.map((l) => l.rule_id));
		assert.ok(ids.has("groq-api-key"));
		assert.ok(ids.has("wireguard-private-key"));
		assert.equal(all.leaks.find((l) => l.rule_id === "groq-api-key")!.confidence, "passive");
		assert.equal(all.leaks.find((l) => l.rule_id === "wireguard-private-key")!.confidence, "active");

		const activeOnly = detectNoseyParkerLeaks(messages, {
			...DEFAULT_NOSEY_PARKER_CONFIG,
			minConfidence: "active",
		});
		const activeIds = new Set(activeOnly.leaks.map((l) => l.rule_id));
		assert.ok(activeIds.has("wireguard-private-key"), "active matches survive the floor");
		assert.ok(!activeIds.has("groq-api-key"), "passive matches are below an active floor");
	});
});

// ──────────────────────────── detection ────────────────────────────

describe("matchedNoseyParkerRuleIds", () => {
	it("detects each ported provider rule by shape", () => {
		for (const [id, sample] of Object.entries(FIXTURES)) {
			assert.ok(matchedNoseyParkerRuleIds(sample).includes(id), `expected ${id} to match its fixture`);
		}
	});

	it("does not match ordinary prose", () => {
		const prose = [
			"please add a unit test for the new helper",
			"reset my password tomorrow and retry the deploy",
			"the mongodb cluster hosts the staging database",
			"curl the endpoint with a Bearer token from the vault",
			"npm install and rubygems update finished cleanly",
			"connect to the vmware esxi host and list the machines",
		];
		for (const p of prose) {
			assert.deepEqual(matchedNoseyParkerRuleIds(p), [], `ordinary prose should not match: ${p}`);
		}
	});

	it("active rules require their confirming context, not a bare value", () => {
		// A bare 43-char base64 string must not match the WireGuard rule; the
		// PrivateKey assignment line must.
		const bare = `the key material is ${"a".repeat(43)}= in the config`;
		assert.ok(!matchedNoseyParkerRuleIds(bare).includes("wireguard-private-key"));
		assert.ok(matchedNoseyParkerRuleIds(FIXTURES["wireguard-private-key"]!).includes("wireguard-private-key"));
	});
});

describe("detectNoseyParkerLeaks", () => {
	it("finds leaks across all four message fields and records message ids", () => {
		const messages: MessageRow[] = [
			msg({ id: "u1", role: "user", content_text: `my token is ${FIXTURES["groq-api-key"]}` }),
			msg({ id: "a1", role: "assistant", content_thinking: `I will use ${FIXTURES["nuget-api-key"]} for this` }),
			msg({
				id: "a2",
				role: "assistant",
				tool_calls: JSON.stringify([{ name: "bash", arguments: { command: `echo ${FIXTURES["tavily-api-key"]}` } }]),
			}),
			msg({
				id: "t1",
				role: "toolResult",
				tool_results: JSON.stringify([{ toolName: "bash", isError: false, textLength: 9, text: FIXTURES["wireguard-private-key"] }]),
			}),
		];
		const res = detectNoseyParkerLeaks(messages, DEFAULT_NOSEY_PARKER_CONFIG);

		const ruleIds = new Set(res.leaks.map((l) => l.rule_id));
		assert.ok(ruleIds.has("groq-api-key"), "groq key in content_text");
		assert.ok(ruleIds.has("nuget-api-key"), "nuget key in content_thinking");
		assert.ok(ruleIds.has("tavily-api-key"), "tavily key in tool_calls");
		assert.ok(ruleIds.has("wireguard-private-key"), "wireguard key in tool_results");

		const msgIds = new Set(res.leaks.map((l) => l.message_id));
		assert.ok(msgIds.has("u1") && msgIds.has("a1") && msgIds.has("a2") && msgIds.has("t1"));
		assert.deepEqual(res.affected_message_ids, ["a1", "a2", "t1", "u1"]);
	});

	it("never stores the full matched secret in a finding", () => {
		const secret = FIXTURES["groq-api-key"]!;
		const messages: MessageRow[] = [
			msg({ id: "u1", role: "user", content_text: `token: ${secret}` }),
		];
		const res = detectNoseyParkerLeaks(messages, DEFAULT_NOSEY_PARKER_CONFIG);
		assert.equal(res.leaks.length, 1);
		const finding = res.leaks[0]!;
		const blob = JSON.stringify(finding);
		assert.ok(!blob.includes(secret), "full secret must not be in the finding");
		assert.ok(!blob.includes(secret.slice(4, -4)), "middle of secret must not be in the finding");
		assert.equal(finding.match_length, secret.length);
		assert.match(finding.fingerprint, /^[0-9a-f]{16}$/);
	});

	it("fingerprints the captured credential, not the whole match, for capture rules", () => {
		// The bearer rule captures the token; the fingerprint must equal the
		// fingerprint of the bare token, not of the full header line.
		const token = `npm_${"a".repeat(36)}`;
		const messages: MessageRow[] = [
			msg({ id: "u1", role: "user", content_text: `Authorization: Bearer ${token}` }),
		];
		const res = detectNoseyParkerLeaks(messages, DEFAULT_NOSEY_PARKER_CONFIG);
		const finding = res.leaks.find((l) => l.rule_id === "http-bearer-token")!;
		assert.ok(finding, "bearer rule should match");
		assert.equal(finding.fingerprint, fingerprintOf(token));
		assert.equal(finding.match_length, token.length);
	});

	it("derives the same fingerprint as secret-leak and gitleaks for a value all three match", () => {
		// Single-proposal-per-leak contract: every detector must fingerprint a
		// shared match identically so the synthesiser can collapse across
		// detectors. The bearer header carries an npm token, which all three
		// catalogues match (nosey-parker captures it; the others match it whole).
		const token = `npm_${"a".repeat(36)}`;
		const line = `Authorization: Bearer ${token}`;
		const messages: MessageRow[] = [msg({ id: "u1", role: "user", content_text: line })];

		const np = detectNoseyParkerLeaks(messages, DEFAULT_NOSEY_PARKER_CONFIG);
		const gitleaks = detectGitleaksLeaks(messages, {
			disabledRules: [],
			allowFingerprints: [],
			allowPatterns: [],
			maxMatchesPerField: 50,
			minSeverity: "medium",
		});
		const secretLeak = detectSecretLeaks(messages, {
			disabledRules: [],
			allowFingerprints: [],
			allowPatterns: [],
			maxMatchesPerField: 50,
			minSeverity: "medium",
		});

		// secret-leak has no npm rule; use its stripe rule against a bearer line
		// carrying a stripe key for the three-way check instead.
		const stripe = `sk_live_${"0".repeat(24)}`;
		const stripeMessages: MessageRow[] = [
			msg({ id: "u1", role: "user", content_text: `Authorization: Bearer ${stripe}` }),
		];
		const npStripe = detectNoseyParkerLeaks(stripeMessages, DEFAULT_NOSEY_PARKER_CONFIG);
		const gitleaksStripe = detectGitleaksLeaks(stripeMessages, {
			disabledRules: [],
			allowFingerprints: [],
			allowPatterns: [],
			maxMatchesPerField: 50,
			minSeverity: "medium",
		});
		const secretLeakStripe = detectSecretLeaks(stripeMessages, {
			disabledRules: [],
			allowFingerprints: [],
			allowPatterns: [],
			maxMatchesPerField: 50,
			minSeverity: "medium",
		});

		const n = npStripe.leaks.find((l) => l.rule_id === "http-bearer-token");
		const g = gitleaksStripe.leaks.find((l) => l.rule_id === "stripe-access-token");
		const s = secretLeakStripe.leaks.find((l) => l.rule_id === "stripe_live_secret_key");
		assert.ok(n && g && s, "all three detectors should flag the stripe key in the bearer header");
		assert.equal(n.fingerprint, s.fingerprint, "nosey-parker and secret-leak fingerprints must agree");
		assert.equal(n.fingerprint, g.fingerprint, "nosey-parker and gitleaks fingerprints must agree");
		assert.equal(n.redacted_preview, s.redacted_preview);
		assert.equal(n.match_length, stripe.length);

		// And the npm-token line: nosey-parker and gitleaks both flag it.
		const n2 = np.leaks.find((l) => l.rule_id === "http-bearer-token");
		const g2 = gitleaks.leaks.find((l) => l.rule_id === "npm-access-token");
		assert.ok(n2 && g2, "both detectors should flag the npm token in the bearer header");
		assert.equal(n2.fingerprint, g2.fingerprint, "fingerprints must agree across detectors");
	});

	it("honors disabledRules with ported kebab-case rule ids", () => {
		const messages: MessageRow[] = [
			msg({ id: "u1", role: "user", content_text: FIXTURES["groq-api-key"] }),
		];
		const res = detectNoseyParkerLeaks(messages, {
			...DEFAULT_NOSEY_PARKER_CONFIG,
			disabledRules: ["groq-api-key"],
		});
		assert.equal(res.leak_count, 0);
	});

	it("honors a fingerprint allowlist without storing the raw secret", () => {
		const secret = FIXTURES["groq-api-key"]!;
		const fp = fingerprintOf(secret);
		const messages: MessageRow[] = [
			msg({ id: "u1", role: "user", content_text: secret }),
		];
		const res = detectNoseyParkerLeaks(messages, {
			...DEFAULT_NOSEY_PARKER_CONFIG,
			allowFingerprints: [fp],
		});
		assert.equal(res.leak_count, 0);
		assert.equal(res.allowlisted_matches, 1);
	});

	it("honors a pattern allowlist by shape", () => {
		const messages: MessageRow[] = [
			msg({ id: "u1", role: "user", content_text: FIXTURES["groq-api-key"] }),
		];
		const res = detectNoseyParkerLeaks(messages, {
			...DEFAULT_NOSEY_PARKER_CONFIG,
			allowPatterns: ["^gsk_a+$"],
		});
		assert.equal(res.leak_count, 0);
		assert.equal(res.allowlisted_matches, 1);
	});

	it("honors minSeverity=critical (drops high/medium)", () => {
		const messages: MessageRow[] = [
			msg({ id: "u1", role: "user", content_text: FIXTURES["groq-api-key"] }), // critical
			msg({ id: "u2", role: "user", content_text: FIXTURES["nuget-api-key"] }), // high
			msg({ id: "u3", role: "user", content_text: FIXTURES["aws-appsync-api-key"] }), // medium
		];
		const res = detectNoseyParkerLeaks(messages, { ...DEFAULT_NOSEY_PARKER_CONFIG, minSeverity: "critical" });
		const ids = new Set(res.leaks.map((l) => l.rule_id));
		assert.ok(ids.has("groq-api-key"));
		assert.ok(!ids.has("nuget-api-key"), "nuget is high, below critical floor");
		assert.ok(!ids.has("aws-appsync-api-key"), "appsync is medium, below critical floor");
	});

	it("caps matches per field and counts the truncation", () => {
		const text = new Array(60).fill(FIXTURES["groq-api-key"]).join(" ");
		const messages: MessageRow[] = [msg({ id: "u1", role: "user", content_text: text })];
		const res = detectNoseyParkerLeaks(messages, { ...DEFAULT_NOSEY_PARKER_CONFIG, maxMatchesPerField: 5 });
		assert.equal(res.leaks.length, 5);
		assert.ok(res.truncated_matches > 0, "truncation should be recorded");
	});

	it("clean session produces zero leaks", () => {
		const messages: MessageRow[] = [
			msg({ id: "u1", role: "user", content_text: "please refactor the helpers" }),
			msg({ id: "a1", role: "assistant", content_text: "sure, splitting them by concern" }),
		];
		const res = detectNoseyParkerLeaks(messages, DEFAULT_NOSEY_PARKER_CONFIG);
		assert.equal(res.leak_count, 0);
		assert.deepEqual(res.affected_message_ids, []);
	});
});

const GROQ_KEY = FIXTURES["groq-api-key"]!;

// redact/fingerprintOf are shared with the other detectors; spot-check the
// re-exports.
describe("shared redaction helpers", () => {
	it("redact never exposes the middle of a credential", () => {
		const r = redact(GROQ_KEY);
		assert.ok(r.startsWith("gsk_"));
		assert.ok(r.includes("…"));
		assert.ok(!r.includes(GROQ_KEY.slice(4, -4)));
	});

	it("fingerprintOf is stable 16-hex and value-sensitive", () => {
		assert.match(fingerprintOf("abc"), /^[0-9a-f]{16}$/);
		assert.notEqual(fingerprintOf("abc"), fingerprintOf("abd"));
	});
});
