// Tests for the regression-evidence detector.
//
// Each case is a hand-written transcript, and the assertion is about the claim:
// whether the session fixed a defect an earlier change introduced. The negative
// cases carry most of the weight, because a false claim poisons the attribution
// pass that reads this output.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_CONFIG, findRegressionEvidence, type MessageRow } from "../../src/analyze/analyzers/regression-signal/detect.js";

let seq = 0;
const nextId = (p: string) => `${p}-${++seq}`;

function row(role: string, text: string | null, extra: Partial<MessageRow> = {}): MessageRow {
	return {
		id: extra.id ?? nextId("m"),
		session_id: extra.session_id ?? "s1",
		role,
		content_text: text,
		content_thinking: extra.content_thinking ?? null,
		tool_calls: extra.tool_calls ?? null,
		tool_results: extra.tool_results ?? null,
		stop_reason: null,
		error_message: null,
		cost_usd: null,
	};
}

/** An assistant row that ran one bash command, plus its result. */
function bash(command: string, result: string): MessageRow[] {
	const callId = nextId("call");
	return [
		row("assistant", null, {
			tool_calls: JSON.stringify([{ id: callId, name: "bash", arguments: { command } }]),
		}),
		row("toolResult", result),
	];
}

describe("findRegressionEvidence", () => {
	it("files a claim when the session fixes a defect and names the pull request that caused it", () => {
		const messages = [
			row("user", "The staging deploy broke after #612 merged. The router now 500s on every request."),
			row("assistant", "That is a regression caused by #612. The config clone was removed there, so the router mutates a shared struct."),
			...bash("git commit -am 'fix(router): restore the config clone'", "[main 9f2c1ab] fix(router): restore the config clone"),
			...bash("gh pr create --title 'fix(router): restore the config clone'", "https://github.com/acme/widgets/pull/700"),
		];

		const scan = findRegressionEvidence(messages);

		assert.equal(scan.claims_regression, true);
		assert.deepEqual(
			scan.cited_pull_requests.map((p) => p.number),
			[612],
		);
		assert.equal(scan.signals.changed_something, true);
		assert.equal(scan.signals.causal_claim, true);
		assert.equal(scan.signals.names_the_cause, true);
		assert.equal(scan.blames_upstream, false);
		assert.equal(scan.never_worked, false);
	});

	it("files a claim for a revert, which is the strongest form of the statement", () => {
		const messages = [
			row("assistant", "Reverting the change, because it broke the streaming path."),
			...bash('git revert --no-edit 1a2b3c4', '[main 5d6e7f8] Revert "stream responses eagerly"'),
			...bash("git commit -m 'this reverts commit 1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b'", "[main 9f2c1ab] revert"),
		];

		const scan = findRegressionEvidence(messages);

		assert.equal(scan.claims_regression, true);
		assert.equal(scan.signals.reverts, true);
		// The reverted sha is cited, and the commits the revert itself created are not: the
		// transcript carries the full 40-character sha in its commit message.
		assert.ok(
			scan.cited_commits.some((c) => c.sha.startsWith("1a2b3c4")),
			"the reverted commit is cited",
		);
		assert.ok(
			!scan.cited_commits.some((c) => c.sha.startsWith("5d6e7f8") || c.sha.startsWith("9f2c1ab")),
			"the commits the revert created are not cited as its cause",
		);
	});

	it("stays silent on an additive session that never names a cause", () => {
		const messages = [
			row("user", "Add a /healthz endpoint."),
			row("assistant", "Adding the endpoint now."),
			...bash("git commit -am 'feat: add /healthz'", "[main 1a2b3c4] feat: add /healthz"),
		];

		const scan = findRegressionEvidence(messages);

		assert.equal(scan.claims_regression, false);
		assert.deepEqual(scan.cited_pull_requests, []);
	});

	it("stays silent when the session only discusses someone else's regression and changes nothing", () => {
		const messages = [
			row("user", "Review PR #612 for me. It says it fixes a regression caused by #580."),
			row("assistant", "Reading it. The claim is that #580 introduced a regression in the credit path. The diff looks reasonable."),
		];

		const scan = findRegressionEvidence(messages);

		assert.equal(scan.claims_regression, false, "a review is not a fix");
		assert.equal(scan.signals.changed_something, false);
	});

	it("does not read 'regression test' as a defect", () => {
		const messages = [
			row("user", "Add a regression test for the credit rounding."),
			...bash("npm test -- regression.test.ts", "PASS regression.test.ts"),
			...bash("git commit -am 'test: add a regression test for credit rounding'", "[main abc1234] test: add a regression test"),
		];

		const scan = findRegressionEvidence(messages);

		assert.equal(scan.claims_regression, false);
	});

	it("marks a vendor regression as upstream rather than ours", () => {
		const messages = [
			row(
				"assistant",
				"That is an upstream regression in the released provider CLI: version 2.4.0 regressed and it is fixed in 2.4.2. Nothing of ours to revert.",
			),
			...bash("git commit -am 'chore(deps): pin provider cli 2.4.1'", "[main abc1234] chore(deps): pin provider cli"),
		];

		const scan = findRegressionEvidence(messages);

		assert.equal(scan.blames_upstream, true);
	});

	it("marks a defect that never worked as a new defect, not a regression", () => {
		const messages = [
			// The claim and the never-worked fact share one sentence, which is how the rule
			// reads: a sentence that names a cause and says the defect never worked is a new
			// defect. Another sentence about another defect must not cancel a real claim.
			row("assistant", "This never worked, caused by a missing branch in PR 590; the path was always unreachable."),
			...bash("git commit -am 'fix: reach the unreachable branch'", "[main abc1234] fix"),
		];

		const scan = findRegressionEvidence(messages);

		assert.equal(scan.never_worked, true);
		assert.equal(scan.claims_regression, false, "a defect that never worked is not a regression");
	});

	it("names a pull request cited in the same sentence as the cause, not one merely linked", () => {
		const messages = [
			row("user", "See #700 and #612. Only the second one matters here."),
			row("assistant", "The regression came from #612, which removed the guard."),
			...bash("git commit -am 'fix: restore the guard'", "[main abc1234] fix"),
		];

		const scan = findRegressionEvidence(messages);

		// Equality, not presence: a detector that also cites the merely linked number
		// must fail here. `some(...)` stayed green with both recorded.
		assert.deepEqual(
			scan.cited_pull_requests.map((p) => p.number),
			[612],
			"only the cited cause is recorded, not the linked one",
		);
	});

	it("does not read a denial as a claim, which is the corpus's most common form", () => {
		const messages = [
			row("assistant", "Both jobs failed at 'Set up job'. This is NOT caused by #1400 (docs-only). It is a transient runner failure."),
			...bash("git commit -am 'ci: re-run the failed jobs'", "[main abc1234] ci: re-run"),
		];

		const scan = findRegressionEvidence(messages);

		assert.deepEqual(scan.cited_pull_requests, [], "#1400 is exonerated, not blamed");
		assert.equal(scan.claims_regression, false);
	});

	it("does not blame a pull request a sentence calls pre-existing", () => {
		const messages = [
			row("assistant", "That file is a pre-existing issue on main, not caused by #1066's diff, which does not touch it."),
			...bash("git commit -am 'docs: trim the file'", "[main abc1234] docs: trim"),
		];

		const scan = findRegressionEvidence(messages);

		assert.deepEqual(scan.cited_pull_requests, []);
		assert.equal(scan.claims_regression, false);
	});

	it("does not blame the pull request that fixed the defect", () => {
		const messages = [
			row("assistant", "The mint 403 was caused by a missing User-Agent and was fixed in #2274."),
			...bash("git commit -am 'fix(mint): send a User-Agent'", "[main abc1234] fix(mint): send a User-Agent"),
		];

		const scan = findRegressionEvidence(messages);

		assert.deepEqual(scan.cited_pull_requests, [], "#2274 is the cure, not the cause");
	});

	it("labels a regression whose cause is stated without a number", () => {
		// The corpus's common shape: the session names the mechanism, not a PR. It is a
		// regression fix, it is simply not attributable to an author session.
		const messages = [
			row("assistant", "The throughput collapse was a regression caused by my own extension of the lab, not by concurrency. Reverting that part."),
			...bash("git commit -am 'fix(lab): drop the extra stage'", "[main abc1234] fix(lab): drop the extra stage"),
		];

		const scan = findRegressionEvidence(messages);

		assert.equal(scan.claims_regression, true, "it is still a regression fix");
		assert.equal(scan.signals.names_the_cause, false, "but nothing can be joined on it");
		assert.deepEqual(scan.cited_pull_requests, []);
	});

	it("does not let another sentence's never-worked cancel a genuine claim", () => {
		const messages = [
			row("assistant", "The unrelated exporter never worked, and that is a separate matter. The deploy broke: the regression was caused by PR 612, which removed the guard."),
			...bash("git commit -am 'fix: restore the guard'", "[main abc1234] fix"),
		];

		const scan = findRegressionEvidence(messages);

		assert.equal(scan.claims_regression, true);
		assert.equal(scan.never_worked, false);
	});

	it("cites the pull request a revert names", () => {
		// `git revert pr 123` states the cause by itself: it names the change being
		// undone. The commit path always read that; the pull-request path demanded a
		// causal phrase no revert sentence carries, so the blame was never attributed.
		const messages = [
			row("assistant", 'Revert "Guard the empty list (#123)" because it broke the credit path.'),
			...bash("git revert abc1234", '[main abc1234] Revert "Guard the empty list (#123)"'),
		];

		const scan = findRegressionEvidence(messages);

		assert.equal(scan.claims_regression, true);
		assert.ok(scan.cited_pull_requests.some((c) => c.number === 123), "the reverted pull request is cited");
	});

	it("cites a pull request written as PR 1234, without a hash", () => {
		const messages = [
			row("assistant", "The deploy broke: the failure was introduced by PR 1234, which removed the guard."),
			...bash("git commit -am 'fix: restore the guard'", "[main abc1234] fix"),
		];

		const scan = findRegressionEvidence(messages);

		assert.deepEqual(scan.cited_pull_requests.map((p) => p.number), [1234]);
	});

	it("is deterministic across runs", () => {
		const messages = [
			row("assistant", "A regression caused by #612 broke the deploy."),
			...bash("git commit -am 'fix: restore'", "[main abc1234] fix"),
		];

		const a = findRegressionEvidence(messages);
		const b = findRegressionEvidence(messages);

		assert.deepEqual(a, b);
	});

	it("returns no claim for an empty session", () => {
		const scan = findRegressionEvidence([], DEFAULT_CONFIG);
		assert.equal(scan.claims_regression, false);
		assert.deepEqual(scan.signals_fired, []);
	});
});

describe("cross-repository citations", () => {
	// A cross-repository reference is first class: the claim carries the repository, so the
	// attribution pass resolves it against that repository instead of guessing by number.
	const cite = (text: string) => {
		const out = findRegressionEvidence(
			[
				...bash("git commit -m fix", "[main abc1234] fix"),
				row("assistant", text),
			],
			DEFAULT_CONFIG,
		);
		return out.claims_regression ? out.cited_pull_requests : [];
	};

	it("reads owner/repo#123 as that repository's pull request", () => {
		const prs = cite("Regressed in acme/widgets#42, which broke retries.");
		assert.equal(prs.length, 1);
		assert.equal(prs[0]!.number, 42);
		assert.equal(prs[0]!.owner, "acme");
		assert.equal(prs[0]!.repo, "widgets");
	});

	it("reads a full GitHub URL as that repository's pull request", () => {
		const prs = cite("Regressed in https://github.com/acme/widgets/pull/42, which broke retries.");
		assert.equal(prs.length, 1);
		assert.equal(prs[0]!.number, 42);
		assert.equal(prs[0]!.owner, "acme");
		assert.equal(prs[0]!.repo, "widgets");
		assert.equal(prs[0]!.host, "github.com");
	});

	it("keeps a bare number bare, so the unique-repository rule still applies to it", () => {
		const prs = cite("Regressed in #42, which broke retries.");
		assert.equal(prs.length, 1);
		assert.equal(prs[0]!.number, 42);
		assert.equal(prs[0]!.owner, undefined);
	});

	it("reads the same number in two repositories as two citations, not one", () => {
		const prs = cite("Regressed in acme/widgets#42 and in beta/gadgets#42, both broke retries.");
		const seen = prs.map((p) => `${p.owner}/${p.repo}#${p.number}`).sort();
		assert.deepEqual(seen, ["acme/widgets#42", "beta/gadgets#42"]);
	});
});

describe("a citation behind the word 'commit' or 'PR' is still the cure", () => {
	// The verb used to sit immediately beside the citation, so the noun between them hid the
	// phrase and the repair was recorded as the cause. Both spellings are live in the corpus.
	it("does not blame the commit that fixed the defect", () => {
		const out = findRegressionEvidence(
			[
				row("assistant", "The regression caused by abc1234 was fixed in commit def5678."),
				...bash("git commit -m fix", "[main def5678] fix"),
			],
			DEFAULT_CONFIG,
		);
		assert.deepEqual(out.cited_commits.filter((c) => c.sha === "def5678"), [], "def5678 is the cure");
		// Both halves: a detector that cites no commit at all would also pass the line above.
		assert.ok(out.cited_commits.some((c) => c.sha === "abc1234"), "the cause is cited");
	});

	it("does not blame the pull request that fixed the defect", () => {
		const out = findRegressionEvidence(
			[
				row("assistant", "The 403 was caused by a missing header and was fixed in PR #2274."),
				...bash("git commit -m fix", "[main abc1234] fix"),
			],
			DEFAULT_CONFIG,
		);
		assert.deepEqual(out.cited_pull_requests, [], "#2274 is the cure");
	});
});

describe("a revert of a never-worked change is not a regression claim", () => {
	// The revert is the claim, made on the command row; the never-worked statement is on a
	// later prose row. Neither a sentence nor a row comparison can join them — the change they
	// share can, so the cancel is by sha.
	it("cancels the claim when the revert undoes a change that never worked", () => {
		const out = findRegressionEvidence(
			[
				...bash("git revert abc1234", "[main 1a2b3c4] Revert \"add warmup\""),
				row("assistant", "This reverts commit abc1234; the feature never worked."),
			],
			DEFAULT_CONFIG,
		);
		assert.equal(out.claims_regression, false);
		assert.equal(out.never_worked, true);
	});

	it("still files the claim when the reverted change worked and then broke", () => {
		const out = findRegressionEvidence(
			[
				...bash("git revert abc1234", "[main 1a2b3c4] Revert \"add warmup\""),
				row("assistant", "This reverts commit abc1234, which broke retries for every tenant."),
			],
			DEFAULT_CONFIG,
		);
		assert.equal(out.claims_regression, true);
	});

	it("does not cancel on a never-worked note about a different change", () => {
		const out = findRegressionEvidence(
			[
				...bash("git revert abc1234", "[main 1a2b3c4] Revert \"add warmup\""),
				row("assistant", "This reverts commit abc1234, which broke retries. Separately, the badge feature never worked and was removed in 9988776."),
			],
			DEFAULT_CONFIG,
		);
		assert.equal(out.claims_regression, true, "an unrelated never-worked note must not cancel this claim");
	});
});

describe("a revert with a never-worked note and no sha", () => {
	it("cancels the claim when the prose says the feature never worked", () => {
		// A revert claim needs no causal sentence, so the sentence-scoped flag never sees this.
		const out = findRegressionEvidence(
			[
				...bash("git revert abc1234", "[main 1a2b3c4] Revert \"add warmup\""),
				row("assistant", "Removed it: the feature never worked at all."),
			],
			DEFAULT_CONFIG,
		);
		assert.equal(out.claims_regression, false);
	});
});

describe("a cure named after the citation", () => {
	it("does not cite the pull request that fixed it as a second cause", () => {
		const out = findRegressionEvidence(
			[
				row("assistant", "The 500 was caused by #1234; #1240 fixed it."),
				...bash("git commit -m fix", "[main abc1234] fix"),
			],
			DEFAULT_CONFIG,
		);
		const cited = out.cited_pull_requests.map((p) => p.number);
		assert.ok(cited.includes(1234), "the cause is cited");
		assert.ok(!cited.includes(1240), "#1240 is the cure");
	});
});

describe("a cross-forge URL is one citation", () => {
	it("does not also record the URL as a host-less citation on the default host", () => {
		// The URL pattern claims the span; the hostless owner/repo/pull pattern must not read it
		// again, or one URL became two citations and the second looked like a GitHub blame.
		const out = findRegressionEvidence(
			[
				row("assistant", "Regressed in https://gitlab.com/acme/widgets/pull/42, which broke retries."),
				...bash("git commit -m fix", "[main abc1234] fix"),
			],
			DEFAULT_CONFIG,
		);
		assert.equal(out.cited_pull_requests.length, 1, "one URL is one citation");
		assert.equal(out.cited_pull_requests[0]!.host, "gitlab.com");
	});
});

describe("the commit path applies the rules the pull-request path has", () => {
	it("does not cite a commit the session only read about", () => {
		const out = findRegressionEvidence(
			[
				...bash("git commit -m fix", "[main abc1234] fix"),
				row("toolResult", "Fixes #12: this regression was introduced in commit 9a1b2c3."),
			],
			DEFAULT_CONFIG,
		);
		assert.deepEqual(out.cited_commits, [], "a log or issue body is not the session's own blame");
	});

	it("does not cite the commit that fixed the defect", () => {
		const out = findRegressionEvidence(
			[
				...bash("git commit -m fix", "[main def5678] fix"),
				row("assistant", "The regression was caused by commit abc1234, and commit 9a1b2c3 fixed it."),
			],
			DEFAULT_CONFIG,
		);
		assert.ok(!out.cited_commits.some((c) => c.sha === "9a1b2c3"), "9a1b2c3 is the cure");
		assert.ok(out.cited_commits.some((c) => c.sha === "abc1234"), "the cause is cited");
	});
});

describe("a denial is never a claim", () => {
	const edit = bash("git commit -m tidy", "[main abc1234] tidy");

	it("does not read 'not a regression from #N' as a cause", () => {
		const out = findRegressionEvidence(
			[edit[0]!, edit[1]!, row("assistant", "This is not a regression from #1234; the docs-only PR cannot reach this path.")],
			DEFAULT_CONFIG,
		);
		assert.equal(out.claims_regression, false);
		assert.deepEqual(out.cited_pull_requests, [], "the exonerated pull request must not be cited");
	});

	it("keeps the claim when the session says the failure is not pre-existing", () => {
		const out = findRegressionEvidence(
			[edit[0]!, edit[1]!, row("assistant", "This is not pre-existing: the deploy broke, caused by #1234.")],
			DEFAULT_CONFIG,
		);
		assert.equal(out.claims_regression, true, "asserting a regression is the strongest claim form");
	});

	it("still treats a plain 'pre-existing' as a denial", () => {
		const out = findRegressionEvidence(
			[edit[0]!, edit[1]!, row("assistant", "That failure is pre-existing on main, caused by #99.")],
			DEFAULT_CONFIG,
		);
		assert.equal(out.claims_regression, false);
	});
});

describe("a denial aimed at one change does not discard another", () => {
	it("keeps the claim when the sentence exonerates a different pull request", () => {
		const out = findRegressionEvidence(
			[
				...bash("git commit -m fix", "[main abc1234] fix"),
				row("assistant", "The deploy broke, caused by #1234, not by #1200."),
			],
			DEFAULT_CONFIG,
		);
		assert.equal(out.claims_regression, true, "the sentence names a cause");
		assert.ok(out.cited_pull_requests.some((p) => p.number === 1234), "#1234 is the cause");
		assert.ok(!out.cited_pull_requests.some((p) => p.number === 1200), "#1200 is exonerated");
	});

	it("does not treat 'new defect caused by #N' as never worked", () => {
		const out = findRegressionEvidence(
			[
				...bash("git commit -m fix", "[main abc1234] fix"),
				row("assistant", "This bug is a new defect caused by #1234."),
			],
			DEFAULT_CONFIG,
		);
		assert.equal(out.claims_regression, true);
		assert.equal(out.never_worked, false);
	});
});

describe("an upstream aside does not discard our own citation", () => {
	it("keeps the claim and the citation when the trailer mentions a tracker", () => {
		const out = findRegressionEvidence(
			[
				...bash("git commit -m fix", "[main abc1234] fix"),
				row("assistant", "The deploy broke, caused by #1234 — tracked in bug 5678."),
			],
			DEFAULT_CONFIG,
		);
		assert.equal(out.claims_regression, true, "the sentence names our own change");
		assert.ok(out.cited_pull_requests.some((p) => p.number === 1234), "#1234 is cited");
	});

	it("still treats a cause named as upstream as not ours", () => {
		const out = findRegressionEvidence(
			[
				...bash("git commit -m fix", "[main abc1234] fix"),
				row("assistant", "The crash was caused by the upstream runtime, not our change."),
			],
			DEFAULT_CONFIG,
		);
		assert.equal(out.claims_regression, false);
	});
});

describe("a change named by number outranks an upstream aside", () => {
	it("counts a bare #1234 as our change even when the sentence says upstream", () => {
		const out = findRegressionEvidence(
			[
				...bash("git commit -m fix", "[main abc1234] fix"),
				row("assistant", "The deploy broke, caused by #1234 in the upstream runtime."),
			],
			DEFAULT_CONFIG,
		);
		// The exemption itself must fire here: an upstream word matches, and the number is
		// the only evidence of ownership. A number pattern that cannot match a bare "#1234"
		// leaves this false, whatever else the sentence says.
		assert.equal(out.claims_regression, true);
		assert.ok(out.cited_pull_requests.some((p) => p.number === 1234));
	});

	it("keeps a citation when an earlier sentence is the one blaming upstream", () => {
		const out = findRegressionEvidence(
			[
				...bash("git commit -m fix", "[main abc1234] fix"),
				row(
					"assistant",
					"The crash was in the upstream runtime. The deploy broke, caused by #1234.",
				),
			],
			DEFAULT_CONFIG,
		);
		assert.equal(out.claims_regression, true);
		assert.ok(
			out.cited_pull_requests.some((p) => p.number === 1234),
			"the citation sits in a sentence of its own",
		);
	});
});
