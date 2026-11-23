import type { FingerprintContributor } from "../../../fingerprint/contributor.js";

/** Active time per session, from the host's own timestamps. Deterministic, so objective. */
export const timeEconomyFingerprint: FingerprintContributor = {
	def: {
		id: "activeTime",
		label: "Active time",
		description: "Active time per session: tool-call spans plus message gaps up to the idle cap.",
		kind: "objective",
		analyzers: ["time-economy"],
		measures: [
			{ kind: "total", id: "totalHours", metric: "time-economy.active-time", field: "seconds", divisor: 3600, decimals: 1 },
			{ kind: "distribution", id: "perSession", metric: "time-economy.active-time", field: "minutes", unit: "minutes", edges: [0, 5, 15, 30, 60, 120, 240] },
		],
	},
	async read(ctx) {
		// One current node per session: a node drawn from a session that later grew
		// is revised by the node drawn from the whole session.
		const timed = (await ctx.nodes("time-economy", { seconds: "$.active_seconds" })).filter((r) => typeof r["seconds"] === "number");
		return {
			measured: timed.map((r) => String(r["session"])),
			rows: timed.map((r) => ({ session: r["session"]!, seconds: r["seconds"]!, minutes: Math.round((Number(r["seconds"]) / 60) * 100) / 100 })),
		};
	},
};
