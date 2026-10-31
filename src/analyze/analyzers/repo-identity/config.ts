/**
 * Configuration for the repo-identity analyzer.
 *
 * Every knob is part of the config fingerprint: changing one marks prior nodes
 * stale for the `config` reason.
 */

import { Type, type Static } from "typebox";

export const RepoIdentityConfig = Type.Object({
	/**
	 * Directory names under which a person keeps repositories. The directory right
	 * below the first such name in a session's working directory is the repository.
	 * The leftmost match wins. `src` is not a default root: a repository's own
	 * `src` directory would be read as a root and key the repository as `lib`.
	 * Compared case-insensitively. A host that records the working directory
	 * differently, or a layout with another root, is a config change.
	 */
	repoRoots: Type.Array(Type.String()),
	/**
	 * Path prefixes of temporary directories. A session started there belongs to no
	 * repository, and the record says so instead of guessing.
	 */
	tempPrefixes: Type.Array(Type.String()),
});
export type RepoIdentityConfig = Static<typeof RepoIdentityConfig>;

export const DEFAULT_REPO_IDENTITY_CONFIG: RepoIdentityConfig = {
	repoRoots: ["source", "code", "projects", "repos", "git", "dev", "workspace", "work"],
	tempPrefixes: ["/tmp", "/private/tmp", "/var/tmp", "/private/var", "/var/folders"],
};
