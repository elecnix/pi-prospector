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
import { assistantCognitionAnalyzer } from "./analyzers/assistant-cognition/index.js";
import { sessionOverviewAnalyzer } from "./analyzers/session-overview/index.js";
import { toolTrajectoryAnalyzer } from "./analyzers/tool-trajectory/index.js";
import { phaseTrajectoryAnalyzer } from "./analyzers/phase-trajectory/index.js";
import { taskToolMismatchAnalyzer } from "./analyzers/task-tool-mismatch/index.js";
import { toolInventoryTaxAnalyzer } from "./analyzers/tool-inventory-tax/index.js";
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
import { secretScannerAnalyzer } from "./analyzers/secret-scanner/index.js";
import { presidioAnalyzer } from "./analyzers/presidio/index.js";
import { piicatcherAnalyzer } from "./analyzers/piicatcher/index.js";
import { dataprofilerAnalyzer } from "./analyzers/dataprofiler/index.js";
import { failureModesAnalyzer } from "./analyzers/failure-modes/index.js";
import { groundedClaimsAnalyzer } from "./analyzers/grounded-claims/index.js";
import { uncompletedLeadsAnalyzer } from "./analyzers/uncompleted-leads/index.js";
import { compressionChecklistAnalyzer } from "./analyzers/compression-checklist/index.js";
import { languageMismatchAnalyzer } from "./analyzers/language-mismatch/index.js";
import { sessionEndingAnalyzer } from "./analyzers/session-ending/index.js";
import { filesInPlayAnalyzer } from "./analyzers/files-in-play/index.js";
import { frictionAccumulationAnalyzer } from "./analyzers/friction-accumulation/index.js";
import { reviveChainsAnalyzer } from "./analyzers/revive-chains/index.js";
import { tokenUnitsAnalyzer } from "./analyzers/token-units/index.js";
import { requestClassesAnalyzer } from "./analyzers/request-classes/index.js";

export const DEFAULT_ANALYZER_IDS = [
	"turn-pair-core",
	"lexicon-candidates",
	"frustration-lexicon",
	"turn-frustration",
	"turn-pair-llm",
	"assistant-cognition",
	"tool-trajectory",
	"phase-trajectory",
	"task-tool-mismatch",
	"failure-modes",
	"grounded-claims",
	"revive-chains",
	"uncompleted-leads",
	"compression-checklist",
	"language-mismatch",
	"session-ending",
	"files-in-play",
	"friction-accumulation",
	"tool-inventory-tax",
	"context-economy",
	"cache-economy",
	"routing-opportunity",
	"secret-leak",
	"gitleaks",
	"nosey-parker",
	"detect-secrets",
	"trufflehog",
	"secret-scanner",
	"presidio",
	"piicatcher",
	"dataprofiler",
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
	// The assistant's own cognitive state, per turn: confusion, indecision, and
	// surprise read from the thinking trace and response text. Depends only on
	// turn-pair-core (it needs the turn construction, not the friction score), so
	// it sits beside the other per-turn LLM analyzer.
	assistantCognitionAnalyzer,
	toolTrajectoryAnalyzer,
	// The plan-compliance twin of the trajectory analyzer (#115): where
	// tool-trajectory reads patterns in the ordered call stream, this maps each
	// turn to a problem-solving phase (navigate/reproduce/patch/validate/other)
	// and detects plan violations — premature patching, skipped validation,
	// never patching, phases out of canonical order — plus prolonged stagnation.
	// Depends on turn-pair-core (the conversation view), reuses tool-trajectory's
	// read-only/mutating arg-parser; deterministic, session-anchored metric node
	// only. Kept beside the other session-level deterministic graders, before the
	// synthesizer, so a future consumer (#121's plan-compliance scores) can
	// declare it as a dependency without reordering.
	phaseTrajectoryAnalyzer,
	// What the task asked for versus what the agent did (#158): the first user
	// message instructs a specific tool/command, that tool was in the session's
	// recorded inventory, yet the agent made zero calls of it and rebuilt the
	// result by hand with many substitute calls. The proposal points at the
	// instructed-but-avoided tool — never at the substitute symptom (redundant
	// reads/greps are context-economy's territory and are not the disease).
	// Deterministic, standalone, session-level; reads the same action stream as
	// the other trajectory-adjacent graders, before the synthesizer.
	taskToolMismatchAnalyzer,
	// What failed, of every kind. Deterministic and standalone; ordered next to
	// tool-trajectory because the two read the same action stream — one for the
	// shape of the sequence, the other for what went wrong in it.
	failureModesAnalyzer,
	// The claim-consistency twin of failure-modes (#100): both read the same
	// action stream, but where failure-modes sees what the tools reported,
	// grounded-claims checks what the agent *claimed* against it — ungrounded
	// claims (a stated fact absent from that turn's tool results) and unacted
	// requests (a concrete request no call in this or the next turn satisfied).
	// Deterministic, turn-anchored metric nodes only (one per signal, anchored to
	// the turn's user message); placed beside the other action-stream readers so
	// a future session-overview consumer can declare it without reordering.
	groundedClaimsAnalyzer,
	// The orchestration-waste twin of failure-modes: both read the same action
	// stream, but where failure-modes sees what broke, revive-chains sees the
	// waste that no single call records — a chain of individually successful
	// revives. Ordered next to it for the same reason.
	reviveChainsAnalyzer,
	// The inverse waste of the trajectory analyzers: valuable work that never
	// happened. Deterministic and standalone (it reads the same action stream as
	// tool-trajectory and failure-modes, for what tool output surfaced vs. what
	// later calls pursued); placed before the synthesizer so a future
	// session-overview consumer can declare it as a dependency without reordering.
	uncompletedLeadsAnalyzer,
	// The compaction-quality twin of context-economy's compaction *timing*
	// analysis (#218): where context-economy prices when a flush fired, this
	// grades what the flush kept. Deterministic, standalone — the compaction
	// boundary is a conversation role, not derived analysis — so it declares no
	// dependency; it reuses uncompleted-leads' pure extractor and matcher over
	// the same action stream (shared functions, no analysis edge).
	compressionChecklistAnalyzer,
	// Language agreement between the user, the agent, and the harness's
	// compaction summaries. Session-level, standalone, deterministic (a
	// Unicode-block script heuristic — no LLM, no new dependencies); placed
	// beside the other compaction-adjacent grader so its findings sit in the
	// same region of the registry.
	languageMismatchAnalyzer,
	// How each session ended — resolved / abandoned / handed-off / errored /
	// the conservative unclear — read deterministically from the transcript tail
	// and the shared action stream (#102). Emits a metric node only: the label
	// is ranking input for downstream synthesis, never a detection gate, so no
	// proposal flows from it. Standalone, deterministic; placed with the other
	// session-level deterministic graders, before the synthesizer, so a future
	// consumer can declare it as a dependency without reordering.
	sessionEndingAnalyzer,
	// Which files each session had in play, and how much it churned over that
	// set — repeated read→edit→read cycling where the agent keeps reopening
	// files it already holds. The waste twin of the file-touch consumers:
	// uncompleted-leads sees files nobody opened, this sees files opened too
	// many times. Session-level, standalone, deterministic (no LLM); reads the
	// same action stream as the trajectory and failure analyzers. Placed with
	// the other session-level deterministic graders, before the synthesizer, so
	// a future consumer can declare it as a dependency without reordering.
	filesInPlayAnalyzer,
	// The session-level accumulator over the per-turn friction signals (#101):
	// consumes turn-pair-core scores, turn-frustration hit weights, and culminating
	// tool-trajectory patterns (all three declared as dependencies — their node
	// outputs ARE this unit's source set), and flags a gradual decline by comparing
	// the first and last window's mean per-turn rate. Session-level, deterministic
	// (no LLM); placed with the other session-level deterministic graders, before
	// the synthesizer, so a future consumer can declare it without reordering.
	frictionAccumulationAnalyzer,
	// The price of what a session merely *carried* (#70): the set difference
	// between the synced tool inventory and the tools actually invoked, with the
	// unused definitions' static prefix cost estimated from per-bucket implied
	// rates across billed turns. The cost-economy sibling of context-economy —
	// that one prices what a session *read*, this prices what it *had available*
	// and never called. Session-level, standalone, deterministic (no LLM); the
	// UNKNOWN-inventory case is skipped, never read as empty. Placed with the
	// other session-level deterministic graders, before the synthesizer.
	toolInventoryTaxAnalyzer,
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
	// The SecretScanner-style container/filesystem evidence detector, same seam
	// as the other detectors: session-level, standalone, deterministic, metric
	// nodes only, redacted findings. Its value is the extraction layer — it
	// recognises which artifact a value lived in (Dockerfile ENV/ARG, compose
	// env blocks, .env entries, build logs, CI logs, shell exports) and detects
	// with the bundled catalogue families plus a structural name/shape check.
	// Implements Deepfence SecretScanner's method only; nothing was vendored.
	// Enabled by default; a user narrows it via config (extraction toggles /
	// disabledRules / allowlists), never by editing this list.
	secretScannerAnalyzer,
	// The Presidio-method PII detector, same seam as the other detectors:
	// session-level, standalone, deterministic, metric nodes only. The first
	// PII detector in the stack (the previous five find credentials): pattern
	// recognizers with mandatory checksum validators (Luhn credit cards, mod-97
	// IBANs), SSN validity rules, and fingerprint-based allow/deny lists.
	// NER (names, addresses) is deferred — v1 is fully deterministic at zero
	// model cost; the recognizer registry is shaped for a later LLM-seam NER
	// recognizer without reshaping config identity. Implements Microsoft
	// Presidio's method only (Apache-2.0); nothing was vendored. Findings carry
	// identically derived fingerprints so the future proposal synthesiser can
	// collapse the same leak into one proposal across detectors.
	presidioAnalyzer,
	// The PIICatcher-method column-semantics PII detector, same seam as the
	// other detectors: session-level, standalone, deterministic, metric nodes
	// only, redacted findings. Its distinctive half is **column semantics**:
	// tabular fragments flowing through sessions (CSV blocks with delimiter
	// sniffing and header inference, JSON arrays of homogeneous records, SQL
	// result tables — box-drawing, pipe-bordered, aligned columns) are
	// segmented into logical columns and each column judged by sampling its
	// values against the recognizer stack shared with presidio (pure functions
	// reused; no analysis dependency declared). A column whose sampled values
	// match sensitive shapes above `sensitivityThreshold` IS a sensitive
	// column — frequency analysis, not repeated row scanning. Implements Tokern
	// PIICatcher's method only (Apache-2.0, verified against upstream; nothing
	// was vendored). Findings carry identically derived fingerprints so the
	// future proposal synthesiser can collapse the same leak into one proposal
	// across detectors.
	piicatcherAnalyzer,
	// The DataProfiler-method tabular file PII detector, same seam as the other
	// detectors: session-level, standalone, deterministic, metric nodes only,
	// redacted findings. Its distinctive half is the **file-profiling path**:
	// where piicatcher reads structured fragments inline, this analyzer profiles
	// the FILES a session read or wrote — a tool call's normalized arguments name
	// a tabular path (.csv/.tsv/.json; binary formats skipped), the paired tool
	// result captured the content (paired by tool-call id through the shared
	// action stream), and header-label inference plus value-distribution
	// validation combine into per-column verdicts. The finding is about the file
	// (path in metadata) anchored to the touching message. Reuses the recognizer
	// stack shared with presidio via piicatcher's pure functions (no analysis
	// dependency declared). Implements Capital One DataProfiler's method only
	// (Apache-2.0, verified against upstream; nothing was vendored). Findings
	// carry identically derived fingerprints so the future proposal synthesiser
	// can collapse the same leak into one proposal across detectors.
	dataprofilerAnalyzer,
	// Cost accounting. token-units is deterministic and depends on nothing;
	// request-classes labels the same request segments it prices. Neither depends
	// on the other — the report joins them at read time, through token-units'
	// outputs, so no dependency edge orders analysis around a rendering concern.
	tokenUnitsAnalyzer,
	requestClassesAnalyzer,
	sessionOverviewAnalyzer,
];

export async function registerDefaults(framework: AnalyzerFramework): Promise<void> {
	for (const a of BUILTIN_ANALYZERS) await framework.register(a);
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
	for (const a of builtins) await framework.register(a);

	const builtinIds = builtins.map((a) => a.def.id);
	const { loaded, errors } = await loadCustomAnalyzers({ paths: opts.paths ?? [], builtinIds });
	const customRegistered: string[] = [];
	for (const a of loaded) {
		await framework.register(a);
		customRegistered.push(a.def.id);
	}
	return { customRegistered, errors };
}
