import type { MetricDefinition } from "../../metrics/types.js";
import { LIMIT_CALL_ID, LIMIT_HARNESS, LIMIT_VERSIONS } from "../../metrics/limits.js";

export const metrics: MetricDefinition[] = [
	{
		id: "file-reads.reads",
		name: "File reads in order",
		definition: "Per session, every read of a file in tool-call order: the path relative to the working directory, its rank among the session's distinct files, the tool, the characters the read returned, and whether it asked for part of the file. The files the session edited are kept beside them.",
		measurement: "counted",
		unit: "reads per session",
		denominator: "none",
		limitations: [
			"A path is read from the call's arguments. A bash call counts only for the commands that print a file (cat, head, tail, sed and a few others), and only for tokens that look like a file, so a search scope such as `grep -rn x src` is not a read and a file read by a script is missed.",
			"Paths are relative to the session's working directory. A bash call that changed directory first names its paths from somewhere else, and they are taken as written.",
			"A bash call that read several files returns one text, so none of those reads has a size.",
			LIMIT_CALL_ID,
			LIMIT_HARNESS,
			LIMIT_VERSIONS,
		],
	},
	{
		id: "file-reads.graph",
		name: "File read graph",
		definition: "Per repository, folded at read time from the newest node of every session: each file with the sessions that read it, its reads, the sessions that read it first or among their first files, its median rank and size, and the share of whole-file reads; and each edge from the session root or a file to the next distinct file read, with the sessions that took it.",
		measurement: "counted",
		unit: "sessions and reads per file, sessions per edge",
		denominator: "sessions in the repository",
		limitations: [
			"No node stores it. The `file-reads:graph` output computes it on each render, so a session not analysed yet is missing.",
			"A repository is the repo-identity key where that analyzer found one, and the working directory otherwise, so sessions with no git hint in a worktree form a group of their own.",
			"Reads outside the working directory are counted apart and left out of the graph.",
			"The documentation and refactoring leads are thresholds over these counts. Their token figures are upper bounds that assume every listed read could be avoided.",
		],
	},
];
