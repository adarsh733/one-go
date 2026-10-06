// p3-evidence.test.mjs — lib/evidence.mjs: the whole-tree check lock (obs 0070) plus the carried
// -over record gate it sits beside. Since 2026-10-03 only passes still WRITING hold the check;
// a pass marked `built` does not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { wholeTreeConflict, isWholeTreePass, recordGap, RUN_SCHEMA } from "../lib/evidence.mjs";

function state(passes) { return { schema: 3, run_id: "r", passes }; }

test("an ordinary pass's check may run beside anything", () => {
  const s = state([
    { n: 1, title: "Build the list", status: "running", shared_resources: [] },
    { n: 2, title: "Write docs", status: "running", shared_resources: [] }
  ]);
  assert.equal(wholeTreeConflict(s, 1), null);
});

test("a whole-tree pass is held back while another pass is running, naming them", () => {
  const s = state([
    { n: 1, title: "End-to-end run", status: "running", shared_resources: ["capture-tree"] },
    { n: 2, title: "Build", status: "running" },
    { n: 3, title: "Build more", status: "launch-requested" },
    { n: 4, title: "Later", status: "pending" },
    { n: 5, title: "Done", status: "done" }
  ]);
  const c = wholeTreeConflict(s, 1);
  assert.ok(c);
  assert.deepEqual(c.running, [2, 3]);
  assert.match(c.reason, /passes 2, 3 are still running \(writing\)/);
});

test("a sibling marked built (finished writing) does not hold a whole-tree check", () => {
  const s = state([
    { n: 1, title: "Home", status: "built", shared_resources: ["capture-tree"] },
    { n: 2, title: "Settings", status: "built", shared_resources: ["capture-tree"] },
    { n: 3, title: "Docs", status: "built" }
  ]);
  assert.equal(wholeTreeConflict(s, 1), null);
  assert.equal(wholeTreeConflict(s, 2), null);
});

test("a description word alone no longer makes a pass whole-tree — only the check command", () => {
  assert.equal(isWholeTreePass({ n: 1, title: "Shoot the screenshot and match it", proven_by: "node --test" }), false);
  assert.equal(isWholeTreePass({ n: 1, title: "Tidy", proven_by: "node scripts/journey.mjs" }), true);
});

test("a whole-tree pass may run once nothing else is live", () => {
  const s = state([
    { n: 1, title: "x", status: "running", shared_resources: ["whole-tree"] },
    { n: 2, title: "y", status: "done" },
    { n: 3, title: "z", status: "pending" }
  ]);
  assert.equal(wholeTreeConflict(s, 1), null);
});

test("an untagged pass whose check drives screenshots still counts as whole-tree", () => {
  const p = { n: 1, title: "Tidy", required_check: { command: "node tools/screenshot-all.mjs" } };
  assert.equal(isWholeTreePass(p), true);
  assert.equal(isWholeTreePass({ n: 2, title: "Tidy", proven_by: "node --test" }), false);
  const s = state([{ ...p, status: "running" }, { n: 2, title: "b", status: "running" }]);
  assert.deepEqual(wholeTreeConflict(s, "1").running, [2]);
});

test("an unknown pass number is no conflict", () => {
  assert.equal(wholeTreeConflict(state([]), 9), null);
  assert.equal(wholeTreeConflict(null, 1), null);
});

test("carried-over record gate is unchanged", () => {
  assert.equal(RUN_SCHEMA, 3);
  const ok = { n: 1, attempts: 1, verification_record: { command: "c", exit_code: 0, run_id: "r", pass_n: 1, attempt: 1 } };
  assert.equal(recordGap(ok, { runId: "r" }), null);
  assert.match(recordGap({ ...ok, verification_record: { ...ok.verification_record, exit_code: 2 } }, { runId: "r" }), /FAILED/);
});
