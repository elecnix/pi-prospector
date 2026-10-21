/**
 * Each source claims the file shapes its own writer produces, and nothing else.
 *
 * A session root is not a directory of sessions. Pi's harness writes
 * `<timestamp>_<uuid>.jsonl` session files and, through the pi-subagents
 * extension, `<runId>/run-N/session.jsonl` child-run sessions; the RPC daemon keeps
 * `out.jsonl` protocol streams; the extension drops `*_transcript.jsonl` artifact
 * sets beside them. Claude Code writes `<uuid>.jsonl` sessions, and separately
 * `subagents/agent-*.jsonl` child transcripts and `journal.jsonl` workflow logs.
 *
 * Discovery claims by extension no longer. The tree below holds one file of every
 * shape found on a real machine, and each source is asserted against all of them:
 * the ones it owns, and the ones it must leave alone even though they are `.jsonl`
 * and sit in the same directory.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { PiFileSource } from "../../src/sync/sources/pi-file.js";
import { ClaudeFileSource } from "../../src/sync/sources/claude-file.js";
import { PiSubagentSource } from "../../src/sync/sources/pi-subagent.js";
import { makeTempRoot } from "./helpers.js";

const PI_SESSION_UUID = "aaaa0001-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CHILD_RUN_ID = "2b83bd26-cccc-4ddd-8eee-ffffffffffff";
const CLAUDE_SESSION_UUID = "dddd0001-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const CLAUDE_CHILD_ID = "a60f1e9e536d5a637";
const CLAUDE_WORKFLOW_CHILD_ID = "a8670a845f713d1f0";

/** Every file shape a real sessions tree was found to contain. */
function writeFullTree(root: string): void {
	const piProject = path.join(root, "--Users-test--pi-project");
	const claudeProject = path.join(root, "-Users-test-pi-project");

	const files: Array<[string, string]> = [
		// Pi's own session file.
		[path.join(piProject, `2026-08-19T01-00-00-000Z_${PI_SESSION_UUID}.jsonl`), '{"type":"session","id":"x"}\n'],
		// A child run's session, inside the run directory the extension creates.
		[
			path.join(piProject, "2026-08-19T01-02-17_uuid", CHILD_RUN_ID, "run-0", "session.jsonl"),
			'{"type":"session","id":"child"}\n',
		],
		// The RPC daemon's protocol stream.
		[path.join(piProject, "an-rpc-run", "out.jsonl"), '{"type":"extension_ui_request","method":"notify"}\n'],
		// The pi-subagents extension's own artifact set.
		[
			path.join(piProject, "subagent-artifacts", `${CHILD_RUN_ID}_worker_0_transcript.jsonl`),
			'{"version":1,"recordType":"message","runId":"2b83bd26"}\n',
		],
		[path.join(piProject, "subagent-artifacts", `${CHILD_RUN_ID}_worker_0_meta.json`), '{"runId":"2b83bd26","agent":"worker"}\n'],
		// Claude Code's session file.
		[path.join(claudeProject, `${CLAUDE_SESSION_UUID}.jsonl`), '{"type":"user","uuid":"u1"}\n'],
		// Claude Code's child agents: the harness writes one transcript per child,
		// under the parent session's `subagents/`, one directory deeper again when
		// the child belongs to a workflow.
		[
			path.join(claudeProject, CLAUDE_SESSION_UUID, "subagents", `agent-${CLAUDE_CHILD_ID}.jsonl`),
			'{"type":"user","uuid":"c1","isSidechain":true}\n',
		],
		[
			path.join(claudeProject, CLAUDE_SESSION_UUID, "subagents", "workflows", "wf_1", `agent-${CLAUDE_WORKFLOW_CHILD_ID}.jsonl`),
			'{"type":"user","uuid":"c2","isSidechain":true}\n',
		],
		// The workflow journal beside them records lifecycle events, not turns.
		[
			path.join(claudeProject, CLAUDE_SESSION_UUID, "subagents", "workflows", "wf_1", "journal.jsonl"),
			'{"type":"launched"}\n',
		],
		// A name that starts with `agent-` outside any `subagents` directory is not
		// a child transcript: the shape is the harness's name *and* its directory.
		[path.join(claudeProject, "not-a-subagent-run", "agent-journal.jsonl"), '{"type":"launched"}\n'],
	];

	for (const [filePath, content] of files) {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		fs.writeFileSync(filePath, content);
	}
}

/** The basenames a source discovers, for comparison against the shapes it owns. */
async function claimed(source: { discover(): Promise<Array<{ filePath: string }>> }): Promise<string[]> {
	return (await source.discover()).map((d) => path.basename(d.filePath)).sort();
}

describe("source shapes", () => {
	it("the Pi source claims its own session files and child-run sessions, and nothing else", async () => {
		const fx = makeTempRoot("prospect-shapes-");
		try {
			writeFullTree(fx.root);
			assert.deepEqual(await claimed(new PiFileSource(fx.root)), [
				`2026-08-19T01-00-00-000Z_${PI_SESSION_UUID}.jsonl`,
				"session.jsonl",
			]);
		} finally {
			fx.cleanup();
		}
	});

	it("the Claude source claims its session files and its child agents, and nothing else", async () => {
		const fx = makeTempRoot("prospect-shapes-");
		try {
			writeFullTree(fx.root);
			assert.deepEqual(await claimed(new ClaudeFileSource(fx.root)), [
				`agent-${CLAUDE_CHILD_ID}.jsonl`,
				`agent-${CLAUDE_WORKFLOW_CHILD_ID}.jsonl`,
				`${CLAUDE_SESSION_UUID}.jsonl`,
			]);
		} finally {
			fx.cleanup();
		}
	});

	it("the pi-subagents source claims child-run sessions, named by the extension", async () => {
		const fx = makeTempRoot("prospect-shapes-");
		try {
			writeFullTree(fx.root);
			assert.deepEqual(await claimed(new PiSubagentSource(fx.root)), ["session.jsonl"]);
		} finally {
			fx.cleanup();
		}
	});

	it("a source's own artifact files are not claimed as sessions by any source", async () => {
		const fx = makeTempRoot("prospect-shapes-");
		try {
			writeFullTree(fx.root);
			const everything = [
				...(await new PiFileSource(fx.root).discover()),
				...(await new ClaudeFileSource(fx.root).discover()),
				...(await new PiSubagentSource(fx.root).discover()),
			].map((d) => d.filePath);

			for (const foreign of ["out.jsonl", `${CHILD_RUN_ID}_worker_0_transcript.jsonl`, "journal.jsonl"]) {
				assert.equal(
					everything.some((p) => p.endsWith(foreign)),
					false,
					`${foreign} is not a session and must be claimed by nothing`,
				);
			}
			assert.equal(
				everything.some((p) => p.includes("agent-journal.jsonl")),
				false,
				"an `agent-` name outside a subagents directory is not a child transcript",
			);
			// The harness's own child agents are claimed, by the harness source.
			for (const child of [`agent-${CLAUDE_CHILD_ID}.jsonl`, `agent-${CLAUDE_WORKFLOW_CHILD_ID}.jsonl`]) {
				const owner = [
					...(await new ClaudeFileSource(fx.root).discover()),
				].find((d) => d.filePath.endsWith(child));
				assert.ok(owner, `${child} is a Claude child agent and must be claimed`);
				assert.equal(owner.source, "claude");
			}
		} finally {
			fx.cleanup();
		}
	});
});
