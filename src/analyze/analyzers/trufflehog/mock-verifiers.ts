/**
 * Mock credential verifiers for tests — the deterministic stand-in half of the
 * verifier seam, exactly as `../mock-llm.ts` stands in for `../pi-llm.ts`.
 *
 * No network, no timers, no nondeterminism: the outcome for a candidate value
 * is whatever the test scripted. Every verification call is recorded so tests
 * can assert on which values were probed, by which verifier, with what
 * timeout — and, critically, that the raw credential only ever reached the
 * verifier that owns its provider shape.
 */

import type { CredentialVerifier, VerificationOutcome } from "./verifiers.js";

/** One recorded verification call. */
export interface MockVerifierCall {
	verifierId: string;
	/** The candidate value the verifier was handed (the mock records it; production must not persist it). */
	value: string;
	timeoutMs: number;
}

export interface MockVerifierOptions {
	/**
	 * Map a candidate value to its scripted outcome. Takes precedence over
	 * `fallback`. Keys are exact values, so tests build their synthetic tokens
	 * and script outcomes for them directly.
	 */
	outcomes?: Record<string, VerificationOutcome>;
	/** Outcome for values not found in `outcomes`. */
	fallback?: VerificationOutcome;
	/**
	 * Restrict the mock to one verifier id (default `"mock-verifier"`). Tests
	 * that need several verifiers create several mocks.
	 */
	id?: string;
	/** The value-shape this mock claims (`appliesTo`). Defaults to matching everything. */
	appliesTo?: string;
}

export interface MockVerifier extends CredentialVerifier {
	/** All calls received, in order. */
	calls: MockVerifierCall[];
}

/** Create a deterministic mock verifier. */
export function createMockVerifier(opts: MockVerifierOptions = {}): MockVerifier {
	const id = opts.id ?? "mock-verifier";
	const calls: MockVerifierCall[] = [];
	return {
		id,
		label: `Mock verifier (${id})`,
		appliesTo: opts.appliesTo ?? "",
		calls,
		async verify(value: string, timeoutMs: number): Promise<VerificationOutcome> {
			calls.push({ verifierId: id, value, timeoutMs });
			const scripted = opts.outcomes?.[value] ?? opts.fallback;
			if (!scripted) {
				throw new Error(
					`mock-verifier(${id}): no scripted outcome for candidate — tests must script every value they expect to be verified`,
				);
			}
			return scripted;
		},
	};
}
