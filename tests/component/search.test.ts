/**
 * Component tests for corpus search (`prospect search`, issue #194) — content
 * and pattern search over proposals and the session corpus via the two FTS5
 * indexes (`messages_fts`, `proposals_fts`).
 *
 * Real SQLite (temp file), hand-written synthetic session text and proposals,
 * no network, no LLM. Proves the search finds both record kinds, highlights
 * matches in snippets, ranks by bm25, honours the kind/source/limit filters,
 * supports honest FTS5 MATCH syntax including prefix queries, rejects
 * malformed queries with a user-facing error instead of a silent empty result,
 * and stays in sync when proposals are deleted (gc).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession, insertMessages, insertProposalRow } from "./helpers.js";
import {
	searchCorpus,
	SNIPPET_OPEN,
	SNIPPET_CLOSE,
	type SearchResult,
} from "../../src/db/search-queries.js";
import { readSearch, renderSearch } from "../../src/commands/search.js";

interface Scenario {
	db: ReturnType<typeof tempDb>["db"];
	close: () => void;
}

/**
 * Two pi sessions and one claude session of corpus text, plus three proposals
 * (two open on one topic, one rejected on another) so cross-kind merging, the
 * source filter, and status visibility are all exercised.
 */
function buildScenario(): Scenario {
	const { db, close } = tempDb();
	insertSession(db, "sess-pi-1", "/tmp/sess-pi-1.jsonl", "", "pi");
	insertSession(db, "sess-pi-2", "/tmp/sess-pi-2.jsonl", "", "pi");
	insertSession(db, "sess-claude", "/tmp/sess-claude.jsonl", "", "claude");

	// The lexicon topic lives in sess-pi-1 (user) and sess-claude (assistant).
	insertMessages(db, "sess-pi-1", [
		{ role: "user", text: "the lexicon keeps missing French frustration terms" },
		{ role: "assistant", thinking: "lexicon coverage is the recall risk here", text: "understood" },
	]);
	insertMessages(db, "sess-pi-2", [
		{ role: "user", text: "please fix the login bug in the auth service" },
	]);
	insertMessages(db, "sess-claude", [
		{ role: "assistant", text: "I extended the lexicon with three new terms" },
	]);

	insertProposalRow(db, {
		id: "prop-lexicon",
		sessionId: "sess-pi-1",
		title: "Add French frustration terms to the lexicon",
		summary: "The lexicon missed 'laisse tomber'; encode it as a correction term",
	});
	insertProposalRow(db, {
		id: "prop-lexicon-2",
		sessionId: "sess-claude",
		title: "Lexicon nomination budget is exhausted too early",
		summary: "Raise the per-session nomination cap so rare terms get judged",
	});
	insertProposalRow(db, {
		id: "prop-auth",
		sessionId: "sess-pi-2",
		title: "Document the auth service retry rule",
		summary: "Standing instruction: check auth service health before deploy",
		status: "rejected",
	});
	return { db, close };
}

describe("searchCorpus", () => {
	it("finds a message hit with its session, role, source, and highlighted snippet", () => {
		const { db, close } = buildScenario();
		try {
			const r = searchCorpus(db, "frustration");
			const hit = r.hits.find((h) => h.kind === "message" && h.session_id === "sess-pi-1");
			assert.ok(hit, "expected a hit in sess-pi-1");
			assert.equal(hit.kind, "message");
			if (hit.kind !== "message") return;
			assert.equal(hit.role, "user");
			assert.equal(hit.source, "pi");
			assert.ok(hit.snippet.includes(`${SNIPPET_OPEN}frustration${SNIPPET_CLOSE}`), hit.snippet);
			assert.ok(r.message_matches >= 1);
		} finally {
			close();
		}
	});

	it("indexes assistant private reasoning as well as message text", () => {
		const { db, close } = buildScenario();
		try {
			const r = searchCorpus(db, "recall");
			const hit = r.hits.find((h) => h.kind === "message");
			assert.ok(hit && hit.kind === "message");
			if (hit && hit.kind === "message") {
				assert.equal(hit.field, "content_thinking");
				assert.ok(hit.snippet.includes(`${SNIPPET_OPEN}recall${SNIPPET_CLOSE}`));
			}
		} finally {
			close();
		}
	});

	it("finds a proposal hit naming which indexed field matched", () => {
		const { db, close } = buildScenario();
		try {
			const r = searchCorpus(db, "nomination");
			const hit = r.hits.find((h) => h.kind === "proposal" && h.proposal_id === "prop-lexicon-2");
			assert.ok(hit, "expected prop-lexicon-2");
			assert.equal(hit.kind, "proposal");
			if (hit.kind !== "proposal") return;
			assert.equal(hit.severity, "suggestion");
			assert.equal(hit.status, "open");
			assert.ok(["title", "summary"].includes(hit.field), `unexpected field ${hit.field}`);
			assert.ok(hit.snippet.includes(SNIPPET_OPEN));
		} finally {
			close();
		}
	});

	it("merges both kinds into one bm25-ranked list with ascending ranks", () => {
		const { db, close } = buildScenario();
		try {
			const r = searchCorpus(db, "lexicon");
			const kinds = new Set(r.hits.map((h) => h.kind));
			assert.ok(kinds.has("message"), "expected at least one message hit");
			assert.ok(kinds.has("proposal"), "expected at least one proposal hit");
			const ranks = r.hits.map((h) => h.rank);
			assert.deepEqual([...ranks].sort((a, b) => a - b), ranks, "hits must be ordered best-rank first");
		} finally {
			close();
		}
	});

	it("filters by harness source through each record kind's session", () => {
		const { db, close } = buildScenario();
		try {
			const r = searchCorpus(db, "lexicon", { source: "claude" });
			assert.ok(r.hits.length > 0);
			for (const h of r.hits) assert.equal(h.session_id, "sess-claude");
			const all = searchCorpus(db, "lexicon");
			assert.ok(all.hits.some((h) => h.kind === "message" && h.source === "pi"));
		} finally {
			close();
		}
	});

	it("restricts to one record kind with --kind", () => {
		const { db, close } = buildScenario();
		try {
			const msgs = searchCorpus(db, "lexicon", { kind: "messages" });
			assert.ok(msgs.message_matches > 0);
			assert.equal(msgs.proposal_matches, 0);
			assert.ok(msgs.hits.every((h) => h.kind === "message"));
			const props = searchCorpus(db, "lexicon", { kind: "proposals" });
			assert.equal(props.message_matches, 0);
			assert.ok(props.hits.every((h) => h.kind === "proposal"));
		} finally {
			close();
		}
	});

	it("supports FTS5 prefix queries (pattern search)", () => {
		const { db, close } = buildScenario();
		try {
			const r = searchCorpus(db, "frustrat*");
			assert.ok(
				r.hits.some((h) => h.kind === "message"),
				"prefix 'frustrat*' must match 'frustration'",
			);
		} finally {
			close();
		}
	});

	it("supports quoted phrases and column filters", () => {
		const { db, close } = buildScenario();
		try {
			const phrase = searchCorpus(db, '"standing instruction"');
			assert.ok(phrase.proposal_matches > 0, "phrase must match prop-auth summary");
			// A column filter is per-index (messages index content_text/content_thinking,
			// proposals index title/summary/detail/evidence), so pair it with --kind.
			const column = searchCorpus(db, "title:retry", { kind: "proposals" });
			const hit = column.hits.find((h) => h.kind === "proposal" && h.proposal_id === "prop-auth");
			assert.ok(hit, "column filter title:retry must find prop-auth");
		} finally {
			close();
		}
	});

	it("applies the merged limit and reports what was omitted", () => {
		const { db, close } = buildScenario();
		try {
			const r = searchCorpus(db, "lexicon", { limit: 1 });
			assert.equal(r.hits.length, 1);
			assert.ok(r.omitted_by_limit >= 1);
		} finally {
			close();
		}
	});

	it("rejects an empty query and malformed MATCH syntax with user-facing errors", () => {
		const { db, close } = buildScenario();
		try {
			assert.throws(() => searchCorpus(db, ""), /empty search query/);
			assert.throws(() => searchCorpus(db, '   '), /empty search query/);
			assert.throws(
				() => searchCorpus(db, "lexicon AND"),
				/invalid search query/,
				"a dangling AND is invalid FTS5",
			);
			// A hyphen reads as a column filter to FTS5; the error must stay
			// user-facing rather than a raw SQLITE_ERROR.
			assert.throws(() => searchCorpus(db, "zzz-nothing"), /invalid search query/);
		} finally {
			close();
		}
	});

	it("stays in sync when gc deletes a proposal", () => {
		const { db, close } = buildScenario();
		try {
			assert.ok(searchCorpus(db, "retry").proposal_matches > 0);
			db.prepare("DELETE FROM proposals WHERE id = ?").run("prop-auth");
			const r = searchCorpus(db, "retry");
			assert.equal(r.proposal_matches, 0);
			assert.equal(r.hits.length, 0);
		} finally {
			close();
		}
	});
});

describe("readSearch / renderSearch", () => {
	it("renders kind, id, session, snippet, and links into the read surface", () => {
		const { db, close } = buildScenario();
		try {
			const { text, report } = readSearch(db, { query: "lexicon", kind: "all" });
			const r: SearchResult = report;
			assert.equal(r.query, "lexicon");
			assert.ok(text.includes('Search "lexicon"'), text);
			assert.ok(text.includes("[message]"), "message hits labelled");
			assert.ok(text.includes("[proposal]"), "proposal hits labelled");
			assert.ok(text.includes("→ prospect show --session sess-pi-1"), "session link present");
			assert.ok(text.includes("→ prospect show prop-lexicon"), "proposal link present");
			assert.ok(text.includes(SNIPPET_OPEN), "highlight marker rendered");
		} finally {
			close();
		}
	});

	it("renders the no-match case with the supported syntax, never silently", () => {
		const { db, close } = buildScenario();
		try {
			const { text } = readSearch(db, { query: "zzznothingmatchesthis", kind: "all" });
			assert.ok(text.includes("No matches"), text);
			assert.ok(text.includes("FTS5"), "syntax help accompanies an empty result");
		} finally {
			close();
		}
	});
});
