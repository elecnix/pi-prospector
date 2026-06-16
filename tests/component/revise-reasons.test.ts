import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages } from "./helpers.js";
import { AnalyzerFramework } from "../../src/analyze/framework.js";
import { createThrowingLLM } from "../../src/analyze/mock-llm.js";
import { turnPairCoreAnalyzer } from "../../src/analyze/analyzers/turn-pair-core/index.js";
import { DEFAULT_MODEL_TIERS } from "../../src/analyze/model-tiers.js";
import type { Analyzer, ReviseReason } from "../../src/analyze/types.js";

function seed(db: import("better-sqlite3").Database): void {
	insertSession(db, "s1");
	insertMessages(db, "s1", [
		{ role: "user", text: "fix the login bug" },
		{ role: "assistant", text: "looking", toolCalls: [{ name: "read" }] },
		{ role: "toolResult", toolResults: [{ toolName: "read", isError: true, textLength: 50 }] },
		{ role: "user", text: "no, that's wrong, use the auth module" },
		{ role: "assistant", text: "fixing" },
	]);
}

/** Fill the graph with the base v1.0 analyzer. */
async function fillV1(db: import("better-sqlite3").Database): Promise<void> {
	const fw = new AnalyzerFramework({ db, llm: createThrowingLLM(), modelTiers: DEFAULT_MODEL_TIERS });
	fw.register(turnPairCoreAnalyzer);
	await fw.run("s1", {});
}

/** A fresh framework registered with `analyzer`, then run with the given reasons. */
async function run(db: import("better-sqlite3").Database, analyzer: Analyzer, revise: ReviseReason[]) {
	const fw = new AnalyzerFramework({ db, llm: createThrowingLLM(), modelTiers: DEFAULT_MODEL_TIERS });
	fw.register(analyzer);
	return fw.run("s1", { revise });
}

async function scan(db: import("better-sqlite3").Database, analyzer: Analyzer) {
	const fw = new AnalyzerFramework({ db, llm: createThrowingLLM(), modelTiers: DEFAULT_MODEL_TIERS });
	fw.register(analyzer);
	return fw.scan("s1");
}

const minorBump: Analyzer = {
	...turnPairCoreAnalyzer,
	version: { ...turnPairCoreAnalyzer.version, minor: turnPairCoreAnalyzer.version.minor + 1 },
};
const majorBump: Analyzer = {
	...turnPairCoreAnalyzer,
	version: { ...turnPairCoreAnalyzer.version, major: turnPairCoreAnalyzer.version.major + 1 },
};
const configChange: Analyzer = {
	...turnPairCoreAnalyzer,
	defaultConfig: {
		...turnPairCoreAnalyzer.defaultConfig,
		configJson: { ...turnPairCoreAnalyzer.defaultConfig.configJson, frictionThresholdTweak: 99 },
	},
};

describe("revise reasons select which stale units to recompute", () => {
	it("a minor bump is graded `minor`; --revise major skips it, --revise minor revises it", async () => {
		const { db, close } = tempDb();
		try {
			seed(db);
			await fillV1(db);

			const classified = await scan(db, minorBump);
			assert.ok(classified.length >= 1);
			assert.ok(
				classified.every((c) => c.status === "stale" && c.reasons.includes("minor") && !c.reasons.includes("major")),
				"a minor bump grades only as minor",
			);

			assert.equal((await run(db, minorBump, ["major"])).nodesRevised, 0, "--revise major skips a minor-only change");
			assert.ok((await run(db, minorBump, ["minor"])).nodesRevised >= 1, "--revise minor revises it");
		} finally {
			close();
		}
	});

	it("a major bump is graded `major` and is revised by --revise major", async () => {
		const { db, close } = tempDb();
		try {
			seed(db);
			await fillV1(db);
			assert.ok((await run(db, majorBump, ["major"])).nodesRevised >= 1, "a major bump is picked up by --revise major");
		} finally {
			close();
		}
	});

	it("a config change is graded `config` only; --revise config revises, --revise major does not", async () => {
		const { db, close } = tempDb();
		try {
			seed(db);
			await fillV1(db);

			const classified = await scan(db, configChange);
			assert.ok(
				classified.every(
					(u) => u.status === "stale" && u.reasons.includes("config") && !u.reasons.includes("major") && !u.reasons.includes("minor"),
				),
				"a config change carries only the config reason",
			);

			assert.equal((await run(db, configChange, ["major"])).nodesRevised, 0, "--revise major ignores a config-only change");
			assert.ok((await run(db, configChange, ["config"])).nodesRevised >= 1, "--revise config revises it");
		} finally {
			close();
		}
	});
});
