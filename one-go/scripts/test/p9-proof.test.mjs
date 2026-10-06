// p9-proof.test.mjs — carried over from the old skill's test/proof.test.mjs (ported, generic).
// Proves cmd/pass.mjs's proof-gate behaviour:
//
//   1. UNVERIFIED_NOTE never overwrites a real passing --verify record. Gate 2's task-record
//      sentence is appended as a second clause, never substituted for it.
//   2. The pass transition line ("Pass N (title) -> status") reports the NEW status, not the
//      one the pass is leaving.
//   3. The required-check comparison compares bare commands — a plan cell's markdown
//      backticks around the command do not refuse an otherwise-matching --verify.
//   4. "done" is refused when a pass declares a file that is not on disk, naming it — but ONLY
//      when the file's folder is real; when nothing anchors at all (no file, no folder), the
//      refusal is the honest "cannot resolve", not a false "missing" claim (lib/resolve.mjs).
//   5. "done" is refused when a pass has neither a passing verification record nor
//      --no-check "<why>"; --no-check itself is recorded on the pass and printed in the run's
//      own report line.
//
// Everything here runs against a throwaway sandbox from helpers.mjs — never a real board.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeSandbox, runBoard } from "./helpers.mjs";

// A real, trivially-passing script `node` can run as a check. Using a file (not `node -e`)
// means its path carries a ".mjs" extension, which is what makes `looksLikeCommand` recognize
// it as a command even when the whole string is wrapped in markdown backticks (test 3) — an
// `node -e "..."` one-liner has no extension for that unanchored check to catch, and would
// dodge the very bug this suite proves fixed.
const OK_CMD = "node ok-check.mjs";

function seedOkScript(root) {
  fs.writeFileSync(path.join(root, "ok-check.mjs"), "process.exit(0);\n");
}

function writeRun(sandbox, runId, state) {
  const dir = path.join(sandbox.onegoDir, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state, null, 2));
  return dir;
}

function readState(sandbox, runId) {
  return JSON.parse(fs.readFileSync(path.join(sandbox.onegoDir, runId, "state.json"), "utf8"));
}

test("a passing --verify record survives completing the run — Gate 2 appends, never substitutes UNVERIFIED_NOTE", () => {
  const sandbox = makeSandbox();
  try {
    seedOkScript(sandbox.root);
    const runId = "2026-01-01-0001-t1";
    writeRun(sandbox, runId, {
      schema: 3, run_id: runId, slug: "t1",
      passes: [{ n: 1, title: "only pass", status: "pending", files: [], required_check: { command: OK_CMD } }]
    });

    const { code, stdout } = runBoard(["pass", "t1", "1", "done", "--proven", "checked", "--verify", OK_CMD], sandbox.root);
    assert.equal(code, 0, stdout);
    assert.match(stdout, /check PASSED \(exit 0\)/);
    assert.match(stdout, /Verification: check ran: .* → exit 0 at/);
    assert.doesNotMatch(stdout, /unverified — no task record/);

    const saved = readState(sandbox, runId);
    assert.match(saved.passes[0].verification, /^check ran: .* → exit 0 at /);
  } finally {
    sandbox.teardown();
  }
});

test("a passing check also survives on a pass that does NOT complete the run", () => {
  const sandbox = makeSandbox();
  try {
    seedOkScript(sandbox.root);
    const runId = "2026-01-01-0002-t2";
    writeRun(sandbox, runId, {
      schema: 3, run_id: runId, slug: "t2",
      passes: [
        { n: 1, title: "p1", status: "pending", files: [], required_check: { command: OK_CMD } },
        { n: 2, title: "p2", status: "pending", files: [] }
      ]
    });

    const { code, stdout } = runBoard(["pass", "t2", "1", "done", "--proven", "checked", "--verify", OK_CMD], sandbox.root);
    assert.equal(code, 0, stdout);
    assert.match(stdout, /Verification: check ran: .* → exit 0 at/);
    assert.doesNotMatch(stdout, /unverified — no task record/);
  } finally {
    sandbox.teardown();
  }
});

test("the transition line reports the NEW status, not the one being left", () => {
  const sandbox = makeSandbox();
  try {
    seedOkScript(sandbox.root);
    const runId = "2026-01-01-0003-t3";
    writeRun(sandbox, runId, {
      schema: 3, run_id: runId, slug: "t3",
      passes: [{ n: 1, title: "p1", status: "pending", files: [], required_check: { command: OK_CMD } }]
    });

    const { code, stdout } = runBoard(["pass", "t3", "1", "done", "--proven", "checked", "--verify", OK_CMD], sandbox.root);
    assert.equal(code, 0, stdout);
    assert.match(stdout, /Pass 1 \(p1\) → done/);
    assert.doesNotMatch(stdout, /→ pending/);
  } finally {
    sandbox.teardown();
  }
});

test("required-check comparison strips the plan's markdown backticks before comparing", () => {
  const sandbox = makeSandbox();
  try {
    seedOkScript(sandbox.root);
    const runId = "2026-01-01-0004-t4";
    writeRun(sandbox, runId, {
      schema: 3, run_id: runId, slug: "t4",
      passes: [{ n: 1, title: "p1", status: "pending", files: [], required_check: { command: "`" + OK_CMD + "`" } }]
    });

    const { code, stdout } = runBoard(["pass", "t4", "1", "done", "--proven", "checked", "--verify", OK_CMD], sandbox.root);
    assert.equal(code, 0, stdout);
    assert.doesNotMatch(stdout, /does not match the approved plan/);
  } finally {
    sandbox.teardown();
  }
});

// Fixed honestly (this was one of the two old failures): the declared file's FOLDER must exist
// for "declares N files that do not exist" to fire — lib/resolve.mjs only claims a file is
// honestly "missing" once something anchors (its folder is real); with nothing anchored at all
// the true answer is "cannot resolve", covered separately below. The old fixture declared a file
// under a folder ("ghost/") that was never created, so it always hit the "cannot resolve" branch
// and the old assertion ("declares 1 file") could never be reached — a real message-selection
// bug in what the old test proved, not stale wording. Creating the folder here (without the
// file) exercises the branch the test's name actually describes.
test("done is refused when a declared file does not exist on disk, naming it (its folder is real)", () => {
  const sandbox = makeSandbox();
  try {
    const runId = "2026-01-01-0005-t5";
    fs.mkdirSync(path.join(sandbox.root, "ghost"), { recursive: true });
    writeRun(sandbox, runId, {
      schema: 3, run_id: runId, slug: "t5",
      passes: [{ n: 1, title: "p1", status: "pending", files: ["ghost/does-not-exist.txt"] }]
    });

    const { code, stdout } = runBoard(["pass", "t5", "1", "done", "--proven", "checked"], sandbox.root);
    assert.equal(code, 1);
    assert.match(stdout, /REFUSED: pass 1 declares 1 file/);
    assert.match(stdout, /ghost\/does-not-exist\.txt/);
  } finally {
    sandbox.teardown();
  }
});

// The companion case: nothing anchors at all (no file AND no folder) — the honest answer is
// "cannot resolve", never a confident "missing" claim (lib/resolve.mjs).
test("done is refused with 'cannot resolve', not a false 'missing' claim, when nothing anchors at all", () => {
  const sandbox = makeSandbox();
  try {
    const runId = "2026-01-01-0005b-t5b";
    writeRun(sandbox, runId, {
      schema: 3, run_id: runId, slug: "t5b",
      passes: [{ n: 1, title: "p1", status: "pending", files: ["nowhere/does-not-exist.txt"] }]
    });

    const { code, stdout } = runBoard(["pass", "t5b", "1", "done", "--proven", "checked"], sandbox.root);
    assert.equal(code, 1);
    assert.match(stdout, /REFUSED: cannot resolve any of pass 1's 1 declared files under any candidate base/);
    assert.match(stdout, /not proof the files are absent/);
  } finally {
    sandbox.teardown();
  }
});

test("done is refused with neither a passing record nor --no-check", () => {
  const sandbox = makeSandbox();
  try {
    const runId = "2026-01-01-0006-t6";
    writeRun(sandbox, runId, {
      schema: 3, run_id: runId, slug: "t6",
      passes: [{ n: 1, title: "p1", status: "pending", files: [] }]
    });

    const { code, stdout } = runBoard(["pass", "t6", "1", "done", "--proven", "checked by hand"], sandbox.root);
    assert.equal(code, 1);
    assert.match(stdout, /neither a passing verification record nor --no-check/);
  } finally {
    sandbox.teardown();
  }
});

test("--no-check records the reason, prints it, and lets an unrunnable review complete", () => {
  const sandbox = makeSandbox();
  try {
    const runId = "2026-01-01-0007-t7";
    writeRun(sandbox, runId, {
      schema: 3, run_id: runId, slug: "t7",
      passes: [{ n: 1, title: "p1", status: "pending", files: [] }]
    });

    const { code, stdout } = runBoard(
      ["pass", "t7", "1", "done", "--proven", "read the diff by eye", "--no-check", "read-only review, nothing to execute"],
      sandbox.root
    );
    assert.equal(code, 0, stdout);
    assert.match(stdout, /No-check: read-only review, nothing to execute/);

    const saved = readState(sandbox, runId);
    assert.equal(saved.passes[0].no_check.reason, "read-only review, nothing to execute");
  } finally {
    sandbox.teardown();
  }
});
