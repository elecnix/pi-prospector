/**
 * The coding harness a session came from ("pi" | "claude" | "pi-rpc") — the raw
 * value the sync layer stores, and the display label rendered from it.
 *
 * This is the one place they meet. Everything that shows which host produced
 * a session — the token-report's "Agent" dimension, session filters, proposal
 * group headers — reads the source here and renders it as Pi / Claude / Pi RPC,
 * and a session whose source is absent or orphaned renders as "unknown" rather
 * than silently defaulting to a host name. A missing source is a fact worth
 * surfacing, not something to paper over with a guess.
 *
 * `pi-rpc` is the RPC event-stream shape written by headless Pi agents
 * (~/.pi/agent/sessions/pi-rpc/<name>/out.jsonl). It is still Pi the harness —
 * same tools, same turn structure — but a different transcript encoding, so it
 * gets its own source tag (#263) rather than pretending the shapes match.
 */

export type HarnessSource = "pi" | "claude" | "pi-rpc";

export const HARNESS_SOURCES: readonly HarnessSource[] = ["pi", "claude", "pi-rpc"];

/** True when a value is one of the harness sources. */
export function isHarnessSource(v: unknown): v is HarnessSource {
	return v === "pi" || v === "claude" || v === "pi-rpc";
}

/**
 * Interpret a `--source`/`source` selector. Returns the harness for a valid
 * value, or undefined for absent. Unknown values throw with a clear message so
 * a typoed filter fails loudly instead of silently matching nothing.
 */
export function parseHarnessSource(v: string | undefined): HarnessSource | undefined {
	if (v === undefined || v === "") return undefined;
	const t = v.trim().toLowerCase();
	if (t === "pi" || t === "claude" || t === "pi-rpc") return t;
	throw new Error(`unknown source '${v}' (use pi, claude, or pi-rpc)`);
}

/**
 * The human-readable label for a source value, with an explicit "unknown" for
 * anything that is not a recorded harness — never a silent fallback to Pi.
 */
export function harnessLabel(source: string | null | undefined): string {
	if (source === "pi") return "Pi";
	if (source === "claude") return "Claude";
	if (source === "pi-rpc") return "Pi RPC";
	return "unknown";
}
