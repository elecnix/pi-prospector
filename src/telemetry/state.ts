import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { Type, type Static } from "typebox";
import { Check } from "typebox/value";

/**
 * The user's telemetry choice and the send cursor (#290), kept in a small JSON
 * file next to `prospector.json`. It is not in the prospector database: the
 * database holds the analysis graph, and this is a per-install preference.
 */

const DEFAULT_STATE_PATH = path.join(os.homedir(), ".pi", "agent", "prospector-telemetry.json");

export const TelemetryState = Type.Object({
	/** `granted` or `denied` once the user has answered; absent until then. */
	consent: Type.Optional(Type.Union([Type.Literal("granted"), Type.Literal("denied")])),
	/** When the user answered. A first send covers activity from here on. */
	consentAt: Type.Optional(Type.String()),
	/** A random id that groups one install's days. `reset-id` replaces it. */
	installId: Type.String(),
	/** The UTC day of the last successful send, YYYY-MM-DD. */
	lastSentDay: Type.Optional(Type.String()),
	/** The end of the last window sent. The next window starts here. */
	sentThrough: Type.Optional(Type.String()),
});
export type TelemetryState = Static<typeof TelemetryState>;

/** Where the state lives; `PROSPECTOR_TELEMETRY_FILE` overrides it (tests). */
export function statePath(env: NodeJS.ProcessEnv = process.env): string {
	return env["PROSPECTOR_TELEMETRY_FILE"] || DEFAULT_STATE_PATH;
}

/**
 * Read the state. A missing file means the user hasn't answered yet. A file
 * that exists but can't be read or parsed counts as no: the user's answer is
 * unknown, so nothing is sent and they aren't asked again. `telemetry on`
 * rewrites the file.
 */
export function readState(file: string = statePath()): TelemetryState {
	let raw: string;
	try {
		raw = fs.readFileSync(file, "utf-8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { installId: randomUUID() };
		return { installId: randomUUID(), consent: "denied" };
	}
	try {
		const parsed: unknown = JSON.parse(raw);
		if (Check(TelemetryState, parsed)) return parsed;
	} catch {
		// Falls through to the unreadable case.
	}
	return { installId: randomUUID(), consent: "denied" };
}

export function writeState(state: TelemetryState, file: string = statePath()): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(state, null, 2) + "\n");
}

/** Record the user's answer. */
export function setConsent(state: TelemetryState, consent: "granted" | "denied", now: Date = new Date()): TelemetryState {
	return { ...state, consent, consentAt: now.toISOString() };
}

/** Whether an environment variable turns telemetry off, whatever the saved choice. */
export function disabledByEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (truthy(env["DO_NOT_TRACK"])) return "DO_NOT_TRACK";
	if (truthy(env["PROSPECTOR_TELEMETRY_DISABLED"])) return "PROSPECTOR_TELEMETRY_DISABLED";
	return undefined;
}

/** Whether to ask the user now: they haven't answered, nothing turns it off, and this isn't CI. */
export function shouldAsk(state: TelemetryState, env: NodeJS.ProcessEnv = process.env): boolean {
	return state.consent === undefined && disabledByEnv(env) === undefined && !truthy(env["CI"]);
}

/** Whether a send is due: the user said yes, nothing turns it off, and today's send hasn't happened. */
export function sendDue(state: TelemetryState, now: Date, env: NodeJS.ProcessEnv = process.env): boolean {
	return state.consent === "granted" && disabledByEnv(env) === undefined && state.lastSentDay !== utcDay(now);
}

export function utcDay(at: Date): string {
	return at.toISOString().slice(0, 10);
}

function truthy(value: string | undefined): boolean {
	return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}
