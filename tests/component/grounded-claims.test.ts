/**
 * Component tests for the grounded-claims analyzer, exercised end-to-end
 * through the real AnalyzerFramework (issue #100). No real session data, no
 * network: hand-written synthetic rows. The analyzer never touches the LLM
 * seam; the mock LLM exists only to satisfy the framework's construction and
 * prove the analyzer stays deterministic.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	tempDb,
	insertSession,
	insertMessages,
	mockFramework,
	readAnalyzerNodes,
	nodeEdges,
	type TestMessage,
} from "./helpers.js";
import {
	GROUNDED_CLAIMS_DEF,
	GROUNDED_CLAIMS_PROPERTIES,
	groundedClaimsAnalyzer,
} from "../../src/analyze/analyzers/grounded-claims/index.js";

const ANALYZER_ID = GROUNDED_CLAIMS_DEF.id;

interface SignalContent {
	user_message_id: string;
	pair_index: number;
	signal: string;
	claim_kind: string;
	claim: string;
	request_type: string | null;
	detail: string;
}

let callSeq = 0;
function bashMsg(command: string): Omit<TestMessage, "role"> & { callId: string } {
	const callId = `c${callSeq++}`;
	return {
		role: "assistant",
		stopReason: "toolUse",
		text: "",
		toolCalls: [{ id: callId, name: "bash", arguments: { command } }],
		callId,
	};
}

function toolResultFor(msg: { callId: string }, text: string): TestMessage {
	return {
		role: "toolResult",
		text,
		toolResults: [{ toolCallId: msg.callId, toolName: "bash", isError: false, textLength: text.length }],
	};
}

/** One turn with an ungrounded claim (stated number absent from results). */
function ungroundedClaimSession(): TestMessage[] {
	const run = bashMsg("npm test");
	return [
		{ role: "user", text: "Fix the failing tests." },
		run,
		toolResultFor(run, "3 tests failed"),
		{ role: "assistant", text: "Good news — all 128 tests pass now." },
	];
}

/** One turn whose request is answered without any tool call. */
function unactedRequestSession(): TestMessage[] {
	return [
		{ role: "user", text: "Please run the full test suite before we continue." },
		{ role: "assistant", text: "Everything looks good to me!" },
	];
}

/** A clean session: claims are grounded, requests acted upon. */
function cleanSession(): TestMessage[] {
	const run = bashMsg("npm test");
	return [
		{ role: "user", text: "Please run the tests." },
		run,
		toolResultFor(run, "128 tests passing, report in reports/junit.xml"),
		{ role: "assistant", text: "All 128 tests pass. Report written to reports/junit.xml." },
	];
}

describe("grounded-claims component tests", () => {
	it("emits one metric node per signal, anchored to the turn's user message", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "gc-signals");
			await insertMessages(db, "gc-signals", [
				...ungroundedClaimSession(),
				...unactedRequestSession(),
			]);

			const fw = mockFramework(db);
			void GROUNDED_CLAIMS_PROPERTIES; // schema declared; content checked field-by-field below
			await fw.register(groundedClaimsAnalyzer);
			const summary = await fw.run("gc-signals", {});
			assert.equal(summary.errors.length, 0, `run should have no errors: ${summary.errors.join("; ")}`);

			const nodes = await readAnalyzerNodes(db, ANALYZER_ID);
			assert.equal(nodes.length, 2, "one node per signal");

			const bySignal = new Map<string, SignalContent>();
			for (const n of nodes) {
				assert.equal(n.node_kind, "metric");
				const content = JSON.parse(n.content_json) as SignalContent;
				bySignal.set(content.signal, content);
			}
			assert.deepEqual([...bySignal.keys()].sort(), ["unacted-request", "ungrounded-claim"]);

			const claim = bySignal.get("ungrounded-claim")!;
			assert.equal(claim.pair_index, 0);
			assert.match(claim.detail, /128/);
			assert.equal(claim.request_type, null);

			const request = bySignal.get("unacted-request")!;
			assert.equal(request.pair_index, 1);
			assert.equal(request.request_type, "test-run");
			assert.match(request.claim, /run the full test suite/);

			// Evidence trail: every node anchors to its own turn's user message.
			for (const n of nodes) {
				const edges = await nodeEdges(db, n.id);
				const anchors = edges.filter((e) => e["edge_kind"] === "anchors" && e["to_ref_kind"] === "message");
				assert.equal(anchors.length, 1, "exactly one message anchor per node");
			}
		} finally {
			await close();
		}
	});

	it("re-running the same recipe is idempotent: no new nodes, keys unchanged", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "gc-idem");
			await insertMessages(db, "gc-idem", [...ungroundedClaimSession(), ...unactedRequestSession()]);

			const fw = mockFramework(db);
			await fw.register(groundedClaimsAnalyzer);

			const first = await fw.run("gc-idem", {});
			assert.equal(first.errors.length, 0);
			const before = await readAnalyzerNodes(db, ANALYZER_ID);
			assert.ok(before.length >= 2);

			const second = await fw.run("gc-idem", {});
			assert.equal(second.errors.length, 0);
			assert.equal(second.nodesProduced, 0, "second plain fill must produce nothing");

			const after = await readAnalyzerNodes(db, ANALYZER_ID);
			assert.deepEqual(
				after.map((n) => [n.input_key, n.output_key]).sort(),
				before.map((n) => [n.input_key, n.output_key]).sort(),
				"recipe identities unchanged",
			);
		} finally {
			await close();
		}
	});

	it("a session whose claims ground and whose requests were acted on stays quiet", async () => {
		const { db, close } = await tempDb();
		try {
			await insertSession(db, "gc-clean");
			await insertMessages(db, "gc-clean", cleanSession());

			const fw = mockFramework(db);
			await fw.register(groundedClaimsAnalyzer);
			const summary = await fw.run("gc-clean", {});
			assert.equal(summary.errors.length, 0);
			assert.equal(summary.nodesProduced, 0, "no signals for grounded work");

			const nodes = await readAnalyzerNodes(db, ANALYZER_ID);
			assert.equal(nodes.length, 0);
		} finally {
			await close();
		}
	});
});
