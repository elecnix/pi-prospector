/**
 * Bundled analyzer registry. `registerDefaults(framework)` wires up the built-in
 * analyzers in dependency order; `registerAll(framework, opts)` additionally
 * discovers and registers locally-authored custom analyzers from disk.
 */

import type { AnalyzerFramework } from "./framework.js";
import type { Analyzer } from "./types.js";
import { loadCustomAnalyzers, type LoadError } from "./loader.js";
import { turnPairCoreAnalyzer } from "./analyzers/turn-pair-core/index.js";
import { turnPairLLMAnalyzer } from "./analyzers/turn-pair-llm/index.js";
import { sessionOverviewAnalyzer } from "./analyzers/session-overview/index.js";
import { toolTrajectoryAnalyzer } from "./analyzers/tool-trajectory/index.js";
import { contextEconomyAnalyzer } from "./analyzers/context-economy/index.js";
import { cacheEconomyAnalyzer } from "./analyzers/cache-economy/index.js";
import { routingOpportunityAnalyzer } from "./analyzers/routing-opportunity/index.js";
import { lexiconCandidatesAnalyzer } from "./analyzers/lexicon-candidates/index.js";
import { frustrationLexiconAnalyzer } from "./analyzers/frustration-lexicon/index.js";
import { turnFrustrationAnalyzer } from "./analyzers/turn-frustration/index.js";
import { secretLeakAnalyzer } from "./analyzers/secret-leak/index.js";
import { gitleaksAnalyzer } from "./analyzers/gitleaks/index.js";
import { noseyParkerAnalyzer } from "./analyzers/nosey-parker/index.js";
import { detectSecretsAnalyzer } from "./analyzers/detect-secrets/index.js";
import { trufflehogAnalyzer } from "./analyzers/trufflehog/index.js";
import { failureModesAnalyzer } from "./analyzers/failure-modes/index.js";
import { tokenUnitsAnalyzer } from "./analyzers/token-units/index.js";
import { requestClassesAnalyzer } from "./analyzers/request-classes/index.js";

export const DEFAULT_ANALYZER_IDS = [
	"turn-pair-core",
	"lexicon-candidates",
	"frustration-lexicon",
	"turn-frustration",
	"turn-pair-llm",
	"tool-trajectory",
	"failure-modes",
	"context-economy",
	"cache-economy",
	"routing-opportunity",
	"secret-leak",
	"gitleaks",
	"nosey-parker",
	"detect-secrets",
	"trufflehog",
	"token-units",
	"request-classes",
	"session-overview",
] as const;

/** The built-in analyzers registered by a plain analyze run, in dependency order. */
export const BUILTIN_ANALYZERS: Analyzer[] = [
	turnPairCoreAnalyzer,
	// The learned frustration lexicon: nominate vocabulary, judge each unseen word
	// once for the whole corpus, then match turns against it. Ordered before
	// turn-pair-llm because a lexicon hit can promote a turn into enrichment.
	lexiconCandidatesAnalyzer,
	frustrationLexiconAnalyzer,
	turnFrustrationAnalyzer,
	turnPairLLMAnalyzer,
	toolTrajectoryAnalyzer,
	// What failed, of every kind. Deterministic and standalone; ordered next to
	// tool-trajectory because the two read the same action stream — one for the
	// shape of the sequence, the other for what went wrong in it.
	failureModesAnalyzer,
	contextEconomyAnalyzer,
	cacheEconomyAnalyzer,
	routingOpportunityAnalyzer,
	// Session-level, standalone, deterministic. Placed before the synthesizer so a
	// future session-overview consumer can declare it as a dependency without
	// reordering. Emits redacted findings only — never the matched secret.
	secretLeakAnalyzer,
	// The ported gitleaks catalogue, same seam as secret-leak: session-level,
	// standalone, deterministic, metric nodes only, redacted findings. Enabled by
	// default; a user narrows it via config (disabledRules / allowlists), never by
	// editing this list. Findings from both detectors carry identically derived
	// fingerprints so the future proposal synthesiser can collapse the same leak
	// into one proposal.
	gitleaksAnalyzer,
	// The ported Nosey Parker catalogue, same seam as the other detectors:
	// session-level, standalone, deterministic, metric nodes only, redacted
	// findings. Its rules capture the credential (so fingerprints cover exactly
	// the secret) and carry a passive/active confidence with a config floor.
	// Enabled by default; a user narrows it via config (disabledRules /
	// minConfidence / allowlists), never by editing this list.
	noseyParkerAnalyzer,
	// The detect-secrets method, same seam as the other detectors: session-level,
	// standalone, deterministic, metric nodes only, redacted findings. Its value
	// is precision on session prose: candidate generators (keyword-context,
	// hex/base64 high-entropy) followed by detect-secrets' false-positive
	// exclusion heuristics (placeholders, documentation URLs, code-sample
	// contexts, sequential/low-entropy strings). Enabled by default; a user
	// narrows it via config (disabledPlugins / disabledFilters / allowlists),
	// never by editing this list.
	detectSecretsAnalyzer,
	// The TruffleHog-style detector, same seam as the other detectors:
	// session-level, standalone, deterministic, metric nodes only, redacted
	// findings. Its catalogue is deliberately small — only self-written patterns
	// no bundled detector matches (TruffleHog is AGPL-3.0; nothing was ported) —
	// and its distinctive half is **opt-in live verification** (`verify: false`
	// by default): when enabled, findings are probed against their issuing
	// provider through the verifier seam, turning a shape match into a confirmed
	// live credential. Enabling it marks prior nodes stale/config, which is the
	// correct visible behaviour for a materially different analysis.
	trufflehogAnalyzer,
	// Cost accounting. token-units is deterministic and depends on nothing;
	// request-classes labels the same request segments it prices. Neither depends
	// on the other — the report joins them at read time, through token-units'
	// outputs, so no dependency edge orders analysis around a rendering concern.
	tokenUnitsAnalyzer,
	requestClassesAnalyzer,
	sessionOverviewAnalyzer,
];

export function registerDefaults(framework: AnalyzerFramework): void {
	for (const a of BUILTIN_ANALYZERS) framework.register(a);
}

export interface RegisterAllOptions {
	/** Built-in analyzers to register first. Defaults to {@link BUILTIN_ANALYZERS}. */
	builtins?: Analyzer[];
	/** Paths (files/dirs) to discover custom analyzers from, in precedence order. */
	paths?: string[];
}

export interface RegisterAllResult {
	/** Ids of the custom analyzers that were successfully registered. */
	customRegistered: string[];
	/** Per-file load/validation failures; the run still proceeds without them. */
	errors: LoadError[];
}

/**
 * Register built-ins, then discover and register locally-authored custom
 * analyzers from `paths`. Built-ins are registered first so a custom analyzer's
 * id can be checked for collision against them. Loading never throws: a bad
 * analyzer is skipped and reported in `errors`.
 */
export async function registerAll(
	framework: AnalyzerFramework,
	opts: RegisterAllOptions = {},
): Promise<RegisterAllResult> {
	const builtins = opts.builtins ?? BUILTIN_ANALYZERS;
	for (const a of builtins) framework.register(a);

	const builtinIds = builtins.map((a) => a.def.id);
	const { loaded, errors } = await loadCustomAnalyzers({ paths: opts.paths ?? [], builtinIds });
	const customRegistered: string[] = [];
	for (const a of loaded) {
		framework.register(a);
		customRegistered.push(a.def.id);
	}
	return { customRegistered, errors };
}
