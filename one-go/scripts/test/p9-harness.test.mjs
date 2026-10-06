// p9-harness.test.mjs — carried over from the old skill's test/harness.test.mjs (ported,
// generic), proving the sandbox harness is actually isolated.
//
// The old version proved this by reading a REAL project's board.json before/after a sandboxed
// run — a path this staging build must never name (dev/CONTRACT.md §8: no project names under
// `skill/`). The property that mattered was never "this one specific file is untouched"; it was
// "ONEGO_ROOT is the only thing that decides which board.json a run touches". That is provable
// with two throwaway sandboxes instead of one real board: if board.mjs is pointed at sandbox A,
// sandbox B's board.json (an equally real, on-disk file) must be untouched, and vice versa. Two
// things must be true or the whole suite this pass exists to enable is unsafe to run:
//   1. A sandboxed board.mjs invocation never writes outside the ONEGO_ROOT it was given.
//   2. `board.mjs` with no args, pointed at a fresh sandbox, exits 0.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { makeSandbox, runBoard } from "./helpers.mjs";

test("a run against one sandbox never touches a second sandbox's board.json (ONEGO_ROOT is the only scope)", () => {
  const a = makeSandbox();
  const b = makeSandbox();
  try {
    const bBefore = fs.readFileSync(b.boardPath);
    const bStatBefore = fs.statSync(b.boardPath);

    runBoard([], a.root);
    runBoard(["--all"], a.root);
    runBoard(["dispatch", "a totally new job idea, only for sandbox a"], a.root);

    const bAfter = fs.readFileSync(b.boardPath);
    const bStatAfter = fs.statSync(b.boardPath);
    assert.ok(bBefore.equals(bAfter), "sandbox B's board.json bytes changed from a run scoped to sandbox A");
    assert.equal(bStatAfter.mtimeMs, bStatBefore.mtimeMs, "sandbox B's board.json mtime changed from a run scoped to sandbox A");

    // And the new job really did land in A, not B — proving ONEGO_ROOT was honoured, not just
    // that nothing happened anywhere. (slugify caps the slug to its first few words.)
    const boardA = JSON.parse(fs.readFileSync(a.boardPath, "utf8"));
    assert.ok(boardA.tasks["a-totally-new-job-idea"], "the new job should exist in sandbox A");
    const boardB = JSON.parse(fs.readFileSync(b.boardPath, "utf8"));
    assert.ok(!boardB.tasks["a-totally-new-job-idea"], "the new job must not leak into sandbox B");
  } finally {
    a.teardown();
    b.teardown();
  }
});

test("board.mjs with no args exits 0 against a sandboxed board", () => {
  const sandbox = makeSandbox();
  try {
    const { code, stdout, stderr } = runBoard([], sandbox.root);
    assert.equal(code, 0, `expected exit 0, got ${code}\nstdout: ${stdout}\nstderr: ${stderr}`);
  } finally {
    sandbox.teardown();
  }
});
