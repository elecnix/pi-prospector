import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import registerExtension from "../../src/index.js";
import { insertProposalRow, insertSession } from "./helpers.js";
import { openAsyncDatabase, type AsyncDatabase } from "../../src/db/async-db.js";
import { migrate } from "../../src/db/schema.js";
import { getLatestDecision } from "../../src/db/queries.js";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ModelRegistry,
	ToolResult,
} from "../../src/pi-stubs.js";

type Handler = (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
type ToolExec = (
	id: string,
	params: Record<string, unknown>,
	signal: AbortSignal,
	onUpdate: unknown,
	ctx: ExtensionCommandContext,
) => Promise<ToolResult> | ToolResult;

const FIXTURES = path.resolve(import.meta.dirname, "..", "fixtures");

const commands = new Map<string, Handler>();
let toolExec: ToolExec;
const flags = new Map<string, string | boolean | undefined>();

const fakePi: ExtensionAPI = {
	registerCommand: (name, opts) => commands.set(name, opts.handler),
	registerTool: (tool) => {
		if (tool.name === "prospect") toolExec = tool.execute as ToolExec;
	},
	registerFlag: (name, opts) => {
		if (opts.default !== undefined) flags.set(name, opts.default);
	},
	getFlag: (name) => flags.get(name),
	on: () => {
		/* no session_start dispatch needed for these command tests */
	},
};

const notes: string[] = [];
const modelRegistry: ModelRegistry = {
	find: () => undefined,
	getAll: () => [],
	getAvailable: () => [],
	getApiKeyAndHeaders: async () => ({ ok: false, error: "no creds in test" }),
};
const ctx: ExtensionCommandContext = {
	modelRegistry,
	hasUI: false,
	ui: { notify: (m) => notes.push(m) },
};

let tmpDir: string;

before(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "prospector-cmd-"));
	process.env["PROSPECTOR_DB_PATH"] = path.join(tmpDir, "cmd.db");
	process.env["PROSPECTOR_SESSIONS_DIR"] = FIXTURES;
	registerExtension(fakePi);
});

after(() => {
	delete process.env["PROSPECTOR_DB_PATH"];
	delete process.env["PROSPECTOR_SESSIONS_DIR"];
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		/* ignore */
	}
});

async function run(name: string, args = ""): Promise<string> {
	notes.length = 0;
	await commands.get(name)!(args, ctx);
	return notes.join("\n");
}

describe("slash commands", () => {
	it("registers all expected commands and the tool", () => {
		for (const name of [
			"prospect-sync",
			"prospect-stats",
			"prospect-proposals",
			"prospect-accept",
			"prospect-reject",
			"prospect-remediate",
			"prospect-analyze",
			"prospect-verify",
			"prospect-runs",
			"prospect-diff",
			"prospect-gc",
			"prospect-retract",
		]) {
			assert.ok(commands.has(name), `missing command ${name}`);
		}
		assert.ok(typeof toolExec === "function");
	});

	it("prospect-sync indexes fixtures", async () => {
		const out = await run("prospect-sync");
		assert.match(out, /Prospect sync complete/);
		assert.match(out, /Sessions processed:/);
	});

	it("prospect-stats renders stats", async () => {
		const out = await run("prospect-stats");
		assert.match(out, /Prospector Stats/);
		assert.match(out, /Sessions indexed:/);
	});

	it("prospect-analyze runs the deterministic analyzer without an LLM", async () => {
		const out = await run("prospect-analyze", "--analyzer turn-pair-core");
		assert.match(out, /Done \[fill\]/);
		assert.match(out, /Nodes produced:/);
	});

	it("prospect-analyze --revise re-scans", async () => {
		const out = await run("prospect-analyze", "--revise all --analyzer turn-pair-core");
		assert.match(out, /Done \[revise:/);
	});

	it("prospect-verify confirms integrity and flags tampering", async () => {
		await run("prospect-sync");
		await run("prospect-analyze", "--analyzer turn-pair-core");
		const ok = await run("prospect-verify");
		assert.match(ok, /every reference resolves/);

		const db = await openAsyncDatabase(process.env["PROSPECTOR_DB_PATH"]!);
		try {
			const rows = await db.prepare("SELECT id FROM analysis_nodes LIMIT 2").all() as Array<{ id: string }>;
			assert.ok(rows.length >= 1, "expected nodes to tamper with");
			// Valid-but-different content → output_key mismatch.
			await db.prepare("UPDATE analysis_nodes SET content_json = '{\"x\":1}' WHERE id = ?").run(rows[0]!.id);
			// Unparseable content → exercises the parse-failure branch.
			if (rows[1]) await db.prepare("UPDATE analysis_nodes SET content_json = 'not json' WHERE id = ?").run(rows[1].id);
		} finally {
			await db.close();
		}
		const bad = await run("prospect-verify");
		assert.match(bad, /integrity problem\(s\) found/);
	});

	it("prospect-verify flags a broken evidence trail (dangling edge #49)", async () => {
		const trailDb = path.join(tmpDir, "trail.db");
		process.env["PROSPECTOR_DB_PATH"] = trailDb;
		try {
			await run("prospect-sync");
			await run("prospect-analyze", "--analyzer turn-pair-core");
			const ok = await run("prospect-verify");
			assert.match(ok, /edge\(s\): every reference resolves/);

			const db = await openAsyncDatabase(process.env["PROSPECTOR_DB_PATH"]!);
			try {
				// An edge references its target by id (message/session), so out-of-band SQL
				// can point it at an id that no longer exists. Break one to emulate the #49
				// incident: a dangling trail that content-hash verify misses. (turn-pair-core
				// produces `anchors`→message edges but no `consumes` edges — those are
				// added by the session-overview step.)
				const edge = await db.prepare("SELECT id FROM analysis_edges WHERE edge_kind = 'anchors' AND to_ref_kind = 'message' LIMIT 1").get() as { id: string } | undefined;
				assert.ok(edge, "expected an anchors→message edge to break");
				await db.prepare("UPDATE analysis_edges SET to_ref_id = 'ghost-message-id' WHERE id = ?").run(edge!.id);
			} finally {
				await db.close();
			}
			const bad = await run("prospect-verify");
			assert.match(bad, /dangling reference\(s\)/);
			assert.match(bad, /anchors → message/);
			assert.match(bad, /messages.id/);
		} finally {
			process.env["PROSPECTOR_DB_PATH"] = path.join(tmpDir, "cmd.db");
		}
	});

	it("prospect-analyze reports when there is nothing to do", async () => {
		// A fresh empty DB → no sessions.
		const emptyDb = path.join(tmpDir, "empty.db");
		process.env["PROSPECTOR_DB_PATH"] = emptyDb;
		try {
			const out = await run("prospect-analyze", "--session does-not-exist --analyzer turn-pair-core");
			assert.match(out, /Done|No sessions/);
		} finally {
			process.env["PROSPECTOR_DB_PATH"] = path.join(tmpDir, "cmd.db");
		}
	});

	it("prospect-proposals lists, accepts, and rejects", async () => {
		const db = await openAsyncDatabase(process.env["PROSPECTOR_DB_PATH"]!);
		await migrate(db);
		const session = await db.prepare("SELECT id FROM sessions LIMIT 1").get() as { id: string };
		await insertProposalRow(db, { id: "cmd-p1", sessionId: session.id, title: "Test proposal", severity: "friction" });
		await insertProposalRow(db, { id: "cmd-p2", sessionId: session.id, title: "Second proposal", severity: "waste" });
		await db.close();

		const list = await run("prospect-proposals");
		assert.match(list, /Test proposal/);

		const accepted = await run("prospect-accept", "cmd-p1");
		assert.match(accepted, /applied/);

		const rejected = await run("prospect-reject", "cmd-p2");
		assert.match(rejected, /rejected/);

		const filtered = await run("prospect-proposals", "applied");
		assert.match(filtered, /Test proposal/);

		const missing = await run("prospect-accept", "");
		assert.match(missing, /Usage/);

		const rejectMissing = await run("prospect-reject", "");
		assert.match(rejectMissing, /Usage/);
	});

	it("prospect-accept captures rationale + disposition as a decision", async () => {
		const db = await openAsyncDatabase(process.env["PROSPECTOR_DB_PATH"]!);
		await migrate(db);
		const session = await db.prepare("SELECT id FROM sessions LIMIT 1").get() as { id: string };
		await insertProposalRow(db, { id: "cmd-p3", sessionId: session.id, title: "Rationale proposal", inputKey: "ik-cmd-p3" });
		await db.close();

		const accepted = await run("prospect-accept", "cmd-p3 --done already added the rule to AGENTS.md");
		assert.match(accepted, /applied/);

		const db2 = await openAsyncDatabase(process.env["PROSPECTOR_DB_PATH"]!);
		const d = await getLatestDecision(db2, "ik-cmd-p3")!;
		await db2.close();
		assert.equal(d.decision, "accepted");
		assert.equal(d.disposition, "done");
		assert.match(d.rationale!, /already added the rule/);

		// The decision (durable memory) surfaces in the proposals view.
		const listed = await run("prospect-proposals", "--full");
		assert.match(listed, /decision: accepted \(done\) — already added the rule/);
	});

	it("prospect-remediate accepts many proposals under one shared remediation", async () => {
		const db = await openAsyncDatabase(process.env["PROSPECTOR_DB_PATH"]!);
		await migrate(db);
		const session = await db.prepare("SELECT id FROM sessions LIMIT 1").get() as { id: string };
		await insertProposalRow(db, { id: "cmd-r1", sessionId: session.id, title: "Remediate A", inputKey: "ik-cmd-r1" });
		await insertProposalRow(db, { id: "cmd-r2", sessionId: session.id, title: "Remediate B", inputKey: "ik-cmd-r2" });
		await db.close();

		const out = await run("prospect-remediate", "cmd-r1 cmd-r2 --done consolidated polling guidance into AGENTS.md");
		assert.match(out, /2 proposal/);

		const db2 = await openAsyncDatabase(process.env["PROSPECTOR_DB_PATH"]!);
		const d1 = await getLatestDecision(db2, "ik-cmd-r1")!;
		const d2 = await getLatestDecision(db2, "ik-cmd-r2")!;
		await db2.close();
		assert.equal(d1.decision, "accepted");
		assert.equal(d1.disposition, "done");
		assert.match(d1.rationale!, /consolidated polling guidance/);
		assert.ok(d1.remediation_id, "decision must link to the remediation");
		assert.equal(d1.remediation_id, d2.remediation_id, "both decisions share one remediation");

		// The shared remediation surfaces in the proposals view.
		const listed = await run("prospect-proposals", "applied");
		assert.ok(listed.includes(`remediation ${d1.remediation_id}`), `missing remediation ref; got:\n${listed}`);

		const usage = await run("prospect-remediate", "");
		assert.match(usage, /Usage/);
		const noDescription = await run("prospect-remediate", "cmd-r1 cmd-r2");
		assert.match(noDescription, /Usage/);
	});

	it("prospect-proposals reports empty state", async () => {
		process.env["PROSPECTOR_DB_PATH"] = path.join(tmpDir, "empty2.db");
		try {
			const out = await run("prospect-proposals");
			assert.match(out, /No proposals found/);
		} finally {
			process.env["PROSPECTOR_DB_PATH"] = path.join(tmpDir, "cmd.db");
		}
	});

	it("--source filters to one harness and tags the group header", async () => {
		const db = await openAsyncDatabase(process.env["PROSPECTOR_DB_PATH"]!);
		await migrate(db);
		await insertSession(db, "src-pi", "/tmp/pi.jsonl", "/home/user/piProj", "pi");
		await insertSession(db, "src-cl", "/tmp/cl.jsonl", "/home/user/clProj", "claude");
		await insertProposalRow(db, { id: "s-pi-1", sessionId: "src-pi", title: "Pi proposal", inputKey: "ik-s-pi-1" });
		await insertProposalRow(db, { id: "s-cl-1", sessionId: "src-cl", title: "Claude proposal", inputKey: "ik-s-cl-1" });
		await db.close();

		const all = await run("prospect-proposals");
		assert.match(all, /Pi proposal/);
		assert.match(all, /Claude proposal/);

		const onlyClaude = await run("prospect-proposals", "--source claude");
		assert.match(onlyClaude, /Claude proposal/);
		assert.doesNotMatch(onlyClaude, /Pi proposal/);
		assert.match(onlyClaude, /\[Claude\]/);

		const onlyPi = await run("prospect-proposals", "--source=pi");
		assert.match(onlyPi, /Pi proposal/);
		assert.doesNotMatch(onlyPi, /Claude proposal/);
	});
});

describe("prospect tool", () => {
	const signal = new AbortController().signal;

	it("handles sync, stats, list_proposals, accept, reject, and unknown", async () => {
		const sync = await toolExec("t1", { action: "sync" }, signal, null, ctx);
		assert.match(sync.content[0]!.text, /sessionsProcessed/);

		const stats = await toolExec("t2", { action: "stats" }, signal, null, ctx);
		assert.match(stats.content[0]!.text, /totalSessions/);

		const list = await toolExec("t3", { action: "list_proposals" }, signal, null, ctx);
		assert.ok(list.content[0]!.text.length > 0);

		const acceptNoId = await toolExec("t4", { action: "accept" }, signal, null, ctx);
		assert.match(acceptNoId.content[0]!.text, /required/);

		const rejectNoId = await toolExec("t5", { action: "reject" }, signal, null, ctx);
		assert.match(rejectNoId.content[0]!.text, /required/);

		const unknown = await toolExec("t6", { action: "bogus" }, signal, null, ctx);
		assert.match(unknown.content[0]!.text, /Unknown action/);
	});

	it("sync accepts a project scope and only indexes that project", async () => {
		// Point the sessions dir at a temp tree with two projects; only the scoped
		// one may be indexed. (Claude dir stays absent.)
		const syncRoot = fs.mkdtempSync(path.join(os.tmpdir(), "prospect-tool-sync"));
		const dbPath = path.join(tmpDir, "scope-sync.db");
		const prevDb = process.env["PROSPECTOR_DB_PATH"];
		const prevDir = process.env["PROSPECTOR_SESSIONS_DIR"];
		const prevUser = process.env.USER;
		process.env.USER = "test";
		process.env["PROSPECTOR_DB_PATH"] = dbPath;
		process.env["PROSPECTOR_SESSIONS_DIR"] = syncRoot;
		try {
			for (const proj of ["projA", "projB"]) {
				const d = path.join(syncRoot, `--Users-test--${proj}`);
				fs.mkdirSync(d, { recursive: true });
				fs.writeFileSync(
					path.join(d, `${proj}.jsonl`),
					`{"type":"session","version":3,"id":"${proj}-001","timestamp":"2026-06-01T10:00:00.000Z"}\n`,
				);
			}

			const res = await toolExec("syncProj", { action: "sync", project: "projA" }, signal, null, ctx);
			const body = JSON.parse(res.content[0]!.text);
			assert.equal(body.sessionsProcessed, 1);

			const db = await openAsyncDatabase(dbPath);
			const rows = await db.prepare("SELECT id FROM sessions").all() as Array<{ id: string }>;
			await db.close();
			assert.deepEqual(rows.map((r) => r.id), ["projA-001"]);
		} finally {
			process.env.USER = prevUser;
			if (prevDb !== undefined) process.env["PROSPECTOR_DB_PATH"] = prevDb;
			else delete process.env["PROSPECTOR_DB_PATH"];
			if (prevDir !== undefined) process.env["PROSPECTOR_SESSIONS_DIR"] = prevDir;
			else delete process.env["PROSPECTOR_SESSIONS_DIR"];
			try {
				fs.rmSync(syncRoot, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	});

	// ── Issues #18–#22: tool list_proposals / accept / reject improvements ──

	it("#18 list_proposals shows the full 36-char proposal id, not a truncated prefix", async () => {
		const db = await openAsyncDatabase(process.env["PROSPECTOR_DB_PATH"]!);
		await migrate(db);
		const session = await db.prepare("SELECT id FROM sessions LIMIT 1").get() as { id: string };
		const fullId = "11111111-2222-4333-8444-555555555555";
		await insertProposalRow(db, { id: fullId, sessionId: session.id, title: "Full-id proposal", inputKey: "ik-full-18" });
		await db.close();

		const res = await toolExec("id18", { action: "list_proposals" }, signal, null, ctx);
		const body = res.content[0]!.text;
		assert.ok(body.includes(fullId), `full 36-char id must appear; got:\n${body}`);
		// The conciseEntry id line carries the full id with its hyphens.
		assert.match(body, /id: 11111111-2222-4333-8444-555555555555\s+·\s+prospect show 11111111-2222-4333-8444-555555555555/);
	});

	it("list_proposals accepts a source param and the header shows the harness", async () => {
		const db = await openAsyncDatabase(process.env["PROSPECTOR_DB_PATH"]!);
		await migrate(db);
		await insertSession(db, "tool-pi", "/tmp/tpi.jsonl", "/home/user/toolPiProj", "pi");
		await insertSession(db, "tool-cl", "/tmp/tcl.jsonl", "/home/user/toolClProj", "claude");
		await insertProposalRow(db, { id: "tp-1-0000-0000-4000-8000-000000000001", sessionId: "tool-pi", title: "Tool Pi proposal", inputKey: "ik-tp-1" });
		await insertProposalRow(db, { id: "tc-1-0000-0000-4000-8000-000000000002", sessionId: "tool-cl", title: "Tool Claude proposal", inputKey: "ik-tc-1" });
		await db.close();

		const all = await toolExec("srcAll", { action: "list_proposals" }, signal, null, ctx);
		assert.match(all.content[0]!.text, /Tool Pi proposal/);
		assert.match(all.content[0]!.text, /Tool Claude proposal/);

		const onlyClaude = await toolExec("srcCl", { action: "list_proposals", source: "claude" }, signal, null, ctx);
		assert.match(onlyClaude.content[0]!.text, /Tool Claude proposal/);
		assert.doesNotMatch(onlyClaude.content[0]!.text, /Tool Pi proposal/);
		assert.match(onlyClaude.content[0]!.text, /\[Claude\]/);
	});

	it("list_proposals accepts a session_id param and only shows that session's proposals", async () => {
		const db = await openAsyncDatabase(process.env["PROSPECTOR_DB_PATH"]!);
		await migrate(db);
		await insertSession(db, "sess-filt-a", "/tmp/filta.jsonl", "/home/user/filtA");
		await insertSession(db, "sess-filt-b", "/tmp/filtb.jsonl", "/home/user/filtB");
		await insertProposalRow(db, { id: "flt-a-00000001-0000-4000-8000-000000000001", sessionId: "sess-filt-a", title: "Filter A proposal", inputKey: "ik-flt-a" });
		await insertProposalRow(db, { id: "flt-b-00000001-0000-4000-8000-000000000002", sessionId: "sess-filt-b", title: "Filter B proposal", inputKey: "ik-flt-b" });
		await db.close();

		const res = await toolExec("flt", { action: "list_proposals", session_id: "sess-filt-b" }, signal, null, ctx);
		const body = res.content[0]!.text;
		assert.match(body, /Filter B proposal/);
		assert.doesNotMatch(body, /Filter A proposal/);
	});

	it("#19 list_proposals filters by the severity param", async () => {
		const db = await openAsyncDatabase(process.env["PROSPECTOR_DB_PATH"]!);
		await migrate(db);
		const session = await db.prepare("SELECT id FROM sessions LIMIT 1").get() as { id: string };
		await insertProposalRow(db, { id: "sev-friction-0001-0000-4000-8000-000000000001", sessionId: session.id, title: "Sev friction keep", severity: "friction", inputKey: "ik-sev-f" });
		await insertProposalRow(db, { id: "sev-waste-0002-0000-4000-8000-000000000002", sessionId: session.id, title: "Sev waste keep", severity: "waste", inputKey: "ik-sev-w" });
		await db.close();

		const res = await toolExec("id19", { action: "list_proposals", severity: "waste" }, signal, null, ctx);
		const body = res.content[0]!.text;
		assert.match(body, /Sev waste keep/);
		assert.doesNotMatch(body, /Sev friction keep/);
	});

	it("#20 list_proposals honours the limit param", async () => {
		const db = await openAsyncDatabase(process.env["PROSPECTOR_DB_PATH"]!);
		await migrate(db);
		const session = await db.prepare("SELECT id FROM sessions LIMIT 1").get() as { id: string };
		for (let i = 0; i < 5; i++) {
			await insertProposalRow(db, { id: `lim-${i}-0000-0000-4000-8000-0000000000${i.toString().padStart(2, "0")}`, sessionId: session.id, title: `Limit item ${i}`, inputKey: `ik-lim-${i}` });
		}
		await db.close();

		const res = await toolExec("id20", { action: "list_proposals", limit: 2 }, signal, null, ctx);
		const body = res.content[0]!.text;
		const entries = body.match(/prospect show lim-/g) ?? [];
		assert.equal(entries.length, 2, `limit=2 must cap at 2 entries; got:\n${body}`);
	});

	it("#21 list_proposals groups by session and reuses the conciseEntry format", async () => {
		const db = await openAsyncDatabase(process.env["PROSPECTOR_DB_PATH"]!);
		await migrate(db);
		await insertSession(db, "sess-tool-a", "/tmp/a.jsonl", "/home/user/projA");
		await insertSession(db, "sess-tool-b", "/tmp/b.jsonl", "/home/user/projB");
		await insertProposalRow(db, { id: "grp-a-00000001-0000-4000-8000-000000000001", sessionId: "sess-tool-a", title: "Group A proposal", inputKey: "ik-grp-a" });
		await insertProposalRow(db, { id: "grp-b-00000001-0000-4000-8000-000000000002", sessionId: "sess-tool-b", title: "Group B proposal", inputKey: "ik-grp-b" });
		await db.close();

		const res = await toolExec("id21", { action: "list_proposals" }, signal, null, ctx);
		const body = res.content[0]!.text;
		// Grouping by session produces one header per session (>=2 here, including
		// the fixture session from earlier tests). What matters is that the two
		// new proposals each land under their own session's header, with the
		// slash-command header format and the conciseEntry id+show line.
		assert.ok((body.match(/═══.*═══/g) ?? []).length >= 2, `expected >=2 session group headers; got:\n${body}`);
		assert.ok(body.includes("═══ sess-too [Pi] · /home/user/projA · 1 proposal(s) ═══"), `missing projA group header; got:\n${body}`);
		assert.ok(body.includes("═══ sess-too [Pi] · /home/user/projB · 1 proposal(s) ═══"), `missing projB group header; got:\n${body}`);
		assert.match(body, /Group A proposal/);
		assert.match(body, /Group B proposal/);
		// The conciseEntry id+show line (matching the slash command) is present.
		assert.match(body, /id: grp-a-00000001-0000-4000-8000-000000000001\s+·\s+prospect show grp-a-00000001-0000-4000-8000-000000000001/);
	});

	it("#21 tool list_proposals format matches the slash command output", async () => {
		const db = await openAsyncDatabase(process.env["PROSPECTOR_DB_PATH"]!);
		await migrate(db);
		await insertSession(db, "sess-fmt-a", "/tmp/fa.jsonl", "/home/user/fmtA");
		await insertSession(db, "sess-fmt-b", "/tmp/fb.jsonl", "/home/user/fmtB");
		await insertProposalRow(db, { id: "fmt-a-00000001-0000-4000-8000-000000000001", sessionId: "sess-fmt-a", title: "Fmt A proposal", severity: "friction", inputKey: "ik-fmt-a" });
		await insertProposalRow(db, { id: "fmt-b-00000001-0000-4000-8000-000000000002", sessionId: "sess-fmt-b", title: "Fmt B proposal", severity: "reinforcement", inputKey: "ik-fmt-b" });
		await db.close();

		const toolBody = (await toolExec("id21b", { action: "list_proposals" }, signal, null, ctx)).content[0]!.text;
		const slashOut = await run("prospect-proposals");
		// Every conciseEntry `prospect show <id>` line in the tool output must appear
		// verbatim in the slash command output — proving format consistency.
		const entryIds = toolBody.match(/prospect show \S+/g) ?? [];
		assert.ok(entryIds.length >= 2, `expected >=2 entries; got:\n${toolBody}`);
		for (const e of entryIds) {
			assert.ok(slashOut.includes(e), `slash output missing concise line "${e}";\nslash:\n${slashOut}`);
		}
		// Both produce the same session-group headers for these sessions (the
		// header truncates the session id to 8 chars, so assert on the cwd label
		// which is rendered in full and identically by both).
		assert.ok(toolBody.includes("/home/user/fmtA"), `tool missing fmtA label; got:\n${toolBody}`);
		assert.ok(slashOut.includes("/home/user/fmtA"), `slash missing fmtA label; got:\n${slashOut}`);
		assert.ok(toolBody.includes("/home/user/fmtB"), `tool missing fmtB label; got:\n${toolBody}`);
		assert.ok(slashOut.includes("/home/user/fmtB"), `slash missing fmtB label; got:\n${slashOut}`);
	});

	it("remediate accepts many proposals under one shared remediation", async () => {
		const db = await openAsyncDatabase(process.env["PROSPECTOR_DB_PATH"]!);
		await migrate(db);
		const session = await db.prepare("SELECT id FROM sessions LIMIT 1").get() as { id: string };
		await insertProposalRow(db, { id: "tool-r1-0000-0000-4000-8000-000000000001", sessionId: session.id, title: "Tool remediate A", inputKey: "ik-tool-r1" });
		await insertProposalRow(db, { id: "tool-r2-0000-0000-4000-8000-000000000002", sessionId: session.id, title: "Tool remediate B", inputKey: "ik-tool-r2" });
		await db.close();

		const res = await toolExec(
			"trem1",
			{
				action: "remediate",
				proposal_ids: ["tool-r1-0000-0000-4000-8000-000000000001", "tool-r2-0000-0000-4000-8000-000000000002", "missing-id"],
				description: "added one shared lint rule",
				disposition: "done",
			},
			signal,
			null,
			ctx,
		);
		const body = res.content[0]!.text;
		assert.match(body, /2/);
		assert.match(body, /remediation/i);
		assert.match(body, /missing-id/);

		const db2 = await openAsyncDatabase(process.env["PROSPECTOR_DB_PATH"]!);
		const d1 = await getLatestDecision(db2, "ik-tool-r1")!;
		const d2 = await getLatestDecision(db2, "ik-tool-r2")!;
		await db2.close();
		assert.ok(d1.remediation_id);
		assert.equal(d1.remediation_id, d2.remediation_id);
		assert.equal(d1.disposition, "done");

		const noIds = await toolExec("trem2", { action: "remediate", description: "x" }, signal, null, ctx);
		assert.match(noIds.content[0]!.text, /required/);
		const noDescription = await toolExec("trem3", { action: "remediate", proposal_ids: ["a"] }, signal, null, ctx);
		assert.match(noDescription.content[0]!.text, /required/);
	});

	it("#22 accept/reject with unknown id suggests using the full ID from list_proposals", async () => {
		const accept = await toolExec("id22a", { action: "accept", proposal_id: "no-such-id" }, signal, null, ctx);
		assert.match(accept.content[0]!.text, /not found or not open/i);
		assert.match(accept.content[0]!.text, /full ID/i);
		assert.match(accept.content[0]!.text, /list_proposals/i);

		const reject = await toolExec("id22b", { action: "reject", proposal_id: "no-such-id" }, signal, null, ctx);
		assert.match(reject.content[0]!.text, /not found or not open/i);
		assert.match(reject.content[0]!.text, /full ID/i);
		assert.match(reject.content[0]!.text, /list_proposals/i);
	});
});
