# Hosts — where the passes run, and with which model

A **host** is the tool a job's passes run in. Read this with `reference/CONDUCTOR.md` when a job
starts. The plan never names a model: each pass names a **tier**, and the host turns the tier into
a model.

| Tier | Use it for | Effort |
|---|---|---|
| `think` | the reading, plans, contracts, hard diagnosis, reviewing another agent's work | high |
| `build` | ordinary building where the decisions are already made | medium |
| `mechanical` | moving files, renames, formatting, running an existing check | low |

## The rulebook — one row per tool

Every fact in this table was read from the tool itself (its `--help`, its own models list), never
guessed. Re-check a row when the tool updates; the "Checked against" column says how.

| Tool (host) | How a helper starts | How a tier becomes a model | Model id the tool accepts | When the tier has no model | Checked against |
|---|---|---|---|---|---|
| `claude` — Claude Code | Agent tool, `subagent_type: "one-go-worker"`, prompt = the one line | `model:` on the Agent call; built-in `think → opus`, `build → sonnet`, `mechanical → haiku`, or `hosts.claude.<tier>` | a lowercase alias or model id, no spaces | the built-in alias is used | the Agent tool's `model` parameter |
| `codex` — Codex CLI | `codex exec "<the one line>"` from the project folder (non-interactive) | `-m <model>` added only when `hosts.codex.<tier>` names one | a lowercase slug, no spaces, exactly as in Codex's own models list (`~/.codex/models_cache.json`, entries marked `list`) — a display name with spaces is refused | no `-m`: the helper inherits the main model (`model =` in `~/.codex/config.toml`) | `codex exec --help` (`-m, --model <MODEL>`); the models list |
| `opencode` — OpenCode | `opencode run "<the one line>"` from the project folder | `-m <provider/model>` added only when `hosts.opencode.<tier>` names one | `provider/model`, exactly as `opencode models` prints it | no `-m`: the helper inherits OpenCode's configured model | `opencode run --help` (`-m, --model … provider/model`); `opencode models` |
| `antigravity` — Antigravity | `agentapi new-conversation --model=<id> "<the one line>"` (the `agentapi` launcher in Antigravity's own `bin` folder); the IDE's `antigravity-ide chat -m agent "<the one line>"` also opens one, but its `-m` is the chat **mode**, not a model | `--model=<id>` on `agentapi new-conversation` only | `flash_lite`, `flash` or `pro` — nothing else | no `--model`: the conversation uses the model last picked in the IDE | `agentapi --help`; `antigravity-ide chat --help` |
| `inline` — no helpers | the conductor chat does each pass itself, one at a time | none — tiers are advice only | — | the chat runs whatever model it runs | — |

Where a command is not on the PATH (Codex's desktop install keeps `codex` in its own versioned
`bin` folder), find it once, write its full path into the project's notes, and use that.

## Which host a run uses

The first of these that says something wins:

1. `--host <name>` on `start`, `pass` or `brief`;
2. the plan's `route_policy.host`, counted only in a plan the new engine wrote (it carries the `engine: 2` marker); older plans skip this step;
3. the environment variable `ONEGO_HOST`;
4. `default_host` in the project's `.claude/one-go/config.json`;
5. `claude`.

A name the engine does not know is refused with one line listing the ones it does. The run
records the host it used.

## Which model a tier gets

- **In `config.json`**, under `hosts.<host>.<tier>` — for example
  `"hosts": { "codex": { "think": "<model slug>" } }`. A new model needs only this line, and the id
  must be one the tool itself lists (the rulebook's "Model id" column).
- **Not named there** → no model is passed at all, and the helper inherits the main model — whatever
  that tool is already set to. Nothing goes stale when a new model comes out.
- **Only `claude` has built-in defaults**: `opus`, `sonnet`, `haiku` — Claude Code's own short
  names, which always mean the newest model of each kind.
- A value in angle brackets (`<model slug>`) is a placeholder and names no model.

Other keys per host: `"helpers": false` means this tool cannot start helpers, so passes run
`inline`; `"requires_approval": true` means starting a helper may pop up a yes/no prompt — the
conductor asks for it once, in the question block before the run, never mid-run.

## What `start` prints about models

One line per tier for the run's host — `think → <model>`, `build → <model>`,
`mechanical → <model>`, or `not named — inherits the main model` — then a line starting `WARNING:`

- when every tier resolves to the same model, or none is named (the tiers would make no difference);
- for each named model not in the form that tool accepts (the rulebook's "Model id" column).

A warning never stops the run; fix `hosts.<host>` in `config.json` with an id the tool lists.

## Every host: the same hand-over

Whatever the tool, a pass is handed over the same way:

1. `board.mjs brief <job> <n> --out` writes the brief and prints its path. The brief carries
   `## Model this pass was meant to run on` (host · tier · model) and asks the helper to name the
   model it actually ran on (`Ran on:` in its report).
2. The helper gets one line: `Read <path>. Do exactly that. Report back in the format it specifies.`
   The brief carries the standing rules itself, so a helper needs nothing else. Start it the way
   the rulebook row says, with the tier's model when one is named.
3. When it reports, the conductor records the result with
   `board.mjs pass <job> <n> done --proven "…" --verify "<Proven by cell>"`. The engine runs the
   check itself; the helper's message is only a note.
4. The run report's Model column shows both: `meant: <host> · <model> · ran: <what was reported>`
   (`not reported` until a host or helper says).

Only step 2 differs between tools.

## `claude` — Claude Code

Use the Agent tool with the lean helper agent `one-go-worker` (installed from
`agents/one-go-worker.md`):

```
Agent(subagent_type: "one-go-worker", model: "<model for the tier>",
      prompt: "Read <path>. Do exactly that. Report back in the format it specifies.")
```

`next <job>` prints this line ready to use. Passes in the same lane may be started together.

## When a tool cannot start a helper

If the command is missing, a sandbox blocks it, or the tool has no way to start a second session,
run the job `inline`:

1. **One pass at a time, in plan order.** No passes side by side.
2. For each pass: read `briefs/p<n>.md` (write it first with `brief <job> <n> --out`), do exactly
   that and nothing else, run the pass's "Proven by" command, then record it with
   `pass <job> <n> done --verify "<cmd>"` before starting the next pass.
3. The run is saved after every pass, so a run cut off halfway is picked up by
   `/one-go dispatch <job>` like any other.
4. Tiers are advice only here — the chat runs on whatever model it runs on.

Inline works everywhere; the price is that one chat fills up sooner on a long job. The rule that
the conductor never opens source files does not hold inline — the conductor is the helper — so
keep each pass's reading to what its brief lists.

## Model cards — where to find models, and when they go stale

A **model card** is a project-local record of which models the tools list today, when they were
last checked, and how well each fits the three tiers. The system reads the cards once when a run
starts, picks the best model for each tier on each tool, and uses that choice all the way through
the run. Stale cards never stop a run: `start` prints a warning, and the dispatch block adds one
question asking whether to refresh the cards first (see "When cards refresh").

### Where each list comes from

- **claude** — built-in aliases `opus`, `sonnet`, `haiku` (Claude Code's own short names, always the newest model of each kind);
  no discovery needed, no card needed
- **codex** — `~/.codex/models_cache.json`, entries with `visibility: "list"`
- **opencode** — `opencode models` output, kept to the providers named in `model_scout.opencode_providers`
- **antigravity** — the fixed words `flash_lite`, `flash`, `pro`

### How a tier gets a model

In `config.json`, under `hosts.<host>.<tier>` — for example
`"hosts": { "codex": { "think": "<model slug>" } }`. Or:

- A value of `"auto"` means the scout picks from the cards for that tier
- A model id — kept as written while the tool's own list still has it, so the scout never picks
  again. `claude` pins are always kept, because Claude Code also accepts full model ids that are
  not in its three aliases. A pin the tool's list no longer has falls back (see below). If the
  tool's list cannot be read, the pin is used as written
- A placeholder (`<angle brackets>`) — the helper inherits the main model
- Not named there at all → the helper inherits the main model

A card may carry two optional fields: `quality` (a number 0-100 from one independent benchmark index, compared only within one host) and `quality_source` (that index's web address).
A card may also carry `never_pick`: a one-line reason, such as "the maker may train on prompts". Such a model is never chosen by `"auto"` or by a vanished-pin fallback; a pin you write by hand is still honoured, because that is your explicit choice. Mark every model whose terms let the maker train on prompts, log usage, or come from an unknown maker.
The scout ranks by `quality`, not price — think takes the highest score, build the highest among low- or medium-cost cards (any build card if none), mechanical the cheapest with ties broken by score then speed — and a card without a score falls back to price order and never outranks one that has a score unless no card in that tier has one.
The picker ignores a card's age: stale cards still give picks (only models the tool's own list still has, and only cards that name the tier in `tier_fit`). Age only triggers the refresh question.

### The fallback order when a pinned model vanishes

If a pass names a specific model and that model no longer appears in the tool's list:

1. Try the scout's pick for that tier from the cards (old cards still count)
2. If the cards have no pick (no card file, no cards for that tool, or no card that names the tier
   among the models the tool still lists), no model is passed and the tool's own model runs

A run never stops for a model reason. The warning line is:
`WARNING: <model> is no longer in <host>'s model list — using <fallback> for <tier> instead.`

### When cards refresh

A model card file is **stale** if any of these are true:

- No card file exists
- A card exists but was checked more than 14 days ago
- The tool's model list changed since the card was checked (a new model arrived, an old one was retired)

Stale cards never stop a run. Two places notice them:

- **`start`** checks the run's own host (only when `config.json` sets `model_cards` and that host has
  a tier set) and, if the cards are stale, prints the warning below with the reasons. The run goes on.
- **The dispatch block** adds one question to the open questions: refresh the cards first, or run on
  the old cards. Age only triggers that question; it never changes what the picker chooses.

The warning line is:
`WARNING: model cards are stale (<reason>) — run board.mjs models before the next dispatch.`

`board.mjs models` prints each tool's list and which models need researching; `board.mjs models --check`
does the same and exits 1 when the cards are stale or missing. It is a check you run by hand — `start`
does not call it.

Which tools `models` looks at: with no `--host`, only the hosts that `config.json` sets a tier for
(a pinned model or `"auto"`; the `default_host` counts when it has one) — and if none does, all four
tools. `--host a,b` (or `--host a --host b`) reads exactly the tools named, including ones
`config.json` does not set.
