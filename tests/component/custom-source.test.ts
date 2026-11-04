import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverSourceNames, loadCustomSources, resolveSourcePaths } from "../../src/sync/source-loader.js";
import { buildSourceAdapters, runProspectSync } from "../../src/commands/sync.js";
import { sortSourceAdapters } from "../../src/sync/adapter.js";
import { PiSubagentSource } from "../../src/sync/sources/pi-subagent/index.js";
import { PiFileSource } from "../../src/sync/sources/pi/index.js";
import type { SessionSourceAdapter } from "../../src/sync/adapter.js";
import type { ProspectorConfig } from "../../src/types.js";
import { runSync } from "../../src/sync/index.js";
import { makeTempRoot, messageLine, piSessionFileName, sessionHeaderLine, tempDb, writeJsonl } from "./helpers.js";

/**
 * The custom-source loader, end to end: discovery, validation, config wiring,
 * and one custom source synced through the real loop into a real SQLite db.
 *
 * A custom source is a directory holding `index.{ts,js,mjs}` that default-exports
 * a SessionSourceAdapter. Fixtures are plain `.mjs` so the dynamic import is
 * deterministic under the test runner (the loader test for analyzers does the same).
 */

let root: string;
let cleanup: () => void;

beforeEach(() => {
	({ root, cleanup } = makeTempRoot("prospect-custom-source-"));
});

afterEach(() => {
	cleanup();
});

/** A minimal, valid session source as plain-JS source text. */
function echoSource(sourceTag: string): string {
	return `const sessions = [
	{ filePath: "echo://one", project: "echo", mtime: 1000, size: 0, source: ${JSON.stringify(sourceTag)} },
];
export default {
	source: ${JSON.stringify(sourceTag)},
	async discover() { return sessions; },
	async read(disc, resumeLine) {
		return {
			session: {
				id: "echo-session-1", file_path: disc.filePath, project: disc.project,
				source: disc.source, cwd: "/tmp/echo", parent_session: null,
				started_at: "2026-01-01T00:00:00.000Z", last_line: resumeLine,
				last_modified: disc.mtime, analyzed_at: null, message_count: 0,
				branch_count: 0, name: null, tool_inventory: null,
			},
			messages: [{
				id: "echo-msg-1", session_id: "echo-session-1", source: disc.source,
				parent_id: null, timestamp: "2026-01-01T00:00:01.000Z", role: "user",
				content_text: "hello from the echo source", content_thinking: null,
				tool_calls: null, tool_results: null, usage: null, model: null,
				cost_usd: null, provider_message_id: null, stop_reason: null, error_message: null,
			}],
			processedCount: 1, processedTimestamp: disc.mtime, forksResolved: 0,
		};
	},
};
`;
}

function writeSource(dirName: string, tag: string, fileName = "index.mjs"): string {
	const dir = path.join(root, dirName);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, fileName), echoSource(tag));
	return dir;
}

describe("resolveSourcePaths", () => {
	it("orders config paths, then the project dir, then the user dir, dropping duplicates", () => {
		const user = path.join(root, "user-sources");
		const project = path.join(root, "project-sources");
		const explicit = path.join(root, "explicit");
		const paths = resolveSourcePaths({
			config: { sourcePaths: [explicit] },
			projectDir: project,
			userDir: user,
		});
		assert.deepEqual(paths, [explicit, project, user]);
	});

	it("expands a leading ~ in config paths", () => {
		const paths = resolveSourcePaths({ config: { sourcePaths: ["~/s_sources"] } });
		assert.equal(paths[0], path.join(os.homedir(), "s_sources"));
	});
});

describe("loadCustomSources", () => {
	it("discovers the source names under one directory", () => {
		writeSource("echo", "echo");
		writeSource("zeta", "zeta", "index.js");
		fs.mkdirSync(path.join(root, "not-a-source"), { recursive: true });
		const names = discoverSourceNames(root);
		assert.deepEqual(names, ["echo", "zeta"]);
	});

	it("discovers no source names under a missing directory", () => {
		assert.deepEqual(discoverSourceNames(path.join(root, "absent")), []);
	});

	it("loads a valid source directory and keeps its adapter", async () => {
		writeSource("echo", "echo");
		const result = await loadCustomSources({ names: ["echo"], paths: [root] });
		assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
		assert.equal(result.loaded.length, 1);
		assert.equal(result.loaded[0]!.source, "echo");
	});

	it("reports a requested name that no discovery path provides", async () => {
		const result = await loadCustomSources({ names: ["absent"], paths: [root] });
		assert.equal(result.loaded.length, 0);
		assert.equal(result.errors.length, 1);
		assert.match(result.errors[0]!.message, /'absent'/);
	});

	it("rejects a module whose default export is not an adapter", async () => {
		const dir = path.join(root, "broken");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(path.join(dir, "index.mjs"), "export default { nope: true };\n");
		const result = await loadCustomSources({ names: ["broken"], paths: [root] });
		assert.equal(result.loaded.length, 0);
		assert.equal(result.errors.length, 1);
		assert.match(result.errors[0]!.message, /broken/);
	});

	it("rejects a custom source whose tag collides with a built-in id", async () => {
		writeSource("claude-clone", "claude");
		const result = await loadCustomSources({ names: ["claude-clone"], paths: [root], builtinIds: ["claude"] });
		assert.equal(result.loaded.length, 0);
		assert.equal(result.errors.length, 1);
		assert.match(result.errors[0]!.message, /built-in/);
	});

	it("rejects two discovered sources claiming the same tag", async () => {
		writeSource("one", "twin");
		writeSource("two", "twin");
		const result = await loadCustomSources({ names: ["one", "two"], paths: [root] });
		assert.equal(result.loaded.length, 1);
		assert.equal(result.errors.length, 1);
		assert.match(result.errors[0]!.message, /same source tag|conflicts/);
	});

	it("instantiates a default-exported class with no arguments", async () => {
		const dir = path.join(root, "classy");
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "index.mjs"),
			`export default class ClassySource {
				source = "classy";
				async discover() { return []; }
				async read() { throw new Error("not reached"); }
			};
`,
		);
		const result = await loadCustomSources({ names: ["classy"], paths: [root] });
		assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
		assert.equal(result.loaded.length, 1);
		assert.equal(result.loaded[0]!.source, "classy");
	});

	it("refuses a name that would step outside the discovery directories", async () => {
		// A source directory sits beside the discovery dir, reachable as ../outside/escape.
		const escapeDir = path.join(root, "outside", "escape");
		fs.mkdirSync(escapeDir, { recursive: true });
		fs.writeFileSync(path.join(escapeDir, "index.mjs"), echoSource("escape"));
		const discovery = path.join(root, "discovery");
		fs.mkdirSync(discovery, { recursive: true });
		for (const name of ["../outside/escape", "..", ".", path.join(root, "outside", "escape")]) {
			const result = await loadCustomSources({ names: [name], paths: [discovery] });
			assert.equal(result.loaded.length, 0, `${name} must not load`);
			assert.equal(result.errors.length, 1, `${name} must report one error`);
			assert.match(result.errors[0]!.message, /single directory name/, name);
		}
	});

	it("re-imports an edited source file instead of returning the cached module", async () => {
		writeSource("echo", "echo-v1");
		const first = await loadCustomSources({ names: ["echo"], paths: [root] });
		assert.equal(first.loaded[0]!.source, "echo-v1");
		// mtime granularity: bump the mtime explicitly so the cache-buster changes.
		const file = path.join(root, "echo", "index.mjs");
		fs.writeFileSync(file, echoSource("echo-v2"));
		const then = Date.now() / 1000 + 2;
		fs.utimesSync(file, then, then);
		const second = await loadCustomSources({ names: ["echo"], paths: [root] });
		assert.equal(second.loaded[0]!.source, "echo-v2");
	});
});

describe("a custom source through runSync", () => {
	it("syncs the adapter's sessions and tags every row with its source", async () => {
		writeSource("echo", "echo");
		const { loaded, errors } = await loadCustomSources({ names: ["echo"], paths: [root] });
		assert.equal(errors.length, 0);
		const t = await tempDb();
		try {
			const result = await runSync(t.db, loaded);
			assert.equal(result.sessionsProcessed, 1);
			assert.equal(result.messagesInserted, 1);
			const row = (await t.db.prepare("SELECT source, role, content_text FROM messages WHERE id = 'echo-msg-1'").get()) as { source: string; role: string; content_text: string };
			assert.equal(row.source, "echo");
			assert.equal(row.role, "user");
			assert.equal(row.content_text, "hello from the echo source");
			// A second run is a no-op: the cursor advanced, and nothing duplicates.
			const again = await runSync(t.db, loaded);
			assert.equal(again.sessionsProcessed, 0);
			assert.equal(again.sessionsSkipped, 1);
		} finally {
			await t.close();
		}
	});
});

describe("buildSourceAdapters", () => {
	it("finds a source named in config sourcePaths", async () => {
		writeSource("echo", "echo");
		const { adapters, errors } = await buildSourceAdapters({ sources: ["echo"], sourcePaths: [root] });
		assert.deepEqual(errors, []);
		assert.ok(adapters.some((a) => a.source === "echo"));
	});

	it("loads the default built-ins without config and leaves pi-subagent out", async () => {
		const { adapters, errors } = await buildSourceAdapters({});
		assert.deepEqual(errors, []);
		assert.deepEqual(
			adapters.map((a) => a.source),
			["claude", "codex", "opencode", "cline", "pi"],
		);
	});

	it("loads pi-subagent only when sources names it", async () => {
		const { adapters, errors } = await buildSourceAdapters({ sources: ["pi-subagent"] });
		assert.deepEqual(errors, []);
		assert.deepEqual(
			adapters.map((a) => a.source),
			["claude", "codex", "opencode", "cline", "pi-subagent", "pi"],
		);
	});

	it("orders a custom source after every built-in", async () => {
		writeSource("echo", "echo");
		const { adapters, errors } = await buildSourceAdapters({ sources: ["pi-subagent", "echo"], sourcePaths: [root] });
		assert.deepEqual(errors, []);
		assert.equal(adapters.at(-1)!.source, "echo");
		assert.ok(adapters.indexOf(adapters.find((a) => a.source === "pi-subagent")!) < adapters.indexOf(adapters.find((a) => a.source === "pi")!));
	});

	it("does not load a project-local source over a built-in name", async () => {
		// A .prospector/sources/claude in the working tree must not run as the
		// claude adapter: built-ins load from the package directory only.
		writeSource("claude", "evil");
		const { adapters, errors } = await buildSourceAdapters({ sourcePaths: [root] });
		assert.ok(!adapters.some((a) => a.source === "evil"), JSON.stringify(adapters.map((a) => a.source)));
		assert.ok(adapters.some((a) => a.source === "claude"));
	});

	it("reserves a built-in tag against a custom source even when the built-in is disabled", async () => {
		writeSource("subagent-clone", "pi-subagent");
		const { adapters, errors } = await buildSourceAdapters({ sources: ["subagent-clone"], sourcePaths: [root] });
		assert.ok(errors.some((e) => /built-in/.test(e)), JSON.stringify(errors));
		assert.ok(!adapters.some((a) => a.source === "pi-subagent"));
	});
});

/** A custom source that rediscovers every child-run file the subagent adapter also owns. */
function overlappingSource(root: string): SessionSourceAdapter {
	const runFiles = (): string[] => {
		const out: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (entry.name === "session.jsonl") out.push(full);
			}
		};
		walk(root);
		return out;
	};
	return {
		source: "overlap",
		async discover() {
			return runFiles().map((filePath) => ({ filePath, project: "overlap", mtime: 1000, size: 0, source: "overlap" }));
		},
		async read(disc, resumeLine) {
			const header = JSON.parse(fs.readFileSync(disc.filePath, "utf8").split("\n")[0]!) as { id: string; timestamp: string; cwd?: string };
			return {
				session: {
					id: header.id, file_path: disc.filePath, project: disc.project, source: "overlap",
					cwd: header.cwd ?? null, parent_session: null,
					started_at: header.timestamp, last_line: resumeLine,
					last_modified: disc.mtime, analyzed_at: null, message_count: 0,
					branch_count: 0, name: null, tool_inventory: null,
				},
				messages: [],
				processedCount: 1, processedTimestamp: disc.mtime, forksResolved: 0,
			};
		},
	};
}

describe("adapter order", () => {
	it("keeps pi-subagent ahead of pi, and every built-in ahead of a custom source, so pi-subagent keeps the child runs", async () => {
		const parentId = "aaaa1111-bbbb-4ccc-8ddd-eeeeeeeeeeee";
		const projectDir = path.join(root, "--Users-test--proj");
		writeJsonl(projectDir, piSessionFileName(parentId, "2026-08-19T01-00-00"), [
			sessionHeaderLine(parentId),
			messageLine(parentId, 1, "user", "hello from the parent", "2026-08-19T01:02:20Z"),
		]);
		// The tree pi writes for a child run, which both the subagent adapter and the overlap source discover.
		writeJsonl(path.join(projectDir, `2026-08-19T01-00-00Z_${parentId}`, "2b83bd26", "run-0"), "session.jsonl", [
			sessionHeaderLine("child-0"),
			messageLine("child-0", 1, "user", "hello from the child", "2026-08-19T01:02:20Z"),
		]);

		// Adapters declare their claim order; the sort must keep pi-subagent ahead
		// of pi and both ahead of the custom source (which declares none).
		const composed = sortSourceAdapters([new PiFileSource(root), overlappingSource(root), new PiSubagentSource(root)]);
		assert.deepEqual(composed.map((a) => a.source), ["pi-subagent", "pi", "overlap"]);

		const t = await tempDb();
		try {
			const result = await runSync(t.db, composed);
			assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
			const rows = (await t.db.prepare("SELECT id, source, parent_session FROM sessions ORDER BY id").all()) as Array<{
				id: string;
				source: string;
				parent_session: string | null;
			}>;
			assert.deepEqual(rows, [
				{ id: parentId, source: "pi", parent_session: null },
				{ id: "child-0", source: "pi-subagent", parent_session: parentId },
			]);
		} finally {
			await t.close();
		}
	});
});

describe("a config sources value that is not an array", () => {
	it("reports it from buildSourceAdapters instead of throwing", async () => {
		const { adapters, errors } = await buildSourceAdapters({ sources: "echo" } as unknown as ProspectorConfig);
		// The built-in defaults still load; only the customs cannot be named.
		assert.deepEqual(
			adapters.map((a) => a.source),
			["claude", "codex", "opencode", "cline", "pi"],
		);
		assert.equal(errors.length, 1);
		assert.match(errors[0]!, /'sources' must be an array/);
	});

	it("reports it in the sync result from runProspectSync instead of throwing", async () => {
		const file = path.join(root, "prospector.json");
		fs.writeFileSync(file, JSON.stringify({ sources: "echo" }));
		const previous = process.env["PROSPECTOR_CONFIG"];
		process.env["PROSPECTOR_CONFIG"] = file;
		const t = await tempDb();
		try {
			const result = await runProspectSync(t.db);
			assert.ok(result.errors.some((e) => /'sources' must be an array/.test(e)), JSON.stringify(result.errors));
		} finally {
			await t.close();
			if (previous === undefined) delete process.env["PROSPECTOR_CONFIG"];
			else process.env["PROSPECTOR_CONFIG"] = previous;
		}
	});
});
