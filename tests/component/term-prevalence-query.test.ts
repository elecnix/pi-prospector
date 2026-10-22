/**
 * The prevalence query keys signals the way the reader looks them up.
 *
 * `hitSignal` lowercases a lexicon signal, because a term is a corpus-wide key
 * and `Do` and `do` are one word. The prevalence query must agree: if it grouped
 * by the raw stored spelling, a signal stored with any uppercase character would
 * miss in that lookup, the reader would treat the term as having fired on no
 * turns, and a background word would keep full weight on every read — silently,
 * because a miss and a genuinely rare word are indistinguishable.
 *
 * The tokeniser lowercases today, so this is a guard on a contract rather than a
 * bug that shows up in a fresh corpus. It is exactly the kind of contract that
 * breaks when a new write path arrives, and the failure mode is invisible.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tempDb, insertSession } from "./helpers.js";
import { insertNode } from "../../src/db/analysis-queries.js";
import { termPrevalence } from "../../src/db/term-prevalence.js";

const NOW = "2026-01-01T00:00:00.000Z";

async function insert(
	db: Parameters<typeof insertNode>[0],
	args: { id: string; analyzerId: string; content: unknown; createdAt?: string },
): Promise<void> {
	await insertNode(db, {
		id: args.id,
		sessionId: "s1",
		analyzerId: args.analyzerId,
		analyzerVersionId: "v",
		configId: "c",
		runId: null,
		nodeKind: "metric",
		contentJson: JSON.stringify(args.content),
		sourceSetHash: `src-${args.id}`,
		inputKey: `in-${args.id}`,
		outputKey: `out-${args.id}`,
		createdAt: args.createdAt ?? NOW,
	});
}

describe("term prevalence", () => {
	it("groups a signal by the spelling the reader looks it up under", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "s1");

			// Three analysed turns.
			for (const i of [0, 1, 2]) {
				await insert(db, {
					id: `core-${i}`,
					analyzerId: "turn-pair-core",
					content: { user_message_id: `msg-${i}` },
				});
			}

			// The same word, stored two ways, on two turns. A term is a corpus-wide
			// key: these are one word and must count as two hit documents.
			await insert(db, {
				id: "hit-a",
				analyzerId: "turn-frustration",
				content: { user_message_id: "msg-0", signal_source: "lexicon", signal: "Do" },
			});
			await insert(db, {
				id: "hit-b",
				analyzerId: "turn-frustration",
				content: { user_message_id: "msg-1", signal_source: "lexicon", signal: "do" },
			});
			// A marker is not vocabulary and must not appear among the terms.
			await insert(db, {
				id: "hit-c",
				analyzerId: "turn-frustration",
				content: { user_message_id: "msg-2", signal_source: "paralinguistic", signal: "shouting" },
			});

			const prevalence = await termPrevalence(db, "turn-pair-core", "turn-frustration");

			assert.equal(prevalence.documents, 3, "three analysed turns");
			assert.equal(
				prevalence.hitDocuments.get("do"),
				2,
				`both spellings are the same signal: ${
					[...prevalence.hitDocuments.entries()].map(([k, v]) => `${k}=${v}`).join(", ")
				}`,
			);
			assert.equal(prevalence.hitDocuments.has("Do"), false, "no second bucket under the raw spelling");
			assert.equal(prevalence.hitDocuments.has("shouting"), false, "a marker has no spelling to price");
		} finally {
			await close();
		}
	});
});
