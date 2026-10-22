/**
 * Term specificity: how much a term's presence tells you (issue #321).
 *
 * The lexicon needs to keep background vocabulary out of the ranking without a
 * hand-written list of any language's function words. Document frequency is
 * that property: a word in most turns cannot distinguish one turn from another.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	DEFAULT_MAX_DOCUMENT_SHARE,
	MIN_DOCUMENTS,
	termSpecificity,
} from "../../src/analyze/term-specificity.js";

describe("term specificity", () => {
	it("gives a term carried by a single turn full weight", () => {
		assert.equal(termSpecificity(1, 1000), 1 - 1 / 1000 / DEFAULT_MAX_DOCUMENT_SHARE);
		assert.ok(termSpecificity(1, 1000) > 0.9, "a rare term keeps nearly all its weight");
	});

	it("prices a background term at exactly zero", () => {
		// The failure this replaces: `do` fired on a large share of a real corpus's
		// turns and dominated the ranking on volume.
		assert.equal(termSpecificity(400, 1000), 0, "a term in 40% of turns is background");
		assert.equal(termSpecificity(1000, 1000), 0, "a term in every turn is background");
	});

	it("reaches zero at the cut, not merely near it", () => {
		// A small positive price would still let volume win, so the cut must be a
		// genuine zero rather than a decay.
		const atCut = termSpecificity(Math.ceil(1000 * DEFAULT_MAX_DOCUMENT_SHARE), 1000);
		assert.equal(atCut, 0);
		assert.ok(termSpecificity(Math.floor(1000 * DEFAULT_MAX_DOCUMENT_SHARE) - 1, 1000) > 0);
	});

	it("falls monotonically as a term becomes more common", () => {
		const shares = [1, 10, 25, 50, 99].map((n) => termSpecificity(n, 1000));
		for (let i = 1; i < shares.length; i++) {
			assert.ok(shares[i]! <= shares[i - 1]!, "a more common term is never worth more");
		}
	});

	it("refuses to price a corpus too small for a share to mean anything", () => {
		// One turn in three is not background by any useful reading; a young corpus
		// over-reports rather than going silent.
		assert.equal(termSpecificity(1, 1), 1);
		assert.equal(termSpecificity(1, 3), 1);
		assert.equal(termSpecificity(MIN_DOCUMENTS - 1, MIN_DOCUMENTS - 1), 1);
	});

	it("prices nothing when the cut is disabled", () => {
		assert.equal(termSpecificity(1000, 1000, 0), 1, "a zero cut must not silence the lexicon");
		assert.equal(termSpecificity(1000, 1000, -1), 1);
	});

	it("treats a term that never fired as fully specific", () => {
		assert.equal(termSpecificity(0, 1000), 1);
	});
});
