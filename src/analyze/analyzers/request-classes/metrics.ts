import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_USER_ROLE, LIMIT_VERSIONS } from "../../metrics/limits.js";

export const metrics: MetricDefinition[] = [
	{
		id: "request-classes.request-class",
		name: "Request class",
		definition: "A class of request that a model named in its own words for one session, with the requests that belong to it. The vocabulary of classes is the finding, so the class names have no fixed list.",
		measurement: "inferred",
		unit: "requests per class",
		denominator: "classified requests: the requests sent to the model, capped per session",
		limitations: [
			"The model names its classes with no taxonomy supplied, so class names differ between sessions and between models. Counts per name compare only inside one session until a person groups the names.",
			"A request may belong to several classes. Spend attributed through classes, as in token-units, is divided evenly among them.",
			"Requests beyond the cap are not sent and get no class. The node stores how many were truncated, and truncated spend drops out of class totals.",
			"Each request is cut to a character cap before it is sent, so a long request is classified from its start.",
			LIMIT_USER_ROLE,
			LIMIT_VERSIONS,
		],
	},
];
