import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PROSPECT_TOOL } from "../../src/commands/tool-schema.js";

/**
 * A model picks the tool's action from the description, so an action the schema
 * accepts but the description never enumerates is a capability the model cannot
 * reach. Cite flagged exactly that on this file (#293): the summary sentence
 * stopped at `help` while the schema also accepted `nodes`, `node`,
 * `session_summary`, `leaks`, and `search`.
 */

/** The actions the tool's parameter schema accepts. */
function schemaActions(): string[] {
	const parameters = PROSPECT_TOOL.parameters as {
		properties: { action: { anyOf: Array<{ const: string }> } };
	};
	return parameters.properties.action.anyOf.map((member) => member.const);
}

/** The actions the description's summary sentence lists. */
function enumeratedActions(): string[] {
	const match = /Actions: ([^.]+)\./.exec(PROSPECT_TOOL.description);
	assert.ok(match, "the tool description must enumerate its actions");
	return match[1]!.split(",").map((action) => action.trim());
}

describe("prospect tool action list", () => {
	it("enumerates every action the schema accepts", () => {
		const enumerated = new Set(enumeratedActions());
		const missing = schemaActions().filter((action) => !enumerated.has(action));
		assert.deepEqual(missing, [], `the description never names these actions: ${missing.join(", ")}`);
	});

	it("enumerates nothing the schema rejects", () => {
		const accepted = new Set(schemaActions());
		const stale = enumeratedActions().filter((action) => !accepted.has(action));
		assert.deepEqual(stale, [], `the description names actions the schema does not accept: ${stale.join(", ")}`);
	});
});
