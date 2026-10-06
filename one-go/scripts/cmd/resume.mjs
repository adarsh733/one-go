// cmd/resume.mjs — `resume [<job>|<n>|<run-id>] [--apply] [--tidy]`, a silent alias (old habit):
// `dispatch` now picks a cut-off run up on its own. A thin wrapper: every behaviour and flag
// lives in cmd/revive.mjs, so `resume` and `revive` can never drift apart (the router sends both
// here).
import { runRevive } from "./revive.mjs";

export function runResume(ctx = {}) {
  return runRevive(ctx);
}
