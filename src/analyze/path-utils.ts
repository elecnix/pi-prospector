/**
 * Shared path-shape predicates used by analyzers that must tell file paths
 * apart from flags, URLs, and ordinary words. Pure functions, no analyzer
 * coupling: every consumer gets the same conservative judgement, so two
 * detectors can never disagree about what counts as a path.
 */

/**
 * Whether a bare token looks like a file path rather than a subcommand, flag
 * value, URL, or punctuation. Deliberately conservative: a slash anywhere
 * (absolute or relative paths), or a dotted final segment (`name.ext`,
 * `.env`, `archive.tar.gz`). Flags, URLs, operators, and bare words
 * (`test`, `build`) are rejected.
 */
export function looksLikePath(token: string): boolean {
	if (token.includes("://")) return false; // URLs, not files
	if (/^[|&;<>()]+$/.test(token)) return false; // shell operators
	if (token.includes("/")) return true;
	// Dotted final segment: something before the dot, a non-empty extension,
	// and no trailing dot. Dotfiles (`.env`) qualify; `1.` does not.
	return /^[^.].*\.[^.]+$/.test(token);
}
