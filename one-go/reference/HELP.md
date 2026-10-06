# `/one-go help` — printed exactly as written, nothing added above or below

### `/one-go` — the thing that finishes big jobs while you are away

| Type this | What happens |
|---|---|
| `/one-go dispatch <what to build>` | **Start or carry on a job.** Say what you want in plain words — one sentence, a pasted note, a long spec. It reads every file the job touches **first**, then asks you every question in one numbered block. You answer once. Then it runs to the end and leaves one report. If a run got cut off (a usage limit, a closed window), the same command checks what is really done and carries on. |
| `/one-go stop [<job>]` | **Stop now.** Everything it was holding is released, and you still get the report. |
| `/one-go update` | **Get the newest version.** When a newer one-go is out, starting a job tells you in one line. This takes it — never in the middle of a job, and never over changes you made to its files. |
| `/one-go help` | This sheet. |

**For the agent:** everything else is plumbing the agent runs for you — see `SKILL.md` and `reference/CONDUCTOR.md`.

**The promise on questions**

Everything is asked **before** the work starts, never during it. You get one numbered list with a
★ recommendation on each. Answer in one line — `1A 2B 3A` — or say **"use your recommendations"**
and every ★ is taken and listed back to you, so you can overturn any of them.

If a question turns up mid-run that should have been asked, that step waits and the rest carry
on. It goes in the report. It is a planning mistake, not a reason to wake you.

**How a run ends** — always with a report, and one of three endings:

| Ending | Means |
|---|---|
| COMPLETE | Every step done and proven by a check that really ran |
| FINISHED WITH OPEN ITEMS | Every step done, but some things need you — something to look at yourself, a question, a step that could not be checked. The report lists them |
| STOPPED | You stopped it, or it hit its time limit. The report says what is done and what is left |

**What it will never do, however you ask**

| Never | So |
|---|---|
| Push, deploy or delete | It commits locally at most; the report lists what waits for a push |
| Wake you with a question | Small calls it makes itself and lists in the report; big ones wait |
| Say yes on your behalf | A run ends with work waiting for your yes |
| Hide a problem | Every issue is in the report, in plain words |

**Worth knowing**

- One job = one row. A job's smaller pieces roll up into its progress.
- Looking never changes anything: the job list and every refusal leave your files as they were.
- If the job list file is ever damaged, it stops and says so rather than writing over it.
- It cannot see something you only said out loud in another chat. Give it to `/one-go dispatch` and it goes on.
- It works in Claude Code, Codex, Antigravity and OpenCode. Where a tool cannot start helpers, the
  same chat does the steps one by one.
