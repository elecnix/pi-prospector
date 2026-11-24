import type { FingerprintContributor } from "../../../fingerprint/contributor.js";
import { PROMPT_KIND_KEY, PROMPT_KINDS } from "../prompt-form/question.js";

/**
 * The questions whose answers a fingerprint may break down, by stored key. A
 * question registered by a locally authored analyzer counts under `other`, and
 * so does its answer, because its options are not reviewed as shareable.
 */
const QUESTIONS = [PROMPT_KIND_KEY];
const CHOICES = [...PROMPT_KINDS];

/**
 * The answers a decision model gave about the messages it was asked about. The
 * message and its id are never read. A model answered, so inferred.
 */
export const messageAnswersFingerprint: FingerprintContributor = {
	def: {
		id: "messageAnswers",
		label: "Message answers",
		description:
			"Messages a decision model was asked about and its answers, by question and by the option it chose, in any language. Every answer counts, whatever its confidence: the prompt-kind section applies a confidence floor and this one does not. A message is asked about only when its origin is settled, and only with a decision model configured: without one the section is withheld. The sessions measured are those with an answered message.",
		kind: "inferred",
		analyzers: ["message-answers"],
		measures: [
			{ kind: "total", id: "messagesAsked", metric: "message-answers.answer", field: "asked" },
			{ kind: "groups", id: "byAnswer", metric: "message-answers.answer", dimensions: { question: QUESTIONS, choice: CHOICES } },
		],
	},
	async read(ctx) {
		const messages = await ctx.nodes("message-answers", {});
		const answers = await ctx.items("message-answers", "$.answers", { question: "#key", choice: "$.choice" });
		const reviewed = answers.map((a) => (QUESTIONS.includes(String(a["question"])) || typeof a["choice"] !== "string" ? a : { ...a, choice: "other" }));
		return { measured: messages.map((m) => String(m["session"])), rows: [...messages.map((m) => ({ ...m, asked: 1 })), ...reviewed] };
	},
};
