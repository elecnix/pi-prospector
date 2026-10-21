/**
 * Muting commands: surface the lexicon's tail, let the operator (or the
 * reviewing agent via the prospect tool) say "not that one", and mute it.
 *
 * Prompt tuning is the wrong instrument for vocabulary that merely looks like a
 * signal but is not for a given corpus. A mute is a content-addressed
 * judgement — the operator's, keyed on the term — that stops a term from
 * matching new turns while leaving its prior hit nodes intact as stale/config
 * lineage. Nobody hand-edits config.
 *
 *   prospect mute <term> [--reason "..."]
 *   prospect unmute <term>
 *   prospect mutes
 */

import type { ExtensionCommandContext } from "../pi-stubs.js";
import { openAsyncDatabase, type AsyncDatabase } from "../db/async-db.js";
import { migrate } from "../db/schema.js";
import { getDbPath } from "../config.js";
import {
	upsertAssertion,
	supersedeAssertion,
	listAssertions,
	attachMuteEdge,
	silenceConclusionsOfSilencedHits,
	retractConclusionsMadeUnder,
	type AssertionRow,
} from "../db/assertions.js";

function output(ctx: ExtensionCommandContext, text: string, level: "info" | "warning" | "error" = "info"): void {
	ctx.ui.notify(text, level);
	console.log(text);
}

/**
 * Split a leading term from the rest of the arguments. A term in single or
 * double quotes is read whole, so a multi-word term survives; an unquoted term
 * runs up to the first `--` flag. An unterminated quote gives no term.
 */
function splitTerm(args: string): { term: string | undefined; rest: string } {
	const text = (args ?? "").trim();
	const quote = text[0];
	if (quote === '"' || quote === "'") {
		const end = text.indexOf(quote, 1);
		if (end === -1) return { term: undefined, rest: "" };
		const term = text.slice(1, end).trim();
		return { term: term.length > 0 ? term : undefined, rest: text.slice(end + 1).trim() };
	}
	const flag = text.search(/(^|\s)--/);
	const head = (flag === -1 ? text : text.slice(0, flag)).trim();
	const rest = flag === -1 ? "" : text.slice(flag).trim();
	return { term: head.length > 0 ? head : undefined, rest };
}

/** Parse `mute <term> [--reason …] [--by agent|operator]`. The reason is everything after `--reason` (up to `--by`). */
export function parseMuteArgs(args: string): { term?: string; reason: string | null; by: string | null } {
	const { term, rest } = splitTerm(args);
	const toks = rest.split(/\s+/).filter(Boolean);
	let reason: string | null = null;
	let by: string | null = null;
	for (let i = 0; i < toks.length; i++) {
		const t = toks[i]!.toLowerCase();
		if (t === "--reason") {
			const words: string[] = [];
			i++;
			while (i < toks.length && toks[i]!.toLowerCase() !== "--by") words.push(toks[i++]!);
			const joined = words.join(" ").trim();
			if (joined.length > 0) reason = joined;
			i--;
		} else if (t === "--by" && toks[i + 1]) {
			by = toks[++i]!;
		}
	}
	return { term, reason, by };
}

/** Parse `unmute <term>` with the same term rules as `mute`. */
export function parseUnmuteArgs(args: string): string | undefined {
	return splitTerm(args).term;
}

/** Normalise a term the way the tokeniser would, so mute keys match lexicon keys. */
export function normaliseTerm(raw: string): string {
	const unquoted = raw.trim().replace(/^(["'])(.*)\1$/s, "$2");
	return unquoted.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Mute a lexicon term. Records a content-addressed assertion (survives a wipe/
 * recompute) and, when the term already has a lexicon verdict node, wires the
 * `mutes` edge so the mute is reachable from the graph. Every live
 * `turn-frustration` hit node the term produced is marked the same way (#325),
 * so no reader keeps counting a silenced hit. Returns the recorded outcome for
 * reuse by the tool and tests.
 */
export async function muteTerm(
	db: AsyncDatabase,
	args: { term: string; reason?: string | null; by?: string | null },
): Promise<{ muted: boolean; assertionId: string; liveHits: number }> {
	const term = normaliseTerm(args.term);
	const assertionId = await upsertAssertion(db, {
		subjectKind: "term",
		subjectKey: term,
		verdict: "muted",
		reason: args.reason ?? null,
		assertedBy: args.by ?? "operator",
	});
	await attachMuteEdge(db, term, assertionId);
	// The conclusions the silenced hits produced are silenced too: a conclusion
	// drawn from a hit the operator said does not count is a conclusion about a
	// term that does not count. Marking them keeps the reader's old conclusion
	// out of the current generation, so a report never counts a muted term.
	await silenceConclusionsOfSilencedHits(db, assertionId);
	// The hit nodes the mute left behind: they stay live until a `--revise config`
	// recomputes the readers, and the operator is told how many there are. The
	// count is of the *hits* only — the term's lexicon verdict is not a hit.
	const liveHits = await countMutedHitNodes(db, term);
	return { muted: true, assertionId, liveHits };
}

/** How many live `turn-frustration` hit nodes the term produced. */
async function countMutedHitNodes(db: AsyncDatabase, term: string): Promise<number> {
	const row = (await db
		.prepare(
			`SELECT COUNT(*) AS c FROM live_nodes
			 WHERE analyzer_id = 'turn-frustration'
			   AND json_extract(content_json, '$.signal_source') = 'lexicon'
			   AND json_extract(content_json, '$.signal') = ?`,
		)
		.get(term)) as { c: number };
	return row.c;
}

/**
 * Unmute a lexicon term (append-only via superseded_at). Returns rows superseded.
 *
 * Unmuting also lifts the conclusions drawn *under* the mute (#325). A mute is
 * `config`, so a `--revise config` run recomputes the readers with the muted
 * term excluded; those conclusions are right for the muted setup and wrong for
 * the unmuted one. The mute-era nodes are retracted so the pre-mute conclusion
 * becomes current again — the same reversible retraction gc uses, and the same
 * one `prospect retract --undo` reverses.
 */
export async function unmuteTerm(db: AsyncDatabase, term: string): Promise<number> {
	const normalised = normaliseTerm(term);
	const n = await supersedeAssertion(db, {
		subjectKind: "term",
		subjectKey: normalised,
		verdict: "muted",
	});
	if (n > 0) {
		await retractConclusionsMadeUnder(db, normalised, new Date().toISOString());
	}
	return n;
}

/** One-line render of an assertion row. */
export function formatAssertion(a: AssertionRow): string {
	const by = a.asserted_by ? ` by ${a.asserted_by}` : "";
	const reason = a.reason ? ` — ${a.reason}` : "";
	const state = a.superseded_at ? `unmuted ${a.superseded_at}` : "active";
	return `  [${state}] ${a.subject_kind}:${a.subject_key} → ${a.verdict} (asserted ${a.asserted_at}${by})${reason}`;
}

export async function prospectMute(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const { term, reason, by } = parseMuteArgs(args);
	if (!term) {
		output(ctx, 'Usage: /prospect-mute <term> [--reason "why"] [--by operator|agent] (quote a multi-word term)', "warning");
		return;
	}
	const db = openAsyncDatabase(getDbPath());
	await migrate(db);
	try {
		const { assertionId, liveHits } = await muteTerm(db, { term, reason, by });
		const note = reason ? ` — ${reason}` : "";
		const hitNote =
			liveHits > 0
				? ` Its ${liveHits} existing hit node(s) are silenced: they stay in the graph as lineage, but they no longer count towards friction, digests or reports.`
				: "";
		output(
			ctx,
			`Muted '${normaliseTerm(term)}'. It will stop matching new turns; its existing hit nodes stay as stale/config lineage.${hitNote}` +
				`\n  Run '/prospect-analyze --revise config' to recompute the nodes that consulted it.` +
				`\n  Assertion ${assertionId}${note}`,
		);
	} finally {
		await db.close();
	}
}

export async function prospectUnmute(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const parsed = parseUnmuteArgs(args);
	const term = parsed === undefined ? "" : normaliseTerm(parsed);
	if (!term) {
		output(ctx, 'Usage: /prospect-unmute <term> (quote a multi-word term)', "warning");
		return;
	}
	const db = openAsyncDatabase(getDbPath());
	await migrate(db);
	try {
		const n = await unmuteTerm(db, term);
		output(ctx, n > 0 ? `Unmuted '${term}'. Its prior hit nodes classify current again.` : `'${term}' was not muted.`, n > 0 ? "info" : "warning");
	} finally {
		await db.close();
	}
}

export async function prospectMutes(args: string, ctx: ExtensionCommandContext): Promise<void> {
	const db = openAsyncDatabase(getDbPath());
	await migrate(db);
	try {
		const rows = await listAssertions(db, "term");
		if (rows.length === 0) {
			output(ctx, "No term assertions recorded.");
			return;
		}
		const active = rows.filter((r) => r.superseded_at === null).length;
		output(
			ctx,
			`Term assertions (${rows.length} total, ${active} active; the mute corpus is the training input for the classifier prompt):\n${rows.map(formatAssertion).join("\n")}`,
		);
	} finally {
		await db.close();
	}
}
