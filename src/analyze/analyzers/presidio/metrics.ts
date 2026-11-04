import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_HARNESS } from "../../metrics/limits.js";
import { LIMIT_ALLOWLIST, LIMIT_CAPS, LIMIT_REDACTED, LIMIT_SCAN_FIELDS } from "../../metrics/security.js";

export const metrics: MetricDefinition[] = [
	{
		id: "presidio.pii-finding",
		name: "Personal data findings",
		definition: "A string in a session transcript that a recognizer matches as an entity of personal data and that passes the validator, the score floor and the allowlist.",
		measurement: "rule-based",
		unit: "findings per session",
		denominator: "none: the node stores the count and the number of messages scanned",
		limitations: [
			"The recognizers are patterns with checksum validators (a card number must pass the Luhn check, an IBAN the mod-97 check, a social security number its validity rules). A value that fails its validator is dropped and counted as invalid, so a mistyped real number goes undetected.",
			"Named-entity recognition is not part of the method. Names of people, organisations and places are never found, so the count covers structured identifiers only.",
			"A score floor removes low-confidence matches, and a deny list flags a value whatever its score. Both are config, so a change moves the count with no change in the transcript.",
			"A match that a longer overlapping match contains is dropped, so a card number inside an IBAN counts once.",
			"A value can be an example, a test fixture or public data, and the scanner can't tell. A finding is a lead to check.",
			LIMIT_REDACTED,
			LIMIT_SCAN_FIELDS,
			LIMIT_CAPS,
			LIMIT_ALLOWLIST,
			LIMIT_HARNESS,
		],
	},
	{
		id: "presidio.entity-type",
		name: "Personal data entity type",
		definition: "The entity label of the recognizer that matched a finding.",
		measurement: "rule-based",
		unit: "findings per entity type",
		denominator: "findings of the session",
		values: [
			{ value: "EMAIL_ADDRESS", meaning: "An email address." },
			{ value: "PHONE_NUMBER", meaning: "A telephone number." },
			{ value: "IP_ADDRESS", meaning: "An IPv4 or IPv6 address, with private and low-sensitivity addresses judged lower." },
			{ value: "CREDIT_CARD", meaning: "A payment card number that passes the Luhn check." },
			{ value: "IBAN_CODE", meaning: "An international bank account number that passes the mod-97 check." },
			{ value: "US_SSN", meaning: "A United States social security number that passes the validity rules." },
			{ value: "POSTAL_CODE", meaning: "A postal code." },
			{ value: "COORDINATES", meaning: "A latitude and longitude pair within valid ranges." },
		],
		limitations: [
			"Formats are those of the listed recognizers. A telephone number or postal code in an unlisted national format goes undetected, and a numeric string in another use can match.",
			"The entity list is closed, so a kind of personal data with no recognizer has no count at all.",
		],
	},
	{
		id: "presidio.pii-severity",
		name: "Personal data severity",
		definition: "The severity that the recognizer declares for a finding, on a scale that adds low to the secret scanners' scale.",
		measurement: "rule-based",
		unit: "findings per severity",
		denominator: "findings of the session",
		values: [
			{ value: "low", meaning: "Data of low sensitivity: a postal code, or an address a recognizer judged low-sensitivity." },
			{ value: "medium", meaning: "Contact or location data: an email address, a telephone number, an IP address or coordinates." },
			{ value: "high", meaning: "A government or bank identifier: a social security number or an IBAN." },
			{ value: "critical", meaning: "A payment card number." },
		],
		limitations: [
			"The severity belongs to the recognizer and not to the value, so it doesn't change with the context of the finding.",
		],
	},
];
