// The deterministic pre-gate for the LLM regression verdict.
//
// An LLM verdict on every session would cost a corpus-wide fortune, and most
// sessions are additive — a feature, a docs edit, a review. This gate answers a
// cheaper question first: did this session repair a failure at all? It is
// deliberately loose, because the LLM's job is the precision; a loose gate costs
// tokens, a tight gate loses recall and cannot be recovered by the model.
//
// The gate admits a session when it both changed something and encountered a
// failure or stated a defect. The two halves matter together:
//
//   - changed_something alone is any feature work.
//   - failure alone is any debugging session that fixed nothing.
//
// The gate builds the evidence packet the model reads: the failure evidence, the
// commits and edits, and the sentences that discuss a defect or its cause. The
// packet is bounded, because a 5,000-message session cannot be sent whole.

import type { MessageRow } from "../regression-signal/detect.js";
import { buildToolStream } from "../../tool-stream.js";

/** What the gate hands the model. Every field is bounded. */
export type EvidencePacket = {
	session_id: string;
	/** Tool calls the gate saw fail, newest last, with the head of the error. */
	failures: string[];
	/** Commit commands and their result lines, newest last. */
	commits: string[];
	/** Sentences that appear to discuss a defect, its cause, or a repair. */
	defect_statements: string[];
	/** Files the session edited, when a tool call names them. */
	files_touched: string[];
	/** True when the session ran a test, build, or lint command. */
	ran_checks: boolean;
	/** True when a revert command appears anywhere. */
	reverts: boolean;
};

export type GateConfig = {
	/** Cap on each evidence list, so one long session cannot blow the context. */
	maxFailures: number;
	maxCommits: number;
	maxStatements: number;
	maxFiles: number;
	/** Cap on the characters taken from one sentence. */
	statementChars: number;
};

export const DEFAULT_GATE_CONFIG: GateConfig = {
	maxFailures: 12,
	maxCommits: 10,
	maxStatements: 18,
	maxFiles: 20,
	statementChars: 320,
};

/** Tool names whose failure is evidence of a defect the session then repaired. */
const FAILURE_TOOLS = /^(bash|shell|exec|run_command|Bash|terminal)$/;

/** Commands that are a check: a test, build, lint, or type check. */
const CHECK_COMMAND = /\b(?:test|pytest|go test|npm test|pnpm test|jest|vitest|tsc|golangci-lint|eslint|biome|make|build|shellcheck|terraform (?:validate|plan))\b/i;

/** A sentence is worth sending when it talks about a defect, a cause, or a repair. */
const DEFECT_SENTENCE =
	/\b(?:regress\w*|broke(?:n)?|breakage|bug|defect|fix(?:e[sd])?|caused by|introduced (?:by|in)|used to work|worked (?:before|fine|earlier)|never work(?:ed|s)|no longer works?|stopped working|root cause|revert\w*|failure|failing|failed|panic|traceback|nil pointer|data race|deadlock|(?:i|we)\s+(?:caused|broke|introduced)\b|my (?:own )?(?:change|fault|mistake))\b/i;

/** A shell command that writes files. */
const SHELL_EDIT = /\b(?:sed\s+-i|perl\s+-[a-z]*i|tee\b|truncate\b)|>>?\s*[^\s|&;]+/;

/** A tool call that writes files. */
const EDIT_TOOL = /^(edit|write|str_replace|apply_patch|multi_edit|create_file|Write|Edit)$/;

/** Extract the file path from a tool call's arguments, when it names one. */
function fileFromArgs(raw: unknown): string | null {
	if (!raw || typeof raw !== "object") return null;
	const a = raw as Record<string, unknown>;
	for (const key of ["path", "file_path", "filename", "file"]) {
		const v = a[key];
		if (typeof v === "string" && v.length > 0 && v.length < 300) return v;
	}
	return null;
}

/** Parse a tool_calls blob into `{name, args}` pairs, tolerating malformed rows. */
function parseCalls(raw: string | null): Array<{ name: string; args: unknown }> {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter((c) => c && typeof c === "object")
			.map((c) => ({ name: String((c as Record<string, unknown>).name ?? ""), args: (c as Record<string, unknown>).arguments }));
	} catch {
		return [];
	}
}

/** True when a tool result reports an error, by the framework's own marks. */
function isFailure(row: MessageRow): boolean {
	if (row.stop_reason === "error" || row.error_message) return true;
	const text = row.tool_results ?? "";
	// The corpus marks a failed result with `isError: true` in the stored JSON, or
	// with a leading "Error:" the mobile tools use.
	return /"isError"\s*:\s*true/.test(text) || /^\s*(?:Error|error|ERROR)[:\s]/.test(text);
}

/**
 * The text of the failed result inside a serialized `tool_results` blob.
 *
 * Passing the raw JSON to `errorHeadOf` matched the word inside the `isError` key, so the head
 * became `Error":true,"content":…` — a field marker where the message should be, and the real
 * message never reached the model.
 */
function failedResultText(raw: string | null): string {
	if (!raw) return "";
	try {
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) {
			for (const entry of parsed) {
				const e = entry as Record<string, unknown> | null;
				if (!e || e["isError"] !== true) continue;
				for (const key of ["content", "text", "output", "error", "message"]) {
					const v = e[key];
					if (typeof v === "string" && v.trim()) return v;
				}
			}
		}
	} catch {
		// Not JSON: fall through and strip the marker instead.
	}
	return raw.replace(/"isError"\s*:\s*true\s*,?/g, " ");
}

/** The head of an error message, trimmed for the packet. */
function errorHeadOf(text: string): string {
	const body = text.slice(0, 600);
	const m = /(?:Error|error|ERROR|panic|Traceback)[^\n]{0,200}/.exec(body);
	return (m ? m[0] : body.split("\n")[0] ?? "").trim().slice(0, 220);
}

/**
 * How strongly a sentence asserts a defect, its cause, or its repair.
 *
 * Taking the first N matching sentences does not work: a long session opens with a
 * briefing, a skill body, or a plan that says "regression" for its own reasons, and
 * the sentence that actually identifies the cause lands thousands of messages later.
 * Measured on a real session, the first 18 matches were all briefing text and the
 * finding never reached the model. Scoring and then keeping the best-ranked
 * sentences is what puts the conclusion in the packet.
 */
function statementScore(sentence: string): number {
	let score = 0;
	// Direct statements of causality or regression outrank a passing mention.
	if (/\bregression\b|\bregressed\b/i.test(sentence)) score += 6;
	if (/\bcaused by\b|\bintroduced (?:by|in)\b|\broot cause\b/i.test(sentence)) score += 6;
	if (/\bused to work\b|\bworked before\b|\bno longer works?\b|\bstopped working\b/i.test(sentence)) score += 4;
	if (/\bmy (?:own )?(?:change|bug|fault)\b|\bI (?:introduced|broke|caused)\b/i.test(sentence)) score += 5;
	if (/\bfix(?:ed|es)?\b|\brevert\w*\b/i.test(sentence)) score += 3;
	if (/\bpanic\b|\bnil pointer\b|\bdata race\b|\bdeadlock\b|\btraceback\b/i.test(sentence)) score += 2;
	if (/\bnever worked\b/i.test(sentence)) score += 2;
	// A concrete artifact (a path, a symbol) is more useful than a general statement.
	if (/[\w-]+\.(?:go|ts|tsx|py|sh|sql|ya?ml)\b/.test(sentence)) score += 1;
	// A mechanical echo of a command line is weak evidence on its own.
	if (/^\s*(?:\d+\t|\$ )/.test(sentence)) score -= 2;
	return score;
}

/** Every sentence that looks like it discusses a defect, with its score and position. */
function defectSentences(text: string, cap: number): Array<{ text: string; score: number }> {
	const out: Array<{ text: string; score: number }> = [];
	for (const part of text.split(/(?<=[.!?])\s+|\n+/)) {
		const s = part.trim();
		if (s.length < 12) continue;
		if (!DEFECT_SENTENCE.test(s)) continue;
		// Long text is truncated, not dropped: a pasted log or a long bullet is often the
		// only place a session states its cause, and dropping it excluded the session
		// entirely.
		out.push({ text: s.slice(0, cap), score: statementScore(s) });
	}
	return out;
}

export type GateResult = {
	/** True when the session is worth an LLM verdict. */
	admit: boolean;
	packet: EvidencePacket;
	/** Why the gate decided as it did, so a sampled audit can see the reason. */
	reason: string;
};

/**
 * Decide whether a session deserves an LLM regression verdict, and build the
 * evidence packet when it does.
 */
export function gateSession(messages: readonly MessageRow[], config: GateConfig = DEFAULT_GATE_CONFIG): GateResult {
	const failures: string[] = [];
	const commits: string[] = [];
	const candidates: Array<{ text: string; score: number }> = [];
	const files = new Set<string>();
	let ranChecks = false;
	let reverts = false;
	let changedSomething = false;

	// Pairing is the shared action stream's job, not this analyzer's. It joins each
	// call to its own result by tool-call id, so a result cannot be labelled with a
	// command from a different call — the inversion a hand-rolled counter produced
	// when the second of two calls failed and the first had succeeded. It also
	// refuses to split a row that carried several results, so a failed result's text
	// is reported only when the row held exactly one.
	const stream = buildToolStream(messages as MessageRow[]);

	for (const inv of stream.invocations) {
		if (EDIT_TOOL.test(inv.name)) {
			changedSomething = true;
			const file = fileFromArgs(inv.args);
			if (file && files.size < config.maxFiles) files.add(file);
			continue;
		}
		if (!FAILURE_TOOLS.test(inv.name)) continue;

		const command = typeof inv.args["command"] === "string" ? String(inv.args["command"]) : "";
		if (command) {
			// Classify the command, not the words inside its arguments: `git commit -m "drop
			// flaky test"` ran no test, and `rg "git commit" docs/` made no commit. Quoted spans
			// are removed before any pattern sees them.
			const bare = command.replace(/"[^"]*"|'[^']*'/g, " ");
			if (/git revert\b/.test(bare)) {
				reverts = true;
				changedSomething = true;
			}
			if (/git commit\b/.test(bare)) {
				changedSomething = true;
				if (commits.length < config.maxCommits) commits.push(command.slice(0, config.statementChars));
			}
			if (CHECK_COMMAND.test(bare)) ranChecks = true;
			// An edit made through the shell is still a change: `sed -i`, a redirect, or `tee`
			// repaired the file, and reporting "changed nothing" gated the session out.
			if (SHELL_EDIT.test(bare)) {
				changedSomething = true;
				const file = fileFromArgs(inv.args);
				if (file && files.size < config.maxFiles) files.add(file);
			}
		}

		if (inv.outcome?.isError && failures.length < config.maxFailures) {
			const head = inv.outcome.errorText ? errorHeadOf(inv.outcome.errorText) : "";
			// A named command beside a known error, or whichever half is known. Never a
			// command the stream did not pair with this result.
			const label = command ? command.slice(0, 120) : inv.name;
			if (head) failures.push(`${label} → ${head}`);
			else failures.push(`${label} failed`);
		}
	}

	// A row can record a failure with no tool invocation at all: a stop reason of "error", or an
	// error message on the row itself. The tool stream cannot see those, and a session whose only
	// failure evidence is one of them was gated out — losing exactly the recall this loose gate
	// exists to protect. A row the stream already reported is skipped, so nothing is counted twice.
	for (const row of messages) {
		if (failures.length >= config.maxFailures) break;
		if (!isFailure(row)) continue;
		// Skip a row only when the stream already reported this same error. The stream abandons
		// every non-shell invocation before its isError check, so a failing edit, write or read
		// is visible here and nowhere else — blanket-skipping those rows hid it entirely.
		const rowHead = row.error_message
			? errorHeadOf(row.error_message)
			: row.tool_results && /"isError"\s*:\s*true/.test(row.tool_results)
				? errorHeadOf(failedResultText(row.tool_results))
				: "";
		// Skip a row only when the stream already counted it, and decide that structurally: the
		// result names its tool, and the stream pairs every result from a failure tool with its
		// invocation. A result from any other tool is invisible there, which is why this fallback
		// exists. Comparing error strings instead double-counted the shell case and missed the rest.
		// Only a row with exactly one result was paired by the stream with its invocation. A row
		// carrying several results is refused there, so skipping it here lost the failure
		// entirely — the case a successful bash result followed by a failed edit produces.
		const toolNames = [...(row.tool_results ?? "").matchAll(/"toolName"\s*:\s*"([^"]+)"/g)].map((m) => m[1]!);
		// ...and only when that one result is itself an error. A row can fail through
		// `error_message` while its single shell result succeeded, and the stream never sees that.
		if (
			toolNames.length === 1 &&
			FAILURE_TOOLS.test(toolNames[0]!) &&
			/"isError"\s*:\s*true/.test(row.tool_results ?? "")
		) continue;
		// `rowHead` already carries the error message when there is one, and the text of a failed
		// result when there is not. Reading only `error_message` here left a failing edit, write
		// or read recorded nowhere — the case the fallback exists for.
		if (rowHead) failures.push(rowHead);
		else if (row.stop_reason === "error") failures.push("the turn ended with an error");
	}

	// A generation that failed outright is a failure the session saw even when no tool
	// result recorded it — the tokens were billed and nothing usable came back.
	if (failures.length === 0 && stream.turnFailures.length > 0) {
		for (const tf of stream.turnFailures.slice(0, config.maxFailures)) {
			failures.push(`turn failed: ${(tf.errorText || tf.stopReason || "no reason recorded").slice(0, 160)}`);
		}
	}

	for (const m of messages) {
		for (const text of [m.content_text, m.content_thinking]) {
			if (!text) continue;
			for (const cand of defectSentences(text, config.statementChars)) candidates.push(cand);
		}
	}

	// Rank once, after the whole session is read. Ties go to the later sentence: a
	// session states its conclusion after the evidence that produced it.
	const statements = candidates
		.map((c, i) => ({ ...c, i }))
		.sort((a, b) => b.score - a.score || b.i - a.i)
		.slice(0, config.maxStatements)
		.sort((a, b) => a.i - b.i)
		.map((c) => c.text);

	const sawFailure = failures.length > 0;
	// The gate's rule, in one line: something changed, and either a command failed or
	// the session talks about a defect. A session that failed and then repaired is
	// exactly the shape a regression fix has, whether or not it says "regression".
	const talkedAboutDefect = statements.length > 0;
	const admit = changedSomething && (sawFailure || reverts || talkedAboutDefect);

	const reason = !changedSomething
		? "changed nothing: additive, review, or discussion only"
		: !admit
			? "changed something but saw no failure and named no defect"
			: sawFailure && reverts
				? "changed something, saw a failure, and reverted"
				: sawFailure
					? "changed something and saw a failed command"
					: reverts
						? "changed something and reverted"
						: "changed something and named a defect";

	return {
		admit,
		reason,
		packet: {
			session_id: messages[0]?.session_id ?? "",
			failures,
			commits,
			defect_statements: statements,
			files_touched: [...files].sort(),
			ran_checks: ranChecks,
			reverts,
		},
	};
}
