/**
 * Message questions: the classifier questions analyzers ask about a message.
 *
 * Several analyzers want a small judgement about the same message: what kind of
 * prompt it is, whether it is a greeting, what language it is written in. Asking
 * each one separately sends the message to the decision model once per question.
 * An analyzer instead registers its question here, and the shared
 * `message-answers` analyzer asks every question a message has no answer for in
 * one request, then stores the answers on the message's node. An analyzer that
 * needs an answer declares `message-answers` as a dependency and reads it.
 *
 * A question's identity is its id and its version. Raise the version when the
 * wording or the options change, because a stored answer to the old question
 * must not stand for the new one. The registry is a module-level table so that
 * an analyzer loaded from disk can register next to the built-in ones.
 *
 * Pure functions over an in-memory table: no database.
 */

import { Type, type Static } from "typebox";
import { canonicalJson, shortHash } from "./input-hash.js";
import { DecisionQuestion } from "./decision-model.js";
import { MessageOrigin } from "./message-origin.js";

export const MessageQuestion = Type.Object({
	/** Stable name of the question, unique across analyzers. */
	id: Type.String({ minLength: 1 }),
	/** Raised when the wording or the options change. */
	version: Type.Integer({ minimum: 1 }),
	/** The analyzer that reads the answer. */
	owner: Type.String(),
	/**
	 * The origins of the messages worth asking about. Only a message whose origin a
	 * rule or the model settled as one of these is sent, so a question about what a
	 * person typed never costs a call on a harness notification.
	 */
	origins: Type.Array(MessageOrigin, { minItems: 1 }),
	/**
	 * The question. It judges `message`, the person's own words with pasted and
	 * quoted text and harness blocks cut out.
	 */
	question: DecisionQuestion,
});
export type MessageQuestion = Static<typeof MessageQuestion>;

const registry = new Map<string, MessageQuestion>();

/** The key a question's answer is stored under and sent as: `id.v<version>`. */
export function questionKey(q: Pick<MessageQuestion, "id" | "version">): string {
	return `${q.id}.v${q.version}`;
}

/**
 * Register a question. The same question twice is a no-op, a higher version
 * replaces the registered one, and a different question at the same or a lower
 * version is an error, because two analyzers would otherwise ask for different
 * things under one name.
 */
export function registerMessageQuestion(q: MessageQuestion): void {
	const held = registry.get(q.id);
	if (held) {
		if (canonicalJson(held) === canonicalJson(q)) return;
		if (q.version <= held.version) {
			throw new Error(
				`Message question '${q.id}' is already registered at version ${held.version} with different content. ` +
					`If '${q.owner}' changed it, raise its version.`,
			);
		}
	}
	registry.set(q.id, q);
}

/** Every registered question, in id order. */
export function registeredMessageQuestions(): MessageQuestion[] {
	return [...registry.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The fingerprint of the registered set. It moves when a question is added, removed or re-versioned. */
export function messageQuestionsHash(): string {
	return shortHash(`message-questions(${canonicalJson(registeredMessageQuestions())})`);
}

/** Empty the registry. For tests, which register the questions they need. */
export function resetMessageQuestions(): void {
	registry.clear();
}
