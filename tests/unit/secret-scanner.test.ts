/**
 * Unit tests for the SecretScanner-style container/filesystem evidence
 * detector: pure extraction and pure detection, no database, no mocks.
 *
 * Synthetic credentials are built by concatenation/PRNG so no contiguous
 * realistic literal exists in source (GitHub push protection).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	extractArtifactCandidates,
	extractContainerfileCandidates,
	extractDotenvCandidates,
	extractBuildLogCandidates,
	extractCiLogCandidates,
	extractShellExportCandidates,
	type ArtifactCandidate,
} from "../../src/analyze/analyzers/secret-scanner/extractors.js";
import {
	detectArtifactLeaks,
	hasCredentialShape,
	ARTIFACT_CATALOGUE_RULES,
	STRUCTURAL_RULE_ID,
} from "../../src/analyze/analyzers/secret-scanner/detectors.js";
import { DEFAULT_SECRET_SCANNER_CONFIG } from "../../src/analyze/analyzers/secret-scanner/config.js";
import { fingerprintOf } from "../../src/analyze/analyzers/secret-scanner/index.js";
import type { MessageRow } from "../../src/analyze/types.js";

// ──────────────────────────── helpers ────────────────────────────

function makeRng(seed: number): () => number {
	let a = seed >>> 0;
	return function () {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
function pseudo(len: number, seed: number, charset: string): string {
	const rng = makeRng(seed);
	let s = "";
	for (let i = 0; i < len; i++) s += charset[Math.floor(rng() * charset.length)];
	return s;
}
const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** Shape-correct, never-live GitHub classic PAT (matches github_pat_classic). */
const GHP = ["ghp_", pseudo(36, 42, ALNUM)].join("");
/** Credential-shaped random value no catalogue rule matches. */
const RANDOM_SECRET = pseudo(32, 7, ALNUM);

let seq = 0;
function msg(partial: Partial<MessageRow> & { id?: string }): MessageRow {
	const id = partial.id ?? `m-${seq++}`;
	return {
		id,
		session_id: partial.session_id ?? "s1",
		parent_id: partial.parent_id ?? null,
		timestamp: partial.timestamp ?? null,
		role: partial.role ?? "user",
		content_text: partial.content_text ?? null,
		content_thinking: partial.content_thinking ?? null,
		tool_calls: partial.tool_calls ?? null,
		tool_results: partial.tool_results ?? null,
		model: partial.model ?? null,
		cost_usd: partial.cost_usd ?? null,
		stop_reason: partial.stop_reason ?? null,
		error_message: partial.error_message ?? null,
	};
}

function keysOf(cands: ArtifactCandidate[]): string[] {
	return cands.map((c) => c.key);
}
function valueOf(cands: ArtifactCandidate[], key: string): string {
	const c = cands.find((x) => x.key === key);
	assert.ok(c, `expected a candidate for key ${key}`);
	return c.value;
}

// ──────────────────────────── extractors ────────────────────────────

describe("containerfile extractor", () => {
	const DOCKERFILE = [
		"FROM node:22-alpine",
		"WORKDIR /app",
		`ENV GITHUB_TOKEN=${GHP}`,
		"ENV NODE_ENV=production",
		"ENV LEGACY_STYLE somevalue",
		`ARG BUILD_TOKEN=${RANDOM_SECRET}`,
		'RUN echo "built"',
	].join("\n");

	it("extracts ENV/ARG candidates only when containerfile instructions are present", () => {
		const cands = extractContainerfileCandidates(DOCKERFILE);
		assert.ok(keysOf(cands).includes("GITHUB_TOKEN"));
		assert.ok(keysOf(cands).includes("NODE_ENV"));
		assert.ok(keysOf(cands).includes("BUILD_TOKEN"));
		assert.equal(valueOf(cands, "GITHUB_TOKEN"), GHP);
		assert.equal(valueOf(cands, "BUILD_TOKEN"), RANDOM_SECRET);
		// Multi-key ENV line: both keys carry the dockerfile kind and location.
		const tok = cands.find((c) => c.key === "GITHUB_TOKEN")!;
		assert.equal(tok.kind, "dockerfile");
		assert.equal(tok.location, "ENV in Dockerfile");
		// ARG lines are labelled as such.
		const arg = cands.find((c) => c.key === "BUILD_TOKEN")!;
		assert.equal(arg.location, "ARG in Dockerfile");
		// Offsets point at the key within the text.
		assert.equal(DOCKERFILE.slice(tok.index, tok.index + tok.key.length), "GITHUB_TOKEN");
	});

	it("reads the legacy space-separated ENV form", () => {
		const cands = extractContainerfileCandidates(DOCKERFILE);
		const legacy = cands.find((c) => c.key === "LEGACY_STYLE");
		assert.ok(legacy);
		assert.equal(legacy.value, "somevalue");
	});

	it("ignores ENV-looking prose without containerfile evidence", () => {
		const prose = `ENV is a Dockerfile instruction. The token GITHUB_TOKEN=${GHP} leaked.`;
		assert.deepEqual(extractContainerfileCandidates(prose), []);
	});

	it("extracts compose environment sections (list and mapping forms)", () => {
		const compose = [
			"services:",
			"  worker:",
			"    image: worker:1",
			"    environment:",
			`      - GITHUB_TOKEN=${GHP}`,
			"      - NODE_ENV=production",
			"    variables:",
			"      BUILD_TOKEN: \"abc\"",
			"    command: run",
		].join("\n");
		const cands = extractContainerfileCandidates(compose);
		const tok = cands.find((c) => c.key === "GITHUB_TOKEN");
		assert.ok(tok);
		assert.equal(tok.value, GHP);
		assert.equal(tok.kind, "compose");
		assert.equal(tok.location, "compose environment block");
		// Mapping form, quotes stripped.
		assert.equal(valueOf(cands, "BUILD_TOKEN"), "abc");
		// The section ends at `command:` — nothing after it is an env entry.
		assert.ok(!keysOf(cands).includes("command"));
	});
});

describe("dotenv extractor", () => {
	it("extracts entries after a .env mention", () => {
		const text = [
			"let me check the env file",
			"$ cat .env",
			`GITHUB_TOKEN=${GHP}`,
			"DATABASE_URL=postgres://localhost/app",
		].join("\n");
		const cands = extractDotenvCandidates(text);
		const tok = cands.find((c) => c.key === "GITHUB_TOKEN");
		assert.ok(tok);
		assert.equal(tok.value, GHP);
		assert.equal(tok.kind, "dotenv");
		assert.equal(tok.location, ".env entry");
	});

	it("extracts uppercase KEY=value blocks without a mention (3+ consecutive lines)", () => {
		const text = [
			"the deploy wrote:",
			"REGION=us-east-1",
			`GITHUB_TOKEN=${GHP}`,
			"MAX_RETRIES=5",
			"done",
		].join("\n");
		const cands = extractDotenvCandidates(text);
		assert.ok(cands.find((c) => c.key === "GITHUB_TOKEN"));
		assert.ok(cands.find((c) => c.key === "REGION"));
	});

	it("does not treat an isolated KEY=value line as dotenv", () => {
		const text = `GITHUB_TOKEN=${GHP}`;
		assert.deepEqual(extractDotenvCandidates(text), []);
	});
});

describe("build-log extractor", () => {
	it("extracts ENV from classic and BuildKit step lines", () => {
		const log = [
			"Sending build context to Docker daemon  12.4kB",
			`Step 3/9 : ENV GITHUB_TOKEN=${GHP}`,
			" ---> Running in 4f2a9c1b",
			`=> [4/9] ARG BUILD_TOKEN=${RANDOM_SECRET}`,
		].join("\n");
		const cands = extractBuildLogCandidates(log);
		assert.equal(valueOf(cands, "GITHUB_TOKEN"), GHP);
		assert.equal(valueOf(cands, "BUILD_TOKEN"), RANDOM_SECRET);
		const tok = cands.find((c) => c.key === "GITHUB_TOKEN")!;
		assert.equal(tok.kind, "build-log");
		assert.equal(tok.location, "docker build log");
	});

	it("extracts --build-arg flags", () => {
		const log = `$ docker build --build-arg GITHUB_TOKEN=${GHP} -t app .`;
		const cands = extractBuildLogCandidates(log);
		const tok = cands.find((c) => c.key === "GITHUB_TOKEN");
		assert.ok(tok);
		assert.equal(tok.value, GHP);
		assert.equal(tok.location, "docker build --build-arg");
	});
});

describe("ci-log extractor", () => {
	it("extracts ::set-env workflow commands", () => {
		const log = [`::set-env name=GITHUB_TOKEN::${GHP}`, "all done"].join("\n");
		const cands = extractCiLogCandidates(log);
		const tok = cands.find((c) => c.key === "GITHUB_TOKEN");
		assert.ok(tok);
		assert.equal(tok.value, GHP);
		assert.equal(tok.kind, "ci-log");
		assert.equal(tok.location, "CI log set-env");
	});

	it("extracts workflow env mapping blocks", () => {
		const yaml = [
			"jobs:",
			"  deploy:",
			"    env:",
			`      GITHUB_TOKEN: ${GHP}`,
			"      REGION: us-east-1",
			"    steps: [build]",
		].join("\n");
		const cands = extractCiLogCandidates(yaml);
		const tok = cands.find((c) => c.key === "GITHUB_TOKEN");
		assert.ok(tok);
		assert.equal(tok.value, GHP);
		assert.equal(tok.location, "workflow env block");
	});
});

describe("shell-export extractor", () => {
	it("extracts quoted and bare export assignments", () => {
		const text = [
			"#!/bin/sh",
			`export GITHUB_TOKEN="${GHP}"`,
			`export BUILD_TOKEN='${RANDOM_SECRET}'`,
			"export NODE_ENV=production",
		].join("\n");
		const cands = extractShellExportCandidates(text);
		assert.equal(valueOf(cands, "GITHUB_TOKEN"), GHP);
		assert.equal(valueOf(cands, "BUILD_TOKEN"), RANDOM_SECRET);
		assert.equal(valueOf(cands, "NODE_ENV"), "production");
		const tok = cands.find((c) => c.key === "GITHUB_TOKEN")!;
		assert.equal(tok.kind, "shell-export");
		assert.equal(tok.location, "shell export");
		assert.equal(text.slice(tok.index, tok.index + tok.key.length), "GITHUB_TOKEN");
	});

	it("ignores assignments without the export keyword", () => {
		const text = `GITHUB_TOKEN=${GHP}`;
		assert.deepEqual(extractShellExportCandidates(text), []);
	});
});

// ──────────────────────────── value filters ────────────────────────────

describe("value filters", () => {
	it("credential shape requires length, no whitespace, letters and digits", () => {
		assert.equal(hasCredentialShape(RANDOM_SECRET, 16), true);
		assert.equal(hasCredentialShape("short1", 16), false);
		assert.equal(hasCredentialShape("no digits here at all", 16), false);
		assert.equal(hasCredentialShape("12345678901234567890", 16), false);
		assert.equal(hasCredentialShape("has whitespace inside 12345", 16), false);
	});

	it("masked, interpolated, placeholder and path values are never reported", () => {
		const dockerfile = [
			"FROM alpine",
			"ENV A_TOKEN=****************",
			"ENV B_TOKEN=[masked]",
			"ENV C_TOKEN=${OTHER_VAR}",
			"ENV D_TOKEN=your-token-here",
			"ENV E_TOKEN=<paste-your-token>",
			"ENV F_TOKEN=/var/lib/state1",
		].join("\n");
		const scan = detectArtifactLeaks([msg({ content_text: dockerfile })]);
		assert.equal(scan.leak_count, 0, JSON.stringify(scan.leaks.map((l) => l.key_name)));
	});
});

// ──────────────────────────── detection ────────────────────────────

describe("detection", () => {
	it("reports a catalogue match inside a Dockerfile ENV and names the rule family", () => {
		const dockerfile = ["FROM node:22", `ENV GITHUB_TOKEN=${GHP}`].join("\n");
		const scan = detectArtifactLeaks([msg({ content_text: dockerfile })]);
		assert.equal(scan.leak_count, 1);
		const leak = scan.leaks[0]!;
		assert.equal(leak.rule_id, "github_pat_classic");
		assert.equal(leak.severity, "critical");
		assert.equal(leak.artifact_kind, "dockerfile");
		assert.equal(leak.artifact_location, "ENV in Dockerfile");
		assert.equal(leak.key_name, "GITHUB_TOKEN");
		assert.equal(leak.fingerprint, fingerprintOf(GHP));
		assert.ok(!leak.redacted_preview.includes(GHP.slice(4, -4)));
	});

	it("reports a structural match for a sensitive name with credential shape and no catalogue rule", () => {
		const text = ["$ cat .env", `DEPLOY_TOKEN=${RANDOM_SECRET}`].join("\n");
		const scan = detectArtifactLeaks([msg({ content_text: text })]);
		assert.equal(scan.leak_count, 1);
		const leak = scan.leaks[0]!;
		assert.equal(leak.rule_id, STRUCTURAL_RULE_ID);
		assert.equal(leak.confidence, "active");
		assert.equal(leak.artifact_kind, "dotenv");
		assert.equal(leak.fingerprint, fingerprintOf(RANDOM_SECRET));
	});

	it("does NOT flag benign assignments (PATH, LANG, HOME, NODE_ENV)", () => {
		const dockerfile = [
			"FROM ubuntu:24.04",
			"ENV PATH=/usr/local/bin:/usr/bin:/bin",
			"ENV LANG=en_US.UTF-8",
			"ENV HOME=/root",
			"ENV NODE_ENV=production",
		].join("\n");
		const shell = [
			"export PATH=/usr/local/sbin:/usr/local/bin",
			"export LANG=en_US.UTF-8",
			"export EDITOR=vim",
		].join("\n");
		const scan = detectArtifactLeaks([
			msg({ content_text: dockerfile }),
			msg({ content_text: shell }),
		]);
		assert.equal(scan.leak_count, 0, JSON.stringify(scan.leaks.map((l) => l.key_name)));
	});

	it("does not flag a sensitive name whose value lacks credential shape", () => {
		const text = ["$ cat .env", "API_TOKEN=1", "DB_PASSWORD=true"].join("\n");
		const scan = detectArtifactLeaks([msg({ content_text: text })]);
		assert.equal(scan.leak_count, 0);
	});

	it("scans tool_calls fields (a Dockerfile written via a write tool)", () => {
		const toolCalls = JSON.stringify([
			{
				name: "write",
				arguments: { path: "Dockerfile", content: ["FROM node:22", `ENV GITHUB_TOKEN=${GHP}`].join("\n") },
			},
		]);
		const scan = detectArtifactLeaks([msg({ tool_calls: toolCalls })]);
		assert.equal(scan.leak_count, 1);
		assert.equal(scan.leaks[0]!.field, "tool_calls");
		assert.equal(scan.leaks[0]!.artifact_kind, "dockerfile");
	});

	it("counts findings per rule and per artifact kind", () => {
		const text = [
			"FROM node:22",
			`ENV GITHUB_TOKEN=${GHP}`,
			`ARG DEPLOY_TOKEN=${RANDOM_SECRET}`,
		].join("\n");
		const scan = detectArtifactLeaks([msg({ content_text: text })]);
		assert.equal(scan.leak_count, 2);
		assert.equal(scan.rule_counts["github_pat_classic"], 1);
		assert.equal(scan.rule_counts[STRUCTURAL_RULE_ID], 1);
		assert.equal(scan.artifact_counts["dockerfile"], 2);
		assert.deepEqual(scan.affected_message_ids, [scan.leaks[0]!.message_id]);
	});

	it("honours disabledRules for both structural and catalogue families", () => {
		const text = ["FROM node:22", `ENV GITHUB_TOKEN=${GHP}`, `ARG DEPLOY_TOKEN=${RANDOM_SECRET}`].join("\n");
		const scan = detectArtifactLeaks([msg({ content_text: text })], {
			...DEFAULT_SECRET_SCANNER_CONFIG,
			disabledRules: [STRUCTURAL_RULE_ID],
		});
		assert.equal(scan.leak_count, 1);
		assert.equal(scan.leaks[0]!.rule_id, "github_pat_classic");

		const scan2 = detectArtifactLeaks([msg({ content_text: text })], {
			...DEFAULT_SECRET_SCANNER_CONFIG,
			disabledRules: ["github_pat_classic"],
		});
		// Disabling one catalogue family must not silence the same value when
		// another family (gitleaks' own ghp_ rule) still matches it.
		assert.ok(scan2.leaks.every((l) => l.rule_id !== "github_pat_classic"));
		assert.ok(scan2.leaks.some((l) => l.rule_id === STRUCTURAL_RULE_ID));
	});

	it("honours extraction toggles", () => {
		const text = ["$ cat .env", `DEPLOY_TOKEN=${RANDOM_SECRET}`].join("\n");
		const scan = detectArtifactLeaks([msg({ content_text: text })], {
			...DEFAULT_SECRET_SCANNER_CONFIG,
			extractDotenv: false,
		});
		assert.equal(scan.leak_count, 0);
	});

	it("honours fingerprint and shape allowlists", () => {
		const text = ["FROM node:22", `ENV GITHUB_TOKEN=${GHP}`].join("\n");
		const byFp = detectArtifactLeaks([msg({ content_text: text })], {
			...DEFAULT_SECRET_SCANNER_CONFIG,
			allowFingerprints: [fingerprintOf(GHP)],
		});
		assert.equal(byFp.leak_count, 0);
		assert.equal(byFp.allowlisted_matches, 1);

		const byShape = detectArtifactLeaks([msg({ content_text: text })], {
			...DEFAULT_SECRET_SCANNER_CONFIG,
			allowPatterns: ["^ghp_"],
		});
		assert.equal(byShape.leak_count, 0);
		assert.equal(byShape.allowlisted_matches, 1);
	});

	it("caps matches per field and counts the truncation", () => {
		const lines = ["FROM node:22"];
		for (let i = 0; i < 5; i++) {
			lines.push(`ENV TOKEN_${i}=${pseudo(32, 100 + i, ALNUM)}`);
		}
		const scan = detectArtifactLeaks([msg({ content_text: lines.join("\n") })], {
			...DEFAULT_SECRET_SCANNER_CONFIG,
			maxMatchesPerField: 2,
		});
		assert.equal(scan.leak_count, 2);
		assert.equal(scan.truncated_matches, 3);
	});

	it("throws on an unknown disabledRules id (no silent catches)", () => {
		assert.throws(
			() => detectArtifactLeaks([msg({ content_text: "x" })], {
				...DEFAULT_SECRET_SCANNER_CONFIG,
				disabledRules: ["not-a-rule"],
			}),
			/not-a-rule/,
		);
	});

	it("catalogue union is deduplicated by id", () => {
		const ids = ARTIFACT_CATALOGUE_RULES.map((r) => r.id);
		assert.equal(new Set(ids).size, ids.length);
		assert.ok(ids.includes("github_pat_classic"));
	});

	it("is deterministic: same input, same findings in the same order", () => {
		const text = [
			"FROM node:22",
			`ENV GITHUB_TOKEN=${GHP}`,
			`ARG DEPLOY_TOKEN=${RANDOM_SECRET}`,
			"$ cat .env",
			`SERVICE_SECRET=${pseudo(24, 99, ALNUM)}`,
		].join("\n");
		const a = detectArtifactLeaks([msg({ id: "m-det", content_text: text })]);
		const b = detectArtifactLeaks([msg({ id: "m-det", content_text: text })]);
		assert.deepEqual(a, b);
	});
});

describe("extractor facade", () => {
	it("merges all extractors and dedupes by (kind, index)", () => {
		const text = [
			"FROM node:22",
			`ENV GITHUB_TOKEN=${GHP}`,
			"$ cat .env",
			`DEPLOY_TOKEN=${RANDOM_SECRET}`,
			`export BUILD_TOKEN=${pseudo(24, 55, ALNUM)}`,
		].join("\n");
		const cands = extractArtifactCandidates(text, {
			extractDockerfiles: true,
			extractDotenv: true,
			extractBuildLogs: true,
			extractCiLogs: true,
			extractShellExports: true,
		});
		const seen = new Set(cands.map((c) => `${c.kind}\u0000${c.index}`));
		assert.equal(seen.size, cands.length);
		assert.ok(cands.some((c) => c.kind === "dockerfile"));
		assert.ok(cands.some((c) => c.kind === "dotenv"));
		assert.ok(cands.some((c) => c.kind === "shell-export"));
		// Sorted by index.
		const indices = cands.map((c) => c.index);
		assert.deepEqual([...indices].sort((a, b) => a - b), indices);
	});
});
