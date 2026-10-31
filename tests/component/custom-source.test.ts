import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadCustomSources, resolveSourcePaths } from "../../src/sync/source-loader.js";
import { runSync } from "../../src/sync/index.js";
import { makeTempRoot, tempDb } from "./helpers.js";

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
