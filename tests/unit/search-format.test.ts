/**
 * Unit tests for the `prospect search` argument parsing and rendering — pure
 * functions over strings and plain objects, no database.
 *
 * The parser is the contract for both surfaces (slash command and tool
 * action): flags are stripped, the remainder is the verbatim FTS5 MATCH
 * query, and malformed input is an Error with a user-facing message rather
 * than a silent fallback.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	parseSearchArgs,
	renderSearch,
	searchSyntaxHelp,
	type SearchReport,
} from "../../src/commands/search.js";
import { SNIPPET_OPEN, SNIPPET_CLOSE } from "../../src/db/search-queries.js";

describe("parseSearchArgs", () => {
	it("treats every non-flag token as the query, joined in order", () => {
		const q = parseSearchArgs("lexicon frustration terms");
		assert.equal(q.query, "lexicon frustration terms");
		assert.equal(q.kind, "all");
		assert.equal(q.limit, undefined);
		assert.equal(q.source, undefined);
	});

	it("parses the supported flags", () => {
		const q = parseSearchArgs("lexicon* --kind proposals --limit 5 --source claude");
		assert.equal(q.query, "lexicon*");
		assert.equal(q.kind, "proposals");
		assert.equal(q.limit, 5);
		assert.equal(q.source, "claude");
	});

	it("keeps quoted phrases together as part of the query", () => {
		const q = parseSearchArgs('"standing instruction" deploy');
		assert.equal(q.query, '"standing instruction" deploy');
	});

	it("rejects unknown --kind and --source values", () => {
		assert.throws(() => parseSearchArgs("x --kind everything"), /unknown --kind/);
		assert.throws(() => parseSearchArgs("x --source gpt"), /unknown --source/);
	});

	it("requires a positive integer limit", () => {
		assert.throws(() => parseSearchArgs("x --limit 0"), /positive integer/);
		assert.throws(() => parseSearchArgs("x --limit abc"), /needs a value|positive integer|Invalid/);
	});

	it("rejects a flag missing its value", () => {
		assert.throws(() => parseSearchArgs("x --limit"), /needs a value/);
	});

	it("rejects an empty query with the usage line", () => {
		assert.throws(() => parseSearchArgs("--kind messages"), /a search query is required.*Usage:/s);
	});
});

describe("renderSearch", () => {
	const report: SearchReport = {
		query: "frustrat*",
		hits: [
			{
				kind: "message",
				message_id: "m1",
				session_id: "s1",
				role: "user",
				source: "pi",
				rank: -1.2,
				snippet: `the ${SNIPPET_OPEN}frustration${SNIPPET_CLOSE} term`,
				field: "content_text",
			},
			{
				kind: "proposal",
				proposal_id: "p1",
				session_id: "s2",
				title: "Add terms",
				severity: "correction",
				status: "open",
				analyzer_id: null,
				rank: -0.9,
				snippet: `${SNIPPET_OPEN}frustration${SNIPPET_CLOSE} lexicon`,
				field: "summary",
			},
		],
		message_matches: 1,
		proposal_matches: 1,
		omitted_by_limit: 0,
	};

	it("labels each hit kind and links into prospect show", () => {
		const text = renderSearch(report, { kind: "all" });
		assert.ok(text.includes("[message] m1 · user · pi · session s1"), text);
		assert.ok(text.includes("[proposal] p1 · correction/open"), text);
		assert.ok(text.includes("→ prospect show --session s1"));
		assert.ok(text.includes("→ prospect show p1"));
	});

	it("reports the match tallies and the ranking order claim", () => {
		const text = renderSearch(report, { kind: "all" });
		assert.ok(text.includes('Search "frustrat*"'), text);
		assert.ok(text.includes("2 hit(s) (1 message(s), 1 proposal(s) matched)"), text);
		assert.ok(text.includes("bm25"), text);
	});

	it("mentions omitted hits when the limit cut results", () => {
		const text = renderSearch({ ...report, hits: report.hits.slice(0, 1), omitted_by_limit: 1 }, { kind: "all", limit: 1 });
		assert.ok(text.includes("1 more hit(s) omitted by --limit 1"), text);
	});

	it("renders the empty case with syntax help", () => {
		const empty: SearchReport = { query: "zzz", hits: [], message_matches: 0, proposal_matches: 0, omitted_by_limit: 0 };
		const text = renderSearch(empty, {});
		assert.ok(text.includes("No matches"), text);
		assert.ok(text.includes(searchSyntaxHelp().slice(0, 30)), "syntax help present");
	});

	it("documents prefix queries and column filters in the syntax help", () => {
		const help = searchSyntaxHelp();
		assert.match(help, /\*/);
		assert.match(help, /column filters/);
		assert.match(help, /title:secret/);
		assert.match(help, /content_thinking/);
		assert.match(help, /evidence/);
	});
});
