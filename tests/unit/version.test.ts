import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	expandReviseReasons,
	gradeVersionMove,
	parseReviseArg,
	parseVersionId,
	reachLabel,
	versionIdOf,
} from "../../src/analyze/version.js";

describe("version identity", () => {
	it("round-trips major.minor through versionIdOf/parseVersionId", () => {
		assert.equal(versionIdOf({ major: 2, minor: 3 }), "2.3");
		assert.deepEqual(parseVersionId("2.3"), { major: 2, minor: 3 });
		assert.deepEqual(parseVersionId(versionIdOf({ major: 10, minor: 0 })), { major: 10, minor: 0 });
	});

	it("parses defensively (missing minor, junk → 0)", () => {
		assert.deepEqual(parseVersionId("4"), { major: 4, minor: 0 });
		assert.deepEqual(parseVersionId(""), { major: 0, minor: 0 });
		assert.deepEqual(parseVersionId("x.y"), { major: 0, minor: 0 });
	});
});

describe("gradeVersionMove", () => {
	it("grades a higher major as major", () => {
		assert.equal(gradeVersionMove({ major: 1, minor: 5 }, { major: 2, minor: 0 }), "major");
	});

	it("grades a higher minor (same major) as minor", () => {
		assert.equal(gradeVersionMove({ major: 1, minor: 0 }, { major: 1, minor: 1 }), "minor");
	});

	it("returns null for equal versions and for downgrades", () => {
		assert.equal(gradeVersionMove({ major: 1, minor: 2 }, { major: 1, minor: 2 }), null);
		assert.equal(gradeVersionMove({ major: 2, minor: 0 }, { major: 1, minor: 9 }), null);
		assert.equal(gradeVersionMove({ major: 1, minor: 5 }, { major: 1, minor: 4 }), null);
	});
});

describe("expandReviseReasons", () => {
	it("makes minor imply major", () => {
		assert.deepEqual([...expandReviseReasons(["minor"])].sort(), ["major", "minor"]);
	});

	it("leaves major and config alone", () => {
		assert.deepEqual([...expandReviseReasons(["major"])], ["major"]);
		assert.deepEqual([...expandReviseReasons(["config"])], ["config"]);
		assert.deepEqual([...expandReviseReasons([])], []);
	});
});

describe("parseReviseArg", () => {
	it("parses individual reasons and ignores unknown tokens", () => {
		assert.deepEqual(parseReviseArg("major"), ["major"]);
		assert.deepEqual(parseReviseArg("config"), ["config"]);
		assert.deepEqual(parseReviseArg("nonsense"), []);
		assert.deepEqual(parseReviseArg(""), []);
	});

	it("parses comma lists and dedupes", () => {
		assert.deepEqual(parseReviseArg("minor,config").sort(), ["config", "minor"]);
		assert.deepEqual(parseReviseArg("major,major").sort(), ["major"]);
	});

	it("expands `all` to every reason", () => {
		assert.deepEqual(parseReviseArg("all").sort(), ["config", "major", "minor"]);
	});
});

describe("reachLabel", () => {
	it("labels an empty reach as fill", () => {
		assert.equal(reachLabel([]), "fill");
		assert.equal(reachLabel(new Set()), "fill");
	});

	it("labels a non-empty reach as a sorted revise set", () => {
		assert.equal(reachLabel(["config", "major"]), "revise:config+major");
		assert.equal(reachLabel(new Set(["major", "minor"])), "revise:major+minor");
	});
});
