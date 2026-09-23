/**
 * The reference corpus: the sessions the language model is trained and
 * calibrated on, and the rules that keep that honest (issue #277).
 *
 *  1. **Reference sessions.** The earliest `maxReferenceSessions` sessions (by
 *     start time, then id) that carry a document. Earliest, so that once the
 *     corpus outgrows the cap, a newly synced session changes nothing about the
 *     reference and every existing node stays current.
 *  2. **Cross-session filter.** Every shingle is indexed by the session it
 *     appeared in; a reference document whose share of shingles seen in some
 *     *other* session falls under `minCrossSessionShare` is kept out of training
 *     and calibration. Collapsed output is novel everywhere, so it repeats
 *     nothing from another session; ordinary technical language repeats all the
 *     time. No labels go into this.
 *  3. **Split by session.** Every `holdoutEvery`-th reference session, in
 *     hashed-id order, is held out. Splitting by session rather than by document
 *     keeps near-identical documents of one session from sitting on both sides.
 *  4. **Train** on the filtered documents of the training sessions.
 *  5. **Calibrate** by scoring the held-out documents; the threshold sits above
 *     their maximum. The threshold is a property of the corpus, so it is
 *     derived here rather than configured.
 *  6. **Score** a session with a model that never saw it: its own training
 *     counts are subtracted, and its own held-out documents are left out of the
 *     maximum. A model that scores a document it trained on has memorised it and
 *     reports collapse as ordinary text — the trap this module exists to avoid.
 *
 * Building the reference reads every reference session, so it is built once per
 * process and reused until the conversation index changes.
 */

import { Type, type Static } from "typebox";
import type { AsyncDatabase } from "../../../db/async-db.js";
import { getAssistantGenerations, getCorpusSignature, listSessionIdsByStart } from "../../../db/queries.js";
import type { SourceRef } from "../../types.js";
import { computeConfigHash, shortHash } from "../../input-hash.js";
import type { DecodeCollapseConfig } from "./config.js";
import { documentsFingerprint, extractDocuments, GenerationDocument } from "./documents.js";
import { NgramCounts, NgramModel, median, quantile, shingles, type TokenizedDocument } from "./ngram.js";

/** Held-out perplexity distribution the threshold was read from. */
export const Calibration = Type.Object({
	held_out_documents: Type.Number(),
	held_out_median: Type.Number(),
	held_out_p99: Type.Number(),
	held_out_max: Type.Number(),
	threshold: Type.Number(),
});
export type Calibration = Static<typeof Calibration>;

/** How much corpus stood behind one session's scores. */
export const ReferenceCoverage = Type.Object({
	reference_sessions: Type.Number(),
	training_sessions: Type.Number(),
	held_out_sessions: Type.Number(),
	reference_documents: Type.Number(),
	/** Reference documents the cross-session filter kept out of training and calibration. */
	filtered_documents: Type.Number(),
});
export type ReferenceCoverage = Static<typeof ReferenceCoverage>;

const SHINGLE_SHARED = -1;

/** One reference session's contribution. */
const ReferenceSession = Type.Object({
	id: Type.String(),
	index: Type.Number(),
	held_out: Type.Boolean(),
	documents: Type.Array(GenerationDocument),
	fingerprint: Type.String(),
});

/** Everything scoring one session needs, with that session already excluded. */
export class SessionScorer {
	constructor(
		readonly model: NgramModel | null,
		readonly calibration: Calibration | null,
		readonly coverage: ReferenceCoverage,
		private readonly shareOf: (doc: TokenizedDocument) => number,
		private readonly minLineTokens: number,
	) {}

	get ready(): boolean {
		return this.model !== null && this.calibration !== null;
	}

	/** Share of the document's shingles seen in some reference session other than this one. */
	crossSessionShare(doc: TokenizedDocument): number {
		return this.shareOf(doc);
	}

	score(doc: TokenizedDocument): number | null {
		return this.model ? this.model.documentScore(doc, this.minLineTokens) : null;
	}
}

export class ReferenceCorpus {
	private readonly byId = new Map<string, Static<typeof ReferenceSession>>();
	private readonly owners = new Map<string, number>();
	private readonly kept = new Map<string, TokenizedDocument[]>();
	private readonly counts: NgramCounts;
	/** Filtered held-out documents' scores, with the session they came from. */
	private readonly heldOutScores: Array<{ sessionId: string; score: number }> = [];
	private readonly filteredCount: number;
	private readonly documentCount: number;

	/** One source ref per reference session, committing identity to its exact documents. */
	readonly sourceRefs: SourceRef[];
	/** Digest of the whole reference: the sessions, their content, their split. */
	readonly fingerprint: string;

	constructor(
		sessions: ReadonlyArray<{ id: string; documents: GenerationDocument[] }>,
		private readonly config: DecodeCollapseConfig,
	) {
		const order = [...sessions].sort((a, b) => {
			const ha = shortHash(a.id);
			const hb = shortHash(b.id);
			return ha < hb ? -1 : ha > hb ? 1 : a.id < b.id ? -1 : 1;
		});
		const heldOut = new Set(order.filter((_, i) => i % config.holdoutEvery === config.holdoutEvery - 1).map((s) => s.id));

		sessions.forEach((s, index) => {
			this.byId.set(s.id, {
				id: s.id,
				index,
				held_out: heldOut.has(s.id),
				documents: s.documents,
				fingerprint: documentsFingerprint(s.documents),
			});
			for (const doc of s.documents) {
				for (const sh of new Set(shingles(doc.tokens, config.crossSessionShingle))) {
					const owner = this.owners.get(sh);
					if (owner === undefined) this.owners.set(sh, index);
					else if (owner !== index) this.owners.set(sh, SHINGLE_SHARED);
				}
			}
		});

		let filtered = 0;
		let total = 0;
		for (const s of sessions) {
			const index = this.byId.get(s.id)!.index;
			const keep: TokenizedDocument[] = [];
			for (const doc of s.documents) {
				total++;
				if (this.share(doc.tokens, index) < config.minCrossSessionShare) filtered++;
				else keep.push(doc.tokens);
			}
			this.kept.set(s.id, keep);
		}
		this.filteredCount = filtered;
		this.documentCount = total;

		this.counts = new NgramCounts(config.order);
		for (const s of sessions) {
			if (heldOut.has(s.id)) continue;
			for (const doc of this.kept.get(s.id)!) this.counts.addDocument(doc);
		}
		const model = new NgramModel(this.counts, config.discount);
		for (const s of sessions) {
			if (!heldOut.has(s.id)) continue;
			for (const doc of this.kept.get(s.id)!) {
				this.heldOutScores.push({ sessionId: s.id, score: model.documentScore(doc, config.minLineTokens) });
			}
		}

		this.sourceRefs = sessions.map((s) => ({
			kind: "session" as const,
			id: `${s.id}#decode-ref=${this.byId.get(s.id)!.fingerprint}${heldOut.has(s.id) ? ":held" : ""}`,
		}));
		this.fingerprint = shortHash(this.sourceRefs.map((r) => r.id).join("\n"));
	}

	/** Share of a document's shingles also seen in a reference session other than `selfIndex`. */
	private share(doc: TokenizedDocument, selfIndex: number): number {
		const all = shingles(doc, this.config.crossSessionShingle);
		if (all.length === 0) return 0;
		let shared = 0;
		for (const sh of all) {
			const owner = this.owners.get(sh);
			if (owner === SHINGLE_SHARED || (owner !== undefined && owner !== selfIndex)) shared++;
		}
		return shared / all.length;
	}

	/** A scorer for one session, trained and calibrated without it. */
	scorerFor(sessionId: string): SessionScorer {
		const self = this.byId.get(sessionId);
		const selfIndex = self ? self.index : -2;
		let trainingSessions = 0;
		let heldOutSessions = 0;
		for (const s of this.byId.values()) {
			if (s.id === sessionId) continue;
			if (s.held_out) heldOutSessions++;
			else trainingSessions++;
		}
		const coverage: ReferenceCoverage = {
			reference_sessions: this.byId.size,
			training_sessions: trainingSessions,
			held_out_sessions: heldOutSessions,
			reference_documents: this.documentCount,
			filtered_documents: this.filteredCount,
		};
		const shareOf = (doc: TokenizedDocument) => this.share(doc, selfIndex);

		const heldOut = this.heldOutScores.filter((h) => h.sessionId !== sessionId).map((h) => h.score);
		if (trainingSessions < this.config.minTrainingSessions || heldOut.length < this.config.minHeldOutDocuments) {
			return new SessionScorer(null, null, coverage, shareOf, this.config.minLineTokens);
		}

		let excluded: NgramCounts | undefined;
		if (self && !self.held_out) {
			excluded = new NgramCounts(this.config.order);
			for (const doc of this.kept.get(sessionId)!) excluded.addDocument(doc);
		}
		const max = heldOut.reduce((m, v) => (v > m ? v : m), 0);
		const calibration: Calibration = {
			held_out_documents: heldOut.length,
			held_out_median: round(median(heldOut)),
			held_out_p99: round(quantile(heldOut, 0.99)),
			held_out_max: round(max),
			threshold: round(max * this.config.thresholdMultiplier),
		};
		return new SessionScorer(
			new NgramModel(this.counts, this.config.discount, excluded),
			calibration,
			coverage,
			shareOf,
			this.config.minLineTokens,
		);
	}
}

/** Scores are recorded to one decimal: enough to rank, stable enough to hash. */
export function round(n: number): number {
	return Math.round(n * 10) / 10;
}

/** A reference session's training documents: its documents in order, up to the per-session token cap. */
function trainingSlice(docs: GenerationDocument[], cap: number): GenerationDocument[] {
	const out: GenerationDocument[] = [];
	let tokens = 0;
	for (const d of docs) {
		if (out.length > 0 && tokens + d.token_count > cap) break;
		out.push(d);
		tokens += d.token_count;
	}
	return out;
}

async function buildReference(db: AsyncDatabase, config: DecodeCollapseConfig): Promise<ReferenceCorpus> {
	const sessions: Array<{ id: string; documents: GenerationDocument[] }> = [];
	for (const id of await listSessionIdsByStart(db)) {
		if (sessions.length >= config.maxReferenceSessions) break;
		const docs = extractDocuments(await getAssistantGenerations(db, id), config);
		if (docs.length === 0) continue;
		sessions.push({ id, documents: trainingSlice(docs, config.maxTrainingTokensPerSession) });
	}
	return new ReferenceCorpus(sessions, config);
}

const cache = new WeakMap<AsyncDatabase, { key: string; reference: Promise<ReferenceCorpus> }>();

/** The reference corpus for this database and config, built once and reused while the index is unchanged. */
export async function getReference(db: AsyncDatabase, config: DecodeCollapseConfig): Promise<ReferenceCorpus> {
	const key = `${await getCorpusSignature(db)}|${computeConfigHash(config)}`;
	const hit = cache.get(db);
	if (hit && hit.key === key) return hit.reference;
	const reference = buildReference(db, config);
	cache.set(db, { key, reference });
	try {
		return await reference;
	} catch (err) {
		// A failed build must not be served to the next caller.
		if (cache.get(db)?.reference === reference) cache.delete(db);
		throw err;
	}
}
