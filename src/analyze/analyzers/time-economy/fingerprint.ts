import type { FingerprintContributor } from "../../../fingerprint/contributor.js";

/** Active time per session, from the host's own timestamps. Deterministic, so objective. */
export const timeEconomyFingerprint: FingerprintContributor = {
	def: {
		id: "activeTime",
		label: "Active time",
		description: "Active time per session: tool-call spans plus message gaps up to the idle cap.",
		kind: "objective",
		measures: [
			{ kind: "total", id: "totalHours", field: "seconds", divisor: 3600, decimals: 1 },
			{ kind: "distribution", id: "perSession", field: "minutes", unit: "minutes", edges: [0, 5, 15, 30, 60, 120, 240] },
		],
	},
	async read(ctx) {
		const rows = await ctx.nodes("time-economy", { seconds: "$.active_seconds" });
		const timed = rows.filter((r) => typeof r["seconds"] === "number");
		return {
			measured: timed.map((r) => String(r["session"])),
			rows: timed.map((r) => ({ session: r["session"]!, seconds: r["seconds"]!, minutes: Math.round((Number(r["seconds"]) / 60) * 100) / 100 })),
		};
	},
};
