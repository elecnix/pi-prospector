import { randomUUID } from "node:crypto";
import type { ExtensionCommandContext } from "../pi-stubs.js";
import { getDbPath } from "../config.js";
import { openAsyncDatabase } from "../db/async-db.js";
import { migrate } from "../db/schema.js";
import { buildPayload, reportWindow } from "../telemetry/report.js";
import { disabledByEnv, readState, setConsent, statePath, writeState } from "../telemetry/state.js";

/**
 * `/prospect-telemetry [status|on|off|show|reset-id]` (#290): see and change
 * the anonymous usage-report setting, and print the next report without
 * sending it.
 */
export async function prospectTelemetry(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const sub = (args ?? "").trim().split(/\s+/)[0]?.toLowerCase() || "status";
	const file = statePath();
	const state = readState(file);

	if (sub === "on" || sub === "off") {
		writeState(setConsent(state, sub === "on" ? "granted" : "denied"), file);
		report(ctx, sub === "on" ? "Usage reports are on. Thank you." : "Usage reports are off.");
		return;
	}
	if (sub === "reset-id") {
		writeState({ ...state, installId: randomUUID() }, file);
		report(ctx, "The install id is replaced. Later reports can't be linked to earlier ones.");
		return;
	}
	if (sub === "show") {
		const db = openAsyncDatabase(getDbPath());
		try {
			await migrate(db);
			const payload = await buildPayload(db, state, reportWindow(state, new Date()));
			console.log(JSON.stringify(payload, null, 2));
		} finally {
			await db.close();
		}
		return;
	}
	if (sub !== "status") {
		report(ctx, `Unknown telemetry subcommand: ${sub}. Use status, on, off, show, or reset-id.`, "error");
		return;
	}

	const blocked = disabledByEnv();
	const setting = state.consent === "granted" ? "on" : state.consent === "denied" ? "off" : "not chosen yet (off)";
	const lines = [
		`Usage reports: ${setting}`,
		...(blocked ? [`  ${blocked} is set, so nothing is sent whatever the setting.`] : []),
		`  Last report: ${state.lastSentDay ?? "never"}`,
		`  Settings file: ${file}`,
		"  `telemetry show` prints the next report. `telemetry on|off` changes the setting.",
	];
	report(ctx, lines.join("\n"));
}

function report(ctx: ExtensionCommandContext, message: string, level: "info" | "error" = "info"): void {
	console.log(message);
	ctx.ui.notify(message, level);
}
