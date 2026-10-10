import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Check } from "typebox/value";
import type { AsyncDatabase } from "../db/async-db.js";
import { collectUsageCounts } from "../db/telemetry-queries.js";
import { KNOWN_ANALYZER_IDS, UsageReport, COUNT_FIELDS, toReport, type UsageRow } from "./schema.js";
import { readState, sendDue, statePath, utcDay, writeState, type TelemetryState } from "./state.js";

/**
 * Build and send the daily anonymous usage report (#290).
 *
 * One POST a day carries per-analyzer totals since the last successful send,
 * to a usage-tracker deployment (https://github.com/elecnix/usage-tracker).
 * The cursor moves only when the tracker accepts the report, so a failed send
 * is retried on a later day with the same window.
 */

/** The tracker that stores the reports. `PROSPECTOR_TELEMETRY_URL` overrides it. */
export const DEFAULT_TRACKER_URL = "https://prospector-telemetry.pi-prospector.workers.dev";
const SEND_TIMEOUT_MS = 3000;

const KNOWN = new Set<string>(KNOWN_ANALYZER_IDS);

/** The window a report covers: from the last send (or the user's consent) to now. */
export function reportWindow(state: TelemetryState, now: Date): { since: string; until: string } {
	return { since: state.sentThrough ?? state.consentAt ?? now.toISOString(), until: now.toISOString() };
}

/** Build the report for a window. Analyzers outside the shipped set report as `custom`. */
export async function buildPayload(db: AsyncDatabase, state: TelemetryState, window: { since: string; until: string }): Promise<UsageReport> {
	const merged = new Map<string, UsageRow>();
	for (const counts of await collectUsageCounts(db, window.since, window.until)) {
		const analyzer = KNOWN.has(counts.analyzer) ? counts.analyzer : "custom";
		const harness = counts.harness === "claude" ? "claude" : "pi";
		const key = `${analyzer}\u0000${harness}`;
		const existing = merged.get(key);
		if (!existing) {
			merged.set(key, { ...counts, analyzer, harness });
			continue;
		}
		for (const field of COUNT_FIELDS) existing[field] += counts[field];
	}
	const rows = [...merged.values()].sort((a, b) => a.analyzer.localeCompare(b.analyzer) || a.harness.localeCompare(b.harness));
	return toReport(state.installId, packageVersion(), rows);
}

export interface SendOptions {
	db: () => Promise<AsyncDatabase>;
	now?: Date;
	env?: NodeJS.ProcessEnv;
	fetch?: typeof fetch;
	/** Where `PROSPECTOR_TELEMETRY_DEBUG` prints the payload. */
	debug?: (line: string) => void;
}

export type SendResult = "not-due" | "empty" | "debug" | "sent" | { failed: string };

/**
 * Send today's report if one is due. Never throws: a telemetry failure must not
 * fail the command the user ran.
 */
export async function sendDailyReport(options: SendOptions): Promise<SendResult> {
	const env = options.env ?? process.env;
	const now = options.now ?? new Date();
	const file = statePath(env);
	const state = readState(file);
	if (!sendDue(state, now, env)) return "not-due";
	try {
		const window = reportWindow(state, now);
		const payload = await buildPayload(await options.db(), state, window);
		if (!Check(UsageReport, payload)) return { failed: "report does not match the schema" };
		if (env["PROSPECTOR_TELEMETRY_DEBUG"]) {
			(options.debug ?? ((line) => process.stderr.write(line + "\n")))(JSON.stringify(payload, null, 2));
			return "debug";
		}
		// With nothing to report, leave the day open: a later command today may
		// run an analysis, and its totals belong in today's report.
		if (payload.rows.length === 0) return "empty";
		const done = { ...state, lastSentDay: utcDay(now), sentThrough: window.until };
		const response = await (options.fetch ?? fetch)(new URL("/v1/report", env["PROSPECTOR_TELEMETRY_URL"] || DEFAULT_TRACKER_URL), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
		});
		if (!response.ok) return { failed: `HTTP ${response.status}` };
		writeState(done, file);
		return "sent";
	} catch (err) {
		return { failed: err instanceof Error ? err.message : String(err) };
	}
}

let cachedVersion: string | undefined;

/** The package version, read from package.json; `0.0.0` when it can't be read. */
export function packageVersion(): string {
	if (cachedVersion !== undefined) return cachedVersion;
	try {
		const here = path.dirname(fileURLToPath(import.meta.url));
		const pkg: unknown = JSON.parse(fs.readFileSync(path.join(here, "..", "..", "package.json"), "utf-8"));
		const version = typeof pkg === "object" && pkg !== null && "version" in pkg ? String(pkg.version) : "";
		cachedVersion = /^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$/.test(version) ? version : "0.0.0";
	} catch {
		cachedVersion = "0.0.0";
	}
	return cachedVersion;
}
