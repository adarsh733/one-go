---
name: one-go
description: An unattended runner for big jobs, with a work board behind it. `/one-go dispatch <what to build>` reads first, asks every question in one block, then finishes the job step by step. Use when the user types /one-go, asks "what am I working on", or wants a big task done without questions midway.
---

# /one-go — the board, and the runner

Two things in one command:

- **The board** — one table of every job in this project and how far each one has got.
- **The runner** — give it a job in plain words. It reads everything the job touches, asks the
  user every question in one block, then finishes the whole job while the user is away. One
  report at the end.

## Words used in this file

| Word | Means | Example |
|---|---|---|
| **job** | one row on the board — a thing the user wants done | "fix the search box" |
| **part** | a piece of a job; parts roll up into the job's progress | "fix the search box / add a test" |
| **pass** | one step of a job, done by one helper | pass 2 = "write the new search query" |
| **helper** | a separate agent that does one pass and reports back in 12 lines | on Claude Code, the `one-go-worker` agent |
| **conductor** | the chat the job was started in, once it runs. It hands out passes and never builds | this chat |
| **plan** | the file listing the passes, the files each one writes and how each is proven | `.claude/one-go/plans/fix-search.md` |
| **seal** | the user's answers written into the plan. Nothing runs off an unsealed plan | "use your recommendations" |
| **run** | one attempt at a sealed plan, with its own folder of state and a report | `.claude/one-go/<date>-<time>-fix-search/` |
| **tier** | how much thinking a pass needs: `think`, `build` or `mechanical` | a design pass is `think` |
| **host** | the tool the passes run in: `claude`, `codex`, `antigravity`, `opencode`, or `inline` (this chat, one pass at a time) | `claude` |
| **model card** | a project-local record of which models each tool lists, checked when a run starts, and how well each fits the tiers | `~/.claude/one-go/model-cards.json` |
| **house rules** | optional per-project extras | `.claude/one-go/house-rules.md` |

## The four commands

The person types `/one-go …`. The agent runs `node <this skill folder>/scripts/board.mjs …` and
prints what it returns, adding only facts the engine cannot know.

| Typed | What happens | The agent runs |
|---|---|---|
| `/one-go dispatch <what to build>` | Start a job, or carry on one already on the board — from a sentence, a pasted note or a long spec. A run that was cut off (usage limit, closed window) is checked against the real files and picked up on its own. | `board.mjs dispatch "<what to build>"` |
| `/one-go stop [<job>]` | Stop now. Claims are released and the report is still written. | `board.mjs stop …` |
| `/one-go update` | Take the newest one-go from GitHub. Refuses, changing nothing, while a job is running or when one-go's own files were edited. `--check` only says whether a newer one exists. | `board.mjs update` |
| `/one-go help` | Prints the cheat sheet `reference/HELP.md` exactly as written. Reads nothing else. | `board.mjs help` |

### Reading what the user typed

1. **A known command word always wins.** `/one-go stop the flicker` is the `stop` command. If the
   rest is not a job name, the engine says so in one line; do not guess what they meant.
2. **Anything else is a job.** `/one-go make the search box handle two words` runs
   `board.mjs dispatch "make the search box handle two words"`. This short form works but is
   never advertised.
3. **An answer is not a job.** "approved", "go ahead", "use your recommendations" belong to the
   question block already open in this chat — record them there. `dispatch` refuses them too.
4. **The bare board is plumbing, not a menu item.** `/one-go` with no words (or `--all`) still
   prints the board — one table, one line per running job, a short footer, changes nothing — via
   `board.mjs`. The agent uses it as its state check; do not offer it as a command.
5. **Old words still work, quietly.** `finish` is the same as `dispatch`. `resume` and `revive`
   list runs that never ended and check one against the real files. `abort` and `cancel` are the
   same as `stop`. Never show these to the user.
6. **Retired words** — `add`, `sub`, `done`, `stage`, `ready`, `audit`, `status`, `watch`, `guard`.
   The engine prints one line saying so. Pass that line on; never turn the word into a job.

### The new-version line

`dispatch` may print one line first: `A newer one-go is out (v…; you have v…). Type /one-go
update to get it …`. Pass it on to the person in one line, then carry on with the job — never
update on your own. It comes from a check made at most once a day in the background, only for a
copy installed from GitHub (INSTALL.md); it never waits on the network. `ONEGO_UPDATE_CHECK=off`
turns it off. This copy's version is in `VERSION`; what changed is in `CHANGELOG.md`.

## Where things live

| Path | What it is |
|---|---|
| `SKILL.md` | this file |
| `VERSION` | this copy's version number, for example `1.0.0` |
| `reference/HELP.md` | the cheat sheet — read it only when `help` is asked for |
| `reference/CONDUCTOR.md` | how to run a job — read it **the moment a job starts**, not before |
| `reference/HOSTS.md` | how to start a helper in each tool, and with which model |
| `agents/one-go-worker.md` | the lean helper agent for Claude Code |
| `examples/` | a sample `house-rules.md` and `config.json` |
| `scripts/board.mjs` | the engine |
| `scripts/install.mjs` | links this skill into each tool's skills folder (dry run unless `--apply`) |
| `<project>/.claude/one-go/board.json` | the list of jobs and their parts |
| `<project>/.claude/one-go/plans/<job>.md` | the plan a person reads and answers. The engine never rewrites it |
| `<project>/.claude/one-go/<run-id>/` | one folder per run: `state.json`, `heartbeat.txt`, `briefs/`, `report.md` |

The engine walks up from the current folder to find `.claude/one-go/board.json`, so no path is
typed by hand. Setting the `ONEGO_ROOT` environment variable points it at another folder.

## House rules — the per-project layer

The core knows nothing about any one project. A project can add two optional files in its
`.claude/one-go/` folder:

- **`config.json`** — paths and switches, for example `"claims_file": ".claude/ACTIVE-WORK.md"`
  (a table where several chat windows note which files they are holding), or which model each
  tier uses in a tool (`hosts`). No file = every extra is off.
- **`house-rules.md`** — words, in three sections: `## For the conductor`, `## For every worker`
  (pasted word for word into every helper's brief) and `## Before a run is called finished`
  (a checklist the ending prints).

A broken `config.json` stops the engine with a clear error; it never quietly falls back. Copy
the files in `examples/` to start one. When house rules and this file disagree, house rules win.

## Tiers and hosts

A plan names a **tier** per pass, never a model. The tool the run happens in turns the tier into
a model: on Claude Code that is built in; in any other tool it is the model the project's
`config.json` names, or else whatever that tool is already set to. A new model needs only a line
in `config.json`. `reference/HOSTS.md` says how each tool starts a helper, and what to do when it
cannot: the conductor then does the passes itself, one at a time (`inline`).

## When a job starts — the conductor

From the moment the agent runs `dispatch`, this chat is the **conductor** until the run ends.
Before the next step, read `reference/CONDUCTOR.md`, `reference/HOSTS.md` and, if present,
`<project>/.claude/one-go/house-rules.md`. The short version:

1. **The user types once.** Their whole part is answering one block of questions. After that the
   conductor runs every step itself; sitting and waiting for another instruction is a bug.
2. **Read everything first, then ask everything at once.** The reading is done by a helper
   ("pass 0"), not by the conductor. A question found mid-run costs a night; found now, one line.
3. **The conductor never builds and never opens source files.** It reads the plan, hands out
   passes, records results. That keeps its context small enough to last the whole job.
4. **Every pass goes to a helper** at its tier (on Claude Code, the `one-go-worker` agent).
   Instructions are written to a file by `brief --out` and handed over by path, never pasted in.
   No helpers in this tool? Run the passes inline, as `reference/HOSTS.md` says.
5. **Every run ends with `close`**, which writes the report with one of three endings: COMPLETE,
   FINISHED WITH OPEN ITEMS, or STOPPED.

## The plumbing — commands the agent uses, not the user

Not on the menu, not in the cheat sheet. `reference/CONDUCTOR.md` says when to use each.

| Command | What it does |
|---|---|
| `board.mjs` (no word; `--all` adds finished jobs) | The board: one table, one line per running job, a short footer. Changes nothing |
| `dispatch "<text>" --seal` | Writes the reading instructions for pass 0 to a file; prints only its path |
| `check-plan <job>` | Runs the plan checks on a draft plan and lists every problem at once |
| `start <job>[/<part>] [--host <name>]` | Begins a run: run folder, state, heartbeat, the "run in progress" marker |
| `next <job>` | Prints the single next thing the conductor should do |
| `brief <job> <n> --out` | Writes the helper's instructions for pass n to a file; prints only its path |
| `lanes <job>` | Which passes may safely run at the same time right now |
| `pass <job> <n> <status>` | Records a pass result; `done` needs `--proven` and `--verify` or `--no-check`; `built` marks a pass finished writing but still counts as running for scheduling |
| `close <job>` | Ends a run: report, end stamp, claims released, marker removed, board updated |
| `watchdog` | Checks a run's time limit and for stalled passes; closes a finished run |
| `info <job>` | Everything about one job: parts, last runs, pass by pass, questions waiting |
| `worker` | Instructions for a helper started by hand in another tool |

## Proof — being marked done is not being proven done

**Words are a note. Only a check the engine ran itself is proof.**

```
board.mjs pass fix-search 2 done --proven "unit tests for the query" --verify "npm test"
```

The engine runs the `--verify` command in the project folder and records the exit code (the
number a program returns when it ends: 0 means success). A non-zero exit refuses the `done`.
The command must match the plan's "Proven by" cell exactly. A pass that truly cannot be run —
a read-only review, say — uses `--no-check "<why>"`, and that reason becomes an open item.

Something checked only by eye ("looked right on my phone") has no exit code, so a run holding
one ends as FINISHED WITH OPEN ITEMS, never COMPLETE, and the report lists what the user still
needs to confirm.

## The board — rules that keep it readable

- **One row per job.** A job's pieces are its parts and roll up into its progress bar. Before
  starting a new job, ask: is this a new job, or a part of one already there?
- A row that became part of a bigger job gets `absorbed_by: "<job>"` instead of being deleted.
- Stages: not started · waiting on you · running · blocked · on your phone · done. Nothing shows
  done until it is proven.
- **Looking never changes anything.** The board, `info`, `lanes` and every refusal leave the
  files exactly as they were. A damaged `board.json` stops the engine; it is never written over.
- **If a run's files disagree with the board, the run files win** and the board is corrected in
  that turn.
- Job names: plain words in dashes (`fix-search-box`). Written once, never silently renamed.

## Never, however it is asked

| Never | Instead |
|---|---|
| Push, deploy or delete | Commit locally at most; the report lists what waits for a push |
| Ask a question mid-run | Small calls are made and listed in the report; big ones park that pass and the rest carry on |
| Take an approval step for the user | A run ends with work waiting for their yes |
| Hide a problem | Every issue is in the report in plain words |
| Guess past a refusal | Say the refusal in one line and what would clear it |

## Keeping the cheat sheet true

`reference/HELP.md` is part of the command. A public command added, renamed or removed here
without the same change in HELP.md is a bug. `node scripts/check-help-rows.mjs` checks that both
files list each of the four public commands exactly once and advertise nothing else.

## Offering it

When a task in any chat is big enough to split — several steps, several separate sets of files —
offer `/one-go dispatch <that task>` in one line instead of building it all in one chat.
