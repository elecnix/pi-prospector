/**
 * Nosey Parker rule catalogue, ported for in-process session scanning.
 *
 * Provenance: the rules below are ported from Nosey Parker's built-in ruleset
 * (`crates/noseyparker/data/default/builtin/rules`), upstream version
 * **v0.24.0**, licensed **MIT OR Apache-2.0**. Source:
 * https://github.com/praetorian-inc/noseyparker/tree/v0.24.0/crates/noseyparker/data/default/builtin/rules
 * The upstream licence is recorded here per the repo's provenance rules; the
 * rules are re-expressed as plain TypeScript `RegExp` entries in the shared
 * `SecretLeakRule` shape (see `../secret-scanner.ts`), extended with the
 * `confidence` field that models Nosey Parker's passive/active distinction.
 * No subprocess and no binary — the catalogue runs deterministically
 * in-process.
 *
 * What the port keeps from upstream:
 * - **Per-rule captures.** Nosey Parker's defining trait: the *secret* is a
 *   capture group inside a larger match, so the fingerprint covers exactly
 *   the credential, not its surrounding context. The shared engine already
 *   reads group 1 as the secret; every rule here captures it.
 * - **Passive/active confidence.** `confidence: "active"` marks rules that
 *   need confirming context (a keyword, an assignment, an auth header) —
 *   stronger evidence than a bare structural match. A config floor
 *   (`minConfidence`) can raise the bar to active-only.
 *
 * Deliberate deviations from upstream, all precision-preserving:
 * - **Free-spacing and inline flags are rewritten.** Upstream patterns use
 *   Rust regex `(?x)` / `(?i)` / `(?s)` and `(?# …)` comments; JavaScript
 *   RegExp expresses these as flags (`i`, `s`) and expanded whitespace.
 * - **Multi-capture rules are re-captured to group 1.** Upstream rules that
 *   capture a credential pair (e.g. Azure `AccountName` + `AccountKey`)
 *   capture the *secret* as their final group. The shared engine reads group
 *   1, so the port makes every non-secret group non-capturing. The finding
   * therefore fingerprints exactly the secret, as upstream's capture would.
 * - **Pure false-positive bait is dropped.** Bare-shape branches that only
 *   work in a repository-diff context — the ThingsBoard bare 20-char
 *   provision rules, the LinkedIn and Facebook fuzzy keyword+32-char rules —
 *   are omitted; only their context-anchored siblings are ported where they
 *   exist.
 * - **Identifier-only rules are dropped.** AWS S3 buckets, ARNs, Google
 *   client IDs and age *recipient* keys name a resource, not a credential.
 * - **Rules secret-leak or gitleaks already cover are not re-ported** (AWS
 *   access-key IDs and secret keys, GitHub tokens, Google `AIza` keys, Slack,
 *   Stripe, GitLab, Anthropic, OpenAI, PEM, JWT, and the ~90 gitleaks rules —
 *   see `../gitleaks/rules.ts` for the covered list). Both detectors run over
 *   the same fields, so re-porting them would only double the findings the
 *   downstream synthesiser must collapse.
 * - **Quote-variant pairs are merged.** Where upstream splits a rule only on
 *   the quote character (`np.generic.5`/`.6`, `.11`/`.12`), the port keeps
 *   one entry matching either quote; ids note the upstream pairs.
 * - Upstream rule ids keep their `np.<service>.<n>` form in each rule's
 *   `label` provenance comment; the catalogue ids are kebab-case, matching
 *   the other detectors, so a `disabledRules` entry maps 1:1.
 *
 * The catalogue is structured for incremental growth: passive rules are plain
 * entries; active rules are plain entries carrying `confidence: "active"`.
 * Adding a rule is one entry — port more upstream rules as gaps are observed.
 */

import type { SecretLeakRule } from "../secret-scanner.js";

/** Upstream provenance, asserted by tests so it cannot silently rot. */
export const NOSEY_PARKER_UPSTREAM = {
	/** Upstream project. */
	project: "noseyparker",
	/** Upstream release the port was taken from. */
	version: "v0.24.0",
	/** Licence of the upstream ruleset (dual-licensed). */
	licence: "MIT OR Apache-2.0",
	/** Upstream rules directory the rules were ported from. */
	source:
		"https://github.com/praetorian-inc/noseyparker/tree/v0.24.0/crates/noseyparker/data/default/builtin/rules",
} as const;

// ──────────────────────────── rule catalogue ────────────────────────────

/**
 * The ported Nosey Parker catalogue. Ordered: passive rules first (structure
 * alone, grouped by provider alphabetically), then active rules (confirming
 * context required).
 */
export const NOSEY_PARKER_RULES: readonly SecretLeakRule[] = [
	// ── passive: the token format itself is distinctive ──

	// np.adafruit.1
	{
		id: "adafruit-io-key",
		label: "Adafruit IO Key",
		severity: "high",
		pattern: /\b(aio_[a-zA-Z0-9]{28})\b/g,
	},
	// np.adobe.1 — upstream is case-insensitive; kept.
	{
		id: "adobe-client-secret",
		label: "Adobe OAuth Client Secret",
		severity: "high",
		pattern: /\b(p8e-[a-z0-9-]{32})(?:[^a-z0-9-]|$)/gi,
	},
	// np.appsync.1
	{
		id: "aws-appsync-api-key",
		label: "AWS AppSync API Key",
		severity: "medium",
		pattern: /\b(da2-[a-z0-9]{26})\b/g,
	},
	// np.aws.5
	{
		id: "amazon-mws-auth-token",
		label: "Amazon MWS Auth Token",
		severity: "high",
		pattern: /(amzn\.mws\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi,
	},
	// np.dockerhub.1
	{
		id: "dockerhub-personal-access-token",
		label: "Docker Hub Personal Access Token",
		severity: "high",
		pattern: /\b(dckr_pat_[a-zA-Z0-9_-]{27})(?:$|[^a-zA-Z0-9_-])/g,
	},
	// np.doppler.1
	{
		id: "doppler-cli-token",
		label: "Doppler CLI Token",
		severity: "critical",
		pattern: /\b(dp\.ct\.[a-zA-Z0-9]{40,44})\b/g,
	},
	// np.doppler.2
	{
		id: "doppler-personal-token",
		label: "Doppler Personal Token",
		severity: "critical",
		pattern: /\b(dp\.pt\.[a-zA-Z0-9]{40,44})\b/g,
	},
	// np.doppler.3
	{
		id: "doppler-service-token",
		label: "Doppler Service Token",
		severity: "critical",
		pattern: /\b(dp\.st\.(?:[a-z0-9\-_]{2,35}\.)?[a-zA-Z0-9]{40,44})\b/g,
	},
	// np.doppler.4
	{
		id: "doppler-service-account-token",
		label: "Doppler Service Account Token",
		severity: "critical",
		pattern: /\b(dp\.sa\.[a-zA-Z0-9]{40,44})\b/g,
	},
	// np.doppler.5
	{
		id: "doppler-scim-token",
		label: "Doppler SCIM Token",
		severity: "critical",
		pattern: /\b(dp\.scim\.[a-zA-Z0-9]{40,44})\b/g,
	},
	// np.doppler.6
	{
		id: "doppler-audit-token",
		label: "Doppler Audit Token",
		severity: "critical",
		pattern: /\b(dp\.audit\.[a-zA-Z0-9]{40,44})\b/g,
	},
	// np.dropbox.1
	{
		id: "dropbox-access-token",
		label: "Dropbox Access Token",
		severity: "critical",
		pattern: /\b(sl\.[a-zA-Z0-9_-]{130,152})(?:$|[^a-zA-Z0-9_-])/g,
	},
	// np.facebook.2
	{
		id: "facebook-access-token",
		label: "Facebook Access Token",
		severity: "high",
		pattern: /\b(EAACEdEose0cBA[a-zA-Z0-9]+)\b/g,
	},
	// np.figma.1 — the UUID-shaped key material alone is too generic; the
	// `figma` keyword within 20 chars is the confirming context.
	{
		id: "figma-personal-access-token",
		label: "Figma Personal Access Token",
		severity: "high",
		confidence: "active",
		pattern:
			/figma.{0,20}\b([0-9a-f]{4}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi,
	},
	// np.firecrawl.1
	{
		id: "firecrawl-api-key",
		label: "Firecrawl API Key",
		severity: "high",
		pattern: /\b(fc-[a-f0-9]{32})\b/g,
	},
	// np.google.2 — the GOCSPX prefix; the context-anchored bare branch
	// (np.google.3) is too loose for session text and is omitted.
	{
		id: "google-oauth-client-secret",
		label: "Google OAuth Client Secret",
		severity: "high",
		pattern: /\b(GOCSPX-[a-zA-Z0-9_-]{28})(?:[^a-zA-Z0-9_-]|$)/g,
	},
	// np.google.4
	{
		id: "google-oauth-access-token",
		label: "Google OAuth Access Token",
		severity: "high",
		pattern: /\b(ya29\.[0-9A-Za-z_-]{20,1024})(?:[^0-9A-Za-z_-]|$)/g,
	},
	// np.groq.1
	{
		id: "groq-api-key",
		label: "Groq API Key",
		severity: "critical",
		pattern: /\b(gsk_[a-zA-Z0-9]{50,54})\b/g,
	},
	// np.hashicorp.6 — the hvs./hvb. vault tokens are gitleaks-covered; the
	// recovery-token prefix is not.
	{
		id: "vault-recovery-token",
		label: "Hashicorp Vault Recovery Token",
		severity: "critical",
		pattern: /\b(hvr\.[A-Za-z0-9]{24,130})(?:[^A-Za-z0-9]|$)/g,
	},
	// np.jina.1
	{
		id: "jina-api-key",
		label: "Jina Search Foundation API Key",
		severity: "high",
		pattern: /\b(jina_[a-zA-Z0-9]{60})\b/g,
	},
	// np.grafana.1 — the `eyJrIjoi` service-token form; gitleaks covers the
	// `glsa_` service-account form.
	{
		id: "grafana-service-token",
		label: "Grafana Service Token",
		severity: "high",
		pattern: /\b(eyJrIjoi[A-Za-z0-9]{60,100})\b/g,
	},
	// np.nuget.1
	{
		id: "nuget-api-key",
		label: "NuGet API Key",
		severity: "high",
		pattern: /\b(oy2[a-z0-9]{43})\b/g,
	},
	// np.pwhash.1
	{
		id: "password-hash-md5crypt",
		label: "Password Hash (md5crypt)",
		severity: "medium",
		pattern: /(\$1\$[./A-Za-z0-9]{8}\$[./A-Za-z0-9]{22})/g,
	},
	// np.pwhash.2
	{
		id: "password-hash-bcrypt",
		label: "Password Hash (bcrypt)",
		severity: "high",
		pattern: /(\$2[abxy]\$\d+\$[./A-Za-z0-9]{53})/g,
	},
	// np.pwhash.3
	{
		id: "password-hash-sha256crypt",
		label: "Password Hash (sha256crypt)",
		severity: "high",
		pattern: /(\$5(?:\$rounds=\d+)?\$[./A-Za-z0-9]{8,16}\$[./A-Za-z0-9]{43})/g,
	},
	// np.pwhash.4
	{
		id: "password-hash-sha512crypt",
		label: "Password Hash (sha512crypt)",
		severity: "high",
		pattern: /(\$6(?:\$rounds=\d+)?\$[./A-Za-z0-9]{8,16}\$[./A-Za-z0-9]{86})/g,
	},
	// np.salesforce.1
	{
		id: "salesforce-access-token",
		label: "Salesforce Access Token",
		severity: "critical",
		pattern: /\b(00[a-zA-Z0-9]{13}![a-zA-Z0-9._]{96})\b/g,
	},
	// np.segment.1 — Segment's `sgp_` 64-char form; gitleaks' sourcegraph rule
	// covers a different 40-char shape on the same prefix.
	{
		id: "segment-public-api-token",
		label: "Segment Public API Token",
		severity: "critical",
		pattern: /\b(sgp_[a-zA-Z0-9]{64})\b/g,
	},
	// np.stackhawk.1
	{
		id: "stackhawk-api-key",
		label: "StackHawk API Key",
		severity: "high",
		pattern: /\b(hawk\.[0-9A-Za-z_-]{20}\.[0-9A-Za-z_-]{20})\b/g,
	},
	// np.tavily.1
	{
		id: "tavily-api-key",
		label: "Tavily API Key",
		severity: "high",
		pattern: /\b(tvly-[a-zA-Z0-9]{32})\b/g,
	},
	// np.teamcity.1 — the literal prefix decodes to `{"typ": "TCV2"}`.
	{
		id: "teamcity-api-token",
		label: "TeamCity API Token",
		severity: "critical",
		pattern: /\b(eyJ0eXAiOiAiVENWMiJ9\.[A-Za-z0-9_-]{36}\.[A-Za-z0-9_-]{48})/g,
	},
	// np.truenas.1 — the REST variant (np.truenas.2) only adds a Bearer
	// keyword; the shape alone is distinctive enough.
	{
		id: "truenas-api-key",
		label: "TrueNAS API Key",
		severity: "high",
		pattern: /(\d+-[a-zA-Z0-9]{64})/g,
	},

	// ── active: confirming context required ──

	// np.auth0.1 — domain and client-id captures made non-capturing; the
	// client secret is the secret.
	{
		id: "auth0-application-credentials",
		label: "Auth0 Application Credentials",
		severity: "critical",
		confidence: "active",
		pattern:
			/(?:AUTH0_DOMAIN|AUTH0_ISSUER_BASE_URL)\s*=\s*['"](?:https?:\/\/)?[a-zA-Z0-9._-]{10,100}['"].{0,100}AUTH0_CLIENT_ID\s*=\s*['"](?:[a-zA-Z0-9]{32})['"].{0,100}AUTH0_CLIENT_SECRET\s*=\s*['"]([a-zA-Z0-9_-]{32,80})['"]/gs,
	},
	// np.aws.4
	{
		id: "aws-session-token",
		label: "AWS Session Token",
		severity: "critical",
		confidence: "active",
		pattern:
			/(?:aws.?session|aws.?session.?token|aws.?token)["'`]?\s{0,30}(?::|=>|=)\s{0,30}["'`]?([a-z0-9/+=]{16,200})[^a-z0-9/+=]/gi,
	},
	// np.aws.6 — the access-key-id capture made non-capturing; the 40-char
	// secret beside it is the secret. (The bare id alone is secret-leak's rule.)
	{
		id: "aws-api-credentials",
		label: "AWS API Credentials",
		severity: "critical",
		confidence: "active",
		pattern:
			/\b(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}\b.{0,40}\b([A-Za-z0-9/+=]{40})(?:[^A-Za-z0-9/+=]|$)/gs,
	},
	// np.azure.1 — the account-name capture made non-capturing; the account
	// key is the secret.
	{
		id: "azure-storage-connection-string",
		label: "Azure Storage Connection String",
		severity: "critical",
		confidence: "active",
		pattern:
			/(?:AccountName|SharedAccessKeyName|SharedSecretIssuer)\s*=\s*[^${;<[.\s"'#][^.;\n"'#]{2,80}\s*;\s*.{0,10}\s*(?:AccountKey|SharedAccessKey|SharedSecretValue)\s*=\s*([a-zA-Z0-9/+]{20,100}={0,3})(?:[^a-zA-Z0-9/+=]|$)/gi,
	},
	// np.django.1 — the generated settings comment is the confirming context.
	{
		id: "django-secret-key",
		label: "Django Secret Key",
		severity: "critical",
		confidence: "active",
		pattern:
			/# SECURITY WARNING: keep the secret key used in production secret!\s*.{0,5}SECRET_KEY\s*=\s*r?["']([^"'\n]{5,100})["']/g,
	},
	// np.gitalk.1 — the client-id capture made non-capturing.
	{
		id: "gitalk-oauth-credentials",
		label: "Gitalk OAuth Credentials",
		severity: "high",
		confidence: "active",
		pattern:
			/\bnew\s+Gitalk\s*\(\s*\{\s*clientID:\s*'(?:[a-f0-9]{20})',\s*clientSecret:\s*'([a-f0-9]{40})',/g,
	},
	// np.google.6 — the client-id capture made non-capturing; the client
	// secret (either branch) is the secret.
	{
		id: "google-oauth-credentials",
		label: "Google OAuth Credentials",
		severity: "high",
		confidence: "active",
		pattern:
			/\b(?:[0-9]+-[a-z0-9_]{32}\.apps\.googleusercontent\.com).{0,40}\b(?:client.?secret.{0,10})?\b((?:GOCSPX-[a-zA-Z0-9_-]{28})|(?:[a-zA-Z0-9_-]{24}))(?:[^a-zA-Z0-9_-]|$)/gs,
	},
	// np.gradle.1 — the username capture made non-capturing; the password is
	// the secret.
	{
		id: "gradle-hardcoded-credentials",
		label: "Hardcoded Gradle Credentials",
		severity: "high",
		confidence: "active",
		pattern:
			/credentials\s*\{(?:\s*\/\/.*)*\s*(?:username|password)\s+['"](?:[^'"]{1,60})['"](?:\s*\/\/.*)*\s*(?:username|password)\s+['"]([^'"]{1,60})['"]/gi,
	},
	// np.http.1 — the base64 of `user:password` is the secret.
	{
		id: "http-basic-auth",
		label: "HTTP Basic Authentication Header",
		severity: "high",
		confidence: "active",
		pattern:
			/Authorization(?:\s*.{1,5}\s*)Basic\s+([A-Za-z0-9+/]{6,}={0,2})(?:[^A-Za-z0-9+/=]|$)/gi,
	},
	// np.http.2 — the bearer value is the secret. Upstream's `[a-zA-z…]`
	// class (a typo that admits `\]^_`) is corrected to `[a-zA-Z…]`.
	{
		id: "http-bearer-token",
		label: "HTTP Bearer Token Header",
		severity: "high",
		confidence: "active",
		pattern:
			/Authorization(?:\s*.{1,5}\s*)Bearer\s+([a-zA-Z0-9._~+/-]{6,}=*)(?:[^a-zA-Z0-9._~+/=-]|$)/gi,
	},
	// np.jenkins.1
	{
		id: "jenkins-token-or-crumb",
		label: "Jenkins Token or Crumb",
		severity: "high",
		confidence: "active",
		pattern:
			/jenkins.{0,12}(?:(?:crumb|token).{0,10})?\b([0-9a-f]{32,36}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})(?:[^0-9a-f-]|$)/gi,
	},
	// np.kagi.1
	{
		id: "kagi-api-key",
		label: "Kagi API Key",
		severity: "high",
		confidence: "active",
		pattern: /(?:kagi|KAGI).{0,100}\b([a-zA-Z0-9_-]{11}\.[a-zA-Z0-9_-]{43})(?:$|[^a-zA-Z0-9_-])/gs,
	},
	// np.kubernetes.1
	{
		id: "kubernetes-bootstrap-token",
		label: "Kubernetes Bootstrap Token",
		severity: "high",
		confidence: "active",
		pattern: /(?:token|Token|TOKEN|bootstrap|BOOTSTRAP).{0,8}\b([a-z0-9]{6}\.[a-z0-9]{16})\b/g,
	},
	// np.mongodb.1 — the username and host captures made non-capturing; the
	// password is the secret.
	{
		id: "mongodb-connection-string",
		label: "Credentials in MongoDB Connection String",
		severity: "critical",
		confidence: "active",
		pattern:
			/(?:mongodb\+srv|mongodb):\/\/[a-zA-Z0-9%;._~!$&'()*+,;=-]{3,}:([a-zA-Z0-9%;._~!$&'()*+,;=-]{3,})@[a-zA-Z0-9_.-]{3,}(?::\d{1,5})?(?:[^a-zA-Z0-9_.-]|$)/g,
	},
	// np.netrc.1 — the machine and login captures made non-capturing.
	{
		id: "netrc-credentials",
		label: "netrc Credentials",
		severity: "high",
		confidence: "active",
		pattern: /(?:machine\s+[^\s]+|default)\s+login\s+(?:[^\s]+)\s+password\s+([^\s]+)/g,
	},
	// np.odbc.1 — the user capture made non-capturing; the password is the
	// secret.
	{
		id: "odbc-connection-string",
		label: "Credentials in ODBC Connection String",
		severity: "high",
		confidence: "active",
		pattern:
			/(?:User|User Id|UserId|Uid)\s*=\s*[^\s;]{3,100}\s*;[\ \t].{0,10}[\ \t]*(?:Password|Pwd)\s*=\s*([^\t ;]{3,100})\s*(?:[;"']|$)/gi,
	},
	// np.particleio.1 — the URL-adjacent variant; the token is the secret.
	{
		id: "particleio-access-token",
		label: "particle.io Access Token",
		severity: "high",
		confidence: "active",
		pattern:
			/https:\/\/api\.particle\.io\/v1\/[a-zA-Z0-9_\-\s/"\\?]*(?:access_token=|Authorization:\s*Bearer\s*)\b([a-zA-Z0-9]{40})\b/g,
	},
	// np.phpmailer.1 — host and username captures made non-capturing; the
	// password is the secret.
	{
		id: "phpmailer-credentials",
		label: "PHPMailer Credentials",
		severity: "high",
		confidence: "active",
		pattern:
			/\$mail->Host\s*=\s*'(?:[^'\n]{5,})';\s*(?:\/\/.*)?(?:\s*.*\s*){0,3}\$mail->Username\s*=\s*'(?:[^'\n]{5,})';\s*(?:\/\/.*)?(?:\s*.*\s*){0,3}\$mail->Password\s*=\s*'([^'\n]{5,})';/g,
	},
	// np.postgres.1 — username and host captures made non-capturing; the
	// password is the secret.
	{
		id: "postgres-connection-uri",
		label: "Credentials in PostgreSQL Connection URI",
		severity: "critical",
		confidence: "active",
		pattern:
			/(?:postgres|postgresql):\/\/[a-zA-Z0-9%;._~!$&'()*+,;=-]{3,}:([a-zA-Z0-9%;._~!$&'()*+,;=-]{3,})@[a-zA-Z0-9_.-]{3,}(?::\d{1,5})?(?:[^a-zA-Z0-9_.-]|$)/g,
	},
	// np.postmark.1
	{
		id: "postmark-api-token",
		label: "Postmark API Token",
		severity: "high",
		confidence: "active",
		pattern:
			/postmark[a-z0-9_-]{0,20}.{0,10}\b([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\b/gi,
	},
	// np.psexec.1 — the username capture made non-capturing.
	{
		id: "psexec-invocation-credentials",
		label: "Credentials in PsExec Invocation",
		severity: "high",
		confidence: "active",
		pattern: /psexec.{0,100}-u\s*(?:\S+)\s+-p\s*(\S+)/gi,
	},
	// np.generic.5 + np.generic.6 — merged: upstream splits only on the quote
	// character.
	{
		id: "generic-password-quoted",
		label: "Generic Password (quoted assignment)",
		severity: "medium",
		confidence: "active",
		pattern:
			/password["']?\s*(?:=|:|:=|=>)\s*["']([^$<%@.,\s+'"(){}&/\#\-][^\s+'"(){}/]{4,})["']/gi,
	},
	// np.generic.11 + np.generic.12 — merged: upstream splits only on the
	// quote character.
	{
		id: "generic-password-stated",
		label: "Generic Password (stated in prose)",
		severity: "medium",
		confidence: "active",
		pattern: /the (?:default )?password is ["']([^'"\n\#$|"{<+()\\][^'"\n]{3,60})["']/gi,
	},
	// np.reactapp.2 — the username variant (np.reactapp.1) names an account,
	// not a credential, and is omitted.
	{
		id: "react-app-password",
		label: "React App Password",
		severity: "high",
		confidence: "active",
		pattern:
			/\bREACT_APP(?:_[A-Z0-9]+)*_PASS(?:WORD)?\s*=\s*['"]?([^\s'"$]{6,})(?:[\s'"$]|$)/g,
	},
	// np.sauce.1
	{
		id: "sauce-token",
		label: "Sauce Token",
		severity: "medium",
		confidence: "active",
		pattern: /sauce.{0,50}\b([a-f0-9-]{36})(?:[^a-f0-9-]|$)/gi,
	},
	// np.thingsboard.1 — the bare 20-char provision rules (np.thingsboard.2/3)
	// are omitted: pure shape, unmanageable outside a diff context.
	{
		id: "thingsboard-access-token",
		label: "ThingsBoard Access Token",
		severity: "high",
		confidence: "active",
		pattern: /thingsboard\.cloud\/api\/v1\/([a-z0-9]{20})/g,
	},
	// np.vmware.1 — the username capture made non-capturing.
	{
		id: "vmware-viserver-credentials",
		label: "Credentials in Connect-VIServer Invocation",
		severity: "high",
		confidence: "active",
		pattern: /Connect-VIServer.{0,50}-User\s+(?:\S{3,30})\s+.{0,50}-Password\s+(\S{3,30})/gi,
	},
	// np.wireguard.1
	{
		id: "wireguard-private-key",
		label: "WireGuard Private Key",
		severity: "critical",
		confidence: "active",
		pattern: /PrivateKey\s*=\s*([A-Za-z0-9+/]{43}=)/g,
	},
	// np.wireguard.2
	{
		id: "wireguard-preshared-key",
		label: "WireGuard Preshared Key",
		severity: "high",
		confidence: "active",
		pattern: /PresharedKey\s*=\s*([A-Za-z0-9+/]{43}=)/g,
	},
];
