/**
 * Configuration for the repo-identity analyzer.
 *
 * Every knob is part of the config fingerprint: changing one marks prior nodes
 * stale for the `config` reason.
 */

import { Type, type Static } from "typebox";

export const RepoIdentityConfig = Type.Object({
	/** Tool names treated as shell execution, whose `command` argument is read. Compared case-insensitively. */
	shellToolNames: Type.Array(Type.String()),
	/** Character cap on the result text read per call. */
	maxResultChars: Type.Integer({ minimum: 1 }),
});
export type RepoIdentityConfig = Static<typeof RepoIdentityConfig>;

export const DEFAULT_REPO_IDENTITY_CONFIG: RepoIdentityConfig = {
	shellToolNames: ["bash"],
	maxResultChars: 20_000,
};
