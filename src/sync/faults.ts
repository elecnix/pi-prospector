/**
 * A named failure of one session file, so a sync summary can count failures by class
 * instead of by message. A source throws a `SyncFault` for a failure it understands
 * (a pi file with no session header); any other error is classed by its own name.
 */
export class SyncFault extends Error {
	constructor(
		readonly faultClass: string,
		message: string,
	) {
		super(message);
		this.name = "SyncFault";
	}
}

/** The class a sync summary files an error under. */
export function faultClassOf(err: unknown): string {
	if (err instanceof SyncFault) return err.faultClass;
	if (err instanceof Error) {
		const code = (err as NodeJS.ErrnoException).code;
		return code ? `${err.name}:${code}` : err.name;
	}
	return "unknown";
}
