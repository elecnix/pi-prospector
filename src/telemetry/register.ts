import type { ExtensionAPI } from "../pi-stubs.js";

/**
 * Hook the usage-report consent question and the daily send into pi's startup
 * (#290). This file is on the startup surface, so it only registers the
 * listener. The work loads behind a dynamic import, and runs without blocking
 * the prompt.
 */
export function registerTelemetry(pi: ExtensionAPI): void {
	let started = false;
	pi.on("session_start", (event, ctx) => {
		if (started || event.reason !== "startup") return;
		started = true;
		void import("./startup.js")
			.then((startup) => startup.onPiStartup(ctx))
			.catch(() => {
				// Telemetry must never disturb a pi session.
			});
	});
}
