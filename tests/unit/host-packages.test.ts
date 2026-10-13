import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { initialize, isHostPackage, resolve } from "../../bin/host-packages.mjs";

/**
 * The `prospect` executable runs under plain Node, where `typebox` (a peer that
 * pi provides) may not be installed next to this package. Its resolve hook then
 * resolves `typebox` from the pi on PATH, as pi itself would.
 */

const notFound = () => Object.assign(new Error("Cannot find package 'typebox'"), { code: "ERR_MODULE_NOT_FOUND" });

describe("host package resolve hook", () => {
	it("names typebox and its subpaths as host packages, and nothing else", () => {
		assert.equal(isHostPackage("typebox"), true);
		assert.equal(isHostPackage("typebox/value"), true);
		assert.equal(isHostPackage("typeboxer"), false);
		assert.equal(isHostPackage("better-sqlite3"), false);
	});

	it("retries an unresolvable host package from pi's directory", async () => {
		initialize({ piRoot: "/opt/pi/lib/node_modules/@earendil-works/pi-coding-agent" });
		const parents: Array<string | undefined> = [];
		const result = await resolve("typebox/value", { parentURL: "file:///app/src/x.ts", conditions: [], importAttributes: {} }, async (_specifier, context) => {
			parents.push(context?.parentURL);
			if (parents.length === 1) throw notFound();
			return { url: "file:///opt/pi/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/typebox/build/value/index.mjs" };
		});
		assert.deepEqual(parents, ["file:///app/src/x.ts", "file:///opt/pi/lib/node_modules/@earendil-works/pi-coding-agent/package.json"]);
		assert.match(result.url, /pi-coding-agent\/node_modules\/typebox/);
	});

	it("leaves a package it doesn't host, and a host package when pi isn't on PATH, to fail as before", async () => {
		initialize({ piRoot: "/opt/pi" });
		await assert.rejects(resolve("left-pad", { parentURL: "file:///app/x.ts", conditions: [], importAttributes: {} }, async () => Promise.reject(notFound())), /Cannot find/);
		initialize({ piRoot: undefined });
		await assert.rejects(resolve("typebox", { parentURL: "file:///app/x.ts", conditions: [], importAttributes: {} }, async () => Promise.reject(notFound())), /Cannot find/);
	});

	it("uses the package installed next to this one when there is one", async () => {
		initialize({ piRoot: "/opt/pi" });
		let calls = 0;
		const result = await resolve("typebox", { parentURL: "file:///app/x.ts", conditions: [], importAttributes: {} }, async () => (calls++, { url: "file:///app/node_modules/typebox/index.mjs" }));
		assert.equal(calls, 1);
		assert.equal(result.url, "file:///app/node_modules/typebox/index.mjs");
	});
});
