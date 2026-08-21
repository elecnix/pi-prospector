/**
 * Presidio-method PII recognizers: the pattern + validator + entity-type +
 * score registry.
 *
 * Licence (issue #173): Microsoft Presidio is Apache-2.0. Only its *method*
 * is implemented here — pattern recognizers with checksum validators,
 * confidence scores, and per-entity allow/deny lists. No upstream code or
 * rule text was vendored or ported. Reference implementation studied:
 * `microsoft/presidio` (Apache-2.0), 2.2 series.
 *
 * **NER is deferred** (issue option b): named-entity detection (person names,
 * addresses) needs a model, which would break "deterministic, no LLM". The
 * registry below is deliberately shaped so a future NER recognizer can be
 * added through the LLM seam (a recognizer whose "pattern" stage is a
 * deterministic candidate gate and whose validator stage is a structured
 * model pass over escalated candidates only) without reshaping config
 * identity: a recognizer is an id + entity type + score behaviour, and the
 * config surface speaks in those ids.
 *
 * Presidio's key precision trick is honoured strictly: where a format has a
 * checksum, the checksum validator is **mandatory** — a Luhn-failing credit
 * card or a mod-97-failing IBAN is *not a finding*, not a low-confidence
 * finding. Formats with only structural validity rules (US SSN area/group/
 * serial) are soft-validated: a failure lowers the score instead of dropping
 * the candidate, because the rules exclude impossible values, not typos.
 */

// ──────────────────────────── entity types ────────────────────────────

/** Presidio-style entity labels emitted by the shipped recognizers. */
export const PII_ENTITY_TYPES = [
	"EMAIL_ADDRESS",
	"PHONE_NUMBER",
	"IP_ADDRESS",
	"CREDIT_CARD",
	"IBAN_CODE",
	"US_SSN",
	"POSTAL_CODE",
	"COORDINATES",
] as const;
export type PiiEntityType = (typeof PII_ENTITY_TYPES)[number];

/** Finding severity. PII extends the secret detectors' scale with `low`. */
export const PII_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type PiiSeverity = (typeof PII_SEVERITIES)[number];

/** Rank used to order severities (not currently compared against a floor; scores do that job). */
export const PII_SEVERITY_RANK: Record<PiiSeverity, number> = {
	low: 1,
	medium: 2,
	high: 3,
	critical: 4,
};

// ──────────────────────────── validators ────────────────────────────

/**
 * Luhn checksum (credit cards). The digits are summed right-to-left, doubling
 * every second digit; valid when the total is a multiple of 10.
 */
export function luhnValid(value: string): boolean {
	const digits = value.replace(/\D/g, "");
	if (digits.length < 13 || digits.length > 19) return false;
	let sum = 0;
	let double = false;
	for (let i = digits.length - 1; i >= 0; i--) {
		let d = digits.charCodeAt(i) - 48;
		if (double) {
			d *= 2;
			if (d > 9) d -= 9;
		}
		sum += d;
		double = !double;
	}
	return sum % 10 === 0;
}

/**
 * IBAN mod-97 check (ISO 13616). Rearrange: first four characters move to the
 * end; letters become numbers (A=10 … Z=35); the whole must be ≡ 1 mod 97.
 */
export function ibanMod97Valid(value: string): boolean {
	const s = value.replace(/[ -]/g, "").toUpperCase();
	if (!/^[A-Z]{2}\d{2}[A-Z0-9]+$/.test(s)) return false;
	if (s.length < 15 || s.length > 34) return false;
	const rearranged = s.slice(4) + s.slice(0, 4);
	let remainder = 0;
	for (const ch of rearranged) {
		const code = ch >= "A" && ch <= "Z" ? (ch.charCodeAt(0) - 55).toString() : ch;
		for (const d of code) {
			remainder = (remainder * 10 + (d.charCodeAt(0) - 48)) % 97;
		}
	}
	return remainder === 1;
}

/** US SSN structural validity: area 001–899 excluding 666, group 01–99, serial 0001–9999. */
export function ssnValid(value: string): { valid: boolean; area: string; group: string; serial: string } {
	const m = /^(\d{3})[- ](\d{2})[- ](\d{4})$/.exec(value.trim());
	if (!m) return { valid: false, area: "", group: "", serial: "" };
	const area = m[1]!;
	const group = m[2]!;
	const serial = m[3]!;
	const valid =
		Number(area) >= 1 &&
		Number(area) <= 899 &&
		area !== "666" &&
		Number(group) >= 1 &&
		Number(serial) >= 1;
	return { valid, area, group, serial };
}

/** IPv4 private/reserved ranges (RFC 1918 + loopback + link-local + CGNAT). */
export function isPrivateIPv4(value: string): boolean {
	const parts = value.split(".").map((p) => Number(p));
	if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
	const [a, b] = parts as [number, number, number, number];
	if (a === 10) return true; // 10/8
	if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
	if (a === 192 && b === 168) return true; // 192.168/16
	if (a === 127) return true; // loopback
	if (a === 169 && b === 254) return true; // link-local
	if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
	if (a === 0) return true; // this-network
	if (a >= 224) return true; // multicast + reserved
	return false;
}

/** IPv6 loopback / unique-local (fc00::/7) / link-local (fe80::/10) / documentation (2001:db8::/32). */
export function isLowSensitivityIPv6(value: string): boolean {
	const s = value.toLowerCase();
	if (s === "::1") return true;
	if (s.startsWith("fc") || s.startsWith("fd")) return true;
	if (s.startsWith("fe8") || s.startsWith("fe9") || s.startsWith("fea") || s.startsWith("feb")) return true;
	if (s.startsWith("2001:db8")) return true;
	return false;
}

/** Geographic coordinate range validity: |lat| ≤ 90, |lon| ≤ 180. */
export function coordinatesValid(lat: number, lon: number): boolean {
	return Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

// ──────────────────────────── recognizer registry ────────────────────────────

/** How a recognizer judges one candidate value. */
export interface RecognizerJudgement {
	/** Confidence 0..1, Presidio-style. */
	score: number;
	/** Finding severity for this value. */
	severity: PiiSeverity;
	/** True when the recognizer's validator (if any) confirmed the value. */
	validated: boolean;
}

export interface PiiRecognizer {
	/** Kebab-case recognizer id — the config-facing identifier. */
	id: string;
	/** Presidio-style entity label carried on findings. */
	entityType: PiiEntityType;
	/** Human-readable label. */
	label: string;
	/** Score when the value is unvalidated (validators disabled, or no validator). */
	baseScore: number;
	/** Score when the value passes validation. Equals baseScore when there is no validator. */
	validatedScore: number;
	/**
	 * Checksum-style validator: when config enables validators, a failure means
	 * **not a finding** (Presidio's key precision trick). Absent for formats
	 * with no checksum.
	 */
	checksum?: (value: string) => boolean;
	/**
	 * Structural validity rules without a checksum (US SSN): a failure lowers
	 * the score to `invalidScore` instead of dropping the candidate.
	 */
	softValidate?: (value: string) => boolean;
	/** Score for a soft-validation failure. */
	invalidScore?: number;
	/**
	 * Low-sensitivity classification (private IP ranges): the value stays a
	 * finding but at a reduced score/severity, since e.g. RFC1918 addresses
	 * are not routable public identifiers.
	 */
	classifyLow?: (value: string) => boolean;
	/** Score/severity for a low-sensitivity classification. */
	lowScore?: number;
	lowSeverity?: PiiSeverity;
	/** Normal severity. */
	severity: PiiSeverity;
	/** Anchored patterns. Must carry the `g` flag; the whole match is the value. */
	patterns: RegExp[];
}

/** Judgement for one candidate. Returns undefined when the candidate is dropped (failed mandatory checksum). */
export function judge(rec: PiiRecognizer, value: string, validatorsEnabled: boolean): RecognizerJudgement | undefined {
	if (rec.checksum) {
		if (!validatorsEnabled) {
			return { score: rec.baseScore, severity: rec.severity, validated: false };
		}
		if (!rec.checksum(value)) return undefined;
		return { score: rec.validatedScore, severity: rec.severity, validated: true };
	}
	if (rec.softValidate) {
		if (!validatorsEnabled) {
			return { score: rec.baseScore, severity: rec.severity, validated: false };
		}
		return rec.softValidate(value)
			? { score: rec.validatedScore, severity: rec.severity, validated: true }
			: { score: rec.invalidScore ?? rec.baseScore, severity: rec.severity, validated: false };
	}
	if (rec.classifyLow?.(value)) {
		return {
			score: rec.lowScore ?? rec.baseScore,
			severity: rec.lowSeverity ?? rec.severity,
			validated: true,
		};
	}
	return { score: rec.validatedScore, severity: rec.severity, validated: true };
}

/**
 * The shipped recognizer registry — Presidio's deterministic pattern layer.
 * Order is stable and load-bearing: candidates are emitted in pattern order,
 * then by index.
 */
export const PII_RECOGNIZERS: readonly PiiRecognizer[] = [
	{
		id: "email-address",
		entityType: "EMAIL_ADDRESS",
		label: "Email address",
		baseScore: 0.5,
		validatedScore: 0.5,
		severity: "medium",
		patterns: [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g],
	},
	{
		id: "phone-number",
		entityType: "PHONE_NUMBER",
		label: "Phone number (international formats)",
		baseScore: 0.4,
		validatedScore: 0.4,
		severity: "medium",
		patterns: [
			// International: leading +country code, then 8–14 digits with the usual
			// separators (spaces, dots, dashes, parentheses).
			/(?<![\d+])\+\d{1,3}(?:[ .()-]*\d){8,14}(?!\d)/g,
			// North American: optional +1, (NNN) or NNN, then NNN-NNNN.
			/(?<!\d)(?:\+1[ .-]?)?(?:\(\d{3}\)[ .-]?|\d{3}[ .-])\d{3}[ .-]?\d{4}(?!\d)/g,
		],
	},
	{
		id: "ip-address",
		entityType: "IP_ADDRESS",
		label: "IP address (public flagged; private RFC1918 low-sensitivity)",
		baseScore: 0.5,
		validatedScore: 0.5,
		severity: "medium",
		classifyLow: (v) => (v.includes(":") ? isLowSensitivityIPv6(v) : isPrivateIPv4(v)),
		lowScore: 0.1,
		lowSeverity: "low",
		patterns: [
			// IPv4 — octet ranges are built into the pattern.
			/(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?![\d.])/g,
			// IPv6 — full form.
			/(?<![:\w])(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}(?![\w:])/g,
			// IPv6 — ::-compressed forms (fe80::1, 2001:db8::1, …).
			/(?<![:\w])(?:[0-9A-Fa-f]{1,4}:){1,7}:(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4}){0,6})?|(?<![:\w])::(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4}){0,6})(?![\w:])/g,
		],
	},
	{
		id: "credit-card",
		entityType: "CREDIT_CARD",
		label: "Credit card number (Luhn-validated)",
		baseScore: 0.3,
		validatedScore: 1,
		severity: "critical",
		checksum: luhnValid,
		patterns: [
			// 13–19 digits in groups of 1–4 separated by spaces or dashes; the
			// Luhn validator does the real work of rejecting non-card digit runs.
			/(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g,
		],
	},
	{
		id: "iban-code",
		entityType: "IBAN_CODE",
		label: "IBAN (mod-97 validated)",
		baseScore: 0.3,
		validatedScore: 1,
		severity: "high",
		checksum: ibanMod97Valid,
		patterns: [
			// Country code + check digits + BBAN, optionally space-grouped in fours.
			/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7} ?[A-Z0-9]{1,4}(?![A-Z0-9])/g,
		],
	},
	{
		id: "us-ssn",
		entityType: "US_SSN",
		label: "US Social Security Number (area/group validity rules)",
		baseScore: 0.2,
		validatedScore: 0.9,
		invalidScore: 0.2,
		severity: "high",
		softValidate: (v) => ssnValid(v).valid,
		patterns: [
			// Separators required: NNN-NN-NNNN or NNN NN NNNN. Without them any
			// 9-digit run would match; Presidio's own patterns require context too.
			/(?<!\d)\d{3}[ -]\d{2}[ -]\d{4}(?!\d)/g,
		],
	},
	{
		id: "postal-code",
		entityType: "POSTAL_CODE",
		label: "Postal code (US ZIP)",
		baseScore: 0.3,
		validatedScore: 0.3,
		severity: "low",
		patterns: [
			// US ZIP: 5 digits, optionally ZIP+4. Deliberately low score — bare
			// five-digit numbers are common in session text; the recognizer is
			// cheap to disable via config.
			/(?<!\d)\d{5}(?:-\d{4})?(?!\d)/g,
		],
	},
	{
		id: "coordinates",
		entityType: "COORDINATES",
		label: "Geographic coordinates (lat,long)",
		baseScore: 0.3,
		validatedScore: 0.5,
		severity: "medium",
		// Range check is a hard format validator: out-of-range pairs are not
		// coordinates. Modelled as a checksum so validators-off reports them
		// at base score instead of dropping.
		checksum: (v) => {
			const m = /^(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/.exec(v.trim());
			return m !== null && coordinatesValid(Number(m[1]), Number(m[2]));
		},
		patterns: [
			// Decimal-degree pairs, comma-separated. Requires a decimal point so
			// ordinary integer lists never match.
			/(?<![\w.\-])(-?\d{1,3}\.\d{1,6})\s*,\s*(-?\d{1,3}\.\d{1,6})(?![\w.\-])/g,
		],
	},
];

/** Recognizer ids, for config validation. */
export const PII_RECOGNIZER_IDS: readonly string[] = PII_RECOGNIZERS.map((r) => r.id);
