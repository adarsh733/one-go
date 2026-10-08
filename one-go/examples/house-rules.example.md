# House rules — example

Copy this file to `<project>/.claude/one-go/house-rules.md` and change the words to fit the
project. Only the three `##` sections below are read; this introduction and anything outside
them is ignored. Leave a section out and it is simply empty. Paths and switches do not go here —
they go in `config.json` (see `config.example.json`).

## For the conductor

- Read `docs/ARCHITECTURE.md` in the reading pass (pass 0) before writing any question; the folder
  layout there is the one every pass must follow.
- A pass that changes the database schema always runs alone and uses the think model.
- Any pass that adds a new dependency asks about it in the question block first.

## For every worker

- Run `npm run lint` before reporting; say its exit code in the report.
- Never edit files under `vendor/` — they are copied from elsewhere and get overwritten.
- If a test needs the network, stop and report PARKED instead of mocking it.

## Before a run is called finished

- `npm test` passes on the whole project, not only on each pass's own files.
- The README still describes how to run the project.
- Anything that changed what a user sees is listed for the user to try by hand.
