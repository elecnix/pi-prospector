import * as readline from "node:readline/promises";
import { readState, setConsent, shouldAsk, statePath, writeState } from "./state.js";

/**
 * The one-time question that turns anonymous usage reports on (#290). Nothing
 * is sent until the user answers yes. The suggested answer is yes: pressing
 * Enter accepts it, and any other way out of the question counts as no.
 */

export const CONSENT_TITLE = "Share anonymous usage totals with the pi-prospector maintainers?";

export const CONSENT_DETAIL = [
	"Once a day, pi-prospector would send per-analyzer counts: runs, sessions, proposals by severity,",
	"and how many you accepted or rejected. It never sends conversation text, file paths, or session ids.",
	"Change it any time with `prospect telemetry on|off`. `prospect telemetry show` prints the next report.",
].join("\n");

export const YES = "Yes, share anonymous totals";
export const NO = "No";

/** Ask in pi's UI. Returns the answer, or undefined when nothing was asked. */
export async function askInPi(
	select: (title: string, options: string[]) => Promise<string | undefined>,
	env: NodeJS.ProcessEnv = process.env,
): Promise<"granted" | "denied" | undefined> {
	const file = statePath(env);
	const state = readState(file);
	if (!shouldAsk(state, env)) return undefined;
	const choice = await select(`${CONSENT_TITLE}\n\n${CONSENT_DETAIL}`, [YES, NO]);
	const consent = choice === YES ? "granted" : "denied";
	writeState(setConsent(state, consent), file);
	return consent;
}

/** Ask on a terminal. An empty answer means yes. */
export async function askInTerminal(
	ask: (question: string) => Promise<string>,
	env: NodeJS.ProcessEnv = process.env,
): Promise<"granted" | "denied" | undefined> {
	const file = statePath(env);
	const state = readState(file);
	if (!shouldAsk(state, env)) return undefined;
	const answer = (await ask(`${CONSENT_TITLE}\n${CONSENT_DETAIL}\nShare? [Y/n] `)).trim().toLowerCase();
	const consent = answer === "" || answer === "y" || answer === "yes" ? "granted" : "denied";
	writeState(setConsent(state, consent), file);
	return consent;
}

/** A question on stdin and stderr, so a command's stdout stays clean for pipes. */
export async function terminalQuestion(question: string): Promise<string> {
	const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
	try {
		// Ctrl-D or a closed stdin ends the question without an answer: treat it as no.
		return await new Promise<string>((resolve) => {
			rl.once("close", () => resolve("n"));
			rl.question(question).then(resolve, () => resolve("n"));
		});
	} finally {
		rl.close();
	}
}
