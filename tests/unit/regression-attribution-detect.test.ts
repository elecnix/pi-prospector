// Tests for the regression-attribution join.
//
// The join is the part that can manufacture an author if it is wrong, so the
// negative cases matter most: an ambiguous number, an unknown number, and a
// self-inflicted repair must each be told apart from a clean attribution.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	attribute,
	claimFromNode,
	indexPullRequests,
	recordFromNode,
	type PullRequestRecord,
} from "../../src/analyze/analyzers/regression-attribution/detect.js";

const repo = { owner: "acme", repo: "widgets" };

function rec(session_id: string, number: number, title = ""): PullRequestRecord {
	return { session_id, ...repo, number, url: `https://github.com/acme/widgets/pull/${number}`, title };
}

function claim(prs: number[], commits: string[] = []) {
	return {
		cited_pull_requests: prs.map((n) => ({ number: n, quote: `caused by #${n}`, message_id: "m1" })),
		cited_commits: commits.map((sha) => ({ sha, quote: `commit ${sha}`, message_id: "m1" })),
	};
}

describe("indexPullRequests", () => {
	it("keeps the first record for a pull request, matching the cost report's rule", () => {
		const index = indexPullRequests([rec("first", 10), rec("second", 10)]);
		// The host is part of the key: two forges can carry the same owner, repository and number.
		assert.equal(index.get("github.com|acme/widgets#10")?.session_id, "first");
	});

	it("skips malformed records instead of throwing", () => {
		const index = indexPullRequests([
			{ session_id: "x", owner: "", repo: "", number: 1, url: "", title: null },
			rec("ok", 2),
		]);
		assert.equal(index.size, 1);
	});
});

describe("attribute", () => {
	it("resolves a blamed pull request to the session that opened it", () => {
		const result = attribute("fix-session", claim([612]), [rec("author-session", 612, "feat: remove the config clone")]);

		assert.equal(result.resolved_count, 1);
		assert.equal(result.unresolved_count, 0);
		assert.equal(result.attributions[0].introducing_session_id, "author-session");
		assert.equal(result.attributions[0].introducing_title, "feat: remove the config clone");
		assert.equal(result.self_inflicted, false);
	});

	it("records an unresolved blame rather than dropping it", () => {
		const result = attribute("fix-session", claim([999]), []);

		assert.equal(result.resolved_count, 0);
		assert.equal(result.unresolved_count, 1);
		assert.equal(result.attributions[0].introducing_session_id, null);
		assert.equal(result.attributions[0].resolved, false);
	});

	it("refuses to attribute when one number appears in two repositories", () => {
		const records: PullRequestRecord[] = [
			rec("a", 612),
			{ session_id: "b", owner: "elecnix", repo: "other", number: 612, url: "", title: null },
		];

		const result = attribute("fix-session", claim([612]), records);

		assert.equal(result.resolved_count, 0, "an ambiguous number must not invent an author");
		assert.equal(result.unresolved_count, 1);
	});

	it("marks a repair of the session's own earlier change as self-inflicted", () => {
		const result = attribute("same-session", claim([612]), [rec("same-session", 612)]);

		assert.equal(result.resolved_count, 1);
		assert.equal(result.self_inflicted, true);
	});

	it("does not call a repair self-inflicted when one blamed author is different", () => {
		const result = attribute("fix-session", claim([612, 600]), [rec("fix-session", 612), rec("other", 600)]);

		assert.equal(result.resolved_count, 2);
		assert.equal(result.self_inflicted, false);
	});

	it("never resolves a commit to a session", () => {
		const result = attribute("fix-session", claim([], ["1a2b3c4d5e6f"]), [rec("someone", 1)]);

		assert.equal(result.attributions.length, 0);
		assert.equal(result.cited_commits.length, 1);
		assert.equal(result.resolved_count, 0);
	});

	it("orders attributions by pull request number", () => {
		const result = attribute("fix-session", claim([700, 612]), [rec("a", 612), rec("b", 700)]);
		assert.deepEqual(
			result.attributions.map((a) => a.number),
			[612, 700],
		);
	});
});

describe("claimFromNode", () => {
	it("reads the pull requests and commits regression-signal wrote", () => {
		const claimValue = claimFromNode({
			cited_pull_requests: [{ number: 612, quote: "caused by #612", message_id: "m1" }],
			cited_commits: [{ sha: "abc1234", quote: "commit abc1234", message_id: "m1" }],
		});

		assert.ok(claimValue);
		assert.equal(claimValue.cited_pull_requests[0].number, 612);
		assert.equal(claimValue.cited_commits[0].sha, "abc1234");
	});

	it("returns null when the node carries no citation", () => {
		assert.equal(claimFromNode({ cited_pull_requests: [], cited_commits: [] }), null);
		assert.equal(claimFromNode(null), null);
	});
});

describe("recordFromNode", () => {
	it("reads the built-in pr-opened shape", () => {
		const record = recordFromNode({
			session_id: "s1",
			pull_request: { url: "https://github.com/acme/widgets/pull/612", owner: "acme", repo: "widgets", number: 612, title: "feat: x" },
		});

		assert.ok(record);
		assert.equal(record.number, 612);
		assert.equal(record.session_id, "s1");
		assert.equal(record.title, "feat: x");
	});

	it("returns null for a node without a pull request", () => {
		assert.equal(recordFromNode({}), null);
	});
});
