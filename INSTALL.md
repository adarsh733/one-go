# Installing one-go

You need **Node.js 20 or newer** (check with `node --version`), **git** (check with
`git --version`) and at least one of: Claude Code, Codex, Antigravity or OpenCode.

`~` below means your home folder. In Windows PowerShell, write `$HOME` instead of `~`.

**Copied the `one-go` folder by hand before v1.0.0?** That copy cannot update itself. Delete
`~/.agents/skills/one-go` (and any `one-go` folder you copied into another tool's skills folder),
then follow the steps below. Your projects' boards live in each project's `.claude/one-go/` folder
and are not touched.

## 1 · Download it

```
git clone https://github.com/adarsh733/one-go.git ~/.agents/one-go
```

This puts the download in `~/.agents/one-go/`; the skill itself is the `one-go/` folder inside it.
Keeping it as a git download is what lets one command update it later.

## 2 · Let your tools see it

Each tool looks in its own skills folder. One command links the skill into all of them:

```
node ~/.agents/one-go/one-go/scripts/install.mjs
node ~/.agents/one-go/one-go/scripts/install.mjs --apply
```

The first line only shows what it would do; the second does it. Add `--tool claude`, `--tool
codex`, `--tool opencode` or `--tool antigravity` to do one tool only. It skips a tool that
already sees the skill and never overwrites a real folder that is already there. Because these
are links, not copies, every tool sees an update the moment it lands.

What it links, if you would rather do it by hand:

| Tool | Folder it looks in |
|---|---|
| Claude Code | `~/.claude/skills/one-go/` |
| Codex | `~/.codex/skills/one-go/` |
| OpenCode | `~/.config/opencode/skills/one-go/` |
| Antigravity | `~/.agents/skills/one-go/` |

Each one should link to `~/.agents/one-go/one-go/`. If your version of a tool looks for skills
somewhere else, put the link there instead.

## 3 · The lean helper agent (Claude Code only)

Step 2 already copied `one-go/agents/one-go-worker.md` to `~/.claude/agents/one-go-worker.md`
(if a different file was there, it said so and left it — copy it over by hand). This is the
helper each pass runs as: it has only the six tools a pass needs, so it starts faster and uses
less of its memory on set-up. Restart Claude Code so it sees the new agent. `/one-go update`
refreshes this copy too, unless you edited it.

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
node ~/.agents/one-go/one-go/scripts/board.mjs help
node ~/.agents/one-go/one-go/scripts/board.mjs update --check
```

The first prints the cheat sheet; the second says which version you have and whether a newer
one is out.

## Updates

When a newer version is out, starting a job prints one line saying so. Type `/one-go update` to
take it. It never updates in the middle of a job, never overwrites changes you made to one-go's
own files, and changes nothing when it is offline. The check behind that line runs at most once a
day, in the background, and a job never waits for it. To turn it off, set the environment
variable `ONEGO_UPDATE_CHECK=off`. What changed in each version is in `one-go/CHANGELOG.md`.

By hand, the same thing is: `git -C ~/.agents/one-go pull --ff-only`.

## Uninstall

Delete the links from step 2, the `~/.agents/one-go` folder, `~/.one-go/` (the saved update
check) and `~/.claude/agents/one-go-worker.md`. Your project's `.claude/one-go/` folder holds your
board and run history; keep it or delete it as you like.
