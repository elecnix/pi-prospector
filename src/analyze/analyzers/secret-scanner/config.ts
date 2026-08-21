/**
 * Configuration for the SecretScanner-style container/filesystem evidence
 * detector analyzer.
 *
 * Everything here is part of the config fingerprint, so changing it produces a
 * new config identity and, on a run that includes the `config` reason, new
 * node versions (old nodes preserved as lineage).
 *
 * Allowlists are **fingerprint/shape-based by design**: a user never pastes a
 * real secret into config (config is content-addressed and stored in the
 * analysis graph — storing a secret there would be the very leak this
 * analyzer exists to catch). `allowFingerprints` uses the same short SHA-256
 * fingerprint the analyzer records for a match; `allowPatterns` matches by
 * shape regex against the matched value.
 */

import { Type, type Static } from "typebox";
import { ARTIFACT_KINDS } from "./extractors.js";
import { ARTIFACT_CATALOGUE_RULE_IDS, STRUCTURAL_RULE_ID } from "./detectors.js";

export const SecretScannerConfigSchema = Type.Object({
	/**
	 * Rule ids to skip entirely. Ids are either this analyzer's structural rule
	 * (`artifact-sensitive-name`) or any catalogue rule family id from the
	 * bundled detector catalogues — see `ARTIFACT_CATALOGUE_RULES` in
	 * detectors.ts.
	 */
	disabledRules: Type.Array(Type.String()),
	/**
	 * Extraction toggle: Dockerfile instructions (`ENV`/`ARG`) and compose
	 * environment sections.
	 */
	extractDockerfiles: Type.Boolean(),
	/** Extraction toggle: `.env`/dotenv entries. */
	extractDotenv: Type.Boolean(),
	/** Extraction toggle: `docker build` output and `--build-arg` flags. */
	extractBuildLogs: Type.Boolean(),
	/** Extraction toggle: CI-log env evidence (`::set-env`, workflow env blocks). */
	extractCiLogs: Type.Boolean(),
	/** Extraction toggle: shell export blocks and profile snippets. */
	extractShellExports: Type.Boolean(),
	/**
	 * Regex source tested against each candidate's variable name for the
	 * structural check (case-insensitive). A name matching this pattern whose
	 * value has credential shape is reported even when no catalogue rule
	 * matches. Tune to widen/narrow name sensitivity — never to allowlist a
	 * specific secret (use `allowFingerprints`/`allowPatterns` for that).
	 */
	sensitiveNamePattern: Type.String(),
	/** Minimum value length for the structural credential-shape check. */
	minCredentialLength: Type.Integer({ minimum: 8 }),
	/**
	 * Short SHA-256 fingerprints (16 hex chars) of matched values to ignore,
	 * e.g. a committed test fixture token. Never put the raw secret here —
	 * config is persisted in the graph. The fingerprint is what the analyzer
	 * stores for a match, so it can be copied from an existing finding.
	 */
	allowFingerprints: Type.Array(Type.String()),
	/**
	 * Regex source strings tested against a matched value; a match is ignored.
	 * Use this for shape-based allowlisting (e.g. `"^example"`), never for a
	 * literal secret.
	 */
	allowPatterns: Type.Array(Type.String()),
	/**
	 * Maximum matches recorded per message field (after allowlisting). Bounds
	 * node size for a pathological field; extra survivors are counted in
	 * `truncated_matches` but not listed.
	 */
	maxMatchesPerField: Type.Integer({ minimum: 1 }),
});
export type SecretScannerConfig = Static<typeof SecretScannerConfigSchema>;

/**
 * Default structural name-sensitivity pattern: variable names that speak of
 * credentials. Word-ish segments so `KEY` inside `MONKEY` does not match.
 */
export const DEFAULT_SENSITIVE_NAME_PATTERN =
	"TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|AUTH|CREDENTIAL|BEARER|CLIENT_?SECRET|ENCRYPTION_?KEY|SIGNING_?KEY|SERVICE_?ACCOUNT";

export const DEFAULT_SECRET_SCANNER_CONFIG: SecretScannerConfig = {
	disabledRules: [],
	extractDockerfiles: true,
	extractDotenv: true,
	extractBuildLogs: true,
	extractCiLogs: true,
	extractShellExports: true,
	sensitiveNamePattern: DEFAULT_SENSITIVE_NAME_PATTERN,
	minCredentialLength: 16,
	allowFingerprints: [],
	allowPatterns: [],
	maxMatchesPerField: 50,
};

/**
 * Validate config-facing ids so a typo fails loudly (errors thrown with
 * messages, no silent catches). Artifact kinds are validated too because the
 * extraction toggles are booleans — this guards future per-kind config.
 */
export function assertKnownRuleIds(config: SecretScannerConfig): void {
	const known = new Set<string>([STRUCTURAL_RULE_ID, ...ARTIFACT_CATALOGUE_RULE_IDS]);
	for (const id of config.disabledRules) {
		if (!known.has(id)) {
			throw new Error(
				`secret-scanner: unknown rule id '${id}' in disabledRules (known ids: structural '${STRUCTURAL_RULE_ID}' plus ${known.size - 1} catalogue rule families)`,
			);
		}
	}
}

/** True when every artifact kind's extractor is disabled (nothing can be found). */
export function allExtractorsDisabled(config: SecretScannerConfig): boolean {
	return ARTIFACT_KINDS.every((kind) => {
		switch (kind) {
			case "dockerfile":
			case "compose":
				return !config.extractDockerfiles;
			case "dotenv":
				return !config.extractDotenv;
			case "build-log":
				return !config.extractBuildLogs;
			case "ci-log":
				return !config.extractCiLogs;
			case "shell-export":
				return !config.extractShellExports;
		}
	});
}
