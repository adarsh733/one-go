// lib/status.mjs — the one place pass-status strings are classified. TASK-ENF-001 stage 3.
//
// Before this file existed, every classifier in the codebase used a PREFIX regex
// (`/^done/`, `/^(parked|crashed|failed|blocked)/`, `/^(pending|running|queued)/`), so a
// status of "done-but-actually-broken" read as done everywhere — in the board's own rollup,
// in `pass`'s auto-advance, in `watchdog`'s finalize check, in `stop`'s report. That was one
// of the three reproduced bypasses (TASK-ENF-001 contract). Every one of those call sites now
// imports its classifier from here, and every classifier is an EXACT match against the known
// set, never a prefix.
//
// KNOWN_STATUSES is the exact list `pass`'s own usage banner names, plus `done-uncommitted`
// (a status `pass` doesn't hand out but that other tooling and hand-written run files have
// always been allowed to write — see the write-back logic this file's callers still honour).
//
// "built" (2026-10-03): the worker has finished WRITING, but the pass is not proven yet. It keeps
// its slot and its files — it counts as running for scheduling — yet it is not "still writing",
// so a whole-app check (lib/evidence.mjs wholeTreeConflict) may run beside it. Without it, two
// whole-app passes building together each waited for the other to finish, forever.
export const KNOWN_STATUSES = [
  "done", "done-uncommitted", "running", "built", "parked", "crashed", "failed", "blocked", "stopped", "pending",
  "launch-requested", "stop-requested"
];
const DONE = new Set(["done", "done-uncommitted"]);
const STUCK = new Set(["parked", "crashed", "failed", "blocked"]);
// "queued" is not a status `pass` will accept as input (it is not in KNOWN_STATUSES), but it
// has always been tolerated on READ when some other tool wrote it into state.json directly —
// kept here, unchanged, for that reason only.
const LIVE = new Set(["pending", "running", "built", "queued", "launch-requested", "stop-requested"]);
const REQUESTED = new Set(["launch-requested", "stop-requested"]);

export function isKnownStatus(status) {
  return KNOWN_STATUSES.includes(String(status || ""));
}
export function isDoneStatus(status) {
  return DONE.has(String(status || ""));
}
export function isStuckStatus(status) {
  return STUCK.has(String(status || ""));
}
export function isLiveStatus(status) {
  return LIVE.has(String(status || ""));
}
export function isRequestedStatus(status) {
  return REQUESTED.has(String(status || ""));
}
export function isStoppedStatus(status) {
  return String(status || "") === "stopped";
}

// "pending" and "running" were both lumped into LIVE, which reads fine for the board ("this run
// has unfinished work") but is wrong for the scheduler: a pending pass has NOT started, and
// treating it as already live meant `readyPasses` skipped every single pass and nothing could
// ever be scheduled. These two answer the scheduler's question instead.
const RUNNING = new Set(["running", "built", "queued"]);
export function isRunningStatus(status) {
  return RUNNING.has(String(status || ""));
}
/** Finished writing, not yet proven — holds its slot, but no longer changes the tree. */
export function isBuiltStatus(status) {
  return String(status || "") === "built";
}
// Handed out and may still be changing files: what a whole-app check must wait for.
const WRITING = new Set(["running", "queued", "launch-requested", "stop-requested"]);
export function isWritingStatus(status) {
  return WRITING.has(String(status || ""));
}
/** Not finished, not stuck, and not already dispatched — so it is a candidate to start. */
export function isStartableStatus(status) {
  const s = String(status || "");
  return s === "" || s === "pending";
}
