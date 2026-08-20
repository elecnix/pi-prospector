/**
 * What is already installed.
 *
 * Recommending a package the operator installed last week is worse than a
 * missed finding: it says the analysis did not look. The host records its
 * installed packages in its own settings file, so the check is a file read, and
 * the answer is folded into the analyzer's config fingerprint — installing a
 * recommended extension is a change to the analysis inputs, and the affected
 * nodes should go stale for the `config` reason rather than silently keep
 * recommending it.
 *
 * The read never throws. A missing or unreadable settings file means "not
 * known", and an unknown install state must not suppress a finding — it is
 * stated on the node instead, so a proposal that could not be
 * already-installed-checked says so.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface InstalledPackages {
	/** Normalised package names the host reports as installed. */
	names: Set<string>;
	/** False when the settings file could not be read — the check is unknown, not negative. */
	known: boolean;
}

/** The host's settings file, honouring the same env override the rest of the config uses. */
export function defaultSettingsPath(): string {
	const override = process.env["PROSPECTOR_PI_SETTINGS"];
	if (override) return override;
	return path.join(os.homedir(), ".pi", "agent", "settings.json");
}

/**
 * Reduce a package spec to a comparable name.
 *
 * The host records a heterogeneous list: `npm:@scope/name`, `git:github.com/owner/repo@branch`,
 * and objects carrying a `source`. Only the npm form can be compared against
 * the curated catalogue, so that is what is extracted; a git install of the
 * same extension is deliberately *not* matched, because the catalogue names
 * registry packages and cannot know that some fork is the same thing.
 */
export function normalizePackageSpec(spec: unknown): string | null {
	const raw =
		typeof spec === "string"
			? spec
			: spec && typeof spec === "object" && typeof (spec as Record<string, unknown>)["source"] === "string"
				? ((spec as Record<string, unknown>)["source"] as string)
				: null;
	if (!raw) return null;
	if (!raw.startsWith("npm:")) return null;
	const withoutPrefix = raw.slice("npm:".length);
	// Strip a version range: `@scope/name@1.2.3` → `@scope/name`, `name@1` → `name`.
	const at = withoutPrefix.lastIndexOf("@");
	const name = at > 0 ? withoutPrefix.slice(0, at) : withoutPrefix;
	return name.length > 0 ? name : null;
}

/** Read the host's installed packages. Never throws. */
export function readInstalledPackages(settingsPath = defaultSettingsPath()): InstalledPackages {
	let text: string;
	try {
		text = fs.readFileSync(settingsPath, "utf8");
	} catch {
		return { names: new Set(), known: false };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { names: new Set(), known: false };
	}
	const packages = (parsed as Record<string, unknown> | null)?.["packages"];
	if (!Array.isArray(packages)) return { names: new Set(), known: false };

	const names = new Set<string>();
	for (const spec of packages) {
		const name = normalizePackageSpec(spec);
		if (name) names.add(name);
	}
	return { names, known: true };
}
