# pi-prospector — Design & Concepts

This document is the orientation guide for anyone — human or AI agent — who is
new to this repository. It explains **what the system is for** and **why it is
built the way it is**, and it fixes a **ubiquitous language**: a small set of
terms that mean exactly one thing throughout the code, the database, the
commands, and any conversation about the project. When you read or write code
here, use these words with these meanings. When a term in this glossary appears
in a discussion, assume the precise definition below — not its everyday sense.

This is a conceptual guide. It deliberately contains no file paths, function
names, table definitions, or code. Those change; the concepts and the reasons
for them are what must stay stable.

---

## 1. Purpose

People spend hours working with coding agents. Those conversations are a
goldmine of signal about where the agent's standing instructions, documentation,
tools, and skills fall short: every time the user has to correct the agent,
re-explain context, or watch it waste effort, that friction is evidence of a
fixable gap.

pi-prospector mines that history. It reads the local record of past agent
**sessions**, looks for moments of **friction**, and turns recurring patterns
into concrete, reviewable **proposals** — suggested edits to the artifacts that
steer future agent behaviour (standing instruction files, skills, tool
descriptions, configuration, and similar). The human stays in control: the
system proposes, ranks, and explains; it never edits those artifacts on
its own.

The guiding intent behind every design choice is **trust through traceability
and cheap recomputation**. A proposal is only worth acting on if you can see the
exact evidence that produced it, and the analysis is only sustainable if it can
be re-derived cheaply as the analysis logic improves — without paying again for
work that is already up to date, and without throwing away earlier conclusions
that someone may want to compare against.

---

## 2. Ubiquitous language

These are the load-bearing nouns and verbs of the system. They are listed in
roughly the order concepts build on one another.

### Conversation domain (the read-only input)

- **Session** — one recorded conversation between a user and a coding agent,
  from start to end. Sessions are the raw material. They are treated as
  **read-only**: the system observes them and never alters them.
- **Message** — a single entry within a session: something the user said, one of
  the agent's replies, the agent's private reasoning, or the result of a tool the
  agent ran. Messages carry metadata (timing, model, token usage, error flags).
- **Billed cost** — the dollar amount the host platform recorded for a single
  assistant message (`usage.cost.total` for Pi; Claude Code records none). It is
  money and is never inferred: a message whose transcript recorded no cost — or
  whose cost total is zero, which Pi writes when it has not priced a message —
  carries **null**, never a synthetic 0, because a silent zero reads as
  "this was free" to every downstream consumer.
- **Turn** — the natural unit of one round of work, and where most friction is
  visible. A turn begins at a user message (the turn boundary) and spans
  *everything* the agent does in response — every assistant reply, its private
  reasoning, and every tool call and result — up to the next user message. A
  turn is therefore usually **many messages, not two**: a single request
  normally drives a loop of repeated assistant generations and tool calls before
  the next user message arrives. (The host platform also treats a few non-user
  entries — a bash execution, a branch or custom summary — as turn boundaries.)
  The per-turn analyzers are named `turn-pair-*` and the codebase calls this
  unit a "turn pair"; it is one turn, not a pair of turns.
- **Step** — one assistant generation within a turn: a single model response,
  possibly carrying tool calls. A turn is a sequence of one or more steps plus
  the tool results they trigger.
- **Tool call** — a single invocation of a tool by the agent within a step,
  carrying a name and arguments. Tool calls are the finest-grained unit of
  agent action; their sequence within a session is the **tool-call trajectory**.
- **Normalized arguments** — a canonical, comparison-ready representation of a
  tool call's arguments. For `bash` calls the `command` string is the normalized
  form (with known-flag prefixes stripped of values); for structured tools the
  relevant fields are extracted. Normalization makes "same call" detection robust
  against incidental differences.
- **Tool evidence** — the tool name, truncated arguments, and (for failed
  results) truncated error output for the tool calls within a turn, supplied to
  LLM analyzers alongside message text so proposals can be attributed to specific
  commands rather than paraphrased from user wording. The `turn-pair-core`
  builder extracts it deterministically under fixed caps (arguments and error
  head each truncated to a fixed length, at most eight calls surfaced per turn);
  those caps keep the derived prompts bounded so content-addressed identities
  stay reproducible. Two analyzers consume tool evidence: `turn-pair-llm` renders
  a `TOOL CALLS:` block into the classifier prompt, and `session-overview`
  appends a `tool=<name> args="…" err="…"` fragment to the per-pair digest line
  for high-signal or failing turns.
- **Compaction boundary** — a point where the conversation history was
  summarised and truncated to fit the model's context. The system is aware of
  these so it does not mistake a summary for an ordinary message.

### Analysis domain (the append-only output)

- **Analysis graph** — the entire body of derived analysis, layered on top of
  the conversation. It is a graph, not a tree, and it is **append-only**: once
  written, an analysis result is never edited or deleted.
- **Analysis node** (or just **node**) — one self-contained piece of derived
  analysis: a set of metrics for a turn, a classification of a turn, a
  session-level summary, or a recorded error. Every node states what it is
  about, what it was built from, and exactly which recipe produced it. A session
  with zero friction still produces a summary node carrying **positive signals**
  and, when warranted, **reinforcement proposals** — it is never invisible to
  the pipeline.
- **Node kind** — the category of a node's content. The kinds in use are
  **metric** (deterministic measurements of a turn or session), **classification**
  (a language-model judgement about a turn), **summary** (a session-level
  synthesis that carries proposals), **validation** (a replay test of a proposal
  against the turns it came from — see *Replay validation* below), and **error**
  (a record that an analysis attempt failed). An error node's identity is its
  recipe plus the failure's message and timestamp, so every failure is a distinct,
  append-only record that never
  occupies the recipe identity reserved for a successful result. Failures stay
  visible and auditable, yet never mark a unit as done: the unit stays *missing*
  and is recomputed on the next scan that reaches it.
- **Output** — a file an analyzer can render from the finished graph, named and
  described by that analyzer and addressed as `analyzer:output`. An output is
  **not** a node: it produces an **artifact** (a filename, a media type, and
  text) and writes nothing back. Where a node is the durable record of what was
  found, an output is that record shaped for a person or for a tool that is not
  this one — a report, an export, a feed.
- **Artifact** — one rendered file produced by an output. Artifacts are
  disposable by design: they are re-rendered from scratch on every request and
  carry no identity, no lineage, and no place in the graph.
- **Edge** — a typed, directed relationship in the analysis graph. Edges are the
  **single source of truth** for relationships: there are no parent links or
  embedded references hidden inside nodes. Every connection between a node and
  anything else is an explicit edge with a named kind.
- **Edge kind** — the meaning of an edge. The kinds are:
  - **anchors** — “this node is *about* this part of the conversation” (a
    session or a specific message). Anchoring is how a proposal can be traced
    back to the exact words that justify it.
  - **consumes** — “this node was *built from* that node.” It records the inputs
    that fed an analysis.
  - **uses_prompt** — “this node was produced using that prompt.”
  - **uses_config** — “this node was produced under that configuration.”
  - **produces** — “this node yielded that proposal.”
  - **revises** — “this node is a newer-version alternative of that node,
    covering the same subject.” This is the backbone of lineage (below).
  - **mutes** — “this node's conclusion is silenced by that human assertion.” The
    edge reaches a *judgement* (a mute) from the analyzed conclusion it
    suppresses, so human input is traversable alongside everything else.
- **Anchor** — the conversation entity a node is about, reached via an *anchors*
  edge. A turn-level node anchors to its user message; a session-level node
  anchors to the session.

### Recipe, identity, and idempotency

- **Analyzer** — a named, self-describing unit of analysis logic. An analyzer
  declares what it is about, what other analyzers it depends on, the prompts and
  default configuration it uses, how to enumerate the work it could do, and how
  to perform one piece of that work. Analyzers are the only things that create
  nodes.
- **Analyzer version** — an analyzer's declared release, a `major.minor` pair
  owned by its author (third-party, out-of-tree analyzers declare it when they
  register). The version represents everything the author *ships*: the analysis
  logic, the default prompt, and the default model tier. Improving an analyzer
  means bumping the version — **major** for a change the author judges
  significant, **minor** for a small one. Prompt or default changes are folded
  into that one number; shipped defaults have no separate identity axis. A new
  version produces new nodes rather than overwriting old ones.
- **Config** — everything the *user* sets for an analyzer: thresholds and
  parameters, a prompt override, the tier→model mapping, and any model pin. The
  resolved model lives here. Config is content-addressed, so changing any of it
  yields a distinct config identity — but config changes are **never graded**
  major/minor; a different prompt or a different model "is just different."
- **Prompt** — a content-addressed piece of prompt text, recorded for provenance
  (which prompt produced a node). A prompt the analyzer *ships* is represented by
  its version, not by a separate identity axis; only a prompt the *user* overrides
  contributes to identity, as part of config.
- **Source set** — the exact collection of inputs a single piece of analysis
  draws on, reduced to a stable fingerprint. Two analyses over the same inputs
  share a source-set fingerprint; adding or changing inputs changes it. A
  consumer's source set references its upstream sources by their **output key**
  (below), so the consumer's identity folds in *what those sources concluded*,
  not merely that they exist.
- **Recipe** — the full description of *how a node came to be*: which analyzer,
  which version, which config, and which source set. The recipe is condensed
  into a single fingerprint called the **input key**.
- **Input key** — the content-addressed fingerprint of a recipe (analyzer +
  version + config + source set). It is the system's notion of identity for
  *whether work needs doing*: if a node with a given input key already exists,
  the work it represents is already done. An input key folds in only *inputs* —
  never the model's output — so the same recipe over the same sources always has
  the same input key.
- **Output key** — the content-addressed fingerprint of a node's *result*:
  `hash(input_key, content)`. It identifies a *specific output*. A downstream
  analyzer references its sources by their output key, so the whole graph is a
  Merkle DAG: identical inputs and outputs reproduce identical keys on any
  machine, after any wipe, and a stored key can be re-derived from content to
  **verify** the node. Because analysis is append-only, a different output is
  always a different node and therefore a different output key.
- **Idempotency** — the property that running analysis again produces no
  duplicate work and no changed results, because identity is the recipe. Re-running
  is always safe and usually a no-op.
- **Verification** — recomputing every node's output key from its stored content
  and confirming it matches, **and** validating every edge's referential
  integrity (each `consumes`/`revises` target resolves to a real output key, each
  `anchors`/`uses_*`/produces/contrasts_with target resolves to a real entity).
  Because identities are content-addressed, any drift reveals out-of-band
  tampering or corruption; because relationships live only in typed edges, a
  dangling edge is the one damage that content hashing cannot see — so it is
  checked here, or a broken evidence trail would certify clean. (`prospect verify`.)

### Running analysis

- **Plan** — an analyzer's enumeration of the discrete pieces of work it *could*
  do for a session (for example, “one piece of work per turn”). Planning does
  not perform analysis; it only describes the candidate units and their source
  sets.
- **Unit** — one planned piece of work: a source set plus where its result would
  anchor. A unit is the thing that does or does not yet have a corresponding
  node.
- **Scan** — the act of comparing every planned unit against the existing graph
  and classifying it. Scanning is cheap (fingerprint lookups, no model calls)
  and is how the system decides what, if anything, needs doing. This replaces
  any notion of progress cursors or crash bookkeeping.
- **Unit status** — the result of classifying a unit during a scan:
  - **missing** — no *successful* node exists for this unit's recipe. Either it
    has never been attempted, or prior attempts only produced error nodes (which
    carry a decoupled identity and never satisfy a recipe). Missing work is always
    done, even by a frugal run.
  - **stale** — a node exists for this subject but under a different recipe than
    the current one. Staleness carries its *reasons*: **major** or **minor** (the
    analyzer's version moved — graded by the author) and/or **config** (the
    user's setup changed — ungraded). A unit can be stale for several reasons at
    once.
  - **current** — a node already exists for the current recipe; nothing to do.
- **Run** — one execution of an analyzer over a session. A run records its own
  provenance (status, cost, tokens, how many nodes it produced, skipped, or
  revised) so that execution history is itself auditable.
- **Analyze invocation** — one full `analyze` over many sessions. It keeps a
  completion record (`analyze_runs`): how many sessions it attempted, completed,
  and failed, plus node/proposal/cost tallies and representative errors. This is
  what makes a partial overlay legible — a run that stalled part-way is
  distinguishable from a corpus that genuinely had little to say. The record is
  created as `running` up front and finalized with real counts when the run
  returns.
- **Revise reasons** — what a run is allowed to recompute, beyond always filling
  *missing* work. A run with no reasons is frugal: it fills missing analysis and
  touches nothing that already has a node. The reasons widen that reach to
  recompute stale nodes too: **major** (the analyzer had a major version bump),
  **minor** (major *and* minor bumps), and **config** (the user's setup changed).
  Reasons are a *set*, not a ladder — `config` is orthogonal to the author's
  major/minor grade, so you choose any combination (major-plus-config, or
  everything). Recomputing records each result as a new version linked by a
  *revises* edge.
- **Selection versus recompute** — the reasons decide *which* out-of-date units a
  run touches; they never decide *what to recompute toward*. A selected unit is
  always recomputed to the **current recipe in full** — latest version, latest
  config, latest resolved model. The grade is a trigger, not a target: there is
  no recomputing to an intermediate state, so a unit revised for one reason
  absorbs every pending change for that same unit at once and you never get a
  half-updated node.
- **Lineage** — the chain of versioned alternatives for one subject, connected by
  *revises* edges. Because analysis is append-only, recomputing does not replace
  the old conclusion; it adds a newer one beside it, and both remain navigable
  “at the same level.” This is what lets you compare how analysis changed as the
  logic improved.

### Trajectory analysis (deterministic, session-level)

Beyond per-turn friction, the agent's **tool-call trajectory** carries patterns
that have no verbal marker and no error flag: the same call repeated without
change, a read-only poll waiting for external state, an action undone and
redone, or a mutating command that fails on a missing precondition. These
patterns are invisible to the turn-pair metrics because they span multiple
turns and live in the *sequence* of actions, not in a single response. The
trajectory analyzer is deterministic and session-anchored: it reads the full
ordered stream of tool calls and emits **trajectory signal** nodes that
contribute to the session's friction score and surface in the digest.

- **Trajectory signal** — a deterministic, session-level detection of a
  problematic tool-call pattern (stuck-loop, polling-loop, oscillation, or
  pre-flight gap). Each signal carries the pattern name, the tool(s) involved,
  the count of repetitions, the message ids that participate, and a
  normalised argument fingerprint. Trajectory signals are node kind **metric**
  (deterministic measurement of a session) and anchor to the session.
- **Stuck-loop** — the same tool with near-identical normalised arguments
  invoked **N** or more times without an intervening success or state change.
  A stuck-loop indicates the agent is retrying without adaptation. Threshold
  `stuckLoopMin` (default 3) configures the minimum repetition count.
- **Polling-loop** — a read-only command (`gh pr view`, `gh run list`, `git
  status`, etc.) repeated while the agent waits for an external state change.
  A polling-loop is a specialisation of stuck-loop where the tool is
  read-only. Threshold `pollingLoopMin` (default 3) configures the minimum
  repetition count.
- **Oscillation** — an action followed later by its inverse on the same
  target (push commit A then push old-sha to the same ref; checkout `x` then
  checkout `y` then checkout `x`; create then delete). Oscillation detection
  looks for reversal within a sliding window. Threshold
  `oscillationWindow` (default 10 tool calls) configures how far apart two
  opposite actions can be and still count as oscillation.
- **Pre-flight gap** — a mutating command that fails on a missing
  precondition that an earlier command in the session could have established
  (e.g. `mv` into a non-existent directory, `git push` of an unpushed
  branch). Pre-flight gaps signal that the agent acted without checking or
  establishing prerequisites.

### Failure analysis (deterministic, session-level)

A trajectory signal is a pattern in what the agent *did*. This is the other
half: what simply **failed**. Two things fail, and they are not the same thing.

- **Tool failure** — the agent asked for a well-formed action and the tool
  itself refused or errored. This has always been visible: the transcript
  records the result and flags it as an error.
- **Turn failure** — the agent's own generation never produced a usable result,
  so no tool was ever reached. The provider refused the call, the connection
  dropped mid-stream, the model emitted a tool call the host could not parse, the
  context ceiling was hit. A turn failure is the most expensive kind of friction
  there is — the tokens were billed and nothing came back — and it is also the
  quietest: with no tool call to record, the turn reads as an ordinary short
  reply. It was invisible until ingest kept the host's stop reason and error
  text, which is why the corpus looked healthier than it was.

Both are read from the same **action stream** — the session's tool calls paired
with their results by the provider's tool-call id, alongside the generations
that failed. One reconstruction serves every analyzer that needs it, so
"the third call" and "that call failed" mean the same thing everywhere. Pairing
by *position* instead, as an earlier version did, mis-attributed every error in
any session where one step issued several calls.

- **Failure class** — the curated category a failure falls into: rate limit,
  transport failure, provider server error, malformed tool call, context
  ceiling, authentication, quota, model unavailable, abort; and on the tool side
  invalid input, edit-anchor miss, script error, guardrail block,
  tool-or-command not found, path not found, permission denied, remote rate
  limit, unavailable backing service, timeout, a command that reported its own
  error, and a non-zero exit used as a signal. A class is decided by matching a
  hand-written catalogue. Anything that matches nothing is **unclassified** — a
  real answer, and the honest measure of the catalogue's gaps, where forcing a
  poor fit would hide them. It is what the catalogue is *for*: the first run over
  a real corpus left a third of failures unnamed, and profiling that residual is
  what produced most of the classes above.
- **Classifying from the call** — some failures leave no evidence in the result
  at all. A `grep` that finds nothing exits non-zero and prints *nothing*; the
  only way to know what happened is to look at what was asked for. So a class may
  match on the invocation as well as on the result. Such a class sits late in the
  catalogue, so a command that *did* report a real error is named by that error
  first.
- **Exit status as a signal** — a non-zero exit that is a normal answer rather
  than a failure: `grep` found nothing, `diff` found a difference, `test`
  evaluated false. The harness marks it as an error and the agent re-plans around
  a non-problem. It is the single largest tool-side class on a real corpus, and
  the remedy is a standing instruction, because the shell will never say so
  itself.
- **Not-a-failure classes** — an operator **abort**, and a poll of an unfinished
  **background task**. Both arrive flagged as errors and neither is a defect.
  They are counted, so every rate in the session keeps an honest denominator, and
  never proposed on.
- **Cause label** — the short, fixed description of *which* matcher fired. The
  label is what goes into the graph; the matched error text never does. Host
  error text quotes account names, organisation names, provider slugs, and
  request ids, and the analysis graph is durable and widely readable — the same
  reasoning that makes `secret-leak` store a redacted preview rather than the
  secret. Alongside the label sits a digest of the normalised text, so two
  occurrences of one failure count as one cause seen twice while genuinely
  different errors stay apart, and neither is readable. When the result said
  nothing at all, the *command* is fingerprinted in its place — hashed, never
  stored, exactly like the error text it stands in for. Causes are merged by
  label when a proposal quotes them: the fingerprint is identity, not something
  a reader needs to see repeated.
- **Remedy** — what a failure class is fixed by, written down in the catalogue
  beside it. Every class has one that requires installing nothing.
- **Extension candidate** — a published package that addresses a class, listed
  in the catalogue with the version and licence that were checked against the
  registry when it was curated. **Package names are only ever read from this
  catalogue.** A language model asked to name a package will produce one that
  sounds right, and recommending a package that does not exist is a supply-chain
  hazard rather than a bad suggestion — so the synthesiser may only repeat a
  package the deterministic layer already named for it.
- **Extension proposal** — a proposal whose *target* is an extension: the thing
  to change is the set of installed packages, not a file. Nothing is ever
  installed; the proposal is a pointer with the measurement behind it. A class
  whose candidates are all installed already falls back to the package-free
  remedy, because recommending what the operator installed last week says the
  analysis did not look. What is installed is therefore part of the analyzer's
  **config** identity: installing a recommended extension marks the conclusions
  drawn before it stale for the `config` reason.

Not every failure is a defect. An **abort** is the operator stopping the agent;
it is counted, so the other rates have an honest denominator, and never proposed
on.

Failure counts are stated with their **coverage**. A session indexed before the
stop reason was captured cannot show a failed generation at all, so its count is
reported as *unknown* rather than as zero — a silent zero would read as a clean
session, which is precisely the mistake that hid this class in the first place.
Costs follow the same rule as everywhere else: an unpriced failure contributes
nothing, and a total that omits unpriced failures says so.

### Learned frustration lexicon (corpus-scoped)

Friction is often stated in words, and the shipped correction patterns are
English. A user writing `putain, c'est encore faux`, `не то`, or `🤬` produces no
verbal signal at all, so their friction is invisible unless it happens to leave a
non-verbal trace. Rather than ship more languages — an unbounded, always-partial
list — the system **learns the vocabulary from the corpus**.

- **Lexicon term** — one normalised word or emoji, judged once for the entire
  corpus. A term's verdict carries a **polarity** (*frustration*, *praise*, or
  *neutral*), a **category** (profanity, negation, correction, repetition,
  urgency, confusion, dissatisfaction, praise), a language, a confidence, and a
  rationale. Praise is collected alongside frustration because it feeds
  reinforcement proposals.
- **Frustration lexicon** — the body of those verdicts. It is **derived analysis,
  not configuration**: config is what the *user* sets, and a learned vocabulary is
  something the system concludes. Keeping it in nodes is what makes it traceable
  (a proposal can be walked back to the word and the turn that justified it),
  versionable (improving the judgement is an ordinary version bump, with the old
  verdict preserved beside the new one by a *revises* edge), and free of side
  state.
- **Term source ref** — a source of kind `term` whose id is the word itself
  rather than a row id. This is what makes the lexicon corpus-scoped: identity
  folds in the analyzer, its version, its config, and its source set, so the same
  word yields the same **input key** in every session.
- **The graph is the cache.** Because `input_key` is unique across the whole
  analysis graph, an already-judged word is classified `current` by the ordinary
  scan and skipped. The first session to nominate a word pays one cheap model
  call; every later session in the corpus reuses that verdict for nothing. There
  is no dictionary table, no cursor, and no state outside the graph — the
  existing content-addressed identity *is* the cache, and it required no new
  machinery to become one.
- **Corpus-scoped analyzer** — an analyzer whose subject belongs to the corpus
  rather than to one session, and which therefore reads a declared dependency's
  nodes across all sessions. Dependency-scoped visibility still holds: only the
  *session* scope is lifted, never the dependency scope.
- **Phrase** — *withdrawn.* Multi-word entries were tried and removed: over a real
  corpus they were 84% of all adjudications and 75% of all hits while being
  overwhelmingly noise, because adjacent words in running prose are not idioms.
  The genuine cases (`laisse tomber`, `trop lent`) are real but too rare to find
  by adjudicating every adjacent pair. A future attempt needs a different
  mechanism — a curated seed list, or statistical n-gram selection — not per-pair
  judgement.
- **Nomination** — the deterministic first stage: tokenise a session's user
  messages and put forward the distinct terms worth judging, ranked by frequency
  and capped per session. Nomination is language-blind by design — no stopword
  list, no stemming, since either would quietly privilege the languages we
  happened to think of. Only *shape* is filtered: code, paths, URLs, and
  identifiers are not vocabulary.
- **Hit** — one (turn, signal) pair: a node recording that a turn's user text
  carried a particular signal. Identity is the turn plus that one signal, which
  makes growth **purely additive** — learning a new word adds nodes to the turns
  containing it and disturbs nothing else in the corpus. A node holding *all* of a
  turn's matches would instead rewrite its own source set every time a word was
  learned, stranding its predecessor as neither revised nor superseded.
- **Paralinguistic marker** — frustration carried by *form* rather than
  vocabulary: shouting, repeated punctuation, a held-down letter. These need
  neither a lexicon nor a language, and they exist so that a user whose words the
  lexicon has never seen is still legible.

**The lexicon widens recall; it must never gate it.** Every path that detected
friction before it existed — tool failures, re-asking, empty replies, wasted
output, trajectory signals, the verbatim user-text snippet carried on *every*
digest line — keeps working untouched. A change that made any of them conditional
on lexicon coverage would be a recall regression, not a refinement.

Back-filling is explicit. When a session teaches the corpus a new word, turns in
*earlier* sessions containing that word have genuinely missing units — but those
sessions have been retired from the unanalysed queue, so an ordinary fill never
revisits them. Rather than mutate that queue as a side effect of analysis, a run
reports how many terms it learned and the user asks for a full plain fill. The
back-fill stays frugal: scanning is cheap, and only the turns that actually
contain the new word have anything to compute.

### Language-model access

- **Model tier** — an abstract quality/cost band (**cheap**, **mid**,
  **expensive**) rather than a concrete model name. An analyzer's *default* tier
  is part of what its version ships; the **tier→model mapping** is the user's
  config. Before a node's identity is computed the tier resolves to a concrete
  model, and that resolved model is part of **config** — so changing which model
  a tier maps to is an ungraded config change, picked up by a run that includes
  the `config` reason.
- **Model pin (per run)** — a single run may pin *every* tier to one specific
  model, overriding the configured mapping for that invocation. That is a config
  change for the run: the pinned model is part of identity, so a pinned run
  produces its own nodes, and the model used and the model recorded can never
  disagree. Existing nodes become stale for the `config` reason rather than
  being silently reused.
- **LLM caller** — the single seam through which any analyzer reaches a language
  model. In normal operation it routes through the host agent platform's own
  model provider system, so credentials and model availability are managed in one
  place and never reimplemented here. In tests it is replaced by a deterministic
  stand-in so the suite needs no network and no API key.

### Proposals (the product)

- **Proposal** — a single, concrete, reviewable suggestion to improve a steering
  artifact: what to change, where, why, with what confidence, and backed by
  evidence drawn from the conversation. Proposals are the system's output and the
  only thing a human is asked to act on. A proposal is either a **friction
  proposal** or a **reinforcement proposal**, distinguished by its severity.
- **Friction proposal** — a proposal whose severity is one of *friction*,
  *correction*, or *waste*: it identifies something that went wrong and suggests
  how to fix it. This is the original and default proposal kind.
- **Reinforcement proposal** — a proposal whose severity is *reinforcement*: it
  identifies something the agent did *right* — a positive pattern worth encoding
  into standing instructions so the agent keeps doing it. Reinforcement proposals
  are the product of analysing successful sessions and contrast. They carry the
  same target/evidence/confidence structure as friction proposals, but their
  intent is "keep doing X / encode the working pattern," not "fix what went wrong."
- **Target** — what a proposal would change (a category such as a standing
  instruction file, a skill, a tool description, configuration, or the set of
  installed **extensions**, plus an optional location within it — for an
  extension, the package spec). The categories are open by construction: a new
  one is a new value, never new schema.
- **Severity** — the nature of the signal behind a proposal (for example
  friction, correction, waste, suggestion, insight, or reinforcement). It
  describes *why the proposal exists*, not how urgent it is.
- **Confidence** — how much to trust a proposal. Two kinds, never conflated: the
  **model-rated** confidence the synthesising model assigns to itself, and the
  **replay-validated** score produced by validation (below). When a proposal has
  been validated, its grounded score supersedes the self-rating for ranking and
  display, and the view labels which kind it is showing.
- **Replay validation** — an offline check of whether a proposal would actually
  have helped. For each of the proposal's originating high-signal turns
  (`source_message_ids`, attached by the session summary), a *distinct* validator
  model classifies the turn twice — once as-is, once with the candidate rule
  injected as a standing instruction — and the proposal is credited only where
  injecting the rule turns friction into no-friction. The grounded
  **validated_score** is the fraction of friction turns the rule averts, and the
  proposal's **validation status** is **supported**, **unsupported**, or
  **unvalidated** (not yet tested). The result is a content-addressed
  *validation* node that `consumes` the summary and `anchors` to the replayed
  turns; the score is written back onto the proposal for fast ranking. This is
  advisory only — it grounds confidence, it never edits anything — and it
  deliberately inherits the classifier's blind spots (text-only, no tool calls),
  so the score is labelled *replay-validated* rather than presented as ground
  truth. Proposals whose target is an **extension** are skipped, not scored:
  the test injects the proposal as a standing instruction, and "install this
  package" is not something a text classifier can act on — scoring it would
  produce a number out of noise. They stay *unvalidated*, which is what they are.
- **Positive signal** — a deterministic or model-derived observation that
  something went *well* in a session: the task was completed without correction,
  a correction was followed by a clean recovery, or the tool-failure density was
  low. Positive signals are recorded in the session digest alongside friction
  signals and give the synthesiser **success/failure contrast** — a baseline of
  "normal" or "good" against which subtle friction becomes more visible.
- **Success/failure contrast** — the technique of comparing successful and
  failed trajectories for the same class of task, so the synthesiser can spot
  patterns that friction-only analysis misses. ExpeL (Zhao et al. 2023) shows
  that comparing successes against failures is what produces useful insights;
  summarising only one side is insufficient. Two 2026 results reach the same
  premise by different routes: Dubey (2026) fits its failure detector as a
  *one-class* model on healthy runs alone and flags deviation from that
  baseline, and SWE-Replay (2026) *discards* trajectories whose outcome was bad
  before mining them, on the grounds that their intermediate steps mislead —
  worth about four points in their ablation. The second of those marks a gap we
  still carry: a session's **outcome** is not something this system labels, so
  friction from a session that succeeded anyway is mined identically to friction
  from one that was abandoned. In pi-prospector the contrast works
  at two scopes: **within-session** (a clean pair versus a friction pair in the
  same session) and **cross-session** (a session is handed a compact digest of up
  to N *smooth* sibling sessions in the same repo/`cwd` as negative examples —
  "what the smooth sessions did instead"). Cross-session contrast is derived
  deterministically from the siblings' **raw messages** (present after ingest,
  before any analysis — so it never depends on analysis order or on a sibling
  being analysed yet, and can never form a cycle between session-overview nodes),
  reusing the deterministic turn-pair-core scoring to decide which siblings are
  smooth. Each selected sibling is folded into the session-overview node's
  **source set** as a `session`-kind source ref whose id embeds a hash of the exact
  contrast digest, so the node's `input_key`/`output_key` stay content-addressed
  and reproduce across a DB rebuild, and a `contrasts_with` edge records the
  provenance. This is contrast for *detection*, not cross-session merging.
  *Churn caveat* (expected, and the price of correctness): because the siblings
  are genuinely inputs, editing/adding/removing a smooth session in a repo changes
  the `sourceSetHash` of every friction session's overview in that same `cwd` — so
  those overviews re-identify as `missing` (a fresh recipe over a new source set),
  not as `stale`/`revises` of the old one, and are recomputed with an LLM call on
  the next run. Selection is capped at `maxContrastSiblings` (default 3) ranked by
  pair count, so a new, more substantial smooth sibling can also *swap* which three
  are chosen, reshuffling identities across the repo. This is correct — the nodes'
  inputs really did change — but it is churny when `crossSessionContrast` is on by
  default. The follow-up that bounds it is a per-`cwd` smoothness cache so the
  candidate scan is not repeated per session; consolidation/dedup of the resulting
  proposals remains explicitly out of scope.
- **Materialisation** — the step that lifts proposals out of a summary node into
  the fast, reviewable proposal store, attaching the evidence trail via
  *produces* and *anchors* edges. That trail is browsable after the fact: from a
  proposal you can walk back through the node that produced it to the turns it
  consumed and the messages they anchor, and read those turns verbatim
  (`prospect show`).
- **Textual gradient** — the per-friction record that a synthesis step produces
  *before* generating proposals: a concise *why it failed → what to change*
  explanation, consisting of a description of the friction, what should change,
  the session evidence supporting it, and a severity rating. The textual
  gradient is the exhaustive enumeration of distinct friction; proposals are
  derived from it.
- **Enumerate-then-propose** — the synthesis discipline where the model first
  enumerates *every* distinct friction point as a textual gradient, then emits
  one proposal per enumerated point. The model does not prune or merge
  distinct friction during generation; volume is managed downstream by
  display-time grouping, not by suppressing distinct signals at synthesis time.
- **Proposal status** — where a proposal sits in its lifecycle: **open** (awaiting
  a decision), **applied** (accepted/acted upon), **rejected** (declined), or
  **duplicate** (recognised as the same as an existing open proposal).
- **Decision** — the human's verdict on a proposal: **accepted**, **rejected**,
  or **accepted_modified** (the idea was useful but the human did something other
  than the literal recommendation). A decision is *external human input* — the
  same category as a conversation message, the opposite of derived analysis — so
  it is **not** an analysis node and is **never** folded into a proposal's
  identity. Decisions are recorded append-only and keyed by the proposal's
  content-addressed **input key** (not a row id), so a decision re-attaches to the
  regenerated proposal after a wipe-and-recompute: it is durable memory of how the
  human responds, and the corpus of decisions is the intended input to a future
  meta-analyzer that proposes improvements to raise proposal quality.
- **Disposition** — how the human acted on an accepted proposal: **planned** ("I
  will do it"), **done** ("I did the recommended action"), or **done_differently**
  ("the idea triggered a different action than recommended"). Disposition captures
  the realistic feedback loop where accepting a proposal and acting on it are the
  same moment, and where the action taken may diverge from the literal text.
- **Assertion** — a content-addressed, append-only *judgement* the operator (or
  the reviewing agent on their behalf) makes about a derived subject, recorded
  as external human input — the same category as a decision or a conversation
  message — never as an analysis node. Each assertion is about a
  `subject_kind`/`subject_key` pair (the *content* key: a term, an `input_key`,
  …) and carries a **verdict** (the kind of judgement). Identity is
  content-addressed from kind+key+verdict, so an assertion survives a
  wipe-and-recompute and an edge referencing it reproduces on any machine. The
  next kind of operator feedback is a new verdict value, never new schema.
  The relation is generic: **proposal decisions and remediations live on it
  too** (the follow-up that folded them on), so mutes, decisions, and shared
  remediations are one uniform corpus of operator judgement, keyed the same way.
- **Decision assertion** — a proposal decision stored as an assertion:
  `subject_kind='proposal'`, `subject_key=<the proposal's input_key>`,
  `verdict=accepted|rejected|accepted_modified`, with the decision's
  `disposition`, `actual_change`, and `harness_ref` kept verbatim. Because it is
  keyed by the content-addressed `input_key`, it re-attaches to a regenerated
  proposal after a wipe — the exact durability contract of the legacy
  `proposal_decisions` table, now uniform with mutes. A shared remediation is a
  `subject_kind='remediation'` assertion (its `subject_key` is the remediation
  id), and each decision assertion in the batch carries that id in its
  `remediation_id` to preserve the grouping. This migration is **additive and
  reversible**: legacy `proposal_decisions`/`remediations` rows are folded onto
  the relation (and new decisions still written to both) while the legacy
  tables are kept intact as the rollback, dropped only by a later change — and
  it is *verified by content* (a reconcile that proves every decision
  round-trips) rather than by "it ran", because decisions cannot be recomputed.
- **Mute** — an assertion whose verdict is *muted*, applied today to a **lexicon
  term** (`subject_kind='term'`): it stops a term from matching new turns while
  leaving its existing hit nodes untouched and reachable as lineage. The mute
  set is the user's `config`, so an analyzer that consults term mutes folds a
  hash of the currently-active mute set into its **config fingerprint** —
  muting therefore marks the affected nodes `stale/config`, a plain fill never
  recomputes them silently, and `--revise config` cleanly recomputes them with
  the old nodes preserved as lineage. Unmuting is append-only via
  `superseded_at` — the mute row stays inspectable with its reason and time. The
  mute corpus is operator judgement, and like the decision corpus it is natural
  training input for improving the classifier.

---

## 3. Why the architecture is shaped this way

Each decision below exists to serve the guiding intent — traceability and cheap
recomputation — and to avoid a specific failure mode.

### Append-only analysis, never mutation

Analysis results are written once and never changed. The reason is trust: if a
proposal could be silently rewritten, you could never be sure the evidence you
are looking at is the evidence that produced it. Append-only storage means every
conclusion is permanently tied to the exact inputs and recipe behind it, and
re-analysis adds rather than overwrites.

### Relationships live only in typed edges

There are no parent pointers and no relationship fields buried inside nodes.
Every link is an explicit edge with a named kind. The reason is that the
interesting questions are all about relationships — *what evidence backs this
proposal, what did this summary consume, which version revised which* — and a
single typed-edge fabric answers all of them uniformly. Hiding some relationships
inside nodes and others in a side table would make traversal inconsistent and
provenance unreliable.

### Identity is the recipe (idempotency by input key)

A node's identity is the fingerprint of everything that determines its content:
the analyzer, its **version**, its **config**, and its **inputs** — condensed
into the **input key**. This is what
makes re-running safe and cheap, and it separates two kinds of change. A change
the analyzer's *author* ships — new logic, a reworked default prompt, a different
default tier — is a **version** bump, and the author grades it major or minor. A
change the *user* makes — a threshold, a prompt override, the tier→model mapping,
a model pin — is **config**, and it is never graded; a different prompt or model
"is just different." The resolved model is part of config, so changing which
model a tier maps to makes the affected nodes stale for the `config` reason —
picked up only by a run that asks for it, so a model swap never forces surprise
recomputation. Deterministic analyzers use no model, so nothing about model
settings touches their identity. Leave version, config, and inputs all the same
and nothing is recomputed.

Identities are **content-addressed end to end**. The input key folds in only
inputs (the config's *content* hash, not any database row id; and upstream
sources by their **output key**, not their incidental node id), and the output
key is `hash(input_key, content)`. So the same sessions analysed with the same
analyzers reproduce byte-identical keys on any machine and after any wipe, and
the graph forms a Merkle DAG whose integrity can be re-derived from content
alone (`prospect verify`). Crucially, this is what makes "output matters for
consumers" automatic: because a consumer references its sources by their output
key, a changed upstream output is a new output key, which changes the consumer's
input key and correctly marks it for recomputation — while a *re-run that
reproduces the same output* changes nothing.

### Incrementality by scanning, not by cursors or crash recovery

The system does not keep progress bookmarks and does not maintain crash-recovery
state. Instead, before doing anything it scans: it enumerates the work each
analyzer could do and classifies every candidate as missing, stale, or current
using cheap fingerprint lookups. Whatever is missing gets done; whatever is
current is skipped. The reason is robustness through simplicity: there is no
bookkeeping to get out of sync, nothing to repair after an interruption, and no
way for a stored cursor to disagree with reality. The graph *is* the source of
truth about what has been done, so an interrupted or *failed* run simply leaves
some units missing, and the next scan picks them up. A unit that fails records an
error node for visibility, but because that node carries a decoupled identity
(recipe + message + timestamp) it never claims the recipe's slot — so the unit
stays missing and **self-heals on the next plain fill**, with no special retry
mode. To make that automatic, a session is only retired from the unanalysed queue
once it completes with no errors; a session that had any failure stays queued, so
the next fill re-scans it, recomputes only the still-missing units, and leaves its
prior error nodes intact. This is a deliberate departure from earlier designs that
tracked per-session cursors and recovery status.

### Versioned lineage and the reach of a run

Because analysis logic will keep improving, the system treats a better analyzer
as a *new version* rather than an edit. By default a run is frugal: it fills only
genuinely missing work and never touches subjects that already have a node. When
you have improved an analyzer, or changed your own config, you widen the run's
reach with **revise reasons** — `major` and `minor` for the author's version
bumps, `config` for your own setup changes, in any combination. A run then
re-analyses the matching stale subjects and records each new result as a fresh
version linked back to its predecessor by a *revises* edge. Crucially, the
reasons only *select* what to touch; whatever is touched is recomputed to the
current recipe in full, so you never produce a half-updated node. The old and new
conclusions coexist as navigable alternatives, giving you both economy (don't
redo good work) and the ability to audit how conclusions evolved — without ever
losing the earlier ones.

### Dependency-scoped visibility

An analyzer can read the conversation and its own past output, plus the output of
the analyzers it explicitly declares as dependencies — and nothing else.
Attempting to read undeclared analysis is treated as an error, not quietly
allowed. The reason is to keep the analysis pipeline a clear, declared dependency
graph: composition stays predictable, ordering can be derived, and no analyzer
can develop a hidden reliance on another's internals.

The rule governs *analysis*, and **outputs are exempt**: an output may read any
analyzer's nodes without declaring a dependency. This is narrower than it looks.
The rule exists so that a node's identity names every input that shaped it —
that is what makes recomputation honest. An output has no identity, produces no
node, and writes nothing, so it cannot create a cycle, cannot make anything
stale, and cannot be depended upon in turn. A report over two analyzers'
findings is the ordinary case, and expressing it as a dependency edge would
reorder real analysis work to satisfy a rendering concern.

### Rendering is separate from analysis

Producing a node and producing a file are different jobs with opposite
lifecycles, so they are different concepts rather than two modes of one.

A node is expensive to earn — it may have cost a model call — and must not
change under a reader, which is why it is content-addressed, append-only and
recomputed only when its recipe genuinely goes out of date. A file is the
opposite: cheap, disposable, and expected to differ every time the question
differs ("show me yesterday instead"). Modelling a report as a node would force
one to inherit the other's costs — either reports become immutable and go stale,
or nodes become rewritable and the append-only invariant dies.

Keeping them apart buys three things. Rendering is safe to repeat, because it
writes nothing. A failed render costs a re-run rather than a repair, because
there is no half-written record to reconcile. And an output can freely fold
across analyzers, because it is a read.

The corollary is that an output never *fills* the graph: it displays what
analysis has already found. A report that looks empty means analysis has not
run, and the tooling says so rather than rendering a blank page as though the
day were quiet.

### Deterministic first, language model second

Analysis is layered. A deterministic layer measures every turn with no model
calls at all — lengths, tool failures, wasted output, signs of correction, a
friction score. Only the turns that look high-signal are escalated to a
language-model layer for a nuanced judgement, and only then does a session-level
layer synthesise everything into proposals. The reason is cost and reliability:
the cheap, repeatable layer does the bulk of the triage and always works, the
expensive layer is spent sparingly on the moments that warrant it, and the whole
pipeline still produces useful structure even if the model layer is unavailable.

Two independent 2026 results argue this layering is not merely the cheap choice
but the accurate one. Dubey (2026) builds both layers for live agent monitoring
and finds the deterministic checks beating the trained monitor outright — 60% of
failures caught at zero false positives, against the learned monitor's 54% at a
17% false-alarm rate — and the deterministic layer transfers across model
families unchanged where the monitor's transfer falls to chance. SWE-Replay
(2026) reaches the same conclusion from the other side: its LLM-as-a-judge
selector underperforms a cheap deterministic signal at higher cost. A model
asked to *judge* is the weak link in both systems; a model asked to *interpret
a specific escalated case* is not. That is the split this layering encodes.

A final, optional layer **replay-validates** the proposals (see *Replay
validation*): it re-judges each proposal's originating turns with and without the
candidate rule, using a distinct model, and grounds the proposal's confidence in
whether the rule actually averts the friction — turning a self-rating into an
empirical score without ever editing anything.

**Tool arguments and error payloads are first-class evidence.** Analyzers may
consume tool-call arguments and tool-result error text, not just message prose.
This lets the classifier diagnose the *mechanism* of a failure (wrong flags, a
missing `--repo`, targeting the wrong resource) instead of paraphrasing the
user's complaint. DebugRepair (2026) makes the general form of this argument:
outcome-level failure symptoms show *how* a failure was observed but not the
intermediate state needed to explain it, so a model reasoning from symptoms
alone infers causes it has no evidence for. Their ablations put roughly a
quarter of end-to-end quality on having that evidence — and another quarter on
selecting it by *relevance* (backward-slicing from the failure) rather than by
position, which is the direction this channel still has to grow.

The deterministic correction regex in `turn-pair-core` is a
*ranking signal only* — it enriches pairs it matches with a `note=` hint — but
it must never *gate* what the synthesizer is allowed to see. Every pair carries
a truncated verbatim user-text snippet in the digest; pairs the regex misses are
still visible to the session-level LLM. The un-gating ensures that recall is
not bounded by regex coverage.

### Synthesis enumerates exhaustively; volume managed by display-time grouping

The reduce prompt must not prune or merge distinct friction during generation.
Instead of asking the model to "prefer a few" proposals, the synthesis contract
requires it to **enumerate** every distinct friction point as a textual gradient
(description, what_to_change, evidence, severity) and then emit one proposal
per enumerated point. Reinforcement proposals may also be emitted for positive
patterns worth preserving. Overlapping or redundant proposals are acceptable;
deduplication is a downstream concern handled at display time, not at synthesis
time. This ensures recall does not fall as a session gets longer: every distinct
friction surface is preserved regardless of how many there are, and the human
(or AI agent) reviewing the output can group and prioritise rather than having
the model silently drop signals. The enrichment cap for high-signal turns must
also scale with session length so that long sessions are not under-enriched;
a hard ceiling still bounds cost.

### Model access through the host platform, with a test seam

All model calls go through one seam that, in production, defers to the host agent
platform's own provider system. The system does not embed provider SDKs, manage
its own keys, or talk to a local model server. The reason is to have exactly one
place where models and credentials are configured — the same place the user
already manages them — and to avoid drift between this tool and its host. That
same seam accepts a deterministic stand-in for testing, so the analysis logic can
be verified end to end without a network, a key, or any nondeterminism.

### Proposals are materialised from their source

Proposals are synthesised inside session-level analysis but then lifted into a
dedicated, fast store for review, each carrying an evidence trail back to the
conversation. A proposal's identity is its **input key**, derived from the
content-addressed **output key** of the node that produced it plus its ordinal
in that node's output — never from the model's free-text title, path, or
severity. So re-materialising the same node is idempotent (it never double-
inserts), but two genuinely distinct sources — a different session, or a revised
version — keep their proposals separately. Because identity is the input key
alone (independent of status), a proposal is materialised **exactly once** and is
never re-created in the *open* state after a human has decided it — the decision
is preserved across every later recompute. Overlapping suggestions across
sessions are intentionally retained rather than collapsed: the review step is
expected to be consumed with the help of an AI agent that sees the whole
picture, so the listing simply groups proposals per session and ranks them
by confidence. The reason identity is anchored to the source rather than the
wording is that an idempotency key must be a function of *inputs*; the LLM's
output never feeds it, it only flows into a downstream consumer's source
reference via the output key.

---

### Human decisions are external input, not derived analysis

When a human accepts or rejects a proposal, that verdict — with its rationale,
disposition, and a note of what was actually changed — is recorded in an
append-only decision log keyed by the proposal's content-addressed input key.
Decisions sit on the *input* side of the system, alongside conversation
messages: they are never analysis nodes, never participate in a proposal's
identity, and the latest decision for an input key is authoritative. Keying on
the input key (rather than a row id) is what makes a decision durable: wipe the
database, re-sync, re-analyse, and the same proposal is regenerated with the
same input key, so its decision re-attaches automatically. This decision corpus
is the gold-label training signal for a future meta-analyzer, which consumes it
as a source (folding the decisions into *its* identity, exactly as a turn-pair
analyzer folds in messages) and proposes changes to analyzer prompts, config, or
standing instructions so that future proposals are higher quality.

The decision log is more than durable memory: it is the **event source** that
makes the one mutable thing in the system — `proposals.status` — reconstructible
at a point in time. Replaying `proposal_decisions WHERE decided_at <= T` and
taking the latest per `proposal_input_key` yields every proposal's status as of
`T`; a proposal with no decision by `T` was `open` at `T`. This is what makes an
`--as-of` view of proposals honest rather than a leak of the current state into
the past.

### Point-in-time (`--as-of`) reads

Because the graph is append-only, **"the graph as of T" is simply the nodes with
`created_at <= T`** — no snapshots, no history table. Read commands accept
`--as-of <timestamp>` (an ISO instant or a relative duration like `7d`) and,
for an exact and unambiguous alternative, `--as-of-run <id>` (the run's recorded
`finished_at` boundary, preferred because nodes written concurrently within a
run can interleave and a mid-run instant yields a partial view). An as-of view
is always labelled as a *view*, never presented as current state.

`prospect diff` builds on these reads to compare nodes across versions (`--unit`),
runs (`--runs`), and points in time (`--as-of`). Because identities are
content-addressed, a diff is attributable: same `input_key` with a different
`output_key` means the identical recipe produced a different conclusion, while a
different `input_key` lets the analyzer version, config fingerprint, or source
set explain *why* the recipe moved.

---

## 4. Invariants

These statements must always hold. If a change would violate one, the change is
wrong.

- Rendering an output writes nothing. No node, run, edge, proposal or decision
  is created by producing an artifact, so an output can be re-rendered any
  number of times without touching history, and no output can be a step in
  analysis.
- A node, once written, is never modified or deleted. **Retraction** is how the
  invariant is enforced rather than merely expected: `prospect gc` sets a
  `retracted_at` tombstone (with a `retracted_by_run` provenance) instead of
  issuing a `DELETE`, so the node and its history remain and as-of reads still
  see it before its retraction. Ordinary reads go through the `live_nodes` view
  (`retracted_at IS NULL`); a retracted node is absent from live reads and from
  scanning, so its unit classifies `missing` and is recomputed. Retraction is
  reversible (`retract --undo` clears the column) and only a deliberate
  `purge --retracted-before <ts>` physically reclaims the space. A retracted
  node is still verified — its content must still hash correctly.
- Every relationship is an edge with a valid kind and a valid target type; no
  relationships are stored anywhere else.
- A node's identity equals its recipe fingerprint — analyzer, version, config,
  and inputs; two nodes with the same recipe never both exist.
- The analyzer's shipped logic, default prompt, and default tier are represented
  by its version; everything the user sets, including the resolved model, is
  config. The version is graded major/minor by the author; config is never
  graded. An analyzer that uses no model has no model in its identity.
- Re-running analysis without changing the version, config, or inputs produces no
  new nodes.
- Improving an analyzer means a new version and new nodes; existing nodes for the
  old version remain and stay reachable through lineage.
- An analyzer reads only the conversation, its own nodes, and the nodes of its
  declared dependencies. A corpus-scoped analyzer may read those dependency nodes
  across every session, but never a dependency it did not declare.
- The learned lexicon only ever *widens* detection. No pre-existing path to
  friction may be made conditional on a word being in it.
- Sessions are read-only; the system never writes to the conversation record.
- A proposal can always be traced, via edges, back to the conversation evidence
  that justifies it.
- The system proposes changes to steering artifacts; it never applies them
  itself.
- A human decision is external input: it is append-only, keyed by the proposal's
  input key, never an analysis node, and never part of a proposal's identity. A
  proposal materialises exactly once per input key, so a recorded decision is
  never lost to recompute.

---

## 5. Boundaries and non-goals

To keep the system focused, the following are explicitly *not* part of it:

- **No automatic editing of steering artifacts.** The system surfaces proposals;
  acting on them is a human decision.
- **No eager deletion of superseded analysis.** Old versions are kept for
  comparison; reclaiming space, if ever needed, is a separate, deliberate act
  (`prospect gc` is that deliberate act — a single supported inverse for a run
  or an analyzer that removes the nodes, both edge directions, and the
  proposals materialised from them, in one transaction, while never touching
  human decisions).
- **No bespoke model or credential management.** Model access is delegated to the
  host platform; tiers abstract concrete models.
- **No cross-session meta-analysis as a first concern.** The unit of analysis is a
  session; broader pattern-finding builds on top of that later. **Success/failure
  contrast** is in scope both within-session and cross-session (a session may
  reference smooth sibling sessions in the same repo as negative examples, folded
  into its source set so identity stays content-addressed); cross-session proposal
  consolidation/dedup is still out of scope.
- **No real session data inside the project.** All test material is hand-written
  synthetic conversation; real user sessions never enter source, tests, history,
  or build artifacts.

---

## 6. How to think about a change

When extending this system, ask in order:

1. **Which concept am I touching?** Name it using the ubiquitous language above.
   If you find yourself needing a term that isn't here, that's a signal to define
   it here first.
2. **Does it preserve append-only and edge-only relationships?** If a change wants
   to mutate a node or hide a relationship, reconsider.
3. **Does identity still equal the recipe?** If a change affects a node's content,
   make sure it also affects the recipe, so idempotency and invalidation stay
   honest.
4. **Is the work still discoverable by scanning?** New analysis must be something
   a scan can classify as missing, stale, or current — not something tracked by
   side state.
5. **Is the evidence trail intact?** Any new node that informs a proposal must be
   reachable, by edges, from that proposal back to the conversation.
6. **Does a clean session still produce output?** A session with no friction is a
   first-class analysis subject. A change that would make the pipeline skip or
   produce nothing for a clean session is a recall regression.

Hold to these and the system stays what it is meant to be: a trustworthy,
cheaply-recomputable engine that turns the friction in past agent conversations
into clear, evidence-backed suggestions for making the next conversation better.

---

## 7. Supporting literature

The architectural bets above were made before this work was published and are
recorded here because it corroborates them. None of it is a dependency; the
value is being able to tell which choices have external support, which have
only our own reasoning, and where the literature says we are still short.

- **Zhao et al. (2023), ExpeL: Experiential Learning of LLM Agents.**
  Comparing successful against failed trajectories is what produces usable
  insight; summarising one side alone is not enough. → *Success/failure
  contrast*, positive signals, reinforcement proposals.

- **Dubey (2026), Real-Time Detection and Repair of LLM Agent Failures**
  ([arXiv:2608.02464](https://arxiv.org/abs/2608.02464)). Deterministic,
  label-free checks beat a trained monitor on the same corpus — 60% detection
  (96% with a coverage check) at zero false positives, against 54% at a 17%
  false-alarm rate — and transfer across model families where the learned
  monitor does not. Its failure taxonomy names looping and tool-cascade, which
  the trajectory analyzer detects. → *Deterministic first, language model
  second*; trajectory analysis; the one-class framing of contrast.
  **Where it says we are short:** we detect none of goal drift, fabrication,
  silent abort, or contract violation, and nothing in the pipeline accumulates
  friction across turns, so gradual drift trips no threshold.

- **DebugRepair (2026)**
  ([arXiv:2604.19305](https://arxiv.org/abs/2604.19305)). Outcome-level
  symptoms under-determine root cause; evidence must be intermediate, and it
  must be selected by relevance rather than by position. → *Tool arguments and
  error payloads are first-class evidence*.
  **Where it says we are short:** our evidence is capped positionally, not
  sliced back from the failure to what actually determined it.

- **Scaling Test-Time Compute for Agentic Coding (2026)**
  ([arXiv:2604.16529](https://arxiv.org/abs/2604.16529)). Selection among
  long-horizon trajectories works by structured *comparison* of compact
  summaries, not by asking a model to score them. → *Replay validation*, and
  the refusal to rank on a model's self-rating.
  **Where we go further:** replay validation is counterfactual rather than
  comparative — it injects the candidate rule and checks whether the friction
  flips, which grounds a proposal in isolation instead of only against its
  rivals.

- **SWE-Replay (2026)**
  ([arXiv:2601.22129](https://arxiv.org/abs/2601.22129)). Filter trajectories by
  outcome before mining them; a cheap deterministic selector beat an
  LLM-as-a-judge at lower cost. → *Deterministic first*; success/failure
  contrast.
  **Where it says we are short:** we assign no outcome label to a session, so
  we cannot filter or weight by it.

- **LivePlan (2026), Online Monitoring and Corrective Steering of
  Programming Agents**
  ([arXiv:2608.06701](https://arxiv.org/abs/2608.06701)). A deterministic,
  rule-based monitor detects *behavioral drift* over a trajectory (Graphectory
  back-edges for repetition/oscillation, Langutory phase sequences for plan
  violation and stagnation) and only then consults an advisor LLM for a single
  next-step correction. Its ablation shows event-triggered advice beats
  periodic advice despite *fewer* interventions — misleading advice is worse
  than no advice, so an LLM asked to judge is the weak link. → *Deterministic
  first, language model second*; selective escalation; *Tool arguments and
  error payloads are first-class evidence*; trajectory analysis (stuck-loop,
  oscillation).
  **Where it says we are short:** its Langutory phase representation detects
  *plan violation* (premature patching, skip validation), *long stagnation*, and
  *thought oscillation* — none of which we detect, and nothing here accumulates
  friction across turns so gradual drift trips no threshold. Its
  plan-compliance score (PPC/POC/PPF/PC) deterministically separates resolved
  from unresolved trajectories, which is the session outcome label we still
  lack. Its advisor slices the trajectory *from the last trigger* (event-centered),
  where our evidence is capped positionally.
