// regression-attribution: the join that turns a claim into a chain.
//
// `regression-signal` writes, on the fix session, the pull requests and commits
// it blames. On its own that is an accusation with no author. This analyzer
// closes the loop: for each blamed pull request it finds the session that opened
// it, so the graph carries a walkable path
//
//     fix session → blamed PR → session that opened it → that session's agent
//
// and a reader can ask the question the corpus could not answer before: which
// earlier piece of work caused this repair, and who or what did that work.
//
// The join is deliberately narrow. It matches on the pull request number within
// one repository, never on a title or a guess, and it only follows PRs that some
// local session is known to have opened. A blame we cannot resolve is recorded
// as unresolved rather than dropped, because "we could not find the author" and
// "there is no author" are different facts and only the first is honest.
//
// What this analyzer does NOT do, and why:
//
//   - It does not decide whether the blamed change really introduced the defect.
//     That needs the tree (git blame, the merged bodies) and belongs to the
//     verification step, not to a deterministic pass over transcripts.
//   - It does not follow commits to sessions. A commit sha in a transcript rarely
//     carries the repository it belongs to, so a sha→session join would be a
//     guess. Pull request numbers are unambiguous within a repository, so they
//     are the only join this analyzer performs.
//
// Deterministic: no model, no network. Reads `regression-signal` nodes and the
// pull request records other analyzers already wrote.

import { createHash } from "node:crypto";

export const ANALYZER_ID = "regression-attribution";

/** The analyzers whose pull request records this one joins against. */
export const PR_ANALYZER_IDS = ["pr-opened", "pr-opened-script"] as const;

/** The dependency this analyzer declares, so the framework scopes its read. */
export const SIGNAL_ANALYZER_ID = "regression-signal";

export type Config = {
	/** Abbreviated commit shas are recorded but never resolved to a session. */
	reportUnresolvedCommits: boolean;
};

export const DEFAULT_CONFIG: Config = { reportUnresolvedCommits: true };

/** One pull request record, as `pr-opened` and `pr-opened-script` write it. */
export type PullRequestRecord = {
	session_id: string;
	/** The forge host. Records are GitHub today, so an absent host means GitHub. */
	host?: string;
	owner: string;
	repo: string;
	number: number;
	url: string;
	title: string | null;
};

/** A blamed pull request, resolved to the session that opened it. */
export type Attribution = {
	number: number;
	/** The sentence the blame was read from, so the attribution carries its reason. */
	quote: string;
	/** Message the claim was read from, inside the fix session. */
	message_id: string;
	/** The session that opened the blamed pull request, or null when none is known. */
	introducing_session_id: string | null;
	/** The blamed pull request's own title, when a record was found. */
	introducing_title: string | null;
	/** The blamed pull request's url, when a record was found. */
	introducing_url: string | null;
	/** True when a local session is known to have opened the blamed pull request. */
	resolved: boolean;
};

export type AttributionResult = {
	session_id: string;
	/** Blamed pull requests, resolved or not, in number order. */
	attributions: Attribution[];
	/** Blamed commits, recorded but never resolved to a session. See the header. */
	cited_commits: Array<{ sha: string; quote: string; message_id: string }>;
	/** How many blamed pull requests resolved to a session. */
	resolved_count: number;
	unresolved_count: number;
	/**
	 * True when the fix session and every blamed author session are the same work:
	 * the session repaired its own earlier change. That is a distinct finding from
	 * a repair of someone else's work.
	 */
	self_inflicted: boolean;
};

/**
 * Index pull request records by `owner/repo#number`.
 *
 * The first record for a key wins, matching `cost-per-pr`'s rule that a pull
 * request seen in two sessions belongs to the session that opened it first. The
 * order of `records` is therefore load-bearing and callers pass it in graph order.
 */
export function indexPullRequests(records: readonly PullRequestRecord[]): Map<string, PullRequestRecord> {
	const index = new Map<string, PullRequestRecord>();
	for (const r of records) {
		if (!r || typeof r.number !== "number" || !r.owner || !r.repo) continue;
		// The host is part of the key. Two forges can carry the same owner, repository and number,
		// and without it a citation resolves to whichever host was recorded first. Records are
		// GitHub today, so an absent host means GitHub.
		const key = `${(r.host ?? "github.com").toLowerCase()}|${r.owner.toLowerCase()}/${r.repo.toLowerCase()}#${r.number}`;
		if (!index.has(key)) index.set(key, r);
	}
	return index;
}

/**
 * Resolve a claim's blamed pull requests against the records.
 *
 * A claim that names no repository can only be resolved when exactly one
 * repository recorded that number. With two candidates the mapping is ambiguous,
 * and a guess here would manufacture an author — so it stays unresolved.
 */
export function attribute(
	sessionId: string,
	claim: {
		cited_pull_requests: Array<{ number: number; owner?: string; repo?: string; host?: string; quote: string; message_id: string }>;
		cited_commits: Array<{ sha: string; quote: string; message_id: string }>;
	},
	records: readonly PullRequestRecord[],
): AttributionResult {
	const index = indexPullRequests(records);

	// number → the distinct records that carry it, for the ambiguity rule.
	const byNumber = new Map<number, PullRequestRecord[]>();
	for (const r of records) {
		// The same validity test indexPullRequests applies. A malformed row would
		// otherwise add a phantom repository and make an unambiguous number ambiguous.
		if (!r || typeof r.number !== "number" || !r.owner || !r.repo) continue;
		const list = byNumber.get(r.number) ?? [];
		list.push(r);
		byNumber.set(r.number, list);
	}

	const attributions: Attribution[] = [];
	for (const cite of claim.cited_pull_requests) {
		// A citation that names its repository is narrowed to it before the ambiguity rule, so a
		// number another repository also recorded cannot make it unresolved. Only a claim that
		// names nothing needs the uniqueness rule.
		const cited = cite.owner && cite.repo ? `${cite.owner}/${cite.repo}`.toLowerCase() : null;
		// A named host narrows too. Without it a citation for one forge resolves against the
		// session that opened the same owner, repository and number on another.
		const citedHost = cite.host ? cite.host.toLowerCase() : null;
		const hostOf = (c: { host?: string }) => (c.host ?? "github.com").toLowerCase();
		const candidates = (byNumber.get(cite.number) ?? []).filter(
			(c) =>
				(cited === null || `${c.owner}/${c.repo}`.toLowerCase() === cited) &&
				(citedHost === null || hostOf(c) === citedHost),
		);
		// Two hosts carrying one number are two identities, not one repository recorded twice.
		const distinctRepos = new Set(candidates.map((c) => `${hostOf(c)}|${c.owner}/${c.repo}`.toLowerCase()));

		// A record whose session is unknown resolves nothing. `resolved` is documented as
		// "a local session is known to have opened the blamed pull request", so a record
		// carrying an empty id is not one.
		const withSession = candidates.filter((c) => c.session_id && c.session_id.length > 0);
		let hit: PullRequestRecord | undefined;
		if (distinctRepos.size === 1 && withSession.length > 0) {
			// Unambiguous: every record for this number is the same repository, so the
			// first-opened one is the author session.
			// distinctRepos already carries the host, so it is the whole key prefix.
			hit = index.get(`${[...distinctRepos][0]}#${cite.number}`);
		}

		attributions.push({
			number: cite.number,
			quote: cite.quote,
			message_id: cite.message_id,
			introducing_session_id: hit?.session_id ?? null,
			introducing_title: hit?.title ?? null,
			introducing_url: hit?.url ?? null,
			resolved: Boolean(hit),
		});
	}

	attributions.sort((a, b) => a.number - b.number);
	const resolvedCount = attributions.filter((a) => a.resolved).length;

	// Self-inflicted means every resolved author session is this same session, and
	// there is at least one. An unresolved blame cannot make a repair self-inflicted.
	const resolvedSessions = attributions.filter((a) => a.resolved).map((a) => a.introducing_session_id);
	const selfInflicted =
		resolvedSessions.length > 0 && resolvedSessions.every((s) => s === sessionId);

	return {
		session_id: sessionId,
		attributions,
		cited_commits: [...claim.cited_commits].sort((a, b) => a.sha.localeCompare(b.sha)),
		resolved_count: resolvedCount,
		unresolved_count: attributions.length - resolvedCount,
		self_inflicted: selfInflicted,
	};
}

/** Read the properties `regression-signal` wrote on a node. */
export function claimFromNode(content: unknown): {
	cited_pull_requests: Array<{ number: number; owner?: string; repo?: string; host?: string; quote: string; message_id: string }>;
	cited_commits: Array<{ sha: string; quote: string; message_id: string }>;
} | null {
	const c = content as Record<string, unknown> | null | undefined;
	if (!c) return null;
	const prs = Array.isArray(c["cited_pull_requests"]) ? (c["cited_pull_requests"] as any[]) : [];
	const commits = Array.isArray(c["cited_commits"]) ? (c["cited_commits"] as any[]) : [];
	const prsOk = prs
		.filter((p) => p && typeof p.number === "number")
		.map((p) => ({
			number: p.number,
			// The repository is what makes a cross-repository citation resolvable, so the parser
			// carries it rather than dropping it on the way to attribution.
			...(typeof p.owner === "string" && typeof p.repo === "string" ? { owner: p.owner, repo: p.repo } : {}),
			...(typeof p.host === "string" ? { host: p.host } : {}),
			quote: String(p.quote ?? ""),
			message_id: String(p.message_id ?? ""),
		}));
	const commitsOk = commits
		.filter((p) => p && typeof p.sha === "string")
		.map((p) => ({ sha: p.sha, quote: String(p.quote ?? ""), message_id: String(p.message_id ?? "") }));
	if (prsOk.length === 0 && commitsOk.length === 0) return null;
	return { cited_pull_requests: prsOk, cited_commits: commitsOk };
}

/** Read a `pr-opened`/`pr-opened-script` node's content into a record. */
export function recordFromNode(content: unknown): PullRequestRecord | null {
	const c = content as Record<string, any> | null | undefined;
	const pr = c?.["pull_request"];
	if (!pr || typeof pr.number !== "number" || !pr.owner || !pr.repo) return null;
	return {
		// The owning session is the node's own session, which the caller supplies when
		// absent; the built-in writes it into content_json as `session_id`.
		session_id: String(c?.["session_id"] ?? pr?.session_id ?? ""),
		// The host is part of the record's identity. Dropping it here keyed every record as
		// GitHub, so a citation for another forge was reported unresolved while a GitHub
		// citation for the same number resolved to that other forge's session.
		...(typeof pr.host === "string" && pr.host ? { host: pr.host } : {}),
		owner: String(pr.owner),
		repo: String(pr.repo),
		number: Number(pr.number),
		url: String(pr.url ?? ""),
		title: pr.title == null ? null : String(pr.title),
	};
}

/** A stable identity for the result, so a re-sync that changes the graph recomputes. */
export function attributionHash(result: AttributionResult): string {
	// Everything the node carries, so a corrected quote, title, url, message id or a new
	// cited commit re-identifies it. Hashing two fields promised more than it delivered.
	const digestible = {
		attributions: result.attributions,
		cited_commits: result.cited_commits,
	};
	return createHash("sha256").update(JSON.stringify(digestible)).digest("hex").slice(0, 8);
}
