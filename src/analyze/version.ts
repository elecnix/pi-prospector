/**
 * Analyzer version identity and revise-reason logic.
 *
 * An analyzer's version is a `major.minor` pair the *author* owns: major for a
 * change the author judges significant, minor for a small one. The version
 * represents everything the author ships — logic, default prompt, default tier.
 *
 * When a node is out of date the framework grades *why*: a higher major is a
 * `major` reason, a higher minor (same major) is `minor`, and a changed user
 * `config` is the (ungraded) `config` reason. A run's `--revise` reasons are a
 * *set* that selects which stale units to recompute; `minor` implies `major`.
 */

import type { ReviseReason } from "./types.js";

export interface SemVer {
	major: number;
	minor: number;
}

/** Canonical "major.minor" string, stored on runs and nodes for display/lineage. */
export function versionIdOf(v: SemVer): string {
	return `${v.major}.${v.minor}`;
}

/** Parse a canonical "major.minor" string back into its components. */
export function parseVersionId(versionId: string): SemVer {
	const [major, minor] = versionId.split(".");
	return {
		major: Number.parseInt(major ?? "", 10) || 0,
		minor: Number.parseInt(minor ?? "", 10) || 0,
	};
}

/**
 * Grade a version move from `prior` to `current`:
 *   - "major" when current's major is higher,
 *   - "minor" when the major is unchanged but the minor is higher,
 *   - null otherwise (equal, or a downgrade we never auto-revise toward).
 */
export function gradeVersionMove(prior: SemVer, current: SemVer): "major" | "minor" | null {
	if (current.major > prior.major) return "major";
	if (current.major === prior.major && current.minor > prior.minor) return "minor";
	return null;
}

/**
 * Expand requested revise reasons into the effective selection set: `minor`
 * implies `major` (adopting minor bumps means also adopting major ones). `config`
 * is orthogonal to the version grade and is carried through unchanged.
 */
export function expandReviseReasons(reasons: readonly ReviseReason[]): Set<ReviseReason> {
	const set = new Set<ReviseReason>(reasons);
	if (set.has("minor")) set.add("major");
	return set;
}

/**
 * Parse a `--revise` argument value (comma-separated) into reasons. Accepts
 * `major`, `minor`, `config`, `all` (every reason), and `none`/empty. Unknown
 * tokens are ignored.
 */
export function parseReviseArg(value: string): ReviseReason[] {
	const out = new Set<ReviseReason>();
	for (const raw of value.split(",")) {
		const token = raw.trim().toLowerCase();
		if (token === "all") {
			out.add("major");
			out.add("minor");
			out.add("config");
		} else if (token === "major" || token === "minor" || token === "config") {
			out.add(token);
		}
	}
	return [...out];
}

/** A run's human-readable reach label, for run provenance and command output. */
export function reachLabel(reasons: ReadonlySet<ReviseReason> | readonly ReviseReason[]): string {
	const set = reasons instanceof Set ? reasons : new Set(reasons);
	if (set.size === 0) return "fill";
	return `revise:${[...set].sort().join("+")}`;
}
