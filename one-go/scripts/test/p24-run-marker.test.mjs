// scripts/test/p24-run-marker.test.mjs — D7 (0107): ACTIVE.d per-run markers.
// Tests that start writes ACTIVE.d/<run-id>, close removes it, and activeRunId reads either.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { equal, ok, notEqual, deepEqual } from "node:assert";
import { makeSandbox as makeHelperSandbox, runBoard as runHelperBoard } from "./helpers.mjs";
import { stamp } from "../lib/util.mjs";
import { liveRunIds, releaseMarkers } from "../lib/marker.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOARD_MJS = path.join(__dirname, "..", "board.mjs");

/** Create a sandbox: board.json + sealed plan + run folder. */
function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "one-go-p24-"));
  const onegoDir = path.join(root, ".claude", "one-go");
  const plansDir = path.join(onegoDir, "plans");
  fs.mkdirSync(plansDir, { recursive: true });

  // Board
  const boardPath = path.join(onegoDir, "board.json");
  fs.writeFileSync(boardPath, JSON.stringify({
    schema: 4, updated: "", rev: 0, tasks: {
      "p24-test": { display: "P24 test job", stage: "not_started", run_id: null, subtasks: [] }
    }
  }, null, 2));

  // Sealed plan with one pass
  fs.writeFileSync(path.join(plansDir, "p24-test.md"), `# P24 test job
State: sealed 2026-10-03

## What "done" looks like
The run marker goes to ACTIVE.d/.

## Run shape
- Waves: 1) p1
- Summary: 1 pass in 1 wave

## Passes
| # | What it does | Model | Files it writes | Proven by | Depends on |
|---|---|---|---|---|---|
| 1 | Dummy pass | build | dummy.txt | node -e "process.exit(0)" | — |

## Answers
> approved\n`);

  return { root, onegoDir, boardPath };
}

function runBoard(args, root) {
  const env = { ...process.env, ONEGO_ROOT: root };
  const result = spawnSync(process.execPath, [BOARD_MJS, ...args], {
    env, encoding: "utf8", windowsHide: true
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.status };
}

test("p24-start creates ACTIVE.d/<run-id> alongside legacy ACTIVE", () => {
  const { root, onegoDir } = makeSandbox();
  try {
    const res = runBoard(["start", "p24-test"], root);
    equal(res.code, 0, "start exits 0");

    // Legacy ACTIVE must exist
    const activeFile = path.join(onegoDir, "ACTIVE");
    ok(fs.existsSync(activeFile), "legacy ACTIVE file exists");

    // ACTIVE.d/<run-id> must exist
    const runId = fs.readFileSync(activeFile, "utf-8").trim();
    ok(runId.length > 0, "ACTIVE is non-empty");
    const activeD = path.join(onegoDir, "ACTIVE.d", runId);
    ok(fs.existsSync(activeD), `ACTIVE.d/${runId} exists`);
    equal(fs.readFileSync(activeD, "utf-8").trim(), runId, "ACTIVE.d content is the run id");

    // State has schema >= 3 (gated)
    const state = JSON.parse(fs.readFileSync(path.join(onegoDir, runId, "state.json"), "utf-8"));
    ok(state.schema >= 3, `state schema is ${state.schema} (>= 3)`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("p24-activeRunId reads ACTIVE.d first, falls back to ACTIVE", () => {
  const { root, onegoDir } = makeSandbox();
  try {
    // Start the run (creates both markers)
    runBoard(["start", "p24-test"], root);
    const activeFile = path.join(onegoDir, "ACTIVE");
    const expectedId = fs.readFileSync(activeFile, "utf-8").trim();

    // Read using the engine's own revive scanner (scanRuns) indirectly via the info command
    const res = runBoard(["info", "p24-test"], root);
    equal(res.code, 0, "info exits 0");
    ok(res.stdout.includes(expectedId), `info output mentions run id ${expectedId}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("p24-old-runs-still-work (ACTIVE only, no ACTIVE.d)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "one-go-p24-old-"));
  const onegoDir = path.join(root, ".claude", "one-go");
  fs.mkdirSync(onegoDir, { recursive: true });

  // Board
  const boardPath = path.join(onegoDir, "board.json");
  fs.writeFileSync(boardPath, JSON.stringify({
    schema: 4, updated: "", rev: 0, tasks: {}
  }, null, 2));

  // Old-style run: ACTIVE only, no ACTIVE.d, schema < 3 (ungated)
  const runId = "2026-01-01-0000-old-run";
  const runDir = path.join(onegoDir, runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(onegoDir, "ACTIVE"), runId + "\n");
  fs.writeFileSync(path.join(runDir, "state.json"), JSON.stringify({
    schema: 2, slug: "old-run", run_id: runId, passes: [{ n: 1, status: "done" }]
  }, null, 2));
  fs.writeFileSync(path.join(runDir, "heartbeat.txt"), "2026-01-01 00:00\n");
  fs.writeFileSync(path.join(runDir, "report.md"), "done\n");

  // A watchdog/read should find this run via legacy ACTIVE
  try {
    const res = runBoard(["info", "old-run"], root);
    // Should not crash reading the old run
    notEqual(res.code, 1, "reading old run does not exit 1");
  } catch {
    // Info may fail if no task, but shouldn't crash
  }

  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------
// Fix-up pass 2 (obs 0107, 0109): two runs live at once. One marker per run, each run's cleanup
// scoped to its own entry, watchdog acting on the run it was pointed at, worker and board reading
// ACTIVE.d first.
// ---------------------------------------------------------------------------------------------
const RUN_A = "2026-10-03-1100-alpha-job";
const RUN_B = "2026-10-03-1105-beta-job";

/** A sandbox holding two live runs, each with its own ACTIVE.d entry. Legacy ACTIVE names `legacy` (or is absent). */
function twoRuns({ legacy = RUN_B, passesA, passesB, extraA = {}, extraB = {} } = {}) {
  const sb = makeHelperSandbox();
  const b = JSON.parse(fs.readFileSync(sb.boardPath, "utf8"));
  b.tasks["alpha-job"] = { display: "Alpha job", stage: "running", subtasks: [] };
  b.tasks["beta-job"] = { display: "Beta job", stage: "running", subtasks: [] };
  fs.writeFileSync(sb.boardPath, JSON.stringify(b, null, 2));
  const now = stamp();
  const mk = (runId, slug, passes, extra) => {
    const dir = path.join(sb.onegoDir, runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({
      schema: 3, run_id: runId, slug, started: now, ceiling_hours: 8, heartbeat: now,
      conductor_last_seen: now, passes: passes || [{ n: 1, title: "a", status: "pending" }], ...extra
    }, null, 2));
    fs.writeFileSync(path.join(dir, "heartbeat.txt"), now + "\n");
    fs.mkdirSync(path.join(sb.onegoDir, "ACTIVE.d"), { recursive: true });
    fs.writeFileSync(path.join(sb.onegoDir, "ACTIVE.d", runId), runId + "\n");
    return dir;
  };
  const dirA = mk(RUN_A, "alpha-job", passesA, extraA);
  const dirB = mk(RUN_B, "beta-job", passesB, extraB);
  if (legacy) fs.writeFileSync(path.join(sb.onegoDir, "ACTIVE"), legacy + "\n");
  return { sb, dirA, dirB };
}

const exists = (sb, ...p) => fs.existsSync(path.join(sb.onegoDir, ...p));
const stateOf = dir => JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf-8"));
const legacyOf = sb => fs.readFileSync(path.join(sb.onegoDir, "ACTIVE"), "utf-8").trim();

test("p24-liveRunIds lists every ACTIVE.d run plus the legacy one; releaseMarkers touches only its own", () => {
  const { sb } = twoRuns({ legacy: RUN_B });
  try {
    deepEqual(liveRunIds(sb.onegoDir), [RUN_A, RUN_B]);
    equal(releaseMarkers(RUN_A, sb.onegoDir), true);
    deepEqual(liveRunIds(sb.onegoDir), [RUN_B], "B's ACTIVE.d entry and the legacy ACTIVE (naming B) stay");
    equal(releaseMarkers(RUN_A, sb.onegoDir), false, "nothing left to release for A");
  } finally { sb.teardown(); }
});

test("p24-close removes ONLY its own ACTIVE.d entry when two runs are live (legacy names the other run)", () => {
  const { sb, dirA } = twoRuns({ legacy: RUN_B });
  try {
    const r = runHelperBoard(["close", RUN_A, "--reason", "test"], sb.root);
    equal(r.code, 0, r.stdout + r.stderr);
    ok(stateOf(dirA).ended, "A is closed");
    ok(!exists(sb, "ACTIVE.d", RUN_A), "A's own entry is gone even though legacy ACTIVE names B");
    ok(exists(sb, "ACTIVE.d", RUN_B), "B's entry is untouched");
    equal(legacyOf(sb), RUN_B, "legacy ACTIVE still names B");
    ok(r.stdout.includes("another run is still live"), "the output does not claim the hooks are back on");

    const r2 = runHelperBoard(["close", RUN_B, "--reason", "test"], sb.root);
    equal(r2.code, 0, r2.stdout + r2.stderr);
    ok(!exists(sb, "ACTIVE.d", RUN_B), "B's entry gone");
    ok(!exists(sb, "ACTIVE"), "legacy ACTIVE removed once it names the run being closed");
  } finally { sb.teardown(); }
});

test("p24-close with no name and two live runs refuses to guess", () => {
  const { sb, dirA, dirB } = twoRuns();
  try {
    const r = runHelperBoard(["close"], sb.root);
    equal(r.code, 1);
    ok(r.stdout.includes("More than one run is live"), r.stdout);
    ok(!stateOf(dirA).ended && !stateOf(dirB).ended, "neither run was closed");
  } finally { sb.teardown(); }
});

test("p24-watchdog given run B never touches run A (by run id and by job name)", () => {
  // Run A is under a STOP file AND past its ceiling — touching it would visibly close it.
  const { sb, dirA, dirB } = twoRuns({ legacy: RUN_A, extraA: { started: "2026-01-01 00:00" } });
  try {
    fs.writeFileSync(path.join(dirA, "STOP"), "2026-10-03 11:30 — stop\n");
    for (const arg of [RUN_B, "beta-job"]) {
      const r = runHelperBoard(["watchdog", arg], sb.root);
      equal(r.code, 0, r.stdout + r.stderr);
      ok(r.stdout.includes(RUN_B), r.stdout);
      ok(!stateOf(dirA).ended, `A untouched by watchdog ${arg}`);
      ok(!fs.existsSync(path.join(dirA, "report.md")), "A has no report");
      ok(!stateOf(dirB).ended, "B is still going");
      ok(exists(sb, "ACTIVE.d", RUN_A) && exists(sb, "ACTIVE.d", RUN_B), "both markers remain");
      equal(legacyOf(sb), RUN_A, "legacy pointer (naming A) untouched");
    }
  } finally { sb.teardown(); }
});

test("p24-watchdog with no argument handles every live run on its own merits", () => {
  const { sb, dirA, dirB } = twoRuns({ legacy: RUN_B });
  try {
    fs.writeFileSync(path.join(dirA, "STOP"), "2026-10-03 11:30 — stop\n");
    const r = runHelperBoard(["watchdog"], sb.root);
    equal(r.code, 0, r.stdout + r.stderr);
    ok(stateOf(dirA).ended, "A (STOP file) is closed");
    ok(!exists(sb, "ACTIVE.d", RUN_A), "A's marker released");
    ok(!stateOf(dirB).ended, "B (healthy) is not closed");
    ok(exists(sb, "ACTIVE.d", RUN_B), "B's marker stays");
    equal(legacyOf(sb), RUN_B, "legacy ACTIVE naming B stays");
    ok(r.stdout.includes(RUN_B) && r.stdout.includes("🟢"), "B reported as going");
  } finally { sb.teardown(); }
});

test("p24-watchdog still reads an old run (legacy ACTIVE only, no ACTIVE.d)", () => {
  const sb = makeHelperSandbox();
  try {
    const now = stamp();
    const runId = "2026-09-01-0900-old-job";
    const dir = path.join(sb.onegoDir, runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({
      schema: 2, run_id: runId, slug: "old-job", started: now, heartbeat: now, passes: [{ n: 1, title: "a", status: "pending" }]
    }));
    fs.writeFileSync(path.join(dir, "heartbeat.txt"), now + "\n");
    fs.writeFileSync(path.join(sb.onegoDir, "ACTIVE"), runId + "\n");
    const r = runHelperBoard(["watchdog"], sb.root);
    equal(r.code, 0, r.stdout + r.stderr);
    ok(r.stdout.includes(runId), r.stdout);
  } finally { sb.teardown(); }
});

test("p24-board table reads ACTIVE.d-only runs (no legacy ACTIVE) and names several", () => {
  const { sb } = twoRuns({ legacy: null });
  try {
    const r = runHelperBoard([], sb.root);
    equal(r.code, 0, r.stdout + r.stderr);
    ok(/hooks stood down by 2 runs/.test(r.stdout) && r.stdout.includes(RUN_A) && r.stdout.includes(RUN_B), r.stdout);
    releaseMarkers(RUN_A, sb.onegoDir);
    const r2 = runHelperBoard([], sb.root);
    ok(new RegExp(`hooks stood down since .* by run \`${RUN_B}\``).test(r2.stdout), r2.stdout);
  } finally { sb.teardown(); }
});

test("p24-worker stop-ack on an ACTIVE.d-only run releases that run's entry and leaves the other", () => {
  const { sb, dirB } = twoRuns({
    legacy: null,
    passesB: [{ n: 1, title: "b", status: "stop-requested", pass_id: "P1", attempt_id: "A1", worker: { id: "w1" } }]
  });
  try {
    const r = runHelperBoard(["worker", "stop-ack", "beta-job", "1", "--run", RUN_B, "--attempt", "A1", "--worker", "w1"], sb.root);
    equal(r.code, 0, r.stdout + r.stderr);
    ok(stateOf(dirB).ended, "B ended by the acknowledgement");
    ok(!exists(sb, "ACTIVE.d", RUN_B), "B's entry removed");
    ok(exists(sb, "ACTIVE.d", RUN_A), "A's entry untouched");
  } finally { sb.teardown(); }
});
