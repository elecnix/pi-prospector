/**
 * Pull-request creation detection for pr-opened.
 *
 * A session is the one that *opened* a pull request when it ran the command
 * that created it and the forge answered with the pull request's URL. Both
 * halves are required, and the second half is what separates opening a pull
 * request from reading, monitoring, or merely quoting one:
 *
 *   - the call must be a creation call — `gh pr create` in a shell command, or a
 *     hosted-forge tool whose own arguments carry the pull request (the
 *     `create_pull_request` an MCP server exposes);
 *   - the call must have succeeded;
 *   - the URL must be one the forge printed as its own answer. `gh pr create`
 *     prints the URL alone on a line, so a URL that shares its line with other
 *     text came from something else — a `grep` hit, a log line, a document the
 *     session read — and the session did not open that pull request.
 *
 * `gh pr create` also prints the URL of an existing pull request when one is
 * already open for the branch, and exits non-zero. That call created nothing,
 * so its URL is skipped. The exit status alone cannot decide this: a command
 * line that tolerates the failure (`gh pr create … || true`) reports success,
 * which is why the result text is checked too.
 *
 * The detection reads the shared action stream (`src/analyze/tool-stream.ts`),
 * so "the result of that call" means the same thing here as in every other
 * analyzer. Pairing by tool-call id is what makes it safe when one step issues
 * several calls: a step that opens a pull request and greps a file in parallel
 * cannot have the grep output attributed to the create.
 */

import type { MessageRow } from "../../types.js";
import { buildToolStream, type ToolInvocation } from "../../tool-stream.js";
import { splitShellSegments } from "../navigation-efficiency/detect.js";
import { shortHash } from "../../input-hash.js";
import { DEFAULT_PR_OPENED_CONFIG, type PrOpenedConfig } from "./config.js";

/** A pull request URL, taken apart. */
export interface ParsedPullRequestUrl {
	url: string;
	host: string;
	owner: string;
	repo: string;
	number: number;
}

/** One pull request a session opened, with the evidence that says so. */
export interface OpenedPullRequest {
	url: string;
	host: string;
	owner: string;
	repo: string;
	number: number;
	/** The title the session gave it, or null when the call did not state one. */
	title: string | null;
	/** Which kind of call opened it. */
	via: "gh_pr_create" | "tool";
	/** The assistant message that issued the call. */
	call_message_id: string;
	/** The message that carried the result. */
	result_message_id: string;
}

export interface OpenedPullRequestWithEvidence {
	pull_request: OpenedPullRequest;
	/**
	 * Fingerprint of the call's arguments and the result text. It enters the
	 * node's source set, so a re-sync that backfills the result text re-identifies
	 * the unit and the node is recomputed against what the forge actually said.
	 */
	evidence_hash: string;
}

/** `https://host/owner/repo/pull/<number>`, with any path suffix or query dropped. */
const PR_URL_RE = /https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/([0-9]+)/;

/** A line that is nothing but a pull request URL, as `gh pr create` prints it. */
const BARE_PR_URL_LINE_RE = /^https?:\/\/[^\s]+\/[^\s]+\/[^\s]+\/pull\/[0-9]+\/?$/;

/** Parse a pull request URL, or return null when the string is not one. */
export function parsePullRequestUrl(raw: string): ParsedPullRequestUrl | null {
	const m = PR_URL_RE.exec(raw);
	if (!m) return null;
	const host = m[1]!;
	const owner = m[2]!;
	const repo = m[3]!;
	const number = Number(m[4]!);
	// A number that is not finite is not a pull request; the pattern allows long
	// digit runs that could overflow.
	if (!Number.isSafeInteger(number)) return null;
	return { url: `https://${host}/${owner}/${repo}/pull/${number}`, host, owner, repo, number };
}

/** One shell word, with the quoting that produced it recorded. */
interface ShellWord {
	/** The text, with quotes removed and backslash escapes resolved. */
	text: string;
	/** The word was written in single quotes, so the shell expands nothing in it. */
	singleQuoted: boolean;
	/** A dollar sign in the text came from an escape (`\$5`), so the shell reads it literally. */
	literalDollar: boolean;
}

/**
 * Whether a word written in double quotes holds shell syntax the transcript
 * cannot resolve.
 *
 * A title built by the shell (`--title "$TAG"`, `--title "$(git log -1 …)"`) is
 * whatever that expansion produced, and the transcript does not record the
 * environment it ran in. Reporting the literal `$TAG` as the title would be
 * wrong, so the title is recorded as unknown instead.
 */
function carriesExpansion(word: ShellWord): boolean {
	if (word.singleQuoted) return false;
	if (word.literalDollar) return false;
	return /\$/.test(word.text) || /`/.test(word.text);
}

/**
 * Tokenize one shell segment into words.
 *
 * Quotes group a word and come off it, and a backslash-newline pair is a line
 * continuation the shell removes. Only what this analyzer reads is modelled: a
 * heredoc body is left in place as ordinary text.
 */
function shellWords(segment: string): ShellWord[] {
	const words: ShellWord[] = [];
	let text = "";
	let singleQuoted = false;
	let literalDollar = false;
	let started = false;
	let inSingle = false;
	let inDouble = false;

	const endWord = (): void => {
		if (started) words.push({ text, singleQuoted, literalDollar });
		text = "";
		singleQuoted = false;
		literalDollar = false;
		started = false;
	};

	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i]!;
		if (ch === "\\" && !inSingle) {
			const next = segment[i + 1];
			if (next === "\n") {
				i++;
				continue;
			}
			if (next !== undefined) {
				// Inside double quotes the shell removes a backslash only before a
				// character that would otherwise be special; for the flags and titles
				// read here, removing it always yields the value.
				if (next === "$") literalDollar = true;
				text += next;
				started = true;
				i++;
				continue;
			}
		}
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			if (inSingle) singleQuoted = true;
			started = true;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			started = true;
			continue;
		}
		if (!inSingle && !inDouble && /\s/.test(ch)) {
			endWord();
			continue;
		}
		text += ch;
		started = true;
	}
	endWord();
	return words;
}

/** Drop the leading `cd`, environment assignments, and `timeout` a wrapper puts before the program. */
function programIndex(words: readonly ShellWord[]): number {
	let i = 0;
	while (i < words.length) {
		const w = words[i]!.text;
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
			i++;
		} else if (w === "cd" || w === "sudo" || w === "timeout") {
			// Each takes its own arguments before the program it wraps.
			i += 2;
		} else {
			break;
		}
	}
	return i;
}

/** The value a word contributes as a title, or null when the shell would build it. */
function titleFromWord(word: ShellWord, config: PrOpenedConfig): string | null {
	if (word.text.length === 0) return null;
	if (carriesExpansion(word)) return null;
	return word.text.length > config.maxTitleChars ? word.text.slice(0, config.maxTitleChars) : word.text;
}

/**
 * The titles of every `gh pr create` in a shell command, in the order the
 * segments appear. Nulls are titles the command did not state — a `--fill` run,
 * or one whose title the shell builds.
 *
 * The command is split into simple-command segments first, so the words inside
 * another command's argument (`grep -n "gh pr create" src/index.ts`) are never
 * read as an invocation.
 */
export function ghPrCreateTitles(
	command: string,
	config: PrOpenedConfig = DEFAULT_PR_OPENED_CONFIG,
): Array<string | null> {
	// Line continuations join segments before the split, exactly as the shell
	// joins them: a creation command wrapped across lines is one segment.
	const joined = command.replace(/\\\r?\n/g, " ");
	const titles: Array<string | null> = [];
	for (const segment of splitShellSegments(joined)) {
		const words = shellWords(segment);
		const i = programIndex(words);
		if (words[i]?.text !== "gh" || words[i + 1]?.text !== "pr" || words[i + 2]?.text !== "create") continue;

		let title: string | null = null;
		for (let j = i + 3; j < words.length; j++) {
			const w = words[j]!.text;
			if (w === "--fill" || w === "--fill-first" || w === "--fill-verbose") {
				title = null;
				break;
			}
			const inline = /^--title=(.*)$/.exec(w);
			if (inline) {
				title = titleFromWord({ ...words[j]!, text: inline[1]! }, config);
				break;
			}
			if (w === "--title" || w === "-t") {
				const value = words[j + 1];
				title = value ? titleFromWord(value, config) : null;
				break;
			}
		}
		titles.push(title);
	}
	return titles;
}

/** The lines a `gh pr create` result printed that are nothing but a pull request URL. */
function bareUrlLines(text: string): string[] {
	const out: string[] = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (BARE_PR_URL_LINE_RE.test(trimmed)) out.push(trimmed);
	}
	return out;
}

/**
 * The pull request URLs a `gh pr create` result is evidence of having created.
 *
 * The URL of a pull request that already existed is dropped: it follows the
 * forge's own "already exists" message, and that call created nothing.
 */
function createdUrls(text: string, config: PrOpenedConfig): string[] {
	const lines = text.split("\n");
	const alreadyExists = config.alreadyExistsPatterns.map((p) => new RegExp(p, "i"));
	const out: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		const trimmed = lines[i]!.trim();
		if (!BARE_PR_URL_LINE_RE.test(trimmed)) continue;
		const previous = lines[i - 1] ?? "";
		if (alreadyExists.some((re) => re.test(previous))) continue;
		out.push(trimmed);
	}
	return out;
}

/** Whether a tool name is a creation tool, matching a server's namespaced form. */
function isCreateTool(name: string, config: PrOpenedConfig): boolean {
	const lower = name.toLowerCase();
	return config.createToolNames.some((t) => {
		const want = t.toLowerCase();
		return lower === want || lower.endsWith(`_${want}`);
	});
}

/** The result text of a call, read only when the row carried exactly one result. */
function singleResultText(messages: readonly MessageRow[], inv: ToolInvocation): string | null {
	if (!inv.outcome) return null;
	const row = messages.find((m) => m.id === inv.outcome!.messageId);
	if (!row?.tool_results) return null;
	let results: unknown;
	try {
		results = JSON.parse(row.tool_results);
	} catch {
		return null;
	}
	// The transcript joins several results' texts into one field, and there is no
	// honest way to split them back apart. One result on the row means the text
	// belongs to this call.
	if (!Array.isArray(results) || results.length !== 1) return null;
	return row.content_text ?? "";
}

/** A URL the session's own creation call printed, from the hosted-forge payload. */
function toolResultUrls(text: string, inv: ToolInvocation): string[] {
	const fromArgs = [inv.args["owner"], inv.args["repo"]].filter((v): v is string => typeof v === "string");
	const out: string[] = [];
	for (const m of text.matchAll(new RegExp(PR_URL_RE.source, "g"))) {
		const parsed = parsePullRequestUrl(m[0]);
		if (!parsed) continue;
		// The tool names the repository it acted on, so a URL for another
		// repository in the payload belongs to something else the response
		// mentioned — a linked issue, a cross-referenced pull request.
		if (fromArgs.length === 2 && (parsed.owner !== fromArgs[0] || parsed.repo !== fromArgs[1])) continue;
		out.push(parsed.url);
	}
	return out;
}

/** The title a hosted-forge call passed, when its arguments carry one. */
function toolTitle(inv: ToolInvocation, config: PrOpenedConfig): string | null {
	const raw = inv.args["title"];
	if (typeof raw !== "string" || raw.trim().length === 0) return null;
	return raw.length > config.maxTitleChars ? raw.slice(0, config.maxTitleChars) : raw;
}

/**
 * Every pull request the session opened, in the order it opened them.
 *
 * A pull request appears once. A session that retried a creation call and got
 * the same URL back holds one pull request, not two, and one node for it.
 */
export function findOpenedPullRequests(
	messages: readonly MessageRow[],
	config: PrOpenedConfig,
): OpenedPullRequestWithEvidence[] {
	const stream = buildToolStream([...messages]);
	const shellNames = new Set(config.shellToolNames.map((n) => n.toLowerCase()));
	const found: OpenedPullRequestWithEvidence[] = [];
	const seen = new Map<string, OpenedPullRequestWithEvidence>();

	for (const inv of stream.invocations) {
		const outcome = inv.outcome;
		if (!outcome || outcome.isError) continue;
		const resultText = singleResultText(messages, inv);
		if (resultText === null) continue;
		const capped = resultText.length > config.maxResultChars ? resultText.slice(0, config.maxResultChars) : resultText;

		const candidates: Array<{ url: string; title: string | null; via: OpenedPullRequest["via"] }> = [];
		if (shellNames.has(inv.name.toLowerCase())) {
			const command = typeof inv.args["command"] === "string" ? (inv.args["command"] as string) : null;
			if (command !== null) {
				const titles = ghPrCreateTitles(command, config);
				if (titles.length > 0) {
					const urls = createdUrls(capped, config);
					// A command that creates several pull requests prints their URLs in
					// creation order; pairing by position keeps each title with its own.
					for (let i = 0; i < urls.length; i++) {
						candidates.push({ url: urls[i]!, title: titles[Math.min(i, titles.length - 1)] ?? null, via: "gh_pr_create" });
					}
				}
			}
		} else if (isCreateTool(inv.name, config)) {
			const title = toolTitle(inv, config);
			for (const url of toolResultUrls(capped, inv)) candidates.push({ url, title, via: "tool" });
		}

		for (const candidate of candidates) {
			const parsed = parsePullRequestUrl(candidate.url);
			if (!parsed) continue;
			const evidence_hash = shortHash([inv.name, JSON.stringify(inv.args), outcome.messageId, shortHash(capped)].join("\n"));
			const entry: OpenedPullRequestWithEvidence = {
				pull_request: {
					...parsed,
					title: candidate.title,
					via: candidate.via,
					call_message_id: inv.messageId,
					result_message_id: outcome.messageId,
				},
				evidence_hash,
			};
			const previous = seen.get(parsed.url);
			if (previous) {
				// The same pull request again: keep the first call, and the title the
				// session first gave it.
				if (previous.pull_request.title === null && entry.pull_request.title !== null) {
					previous.pull_request.title = entry.pull_request.title;
				}
				continue;
			}
			seen.set(parsed.url, entry);
			found.push(entry);
		}
	}

	return found;
}
