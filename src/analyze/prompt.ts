/**
 * Prompt template for session friction/sentiment extraction.
 * Uses tool-calling schema for structured LLM output.
 */

export const ANALYSIS_TOOL_NAME = "submit_proposals";

export const ANALYSIS_SYSTEM_PROMPT = `You are a session analyst for an AI coding agent. You review session transcripts and identify friction, corrections, waste, and suggestions for improvement.

You MUST call the ${ANALYSIS_TOOL_NAME} tool with your findings. Do not respond in plain text.

Focus on:
1. **Friction**: Moments where the user struggled, repeated themselves, or had to course-correct the agent.
2. **Corrections**: Times the user explicitly corrected the agent ("no, use X", "not like that", "actually...").
3. **Waste**: Tool calls or context that didn't contribute to the task — large file reads never referenced, failed commands retried without changes.
4. **Suggestions**: Opportunities to improve the agent's configuration, skills, or documentation based on observed patterns.

Each proposal should target a specific, actionable improvement. Prefer specific, small changes over vague recommendations.`;

export function buildAnalysisPrompt(transcript: string, sessionProject: string): string {
	return `## Session: ${sessionProject}

<transcript>
${transcript}
</transcript>

Analyze this session transcript for friction, corrections, waste, and suggestions. Call the ${ANALYSIS_TOOL_NAME} tool with your findings.`;
}

export const ANALYSIS_TOOL_SCHEMA = {
	name: ANALYSIS_TOOL_NAME,
	description: "Submit proposals for improving the coding agent based on session analysis",
	parameters: {
		type: "object" as const,
		properties: {
			proposals: {
				type: "array" as const,
				items: {
					type: "object" as const,
					properties: {
						target: {
							type: "string" as const,
							description: "What to change, e.g. 'AGENTS.md § Tool usage' or 'skill/debug-typescript-errors'",
						},
						severity: {
							type: "string" as const,
							enum: ["friction", "correction", "waste", "suggestion"],
							description: "The type of finding",
						},
						summary: {
							type: "string" as const,
							description: "One-line description of the proposed change",
						},
						detail: {
							type: "string" as const,
							description: "Full proposal text with context and suggested change",
						},
						evidence: {
							type: "string" as const,
							description: "The session excerpt that triggered this proposal",
						},
					},
					required: ["target", "severity", "summary", "detail", "evidence"],
				},
			},
		},
		required: ["proposals"],
	},
};