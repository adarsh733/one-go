# one-go

A work board and an unattended runner for AI coding agents. It works in Claude Code, Codex,
Antigravity and OpenCode; its engine is plain Node.js.

- **`/one-go`** — one table of every job in your project and how far each has got.
- **`/one-go dispatch <what you want built>`** — the agent reads every file the job will touch,
  asks you every question it has in **one** numbered block, and then finishes the whole job while
  you are away. You get one report at the end.

## Why

Big jobs done in one chat tend to fail the same way: the chat fills up with file contents halfway
through, a question turns up at 2 a.m., and the work stops with nothing written down. one-go
splits a job into **passes** (steps small enough for one helper agent each), asks every question
before it starts, and keeps the whole plan and every result on disk — so a run that gets cut off
can be picked up where it stopped.

## The four commands

| Type | What happens |
|---|---|
| `/one-go dispatch <what to build>` | Start or carry on a job from plain words. A run that was cut off is picked up where it stopped. |
| `/one-go stop [<job>]` | Stop now; you still get the report. |
| `/one-go update` | Take the newest version. Starting a job tells you in one line when there is one; it never updates by itself, and never in the middle of a job. |
| `/one-go help` | The cheat sheet. |

## How a job runs

1. **Reading.** A helper agent reads everything the job touches and writes a plan: the passes,
   the exact files each pass may change, and the command that proves each pass worked.
2. **Questions.** You get every question at once, each with a recommended answer (★). Answer in
   one line — `1A 2B 3A` — or say "use your recommendations".
3. **Running.** The chat you typed in becomes the **conductor**: it hands each pass to a helper
   agent, runs the proving command itself, and records the real result. Passes that touch
   different files can run at the same time. In a tool that cannot start helpers, the same chat
   does the passes one by one, saving after each.
4. **Report.** Every run ends with one of three endings — **COMPLETE**, **FINISHED WITH OPEN
   ITEMS** (done, but something needs you, such as a look on your phone), or **STOPPED** — and a
   list of anything waiting on you.

**Proof is a command, not a sentence.** A pass is only called done when the command in the plan
(say `npm test`) really ran and returned success. "It works" in a helper's message is not proof.

**It never** pushes, deploys or deletes; asks you questions mid-run; or hides a problem.

## Models

A plan never names a model. Each pass gets a size — `think`, `build` or `mechanical` — and the
tool you run in picks the model. Claude Code uses its own newest models for each size; other
tools use whatever model you have set, unless your project's settings name one per size.

**Automatic model picking (optional).** Set a size to `"auto"` and point `model_cards` at a
"model cards" file: one short card per model saying what it is good and bad at, its cost, its
speed, a measured quality score and the web page each fact came from. At the start of a run
one-go reads each tool's own list of models, and for each size picks from the cards — the
highest measured quality for `think`, the best value for `build`, the cheapest that is good
enough for `mechanical`. When a tool adds a model, or the cards are older than 14 days, the
question block offers to refresh the cards first. A model you pinned that has disappeared gives
a one-line warning and the cards' pick instead — a run never breaks over a model name. A card
marked `never_pick` (for example, the maker may train on your prompts) is never chosen
automatically. Details: `one-go/reference/HOSTS.md`.

## Per-project extras ("house rules")

Out of the box one-go knows nothing about your project. Two optional files in
`<project>/.claude/one-go/` add project habits:

- `config.json` — paths and switches: a file where parallel chats claim the files they are
  editing, folders of approved designs, a work log, extra report lines, and which model each
  size uses in each tool.
- `house-rules.md` — words for the conductor, for every helper, and a checklist before a run is
  called finished.

Samples are in `one-go/examples/`.

## Install

```
git clone https://github.com/adarsh733/one-go.git ~/.agents/one-go
node ~/.agents/one-go/one-go/scripts/install.mjs --apply
```

The full steps, and how updates work, are in [INSTALL.md](INSTALL.md). The version you have is in
`one-go/VERSION`; what changed is in `one-go/CHANGELOG.md`.

The full test suite lives in the development build; a few tests are left out of this package on
purpose because they use example file paths.

## Licence

MIT — see [LICENSE](LICENSE).
