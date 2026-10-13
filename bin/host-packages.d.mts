export interface ResolveContext {
	parentURL?: string;
	conditions: string[];
	importAttributes: Record<string, string>;
}
export interface ResolveResult {
	url: string;
	format?: string;
	shortCircuit?: boolean;
}
export function initialize(data: { piRoot: string | undefined }): void;
export function resolve(
	specifier: string,
	context: ResolveContext,
	nextResolve: (specifier: string, context?: ResolveContext) => Promise<ResolveResult>,
): Promise<ResolveResult>;
export function isHostPackage(specifier: string): boolean;
