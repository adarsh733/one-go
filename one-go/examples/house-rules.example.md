# House rules — example

Copy this file to `<project>/.claude/one-go/house-rules.md` and change the words to fit the
project. Only the three `##` sections below are read; this introduction and anything outside
them is ignored. Leave a section out and it is simply empty. Paths and switches do not go here —
they go in `config.json` (see `config.example.json`).

## For the conductor

- Read `docs/ARCHITECTURE.md` in the reading pass (pass 0) before writing any question; the folder
  layout there is the one every pass must follow.
- A pass that changes the database schema always runs alone and uses the think model.
- Any new `.md` file needs its register line approved by the user before `start`.
- Keep an undo of a frozen design and its re-freeze in the same pass; never split them.

## For every worker

- Run `npm run lint` before reporting; say its exit code in the report.
- Never edit files under `vendor/` — they are copied from elsewhere and get overwritten.
- If a test needs the network, stop and report PARKED instead of mocking it.

## Before a run is called finished

- Every claim this run took is released in the claims file, each with a one-line outcome.
- One line per pass appended to the work log.
- Anything committed is listed in the pending-push file.
- Screens touched by the run are checked by the user on their phone.
