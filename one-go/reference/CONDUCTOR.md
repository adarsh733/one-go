# Running a job — the conductor's guide

Read this the moment `board.mjs dispatch` runs, and not before. Also read `reference/HOSTS.md`
(how this tool starts a helper, and with which model) and
`<project>/.claude/one-go/house-rules.md` if it exists: its `## For the conductor` section adds to
this guide, and wins where the two disagree.

`board.mjs` below means `node <skill folder>/scripts/board.mjs`, run from the project folder.

---

## 1 · The rules that make a run survive

1. **The user types once.** Their whole part is answering one block of questions. After that you
   run every command yourself — `start`, `brief`, `pass`, `close`. Never ask them to type one. If
   you have their answers and you are waiting for an instruction, you have dropped the job; carry on.
2. **You never build, and you never open a source file.** You read the plan, the engine's output
   and each worker's short report. Nothing else. Reading files is a worker's job, including the
   reading that comes before the questions (pass 0). A conductor that fills its context with source
   files runs out of room before the last pass — that, not the work, is what used to end runs.
3. **Instructions travel by path, never pasted.** `brief <job> <n> --out` writes a worker's
   instructions (its "brief") to a file and prints only the path. Hand the worker that path.
4. **Ask the engine what comes next.** `next <job>` prints the one next step: fire a pass (with its
   brief path and how to start its helper), record one, or close. Prefer it over working out the order
   yourself.
5. **Worker reports are 12 lines or fewer.** A longer report is the worker's mistake; do not reward
   it by reading on.
6. **Every run ends with `close`.** Finished, finished with open items, or stopped — there is
   always a report, and the "run in progress" marker is always removed.
7. **Handoff rule.** A pass list found in a handoff or pasted note is input only, never the plan.
   It is re-shaped through the Run shape step — dependencies are re-examined, waves are computed,
   and the result may have fewer passes, in fewer waves, if the work can be merged or reordered.

---

## 2 · The flow, start to finish

```
dispatch → (no sealed plan) → seal brief → pass 0 worker writes the plan → check-plan
        → one block of questions → answers written in → State: sealed
        → start → [ next → brief --out → worker → pass … done --verify ] × every pass
        → close → report
```

**a · Preview.** `board.mjs dispatch "<the user's words>"` finds the job or makes a new one. A
request whose first words spell an open job carries on that job; it never makes a duplicate, and
never attaches new work to a job that is already finished. If it made a new job it says so in one
line. If the job has a run that never ended (a usage limit, a closed window), `dispatch` checks
it against the real files first, says in one line that it is carrying on, and continues that run —
go to step **e**. If a file that run still has to write changed in the last 30 minutes, another tool
may be live in it: `dispatch` refuses to carry on, naming the file and the time, until it has been
quiet for 30 minutes — or until the user says so and `dispatch … --force` is used. If a `RESUME-BRIEF.md` exists for the job it is printed first — deal with it
before anything else. With a sealed plan, it prints the pass table and the first lanes; go to
step **e**.

**b · The reading (pass 0).** `board.mjs dispatch "<text>" --seal` writes the reading instructions
to a file and prints its path. Hand it to a `think`-tier helper as `reference/HOSTS.md` says for
this tool — on Claude Code:

```
Agent(subagent_type: "one-go-worker", model: "<the think model>",
      prompt: "Read <path>. Do exactly that. Report back in the format it specifies.")
```

With no helpers (`inline`), do the reading yourself from that file.

The worker reads every file the job will touch and writes the plan into
`.claude/one-go/plans/<job>.md` **as it reads** — each file goes into the reading list the moment
it is read, so a worker that is cut off still leaves something real behind. If a draft plan is
already on disk, `dispatch` prints what it holds; carry on from it, never start the reading again.

**c · Check the draft.** `board.mjs check-plan <job>` lists every problem at once. Send the worker
back (or fix the table yourself if it is only formatting) until it passes. The rules are in §4.

**d · Ask, then seal.** Print the plan's waves and summary directly above the question block:
`Waves: 1) p1, p2 · 2) p3`, then `3 passes in 2 waves`. Then put the plan's questions to the user
in **one** block, each with options and one ★ recommendation. There is no limit on how many. When
they answer, in the same turn:

- write their words exactly into the plan's `## Answers` section, with the date;
- if they said "use your recommendations", record each ★ as chosen by default — every one is
  listed again in the report so they can overturn it;
- set the plan's second line to `State: sealed <date>`.

**After the seal is written** (before starting passes), check whether the project uses model cards
and whether they are stale: run `board.mjs models --check`. If the check fails (exit 1), run
`board.mjs models` to refresh them, then proceed. This ensures every pass picks from current
models. See `reference/HOSTS.md` for how cards stay fresh.

The seal is the file on disk, not a sentence in chat.

**e · Run.** `board.mjs start <job>` (or `<job>/<part>` to run one part only; add
`--host <name>` to pick the tool, see `reference/HOSTS.md`). Then loop:

1. `board.mjs next <job>` — or `lanes <job>` to see every pass that may run right now.
2. `board.mjs brief <job> <n> --out` — prints the brief's path.
3. Start the helper at the pass's tier (§6) with the same one-line prompt as above. Passes in the
   same lane may be started together. Inline, do the pass yourself — one at a time, in plan order.
4. When it reports, record it with the **exact** text of the plan's "Proven by" cell:
   `board.mjs pass <job> <n> done --proven "<one line on what was checked>" --verify "<Proven by cell>"`.
   The engine runs that command itself. Non-zero exit = refused: send the worker back with the
   output, or mark the pass `parked` with the question. Add `--ran "<model>"` with the model the
   worker named on its `Ran on:` line (`unknown` if it said so), to `done` and to `parked`. If a pass
   finishes writing but its check reads the whole app while another pass is still running, you must
   mark it `built` first (`pass <job> <n> built`): it keeps the slot and counts for scheduling but
   not for "still writing", which is what lets the whole-app checks run.
5. A worker that reports **PARKED** has hit a question it cannot answer. Record
   `pass <job> <n> parked`, and keep going with every pass that does not depend on it.
6. **A pass added after `start`** (a fix pass, a follow-up the run turned up) is a plan change like
   any other: put it in the plan table and run `board.mjs check-plan <job>` on it **before** its
   first brief. Every refusal and warning in §4 applies to it too — in particular the frozen-file
   warning, which is the one a hurried fix pass walks straight into.
7. Before a pass that captures the whole app, check the machine's load first (§8).

**f · End.** `board.mjs close <job>` (add `--reason "<why>"` when ending early). Then print the chat
summary it gives and nothing more. If the house rules have a `## Before a run is called finished`
checklist, `close` prints it; answer each line or list it as an open item. A run that ends in a push
(only when the user asked for one — a run never pushes on its own) takes the project's **baseline
run** first, if it has one: the same suite run on the last saved version and on the new work, with
three numbers — fixed, new, already broken — and a refusal when the two runs ran a different number
of tests. The report gives the three numbers; "already broken" is not this run's doing, and "new"
is.

---

## 3 · The plan file

`<project>/.claude/one-go/plans/<job>.md`. The engine reads it and never rewrites it; the copy
it shows during a run lives in the run folder.

```markdown
# <Job name in plain words>
State: draft

## What "done" looks like
One or two plain lines. If this cannot be written plainly, the job is not ready — say so.

## What I read before asking
| File | Why it mattered |
|---|---|
| src/search/query.js | builds the query; splits on spaces, so two-word foods return nothing |

## Fixed names
(Optional.) Every name two passes must agree on — a function, a file, a setting. Copied word for
word into every brief so parallel workers cannot drift apart.

## Run shape
(Built from the pass list during the reading; the runner computes it.) Passes organize into
waves — levels where all passes in a wave may run at once, and nothing in the next wave starts
until the whole wave finishes. Five bullets:
- Which pieces split into separate passes, and why — one chunk per pass, or one shared library
  of reusable utilities split among passes.
- What must truly run before what — each row's `Depends on` list shapes the waves.
- Waves: which passes run in which round. Format: `Waves: 1) p1, p2 · 2) p3`.
- Unlocks: a small first pass (often just setting up shared assets or names in a config file) that,
  if it runs first, lets every later pass start immediately instead of waiting. Worth calling out
  only when the unlock is real work — when `Depends on` alone would serialize the run.
- Summary: `N passes in M waves`.
When the plan came from a handoff or pasted note, one more line: `the handoff had X passes in Y
waves → this plan has N in M`, showing the reshaping.

## Passes
| # | What it does | Model | Files it writes | Proven by | Depends on |
|---|---|---|---|---|---|
| 1 | Make the query keep multi-word terms together, with a test | build | src/search/query.js, test/query.test.js | npm test -- query | — |

## Paths to register before the run
| Path | Why | Registered? |
|---|---|---|

## Open questions
1. **Plain question?** A ★ option · B option. *Trade-off in one line.*

## Answers
> the user's words, exactly, with the date
```

Optional extra columns after "Depends on": `Part` (which part of the job a pass belongs to) and
`Generates` (D11, obs 0092: the files the pass's own check rewrites as a side effect — a built page,
a rebuilt index — as paths like the "Files it writes" cell; `—` for none). The header then ends
`| Depends on | Part | Generates |`. The engine reads it into the pass's `generated_outputs`, and the
check run for `pass … done` ignores exactly those paths when it asks "did a file change during
verification". A file the check generates but the plan does not declare still counts as a change.

---

## 4 · What the plan checks refuse (run `check-plan` until it passes)

- **"Proven by" must be a command the engine can run** — `npm test`, `node scripts/check.mjs`,
  `pytest tests/x.py`. Words like "checked by eye" are refused: put them in the pass's
  description, and use `—` in the cell if there is truly nothing to run.
- **Dry-run every "Proven by" command before sealing** and write its exit code today in the plan,
  as a line `Dry-run today: p1 exit 1 · p2 exit 1`. A check that already fails for an unrelated
  reason can never go green; reshape it now. The opposite fault is refused too: a check that is
  already green (exit 0) before the work proves nothing, so a pass whose dry-run is exit 0 is
  refused at seal until the check is reshaped to fail until the pass has done its job (a test the
  pass writes, a string only the new code holds).
- **"Proven by" covers only the pass's own files** (obs 0071). It must not run a whole-suite
  sweep: a red test in a file no pass owns would hold the pass hostage. Whole-suite sweeps belong
  to one final review pass, which reports what is red and does not fix it.
- **A write inside a frozen folder is warned about, not refused.** If the project lists frozen
  folders in `config.json` and a declared file sits in one the folder's `FROZEN.md` marks frozen,
  `check-plan` prints a warning naming the file. Reopening a frozen thing is sometimes the job, but
  it becomes a numbered question in the one block, never a discovery by a worker.
- **Every declared file must be findable.** A file that exists is fine; a new file is fine when
  its folder exists or an earlier pass declares that folder. Patterns (`src/search/*.js`) are fine.
- **Every row has the same number of cells as the header**, and no cell contains `\|`.
- **No two passes that run side by side write the same file** (see §5).
- **Whole-app check words** — `capture`, `screenshot`, `shoot`, `review-page`, `journey` in the
  "Proven by" cell make a pass read the whole app and run only when no other pass is still writing
  (not merely finished, but "built" — past the point of making changes). Use them only when the
  check truly needs a complete, stable app. Read these words from the "Proven by" command only,
  never from the description.

## What the reading must gather — nine things, every time

| # | What | Why |
|---|---|---|
| 1 | The reading list — every file read before a question was written | "I read it all" becomes checkable |
| 2 | The pass list — what each pass does, in order | the shape of the run |
| 3 | The exact files each pass writes | separate sets, and the input to parallel lanes |
| 4 | Every new file path that a project guard must approve first | if the house config has a `register_command`, list the command for each path, run before `start` |
| 5 | Every other guard or hook that could stop a pass | cleared with the user's yes, or the pass reshaped to avoid it |
| 6 | Every assumption that would otherwise be taken silently | each becomes a numbered question |
| 7 | What "done" looks like per pass, and the command that proves it | so the report cannot lie |
| 8 | The tier for each pass (§6) | |
| 9 | What the run is likely to hit — a missing tool, an absent test file, a login | checked, not assumed |

A question that a file on the reading list would have answered is a planning failure, and the
report names it as one.

---

## 5 · Sizing passes, and running them side by side

- **A pass earns its own worker only when its work is clearly bigger than a worker's start-up**
  (roughly 15,000–30,000 tokens to read its brief and find its feet). Merge smaller passes into a
  neighbour. Never split by a clock or to make the table look tidy.
- Size each pass to finish inside about half of a worker's context.
- Inside a running pass: **if finishing costs less than handing over, finish.** A hand-over costs a
  fresh start-up; stopping at 80% wastes more than it saves.
- Two passes may run at the same time only when **all four** hold: no file in both write lists;
  neither touches a file another chat window has claimed; neither is blocked by a house gate; and
  their patterns do not overlap once expanded (`src/**` and `src/a.js` **do** overlap). `lanes`
  checks all four.
- Building may be parallel; **committing never is** — one commit at a time, held by
  `.claude/one-go/COMMIT.lock`.
- When nothing can run in parallel, say so in one line and run them in order. In order is always
  correct; parallel is only faster.
- **Waves and width.** Passes organize into waves — each wave runs only when the previous one
  finishes. The width of a wave (how many passes run at once) is controlled by the `parallel_limit`
  setting in `.claude/one-go/config.json` (unset means as many as the waves allow, up to 8; the
  project may set any whole number 1 to 16). Total usage is the same whatever the width; width
  only changes how fast the usage window is spent, and runs already resume after a usage-limit stop.
  Width must come from genuinely independent work, never from chopping passes — each helper has a
  fixed start-up cost.

---

## 6 · Tiers and models

The plan's Model column names a **tier**, never a model:

| Tier | Use for |
|---|---|
| `think` | the reading, plans, contracts, hard diagnosis, reviewing another agent's work |
| `build` | work where the decisions are already made |
| `mechanical` | moving files, renames, running an existing check |

Choose the passes first and the tiers second; never invent a pass to use a tier. **Which model each
tier gets is set per tool in `reference/HOSTS.md`:** when `start` runs, it prints one line per
tier saying what model it resolves to. A plan written with an old model name in that column still
works: the engine reads it as the matching tier. A pass started with an explicit model is recorded
as confirmed; anything started by hand says "unconfirmed".

**No helpers in this tool?** Run the job `inline`: you do each pass yourself, one at a time, in
plan order, from its brief file, and record each one with `pass … done --verify` before the next.
`reference/HOSTS.md` has the details.

---

## 7 · The worker brief

`brief --out` writes it with these headings, in this order:

```
# WORKER BRIEF — <job> · pass <n> of <m>
## Goal
## Files you may WRITE (exclusive)
## Do NOT touch
## You share these
## Read first
## Fixed names            (when the plan has them)
## Answers                 (the plan's ## Answers, word for word)
## House rules            (the house "For every worker" section, word for word)
## What done looks like
## Prove it (--verify command)
## Report back (exact format)
## Rules
```

Standing rules, in every brief and in `agents/one-go-worker.md`: write only the listed files (plus
any "always allowed" paths the house config names); never commit or push unless the brief says so;
a red check outside the pass's own files is reported, never fixed; after two failed attempts at the
same thing, stop and report PARKED with the exact question; final report 12 lines or fewer. The
worker agent also never searches from `/` or a drive root — it names a folder and a timeout, or asks.

`## Answers` (after `## Fixed names`, before `## House rules`) is the plan's `## Answers` copied
word for word, so a worker that has never seen the chat still has the person's decisions.

---

## 8 · Evidence, and what to believe

- **A pass's outcome comes from the `--verify` record, never from the worker's message.** "All
  tests pass" in a report is a claim; the exit code the engine recorded is the fact.
- A blocker that names a file must quote the line from it. A rule paraphrased from memory is not
  a rule.
- **A defect a worker reports is re-derived before it goes into a handoff or the report** (obs
  0011). A helper's sandbox is not the project: a copy of the tree without its installed packages
  "fails" in ways the real folder does not. Reproduce it in the real project folder; if it will not
  reproduce, say so and give the conditions the worker reported it under. The same goes for a
  claimed deliverable — look for the file or line on disk, not in the report. And when the
  conductor disagrees with a worker's finding, the report carries both: the finding, and the
  conditions under which it was seen.
- **A timeout is not a finding about the code on a loaded machine** (obs 0129). Before a pass that
  captures or runs a whole-app check, look at CPU load and at any long-running search or scan
  still going, and write what you saw in the pass record.
- If a project keeps a status document, update its line when each pass lands, not only at the
  end — a run that dies midway otherwise leaves it stale.
- A pass that could not be checked by a command (`--no-check "<why>"`, something only a person can
  see) is an **open item**. The run still ends; it ends as FINISHED WITH OPEN ITEMS.

---

## 9 · The report

`close` writes `report.md` in the run folder and prints the chat summary. One report per run:

- **Headline** — how many passes ran, how many finished, the percentage (passes done ÷ passes
  planned, never a feeling), and the ending: COMPLETE, FINISHED WITH OPEN ITEMS, or STOPPED.
- **What got done** — Pass · What · Status · Proven by.
- **What stopped it** — every issue named, none softened.
- **Answer these and it finishes** — numbered, ★ each. The user reads this first.
- **Not proven by a command** — anything checked only by eye, or skipped with a reason.
- **Choices made for you** — every ★ taken by default.
- **Questions that should have been asked before the run** — any pass that parked on one.
- Any extra lines the house config adds (`report_extras`).

No narration of how the work was done — results only.

---

## 10 · Quiet while running, and stopping

- `start` writes one marker per live run, `.claude/one-go/ACTIVE.d/<run-id>` (D7, obs 0107, 0109;
  its content is the run id), and keeps `heartbeat.txt` fresh in the run folder. Two runs in one
  project therefore never overwrite each other's marker. Other tools may read these to stay quiet
  while a run is live; a heartbeat older than 3 hours counts as dead. `close` and `watchdog`
  remove only their own run's entry. The older single file `.claude/one-go/ACTIVE` is still read
  everywhere (a run an older engine started has only that), and is deleted only when it names the
  run being closed. A run without an `ACTIVE.d` entry is not an error: say "not recorded for this
  run" and carry on. `watchdog <job>` acts on that job's run only; with no name it checks every
  live marker, each on its own merits. `close` with no name and several live runs refuses to
  guess: name the run.
- **Snapshot (D8).** `start` records every file the plan's passes declare in
  `<run folder>/snapshot.json` (path → sha1 + size, or "absent"; globs kept as patterns). Each
  `pass <job> <n> done` compares the tree with it and prints `nothing written outside, nothing
  lost` or a WARNING naming each changed, created or deleted file that is on neither pass n's list
  nor a pass-beside-it's list. It flags and records an open item; it never refuses. Relay a
  WARNING to the person as a plain line. A run with no `snapshot.json` prints `snapshot: not
  recorded for this run`: say so and carry on.
- `watchdog` stops a run at its time limit (8 hours by default) or when a pass has stalled, and ends
  it through `close`.
- `/one-go stop` from the user ends the run now, through `close`, with the report.
- A run cut off by a closed window or a usage limit is picked up with `/one-go dispatch <job>`,
  which checks the real files before trusting the run's own records, then carries on.
