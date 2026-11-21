import * as fs from "node:fs";
import { openAsyncDatabase, type AsyncDatabase } from "./async-db.js";
import { migrate } from "./schema.js";
import { loadOnce } from "../lazy.js";

/**
 * Open the index for a command that only reads it.
 *
 * `migrate` writes: it sets the journal mode, creates what is missing, and
 * rewrites tables whose shape moved. A reader that ran it would change the
 * index it claims only to read, so a read-only command opens the file
 * read-only and checks the schema instead. When the file lacks a table or a
 * column that this build's schema has, the command stops and names the
 * command that upgrades it, rather than reading a partial schema or upgrading
 * it behind the user's back.
 */

/** Every table and view of a schema, each with its columns. */
async function schemaShape(db: AsyncDatabase): Promise<Map<string, Set<string>>> {
	const rows = (await db
		.prepare(
			`SELECT m.name AS object, p.name AS col
			   FROM sqlite_master m LEFT JOIN pragma_table_info(m.name) p
			  WHERE m.type IN ('table', 'view') AND m.name NOT LIKE 'sqlite_%'`,
		)
		.all()) as Array<{ object: string; col: string | null }>;
	const shape = new Map<string, Set<string>>();
	for (const { object, col } of rows) {
		const cols = shape.get(object) ?? new Set<string>();
		if (col !== null) cols.add(col);
		shape.set(object, cols);
	}
	return shape;
}

/** The schema this build creates: `migrate` run on an empty in-memory database, once per process. */
const currentShape = loadOnce(async () => {
	const db = openAsyncDatabase(":memory:");
	try {
		await migrate(db);
		return await schemaShape(db);
	} finally {
		await db.close();
	}
});

/**
 * The tables, views and columns this build's schema has and the open database
 * lacks, as `table` or `table.column`. Empty when the database is current.
 */
export async function schemaGaps(db: AsyncDatabase): Promise<string[]> {
	const have = await schemaShape(db);
	const gaps: string[] = [];
	for (const [object, cols] of await currentShape()) {
		const present = have.get(object);
		if (present === undefined) {
			gaps.push(object);
			continue;
		}
		for (const col of cols) if (!present.has(col)) gaps.push(`${object}.${col}`);
	}
	return gaps;
}

/**
 * Open the index at `path` read-only. Throws when there is no file there, or
 * when its schema is older than this build's; either way the file is left as
 * it was.
 */
export async function openReadOnlyIndex(path: string): Promise<AsyncDatabase> {
	if (!fs.existsSync(path)) throw new Error(`no index at ${path}; run \`prospect sync\` to build it`);
	const db = openAsyncDatabase(path, { readonly: true });
	let gaps: string[];
	try {
		gaps = await schemaGaps(db);
	} catch (err) {
		await db.close();
		throw err;
	}
	if (gaps.length > 0) {
		await db.close();
		const shown = gaps.slice(0, 3).join(", ") + (gaps.length > 3 ? `, and ${gaps.length - 3} more` : "");
		throw new Error(`the index at ${path} is older than this version of pi-prospector (it lacks ${shown}); run \`prospect sync\` or \`prospect analyze\` to upgrade it, then try again`);
	}
	return db;
}
