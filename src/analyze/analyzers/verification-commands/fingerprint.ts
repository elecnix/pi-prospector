import type { FingerprintContributor } from "../../../fingerprint/contributor.js";
import { VERIFICATION_VERDICTS } from "./decision.js";

/**
 * The verdicts on the distinct command lines the sessions ran, as counts. The
 * command lines are never read. A model judged each, so inferred.
 */
export const verificationCommandsFingerprint: FingerprintContributor = {
	def: {
		id: "verificationCommands",
		label: "Verification commands",
		description:
			"Distinct command lines a decision model judged, once for the whole corpus, by whether they check the whole project, part of it, or nothing. Only a command no shipped pattern covers, and that ran long enough in the shape of a gate run, is judged. A command counts in the session that first ran it, so the sessions measured are those that added one. Without a decision model there is no verdict and the section is withheld. No command is published.",
		kind: "inferred",
		analyzers: ["verification-commands"],
		measures: [
			{ kind: "corpusCount", id: "commandsJudged", metric: "verification-commands.verdict", field: "judged", of: "commands" },
			{ kind: "corpusGroups", id: "byVerdict", metric: "verification-commands.verdict", dimensions: { verdict: [...VERIFICATION_VERDICTS] }, total: "commandsJudged", of: "commands" },
		],
	},
	async read(ctx) {
		const verdicts = await ctx.nodes("verification-commands", { verdict: "$.verdict" });
		return { measured: verdicts.map((v) => String(v["session"])), rows: verdicts.map((v) => ({ ...v, judged: 1 })) };
	},
};
