/**
 * The decision-model path of verification-commands (#280).
 *
 * A shell command either verifies the working tree or it does not, and the
 * shipped regex list cannot say which for a project's own gate script. One
 * Choice asks the question for a single command, and its options carry the
 * distinction a regex cannot give: a `full` check (the whole suite, the gate
 * script, the build) and a `narrow` check (one test file, one linted
 * package) behave differently, because a full run that a later edit threw
 * away is worth minutes while a narrow one is worth seconds.
 *
 * The command line goes to the model in full, so the README says so.
 */

import { shortHash, canonicalJson } from "../../input-hash.js";
import { answerOf, type DecisionQuestion, type DecisionResponse } from "../../decision-model.js";

/** What a command does to the working tree, as the model judges it. */
export const VERIFICATION_VERDICTS = ["full", "narrow", "not_verification"] as const;
export type VerificationVerdict = (typeof VERIFICATION_VERDICTS)[number];

export const VERIFICATION_DECISION_QUESTIONS: Record<string, DecisionQuestion> = {
	verifies: {
		type: "choice",
		instructions: {
			question: "Does the shell command `command` check the working tree?",
			focus:
				"Judge the command line alone, in the project it ran in. A command verifies when it tests, lints, " +
				"type-checks, builds, or runs the project's own gate script. A command that reads, lists, edits, " +
				"installs, or starts a server does not verify, however long it takes.",
		},
		criteria: {
			full: {
				what: "Checks the whole project: the full test suite, the project's gate or CI script, a full build, a full type check",
				not_for: "A check that covers one file or one package only",
				examples: ["npm test", "make ci", "tools/ci/run-gates.sh", "go build ./..."],
			},
			narrow: {
				what: "Checks part of the project: one test file, one linted package, a type check over changed files",
				not_for: "A check that covers the whole project",
				examples: ["pytest tests/test_dates.py", "eslint src/date.ts", "tsc --noEmit src/one-file.ts"],
			},
			not_verification: {
				what: "Does not check the tree: reads it, lists it, edits it, installs dependencies, starts a server, or runs a deployment",
				not_for: "Any command that reports whether the tree is correct",
				examples: ["git status", "cat package.json", "npm install", "docker compose up", "curl https://example.test"],
			},
		},
	},
};

export const VERIFICATION_DECISION_QUESTIONS_HASH = shortHash(`verification-decision(${canonicalJson(VERIFICATION_DECISION_QUESTIONS)})`);

/** The model's verdict for one command, with the evidence behind it. */
export interface VerificationDecision {
	verdict: VerificationVerdict;
	confidence: number;
	/** The distribution over the three options, stored as the evidence. */
	probabilities: Record<string, number>;
}

/**
 * Read the verdict out of a decision response.
 *
 * A verdict is cached corpus-wide, so a response without one is an error
 * rather than a default: a guessed "not_verification" would silently mark a
 * project's gate script as unverified. An answer outside the three options is
 * the same kind of fault, so it is rejected rather than stored.
 */
export function parseVerificationDecision(response: DecisionResponse): VerificationDecision {
	const answer = answerOf(response, "verifies", "choice");
	if (!VERIFICATION_VERDICTS.includes(answer.choice as VerificationVerdict)) {
		throw new Error(
			`Decision model returned verdict '${answer.choice}', which is not one of ${VERIFICATION_VERDICTS.join(", ")}.`,
		);
	}
	return {
		verdict: answer.choice as VerificationVerdict,
		confidence: answer.probabilities[answer.choice] ?? answer.confidence,
		probabilities: answer.probabilities,
	};
}
