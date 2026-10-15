/**
 * Configuration for the pr-opened analyzer.
 *
 * Every knob is part of the config fingerprint, exactly like every other
 * analyzer's config: changing one marks prior nodes stale for the `config`
 * reason; a plain fill leaves them alone and `--revise config` recomputes them
 * with lineage preserved.
 */

import { Type, type Static } from "typebox";

export const PrOpenedConfig = Type.Object({
	/**
	 * Tool names treated as shell execution, whose `command` argument is searched
	 * for a pull-request creation call. Kept as config rather than hardcoded so a
	 * harness with a differently named shell tool is a config change, not a
	 * version bump.
	 */
	shellToolNames: Type.Array(Type.String()),
	/**
	 * Tool names whose own arguments create a pull request — the hosted-forge
	 * tools an MCP server exposes, such as GitHub's `create_pull_request`. A tool
	 * matches an entry when its name is the entry or ends with `_` plus it, so the
	 * server's namespacing (`mcp__github__create_pull_request`) needs no entry.
	 */
	createToolNames: Type.Array(Type.String()),
	/**
	 * Regex sources recognising a pull request that already existed, matched
	 * case-insensitively against the result text. `gh pr create` prints the URL of
	 * the existing pull request on the line after such a message, and that URL is
	 * not evidence this session opened anything.
	 */
	alreadyExistsPatterns: Type.Array(Type.String()),
	/**
	 * Character cap on the result text read per call. A transcript's tool result
	 * can run to megabytes, and the URL sits at the end of `gh pr create`'s
	 * output; the cap is generous enough for that, and bounds the work a synced
	 * session can impose.
	 */
	maxResultChars: Type.Integer({ minimum: 1 }),
	/**
	 * Character cap on the stored title. The title is provenance for a human
	 * reading the node, not analysis input, and the graph is durable and widely
	 * readable.
	 */
	maxTitleChars: Type.Integer({ minimum: 1 }),
});
export type PrOpenedConfig = Static<typeof PrOpenedConfig>;

export const DEFAULT_PR_OPENED_CONFIG: PrOpenedConfig = {
	shellToolNames: ["bash"],
	createToolNames: ["create_pull_request"],
	alreadyExistsPatterns: ["already exists"],
	maxResultChars: 200_000,
	maxTitleChars: 300,
};
