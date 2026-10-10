import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { askInPi, askInTerminal, NO, YES } from "../../src/telemetry/consent.js";
import { disabledByEnv, readState, sendDue, shouldAsk } from "../../src/telemetry/state.js";

/** The usage-report question and the switches that override it (#290). */

let dir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "prospector-telemetry-"));
	env = { PROSPECTOR_TELEMETRY_FILE: path.join(dir, "telemetry.json") };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("telemetry switches", () => {
	it("lets DO_NOT_TRACK and PROSPECTOR_TELEMETRY_DISABLED turn reports off", () => {
		assert.equal(disabledByEnv({}), undefined);
		assert.equal(disabledByEnv({ DO_NOT_TRACK: "1" }), "DO_NOT_TRACK");
		assert.equal(disabledByEnv({ PROSPECTOR_TELEMETRY_DISABLED: "true" }), "PROSPECTOR_TELEMETRY_DISABLED");
		assert.equal(disabledByEnv({ DO_NOT_TRACK: "0" }), undefined);
	});

	it("asks only an undecided user, outside CI, with nothing turning reports off", () => {
		const fresh = { installId: "x" };
		assert.equal(shouldAsk(fresh, {}), true);
		assert.equal(shouldAsk(fresh, { CI: "true" }), false);
		assert.equal(shouldAsk(fresh, { DO_NOT_TRACK: "1" }), false);
		assert.equal(shouldAsk({ ...fresh, consent: "denied" }, {}), false);
	});

	it("sends at most once per UTC day, and only with consent", () => {
		const now = new Date("2026-10-09T08:00:00Z");
		assert.equal(sendDue({ installId: "x" }, now, {}), false);
		assert.equal(sendDue({ installId: "x", consent: "granted" }, now, {}), true);
		assert.equal(sendDue({ installId: "x", consent: "granted", lastSentDay: "2026-10-09" }, now, {}), false);
		assert.equal(sendDue({ installId: "x", consent: "granted" }, now, { PROSPECTOR_TELEMETRY_DISABLED: "1" }), false);
	});

	it("reads a missing or corrupt file as undecided, with a fresh install id", () => {
		const file = env["PROSPECTOR_TELEMETRY_FILE"]!;
		assert.equal(readState(file).consent, undefined);
		fs.writeFileSync(file, "{oops");
		assert.match(readState(file).installId, /^[0-9a-f-]{36}$/);
	});
});

describe("the terminal question", () => {
	it("takes an empty answer as yes", async () => {
		assert.equal(await askInTerminal(async () => "", env), "granted");
		assert.equal(readState(env["PROSPECTOR_TELEMETRY_FILE"]).consent, "granted");
	});

	it("takes n as no, and doesn't ask again", async () => {
		assert.equal(await askInTerminal(async () => "n", env), "denied");
		let asked = false;
		assert.equal(await askInTerminal(async () => ((asked = true), ""), env), undefined);
		assert.equal(asked, false);
	});

	it("doesn't ask when DO_NOT_TRACK is set", async () => {
		assert.equal(await askInTerminal(async () => "", { ...env, DO_NOT_TRACK: "1" }), undefined);
	});
});

describe("the pi question", () => {
	it("offers yes first, so it starts selected", async () => {
		let offered: string[] = [];
		await askInPi(async (_title, options) => ((offered = options), options[0]), env);
		assert.deepEqual(offered, [YES, NO]);
		assert.equal(readState(env["PROSPECTOR_TELEMETRY_FILE"]).consent, "granted");
	});

	it("takes a dismissed question as no", async () => {
		assert.equal(await askInPi(async () => undefined, env), "denied");
	});
});
