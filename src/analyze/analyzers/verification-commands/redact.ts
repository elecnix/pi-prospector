/**
 * Redaction of the command lines that leave the machine.
 *
 * `verification-commands` sends a command line to a decision model so the
 * model can judge whether it verifies the working tree. The command line is
 * the only session text that leaves, so it is worth a last look: a command
 * that embeds a token, a password, or a credential in a URL would carry that
 * secret to a remote service.
 *
 * The redaction is deliberately conservative about what it considers a secret.
 * A line that names an environment variable whose *name* looks secret loses
 * its value; a line that assigns an ordinary variable keeps it, because
 * `NODE_ENV=production` is not a credential and redacting it would make the
 * line the model judges less accurate for nothing.
 *
 * The rules are the obvious ones a person would apply by eye:
 *
 *   - a bearer token in an `Authorization` header;
 *   - the value of an environment assignment whose name looks secret;
 *   - the credentials in a URL, keeping the host;
 *   - a provider token that matches a known shape;
 *   - a password given as a flag or as an argument.
 *
 * A redaction is not a guarantee. A secret in a shape this file does not know
 * passes through. The point is that the obvious ones do not.
 */

/** The marker that replaces a redacted value. */
export const REDACTED = "<redacted>";

/**
 * Environment variable names whose value is a secret.
 *
 * The name has to look like a secret on its own, so an ordinary assignment
 * keeps its value. The list is a name-shape test rather than a fixed list of
 * names, so `MY_API_KEY`, `CI_JOB_TOKEN`, and `DB_PASSWORD` all match while
 * `NODE_ENV` and `CI` do not.
 */
const SECRET_NAME = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH|SESSION|COOKIE|SIGNATURE|PRIVATE)/i;

/**
 * A known provider token shape, anchored on its distinctive prefix. These are
 * the shapes a person recognises on sight.
 */
const PROVIDER_TOKEN = [
	/\b(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{20,}/g,
	/\bglpat-[0-9A-Za-z_-]{20,}/g,
	/\bxox[abprs]-[0-9A-Za-z-]{10,}/g,
	/\bsk-(?:ant-|proj-)?[0-9A-Za-z_-]{20,}/g,
	/\bAIza[0-9A-Za-z_-]{20,}/g,
	/\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
	/\bAKIA[0-9A-Z]{16}\b/g,
];

/** A bearer token in an `Authorization` header. */
const BEARER = /(\bAuthorization\s*:\s*Bearer\s+)([^\s'"\\]+)/gi;

/** An environment assignment: `NAME=value`, with the value quoted or bare. */
const ENV_ASSIGNMENT = /\b([A-Z_][A-Z0-9_]*)(\s*=\s*)("([^"]*)"|'([^']*)'|([^\s;&|]+))/g;

/** The credentials in a URL: `scheme://user:password@host`. */
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi;

/** A password given as a flag: `--password=value`, `--token value`, `-p value`. */
const PASSWORD_FLAG = /(--(?:password|passwd|token|secret|api-key|apikey|key)(?:\s+|=))("([^"]*)"|'([^']*)'|([^\s;&|]+))/gi;

/**
 * Redact the obvious secrets in a command line.
 *
 * The line keeps its shape: the secret becomes `<redacted>` and everything
 * around it stays, so the model still sees which command it is judging.
 */
export function redactCommandLine(command: string): string {
	let out = command;

	// A URL's credentials first: the password there may also look like a token.
	out = out.replace(URL_CREDENTIALS, (_all, scheme, user) => `${scheme}${user}:${REDACTED}@`);

	out = out.replace(BEARER, (_all, prefix) => `${prefix}${REDACTED}`);

	out = out.replace(PASSWORD_FLAG, (_all, prefix) => `${prefix}${REDACTED}`);

	// An environment assignment whose *name* looks secret loses its value; one
	// whose name does not keeps it.
	out = out.replace(ENV_ASSIGNMENT, (all, name, eq, ...rest) => {
		if (!SECRET_NAME.test(name)) return all;
		const quoted = rest[0] as string | undefined;
		const bare = rest[2] as string | undefined;
		const value = quoted ?? bare;
		if (value === undefined || value === "") return all;
		return `${name}${eq}${REDACTED}`;
	});

	for (const pattern of PROVIDER_TOKEN) {
		out = out.replace(pattern, REDACTED);
	}

	return out;
}
