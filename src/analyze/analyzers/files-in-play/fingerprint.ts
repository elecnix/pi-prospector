import { newestPerSession, type FingerprintContributor } from "../../../fingerprint/contributor.js";

/**
 * How many files a session works on, and how often the agent goes back to a
 * file it already read. Counted from the file tools' calls, so objective. The
 * paths stay out.
 */
export const filesInPlayFingerprint: FingerprintContributor = {
	def: {
		id: "filesInPlay",
		label: "Files in play",
		description: "Distinct files read, edited or written per session, re-reads of a file already read, read-edit-read cycles, and the sessions in which the agent kept reopening files it had just had open (churn).",
		kind: "objective",
		analyzers: ["files-in-play"],
		measures: [
			{ kind: "distribution", id: "filesPerSession", metric: "files-in-play.distinct-files", field: "files", unit: "files", edges: [0, 1, 5, 10, 25, 50, 100] },
			{ kind: "total", id: "rereads", metric: "files-in-play.reread-events", field: "rereads" },
			{ kind: "total", id: "editRereadCycles", metric: "files-in-play.edit-reread-cycles", field: "cycles" },
			{ kind: "sessions", id: "sessionsChurning", metric: "files-in-play.churn-score", field: "churning" },
		],
	},
	async read(ctx) {
		const rows = newestPerSession(
			await ctx.nodes("files-in-play", { files: "$.distinct_files", rereads: "$.reread_events", cycles: "$.edit_reread_cycles", churning: "$.churning_windows" }),
			"files",
		);
		return { measured: rows.map((r) => String(r["session"])), rows };
	},
};
