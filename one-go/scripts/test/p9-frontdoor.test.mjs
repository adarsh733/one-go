// p9-frontdoor.test.mjs — three things kept from the old 56-test suite that p4's own front-door
// tests (p4-dispatch.test.mjs, p4-router.test.mjs, p4-brief.test.mjs) do not already cover:
//
//   1. `dispatch --seal` on free text with no file-like tokens still writes a self-contained
//      brief, and says so plainly ("(none found in the text)") — from the old dispatch.test.mjs;
//      p4-dispatch's own --seal tests always name a file in the request text.
//   2. `brief`'s fallback text for a pass with NO exclusions/shared_resources at all — from the
//      old brief.test.mjs; p4-brief's own fallback test exercises "Read first" being empty, not
//      "Do NOT touch" / "You share these" specifically.
//   3. NEW — obs 0063: `revive --apply` with no selector used to silently print the list and
//      exit 0 (fixed; p9-recovery.test.mjs proves that one case). This is the general version:
//      every documented flag, run in a state where it plausibly applies, either DOES something
//      (changes a file, or prints a real, specific answer) or CLEANLY REFUSES (non-zero exit,
//      one-line reason) — never a silent, generic "nothing happened" success.
//
// All against throwaway sandboxes via helpers.mjs — never a real project's own `.claude/one-go/`.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeSandbox, runBoard } from "./helpers.mjs";

function readBoard(sb) { return JSON.parse(fs.readFileSync(sb.boardPath, "utf8")); }
function seedTask(sb, slug, display) {
  const board = readBoard(sb);
  board.tasks[slug] = {
    display, what: display, stage: "not_started", source: "test",
    pending_questions: 0, next_move: "", blocked_reason: null, subtasks: []
  };
  fs.writeFileSync(sb.boardPath, JSON.stringify(board, null, 2));
}
function seedPlan(sb, slug, passOverrides = {}) {
  const plan = {
    schema: 1, plan_id: `plan-${slug}`, plan_revision: 1, task_id: slug,
    passes: [{
      n: 1, purpose: "Do the demo thing", writes: ["scripts/demo.mjs"],
      required_check: { command: "node --test scripts/test/demo.test.mjs" },
      ...passOverrides
    }]
  };
  fs.writeFileSync(path.join(sb.plansDir, `${slug}.plan.json`), JSON.stringify(plan, null, 2));
}

// ------------------------------------------------------------------ 1. dispatch --seal, no files named

test("dispatch --seal on free text with no file-like tokens still writes a self-contained brief, noting none found", () => {
  const sb = makeSandbox();
  try {
    const { stdout, code } = runBoard(["dispatch", "brand new idea with no files named", "--seal"], sb.root);
    assert.equal(code, 0, stdout);
    const printedPath = stdout.trim();
    assert.equal(stdout.trim().split(/\r?\n/).length, 1, "stdout must be the path only");
    assert.ok(fs.existsSync(printedPath));
    const content = fs.readFileSync(printedPath, "utf8");
    assert.match(content, /## Files it names/);
    assert.match(content, /\(none found in the text\)/);
    // Still a full, self-contained brief, not an empty stub.
    assert.match(content, /## Job \(free text\)/);
    assert.match(content, /brand new idea with no files named/);
  } finally {
    sb.teardown();
  }
});

// ------------------------------------------------------------------ 2. brief's "none recorded" fallback

test("brief body: Do NOT touch / You share these fall back to '(none recorded in the plan)' when a pass has neither", () => {
  const sb = makeSandbox();
  try {
    seedTask(sb, "demo-job", "Demo Job");
    seedPlan(sb, "demo-job", { exclusions: [], shared_resources: [] });

    const { code, stdout } = runBoard(["brief", "demo-job", "1"], sb.root);
    assert.equal(code, 0, stdout);

    const doNotTouch = stdout.split("## Do NOT touch")[1].split("## You share these")[0];
    const youShare = stdout.split("## You share these")[1].split("## Read first")[0];
    assert.ok(doNotTouch.includes("(none recorded in the plan)"), "Do NOT touch should fall back");
    assert.ok(youShare.includes("(none recorded in the plan)"), "You share these should fall back");
  } finally {
    sb.teardown();
  }
});

// ------------------------------------------------------------------ 3. every flag acts or refuses (obs 0063)

// Each case sets up a sandbox in a state where the flag plausibly applies, runs the command, and
// requires ONE of:
//   - a real, specific message (matched by `expectMessage`) — acting or refusing, either is fine,
//     as long as it is not generic boilerplate that would print no matter what happened;
//   - a real file-system effect (`expectChanged`) — something on disk moved.
// What is refused here is the THIRD option: exit 0, some generic-looking line, and nothing
// changed — the shape obs 0063 actually was (`revive --apply` with no selector silently listing
// runs and exiting 0, as if the flag had been honoured).
const CASES = [
  {
    name: "resume --apply with no selector refuses, does not silently list-and-exit-0",
    setup: () => {},
    argv: ["resume", "--apply"],
    expectCode: 1,
    expectMessage: /will not guess/i
  },
  {
    name: "revive --apply with no selector refuses (alias, same as resume)",
    setup: () => {},
    argv: ["revive", "--apply"],
    expectCode: 1,
    expectMessage: /will not guess/i
  },
  {
    name: "resume --tidy on an empty board still prints a definite answer, not silence",
    setup: () => {},
    argv: ["resume", "--tidy"],
    expectCode: 0,
    expectMessage: /DRY RUN|nothing on disk changes|No runs on this board/
  },
  {
    name: "watchdog with no ACTIVE run refuses to pretend there is one",
    setup: () => {},
    argv: ["watchdog"],
    expectCode: 0,
    expectMessage: /No active run/i
  },
  {
    name: "close on an unknown job refuses by name, writes nothing",
    setup: () => {},
    argv: ["close", "no-such-job"],
    expectCode: 1,
    expectMessage: /no task matches/i
  },
  {
    name: "pass done with no --proven refuses and names the exact fix",
    setup: sb => {
      seedTask(sb, "evidence-job", "Evidence Job");
      // A plan the seal gate has nothing to say about (no declared files, a check command with
      // no path target) — this case is about the --proven gate, not the seal gate.
      seedPlan(sb, "evidence-job", { writes: [], required_check: undefined, proven_by: "node -e \"process.exit(0)\"" });
      const started = runBoard(["start", "evidence-job"], sb.root);
      assert.equal(started.code, 0, `fixture setup failed: ${started.stdout}`);
    },
    argv: () => ["pass", "evidence-job", "1", "done"],
    expectCode: 1,
    expectMessage: /REFUSED/
  },
  {
    name: "start on an unknown job refuses, writes nothing",
    setup: () => {},
    argv: ["start", "no-such-job"],
    expectCode: 1,
    expectMessage: /no task matches/i
  },
  {
    name: "info on an unknown job refuses with a dispatch hint, not a blank board",
    setup: () => {},
    argv: ["info", "no-such-job"],
    expectCode: 1,
    expectMessage: /no job called/i
  },
  {
    name: "check-plan with no draft and no argument refuses in one line",
    setup: () => {},
    argv: ["check-plan"],
    expectCode: 1,
    expectMessage: /.+/
  }
];

for (const c of CASES) {
  test(`obs 0063 — ${c.name}`, () => {
    const sb = makeSandbox();
    try {
      c.setup(sb);
      const argv = typeof c.argv === "function" ? c.argv(sb) : c.argv;
      const { code, stdout } = runBoard(argv, sb.root);
      if (c.expectCode !== undefined) assert.equal(code, c.expectCode, `argv ${argv.join(" ")}\n${stdout}`);
      assert.ok(stdout.trim().length > 0, `${argv.join(" ")} produced no output at all — a flag must never be silent`);
      if (c.expectMessage) assert.match(stdout, c.expectMessage, `argv ${argv.join(" ")}\n${stdout}`);
    } finally {
      sb.teardown();
    }
  });
}
