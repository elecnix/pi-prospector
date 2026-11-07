/** Configuration for the file-reads analyzer and its `graph` output. */

import { Type, type Static } from "typebox";

export const FileReadsConfig = Type.Object({
	/** A read among a session's first N distinct files counts as an opening read. */
	openingReads: Type.Number(),
	/** A lead needs at least this many sessions behind it. */
	minSessions: Type.Number(),
	/** An orientation lead needs this share of the repository's sessions to open on the file. */
	minOpeningShare: Type.Number(),
	/** A file whose median read result is at least this many characters is large. */
	largeFileChars: Type.Number(),
	/** Characters per token, for the token estimates in the report. */
	charsPerToken: Type.Number(),
	/** Most edges drawn in each repository's Mermaid graph, by session count. */
	maxGraphEdges: Type.Number(),
	/** Most leads listed per kind and repository. */
	maxLeads: Type.Number(),
});
export type FileReadsConfig = Static<typeof FileReadsConfig>;

export const DEFAULT_FILE_READS_CONFIG: FileReadsConfig = {
	openingReads: 5,
	minSessions: 3,
	minOpeningShare: 0.25,
	largeFileChars: 20000,
	charsPerToken: 4,
	maxGraphEdges: 40,
	maxLeads: 10,
};
