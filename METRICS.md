# pi-prospector metrics reference

This document defines each metric that pi-prospector stores or that a report built on it prints. An entry gives the name, the definition, how the value is decided, the unit and denominator, and the known limits. The vocabulary is the one in [`DESIGN.md`](./DESIGN.md), section "Measurement and comparability". Read that section first.

The document has no counts from any real corpus. A figure about a corpus belongs in a report, with its date and the analyzer versions it rests on.

## How to read an entry

Each entry has four fields.

- **Definition**: one sentence in the project's vocabulary.
- **Measured by**: the measurement class (counted, rule-based, or inferred), the analyzer that decides it, and the version where the meaning depends on one.
- **Unit and denominator**: what the number counts and what a rate is a share of.
- **Limits**: what the number does not show, and what moves it without any change in the user's practice.

To see which analyzer version and model produced a node, run `prospect nodes --analyzer ID --all-versions`. Each node records its analyzer version, its config, and the model it used.

## Limits that apply to every metric

Each entry omits the limits below, which apply everywhere. Check them before reading any trend.

1. **Harness differences.** Pi, Claude Code, Codex, OpenCode and Cline record different things. They name tools differently and flag errors by their own rules. Each files injected text under a different role. Only Pi, OpenCode and Cline record a billed cost. A share that moves when the mix of harnesses moves says nothing about behaviour. Split by harness before reading a trend, and expect a small harness to rest on few sessions.
2. **A user-role message may not be typed by a person.** Hosts file pasted text, text another agent wrote, task notifications and forked copies under the user role. Any metric that counts or reads user messages mixes the person's words with those. The text origin label separates them, but only turn-frustration hits have it today. A separate change that labels origin on every user-role message is in progress. Until it merges, a count of prompts is an upper bound on what the person typed.
3. **Analyzer versions and models change.** Under a plain run, a node is computed once under one recipe. A monthly series mixes versions and models, unless a revise run brought every node to the current recipe. See "Known series breaks" below.
4. **Capture eras.** The sync layer stores more fields over time. A session indexed before a field was stored has no value for it, and the value reads as unknown. Syncing the session again recovers the fields that live in its transcript. The tool inventory is the exception, because no transcript keeps it.
5. **Parallel work.** Several sessions and agents run at once. The sum of per-session time or cost across sessions is agent time and not the person's time. Use per-session medians for anything about the person.

Timestamps are UTC, and a session belongs to the month of its first message.

## Session shape

### Sessions and child sessions

- **Definition**: a session is one recorded conversation. A top-level session has no parent session. A child session is a sub-agent or workflow run that a parent started.
- **Measured by**: counted from the index. The parent link comes from the host's own record.
- **Unit and denominator**: sessions. A report says whether it counts all sessions or top-level sessions only.
- **Limits**: a session of a few steps counts the same as a long one. To count working sessions only, a report sets its own floor (see "Figures a report computes itself"). A child session exists only where the harness or an extension writes its transcript to a place the sync layer reads.

### Share of sessions by harness

- **Definition**: the share of sessions whose source is `pi`, `claude`, `codex`, `opencode`, `cline` or `unknown`.
- **Measured by**: counted from the source recorded at sync time.
- **Unit and denominator**: percent of sessions in the period.
- **Limits**: the source is the store where sync found the session. A session copied between stores keeps the source of the store it was found in.

### Active days

- **Definition**: the number of distinct UTC days on which a session started.
- **Measured by**: counted.
- **Unit and denominator**: days. A local day can fall on another date than the UTC day, so a report in local time says which zone it assumed.
- **Limits**: a day with a session started by an unattended agent counts as active. The metric shows when the machine worked and says nothing about when the person did.

### Prompts per session

- **Definition**: the number of user-role messages in a session.
- **Measured by**: counted from the messages table.
- **Unit and denominator**: messages per session. The fingerprint export reports a distribution over fixed buckets.
- **Limits**: see limit 2. This metric is the most often misread. Task notifications, workflow harness text, pasted logs and prompts written by an orchestrating agent are all user-role messages. Pi files its own injected notifications under another role, so Pi's count sits closer to what a person typed than Claude Code's does.

### Tool calls per session

- **Definition**: the number of tool calls the agent made.
- **Measured by**: counted from the stored tool calls of assistant messages.
- **Unit and denominator**: calls per session.
- **Limits**: harnesses split work into calls differently, and Claude Code names its tools differently from Pi. A call a sub-agent made counts in the child session and not in the parent.

### Session duration

- **Definition**: wall-clock time from a session's first message to its last.
- **Measured by**: counted from message timestamps.
- **Unit and denominator**: minutes per session.
- **Limits**: it includes every pause, so a session left open overnight is long. Active time measures the time the agent or the person worked.

### Sessions with sub-agents

- **Definition**: the number of top-level sessions that started at least one child session, and the number of child sessions they started.
- **Measured by**: counted from the parent link.
- **Unit and denominator**: sessions.
- **Limits**: a child session whose transcript sync never read is missing from both counts.

## Failures

The failure-modes analyzer (version 1.3) decides the next four entries after the raw rate. It reads the action stream described in DESIGN.md and matches errors against a hand-written catalogue.

### Raw tool error rate

- **Definition**: the share of tool results that the host flagged as an error.
- **Measured by**: counted from the `isError` flag stored with each tool result. No analyzer takes part, so no version applies.
- **Unit and denominator**: percent of tool results.
- **Limits**: each harness chooses what to flag. One harness flags a non-zero exit from `grep` as an error, and another treats it as an ordinary answer. A shift toward the shell moves the rate, because shell commands fail more often than reads. The rate does not depend on pairing calls with results, so it stays comparable for sessions where failure-modes could not pair them.

### Tool failure

- **Definition**: a well-formed tool call that the tool refused or errored on.
- **Measured by**: rule-based. failure-modes pairs each call with its result by call id (and by tool name and order when the stored call has no id), then counts the paired results flagged as errors.
- **Unit and denominator**: failures per session, and failures per tool call. The node stores the failure count and the tool call count.
- **Limits**: a call with no result is unfinished and not failed. Before version 1.3, a session indexed before the call id was stored read as zero tool failures whatever its transcript recorded, because no call could pair with a result. Nodes of version 1.2 and earlier for such sessions understate failures until a revise run recomputes them.

### Turn failure

- **Definition**: an assistant generation that ended in a recorded failure, so no tool ran. The causes include a provider refusal, a dropped connection, a context ceiling and an operator abort.
- **Measured by**: rule-based, from the stop reason and error text stored with the assistant message.
- **Unit and denominator**: failures per assistant turn. The node records whether the stop reason was captured.
- **Limits**: a session indexed before sync stored the stop reason reports its turn failures as `absent`, which means unknown. Reading `absent` as zero makes older months look healthier than newer ones. An abort is the operator stopping the agent. It is counted so that rates keep their full denominator, and the analyzer proposes nothing on it.

### Failure class and unclassified failures

- **Definition**: the curated category of a failure, or `unclassified` when nothing in the catalogue matched. Rate limit and path not found are two of the classes.
- **Measured by**: rule-based. A hand-written catalogue matches the error text and, for some classes, the call itself.
- **Unit and denominator**: failures per class. The share of unclassified failures measures the gaps in the catalogue.
- **Limits**: the catalogue grows. A failure left unclassified in an old node may have a class in a newer one, so class shares from different versions don't compare. Sync stores the error text, but the node keeps only the cause label and a digest of the text.

## Per-turn friction

### Friction score and high-signal turn

- **Definition**: a number from 0 to 1 for one turn, built as a weighted sum. The terms are a detected correction, failed tool results (at most three), an empty reply and oversized tool output. A turn at or above the high-signal threshold is high-signal.
- **Measured by**: rule-based. turn-pair-core (version 1.2) applies the weights in its config.
- **Unit and denominator**: score per turn. The denominator is turn pairs, which include non-user turn boundaries such as a bash execution or a branch summary, so it is not the count of user messages.
- **Limits**: a correction matches English wording, so a correction in another language scores zero. The score ranks turns for escalation and does not limit what the model reads, because every turn keeps a verbatim snippet in the digest. The tool failure term reads the result flags directly, so call pairing does not affect it.

### Correction

- **Definition**: a turn whose user text matches a correction pattern (such as "no, use X instead", "I told you to", or a repeated request).
- **Measured by**: regex rules of turn-pair-core.
- **Unit and denominator**: corrections per 100 turn pairs, or per 100 user messages when a report chooses that denominator. The denominators differ, so a report states the one it used.
- **Limits**: the patterns match English wording only, and a pasted log that contains one counts. The rate swings with the mix of orchestrated and typed sessions (limit 2).

### Rebuttal candidate

- **Definition**: a turn whose user text matches wording that disputes something the assistant said.
- **Measured by**: regex rules of turn-pair-core (version 1.2 and later). A match is a candidate and is not yet a finding.
- **Unit and denominator**: candidates per turn pair.
- **Limits**: the model layer confirms or rejects each candidate, and a confirmed candidate is a rebuttal.

### Friction type and sentiment

- **Definition**: the friction type is `none`, `wrong_approach`, `missed_instruction`, `tool_misuse`, `repetition`, `rebuttal` or `other`. The sentiment is `positive`, `neutral` or `frustrated`. Both describe one turn.
- **Measured by**: inferred. turn-pair-llm judges the turns that the deterministic layer or the lexicon escalated, from the user and assistant text, the tool calls and the error heads. The node records the resolved model. Some runs use a decision model in place of a generative one.
- **Unit and denominator**: classified turns. The denominator is the set of turns that the analyzer's version chose to classify, so a share such as "tool misuse is 8 percent of classified turns" describes that selection and not all turns.
- **Limits**: this metric has the most series breaks (see below). A change of selection, prompt, evidence or model changes the shares with no change in behaviour. Failed calls leave error nodes, and an error node is not a classification, so a count of nodes overstates the count of classified turns. Count nodes of kind `classification`.

## Frustration

### Frustration hit

- **Definition**: one turn and one signal. The user text of the turn matched a lexicon word or phrase, a dictionary entry, or a paralinguistic marker.
- **Measured by**: rule-based matching by turn-frustration (version 1.10) against verdicts that are inferred (see "Lexicon verdict"). The hit's category comes from the lexicon verdict or the dictionary entry.
- **Unit and denominator**: hits per 100 turns of the sessions that turn-frustration read. A hit node stores its intrinsic weight, and a reader scales it by how specific the term is in the corpus.
- **Limits**: coverage decides the number. A month where turn-frustration read few sessions describes only those sessions. Hits drawn before version 1.10 have no origin label, so they may match pasted text. A muted term stops counting. The weight of a word depends on the corpus at read time, so one stored hit can count differently as the corpus grows.

### Lexicon verdict

- **Definition**: the judgement on one normalised word or phrase. It has a polarity (frustration, praise or neutral), a category (such as profanity, insult, urgency or praise), a language, a confidence and a rationale.
- **Measured by**: inferred. frustration-lexicon (version 1.7 separates insult from profanity) judges each term once for the whole corpus, so a verdict reflects the model and the version of the day the term was first nominated.
- **Unit and denominator**: terms. There is no rate.
- **Limits**: a verdict lasts until a revise run recomputes it. A term filed under an earlier category, such as profanity before insult existed, keeps that category until revised. A revise filter lets a run recompute only the affected terms.

### Paralinguistic marker

- **Definition**: frustration expressed by form, such as shouting or repeated punctuation.
- **Measured by**: rule-based, by turn-frustration. It needs a lexicon for no language.
- **Unit and denominator**: hits per 100 turns.
- **Limits**: a pasted log in capitals counts as shouting unless the origin label marks it as pasted.

### Text origin

- **Definition**: the label on a piece of user text that says who wrote it: `typed`, `pasted`, `quoted`, `agent`, `notification` or `fork-copy`.
- **Measured by**: rule-based, in `src/analyze/text-origin.ts`. A turn-frustration hit records the origin of the text it matched and its occurrences per origin.
- **Unit and denominator**: occurrences per origin. They add up to the count of the hit.
- **Limits**: only turn-frustration hits of version 1.10 and later have it. Every other metric on user text lacks it (limit 2). The rules are heuristics over the transcript, and a person who pastes an earlier message of their own gets `pasted`.

### User reply acts

- **Definition**: the kind of reply that a user message is (such as a question, a command or a refusal).
- **Measured by**: inferred, by an analyzer that the operator keeps in their own `.prospector/analyzers` directory. This repository does not define its classes, versions or prompt.
- **Unit and denominator**: classified replies. The share of a class is a share of classified replies.
- **Limits**: the operator's file defines the class list, and the list changed between versions 1.0 and 1.1. The analyzer judges user-role messages, so limit 2 applies in full.

## Trajectory and collapse

### Trajectory signals

- **Definition**: per session, the number of stuck-loops, polling-loops, oscillations, pre-flight gaps and no-effect edits. DESIGN.md defines each.
- **Measured by**: rule-based. tool-trajectory (version 7.0) reads the ordered action stream. Its thresholds (`stuckLoopMin`, `pollingLoopMin`, `oscillationWindow`) are config.
- **Unit and denominator**: signals per session, or per 1000 tool calls when a report corrects for length.
- **Limits**: a long session has more chances for each signal. A stuck-loop shows a pattern and does not prove the agent was wrong, because a legitimate retry loop looks the same. A signal that needs a result to decide, such as a pre-flight gap (a mutating command that failed), depends on pairing calls with results. Older tool-trajectory nodes for sessions indexed before call ids may undercount it.

### Repetition collapse and decode collapse

- **Definition**: a generation that loops on a phrase or a character motif (repetition collapse), or that stopped being language (decode collapse).
- **Measured by**: rule-based. repetition-collapse uses n-gram and motif ratios. decode-collapse scores the median line perplexity under a model trained on the earliest sessions of the corpus.
- **Unit and denominator**: collapsed steps per session. A corpus too small to train on yields unknown and not zero.
- **Limits**: the decode-collapse threshold derives from the corpus, so the same text can score differently in another corpus. The node lists the highest-scoring documents so that a person can confirm them.

## Time and economy

### Active time

- **Definition**: the union of every timed tool call's span and every gap between messages, with each gap capped at an idle limit (300 seconds by default).
- **Measured by**: counted from host timestamps by time-economy (version 2.0). A call without both timestamps is untimed and never zero.
- **Unit and denominator**: minutes per session. Phase spans (start to first commit, commit preparation) and skill spans report minutes, turns and tokens.
- **Limits**: version 2.0 times background calls by their completion record, so durations from version 1.0 are shorter and don't compare. The analyzer may have read only part of a period. Concurrent agents make a total across sessions a measure of agent time (limit 5).

### Cache hit ratio

- **Definition**: for one turn, cache-read tokens divided by the sum of cache-read, cache-write and input tokens.
- **Measured by**: counted from recorded usage by cache-economy.
- **Unit and denominator**: ratio per turn, and the aggregate ratio per session.
- **Limits**: a harness that does not record usage yields a null ratio. Claude Code writes one row per content block, so usage is de-duplicated by provider message id before it is summed.

### Token units (MITE)

- **Definition**: a session priced in million input-token equivalents. Input weighs 1, output 15, cache-read 0.1 and cache-write 1.25.
- **Measured by**: counted from recorded usage by token-units, with fixed weights.
- **Unit and denominator**: MITE per session or per day.
- **Limits**: the weights are a convention and not any provider's price list. A session without recorded usage has no value.

### Billed cost

- **Definition**: the dollar amount that the host recorded for one assistant message.
- **Measured by**: counted. A message without a recorded cost, or with a cost of zero, is null.
- **Unit and denominator**: dollars per message, per turn bucket or per session.
- **Limits**: only some harnesses record it, and only for sessions indexed after sync stored it. A total that omits unpriced messages says so. Dollar figures don't compare across harnesses or months.

### Model recorded

- **Definition**: the model name stored with an assistant message.
- **Measured by**: counted from the transcript.
- **Unit and denominator**: percent of assistant steps with a model, and the share of steps per model family.
- **Limits**: sessions indexed before sync stored the model have none. A routed alias, such as a tier name, hides the model that answered, and a share by family covers recorded steps only.

## Outcome

### Session ending label

- **Definition**: how the session ended: `resolved`, `abandoned`, `handed-off`, `errored` or `unclear` (see DESIGN.md).
- **Measured by**: rule-based. session-ending (version 1.1) reads the last events of the transcript and the action stream, and applies the first rule that matches. The node stores the rule code and an excerpt.
- **Unit and denominator**: percent of labelled sessions. A non-empty session always gets a label, so the denominator is the sessions with at least one message. It includes child sessions unless the report filters them out.
- **Limits**: the label is coarse. `resolved` needs a final summary and a passing verification command (or a last tool result that succeeded), so it can miss work that finished in another session, and it can't see a merge. Sessions that end on a record that is not a conversation turn, such as a compaction summary or a bash execution, get `unclear` by the rule `non_conversational_end`, and that can be a large share. A verification pattern matches the start of the command, so a test run behind `cd dir &&` or an environment assignment goes unrecognised, and the label falls back to the last tool result. Before version 1.1, a session whose calls could not pair with results got `abandoned` by `no_recorded_results`. That affected every session indexed before call ids were stored, and none of them could reach `resolved`.

When the last record is from the assistant, the rules run in this order.

| Rule | Label | Condition |
|---|---|---|
| `operator_abort_at_end` | abandoned | the operator aborted the last generation |
| `generation_failure_at_end` | errored | the last generation has a host error |
| `cut_off_mid_work` | abandoned | the last step still issues tool calls |
| `insufficient_final_text` | unclear | the final text is shorter than the configured minimum |
| `verification_passed` | resolved | the most recent verification-class command succeeded |
| `wrap_up_after_failed_verification` | unclear | the most recent verification-class command failed |
| `summary_after_success` | resolved | no verification command ran and the last tool result succeeded |
| `summary_after_failure` | unclear | no verification command ran and the last tool result failed |
| `no_recorded_results` | abandoned | calls exist and none has a result |
| `no_outcome_evidence` | unclear | no calls exist |

When the last record is a tool result, `failed_result_at_end` gives `errored` and `unanswered_result_at_end` gives `abandoned`. When it is a user message, `explicit_closure` gives `handed-off` and `unanswered_user_message` gives `abandoned`. Any other record gives `unclear`.

### Plan compliance

- **Definition**: four scores from 0 to 1 over a session's phase sequence. PPC measures the phases present, POC the order of transitions, PPF the fidelity to the plan phases, and PC is their geometric mean.
- **Measured by**: rule-based. plan-compliance (version 1.0) reads phase-trajectory, which labels each turn navigate, reproduce, patch, validate or other.
- **Unit and denominator**: score per session.
- **Limits**: the phase of a turn comes from tool names and commands, so a harness with different tool names shifts it. Test and build commands mark a validate phase, so a project that verifies another way reads as skipping validation. PC ranks and contrasts sessions and is not an outcome label.

### Pull request opened

- **Definition**: the pull request that a session opened, as the URL and title in the transcript.
- **Measured by**: rule-based. pr-opened reads the creation command and the answer of the forge.
- **Unit and denominator**: one node per pull request.
- **Limits**: it covers `gh pr create`, a stacked-PR command and a hosted-forge creation tool. A pull request opened by hand is not seen. A session that opened none did not necessarily fail.

## Figures a report computes itself

A report may print figures that no node stores. Each needs a stated definition, because two reports can use one name for different things.

- **Substantive session**: a rule for which sessions count as working sessions. The October 2026 practice-drift report defined it as a top-level session with at least three assistant steps and one user-role message. The floor is a choice, and changing it changes every rate.
- **Human-candidate message**: a user-role message that does not start with a known harness marker, such as a task notification or a slash command. It is still not proof that a person typed it (limit 2).
- **Harness-generated share**: the share of user-role messages that start with such a marker.
- **Tool mix shares** (shell, read, edit): the share of tool calls whose tool name belongs to a group. The grouping depends on each harness's tool names.
- **Sessions that edit a file**: the share of sessions with at least one edit or write call.
- **Minutes to first edit**: minutes from the first message to the first edit or write call, among sessions that edit.

## Known series breaks

A series break turns a trend across it into a comparison of two measurements. The repair for each is a revise run over the window, to the current recipe. A revise run costs model calls for inferred metrics, and each repair needs a person to start it.

| Metric | Break | Effect | Repair |
|---|---|---|---|
| Tool failure, session ending, and any rate that reads tool outcomes | Sessions indexed before the call id was stored (before 2026-08-20) could not pair calls with results. Fixed in failure-modes 1.3 and session-ending 1.1 | Those sessions read as zero tool failures and cannot end `resolved` | `prospect analyze --analyzer failure-modes --revise minor` and `prospect analyze --analyzer session-ending --revise minor` |
| Turn failure | Sessions indexed before sync stored the stop reason | Unknown, shown as `absent` | Sync the session again, then revise failure-modes |
| Friction type and sentiment | turn-pair-llm 1.3 added tool evidence to the prompt | Shares of `tool_misuse` change | `--revise major,minor` |
| Friction type and sentiment | turn-pair-llm 1.4 escalates turns that match a frustration signal | The classified population grows toward turns without tools, so every share shifts | `--backfill-missing` fills the new turns |
| Friction type and sentiment | turn-pair-llm 1.5 passes the turns since the last trigger and not the turn alone | The evidence the model sees changes | `--revise major,minor` |
| Friction type and sentiment | The model that the tier resolves to changes | Judgements differ by model (config reason) | `--revise config`, with `--model` to pin one |
| Frustration category | frustration-lexicon 1.7 split insult from profanity and turn-frustration 1.8 copied the category | Profanity counts fall and insult counts appear | Revise with `--revise-where category=profanity` |
| Frustration origin | turn-frustration 1.10 labels origin | Earlier hits have no origin | `--revise minor` on turn-frustration |
| Active time | time-economy 2.0 times background calls by completion | Durations rise for sessions with background calls | `--revise major` |
| Model recorded, billed cost | Sessions indexed before sync stored each field | Unknown, never zero | Sync the session again |

### Re-running failure-modes adds a second node

The failure-modes unit identifies itself by a fingerprint of the failures it found. Pairing calls with results changes that fingerprint for an affected session, so the framework sees a new unit and fills it. It does not classify the unit as stale. The new node is current beside the old one, and no `revises` edge links them. The old node records a tool failure count of zero, so failure totals stay right. A per-session denominator such as the tool call count appears twice for those sessions, so a rate that sums nodes must read one node per session.

session-ending keeps its unit identity, so its re-run revises the old node in the normal way.

An analyzer that declares failure-modes as a dependency, such as session-overview, folds the output key into its own identity. Its units become missing after the re-run and cost model calls on the next run that reaches them.
