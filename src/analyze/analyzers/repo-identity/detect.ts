/**
 * Repository identity from the git commands a session ran.
 *
 * A host records the directory a session ran in and nothing about the
 * repository. Directory names say little: a worktree is named for a branch, a
 * clone for whatever its owner typed, and a path layout is one person's habit.
 * What names a repository without ambiguity is the forge address the session's
 * own git commands touched: the remote a `git remote -v` printed, the address a
 * `git push` reported, the pull request URL `gh pr create` printed, the
 * `--repo owner/name` a `gh` command was given.
 *
 * Those are **hints**, from strongest to weakest:
 *
 *   - `remote_output`: the remote address in the output of `git remote`, `git
 *     push`, `git fetch`, `git pull`, or `git clone`.
 *   - `pr_url`: a pull request URL in the output of a `gh pr` command.
 *   - `gh_repo_flag`: the `-R` / `--repo` value of a `gh` command.
 *   - `command_url`: a remote address written in a git command (`git clone
 *     <url>`, `git remote add <name> <url>`).
 *
 * The session's working directory scopes the hints. A command that ran in
 * another directory (`cd /elsewhere && …`, `git -C /elsewhere …`, with a path
 * outside the working directory) says nothing about this session's repository,
 * so its output is left out. A command without a directory ran in the working
 * directory.
 *
 * The key is the most-supported address among the strongest hints present:
 * `host/owner/name`, lowercased, without a trailing `.git` and without
 * credentials. A session with no hint has no key, and says so, rather than a key
 * guessed from a folder name.
 */

import type { MessageRow } from "../../types.js";
import { buildToolStream } from "../../tool-stream.js";
import { commandSegments, gitSubcommand, stripCommandText } from "../time-economy/spans.js";
import { DEFAULT_REPO_IDENTITY_CONFIG, type RepoIdentityConfig } from "./config.js";

export type HintBasis = "remote_output" | "pr_url" | "gh_repo_flag" | "command_url";

/** Strongest first. */
export const HINT_STRENGTH: readonly HintBasis[] = ["remote_output", "pr_url", "gh_repo_flag", "command_url"];

export interface RepoHint {
	/** `host/owner/name`, lowercase. */
	repo: string;
	basis: HintBasis;
	/** The message the hint was read from: the call, or the result. */
	message_id: string;
}

export interface RepoIdentity {
	repo_key: string | null;
	/** The basis of the strongest hint, or "none". */
	basis: HintBasis | "none";
	/** Hints that support the chosen key. */
	hint_count: number;
	/** Distinct addresses among the hints of the chosen basis. */
	candidate_count: number;
	/** The last segment of the working directory, or null when none was recorded. */
	directory: string | null;
	/** The message that carried the first supporting hint, or null with no key. */
	evidence_message_id: string | null;
}

/** `host/owner/name`, lowercased, without credentials or a trailing `.git`. */
export function normaliseRepo(host: string, owner: string, name: string): string | null {
	const h = host.toLowerCase().replace(/^[^@]*@/, "");
	const o = owner.toLowerCase();
	const n = name.toLowerCase().replace(/\.git$/, "");
	if (!h || !o || !n || /[\s"'<>]/.test(`${h}${o}${n}`)) return null;
	return `${h}/${o}/${n}`;
}

const FORGE_PATH = /https?:\/\/(?:[^/\s@]+@)?([^/\s]+)\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?=[/\s)#?]|$)/g;
const SSH_ADDRESS = /git@([^:/\s]+)[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?(?=[\s)]|$)/g;
/** `ssh://[user@]host[:port]/owner/name`. */
const SSH_URL = /ssh:\/\/(?:[^@\s/]+@)?([^:/\s]+)(?::\d+)?\/([^/\s]+)\/([^/\s]+?)(?:\.git)?(?=[\s)]|$)/g;
/** `host:owner/name` as git prints it for an address written without a user. */
const SCP_ADDRESS = /(?:^|\s)(?:[\w.-]+@)?([\w-]+(?:\.[\w-]+)+):([\w.-]+)\/([^/\s]+?)(?:\.git)?(?=\s|$)/g;
const PR_URL = /https?:\/\/(?:[^/\s@]+@)?([^/\s]+)\/([^/\s]+)\/([^/\s]+?)\/(?:pull|pulls|issues)\/\d+/g;
const ADDRESS_PATTERNS = [FORGE_PATH, SSH_URL, SSH_ADDRESS, SCP_ADDRESS];
const NOT_A_REPO_OWNER = new Set(["orgs", "settings", "login", "apps"]);

function addresses(text: string, patterns: readonly RegExp[]): string[] {
	const found: string[] = [];
	for (const re of patterns) {
		for (const m of text.matchAll(new RegExp(re.source, "g"))) {
			const repo = normaliseRepo(m[1] ?? "", m[2] ?? "", m[3] ?? "");
			if (repo && !NOT_A_REPO_OWNER.has(m[2]!.toLowerCase())) found.push(repo);
		}
	}
	// One address written once is one hint, however many patterns read it.
	return [...new Set(found)];
}

/** The `-R` / `--repo` value of a `gh` command, as `host/owner/name`. */
function ghRepoFlag(segment: string): string | null {
	const m = /(?:^|\s)(?:-R|--repo)[ =]["']?([^\s"']+)/.exec(segment);
	if (!m?.[1]) return null;
	const parts = m[1].split("/").filter(Boolean);
	if (parts.length === 2) return normaliseRepo("github.com", parts[0]!, parts[1]!);
	if (parts.length === 3) return normaliseRepo(parts[0]!, parts[1]!, parts[2]!);
	return null;
}

/** A path with forward slashes, no trailing slash, and the case folded when it is a Windows drive path. */
function pathKey(path: string): string {
	const p = path.replace(/\\/g, "/").replace(/\/+$/, "");
	return /^[a-zA-Z]:/.test(p) ? p.toLowerCase() : p;
}

/**
 * Whether a directory is the working directory or below it. A relative path is
 * inside unless it climbs out, and a path held in a variable or under `~` is
 * outside, since its value is not in the transcript.
 */
function isWithin(directory: string, cwd: string): boolean {
	if (directory === "_") return false;
	const target = pathKey(directory);
	if (target.startsWith("~") || target.includes("$")) return false;
	if (!/^(?:\/|[a-zA-Z]:)/.test(target)) return !target.startsWith("..");
	const base = pathKey(cwd);
	return target === base || target.startsWith(`${base}/`);
}

/** The directory a `cd` segment moves to, or null when the segment is not a `cd`. */
function cdTarget(segment: string): string | null {
	const m = /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))\s*$/.exec(segment);
	if (m) return m[1] ?? m[2] ?? m[3] ?? "";
	return /^\s*cd\s*$/.test(segment) ? "" : null;
}

/** The `-C` directory of a git segment, or null. */
function gitDirectory(segment: string): string | null {
	const git = /\bgit\s+(?:(?:-[a-zA-Z]\s+\S+|--[\w-]+(?:=\S+)?)\s+)*-C\s+(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(segment);
	return git ? (git[1] ?? git[2] ?? git[3] ?? null) : null;
}

/** Every hint in a session, in stream order. */
export function findRepoHints(
	messages: MessageRow[],
	cwd: string,
	config: RepoIdentityConfig = DEFAULT_REPO_IDENTITY_CONFIG,
): RepoHint[] {
	const shell = new Set(config.shellToolNames.map((n) => n.toLowerCase()));
	const byId = new Map(messages.map((m) => [m.id, m]));
	const hints: RepoHint[] = [];

	for (const call of buildToolStream(messages).invocations) {
		if (!shell.has(call.name.toLowerCase())) continue;
		const command = call.args["command"];
		if (typeof command !== "string") continue;
		const row = call.outcome ? byId.get(call.outcome.messageId) : undefined;
		const single = row?.tool_results ? isSingleResult(row.tool_results) : false;
		const output = !call.outcome?.isError && single ? (row?.content_text ?? "").slice(0, config.maxResultChars) : "";

		// Segments are told apart on the text with quoted strings blanked, so a quoted
		// separator splits nothing. The same segment of the raw text is then read for
		// the values a quote holds (`--repo "owner/name"`).
		const blanked = stripCommandText(command, "_");
		const stripped = commandSegments(blanked);
		const raw = commandSegments(command);
		const aligned = raw.length === stripped.length;
		// Where the shell is as the segments run in order: a `cd` moves it for the rest of the call.
		let inside = true;
		for (const [i, segment] of stripped.entries()) {
			// The directory is read from the raw text, so a quoted path is a path and not a blank.
			const text = aligned ? raw[i]! : segment;
			const moved = cdTarget(text);
			if (moved !== null) {
				inside = moved === "" ? false : /^(?:\/|[a-zA-Z]:|~|\$|_)/.test(moved) ? isWithin(moved, cwd) : inside && isWithin(moved, cwd);
				continue;
			}
			const dir = gitDirectory(text);
			const here = dir === null ? inside : /^(?:\/|[a-zA-Z]:|~|\$|_)/.test(dir) ? isWithin(dir, cwd) : inside && isWithin(dir, cwd);
			if (cwd !== "" && !here) continue;
			const program = segment
				.trim()
				.split(/\s+/)
				.find((w) => !/^(?:[A-Za-z_][A-Za-z0-9_]*=.*|timeout|\d+)$/.test(w));
			if (program === "gh") {
				const flag = ghRepoFlag(text);
				if (flag) hints.push({ repo: flag, basis: "gh_repo_flag", message_id: call.messageId });
				if (/\bgh\s+pr\b/.test(segment) && output) {
					for (const repo of addresses(output, [PR_URL])) hints.push({ repo, basis: "pr_url", message_id: row!.id });
				}
			} else if (program === "git") {
				const sub = gitSubcommand(segment);
				if (/\s(?:clone|add|set-url)\s/.test(segment) && (sub === "clone" || sub === "remote")) {
					for (const repo of addresses(text, ADDRESS_PATTERNS)) hints.push({ repo, basis: "command_url", message_id: call.messageId });
				}
				if (output && sub !== null && ["remote", "push", "fetch", "pull", "ls-remote"].includes(sub)) {
					for (const repo of remoteOutputAddresses(output, sub)) hints.push({ repo, basis: "remote_output", message_id: row!.id });
				}
			}
		}
	}
	return hints;
}

/**
 * The remote addresses a git command's output names. `git remote -v` lists
 * `origin` first, so only the first address counts there. `push`, `fetch`, `pull`
 * prints `To <address>` / `From <address>` lines.
 */
function remoteOutputAddresses(output: string, sub: string): string[] {
	if (sub === "remote" || sub === "ls-remote") {
		const first = addresses(output, ADDRESS_PATTERNS)[0];
		return first ? [first] : [];
	}
	const lines = output.split("\n").filter((l) => /^\s*(?:To|From)\s/.test(l));
	return lines.flatMap((l) => addresses(l, ADDRESS_PATTERNS));
}

function isSingleResult(toolResults: string): boolean {
	try {
		const parsed: unknown = JSON.parse(toolResults);
		return Array.isArray(parsed) && parsed.length === 1;
	} catch {
		return false;
	}
}

/** The identity the hints support: the most-supported address among the strongest basis present. */
export function chooseRepo(hints: readonly RepoHint[], cwd: string): RepoIdentity {
	const segments = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
	const directory = segments[segments.length - 1] ?? null;
	for (const basis of HINT_STRENGTH) {
		const of = hints.filter((h) => h.basis === basis);
		if (of.length === 0) continue;
		const counts = new Map<string, { n: number; first: RepoHint }>();
		for (const h of of) {
			const held = counts.get(h.repo);
			if (held) held.n++;
			else counts.set(h.repo, { n: 1, first: h });
		}
		// Most hints win. A tie goes to the address seen first.
		const [repo, { n, first }] = [...counts.entries()].sort((a, b) => b[1].n - a[1].n)[0]!;
		return { repo_key: repo, basis, hint_count: n, candidate_count: counts.size, directory, evidence_message_id: first.message_id };
	}
	return { repo_key: null, basis: "none", hint_count: 0, candidate_count: 0, directory, evidence_message_id: null };
}
