import { tempDb, type TempDb } from "./helpers.js";
import { fingerprintOf, sectionOf, seedNode, seedRun, seedSession, type Section } from "./fingerprint-seed.js";

/** One section test's graph: a temporary database, seeded through the shared helpers. */
export class GraphSeed {
	private constructor(readonly t: TempDb) {}

	static async open(): Promise<GraphSeed> {
		return new GraphSeed(await tempDb());
	}

	close(): Promise<void> {
		return this.t.close();
	}

	node(sessionId: string, analyzerId: string, content: unknown, version = "1.0"): Promise<void> {
		return seedNode(this.t.db, sessionId, analyzerId, content, version);
	}

	/** A session the analyzer ran on, with one node of the given content (none when `content` is null). */
	async analysed(id: string, analyzerId: string, content: unknown, version = "1.0"): Promise<void> {
		await seedSession(this.t.db, id);
		await seedRun(this.t.db, id, analyzerId, version);
		if (content !== null) await this.node(id, analyzerId, content, version);
	}

	async section(kind: "objective" | "inferred", id: string): Promise<Section> {
		return sectionOf(await fingerprintOf(this.t.db), kind, id);
	}
}
