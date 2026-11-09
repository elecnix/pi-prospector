import type { MetricDefinition } from "../../metrics/types.js";

export const metrics: MetricDefinition[] = [
	{
		id: "regression-attribution.attributed-blame",
		name: "Attributed blame",
		definition:
			"A blamed pull request resolved to the session that opened it, giving a walkable path from the repair to the change that caused the defect.",
		measurement: "rule-based",
		unit: "blamed pull requests per session",
		denominator: "sessions with a regression claim",
		values: [
			{ value: "resolved", meaning: "A local session is recorded as having opened the blamed pull request." },
			{ value: "unresolved", meaning: "No local session opened it, or the number is ambiguous. Recorded, never guessed." },
			{ value: "self_inflicted", meaning: "Every resolved blamed pull request was opened by the repairing session itself." },
		],
		limitations: [
			"Joins on the pull request number within one repository only. A number recorded in two repositories is left unresolved rather than assigned to either.",
			"Coverage is bounded by what the pull request analyzers recorded: a pull request opened outside an indexed session cannot be resolved, so an unresolved blame is not evidence that no author exists.",
			"A commit sha is never joined to a session. A sha in a transcript rarely carries its repository, so that join would manufacture an author.",
			"A repository-qualified citation resolves against that repository. A bare number cannot be disambiguated across repositories: it is refused when the number is recorded in two, but when it exists in the blamed repository and in another that was never indexed, it resolves to the indexed one. The fix is a repository in the claim, and a transcript does not reliably carry one for a bare number.",
			"Whether the blamed change really introduced the defect is not decided here; it needs the tree.",
		],
	},
];
