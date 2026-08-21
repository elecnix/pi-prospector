/**
 * Gitleaks rule catalogue, ported for in-process session scanning.
 *
 * Provenance: the rules below are ported from gitleaks' maintained detection
 * catalogue (`config/gitleaks.toml`), upstream version **v8.25.0**
 * (the config's declared `minVersion`), licensed **Apache-2.0**.
 * Source: https://github.com/gitleaks/gitleaks/blob/v8.25.0/config/gitleaks.toml
 * The upstream licence is recorded here per the repo's provenance rules; the
 * rules are re-expressed as plain TypeScript `RegExp` entries in the shared
 * `SecretLeakRule` shape (see `../secret-scanner.ts`). No subprocess and no
 * gitleaks binary — the catalogue runs deterministically in-process.
 *
 * This is a representative, high-signal subset (~90 of the ~220 upstream
 * rules), biased towards prefix-anchored provider tokens and the
 * assignment-context rules gitleaks uses for providers whose tokens carry no
 * distinctive prefix. The catalogue is structured for incremental growth:
 * prefix rules are plain entries; context rules are one call to the
 * `contextRule` helper, which reproduces gitleaks' shared
 * `keyword … assignment-operator … value` preamble verbatim. Adding a rule is
 * therefore one entry — port more upstream rules as gaps are observed.
 *
 * Deliberate deviations from upstream, all precision-preserving:
 * - **Entropy checks are not ported.** gitleaks gates some rules on Shannon
 *   entropy of the match; this repo's detectors deliberately avoid bare
 *   entropy heuristics on session text, and every ported rule keeps a
 *   structural anchor (prefix, length, or provider keyword + assignment
 *   context) without it.
 * - **Pure false-positive bait is dropped.** Upstream alternatives that match
 *   any bare value of a given shape in session text — the sourcegraph rule's
 *   bare 40-hex branch, the vault rule's short `s.<24 chars>` branch, and the
 *   generic-api-key rule — are omitted; only their prefix-anchored branches
 *   are ported. `generic-api-key` in particular is unmanageable outside a
 *   repository diff context.
 * - **`(?-i:…)` inline flag groups** (unsupported by JavaScript RegExp) are
 *   approximated: where upstream pins one character or literal to
 *   case-sensitive inside an otherwise case-insensitive pattern, the port
 *   either rewrites the pattern with explicit character classes (exact) or
 *   accepts case-insensitivity for that fragment (widening, noted per rule).
 * - **Rules secret-leak already covers are not re-ported.** The hand-written
 *   `secret-leak` catalogue (AWS keys, GitHub tokens, Google API keys, Slack
 *   tokens, GitLab PAT, Stripe live keys, Anthropic/OpenAI keys, PEM private
 *   keys, signed JWTs) already matches those formats with equal or tighter
 *   patterns; both detectors run over the same fields, so re-porting them
 *   would only double the findings the downstream synthesiser must collapse.
 * - Rule ids keep the upstream kebab-case ids so a `disabledRules` entry maps
 *   1:1 onto gitleaks documentation.
 */

import type { SecretLeakRule } from "../secret-scanner.js";

/** Upstream provenance, asserted by tests so it cannot silently rot. */
export const GITLEAKS_UPSTREAM = {
	/** Upstream project. */
	project: "gitleaks",
	/** Upstream config version the port was taken from. */
	version: "v8.25.0",
	/** Licence of the upstream rule catalogue. */
	licence: "Apache-2.0",
	/** Upstream config file the rules were ported from. */
	source: "https://github.com/gitleaks/gitleaks/blob/v8.25.0/config/gitleaks.toml",
} as const;

// ──────────────────────────── context-rule helper ────────────────────────────

/*
 * gitleaks' shared assignment-context preamble, verbatim: a provider keyword
 * within 50 chars, up to 20 filler chars, then an assignment operator
 * (`=`, `:`, `=>`, …), then up to 5 quote/space chars, then the value, then a
 * delimiter tail. The whole pattern is case-insensitive (upstream `(?i)`).
 * `provider` and `value` are regex fragments; **neither may contain a
 * capturing group** — the value is captured by the single wrapping group, so
 * the finding's fingerprint covers exactly the credential.
 */
const ASSIGN_OP = "(?:=|>|:{1,3}=|\\|\\||:|=>|\\?=|,)";
const VALUE_PAD = "[\\x60'\"\\s=]{0,5}";
const TAIL = "(?:[\\x60'\"\\s;]|\\\\[nr]|$)";

function contextPattern(provider: string, value: string): RegExp {
	return new RegExp(
		`[\\w.-]{0,50}?(?:${provider})(?:[ \\t\\w.-]{0,20})[\\s'"]{0,3}${ASSIGN_OP}${VALUE_PAD}(${value})${TAIL}`,
		"gi",
	);
}

function contextRule(
	id: string,
	label: string,
	severity: SecretLeakRule["severity"],
	provider: string,
	value: string,
): SecretLeakRule {
	return { id, label, severity, pattern: contextPattern(provider, value) };
}

// ──────────────────────────── rule catalogue ────────────────────────────

/**
 * The ported gitleaks catalogue. Ordered: prefix-anchored rules first
 * (grouped by provider alphabetically), then assignment-context rules.
 */
export const GITLEAKS_RULES: readonly SecretLeakRule[] = [
	// ── prefix-anchored: the token format itself is distinctive ──

	{
		id: "1password-service-account-token",
		label: "1Password Service Account Token",
		severity: "critical",
		pattern: /\bops_eyJ[a-zA-Z0-9+/]{250,}={0,3}/g,
	},
	{
		id: "age-secret-key",
		label: "Age Secret Key",
		severity: "high",
		// Upstream relies on the keyword gate for anchoring; the leading \b
		// replaces it. Bech32 alphabet, uppercase only (upstream is case-sensitive).
		pattern: /\bAGE-SECRET-KEY-1[QPZRY9X8GF2TVDW0S3JN54KHCE6MUA7L]{58}/g,
	},
	{
		id: "atlassian-api-token",
		label: "Atlassian API Token",
		severity: "critical",
		// Direct `ATATT3` prefix branch only; upstream's keyword+context branch
		// needs `(?-i:…)` groups and adds little over this anchor.
		pattern: /\bATATT3[A-Za-z0-9_\-=]{186}/g,
	},
	{
		id: "cloudflare-origin-ca-key",
		label: "Cloudflare Origin CA Key",
		severity: "high",
		pattern: /\bv1\.0-[a-f0-9]{24}-[a-f0-9]{146}/g,
	},
	{
		id: "databricks-api-token",
		label: "Databricks API Token",
		severity: "high",
		pattern: /\bdapi[a-f0-9]{32}(?:-\d)?/g,
	},
	{
		id: "digitalocean-access-token",
		label: "DigitalOcean OAuth Access Token",
		severity: "critical",
		pattern: /\bdoo_v1_[a-f0-9]{64}/g,
	},
	{
		id: "digitalocean-pat",
		label: "DigitalOcean Personal Access Token",
		severity: "critical",
		pattern: /\bdop_v1_[a-f0-9]{64}/g,
	},
	{
		id: "duffel-api-token",
		label: "Duffel API Token",
		severity: "high",
		pattern: /\bduffel_(?:test|live)_[a-z0-9_\-=]{43}/gi,
	},
	{
		id: "dynatrace-api-token",
		label: "Dynatrace API Token",
		severity: "high",
		pattern: /\bdt0c01\.[a-z0-9]{24}\.[a-z0-9]{64}/gi,
	},
	{
		id: "easypost-api-token",
		label: "Easypost API Token",
		severity: "medium",
		pattern: /\bEZAK[a-z0-9]{54}\b/gi,
	},
	{
		id: "easypost-test-api-token",
		label: "Easypost Test API Token",
		severity: "medium",
		pattern: /\bEZTK[a-z0-9]{54}\b/gi,
	},
	{
		id: "flutterwave-encryption-key",
		label: "Flutterwave Encryption Key",
		severity: "medium",
		pattern: /\bFLWSECK_TEST-[a-h0-9]{12}\b/gi,
	},
	{
		id: "flutterwave-public-key",
		label: "Flutterwave Public Key",
		severity: "medium",
		pattern: /\bFLWPUBK_TEST-[a-h0-9]{32}-X\b/gi,
	},
	{
		id: "flutterwave-secret-key",
		label: "Flutterwave Secret Key",
		severity: "medium",
		pattern: /\bFLWSECK_TEST-[a-h0-9]{32}-X\b/gi,
	},
	{
		id: "flyio-access-token",
		label: "Fly.io Access Token",
		severity: "high",
		// `fo1_` branch only; the `fm1/fm2` base64 branches are dropped as
		// bare-high-entropy bait on session text.
		pattern: /\bfo1_[\w-]{43}\b/g,
	},
	{
		id: "frameio-api-token",
		label: "Frame.io API Token",
		severity: "high",
		pattern: /\bfio-u-[a-z0-9\-_=]{64}/gi,
	},
	{
		id: "gitlab-cicd-job-token",
		label: "GitLab CI/CD Job Token",
		severity: "high",
		pattern: /\bglcbt-[0-9a-zA-Z]{1,5}_[0-9a-zA-Z_-]{20}/g,
	},
	{
		id: "gitlab-deploy-token",
		label: "GitLab Deploy Token",
		severity: "high",
		pattern: /\bgldt-[0-9a-zA-Z_\-]{20}/g,
	},
	{
		id: "gitlab-feature-flag-client-token",
		label: "GitLab Feature Flag Client Token",
		severity: "medium",
		pattern: /\bglffct-[0-9a-zA-Z_\-]{20}/g,
	},
	{
		id: "gitlab-feed-token",
		label: "GitLab Feed Token",
		severity: "medium",
		pattern: /\bglft-[0-9a-zA-Z_\-]{20}/g,
	},
	{
		id: "gitlab-incoming-mail-token",
		label: "GitLab Incoming Mail Token",
		severity: "medium",
		pattern: /\bglimt-[0-9a-zA-Z_\-]{25}/g,
	},
	{
		id: "gitlab-kubernetes-agent-token",
		label: "GitLab Kubernetes Agent Token",
		severity: "medium",
		pattern: /\bglagent-[0-9a-zA-Z_\-]{50}/g,
	},
	{
		id: "gitlab-oauth-app-secret",
		label: "GitLab OAuth App Secret",
		severity: "high",
		pattern: /\bgloas-[0-9a-zA-Z_\-]{64}/g,
	},
	{
		id: "gitlab-ptt",
		label: "GitLab Pipeline Trigger Token",
		severity: "high",
		pattern: /\bglptt-[0-9a-f]{40}/g,
	},
	{
		id: "gitlab-rrt",
		label: "GitLab Runner Registration Token",
		severity: "high",
		pattern: /\bGR1348941[\w-]{20}/g,
	},
	{
		id: "gitlab-runner-authentication-token",
		label: "GitLab Runner Authentication Token",
		severity: "high",
		pattern: /\bglrt-[0-9a-zA-Z_\-]{20}/g,
	},
	{
		id: "gitlab-scim-token",
		label: "GitLab SCIM Token",
		severity: "high",
		pattern: /\bglsoat-[0-9a-zA-Z_\-]{20}/g,
	},
	{
		id: "gitlab-session-cookie",
		label: "GitLab Session Cookie",
		severity: "medium",
		pattern: /_gitlab_session=[0-9a-z]{32}/g,
	},
	{
		id: "grafana-service-account-token",
		label: "Grafana Service Account Token",
		severity: "high",
		pattern: /\bglsa_[A-Za-z0-9]{32}_[A-Fa-f0-9]{8}\b/g,
	},
	{
		id: "hashicorp-tf-api-token",
		label: "HashiCorp Terraform Cloud API Token",
		severity: "high",
		// Upstream pins `atlasv1` case-sensitive inside a case-insensitive
		// pattern; rewritten with explicit classes so the literal stays exact.
		pattern: /\b[a-zA-Z0-9]{14}\.atlasv1\.[a-zA-Z0-9\-_=]{60,70}/g,
	},
	{
		id: "huggingface-access-token",
		label: "Hugging Face Access Token",
		severity: "high",
		pattern: /\bhf_[a-zA-Z]{34}\b/g,
	},
	{
		id: "infracost-api-token",
		label: "Infracost API Token",
		severity: "medium",
		pattern: /\bico-[a-zA-Z0-9]{32}\b/g,
	},
	{
		id: "linear-api-key",
		label: "Linear API Key",
		severity: "high",
		pattern: /\blin_api_[a-z0-9]{40}\b/gi,
	},
	{
		id: "maxmind-license-key",
		label: "MaxMind License Key",
		severity: "medium",
		pattern: /\b[A-Za-z0-9]{6}_[A-Za-z0-9]{29}_mmk\b/g,
	},
	{
		id: "microsoft-teams-webhook",
		label: "Microsoft Teams Webhook",
		severity: "high",
		pattern: /https:\/\/[a-z0-9]+\.webhook\.office\.com\/webhookb2\/[a-z0-9]{8}-(?:[a-z0-9]{4}-){3}[a-z0-9]{12}@[a-z0-9]{8}-(?:[a-z0-9]{4}-){3}[a-z0-9]{12}\/IncomingWebhook\/[a-z0-9]{32}\/[a-z0-9]{8}-(?:[a-z0-9]{4}-){3}[a-z0-9]{12}/gi,
	},
	{
		id: "notion-api-token",
		label: "Notion API Token",
		severity: "high",
		// Upstream splits the tail 32+3; the run is contiguous, so one class.
		pattern: /\bntn_[0-9]{11}[A-Za-z0-9]{35}\b/g,
	},
	{
		id: "npm-access-token",
		label: "npm Access Token",
		severity: "high",
		pattern: /\bnpm_[a-z0-9]{36}\b/gi,
	},
	{
		id: "perplexity-api-key",
		label: "Perplexity API Key",
		severity: "critical",
		pattern: /\bpplx-[a-zA-Z0-9]{48}\b/g,
	},
	{
		id: "planetscale-api-token",
		label: "PlanetScale API Token",
		severity: "high",
		pattern: /\bpscale_tkn_[\w=\.-]{32,64}/g,
	},
	{
		id: "postman-api-token",
		label: "Postman API Token",
		severity: "high",
		pattern: /\bPMAK-[a-f0-9]{24}-[a-f0-9]{34}\b/g,
	},
	{
		id: "prefect-api-token",
		label: "Prefect API Token",
		severity: "medium",
		pattern: /\bpnu_[a-zA-Z0-9]{36}\b/g,
	},
	{
		id: "pypi-upload-token",
		label: "PyPI Upload Token",
		severity: "high",
		pattern: /\bpypi-AgEIcHlwaS5vcmc[\w-]{50,1000}/g,
	},
	{
		id: "pulumi-api-token",
		label: "Pulumi API Token",
		severity: "high",
		pattern: /\bpul-[a-f0-9]{40}\b/g,
	},
	{
		id: "readme-api-token",
		label: "ReadMe API Token",
		severity: "medium",
		pattern: /\brdme_[a-z0-9]{70}\b/g,
	},
	{
		id: "rubygems-api-token",
		label: "RubyGems API Token",
		severity: "medium",
		pattern: /\brubygems_[a-f0-9]{48}\b/g,
	},
	{
		id: "scalingo-api-token",
		label: "Scalingo API Token",
		severity: "medium",
		pattern: /\btk-us-[\w-]{48}\b/g,
	},
	{
		id: "sendgrid-api-token",
		label: "SendGrid API Token",
		severity: "critical",
		// Upstream pins `SG` uppercase (`(?i)` starts after it); rewritten with
		// explicit classes instead of the `i` flag to keep that exact.
		pattern: /\bSG\.[a-zA-Z0-9=_\-.]{66}/g,
	},
	{
		id: "sendinblue-api-token",
		label: "Sendinblue API Token",
		severity: "high",
		pattern: /\bxkeysib-[a-f0-9]{64}-[a-z0-9]{16}\b/gi,
	},
	{
		id: "sentry-org-token",
		label: "Sentry Org Token",
		severity: "critical",
		pattern: /\bsntrys_eyJpYXQiO[a-zA-Z0-9+/]{10,200}(?:LCJyZWdpb25fdXJs|InJlZ2lvbl91cmwi|cmVnaW9uX3VybCI6)[a-zA-Z0-9+/]{10,200}={0,2}_[a-zA-Z0-9+/]{43}/g,
	},
	{
		id: "sentry-user-token",
		label: "Sentry User Token",
		severity: "high",
		pattern: /\bsntryu_[a-f0-9]{64}\b/g,
	},
	{
		id: "shippo-api-token",
		label: "Shippo API Token",
		severity: "medium",
		pattern: /\bshippo_(?:live|test)_[a-fA-F0-9]{40}\b/g,
	},
	{
		id: "shopify-access-token",
		label: "Shopify Access Token",
		severity: "critical",
		pattern: /\bshpat_[a-fA-F0-9]{32}\b/g,
	},
	{
		id: "shopify-custom-access-token",
		label: "Shopify Custom App Access Token",
		severity: "high",
		pattern: /\bshpca_[a-fA-F0-9]{32}\b/g,
	},
	{
		id: "shopify-private-app-access-token",
		label: "Shopify Private App Access Token",
		severity: "high",
		pattern: /\bshppa_[a-fA-F0-9]{32}\b/g,
	},
	{
		id: "shopify-shared-secret",
		label: "Shopify Shared Secret",
		severity: "high",
		pattern: /\bshpss_[a-fA-F0-9]{32}\b/g,
	},
	{
		id: "sourcegraph-access-token",
		label: "Sourcegraph Access Token",
		severity: "high",
		// `sgp_` branches only; upstream's bare 40-hex branch is pure
		// false-positive bait on session text and is deliberately not ported.
		pattern: /\bsgp_(?:[a-fA-F0-9]{16}|local)_[a-fA-F0-9]{40}\b|\bsgp_[a-fA-F0-9]{40}\b/g,
	},
	{
		id: "square-access-token",
		label: "Square Access Token",
		severity: "critical",
		pattern: /\b(?:EAAA|sq0atp-)[\w-]{22,60}\b/g,
	},
	{
		id: "stripe-access-token",
		label: "Stripe Access Token (test and publishable scopes)",
		severity: "high",
		// Complements secret-leak's live-only stripe rules with the test/prod
		// scope gitleaks matches; test keys are still credentials worth flagging.
		pattern: /\b(?:sk|rk)_(?:test|live|prod)_[a-zA-Z0-9]{10,99}\b/g,
	},
	{
		id: "twilio-api-key",
		label: "Twilio API Key",
		severity: "high",
		pattern: /\bSK[0-9a-fA-F]{32}\b/g,
	},
	{
		id: "typeform-api-token",
		label: "Typeform API Token",
		severity: "medium",
		pattern: /\btfp_[a-z0-9\-_\.=]{59}\b/gi,
	},
	{
		id: "vault-batch-token",
		label: "Vault Batch Token",
		severity: "high",
		pattern: /\bhvb\.[\w-]{138,300}/g,
	},
	{
		id: "vault-service-token",
		label: "Vault Service Token",
		severity: "critical",
		// `hvs.` branch only; upstream's short `s.<24 chars>` branch matches
		// ordinary prose fragments and is deliberately not ported.
		pattern: /\bhvs\.[\w-]{90,120}\b/g,
	},

	// ── assignment-context: provider keyword + `= value` (gitleaks' shared
	//    preamble via `contextRule`) — for providers whose tokens carry no
	//    distinctive prefix ──

	contextRule("algolia-api-key", "Algolia API Key", "medium", "algolia", "[a-z0-9]{32}"),
	contextRule("cohere-api-token", "Cohere API Token", "high", "cohere|co_api_key", "[a-zA-Z0-9]{40}"),
	contextRule("codecov-access-token", "Codecov Access Token", "medium", "codecov", "[a-z0-9]{32}"),
	contextRule("coinbase-access-token", "Coinbase Access Token", "high", "coinbase", "[a-z0-9_-]{64}"),
	contextRule(
		"contentful-delivery-api-token",
		"Contentful Delivery API Token",
		"medium",
		"contentful",
		"[a-z0-9=_\\-]{43}",
	),
	contextRule("discord-api-token", "Discord API Token", "high", "discord", "[a-f0-9]{64}"),
	contextRule("droneci-access-token", "DroneCI Access Token", "medium", "droneci", "[a-z0-9]{32}"),
	contextRule("fastly-api-token", "Fastly API Token", "medium", "fastly", "[a-z0-9=_\\-]{32}"),
	contextRule("finnhub-access-token", "Finnhub Access Token", "medium", "finnhub", "[a-z0-9]{20}"),
	contextRule(
		"gocardless-api-token",
		"GoCardless API Token",
		"high",
		"gocardless",
		"live_[a-z0-9\\-_=]{40}",
	),
	contextRule(
		"heroku-api-key",
		"Heroku API Key",
		"high",
		"heroku",
		"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
	),
	contextRule(
		"hubspot-api-key",
		"HubSpot API Key",
		"high",
		"hubspot",
		"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
	),
	contextRule("intercom-api-key", "Intercom API Key", "high", "intercom", "[a-z0-9=_\\-]{60}"),
	contextRule("jfrog-api-key", "JFrog API Key", "high", "jfrog|artifactory|bintray|xray", "[a-z0-9]{73}"),
	contextRule("jfrog-identity-token", "JFrog Identity Token", "high", "jfrog|artifactory|bintray|xray", "[a-z0-9]{64}"),
	contextRule("kraken-access-token", "Kraken Access Token", "high", "kraken", "[a-z0-9/=_+\\-]{80,90}"),
	contextRule("launchdarkly-access-token", "Launchdarkly Access Token", "high", "launchdarkly", "[a-z0-9=_\\-]{40}"),
	contextRule("lob-api-key", "Lob API Key", "high", "lob", "(?:live|test)_[a-f0-9]{35}"),
	contextRule("mailchimp-api-key", "Mailchimp API Key", "high", "mailchimp", "[a-f0-9]{32}-us\\d\\d"),
	contextRule("mailgun-private-api-token", "Mailgun Private API Token", "high", "mailgun", "key-[a-f0-9]{32}"),
	contextRule(
		"mailgun-signing-key",
		"Mailgun Signing Key",
		"medium",
		"mailgun",
		"[a-h0-9]{32}-[a-h0-9]{8}-[a-h0-9]{8}",
	),
	contextRule("mapbox-api-token", "Mapbox API Secret Token", "medium", "mapbox", "pk\\.[a-z0-9]{60}\\.[a-z0-9]{22}"),
	contextRule("mattermost-access-token", "Mattermost Access Token", "medium", "mattermost", "[a-z0-9]{26}"),
	contextRule("messagebird-api-token", "MessageBird API Token", "medium", "message[_-]?bird", "[a-z0-9]{25}"),
	contextRule("netlify-access-token", "Netlify Access Token", "high", "netlify", "[a-z0-9=_\\-]{40,46}"),
	contextRule("new-relic-browser-api-token", "New Relic Browser API Token", "medium", "new-relic|newrelic|new_relic", "NRJS-[a-f0-9]{19}"),
	contextRule("new-relic-insert-key", "New Relic Insert Key", "medium", "new-relic|newrelic|new_relic", "NRII-[a-z0-9-]{32}"),
	contextRule("new-relic-user-api-key", "New Relic User API Key", "high", "new-relic|newrelic|new_relic", "NRAK-[a-z0-9]{27}"),
	contextRule("okta-access-token", "Okta Access Token", "critical", "okta", "00[\\w=\\-]{40}"),
	contextRule(
		"plaid-api-token",
		"Plaid API Token",
		"high",
		"plaid",
		"access-(?:sandbox|development|production)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
	),
	contextRule("plaid-client-id", "Plaid Client ID", "medium", "plaid", "[a-z0-9]{24}"),
	contextRule("plaid-secret-key", "Plaid Secret Key", "high", "plaid", "[a-z0-9]{30}"),
	contextRule("privateai-api-token", "PrivateAI API Token", "medium", "private[_-]?ai", "[a-z0-9]{32}"),
	contextRule("rapidapi-access-token", "RapidAPI Access Token", "medium", "rapidapi", "[a-z0-9_-]{50}"),
	contextRule("sendbird-access-token", "Sendbird Access Token", "medium", "sendbird", "[a-f0-9]{40}"),
	contextRule("sentry-access-token", "Sentry Access Token (legacy)", "high", "sentry", "[a-f0-9]{64}"),
	contextRule(
		"snyk-api-token",
		"Snyk API Token",
		"high",
		"snyk[_.-]?(?:(?:api|oauth)[_.-]?)?(?:key|token)",
		"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
	),
	contextRule(
		"sonar-api-token",
		"SonarQube API Token",
		"high",
		"sonar[_.-]?(?:login|token)",
		"(?:squ_|sqp_|sqa_)?[a-z0-9=_\\-]{40}",
	),
	contextRule(
		"squarespace-access-token",
		"Squarespace Access Token",
		"medium",
		"squarespace",
		"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
	),
	contextRule("sumologic-access-token", "SumoLogic Access Token", "high", "sumo", "[a-z0-9]{64}"),
	contextRule(
		"telegram-bot-api-token",
		"Telegram Bot API Token",
		"critical",
		"telegr",
		// Upstream pins the `A` after the colon case-sensitive via `(?-i:A)`;
		// JavaScript has no scoped flags, so the port widens to either case.
		"[0-9]{5,16}:A[a-zA-Z0-9_\\-]{34}",
	),
	contextRule("travisci-access-token", "Travis CI Access Token", "medium", "travis", "[a-z0-9]{22}"),
	contextRule("twitch-api-token", "Twitch API Token", "medium", "twitch", "[a-z0-9]{30}"),
	contextRule("twitter-bearer-token", "Twitter Bearer Token", "high", "twitter", "A{22}[a-zA-Z0-9%]{80,100}"),
	contextRule(
		"yandex-access-token",
		"Yandex Access Token",
		"high",
		"yandex",
		"t1\\.[A-Za-z0-9_-]+={0,2}\\.[A-Za-z0-9_-]{86}={0,2}",
	),
	contextRule("yandex-api-key", "Yandex API Key", "high", "yandex", "AQVN[A-Za-z0-9_\\-]{35,38}"),
	contextRule("zendesk-secret-key", "Zendesk Secret Key", "medium", "zendesk", "[a-z0-9]{40}"),
];
