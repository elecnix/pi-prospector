/**
 * Repository identity from a session's working directory.
 *
 * A host records the directory a session ran in, and nothing else about where it
 * ran. Two sessions in two worktrees of one repository have two directories, and
 * a host's own project field spells one directory several ways (a path, a path
 * with its separators turned into hyphens). A rate per repository needs one key
 * for the repository, whatever the worktree or the spelling.
 *
 * The key is the directory right below a repository root (`~/Source/<repo>/…`),
 * lowercased, with a trailing `.git` removed. That covers a plain clone and the
 * bare-repository-plus-worktrees layout, where every worktree sits below the
 * repository's own directory. A directory outside every root has no key: the
 * record says why (temporary, or simply unplaced) rather than inventing one.
 */

import { DEFAULT_REPO_IDENTITY_CONFIG, type RepoIdentityConfig } from "./config.js";

export type RepoPlacement = "repo" | "temp" | "unplaced" | "unknown";

export interface RepoIdentity {
	/** The canonical repository key, or null when the directory is in no repository. */
	repo_key: string | null;
	placement: RepoPlacement;
	/**
	 * The first directory below the repository: a worktree's name in the
	 * worktrees layout, otherwise a subdirectory. Null when the session ran in the
	 * repository's own directory or has no repository.
	 */
	checkout: string | null;
	/** The root name the key was found under, as the config spells it. */
	root: string | null;
}

/** A repository key: lowercase, no trailing `.git`. */
export function normaliseRepoKey(name: string): string {
	return name.toLowerCase().replace(/\.git$/, "");
}

/** The identity of the repository a working directory belongs to. */
export function repoIdentityOf(
	cwd: string,
	config: RepoIdentityConfig = DEFAULT_REPO_IDENTITY_CONFIG,
): RepoIdentity {
	const path = cwd.trim().replace(/\\/g, "/");
	if (path === "") return { repo_key: null, placement: "unknown", checkout: null, root: null };

	const segments = path.split("/").filter((s) => s !== "");
	const roots = config.repoRoots.map((r) => r.toLowerCase());
	const at = segments.findIndex((s, i) => i < segments.length - 1 && roots.includes(s.toLowerCase()));
	if (at >= 0) {
		const repo = normaliseRepoKey(segments[at + 1]!);
		if (repo !== "") {
			return {
				repo_key: repo,
				placement: "repo",
				checkout: segments[at + 2] ?? null,
				root: config.repoRoots.find((r) => r.toLowerCase() === segments[at]!.toLowerCase()) ?? null,
			};
		}
	}

	const lower = `/${segments.join("/")}`.toLowerCase();
	const temp = config.tempPrefixes.some((p) => {
		// The same spelling as the path: forward slashes, one leading slash, lowercase.
		const prefix = `/${p.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")}`.toLowerCase();
		return lower === prefix || lower.startsWith(`${prefix}/`);
	});
	return { repo_key: null, placement: temp ? "temp" : "unplaced", checkout: null, root: null };
}
