// p9-sealgate.test.mjs — carried over from the old skill's test/sealgate.test.mjs (ported,
// generic). Proves the seal gate (lib/plan.mjs's validateSealedPlan) is actually wired into
// cmd/start.mjs, end to end, through the real `board.mjs start` call site — not just the unit
// -tested predicate (that's p9-seal.test.mjs).
//
// Three things must hold:
//   1. A plan whose Proven-by cell is prose (not a command), dated at/after SEAL_GATE_CUTOFF,
//      refuses `start`: exits non-zero, names the offending pass, writes no state.
//   2. The SAME plan, dated BEFORE the cutoff, starts normally — grandfathering works.
//   3. A clean plan, dated at/after the cutoff, starts normally — the gate isn't overzealous.
//
// "Dated" here is the run's creation date (matching how cmd/audit.mjs's proof-gate cutoff
// grandfathers by run date, not by anything stored on the plan itself) — start.mjs reads it from
// ONEGO_TEST_TODAY when set, so these tests can simulate being on/after the cutoff without
// waiting for the calendar. Unset, start.mjs always uses the real today().
//
// Always against a throwaway sandbox via helpers.mjs (ONEGO_ROOT) — never a real project's own
// `.claude/one-go/`.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { makeSandbox, BOARD_MJS, activeRunId } from "./helpers.mjs";

// Same cutoff as lib/plan.mjs's SEAL_GATE_CUTOFF / cmd/start.mjs. Kept as a literal here (not
// imported) so this test also catches the constant accidentally drifting between the two files.
const BEFORE_CUTOFF = "2026-09-21";
const AT_CUTOFF = "2026-09-22";

// helpers.mjs's runBoard() only forwards ONEGO_ROOT — this needs ONEGO_TEST_TODAY too (the seal
// gate's test seam, see cmd/start.mjs), so this spawns board.mjs directly the same way runBoard
// does rather than editing helpers.mjs (out of scope for this pass's file list).
function runBoard(args, root, testToday) {
  const env = { ...process.env, ONEGO_ROOT: root };
  if (testToday) env.ONEGO_TEST_TODAY = testToday;
  const result = spawnSync(process.execPath, [BOARD_MJS, ...args], {
    env, encoding: "utf8", windowsHide: true
  });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", code: result.status };
}

function seedTask(sandbox, slug, display) {
  const board = JSON.parse(fs.readFileSync(sandbox.boardPath, "utf8"));
  board.tasks[slug] = {
    display, what: display, stage: "not_started", source: "test",
    pending_questions: 0, next_move: "", blocked_reason: null, subtasks: []
  };
  fs.writeFileSync(sandbox.boardPath, JSON.stringify(board, null, 2));
}

function seedSealedPlan(sandbox, slug, passes) {
  const plan = {
    schema: 1,
    plan_id: `plan-${slug}`,
    plan_revision: 1,
    task_id: slug,
    passes
  };
  const p = path.join(sandbox.plansDir, `${slug}.plan.json`);
  fs.writeFileSync(p, JSON.stringify(plan, null, 2));
  return p;
}

// A "Proven by" cell that is an explanation, not a command — exactly what validateSealedPlan
// (lib/plan.mjs) refuses. No declared files, so the only error possible is the proof-cell one —
// keeps the assertions below unambiguous about which check fired.
const PROSE_PASSES = [
  { n: 1, purpose: "Do the thing", writes: [], reads: [], prerequisites: [],
    proven_by: "Looks correct on manual review" }
];

// A plan validateSealedPlan has nothing to say about: a real runnable check command, no declared
// files to resolve.
const CLEAN_PASSES = [
  { n: 1, purpose: "Do the thing", writes: [], reads: [], prerequisites: [],
    proven_by: "node -e \"process.exit(0)\"" }
];

function onegoEntries(sandbox) {
  return fs.existsSync(sandbox.onegoDir)
    ? fs.readdirSync(sandbox.onegoDir, { withFileTypes: true })
        .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}-/.test(e.name))
        .map(e => e.name)
    : [];
}

test("start refuses a prose Proven-by cell dated at/after the cutoff: non-zero, names the pass, writes nothing", () => {
  const sandbox = makeSandbox();
  try {
    seedTask(sandbox, "prose-job", "Prose Job");
    seedSealedPlan(sandbox, "prose-job", PROSE_PASSES);

    const runDirsBefore = onegoEntries(sandbox);
    const boardBefore = fs.readFileSync(sandbox.boardPath, "utf8");

    const { code, stdout } = runBoard(["start", "prose-job"], sandbox.root, AT_CUTOFF);

    assert.notEqual(code, 0, stdout);
    assert.match(stdout, /Pass 1/, "must name the offending pass");
    assert.match(stdout, /not a runnable command/i, "must say what is wrong");
    assert.match(stdout, /Nothing was written/i);

    assert.deepEqual(onegoEntries(sandbox), runDirsBefore, "no new run directory may appear");
    assert.equal(fs.readFileSync(sandbox.boardPath, "utf8"), boardBefore, "board.json must be untouched");
    assert.ok(!fs.existsSync(path.join(sandbox.onegoDir, "ACTIVE")), "no ACTIVE pointer may be written");
    assert.ok(!fs.existsSync(path.join(sandbox.onegoDir, "ACTIVE.d")) || fs.readdirSync(path.join(sandbox.onegoDir, "ACTIVE.d")).length === 0, "no per-run marker may be written");
    assert.equal(activeRunId(sandbox.onegoDir), null, "no run is live");
  } finally {
    sandbox.teardown();
  }
});

test("the same prose plan dated BEFORE the cutoff starts normally (grandfathered)", () => {
  const sandbox = makeSandbox();
  try {
    seedTask(sandbox, "prose-job-old", "Prose Job Old");
    seedSealedPlan(sandbox, "prose-job-old", PROSE_PASSES);

    const { code, stdout } = runBoard(["start", "prose-job-old"], sandbox.root, BEFORE_CUTOFF);
    assert.equal(code, 0, stdout);

    const runId = activeRunId(sandbox.onegoDir);
    assert.ok(runId, "a run marker (ACTIVE.d/<run-id> or the old ACTIVE file) names the run");
    const state = JSON.parse(fs.readFileSync(path.join(sandbox.onegoDir, runId, "state.json"), "utf8"));
    assert.equal(state.slug, "prose-job-old");
  } finally {
    sandbox.teardown();
  }
});

test("a clean plan dated at/after the cutoff starts normally", () => {
  const sandbox = makeSandbox();
  try {
    seedTask(sandbox, "clean-job", "Clean Job");
    seedSealedPlan(sandbox, "clean-job", CLEAN_PASSES);

    const { code, stdout } = runBoard(["start", "clean-job"], sandbox.root, AT_CUTOFF);
    assert.equal(code, 0, stdout);

    const runId = activeRunId(sandbox.onegoDir);
    assert.ok(runId, "a run marker (ACTIVE.d/<run-id> or the old ACTIVE file) names the run");
    const state = JSON.parse(fs.readFileSync(path.join(sandbox.onegoDir, runId, "state.json"), "utf8"));
    assert.equal(state.slug, "clean-job");
  } finally {
    sandbox.teardown();
  }
});
