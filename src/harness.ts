/**
 * The coding harness a session came from ("pi" | "claude") — the raw value the
 * sync layer stores, and the display label rendered from it.
 *
 * This is the one place the two meet. Everything that shows which host produced
 * a session — the token-report's "Agent" dimension, session filters, proposal
 * group headers — reads the source here and renders it as Pi / Claude, and a
 * session whose source is absent or orphaned renders as "unknown" rather than
 * silently defaulting to a host name. A missing source is a fact worth
 * surfacing, not something to paper over with a guess.
 */

export type HarnessSource = "pi" | "claude";

export const HARNESS_SOURCES: readonly HarnessSource[] = ["pi", "claude"];

/** True when a value is one of the two harness sources. */
export function isHarnessSource(v: unknown): v is HarnessSource {
	return v === "pi" || v === "claude";
}

/**
 * Interpret a `--source`/`source` selector. Returns the harness for a valid
 * value, or undefined for absent. Unknown values throw with a clear message so
 * a typoed filter fails loudly instead of silently matching nothing.
 */
export function parseHarnessSource(v: string | undefined): HarnessSource | undefined {
	if (v === undefined || v === "") return undefined;
	const t = v.trim().toLowerCase();
	if (t === "pi" || t === "claude") return t;
	throw new Error(`unknown source '${v}' (use pi or claude)`);
}

/**
 * The human-readable label for a source value, with an explicit "unknown" for
 * anything that is not a recorded harness — never a silent fallback to Pi.
 */
export function harnessLabel(source: string | null | undefined): string {
	if (source === "pi") return "Pi";
	if (source === "claude") return "Claude";
	return "unknown";
}
