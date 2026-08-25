/**
 * Unit tests for the language-mismatch analyzer's deterministic script
 * detection (issue #151). Pure functions, no database, no mocks, no real
 * session data — hand-written synthetic strings only.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_LANGUAGE_MISMATCH_CONFIG } from "../../src/analyze/analyzers/language-mismatch/config.js";
import type { LanguageMismatchConfig } from "../../src/analyze/analyzers/language-mismatch/config.js";
import {
	detectScript,
	scanSession,
	stripNonProse,
	type ScriptJudgement,
} from "../../src/analyze/analyzers/language-mismatch/detect.js";
import type { TurnPair } from "../../src/analyze/analyzers/turn-pair-core/build.js";
import type { MessageRow } from "../../src/analyze/types.js";

const CONFIG: LanguageMismatchConfig = { ...DEFAULT_LANGUAGE_MISMATCH_CONFIG };

// ─────────────────────────── helpers ───────────────────────────

function judge(text: string, config: LanguageMismatchConfig = CONFIG): ScriptJudgement {
	return detectScript(text, config);
}

let pairSeq = 0;
function pair(userText: string, assistantText: string): TurnPair {
	const index = pairSeq++;
	return {
		index,
		userMessageId: `um-${index}`,
		messageIds: [`um-${index}`, `am-${index}`],
		userText,
		assistantText,
		thinkingText: "",
		toolCalls: [],
		toolResults: [],
		priorUserText: null,
		timestamp: null,
	};
}

let rowSeq = 0;
function row(role: string, text: string): MessageRow {
	const id = `row-${rowSeq++}`;
	return {
		id,
		session_id: "s",
		parent_id: null,
		timestamp: null,
		role,
		content_text: text,
		content_thinking: null,
		tool_calls: null,
		tool_results: null,
		model: null,
		cost_usd: null,
		stop_reason: null,
		error_message: null,
	};
}

// Long synthetic sentences per script (each well past the 40-letter minimum,
// containing nothing from any other script).
const LATIN = "The quick brown fox jumps over the lazy dog while the calm river flows beneath the old stone bridge.";
const CYRILLIC = "Съешь же ещё этих мягких французских булок да выпей чаю и отдыхай спокойно до самого утра.";
const GREEK = "Θέλω να δω το φως του ηλιου να λαμπει πανω απο τα βουνα αυριο το πρωι με καθαρο ουρανο.";
const HEBREW = "השמש זורחת מעל ההרים והנהר זורם בשקט לתוך העמק הירוק שמעבר לגשר הישן בבוקר.";
const ARABIC = "السماء صافية اليوم والشمس تشرق من فوق الجبال البعيدة حيث تجري الانهاه بسلام طوال اليوم.";
const DEVANAGARI = "सूरज आज बहुत तेज चमक रहा है और नदी के किनारे बच्चे खेल रहे हैं पूरे दिन खुशी से।";
const THAI = "วันนี้อากาศดีมากและแดดส่องสว่างเหนือภูเขาไกลที่มีแม่นำไหลเบาๆตลอดวันจริงๆ";
const JAPANESE = "今日はとても良い天気ですね。川のそばで子供たちが楽しそうに遊んでいます。桜の花が春風に舞って、公園全体が美しい色に包まれています。";
const CHINESE = "今天天气非常好，孩子们在河边高兴地玩耍，太阳照在远处的山上，河水静静地流着，远处的田野里开满了金黄色的花朵。";
const KOREAN = "오늘날씨가정말좋습니다강가에서아이들이즐겁게놀고있습니다산책하기좋은날입니다벚꽃이피는봄날에공원에서친구들과함께시간을보냈습니다.";

// ─────────────────────────── script detection ───────────────────────────

describe("detectScript", () => {
	it("judges each supported script as itself", () => {
		const cases: Array<[string, string]> = [
			[LATIN, "latin"],
			[CYRILLIC, "cyrillic"],
			[GREEK, "greek"],
			[HEBREW, "hebrew"],
			[ARABIC, "arabic"],
			[DEVANAGARI, "devanagari"],
			[THAI, "thai"],
			[JAPANESE, "japanese"],
			[CHINESE, "chinese"],
			[KOREAN, "korean"],
		];
		for (const [text, expected] of cases) {
			assert.equal(judge(text).script, expected, `${expected} text judged as ${expected}`);
		}
	});

	it("skips punctuation-only and emoji-only texts", () => {
		for (const text of ["!!! ??? ... ---", "🙂 🙂 🙂 🔥", "; ; ; :"]) {
			const j = judge(text);
			assert.equal(j.script, null);
			assert.equal(j.letterCount, 0);
		}
	});

	it("skips texts below minTextLength even when unambiguous", () => {
		assert.equal(judge("yes ok fine").script, null);
		assert.equal(judge(CYRILLIC.slice(0, 20)).script, null);
	});

	it("skips mixed-script text where no script dominates", () => {
		const half = Math.floor(LATIN.length / 2);
		const mixed = LATIN.slice(0, half) + " " + CYRILLIC.slice(0, CYRILLIC.length / 2 + 10);
		assert.equal(judge(mixed).script, null);
	});

	it("prefers kana presence into japanese even when kanji dominate the count", () => {
		// Mostly kanji with just enough kana to settle the judgement.
		const mostlyKanji = "今日は良い天気です。私達は図書館で新しい技術に関する本を読みました。非常に面白かったです。明日も続けます。";
		assert.equal(judge(mostlyKanji).script, "japanese");
	});

	it("strips fenced code blocks before counting", () => {
		const prose = "Please review this change carefully and explain what the function actually does here.";
		const code = "\n```js\nconst приветствие = 'здравствуйте товарищ';\nconst ещё = 1;\n```\n";
		// The Cyrillic identifiers really are in the raw text — stripping is what
		// removes them, so they cannot flip a Latin-prose verdict.
		assert.ok(code.includes("приветствие"));
		assert.equal(stripNonProse(code).trim(), "");
		assert.equal(judge(prose + code).script, "latin", "Cyrillic identifiers inside a fenced block do not flip the verdict");
	});

	it("strips inline code spans and URLs before counting", () => {
		const prose = "Check the configuration value documented right here in the manual section about startup flags.";
		assert.equal(stripNonProse("`значение`").trim(), "", "inline code spans are removed entirely");
		const inline = prose.replace("value", "`значение`").replace("flags.", "flags see https://example.com/значение");
		assert.equal(judge(inline).script, "latin");
	});
});

// ─────────────────────────── session scan ───────────────────────────

describe("scanSession", () => {
	it("flags a turn whose response script differs from the user's", () => {
		const scan = scanSession([pair(LATIN, CYRILLIC)], [], CONFIG);
		assert.equal(scan.turns.length, 1);
		const t = scan.turns[0]!;
		assert.equal(t.mismatched, true);
		assert.equal(t.user_script, "latin");
		assert.equal(t.assistant_script, "cyrillic");
	});

	it("does not flag a turn whose response matches the user's script", () => {
		const scan = scanSession([pair(LATIN, "And here is a perfectly ordinary reply written in plain English words.")], [], CONFIG);
		assert.equal(scan.turns.length, 1);
		assert.equal(scan.turns[0]!.mismatched, false);
	});

	it("skips turns where either side is too short or noisy", () => {
		const scan = scanSession(
			[pair("ok", CYRILLIC), pair(LATIN, "sure"), pair("", "")],
			[],
			CONFIG,
		);
		assert.deepEqual(scan.turns, []);
	});

	it("flags a compaction summary in a different script than the conversation it compresses", () => {
		const messages = [
			row("user", "First question about the failing build pipeline this morning."),
			row("assistant", "Looking into it now."),
			row("user", "Second question: could you also check the deploy logs afterwards please?"),
			row("compactionSummary", CYRILLIC),
		];
		const scan = scanSession([], messages, CONFIG);
		assert.equal(scan.compactions.length, 1);
		const c = scan.compactions[0]!;
		assert.equal(c.mismatched, true);
		assert.equal(c.conversation_script, "latin");
		assert.equal(c.summary_script, "cyrillic");
	});

	it("does not flag a compaction summary in the conversation's own script", () => {
		const messages = [
			row("user", LATIN),
			row("compactionSummary", "So far we examined the failing build pipeline and found one suspicious flag."),
		];
		const scan = scanSession([], messages, CONFIG);
		assert.equal(scan.compactions.length, 1);
		assert.equal(scan.compactions[0]!.mismatched, false);
	});

	it("skips a compaction summary too short to judge, or with no judgable conversation behind it", () => {
		const short = [row("user", LATIN), row("compactionSummary", "Краткое резюме.")]
		const scanShort = scanSession([], short, CONFIG);
		assert.deepEqual(scanShort.compactions, []);

		const empty = [row("assistant", CYRILLIC), row("compactionSummary", CYRILLIC)];
		const scanEmpty = scanSession([], empty, CONFIG);
		assert.deepEqual(scanEmpty.compactions, [], "no user text precedes the summary, so there is nothing to compare against");
	});

	it("honours checkCompaction: false by producing no compaction verdicts", () => {
		const off: LanguageMismatchConfig = { ...CONFIG, checkCompaction: false };
		const messages = [row("user", LATIN), row("compactionSummary", CYRILLIC)];
		const scan = scanSession([], messages, off);
		assert.deepEqual(scan.compactions, []);
	});
});
