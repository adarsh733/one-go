# Installing one-go

You need **Node.js 20 or newer** (check with `node --version`) and at least one of: Claude Code,
Codex, Antigravity or OpenCode.

`~` below means your home folder.

## 1 · Put the skill in the shared skills folder

Copy the `one-go/` folder from this package to `~/.agents/skills/one-go/`. The result must be
`~/.agents/skills/one-go/SKILL.md` and `~/.agents/skills/one-go/scripts/board.mjs`.

Antigravity reads that shared folder, so for Antigravity you are done with this step.

## 2 · Let your other tools see it

Each tool looks in its own skills folder. One command links the skill into all of them:

```
node ~/.agents/skills/one-go/scripts/install.mjs
node ~/.agents/skills/one-go/scripts/install.mjs --apply
```

The first line only shows what it would do; the second does it. Add `--tool claude`, `--tool
codex`, `--tool opencode` or `--tool antigravity` to do one tool only. It skips a tool that
already sees the skill and never overwrites a real folder that is already there.

What it links, if you would rather do it by hand (a link, or a plain copy of the folder):

| Tool | Folder it looks in |
|---|---|
| Claude Code | `~/.claude/skills/one-go/` |
| Codex | `~/.codex/skills/one-go/` |
| OpenCode | `~/.config/opencode/skills/one-go/` |
| Antigravity | `~/.agents/skills/one-go/` (step 1) |

If your version of a tool looks for skills somewhere else, put the link there instead.

## 3 · The lean helper agent (Claude Code only)

Copy `one-go/agents/one-go-worker.md` to `~/.claude/agents/one-go-worker.md`. This is the
helper each pass runs as: it has only the six tools a pass needs, so it starts faster and uses
less of its memory on set-up. Restart Claude Code so it sees the new agent.

Other tools need no agent file: each step's instructions carry their own rules. A tool that
cannot start helper agents runs the steps one by one in the same chat.

## 4 · Start a board in your project

In your project folder, create the folder `.claude/one-go/` and in it a file `board.json`
holding exactly this line:

```json
{"schema": 4, "updated": "", "tasks": {}}
```

(The engine finds your project by walking up from the current folder until it sees this file.)

Then type `/one-go help` in a chat opened in that project. The cheat sheet means it works.

## 5 · (Optional) House rules and models

Copy `one-go/examples/config.example.json` to `.claude/one-go/config.json` and
`one-go/examples/house-rules.example.md` to `.claude/one-go/house-rules.md`, then edit them.
Delete any setting you do not need; a missing setting means that extra is off.

In `hosts`, replace each `<your model>` with a model name your tool accepts, or delete the line —
then that tool uses whatever model it is already set to. Claude Code needs no entry. Or write
`"auto"` and set `model_cards` to let one-go pick from model cards (see `one-go/reference/HOSTS.md`).

## Check it

```
node ~/.agents/skills/one-go/scripts/board.mjs help
node ~/.agents/skills/one-go/scripts/check-help-rows.mjs
```

The first prints the cheat sheet; the second should report that the help is in order.

## Uninstall

Delete the links from step 2, the `~/.agents/skills/one-go` folder and
`~/.claude/agents/one-go-worker.md`. Your project's `.claude/one-go/` folder holds your board
and run history; keep it or delete it as you like.
