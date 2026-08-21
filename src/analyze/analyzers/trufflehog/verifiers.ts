/**
 * The credential-verifier seam — the TruffleHog analyzer's distinctive half.
 *
 * This mirrors the repo's LLM seam exactly (`../pi-llm.ts` vs `../mock-llm.ts`):
 *
 *  - **Production verifiers** (this module) make real network calls to the
 *    provider that issued a candidate credential, asking "does this still
 *    authenticate?". A verified finding is a working credential — a very
 *    different severity from a shape match.
 *  - **Tests** inject deterministic stand-ins built by `mock-verifiers.ts`,
 *    so the suite never touches a network, an API key, or a real credential.
 *
 * Safety properties, all load-bearing:
 *
 *  - **Off by default.** Verification makes network calls to third parties,
 *    which breaks the deterministic offline analysis contract, so it runs only
 *    when config sets `verify: true`. Because config is content-addressed,
 *    enabling it marks prior nodes `stale/config` — the correct, visible
 *    behaviour for a materially different analysis; a plain fill leaves them
 *    alone and `--revise config` recomputes them with the old nodes preserved
 *    as lineage.
 *  - **Each verifier talks only to its own provider.** A candidate value is
 *    sent to exactly one endpoint — the provider whose prefix shape matched —
 *    and nowhere else. No credential is ever logged, stored, or forwarded to
 *    any other party.
 *  - **Never crash, never leak.** Network errors and timeouts resolve to
 *    `{ verified: "unknown" }`; reasons are fixed short labels chosen by this
 *    code from the HTTP status alone. Provider response bodies are never read
 *    into results (they can echo account names or request ids), so a
 *    verification outcome can never carry the credential or anything sensitive.
 */

import { Type, type Static } from "typebox";

// ──────────────────────────── outcome ────────────────────────────

/**
 * The result of one verification attempt. Stored in the metric node beside a
 * finding's redacted preview + fingerprint — never the raw credential.
 */
export const VERIFICATION_OUTCOME_SCHEMA = Type.Object({
	/** `true` = provider accepted it (live credential); `false` = rejected; `"unknown"` = could not determine. */
	verified: Type.Union([Type.Boolean(), Type.Literal("unknown")]),
	/** Fixed short label explaining the verdict — never provider response text. */
	reason: Type.String(),
});
export type VerificationOutcome = Static<typeof VERIFICATION_OUTCOME_SCHEMA>;

// ──────────────────────────── seam ────────────────────────────

/**
 * One provider's live-credential check. Pure-ish: takes the candidate value,
 * returns an outcome; must never throw (network failures resolve to
 * `unknown`, per {@link outcomeForProbe}).
 */
export interface CredentialVerifier {
	/** Stable id used in config (`enabledVerifiers`) and node content. */
	id: string;
	/** Human-readable label. */
	label: string;
	/**
	 * RegExp source tested against a candidate's raw value: a match means this
	 * verifier is the one that knows the issuing provider. Keyed by the
	 * provider's token-prefix shape so any rule that matches such a value is
	 * verifiable, not just this analyzer's own catalogue.
	 */
	appliesTo: string;
	/** Ask the issuing provider whether the value still authenticates. */
	verify(value: string, timeoutMs: number): Promise<VerificationOutcome>;
}

/** Verifier ids shipped in this module, for config validation. */
export const VERIFIER_IDS: readonly string[] = ["github-token", "openai-key", "figma-token"];

// ──────────────────────────── transport ────────────────────────────

/** Minimal structural fetch/response surface, so tests can inject a fake. */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; signal?: AbortSignal }) => Promise<{ status: number }>;

type ProbeResult = { kind: "http"; status: number } | { kind: "timeout" } | { kind: "network-error" };

/**
 * One GET probe. Never throws: transport failures classify as timeout or
 * network-error and become `unknown` outcomes downstream.
 */
async function probe(url: string, headers: Record<string, string>, timeoutMs: number, doFetch: FetchLike): Promise<ProbeResult> {
	try {
		const res = await doFetch(url, {
			method: "GET",
			headers,
			signal: AbortSignal.timeout(timeoutMs),
		});
		return { kind: "http", status: res.status };
	} catch (err) {
		if (err instanceof Error && err.name === "TimeoutError") return { kind: "timeout" };
		return { kind: "network-error" };
	}
}

/**
 * Map a probe to its outcome. Pure — exported for unit tests of the response
 * handling itself. Only the status is consulted; bodies are ignored on purpose.
 */
export function outcomeForProbe(probe: ProbeResult): VerificationOutcome {
	switch (probe.kind) {
		case "timeout":
			return { verified: "unknown", reason: "timeout" };
		case "network-error":
			return { verified: "unknown", reason: "network-error" };
		case "http":
			if (probe.status === 200) return { verified: true, reason: "provider-accepted" };
			if (probe.status === 401 || probe.status === 403) {
				return { verified: false, reason: "provider-rejected" };
			}
			return { verified: "unknown", reason: `http-${probe.status}` };
	}
}

/** The production transport. Kept behind a function so tsc/CI need no DOM lib assumptions. */
function defaultFetch(): FetchLike {
	return (url, init) => globalThis.fetch(url, init as RequestInit);
}

// ──────────────────────────── production verifiers ────────────────────────────

/**
 * The production verifiers — three concrete illustrations of the seam, each a
 * cheap authenticated GET against the provider that issued the credential:
 *
 *  - `github-token`: GitHub PATs via `GET api.github.com/user`.
 *  - `openai-key`: OpenAI keys via the cheap models-list call.
 *  - `figma-token`: Figma PATs via `GET api.figma.com/v1/me` — closes the loop
 *    with this analyzer's own `figma-pat-figd` rule end-to-end.
 *
 * The GitHub and OpenAI shapes are keyed by prefix so they fire on any rule
 * that matches those tokens (this analyzer's own catalogue does not re-port
 * them — secret-leak/gitleaks already do); verifying *sibling detectors'*
 * findings is the future cross-detector synthesiser layer's job, not this
 * analyzer's.
 *
 * `doFetch` is injectable for tests; production uses the platform default.
 */
export function makeProductionVerifiers(doFetch: FetchLike = defaultFetch()): CredentialVerifier[] {
	const fetcher = doFetch;
	return [
		{
			id: "github-token",
			label: "GitHub personal access token (api.github.com/user)",
			appliesTo: "\\bgh[posur]_[A-Za-z0-9]{36,}\\b",
			async verify(value, timeoutMs) {
				const p = await probe("https://api.github.com/user", {
					Authorization: `Bearer ${value}`,
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
					"User-Agent": "pi-prospector-secret-verifier",
				}, timeoutMs, fetcher);
				return outcomeForProbe(p);
			},
		},
		{
			id: "openai-key",
			label: "OpenAI API key (models list)",
			appliesTo: "\\bsk-[A-Za-z0-9_-]{20,}\\b",
			async verify(value, timeoutMs) {
				const p = await probe("https://api.openai.com/v1/models", {
					Authorization: `Bearer ${value}`,
				}, timeoutMs, fetcher);
				return outcomeForProbe(p);
			},
		},
		{
			id: "figma-token",
			label: "Figma personal access token (api.figma.com/v1/me)",
			appliesTo: "\\bfigd_[A-Za-z0-9_-]{30,}\\b",
			async verify(value, timeoutMs) {
				const p = await probe("https://api.figma.com/v1/me", {
					"X-Figma-Token": value,
					"User-Agent": "pi-prospector-secret-verifier",
				}, timeoutMs, fetcher);
				return outcomeForProbe(p);
			},
		},
	];
}

/** The verifiers a production run uses when `verify: true`. */
export const PRODUCTION_VERIFIERS: readonly CredentialVerifier[] = makeProductionVerifiers();
