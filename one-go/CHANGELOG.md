# Changelog

Every dated rule, the reasoning behind it, and the numbered observations that led to it live here,
so `SKILL.md` and `reference/HELP.md` can stay short and timeless. Newest first. "Obs NNNN" refers
to the maintainer's private observation log; the number is kept so each change can be traced.
"The owner" is the person the tool was first built for.

---

From v1.0.0 on, each release starts with `## v<version> — <date> — <title>`. `/one-go update`
prints the titles of the releases it brought in, so keep each title one plain line.

## v1.0.1 — 2026-10-08 — first-job fixes and safer tool set-up

- **The reading pass gets your words, not the job name.** `dispatch "<job name>" --seal` (the form
  the engine itself prints) used to hand the reading helper only the job name, so it planned blind.
  It now uses the request saved when the job was made. (Obs 0236.) Test: `p28-first-run.test.mjs`.
- **No more "…seal-brief" rows on the board.** The reading instructions file was being read as a
  job of its own; such rows an older version saved are now hidden, and dropped the next time the
  board is saved. (Obs 0233.)
- **A big passing check stays passing.** A "Proven by" command that printed more than 1 MB was
  cut off and recorded as a failure. The limit is now 256 MB.
- **Job names never end on a joining word** ("add-a-greeting-function", not "…-function-to").
- **Codex helpers can write files.** `codex exec` is read-only unless told otherwise; HOSTS.md now
  starts Codex helpers with `--sandbox workspace-write`, and says what to check in OpenCode and
  Antigravity so a helper never waits on a yes/no prompt nobody can answer. It also gives the real
  place of Antigravity's `agentapi` launcher.
- **Whole-app checks** also recognise `playwright`, `cypress` and `e2e`.
- **Example settings are all off.** `examples/config.example.json` ships every extra switched off,
  each with a one-line note; `examples/house-rules.example.md` uses neutral examples.
- `/one-go help` no longer shows the agent's own instruction line at the top.
- Tests that assumed the development copy now also pass in a GitHub install (Windows line endings,
  a home folder whose path contains a tool's name).

## v1.0.0 — 2026-10-06 — version numbers and `/one-go update`

- **A version number.** `VERSION` holds it; each release is a git tag `v<version>` on GitHub.
- **Installed from GitHub with git**, not copied by hand (INSTALL.md), so updating is one step.
  A copied folder keeps working but cannot update itself; `/one-go update` says how to switch.
- **The new-version line.** When a job starts, dispatch prints one line if a newer version is
  out. The check runs at most once a day in a background process and saves its answer in
  `~/.one-go/update-check.json`, so a job never waits on the network and nothing changes offline.
  `ONEGO_UPDATE_CHECK=off` turns it off.
- **`/one-go update`** — a fourth public command. It moves the download forward to the newest
  version tag (a fast-forward only, never a merge) and refreshes the Claude Code helper agent
  when it was never edited by hand. It refuses, changing nothing, while a job is running in the
  project, when one-go's own files were edited, when GitHub cannot be reached, and when the
  download's history no longer lines up. `--check` only says whether a newer version exists.
  Test: `p27-update.test.mjs`.

## 2026-10-06 — never-pick cards, quality ranking, one source for the public package

- **`never_pick`** (optional card field, a one-line reason): such a model is never chosen by
  `"auto"` or by a vanished-pin fallback; a pin written by hand is still honoured. The card checker
  prints how many cards carry it. Test: `p26-scout-never-pick.test.mjs`.
- **Ranking by measured quality** (optional `quality` 0-100 + `quality_source`): think takes the
  highest score, build the highest among low/medium-cost cards, mechanical the cheapest. A card
  without a score never outranks one with it. Price alone had picked weaker models as "strongest".
- **The public package is built from the live skill**, never a separate staging copy, so the two
  cannot drift. The no-leaks test finds its word list in the publishing kit again.

## 2026-10-06 — model cards: per-tool model lists, tier fit, and staleness check

**Model card plumbing** — A project-local card file holds which models each tool lists, when
checked, and how each model fits the think/build/mechanical tiers. The scout picks the best model
for each tier on each tool at run start. A card is stale if it doesn't exist, is older than 14 days,
or was checked before the tool's model list changed. After sealing a plan and before starting passes,
run `board.mjs models --check` to verify the cards are fresh; run `board.mjs models` to refresh if
stale. In SKILL.md, a "model card" row joins the words table. HOSTS.md gains a "Model cards" section
naming where each tool's list comes from, how a tier gets a model, the fallback order, the refresh
rule, and the exact warning lines. CONDUCTOR.md instructs the conductor to check and refresh cards
after sealing. Config adds `model_cards` (null or path) and `model_scout` settings. Examples of both
new config keys appear in `config.example.json`.

---

## 2026-10-03 — the observation review: run markers, claims, plan gate, a three-word menu

Every change below works on a run an older engine started: a run with no `ACTIVE.d` entry or no
`generated_outputs` says "not recorded for this run" and carries on; nothing refuses it.

**One marker per live run** (obs 0107, 0109 — D7)
- `start` writes `.claude/one-go/ACTIVE.d/<run-id>` (content: the run id) beside the old single
  file `ACTIVE`. `close` removes its OWN entry unconditionally and deletes the old `ACTIVE` only
  when it names the run being closed, so closing one of two live runs leaves the other's marker.
  `close` with no name and two live runs refuses to guess and lists them.
- `watchdog <job|run-id>` acts on that run only. With no argument it checks every live marker
  (`ACTIVE.d/*`, plus the old `ACTIVE`) and handles each run on its own merits; it no longer takes
  the first marker it finds. `--accept-open` only applies when one run is being handled.
- `worker stop-ack` releases its own run's marker; the board footer reads every marker and names
  each live run. One shared reader/releaser lives in `lib/marker.mjs`.
- The old single `ACTIVE` is still read everywhere (a run an older engine started has only that).
  The hook that stands noisy tools down (`quiet.py`, both copies) reads any live `ACTIVE.d` entry,
  and a legacy `ACTIVE` still counts as live even when its run folder is missing, as before.
- Correction: the first version of this entry said `close` and `watchdog` "remove only their own
  entry". That was half-built: `close` removed its entry only when the old `ACTIVE` also named the
  run, and `watchdog` took the first marker it found. Fixed in a follow-up pass.
- The last line `pass` prints once every pass is done now reads: Run `board.mjs close <job>` to
  finalize (it used to name `watchdog`).

**A snapshot at start, a comparison at done** (obs 0065, 0111, 0135 — D8; it was promised and had not landed)
- `start` records every file the plan's passes declare (path → sha1 + size, or "absent") in
  `<run folder>/snapshot.json`, braces expanded as everywhere else. A glob (`dir/**`) is not walked:
  it is recorded as a pattern, and the folder it sits in is listed one level deep.
- `pass <job> <n> done` compares the tree with it and prints either `nothing written outside,
  nothing lost` or a WARNING listing each changed, created or deleted file that is on neither pass
  n's list nor the list of a pass running beside it. It looks at every file on any pass's list, plus
  the other files sitting directly in the folders pass n writes into. It flags and records an open
  item (`snapshot_flags` and `open_items` in `state.json`); it never refuses. The accepted work then
  becomes the new baseline, so the next pass is judged against it and a file is reported once.
- A run with no `snapshot.json` prints `snapshot: not recorded for this run` and carries on.
- Not covered: a pass ended by `watchdog` or `revive` rather than `pass … done` does not refresh the
  baseline; the next `done` may report that pass's files once.

**Generated outputs** (obs 0092 — D11, one-go half)
- A plan's Passes table may end in a `Generates` column: files the pass's own check rewrites as a
  side effect. `lib/plan.mjs` reads it into `generated_outputs`, `start` copies it into the run
  state, and the check behind `pass … done` skips exactly those paths when it asks "did a file
  change during verification". An undeclared file that changes still counts.

**Claims reader** (obs 0106, 0115)
- `start` prints `claim rows read: N`, so a reader that found nothing no longer looks like a clear
  table. An open claim row that sits outside the claims table is reported, not skipped.
  A leading code-folder prefix (the claims file's own folder) is stripped from both sides before
  files are compared. A row holding control characters, or a drive path with no slash after `C:`,
  is refused and named — it would otherwise match nothing and look free.

**Plan gate and briefs** (obs 0042, 0071, 0019, 0032, 0068, 0057)
- Every worker brief now carries the plan's `## Answers` word for word (0042), and the standing
  rule "a red check outside your files is reported, never fixed" (0071).
- The seal brief and `check-plan` say a "Proven by" command covers only the pass's own files;
  whole-suite sweeps go to one final review pass (0071).
- `check-plan` refuses a pass whose `Dry-run today` entry is exit 0: a check already green before
  the work proves nothing (0019, 0032).
- `check-plan` warns when a declared write sits in a folder the project lists as frozen and whose
  `FROZEN.md` marks it frozen (0068). A warning, not a refusal.
- `dispatch` refuses to "carry on" a cut-off run when a file that run still has to write changed in
  the last 30 minutes — another tool may be live. It names the file and the time; `--force`
  overrides (0057).

**Three-word public menu** (obs 0124 — D9)
- The public menu is `dispatch`, `stop`, `help`. In a count of about 134 dispatches over a long
  history, the person never typed the bare board; the model ran it as its own state check. So
  the bare board moved from the public list to plumbing in `board.mjs`. `/one-go` with no words
  still prints it, quietly. `HELP.md`, `SKILL.md` and `check-help-rows.mjs` list three commands
  and flag a bare `/one-go` row as advertising plumbing.

**Conductor guide** (obs 0068, 0071, 0011, 0019, 0032, 0129 and D7, D10, D11)
- A pass added after `start` goes through `check-plan` before its first brief (0068).
- §4 gains the already-green dry-run refusal, the own-files-only rule for "Proven by" and the
  frozen-write warning; §3 describes the `Generates` column; §7 lists `## Answers`; §10 describes
  the per-run marker.
- §8: a defect a worker reports is reproduced in the real project folder before it goes into a
  handoff; where the conductor disagrees, the report carries the finding and the conditions it was
  seen under; a claimed deliverable is looked for on disk (0011). Check machine load before a
  whole-app capture — a timeout under load is not a finding about the code (0129).
- A run that ends in a push takes the project's baseline run first, if it has one: the same suite
  on the last saved version and on the new work, three numbers — fixed, new, already broken — and a
  refusal when the two runs ran a different number of tests (D10, obs 0073).

**Worker agent** (obs 0129)
- `one-go-worker` (both copies, kept identical) never searches from `/` or a drive root: a search
  it cannot avoid names a folder and carries a timeout. A whole-disk search once outlived its
  worker and starved the machine.

---

## 2026-10-03 — plan in waves, and a model per tier on every tool

**Run shape — organizing passes into waves** (obs 0132)
- Every plan now carries a `## Run shape` section (before Passes) describing how passes organize:
  which pieces split into separate passes and why, what must truly run before what, the wave
  layout, unlocks (a small first pass that frees later parallelization), and the summary.
- Waves are computed from the `Depends on` graph: each wave runs only when the previous one
  finishes. Format: `Waves: 1) p1, p2 · 2) p3`. The conductor prints this line and the summary
  (`N passes in M waves`) directly above the question block.
- **Handoff rule:** a pass list from a handoff note is input only. It is re-examined through the
  Run shape step — dependencies are re-derived, waves recomputed, passes possibly merged or
  reordered, and the result may have fewer passes in fewer waves.
- Whole-app checks (those containing `capture`, `screenshot`, `shoot`, `review-page`, or `journey`
  in the "Proven by" cell) run only when no other pass is still writing. A new pass status, `built`,
  marks a pass finished writing without counting as "still writing" — freeing whole-app passes to
  run in parallel.

**Parallel and throughput** (obs 0053)
- Width (how many passes run at once per wave) is controlled by `parallel_limit` in
  `config.json`: unset means as many as waves allow up to 8; projects may set 1–16. The
  conductor shows the width at start. **Total usage is the same whatever the width; width only
  changes how fast the usage window is spent, and runs already resume after a usage-limit stop.
  Width must come from genuinely independent work, never from chopping passes — each helper has a
  fixed start-up cost.**

**Models and tiers**
- The conductor prints one line per tier when `start` runs, showing what model each tier resolves
  to — think/build/mechanical resolve based on the tool and the project's `config.json`. See
  `reference/HOSTS.md` for per-tool details. No model version in lib or cmd code.

---

## 2026-09-29 — the final clean

**Commands**
- **Four public commands**: `/one-go` (the board), `/one-go dispatch <what to build>`,
  `/one-go stop`, `/one-go help`. `info` and `resume` left the menu.
- `dispatch` picks up a cut-off run on its own: it runs the resume check first, then carries on.
  A long request whose first words spell an open job continues that job instead of making a
  duplicate. (Obs 0104.)
- Silent aliases, never shown: the bare `/one-go <anything>`, `finish` (= `dispatch`), `resume` and
  `revive`, `abort` and `cancel` (= `stop`).
- Retired: `add`, `sub`, `done`, `stage`, `ready`, `audit`, `status`, `watch`, `guard`. Each prints
  one line and exits 1; none becomes a job. Their files moved to the development archive. `info`
  and `lanes` stay as plumbing the agent uses.
- `check-help-rows.mjs` now expects the four public rows and requires `reference/HOSTS.md`.

**Tiers and hosts** (obs 0103)
- Plans, `SKILL.md`, `HELP.md` and `CONDUCTOR.md` name only tiers — `think`, `build`,
  `mechanical` — never a model. Old plans that name a model still map to its tier.
- The one built-in default is Claude Code's `opus` / `sonnet` / `haiku`, which always mean the
  newest of each. Every other tool uses its own configured model unless the project's
  `config.json` names one under `hosts.<tool>.<tier>`; the example config ships placeholders only.
- New `reference/HOSTS.md`: how to start a helper in Claude Code, Codex, Antigravity and OpenCode,
  how a run picks its tool (`--host`, the plan, `ONEGO_HOST`, `default_host`, then `claude`), and
  the `inline` fallback — with no helpers, the same chat does the passes one at a time from their
  brief files, saving after each.
- Install for all four tools: `scripts/install.mjs` links the skill into each tool's skills folder
  (dry run unless `--apply`; never overwrites a real folder). README and INSTALL rewritten for it.

**Carried in from the live skill** (obs 0105, part of 0106)
- The 2026-09-28 fixes: `start` no longer drops plan sections; the seal gate accepts `(new)` files
  and backticked paths; released claims and the Status column are never read as live files; a
  folder-less pattern no longer matches every file; `pass … done` expands braces.

---

## 2026-09-27 — the public cleanup

**Shape**
- The skill is split into a **core** (this folder, knows nothing about any one project) and
  **house rules** (`<project>/.claude/one-go/house-rules.md` + `config.json`). Everything that used
  to name one project's files — the claims board, frozen-screen folders, a pending-push list, an
  open-loops list, a work log, a doc-register command, backup sweeps, report extras — moved into
  house config. No house file = every extra off. (Obs 0103.)
- `SKILL.md` cut from 42,607 bytes to about a quarter of that; the trigger description from 649
  characters to about 330. The conductor procedure moved to `reference/CONDUCTOR.md`, read only
  when a job starts.
- **Six public commands**: the board, `<anything>`, `info`, `resume`, `stop`, `help`. Silent
  aliases kept for every old paste block: `dispatch`, `finish`, `revive`, `status`, `ready`,
  `watch`, `guard`. Plumbing (`start`, `pass`, `brief`, `lanes`, `next`, `check-plan`, `close`,
  `watchdog`, `worker`, `audit`, `add`, `sub`, `done`, `stage`) works but is off the menu.
- **A command word always wins.** An unknown first word prints a one-line hint and exits 1;
  it no longer falls through to printing the board.
- The name stays **one-go**; the public package is MIT-licensed.
- New `agents/one-go-worker.md`: a lean worker (six tools, no model line — the conductor's `model`
  parameter decides) so each worker starts smaller than a general-purpose agent.
- All seven `*.bak-*` files left the skill folder (kept only in the swap backup).

**Fixes**
- `dispatch` attached new work to a finished job whenever the request's slug began with that job's
  slug (the loose `startsWith` branch in `findTask`). New work never lands on a done or absorbed
  job now; a weak match makes a new job and says so. The seal brief is self-contained instead of
  carrying only the slug. (Obs 0104.)
- `dispatch` refuses answer-shaped text ("approved", "go ahead", "use your recommendations"); junk
  board rows had been created from answers.
- The claims check read column 5 as "files" in every layout, so in two projects it compared paths
  against a date. It now finds the Files column by its header, and ignores a claim id that also
  appears under "Recently released". (Obs 0089.)
- One frozen-status reader, negation-aware ("drafted, not frozen" is not frozen), that answers
  "no reader" instead of "not frozen" when it cannot parse the table. (Obs 0009, 0040.)
- `start` no longer overwrites the human plan `.md` with a generated view (it erased the reading
  list and the questions); the view goes to the run folder's `plan.md`. (Obs 0042.)
- The seal gate refused any plan declaring a file the run would create. A new file now passes when
  its folder exists or an earlier pass declares that folder. New `check-plan` runs the gate on a
  draft, so a bad plan is found before `start`. (Obs 0102.)
- A pass row whose cell count differs from the header, or that contains an escaped pipe, is
  refused instead of silently truncated. (Obs 0062.)
- One shared path resolver keeps absolute declared paths absolute (`revive` used to join them onto
  the repo root) and says "cannot resolve" when none resolve. (Obs 0066.)
- When every declared file is missing, `pass … done` now says "declares N files that do not exist"
  instead of the misleading "cannot resolve any" message.
- A whole-tree check is refused while another pass is running. (Obs 0070.)

**Run endings**
- Every run ends through one `close` command: report, end stamp, claims released, the ACTIVE marker
  removed (only when it names this run), board updated. (Obs 0005.)
- A third ending, **FINISHED WITH OPEN ITEMS**, beside COMPLETE and STOPPED. Before this, a run with
  one pass proven only by eye could never close: the watchdog refused to finalize and the run hung
  open, and the board nagged about "runs never finished" forever.
- `revive` is published as `resume`; it counts open items in `reviewer-flags.md` too (obs 0067) and
  `--tidy` removes ghost claim rows.
- The board shows "hooks stood down since <time> by run <id>" while a run marker is live, and the
  separate `status` table folded into the board.

**Conductor guide** (`reference/CONDUCTOR.md`)
- `next <job>` hands the conductor one step at a time and never a file body; the written rule "the
  conductor never opens a source file" had failed twice. (Obs 0061.)
- Briefs carry the plan's reading rows, an optional `## Fixed names` block copied verbatim to every
  worker (obs 0023), the house worker rules pasted verbatim instead of cited (obs 0017), and any
  always-allowed paths plus a `Protocols run:` report line (obs 0076).
- A pass outcome comes from the verify record, never the worker's message (obs 0011); a blocker
  naming a file must quote it (obs 0036); status-document lines ride with each landed pass
  (obs 0100); every Proven-by command is dry-run and its exit code recorded before sealing
  (obs 0101).
- Pass sizing: merge a pass whose work is smaller than a worker's start-up.

**Audit baseline** (moved out of the code comments): measured 2026-09-20/21 — finishes-work 7,
proof 8, token-efficiency 5, crash-recovery 4, planning-cost 4, board-honesty 5, parallel-safety 6.
Runs dated before 2026-09-21 are classed "legacy, not re-judged".

---

## 2026-09-22 — the seal gate at `start`

`start` refuses a sealed plan whose "Proven by" cell is prose rather than a command, whose check
names a path that does not exist, or that declares a missing file. Only runs created on or after
2026-09-22 are gated, so older runs are never re-judged. (Obs 0051, 0064.) This gate quietly turned
a project-side test suite red for fixtures that declared new files — fixed on 2026-09-27 above.

## 2026-09-21 — nothing interrupts a dispatched job

The owner: *"one go dispatch needs to hijack the chat once it is triggered. So handoff or any hooks
should not come in between it."* From `dispatch` (or `finish`) until `done`, `abort`, `stop` or
`cancel`, prompt-level nudges stand down, using a per-session marker so later turns stay covered.
The finish-versus-hand-over rule ("if tokens to finish < cost of a hand-over, finish") stopped
fighting a hook that used to deny writes past the context ceiling.

## 2026-09-20 — dispatch: a conductor and its workers

- The main chat became a **conductor** that never builds; each pass goes to a worker spawned with
  the Agent tool and an explicit model, which records the route as confirmed.
- **Sealing became a worker pass (pass 0).** The conductor used to do the reading itself; on one
  job four chats in a row filled their context reading, were blocked from writing the seal, and
  handed over with nothing on disk. The run that finally sealed fired zero workers.
- The plan is written **as it is read**, not in one write at the end, and the one-go folder was
  exempted from the context-ceiling write block, so a cut-off chat leaves a real draft behind.
- `brief --out` writes the brief to a file and prints only its path (obs 0043); `lanes` shows
  which passes may run together; the split rule: a pass earns a worker only when its work clearly
  exceeds the worker's start-up cost.
- `revive` (now `resume`) reconciles a killed run against the real files, because a killed run's
  `state.json` records intent at its last write, never state (obs 0057).
- Passes mentioning capture, screenshot, shoot, shot, journey, match or review-page are tagged
  `capture-tree` and never run side by side (obs 0053).
- The plan parser stopped at the next `## ` heading; before, it read to end of file and counted
  later tables as phantom passes.
- `audit` added: seven scores against the baseline above.

## 2026-09-09 — words are a note; only a check is proof

`--proven "tests failed"` had been accepted and the run still announced "completed cleanly".
`--verify "<command>"` now runs the check in the project folder and binds its real exit code to the
run, pass and attempt; non-zero refuses `done`. A run proven only by eye does not declare itself
complete. Runs created before this date keep the old behaviour. (Defect R1.)

## 2026-09-08 — evidence, honesty about dispatch, and parts

- `pass … done` needs `--proven "<what you checked>"`; "—", "none", "n/a" and "tbd" are refused.
  Reproduced first: a single pass with no evidence was finalized as COMPLETE.
- The docs stopped claiming the engine dispatches workers by itself; it decides what, in what
  order, on which model, and records the result.
- A `Part` column so finishing one part of a job no longer ran the whole job's passes (defect D3).
- `start`, `pass` and the board reader were rewritten to close ten reproduced defects; looking at
  the board never writes to it (defect D1).
- **Task-system gate (TASK-ENF-001):** a job carrying a `task_id` is only called complete when the
  separate task system answers ACCEPTED; an unknown pass status is refused by name.

## 2026-09-07 — the board is one table

- The owner: *"I just want a table of list of tasks that are currently running and their overall
  status. Not anything more than that."* One row per job; parts roll up into its bar.
- The owner: *"before asking the questions, read everything which you will touch… not high-level
  questions, but the actual questions that you will have."* Read first, then ask.
- The `finish` preview shows the model per pass and no time estimate — real wall-clock time cannot
  be predicted honestly.
- Handoff notes are not a task source: scanning them invented 10 of 11 "pending on you" items.
- When a run file disagrees with a hand-written board note, the run file wins.

## 2026-09-05 — questions before, never during

- The owner: *"There is no amount of questions that is a ceiling."* Sealing asks everything.
- The owner: *"If there are issues, just note it down. I'll handle it the next day."* The report
  never hides an issue.
- The seal is one plan and one yes — not a design-approval freeze.
- `plan`, `go`, `overnight`, `resume` (the first one) and `plans` were folded into `finish`.
