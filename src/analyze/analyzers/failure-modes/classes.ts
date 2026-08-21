/**
 * The failure-class catalogue: every kind of problem this system can name, what
 * fixes it, and which published extensions address it.
 *
 * This file is the single place where a failure is interpreted. Sync records
 * what the host said, verbatim; the analyzer counts and prices; *this* table is
 * what turns "429: {…}" into "rate limit — the provider refused the call" and
 * into a recommendation. Adding a new kind of problem means adding an entry
 * here, not writing another detector.
 *
 * Three rules hold for every entry, and each exists because the alternative is
 * worse than saying nothing:
 *
 *  1. **The package list is curated in-repo and hand-verified.** A language
 *     model asked to name an npm package will invent one that sounds right, and
 *     a recommendation to install a package that does not exist is a
 *     supply-chain hazard, not a bad suggestion. Every entry below was checked
 *     against the registry: name, version, licence, and stated behaviour. No
 *     analyzer may name a package that is not in this file.
 *  2. **A cause label is safe by construction.** Matched error text is never
 *     copied into the graph — the label written on a node is the fixed string
 *     below, chosen when the matcher was written. Host error text quotes
 *     account names, org names, provider slugs, and request ids; the analysis
 *     graph is durable and widely readable and must not become a second leak
 *     surface. This is the same discipline `secret-leak` follows.
 *  3. **Not every failure is a defect.** An abort is the operator stopping the
 *     agent. It is recorded, counted, and never proposed against.
 */

/** Which of the failure axes a class describes. */
/**
 * The axis a class lives on.
 *
 * `turn` and `tool` are read from the transcript; `child` is read from the
 * subagent artifact metadata (`subagent_runs`), which is the only record a
 * spawn-level child failure ever leaves — the child wrote no messages anywhere.
 */
export type FailureAxis = "turn" | "tool" | "child";

/**
 * What kind of fix a class's remedy is — the axis that keeps a diagnosis from
 * being answered with the wrong kind of prescription.
 *
 * - `extension` — a published package may address the class; only these classes
 *   may produce an install-extension proposal, and only from their curated list.
 * - `environment` — the fix is PATH/install/credential/config on this machine.
 *   No package fixes it, so `buildProposals` must never route one to an
 *   extension target even if someone later pastes extensions into its entry:
 *   recommending an npm package for a missing binary is a plausible-sounding
 *   non-fix.
 * - `prompt` — the fix is what the agent is told: standing instructions,
 *   smaller steps, different anchoring. Expressed as prose guidance only.
 */
export type RemedyKind = "extension" | "environment" | "prompt";

/**
 * A published extension that addresses a failure class.
 *
 * Every field is copied from the registry at curation time, not inferred. The
 * version is the one that was checked — it is evidence of verification, not a
 * pin, and a proposal never tells anyone to install a specific version.
 */
export interface ExtensionCandidate {
	/** The npm package name, exactly as published. */
	pkg: string;
	/** The version verified against the registry when this entry was curated. */
	verifiedVersion: string;
	/** The licence recorded on that version. */
	license: string;
	/** What it does, in one sentence, from the published description. */
	note: string;
}

/**
 * One recognisable cause within a class.
 *
 * `label` is written to the graph; the matched text never is.
 */
export interface FailureMatcher {
	label: string;
	re: RegExp;
}

/**
 * What the analyzer knows about one child run, beyond any error text.
 *
 * Some child failures are only legible from the run's *shape*: every model
 * attempt failing is a fact about the attempt list, not a string in it, and a
 * non-zero exit with no diagnostic at all is a fact about the code. The text
 * matchers still run first, so a specific message names the cause before a
 * structural fact gets the chance.
 */
export interface ChildRunFacts {
	/** The recorded error text, verbatim from the artifact. Empty when none. */
	error: string;
	/** The recorded exit code, or null when the artifact recorded none. */
	exitCode: number | null;
	/** True when at least one model attempt was recorded and none succeeded. */
	allModelAttemptsFailed: boolean;
}

/** A child-run matcher that reads the run's shape rather than its error text. */
export interface ChildRunMatcher {
	label: string;
	matches: (facts: ChildRunFacts) => boolean;
}

export interface FailureClassDef {
	id: string;
	/** Short human-readable name, used in proposal titles. */
	label: string;
	axis: FailureAxis;
	/**
	 * False when the class records something that is not a defect (an operator
	 * abort). Non-actionable classes are counted and shown, never proposed on.
	 */
	actionable: boolean;
	/** Ordered; the first match wins, so put the specific before the general. */
	matchers: FailureMatcher[];
	/**
	 * Matchers tested against the *command that was run*, rather than against
	 * what came back.
	 *
	 * Some failures are only legible from the call. A `grep` that finds nothing
	 * exits non-zero and prints nothing at all — the result carries no evidence
	 * whatsoever, and the only way to know what happened is to look at what was
	 * asked for. A class using these must sit late in the catalogue, so that a
	 * command which *did* report a real error is named by that error first.
	 */
	commandMatchers?: FailureMatcher[];
	/**
	 * Matchers tested against a child run's *shape* (see {@link ChildRunFacts}),
	 * after the text matchers. Only child-axis classes use them.
	 */
	childMatchers?: ChildRunMatcher[];
	/** What kind of fix this class's remedy is. Gates extension proposals. */
	remedyKind: RemedyKind;
	/** What fixes this class without installing anything. */
	remedy: string;
	/** Hand-verified packages that address this class. Empty when none does. */
	extensions: readonly ExtensionCandidate[];
}

// ───────────────────────── verified extension catalogue ─────────────────────────
//
// Verified against the npm registry on 2026-08-20. Grouped by what they
// actually do, because the two groups need different evidence to recommend:
// a repair extension needs malformed tool calls to have happened, a retry
// extension needs the provider to have failed.

/**
 * Extensions for a tool call the host could not *parse* — the generation is
 * already lost, and the only recovery is to ask for it again.
 *
 * Kept apart from the input-repair list below on purpose. These two failures
 * look alike and are not: one happens before any tool exists to receive the
 * call, the other happens when a real tool rejects real arguments. Recommending
 * a retry-the-turn extension for an argument that failed validation would be a
 * recommendation that cannot work.
 */
const TOOL_CALL_PARSE_REPAIR: readonly ExtensionCandidate[] = [
	{
		pkg: "@pedro_klein/pi-auto-retry",
		verifiedVersion: "0.2.0",
		license: "MIT",
		note: "Retries the turn when the model emits an unparseable tool call, asking for smaller edits.",
	},
	{
		pkg: "pi-reasonix",
		verifiedVersion: "1.1.0",
		license: "MIT",
		note: "Cache-first prefix stabilisation, tool-call repair, and cost control.",
	},
];

/** Extensions that fix a tool call's *arguments* before the tool sees them. */
const TOOL_INPUT_REPAIR: readonly ExtensionCandidate[] = [
	{
		pkg: "pi-tool-repair",
		verifiedVersion: "0.2.1",
		license: "MIT",
		note: "Validate-then-repair for common tool-call mistakes (null fields, stringified arrays).",
	},
	{
		pkg: "@r3b1s/pi-repair-layer",
		verifiedVersion: "0.4.3",
		license: "MIT",
		note: "Tool-input repair layer for the built-in tools: validates, then fixes, before dispatch.",
	},
	{
		pkg: "@bacnh85/pi-model-tools",
		verifiedVersion: "0.6.0",
		license: "MIT",
		note: "Tool wrapping with argument repair and defensive handling of model-specific quirks.",
	},
];

/** Extensions that retry or re-route when the provider itself fails. */
const PROVIDER_RETRY: readonly ExtensionCandidate[] = [
	{
		pkg: "@furkanbilgin/pi-retry",
		verifiedVersion: "0.1.2",
		license: "MIT",
		note: "Automatic recovery from transient provider errors — 400, 5xx, rate limits, connection drops.",
	},
	{
		pkg: "@monotykamary/pi-retry",
		verifiedVersion: "0.7.2",
		license: "MIT",
		note: "Retries 400/413 and connection errors.",
	},
	{
		pkg: "@geebos/pi-retry",
		verifiedVersion: "0.0.2",
		license: "MIT",
		note: "Classifies provider-specific and stalled-stream errors for retry, with configurable keys.",
	},
	{
		pkg: "@narumitw/pi-retry",
		verifiedVersion: "0.31.0",
		license: "MIT",
		note: "Retries empty-detail, websocket-limit, and stalled provider errors.",
	},
	{
		pkg: "provider-retry-proxy",
		verifiedVersion: "1.3.0",
		license: "MIT",
		note: "Configurable HTTP retry proxy for LLM providers, with triangular backoff.",
	},
];

/** Extensions that survive a rate limit or quota wall rather than retrying into it. */
const RATE_LIMIT_SURVIVAL: readonly ExtensionCandidate[] = [
	{
		pkg: "pi-pattern-retry",
		verifiedVersion: "0.1.0",
		license: "MIT",
		note: "Keeps sessions alive across provider rate limits, quota exhaustion, and transient auth failures.",
	},
	{
		pkg: "pi-fallback-provider",
		verifiedVersion: "0.0.1",
		license: "MIT",
		note: "Model fallback chain — fails over to another provider instead of stalling.",
	},
	{
		pkg: "@furkanbilgin/pi-retry",
		verifiedVersion: "0.1.2",
		license: "MIT",
		note: "Automatic recovery from transient provider errors, including rate limits.",
	},
];

/** Extensions that reduce what a turn spends before it hits a ceiling. */
const CONTEXT_ECONOMY: readonly ExtensionCandidate[] = [
	{
		pkg: "pi-reasonix",
		verifiedVersion: "1.1.0",
		license: "MIT",
		note: "Cache-first prefix stabilisation, tool-call repair, and cost control.",
	},
];

// ───────────────────────── the catalogue ─────────────────────────
//
// Order matters twice over: classes are tried in order, and within a class the
// matchers are tried in order. Specific message text is matched before generic
// status codes, so "Prompt tokens limit exceeded" reads as a context ceiling
// even though the host wrapped it in a 402.

export const TURN_FAILURE_CLASSES: readonly FailureClassDef[] = [
	{
		id: "aborted",
		label: "aborted",
		axis: "turn",
		remedyKind: "prompt",
		// Someone pressed stop. Counted so the other rates have an honest
		// denominator; never proposed on, because there is nothing to fix.
		actionable: false,
		matchers: [
			{ label: "operation aborted", re: /\b(?:this )?operation was aborted|^operation aborted|^request aborted|^aborted after \d+ retry/i },
		],
		remedy: "No action — an abort is the operator stopping the agent, not a defect.",
		extensions: [],
	},
	{
		id: "malformed-tool-call",
		label: "malformed tool call",
		axis: "turn",
		remedyKind: "extension",
		actionable: true,
		matchers: [
			{ label: "unparseable tool-call JSON", re: /unexpected token|unterminated string|bad control character|invalid json|json parse/i },
			{ label: "tool-call arguments rejected", re: /invalid tool (?:call|input|arguments)|tool_use.*invalid|malformed tool/i },
		],
		remedy:
			"The model emitted a tool call the host could not parse, so the whole generation was discarded. " +
			"Shrink what the model has to emit in one call — smaller edits, fewer arguments — or install a repair extension that retries the call instead of losing the turn.",
		extensions: TOOL_CALL_PARSE_REPAIR,
	},
	{
		id: "context-overflow",
		label: "context ceiling",
		axis: "turn",
		remedyKind: "extension",
		actionable: true,
		matchers: [
			{ label: "prompt token limit exceeded", re: /prompt tokens limit exceeded|context length exceeded|maximum context length|too many tokens/i },
			{ label: "output truncated at the length ceiling", re: /^length$|max_tokens/i },
		],
		remedy:
			"The turn asked for more context than the model would take. Compact earlier, trim what is carried between turns, or route the long turns to a larger-context model.",
		extensions: CONTEXT_ECONOMY,
	},
	{
		id: "rate-limit",
		label: "rate limit",
		axis: "turn",
		remedyKind: "extension",
		actionable: true,
		matchers: [
			{ label: "account usage limit reached", re: /reached your (?:session|weekly|daily|monthly) usage limit|usage limit reached/i },
			{ label: "provider rate limit (429)", re: /^429\b|\brate[ _-]?limit|too many requests/i },
		],
		remedy:
			"The provider refused the call outright. Retrying immediately spends the same wall-clock again; either back off, or fail over to a second provider so the session survives the wall.",
		extensions: RATE_LIMIT_SURVIVAL,
	},
	{
		id: "quota",
		label: "quota or credit exhausted",
		axis: "turn",
		remedyKind: "extension",
		actionable: true,
		matchers: [
			{ label: "insufficient credits", re: /insufficient credits|payment required|^402\b/i },
		],
		remedy:
			"The account ran out of credit mid-session. No extension fixes this — top up, or configure a fallback provider so the run does not stall at the wall.",
		extensions: [
			{
				pkg: "pi-fallback-provider",
				verifiedVersion: "0.0.1",
				license: "MIT",
				note: "Model fallback chain — fails over to another provider instead of stalling.",
			},
		],
	},
	{
		id: "auth",
		label: "authentication",
		axis: "turn",
		// A rejected credential is fixed on this machine — new key, corrected
		// permissions — not by installing anything. Environment, deliberately:
		// routing it to a package would recommend a retry extension that loops.
		remedyKind: "environment",
		actionable: true,
		matchers: [
			{ label: "api key rejected", re: /api key auth failed|invalid api key|unauthorized|^401\b/i },
			{ label: "key lacks permission", re: /permission_error|forbidden|^403\b/i },
		],
		// Deliberately no extensions: retrying a rejected credential just spends
		// the same rejection again. Recommending a retry package here would be
		// worse than saying nothing.
		remedy: "The credential was rejected. Fix the key or its permissions — no retry extension can recover from this, and one that tries will burn the session looping.",
		extensions: [],
	},
	{
		id: "model-unavailable",
		label: "model unavailable",
		axis: "turn",
		remedyKind: "extension",
		actionable: true,
		matchers: [
			{ label: "no endpoint for the requested model", re: /no endpoints found|model not found|^404\b/i },
		],
		remedy: "The configured model has no reachable endpoint. Correct the model id, or configure a fallback chain so an unavailable model does not end the session.",
		extensions: [
			{
				pkg: "pi-fallback-provider",
				verifiedVersion: "0.0.1",
				license: "MIT",
				note: "Model fallback chain — fails over to another provider instead of stalling.",
			},
		],
	},
	{
		id: "provider-server",
		label: "provider server error",
		axis: "turn",
		remedyKind: "extension",
		actionable: true,
		matchers: [
			{ label: "provider returned 5xx", re: /^5\d\d\b|internal server error|bad gateway|service unavailable|gateway timeout/i },
		],
		remedy: "The provider failed on its own side. These are transient and retryable; a retry extension recovers the turn instead of ending it.",
		extensions: PROVIDER_RETRY,
	},
	{
		id: "provider-transport",
		label: "transport failure",
		axis: "turn",
		remedyKind: "extension",
		actionable: true,
		matchers: [
			{ label: "stream closed or stalled", re: /error reading stream|stream closed|stream idle timeout|upstream idle timeout|terminated/i },
			{ label: "connection failed", re: /connection error|econnreset|socket hang up|network error|^error code: 5\d\d/i },
			{ label: "request timed out", re: /request timed out|etimedout|\btimeout\b/i },
		],
		remedy: "The connection to the provider dropped or stalled mid-response. Retrying recovers the turn; without it, the work up to the drop is paid for and thrown away.",
		extensions: PROVIDER_RETRY,
	},
];

export const TOOL_FAILURE_CLASSES: readonly FailureClassDef[] = [
	{
		id: "pending-background-task",
		label: "still running",
		axis: "tool",
		remedyKind: "prompt",
		// Not a failure at all. The host flags a poll of an unfinished background
		// task as an error, and counting it as one inflates every failure rate in
		// the session. Counted so the denominators stay honest, never proposed on
		// — the same treatment an operator's abort gets on the turn axis.
		actionable: false,
		matchers: [
			{ label: "background task has not finished", re: /^\(no output yet\)$|^\(still running\)$/i },
		],
		remedy: "No action — a poll of an unfinished background task is not a failure.",
		extensions: [],
	},
	{
		id: "edit-anchor-miss",
		label: "edit anchor did not match",
		axis: "tool",
		remedyKind: "prompt",
		actionable: true,
		matchers: [
			{ label: "anchor text not found in the file", re: /could not find (?:the exact text|edits\[)|no changes made to|text not found in file/i },
			{ label: "anchor text was ambiguous", re: /found \d+ occurrences of the text|not unique|matches multiple/i },
		],
		remedy:
			"The edit's anchor text did not match the file — the model was editing a version of it that no longer existed, or picked an anchor that appears more than once. " +
			"Read the region immediately before editing it, and anchor on something unique. This is the most common way a session pays twice for one change.",
		// Deliberately no packages. The repair layers fix malformed *arguments*;
		// none of them can know what the file currently says, which is the whole
		// problem here. Recommending one would be a plausible-sounding non-fix.
		extensions: [],
	},
	{
		id: "script-error",
		label: "the agent's own script failed",
		axis: "tool",
		remedyKind: "prompt",
		actionable: true,
		matchers: [
			{ label: "unhandled exception in a script", re: /traceback \(most recent call last\)|^\s*at .+\(.+:\d+:\d+\)$/im },
			{ label: "shell syntax error", re: /syntax error near unexpected token|unexpected eof while looking for|: line \d+: unexpected eof|bad substitution/i },
			{ label: "language-level error", re: /\b(?:syntaxerror|referenceerror|nameerror|modulenotfounderror|importerror)\b/i },
		],
		remedy:
			"The agent wrote a command or script that was itself broken. Prefer short, checkable steps over one long heredoc, and state in the standing instructions which shell and interpreter this machine actually has.",
		extensions: [],
	},
	{
		id: "policy-blocked",
		label: "blocked by a guardrail",
		axis: "tool",
		remedyKind: "prompt",
		actionable: true,
		matchers: [
			{ label: "action refused by policy", re: /^blocked:|denied by policy|blocked by (?:hook|policy|guardrail)|is not allowed here/i },
			{ label: "the operator declined", re: /user (?:declined|denied|rejected)|declined to provide/i },
		],
		remedy:
			"The environment refused the action. A guardrail that fires repeatedly is a rule the agent does not know about — write it into the standing instructions so the attempt stops being made, rather than being caught each time.",
		extensions: [],
	},
	{
		id: "tool-input-invalid",
		label: "invalid tool input",
		axis: "tool",
		remedyKind: "extension",
		actionable: true,
		matchers: [
			{ label: "arguments failed validation", re: /inputvalidationerror|invalid input|validation (?:failed|error)|is required|expected .* but (?:got|received)|unrecognized (?:key|argument)/i },
		],
		remedy:
			"The tool rejected the model's arguments before running. Tighten the tool's description and argument docs so the shape is unambiguous, or install a repair layer that fixes the call instead of returning an error the model has to read and re-plan around.",
		extensions: TOOL_INPUT_REPAIR,
	},
	{
		id: "tool-not-found",
		label: "tool or command not found",
		axis: "tool",
		// The fix is installing the missing binary on this machine — an environment
		// change, not an extension. No package in the catalogue installs tooling.
		remedyKind: "environment",
		actionable: true,
		matchers: [
			{ label: "command not found", re: /command not found|: not found$|unknown command/i },
			{ label: "no such tool", re: /unknown tool|no such tool|tool .* not (?:found|registered)/i },
		],
		remedy: "The agent reached for something that is not installed here. Name the available tooling in the standing instructions, or install what it keeps reaching for.",
		extensions: [],
	},
	{
		id: "path-not-found",
		label: "path not found",
		axis: "tool",
		remedyKind: "prompt",
		actionable: true,
		matchers: [
			{ label: "no such file or directory", re: /no such file or directory|enoent|does not exist|cannot find path/i },
		],
		remedy: "The agent acted on a path that was not there. This is usually a missing pre-flight check — establish the path, or state the layout in the standing instructions so it is not guessed.",
		extensions: [],
	},
	{
		id: "permission-denied",
		label: "permission denied",
		axis: "tool",
		// Granting the permission is a machine configuration change first; the
		// standing-instructions half of the remedy is what the agent can do itself.
		remedyKind: "environment",
		actionable: true,
		matchers: [
			{ label: "permission denied", re: /permission denied|eacces|operation not permitted|not permitted/i },
		],
		remedy: "The action was refused by the environment. Either grant it deliberately or record in the standing instructions that this path is off-limits, so the attempt is not repeated.",
		extensions: [],
	},
	{
		id: "remote-rate-limit",
		label: "remote API rate limit",
		axis: "tool",
		remedyKind: "prompt",
		actionable: true,
		matchers: [
			{ label: "third-party API rate limit", re: /api rate limit (?:already )?exceeded|rate limit exceeded|\b429\b|secondary rate limit/i },
		],
		remedy:
			"A service the agent calls refused it for rate. This is not the model provider — no LLM retry extension touches it. Batch the calls, cache what does not change, or authenticate for a higher ceiling.",
		extensions: [],
	},
	{
		id: "service-unavailable",
		label: "backing service unavailable",
		axis: "tool",
		remedyKind: "environment",
		actionable: true,
		matchers: [
			{ label: "not connected", re: /not connected|connection refused|econnrefused|protocol error|service unavailable|failed to connect/i },
		],
		remedy:
			"The tool was there, but the service behind it was not. Have the agent check the service is up before depending on it, or make the tool fail loudly at startup instead of mid-session.",
		extensions: [],
	},
	{
		id: "tool-timeout",
		label: "tool timeout",
		axis: "tool",
		remedyKind: "prompt",
		actionable: true,
		matchers: [
			{ label: "tool timed out", re: /timed out|etimedout|deadline exceeded/i },
		],
		remedy: "The command outlived its budget. Run the long ones in the background, or narrow them so a result arrives inside the timeout.",
		extensions: [],
	},
	{
		id: "command-failed",
		label: "command reported an error",
		axis: "tool",
		remedyKind: "prompt",
		actionable: true,
		// The Unix convention: a program that fails says `prog: what went wrong`.
		// The named programs come first so the cause label can say *which* program
		// complained; the generic shape catches the rest. Both are anchored to the
		// first or last non-empty line, because that is where a shell puts a
		// diagnostic — matching the shape anywhere would read a line of ordinary
		// output as the reason the command failed.
		matchers: [
			{ label: "git reported an error", re: /^fatal: \S|^git: \S/m },
			{ label: "a text tool reported an error", re: /^(?:sed|awk|grep|egrep|rg|jq|tr|cut|sort|uniq): \S/m },
			{ label: "a file tool reported an error", re: /^(?:cat|ls|cp|mv|rm|mkdir|rmdir|ln|chmod|touch|head|tail|wc|find|xargs|du|df): \S/m },
			{ label: "a build or package tool reported an error", re: /^(?:npm|npx|node|yarn|pnpm|make|cargo|go|python3?|pip3?|tsc|docker|gh|curl): \S/m },
			{ label: "the shell reported an error", re: /^(?:bash|sh|zsh)(?:: line \d+)?: \S/m },
			{ label: "usage error", re: /^usage: \S/im },
			{ label: "exit status reported explicitly", re: /exit(?:ed with)? (?:code|status) [1-9]|non-?zero exit/i },
			// Unnamed programs: the same shape, but only on the first or last line —
			// no `m` flag, so these anchor to the whole text rather than to any line
			// inside it. A `foo: bar` in the middle of a command's ordinary output is
			// not why it failed, and reading it as such would name a confident wrong
			// cause. (The named-program matchers above do search every line: for a
			// known diagnostic prefix like `sed:` that is worth the small risk.)
			{ label: "a command reported an error", re: /^[a-z][\w.+-]{0,30}: \S/ },
			{ label: "a command reported an error", re: /(?:^|\n)[a-z][\w.+-]{0,30}: \S[^\n]*\s*$/ },
		],
		remedy:
			"The command ran and reported its own failure. One is weather; the same command failing repeatedly is a standing instruction waiting to be written — how it is invoked on this machine, or what has to be true before it is.",
		extensions: [],
	},
	{
		id: "exit-status-signal",
		label: "non-zero exit used as a signal",
		axis: "tool",
		remedyKind: "prompt",
		actionable: true,
		// Last, and matched on the *call*: these commands report a normal answer
		// through their exit status and print nothing to explain themselves, so
		// there is no evidence in the result at all. Anything that did leave a
		// diagnostic has already been named by `command-failed` above.
		matchers: [],
		commandMatchers: [
			{ label: "a search that found nothing", re: /(?:^|[|;&(]\s*|\n)\s*(?:grep|egrep|fgrep|rg|ag|ack)\b/ },
			{ label: "git diff signalling a difference", re: /git\s+diff\b[^\n;|]*--(?:exit-code|quiet)\b/ },
			{ label: "a comparison reporting a difference", re: /(?:^|[|;&(]\s*|\n)\s*(?:diff|cmp)\b/ },
			{ label: "a conditional reporting false", re: /(?:^|[|;&(]\s*|\n)\s*(?:test|\[)\s/ },
		],
		remedy:
			"These commands answer through their exit status: grep exits 1 when it finds nothing, diff exits 1 when files differ, test exits 1 for false. None of that is an error, but the harness marks it as one and the agent re-plans around a non-problem. " +
			"Chain them with `|| true`, or with `;` instead of `&&`, and say so in the standing instructions — this is a rule the agent has to be told, because the shell will not tell it.",
		extensions: [],
	},
];

/**
 * Child-run failures, classified from `subagent_runs` artifact metadata.
 *
 * A spawn-level child failure leaves no transcript at all — zero turns, zero
 * tokens, no assistant message anywhere — so these classes are read from the
 * artifact's shape, not from a session. Order matters as everywhere else: a
 * specific error message names the cause before a structural fact gets the
 * chance, so "spawn pi ENOENT" reads as a spawn failure even though every
 * model attempt also failed.
 *
 * None of these classes carries extensions, and none may: the first is an
 * environment failure by definition, and dressing it up as a package
 * recommendation would be a plausible-sounding non-fix for a missing binary.
 */
export const CHILD_FAILURE_CLASSES: readonly FailureClassDef[] = [
	{
		id: "spawn-failure",
		label: "child spawn failure",
		axis: "child",
		actionable: true,
		// The binary never ran. Nothing the model, a prompt, or a package could
		// say or do changes the outcome; the fix is PATH/install/config on this
		// machine, so this class must never route to an extension proposal.
		remedyKind: "environment",
		matchers: [
			{ label: "the child binary could not be launched", re: /\bspawn\b[^\n]*\b(?:enoent|eacces|eperm)\b|\b(?:enoent|eacces)\b[^\n]*\bspawn\b/i },
		],
		childMatchers: [],
		remedy:
			"The child agent never started — its binary was not found where the host looked, or was not executable. " +
			"Fix the environment: install the binary, correct PATH for the user the host runs as, and verify with the same launch command from a clean shell. " +
			"No extension addresses this; the failure happens before any code the package could reach.",
		extensions: [],
	},
	{
		id: "model-attempt-exhaustion",
		label: "every model attempt failed",
		axis: "child",
		actionable: true,
		// Every configured model refused or failed. Retrying harder is not the fix;
		// credentials, endpoints, and provider configuration are — environment work.
		remedyKind: "environment",
		matchers: [],
		childMatchers: [
			{ label: "every attempted model failed", matches: (f) => f.allModelAttemptsFailed },
		],
		remedy:
			"Each model the child tried failed, so the run produced nothing regardless of model. " +
			"Check what the attempts share rather than which model to try next: credentials, network egress, and provider configuration on this machine.",
		extensions: [],
	},
	{
		id: "child-nonzero-exit",
		label: "child run exited non-zero",
		axis: "child",
		actionable: true,
		remedyKind: "prompt",
		matchers: [],
		childMatchers: [
			{ label: "non-zero exit code", matches: (f) => f.exitCode !== null && f.exitCode !== 0 },
		],
		remedy:
			"The child ran and failed on its own terms — it got far enough to exit with a status, which makes this the child's task or instructions to fix, not the host's environment. " +
			"Narrow what the child is asked to do, and say in the standing instructions what has to be true before the delegation is worth making.",
		extensions: [],
	},
];

/** The label recorded when nothing in the catalogue matched. */
export const UNCLASSIFIED = { classId: "unclassified", label: "unrecognised error" } as const;

export interface Classification {
	classId: string;
	/** A fixed, curated label — never text taken from the error itself. */
	label: string;
}

/**
 * What the failure was in aid of, for the classes whose evidence is the call
 * rather than the result.
 */
export interface FailureContext {
	/** The command that was run, for a tool-axis failure. Empty when there is none. */
	command: string;
}

/**
 * Classify one recorded error into the catalogue.
 *
 * Returns `unclassified` when nothing matches, which is a real answer: the
 * count of unclassified failures is what tells us the catalogue has a gap,
 * whereas forcing every error into the nearest class would hide that.
 */
export function classifyFailure(text: string, axis: FailureAxis, context?: FailureContext): Classification {
	const classes = axis === "turn" ? TURN_FAILURE_CLASSES : TOOL_FAILURE_CLASSES;
	const subject = boundForMatching(text);
	const command = context?.command ?? "";
	if (!subject && !command) return { classId: UNCLASSIFIED.classId, label: UNCLASSIFIED.label };
	for (const cls of classes) {
		if (subject) {
			for (const matcher of cls.matchers) {
				if (matcher.re.test(subject)) return { classId: cls.id, label: matcher.label };
			}
		}
		if (command) {
			for (const matcher of cls.commandMatchers ?? []) {
				if (matcher.re.test(command)) return { classId: cls.id, label: matcher.label };
			}
		}
	}
	return { classId: UNCLASSIFIED.classId, label: UNCLASSIFIED.label };
}

/**
 * Classify one child run from its artifact facts.
 *
 * Text matchers run first (specific message before structural shape), then the
 * child matchers, both in catalogue order. Returns `unclassified` for a run
 * that exited cleanly and said nothing failed — which is not a gap in the
 * catalogue but a healthy run, and is why the caller drops unclassified child
 * runs instead of counting them.
 */
export function classifyChildRun(facts: ChildRunFacts): Classification {
	for (const cls of CHILD_FAILURE_CLASSES) {
		for (const matcher of cls.matchers) {
			if (matcher.re.test(facts.error)) return { classId: cls.id, label: matcher.label };
		}
		for (const matcher of cls.childMatchers ?? []) {
			if (matcher.matches(facts)) return { classId: cls.id, label: matcher.label };
		}
	}
	return { classId: UNCLASSIFIED.classId, label: UNCLASSIFIED.label };
}

/** How much of a result's text is matched against the catalogue, at each end. */
const MATCH_WINDOW_CHARS = 2000;

/**
 * Narrow a result to the part of it that is plausibly the error.
 *
 * A failed tool result can be a hundred kilobytes of program output with the
 * real error at one end of it. Matching the whole blob is both slow and
 * *imprecise*: "Permission denied" appearing in a log line the command happened
 * to print is not why the command failed, and a catalogue that reads it as such
 * reports a confident wrong class. Errors sit at the top (an exception, a
 * validation message) or at the bottom (a shell's last word), so those are the
 * two windows we read.
 */
function boundForMatching(text: string): string {
	const trimmed = text.trim();
	if (trimmed.length <= MATCH_WINDOW_CHARS * 2) return trimmed;
	return `${trimmed.slice(0, MATCH_WINDOW_CHARS)}\n…\n${trimmed.slice(-MATCH_WINDOW_CHARS)}`;
}

/** Look a class up by id, across all three axes. */
export function failureClass(classId: string): FailureClassDef | undefined {
	return (
		TURN_FAILURE_CLASSES.find((c) => c.id === classId) ??
		TOOL_FAILURE_CLASSES.find((c) => c.id === classId) ??
		CHILD_FAILURE_CLASSES.find((c) => c.id === classId)
	);
}

/** Every package the catalogue may ever recommend. Nothing outside this set is proposable. */
export function curatedPackages(): string[] {
	const seen = new Set<string>();
	for (const cls of [...TURN_FAILURE_CLASSES, ...TOOL_FAILURE_CLASSES, ...CHILD_FAILURE_CLASSES]) {
		for (const ext of cls.extensions) seen.add(ext.pkg);
	}
	return [...seen].sort();
}
