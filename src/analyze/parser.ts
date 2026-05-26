/**
 * Parse LLM analysis response into structured proposals.
 */

export interface ParsedProposal {
	target: string;
	severity: "friction" | "correction" | "waste" | "suggestion";
	summary: string;
	detail: string;
	evidence: string;
}

const VALID_SEVERITIES = new Set(["friction", "correction", "waste", "suggestion"]);

/**
 * Parse LLM tool-call response into typed proposals.
 * Handles both tool-call arguments object and plain JSON text.
 */
export function parseAnalysisResponse(response: unknown): ParsedProposal[] {
	// If it's already a parsed tool call arguments object
	if (response && typeof response === "object" && "proposals" in response) {
		const proposals = (response as { proposals: unknown[] }).proposals;
		if (Array.isArray(proposals)) {
			return proposals.filter(isValidProposal).map(normalizeProposal);
		}
	}

	// If it's a string, try to extract JSON
	if (typeof response === "string") {
		const jsonMatch = response.match(/```json\s*([\s\S]*?)```/) ??
			response.match(/(\{[\s\S]*\})/);
		if (jsonMatch) {
			try {
				const parsed = JSON.parse(jsonMatch[1] ?? jsonMatch[0]!);
				if (parsed && typeof parsed === "object" && "proposals" in parsed && Array.isArray(parsed.proposals)) {
					return parsed.proposals.filter(isValidProposal).map(normalizeProposal);
				}
			} catch { /* ignore */ }
		}
	}

	return [];
}

function isValidProposal(item: unknown): item is Record<string, unknown> {
	if (!item || typeof item !== "object") return false;
	const p = item as Record<string, unknown>;
	return typeof p.target === "string" && typeof p.summary === "string" && p.target.length > 0 && p.summary.length > 0;
}

function normalizeProposal(item: Record<string, unknown>): ParsedProposal {
	const severity = VALID_SEVERITIES.has(item.severity as string)
		? (item.severity as ParsedProposal["severity"])
		: "suggestion";

	return {
		target: String(item.target),
		severity,
		summary: String(item.summary),
		detail: String(item.detail ?? ""),
		evidence: String(item.evidence ?? ""),
	};
}