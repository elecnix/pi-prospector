/**
 * The deterministic fold: transcript rows → MITE, per model and per request.
 *
 * De-duplication is the correctness crux. Claude Code writes one JSONL line per
 * content block of a single assistant response, and every one of those lines
 * repeats that response's `usage`. On a real corpus that is 125k rows for 59k
 * API calls, so summing rows overstates Claude tokens by 111%. Calls are folded
 * by `provider_message_id` — the provider's own response id — and counted once.
 * Rows indexed before that column existed carry NULL and fall back to their own
 * row id; `coverage.rows_without_key` states how many, so a reader can see when
 * a number is resting on that fallback.
 *
 * Attribution is per **request segment**: a user turn plus every assistant call
 * that follows it, up to the next user turn. That is the unit a person actually
 * spends — "what did this thing I asked for cost" — and it is the unit the
 * request-classes analyzer labels. Calls made before the first user turn land in
 * a segment of ordinal -1 rather than being dropped.
 *
 * Timestamps stay verbatim ISO. Bucketing into local days is the reader's
 * timezone, not a property of the session, so it happens at read time — which
 * keeps a cached node from meaning something different after a flight.
 */

import { DEFAULT_WEIGHTS, EQUIVALENTS_PER_MITE, type UnitWeights } from "./config.js";

/** A transcript row as this fold reads it, in `rowid` order. */
export interface UsageRow {
	id: string;
	role: string;
	timestamp: string | null;
	usage: string | null;
	model: string | null;
	provider_message_id: string | null;
}

export interface TokenTotals {
	input: number;
	output: number;
	cache_read: number;
	cache_write: number;
	/** Weighted input-token equivalents, before dividing by a million. */
	equivalents: number;
	/** `equivalents / EQUIVALENTS_PER_MITE`. */
	mite: number;
	/** Billed API calls, after de-duplication. */
	calls: number;
}

/** A user turn and everything the agent spent answering it. */
export interface RequestSegment {
	/** Position in the session. -1 is the preamble before any user turn. */
	ordinal: number;
	/** The user message that opened it, or null for the preamble. */
	user_message_id: string | null;
	/** ISO instant of the user turn, or of the first call for the preamble. */
	started_at: string | null;
	/** ISO instant of the last billed call in the segment. */
	ended_at: string | null;
	totals: TokenTotals;
	/** Serving models used, in first-seen order. */
	models: string[];
}

export interface TokenUnitsProperties {
	session_id: string;
	unit: "MITE";
	equivalents_per_mite: number;
	weights: UnitWeights;
	totals: TokenTotals;
	by_model: Record<string, TokenTotals>;
	segments: RequestSegment[];
	coverage: {
		/** Assistant rows seen, before de-duplication. */
		assistant_rows: number;
		/** Distinct billed calls after folding by provider_message_id. */
		billed_calls: number;
		/** Calls whose transcript recorded no usage — unknown, never zero. */
		calls_without_usage: number;
		/** Rows with no provider id, which fell back to their own row id. */
		rows_without_key: number;
	};
}

export function emptyTotals(): TokenTotals {
	return { input: 0, output: 0, cache_read: 0, cache_write: 0, equivalents: 0, mite: 0, calls: 0 };
}

interface ParsedUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export function addCall(t: TokenTotals, u: ParsedUsage, w: UnitWeights): void {
	t.input += u.input;
	t.output += u.output;
	t.cache_read += u.cacheRead;
	t.cache_write += u.cacheWrite;
	t.equivalents +=
		u.input * w.input + u.output * w.output + u.cacheRead * w.cache_read + u.cacheWrite * w.cache_write;
	t.mite = t.equivalents / EQUIVALENTS_PER_MITE;
	t.calls += 1;
}

/** Add `b` into `a`. Used to roll segments up into days, classes, and models. */
export function mergeTotals(a: TokenTotals, b: TokenTotals): void {
	a.input += b.input;
	a.output += b.output;
	a.cache_read += b.cache_read;
	a.cache_write += b.cache_write;
	a.equivalents += b.equivalents;
	a.mite += b.mite;
	a.calls += b.calls;
}

/** Scale a totals record, for splitting one segment across several classes. */
export function scaleTotals(t: TokenTotals, factor: number): TokenTotals {
	return {
		input: t.input * factor,
		output: t.output * factor,
		cache_read: t.cache_read * factor,
		cache_write: t.cache_write * factor,
		equivalents: t.equivalents * factor,
		mite: t.mite * factor,
		calls: t.calls * factor,
	};
}

function parseUsage(raw: string | null): ParsedUsage | null {
	if (!raw) return null;
	try {
		const u = JSON.parse(raw) as Record<string, unknown>;
		const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
		return {
			input: num(u.input),
			output: num(u.output),
			cacheRead: num(u.cacheRead),
			cacheWrite: num(u.cacheWrite),
		};
	} catch {
		return null;
	}
}

/** Price one session's rows. Rows must be in conversation order (`ORDER BY rowid`). */
export function foldSessionUnits(
	sessionId: string,
	rows: UsageRow[],
	weights: UnitWeights = DEFAULT_WEIGHTS,
): TokenUnitsProperties {
	const totals = emptyTotals();
	const byModel: Record<string, TokenTotals> = {};
	const segments: RequestSegment[] = [];
	const coverage = { assistant_rows: 0, billed_calls: 0, calls_without_usage: 0, rows_without_key: 0 };

	// The preamble segment absorbs any call made before the first user turn.
	let current: RequestSegment = {
		ordinal: -1,
		user_message_id: null,
		started_at: null,
		ended_at: null,
		totals: emptyTotals(),
		models: [],
	};
	let ordinal = 0;
	const seenCalls = new Set<string>();

	for (const row of rows) {
		if (row.role === "user") {
			// Keep the preamble only when it actually cost something.
			if (current.ordinal !== -1 || current.totals.calls > 0) segments.push(current);
			current = {
				ordinal: ordinal++,
				user_message_id: row.id,
				started_at: row.timestamp,
				ended_at: null,
				totals: emptyTotals(),
				models: [],
			};
			continue;
		}
		if (row.role !== "assistant") continue;

		coverage.assistant_rows += 1;
		if (!row.provider_message_id) coverage.rows_without_key += 1;

		// One response, many rows: count the first row of each call, skip the rest.
		const callKey = row.provider_message_id ?? row.id;
		if (seenCalls.has(callKey)) continue;
		seenCalls.add(callKey);
		coverage.billed_calls += 1;

		const usage = parseUsage(row.usage);
		if (!usage) {
			coverage.calls_without_usage += 1;
			continue;
		}

		addCall(totals, usage, weights);
		addCall(current.totals, usage, weights);
		if (current.started_at === null) current.started_at = row.timestamp;
		if (row.timestamp) current.ended_at = row.timestamp;

		const model = row.model ?? "unrecorded";
		byModel[model] ??= emptyTotals();
		addCall(byModel[model]!, usage, weights);
		if (!current.models.includes(model)) current.models.push(model);
	}
	if (current.ordinal !== -1 || current.totals.calls > 0) segments.push(current);

	return {
		session_id: sessionId,
		unit: "MITE",
		equivalents_per_mite: EQUIVALENTS_PER_MITE,
		weights,
		totals,
		by_model: byModel,
		segments,
		coverage,
	};
}
