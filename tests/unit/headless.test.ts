import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { splitProspectSpec, runProspectSpec, PROSPECT_ACTIONS, type ProspectAction } from "../../src/commands/headless.js";
import type { ExtensionCommandContext } from "../../src/pi-stubs.js";

const ctx = {} as ExtensionCommandContext;

describe("splitProspectSpec", () => {
	it("returns a bare command with empty args", () => {
		assert.deepEqual(splitProspectSpec("sync"), { command: "sync", args: "" });
	});

	it("splits the command from its args", () => {
		assert.deepEqual(splitProspectSpec("analyze --limit 3 --model x/y"), { command: "analyze", args: "--limit 3 --model x/y" });
	});

	it("trims surrounding whitespace and lowercases the command", () => {
		assert.deepEqual(splitProspectSpec("  ACCEPT   019abc  "), { command: "accept", args: "019abc" });
	});
});

describe("PROSPECT_ACTIONS", () => {
	it("exposes the mute/unmute/mutes lifecycle commands", () => {
		assert.equal(typeof PROSPECT_ACTIONS["mute"], "function");
		assert.equal(typeof PROSPECT_ACTIONS["unmute"], "function");
		assert.equal(typeof PROSPECT_ACTIONS["mutes"], "function");
	});

	it("keeps the --prospect command set exactly as documented", () => {
		// The flag is a CLI contract: `--prospect <name>` either runs or prints
		// usage. The set is derived from the command table (#292), so this pins it.
		assert.deepEqual(Object.keys(PROSPECT_ACTIONS).sort(), [
			"accept",
			"analyze",
			"analyzers",
			"diff",
			"gc",
			"mute",
			"mutes",
			"node",
			"nodes",
			"output",
			"proposals",
			"reject",
			"remediate",
			"retract",
			"runs",
			"show",
			"stats",
			"sync",
			"unmute",
			"validate",
			"verify",
		]);
		for (const [name, action] of Object.entries(PROSPECT_ACTIONS)) {
			assert.equal(typeof action, "function", `${name} must be runnable`);
		}
	});
});

describe("runProspectSpec", () => {
	function recorder() {
		const calls: Array<{ name: string; args: string }> = [];
		const make = (name: string): ProspectAction => async (args) => { calls.push({ name, args }); };
		const actions: Record<string, ProspectAction> = { sync: make("sync"), analyze: make("analyze") };
		return { calls, actions };
	}

	it("dispatches to the named action with its args", async () => {
		const { calls, actions } = recorder();
		const ran = await runProspectSpec("analyze --limit 5", ctx, actions);
		assert.equal(ran, true);
		assert.deepEqual(calls, [{ name: "analyze", args: "--limit 5" }]);
	});

	it("returns false and runs nothing for an empty spec", async () => {
		const { calls, actions } = recorder();
		assert.equal(await runProspectSpec("   ", ctx, actions), false);
		assert.equal(calls.length, 0);
	});

	it("returns false and runs nothing for an unknown command", async () => {
		const { calls, actions } = recorder();
		assert.equal(await runProspectSpec("frobnicate now", ctx, actions), false);
		assert.equal(calls.length, 0);
	});

	it("propagates errors thrown by an action", async () => {
		const actions: Record<string, ProspectAction> = {
			boom: async () => { throw new Error("kaboom"); },
		};
		await assert.rejects(() => runProspectSpec("boom", ctx, actions), /kaboom/);
	});
});
