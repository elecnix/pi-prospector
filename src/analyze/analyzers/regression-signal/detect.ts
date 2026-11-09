// Detecting that a session fixed a defect an earlier change introduced.
//
// The input is one session's transcript. The output is the evidence that the
// session repaired something that used to work, together with the earlier change
// it blames — the pull requests and commits it names as the cause.
//
// What counts, and what does not, follows the repository's own `regression-review`
// skill: a regression is a defect an earlier merged change introduced, where that
// change broke something that worked before it. Three things must hold, and this
// module can only establish the first two from a transcript:
//
//   1. the session repaired a defect (it is a fix, not an additive change);
//   2. the session blames an earlier change, and names it;
//   3. that earlier change really did introduce the defect — which needs the
//      tree, not the transcript, and is therefore left to a later step.
//
// So the module reports a *claim*, never a verdict. The claim is what makes the
// attribution pass worth running; the verdict is what git blame decides.
//
// The deliberate silences, each of which a looser rule would have broken:
//
//   - A session that only *discusses* a regression (a review of someone else's
//     fix, a ticket triage) files nothing. It must have changed something: an
//     edit, a commit, a push.
//   - "Regression test" and "prompt-regression"/"visual regression" are a test
//     kind and a test suite, not a defect. They are excluded by name.
//   - A vendor or tool release is not our regression. A session that blames an
//     upstream issue or a released dependency's behaviour is marked as such
//     rather than attributed to an earlier pull request of ours.
//   - A defect that never worked is a new defect. "It never worked" is checked
//     before a claim is made.
//
// Deterministic: no model, no network. The blame check happens elsewhere, against
// the tree.

import type { MessageRow } from "../../types.js";

export type { MessageRow };

export type Config = {
	/** Minimum number of distinct signals before a claim is filed. */
	minSignals: number;
	/** Whether to read assistant thinking, not only visible text. */
	readThinking: boolean;
};

export const DEFAULT_CONFIG: Config = {
	minSignals: 2,
	readThinking: true,
};

/** A pull request the session names as the cause, with the row that says so. */
export type CitedPullRequest = {
	number: number;
	/** Set when the claim named the repository, e.g. "acme/widgets#123". */
	owner?: string;
	repo?: string;
	/** The forge host a URL named. GitHub is the concrete case; the field is not. */
	host?: string;
	/** The sentence that named it, trimmed. */
	quote: string;
	message_id: string;
};

/** A commit the session names as the cause. */
export type CitedCommit = {
	/** Abbreviated or full hex sha, as the transcript wrote it. */
	sha: string;
	quote: string;
	message_id: string;
};

/** Why the session looks like a regression fix. Every field is evidence, not a score. */
export type Signals = {
	/** The session changed files or committed. A regression fix must have. */
	changed_something: boolean;
	/** The session reverts an earlier change, the strongest form of the claim. */
	reverts: boolean;
	/** The session states the earlier change as the cause in its own words. */
	causal_claim: boolean;
	/** The session names a pull request or commit as the cause. */
	names_the_cause: boolean;
	/** The session ran git blame or git log -S to find the introducing change. */
	sought_the_cause: boolean;
	/** The session states the defect used to work. */
	states_it_worked_before: boolean;
};

export type Scan = {
	session_id: string;
	/** True when the transcript carries a claim worth attributing. */
	claims_regression: boolean;
	/** The signals that fired, in a fixed order, so the node is stable across runs. */
	signals_fired: string[];
	signals: Signals;
	cited_pull_requests: CitedPullRequest[];
	cited_commits: CitedCommit[];
	/** The session blames an upstream project or a released dependency, not our earlier change. */
	blames_upstream: boolean;
	/** The session says the defect never worked, which makes it a new defect rather than a regression. */
	never_worked: boolean;
	/** The message ids the claim was read from, so the prose can be walked back. */
	evidence_message_ids: string[];
};

// ── vocabulary ──────────────────────────────────────────────────────────────

/** The defect is described as a regression, in the words the corpus actually uses. */
const REGRESSION_TERMS = [
	/\bregression\b/i,
	/\bregressed\b/i,
	/\bregressing\b/i,
	/\bbroke(?:n)?\b/i,
	/\bbreakage\b/i,
	/\bmade it (?:stop|fail)\b/i,
	/\bused to work\b/i,
	/\bno longer works?\b/i,
	/\bstopped working\b/i,
];

/** The sentence states causality: this defect came from that change. */
const CAUSAL_PATTERNS = [
	/\bcaused by\b/i,
	/\bintroduced (?:by|in|with)\b/i,
	/\bregressed (?:by|in|from)\b/i,
	/\bregression (?:from|in|by)\b/i,
	/\bcame from #\d+/i,
	/\bcomes? from #\d+/i,
	/\boriginated (?:in|from)\b/i,
	/\bbroke(?:n)? by\b/i,
	/\bwas broken by\b/i,
	/\b(?:my|our) (?:earlier |previous |recent )?(?:change|pr|commit|patch)\b[^.]{0,40}\bbroke\b/i,
];

/**
 * Negation around a causal phrase. The corpus's most common form of "caused by
 * #N" is a *denial* — an agent proving its own change did NOT cause a failure, as
 * in "this is NOT caused by 1400 (docs-only)" or "pre-existing on main, not
 * caused by 1066's diff". Reading those as claims would accuse thousands of
 * innocent pull requests, so a negated causal phrase states the opposite and is
 * never a claim.
 */
const NEGATED_CAUSAL = [
	/\b(?:not|never|isn'?t|wasn'?t|aren'?t|weren'?t|was not|were not|is not|are not|cannot|can'?t)\s+(?:\w+\s+){0,2}(?:caused|introduced|regressed|broken|broke)\b/i,
	/\b(?:not|never)\s+(?:\w+\s+){0,2}(?:the\s+)?cause\b/i,
	/\bno\s+(?:\w+\s+){0,2}(?:causation|connection)\b/i,
	/\bpre-existing\b/i,
	/\bunrelated to\b/i,
	/\bnot (?:from|by) #\d+/i,
	/\brather than (?:from|by|a) (?:the )?(?:earlier|previous)?\s*(?:change|pr|commit)\b/i,
];

/** Phrases that make a claim about a *different* repository or a released dependency. */
const UPSTREAM_PATTERNS = [
	/\bupstream\b/i,
	/\bregression in (?:the )?(?:vendor|provider|sdk|cli|runtime|node|go)\b/i,
	/\breleased? (?:version|in)\b/i,
	/\b(?:issue|bug) \d{4,}\b/i,
	/\bfixed in (?:v?\d+\.\d+|the next release)\b/i,
];

/** The defect never worked, so it is not a regression. */
const NEVER_WORKED_PATTERNS = [
	/\bnever worked\b/i,
	/\bhas never worked\b/i,
	/\bdidn'?t work (?:from the start|to begin with|at all)\b/i,
	/\bnever actually worked\b/i,
	/\bnew defect\b/i,
];

/**
 * Words that mark a citation as the repair rather than the cause. A pull request
 * named this way fixes the defect; it did not introduce it.
 */
const NAMES_THE_FIX = /\b(?:fixed|fixes|fix|repaired|resolved|addressed|reverted|mitigated|patched|landed|shipped)\s+(?:in|by|with)\s*$/i;

/** A sentence that is about a defect or a failure, not merely about a number. */
const DEFECT_CONTEXT =
	/\b(?:defect|failure|failures|fail(?:s|ed|ing)?|broke(?:n)?|breakage|regress\w*|bug|error|500|panic|crash\w*|red|flak\w*|wrong|incorrect|missing|stale|outage)\b/i;

/** The session reverted a change. */
const REVERT_PATTERNS = [/\bgit revert\b/i, /\bRevert "/, /\brevert(?:ing|ed)? (?:pr|pull request|commit) #?\d+/i, /\bthis reverts commit\b/i];

/** The session looked for the introducing change. */
const SOUGHT_CAUSE_PATTERNS = [/\bgit blame\b/, /\bgit log -S\b/, /\bgit log --\S*diff-filter/, /\bbisect\b/i, /\blog -S ?["']/];

/** The session edited or committed. Without this it is only discussing a fix. */
const CHANGED_PATTERNS = [
	/\bgit commit\b/,
	/\bgit push\b/,
	/\bgh pr create\b/,
	/\bgit revert\b/,
	/\bapply_patch\b/,
];

/**
 * Test-suite and test-kind names that contain "regression" without being one.
 * Replacing them before matching is what keeps "regression test" from filing a
 * claim on every session that runs one.
 */
const FALSE_FRIENDS = [
	/\bregression (?:test|tests|suite|spec|coverage)\b/gi,
	/\bprompt-regression\b/gi,
	/\bvisual[- ]regression\b/gi,
	/\bregression[- ](?:testing|harness|baseline|fixture)s?\b/gi,
];

/** A bare number, `PR <n>`, `pull/<n>`, or `owner/repo#<n>`. */
const PR_PATTERNS = [/(?:\bPR\s*)?#(\d{1,6})\b/g, /\bpull\/(\d{1,6})\b/g, /\bPR\s+(\d{1,6})\b/g];

/** A commit sha, as the corpus writes them: at least 7 hex characters. */
const COMMIT_PATTERN = /\b([0-9a-f]{7,40})\b/g;

/** Words that look like a sha but are not. */
const NOT_A_SHA = new Set(["deadbeef", "abcdef1", "cafebabe", "0000000", "fffffff"]);

// ── reading ─────────────────────────────────────────────────────────────────

/** Every text field of a row the detector reads, in a fixed order. */
function textsOf(m: MessageRow, config: Config): string[] {
	const out: string[] = [];
	if (m.content_text) out.push(m.content_text);
	if (config.readThinking && m.content_thinking) out.push(m.content_thinking);
	if (m.tool_calls) out.push(m.tool_calls);
	if (m.tool_results) out.push(m.tool_results);
	return out;
}

/** The sentence around a match, so a citation carries its own justification. */
function sentenceAround(text: string, index: number): string {
	const start = Math.max(0, text.lastIndexOf(".", index) + 1, text.lastIndexOf("\n", index) + 1);
	const dot = text.indexOf(".", index);
	const nl = text.indexOf("\n", index);
	const ends = [dot, nl].filter((n) => n !== -1);
	const end = ends.length ? Math.min(...ends) : text.length;
	return text.slice(start, end).trim().slice(0, 300);
}

/** The few words immediately before a match, so a citation can be classified as cause or cure. */
function prefixBefore(text: string, index: number): string {
	return text.slice(Math.max(0, index - 60), index).replace(/\s+$/, "");
}

/** Strip the false friends, so a test name is never read as a defect. */
function stripFalseFriends(text: string): string {
	let out = text;
	for (const re of FALSE_FRIENDS) out = out.replace(re, " ");
	return out;
}

/** True when the sentence denies the causality it appears to state. */
function isNegated(sentence: string): boolean {
	return anyMatch(NEGATED_CAUSAL, sentence);
}

/**
 * The sentences in this text that assert causality, with the negated ones removed.
 *
 * Negation is judged per sentence, not per row, because one row routinely holds
 * both: "the deploy broke, but this is not caused by 1400" states a failure and
 * denies a cause in the same breath.
 */
function causalSentences(text: string): string[] {
	const out: string[] = [];
	for (const re of CAUSAL_PATTERNS) {
		const scanner = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
		let m: RegExpExecArray | null;
		while ((m = scanner.exec(text)) !== null) {
			const sentence = sentenceAround(text, m.index);
			if (!isNegated(sentence)) out.push(sentence);
		}
	}
	return out;
}

function anyMatch(patterns: RegExp[], text: string): boolean {
	return patterns.some((re) => re.test(text));
}

/**
 * Scan one session. Pure: the same messages always give the same scan, which is
 * what lets node identity be a function of the transcript.
 */
export function findRegressionEvidence(messages: readonly MessageRow[], config: Config = DEFAULT_CONFIG): Scan {
	const sessionId = messages[0]?.session_id ?? "";
	const signals: Signals = {
		changed_something: false,
		reverts: false,
		causal_claim: false,
		names_the_cause: false,
		sought_the_cause: false,
		states_it_worked_before: false,
	};
	const citedPrs = new Map<string, CitedPullRequest>();
	const citedCommits = new Map<string, CitedCommit>();
	const evidence = new Set<string>();
	let blamesUpstream = false;
	let neverWorked = false;
	// The message that said the defect never worked. The claim is cancelled only when
	// the claim itself is in that message, never by an aside elsewhere in the session.
	let neverWorkedSentence: string | null = null;
	// The claim's sentence blamed upstream. Session-wide upstream mentions stay out of it.
	let upstreamClaim = false;
	// The message that carried the claim. A never-worked aside in another message must
	// not cancel it, which is the whole point of tracking both ids.
	let claimSentenceText: string | null = null;

	for (const m of messages) {
		for (const raw of textsOf(m, config)) {
			// Whether this text is the agent's own words is decided from the RAW field, not
			// from the stripped one: stripping can change a tool result and make it differ
			// from its own original.
			const ownWords = raw !== (m.tool_results ?? "");
			const text = stripFalseFriends(raw);

			// A change is a command the session RAN. Prose saying "next: git commit" and tool
			// output quoting one are not work, and reading them as work let a triage session
			// file a claim — the gate exists to keep exactly that silent.
			const isCall = raw === (m.tool_calls ?? "");
			if (isCall && !signals.changed_something) {
				// A session that repairs defect through editor calls and never commits did make a
				// change; the command patterns alone missed it.
				if (anyMatch(CHANGED_PATTERNS, text) || /"(?:edit|write|str_replace|multi_edit|apply_patch|create_file)"\s*:/.test(raw)) {
					signals.changed_something = true;
				}
			}
			// A revert the agent read is not a revert it performed. Tool output is history it
			// happened to look at, so only its own words and its own commands count.
			if (ownWords && !signals.reverts && anyMatch(REVERT_PATTERNS, text)) {
				signals.reverts = true;
				evidence.add(m.id);
			}
			if (!signals.sought_the_cause && anyMatch(SOUGHT_CAUSE_PATTERNS, text)) {
				signals.sought_the_cause = true;
				evidence.add(m.id);
			}
			// Upstream and never-worked are judged on the claiming sentence, never on the
			// whole row or the whole session. A 3,000-message session mentions an upstream
			// release somewhere and a "never worked" somewhere else; either would otherwise
			// disqualify a genuine claim about a different defect.

			const mentionsRegression = anyMatch(REGRESSION_TERMS, text);
			// The claim is the session's own words. A tool result saying "the deploy broke,
			// caused by #1234" is a document the session read, and reading one is not a claim.
			const causalSents = ownWords ? causalSentences(text) : [];
			for (const sent of causalSents) {
				// A sentence that states a regression and then says it came from an upstream
				// release is not our regression; one that says the defect never worked is a
				// new defect. Both are recorded so the node says why it claims nothing. The
				// defect-context gate keeps an unrelated upstream aside in a long session
				// from disqualifying a genuine claim about a different defect.
				// A sentence that states the cause is about the defect even when it names no
				// symptom word, so the presence of a causal phrase is context enough here.
				if (anyMatch(UPSTREAM_PATTERNS, sent)) blamesUpstream = true;
				if (anyMatch(NEVER_WORKED_PATTERNS, sent)) {
					neverWorked = true;
					neverWorkedSentence = neverWorkedSentence ?? sent;
				}
			}
			const causal = causalSents.length > 0;
			const revertsHere = anyMatch(REVERT_PATTERNS, text);
			// The claim needs a causal sentence that is about a defect. Provenance prose
			// ("the numbers came from that pull request") matches a causal phrase, and it
			// must not label a session a regression fix on its own.
			const claimSentence = causalSents.find(
				(sent) => DEFECT_CONTEXT.test(sent) || anyMatch(REGRESSION_TERMS, sent) || anyMatch(REVERT_PATTERNS, sent),
			);
			if (claimSentence) {
				if (anyMatch(UPSTREAM_PATTERNS, claimSentence)) upstreamClaim = true;
				signals.causal_claim = true;
				evidence.add(m.id);
				claimSentenceText = claimSentenceText ?? claimSentence;
			}
			// A revert states the causality by itself: the session is undoing a change
			// it blames. Its citation must therefore be read even when the row never
			// says "regression".
			if (!mentionsRegression && !causal && !revertsHere) continue;

			if (!signals.states_it_worked_before && /used to work|worked before|previously worked|has always worked/i.test(text)) {
				signals.states_it_worked_before = true;
				evidence.add(m.id);
			}

			// A citation only counts when the sentence carries causality. A bare "1234" in a link
			// list names nothing as the cause.
			//
			// Cross-repository references are first class. A URL, "owner/repo#123" or
			// "owner/repo/pull/123" is that repository's pull request, and it claims its position
			// so a bare-number pattern never reads the same number twice. A bare number keeps the
			// unique-repository rule downstream. GitHub is the concrete forge; the host is carried
			// so another can be added without changing this shape.
			const found: Array<{ number: number; index: number; owner?: string; repo?: string; host?: string }> = [];
			const consumed: Array<[number, number]> = [];
			const QUALIFIED_PR: Array<{ re: RegExp; host: boolean }> = [
				{ re: /https?:\/\/([a-z0-9.-]+)\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d{1,6})\b/gi, host: true },
				{ re: /\b([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d{1,6})\b/g, host: false },
				{ re: /\b([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d{1,6})\b/g, host: false },
			];
			for (const { re, host } of QUALIFIED_PR) {
				re.lastIndex = 0;
				let q: RegExpExecArray | null;
				while ((q = re.exec(text)) !== null) {
					const number = Number(q[q.length - 1]);
					const owner = host ? q[2] : q[1];
					const repo = host ? q[3] : q[2];
					if (!Number.isFinite(number) || number <= 0 || !owner || !repo) continue;
					found.push({ number, index: q.index, owner, repo, ...(host ? { host: q[1] } : {}) });
					consumed.push([q.index, q.index + q[0].length]);
				}
			}
			for (const re of PR_PATTERNS) {
				re.lastIndex = 0;
				let match: RegExpExecArray | null;
				while ((match = re.exec(text)) !== null) {
					if (consumed.some(([start, end]) => match!.index >= start && match!.index < end)) continue;
					const bare = Number(match[1]);
					if (Number.isFinite(bare) && bare > 0) found.push({ number: bare, index: match.index });
				}
			}
			found.sort((a, b) => a.index - b.index);
			for (const cite of found) {
				const sentence = sentenceAround(text, cite.index);
				// A citation counts only in a sentence that asserts causality and does not deny it.
				// "Not caused by 1400" names a pull request to exonerate it. A revert is causality
				// in its own words — it names the change being undone — so it is read here exactly
				// as the commit loop reads it.
				const namesRevertPr = anyMatch(REVERT_PATTERNS, sentence);
				if (!causalSentences(sentence).length && !namesRevertPr) continue;
				// The citation must sit in a sentence that is about a defect or a failure. Without
				// this, provenance prose — "the numbers came from 2277" — reads as a blamed change.
				if (!DEFECT_CONTEXT.test(sentence) && !anyMatch(REGRESSION_TERMS, sentence) && !anyMatch(REVERT_PATTERNS, sentence)) continue;
				// The citation must be the cause, never the cure.
				if (NAMES_THE_FIX.test(prefixBefore(text, cite.index))) continue;
				// Scoped to this sentence: a regression the sentence calls upstream is not ours, and
				// one it calls never-worked is a new defect.
				if (anyMatch(UPSTREAM_PATTERNS, sentence)) {
					blamesUpstream = true;
					continue;
				}
				if (anyMatch(NEVER_WORKED_PATTERNS, sentence)) {
					neverWorked = true;
					continue;
				}
				// A qualified citation is keyed by its repository, so the same number in two
				// repositories is two citations rather than one contradictory entry.
				const qualified = Boolean(cite.owner && cite.repo);
				const key = qualified ? `${cite.owner!.toLowerCase()}/${cite.repo!.toLowerCase()}#${cite.number}` : String(cite.number);
				if (!citedPrs.has(key)) {
					citedPrs.set(key, {
						number: cite.number,
						...(qualified ? { owner: cite.owner, repo: cite.repo } : {}),
						...(cite.host ? { host: cite.host } : {}),
						quote: sentence,
						message_id: m.id,
					});
				}
				evidence.add(m.id);
			}

			COMMIT_PATTERN.lastIndex = 0;
			let cm: RegExpExecArray | null;
			while ((cm = COMMIT_PATTERN.exec(text)) !== null) {
				const sha = cm[1];
				if (!sha) continue;
				if (NOT_A_SHA.has(sha.toLowerCase())) continue;
				// A sha must look deliberate: mostly digits, or mixed, and never a
				// plain word such as "android" or "acaddb".
				if (!/\d/.test(sha)) continue;
				const sentence = sentenceAround(text, cm.index);
				// A sha is only a citation when the sentence calls it a commit or asserts
				// causality about it. Without both halves, a summary line that happens to
				// contain a hash cites a commit that is not the cause.
				const namesCommit = /\bcommit\b/i.test(sentence);
				if (!namesCommit) continue;
				// A commit named as the repair is not the cause. The pull-request path already
				// guards this; the commit path did not.
				if (NAMES_THE_FIX.test(prefixBefore(text, cm.index))) continue;
				// "this reverts commit <sha>" is causality in its own words: the session is
				// undoing the commit it names.
				const namesRevert = anyMatch(REVERT_PATTERNS, sentence);
				if (!causalSentences(sentence).length && !namesRevert) continue;
				if (!DEFECT_CONTEXT.test(sentence) && !anyMatch(REGRESSION_TERMS, sentence) && !namesRevert) continue;
				if (anyMatch(UPSTREAM_PATTERNS, sentence)) {
					blamesUpstream = true;
					continue;
				}
				if (anyMatch(NEVER_WORKED_PATTERNS, sentence)) {
					neverWorked = true;
					continue;
				}
				if (!citedCommits.has(sha)) citedCommits.set(sha, { sha, quote: sentence, message_id: m.id });
				evidence.add(m.id);
			}

			if (citedPrs.size || citedCommits.size) signals.names_the_cause = true;
		}
	}

	const signalsFired = Object.entries(signals)
		.filter(([, v]) => v)
		.map(([k]) => k);

	// Two separate facts, deliberately not one.
	//
	// `claims_regression` is the LABEL: the session changed something and states that
	// a defect came from an earlier change, whether or not it names that change. Most
	// real regressions in this corpus state the cause without a number ("caused by my
	// own extension", "the collapse is from the new warmup"), and requiring a number
	// here threw away most of them.
	//
	// `names_the_cause` is what the ATTRIBUTION join needs: a pull request number,
	// which is unambiguous within a repository. A labelled regression without it is a
	// real finding that simply cannot be attributed to an author session.
	const namesCause = citedPrs.size > 0 || citedCommits.size > 0;
	const claims =
		signals.changed_something &&
		(signals.causal_claim || signals.reverts) &&
		!(neverWorked && neverWorkedSentence !== null && neverWorkedSentence === claimSentenceText) &&
		!upstreamClaim &&
		signalsFired.length >= config.minSignals;

	return {
		session_id: sessionId,
		claims_regression: claims,
		signals_fired: signalsFired,
		signals,
		cited_pull_requests: [...citedPrs.values()].sort((a, b) => a.number - b.number),
		cited_commits: [...citedCommits.values()].sort((a, b) => a.sha.localeCompare(b.sha)),
		blames_upstream: blamesUpstream,
		never_worked: neverWorked,
		evidence_message_ids: [...evidence].sort(),
	};
}
