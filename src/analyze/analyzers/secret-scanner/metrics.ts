import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_CAPS, LIMIT_DETECTION, LIMIT_REDACTED, LIMIT_SCAN_FIELDS, LIMIT_ALLOWLIST, secretScannerMetrics } from "../../metrics/security.js";
import { LIMIT_HARNESS } from "../../metrics/limits.js";

const BASE = secretScannerMetrics("secret-scanner", "secret-scanner", [
	"The method reads container and filesystem artifacts out of the transcript (Dockerfiles, compose environment blocks, .env entries, build and CI logs, shell exports), splits them into key and value candidates, and matches the values against the catalogue families plus a name-and-shape check. A secret outside one of those artifacts is out of reach.",
	"A value must look like a credential (long enough, one token, letters and digits). A short secret, or one in plain words, goes undetected.",
	"A masked value, an interpolation such as a reference to another variable, a placeholder and a filesystem path are not reported.",
]);

export const metrics: MetricDefinition[] = [
	...BASE,
	{
		id: "secret-scanner.artifact-kind",
		name: "secret-scanner artifact kind",
		definition: "The kind of artifact context a leak was extracted from.",
		measurement: "rule-based",
		unit: "leaks per artifact kind",
		denominator: "leaks of the session",
		values: [
			{ value: "dockerfile", meaning: "An ENV or ARG line of a Dockerfile." },
			{ value: "compose", meaning: "An environment entry of a compose file." },
			{ value: "dotenv", meaning: "A line of an .env file." },
			{ value: "build-log", meaning: "A line of a build log." },
			{ value: "ci-log", meaning: "A line of a CI log." },
			{ value: "shell-export", meaning: "A shell export or assignment." },
		],
		limitations: [
			"The kind comes from the shape of the surrounding text and not from a file name, so a pasted fragment can read as the wrong kind.",
			LIMIT_DETECTION,
			LIMIT_REDACTED,
			LIMIT_SCAN_FIELDS,
			LIMIT_CAPS,
			LIMIT_ALLOWLIST,
			LIMIT_HARNESS,
		],
	},
];
