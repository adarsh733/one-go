// p5-nogo-fixes.test.mjs — the pass 10 NO-GO defects that live in pass 5's commands
// (dev/FIXES-AFTER-P10.md): D1 own claims never block a job, D2 globs never block `pass … done`,
// D3 a no-parts job closed with open items reads "Finished — N things need you", D6 the
// hooks-stood-down note only while the marker is live, D8 the bare board is ONE table + ONE
// footer line. Each test here failed on the build pass 10 judged. Sandbox only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeSandbox, runBoard } from "./helpers.mjs";

const SLUG = "demo-job";
const readBoard = sb => JSON.parse(fs.readFileSync(sb.boardPath, "utf8"));
const writeBoard = (sb, b) => fs.writeFileSync(sb.boardPath, JSON.stringify(b, null, 2));
const pad = n => String(n).padStart(2, "0");
/** `YYYY-MM-DD HH:MM` local, `hoursAgo` hours back — the heartbeat format start/pass write. */
function stampAgo(hoursAgo) {
  const d = new Date(Date.now() - hoursAgo * 3600 * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function seedSealedPlan(sb) {
  fs.mkdirSync(path.join(sb.root, "out"), { recursive: true });
  fs.writeFileSync(path.join(sb.plansDir, `${SLUG}.plan.json`), JSON.stringify({
    schema: 1, plan_id: `plan-${SLUG}`, plan_revision: 1,
    passes: [{ n: 1, purpose: "Write the report", writes: ["out/report.txt"], depends: [],
      required_check: { command: "node -e \"process.exit(0)\"" } }]
  }, null, 2));
  const b = readBoard(sb);
  b.tasks[SLUG] = { display: "Demo Job", stage: "waiting" };
  writeBoard(sb, b);
}

/** A claims board (config claims_file) with the given rows under `## Active claims`. */
function seedClaims(sb, rows) {
  fs.writeFileSync(path.join(sb.onegoDir, "config.json"), JSON.stringify({ claims_file: ".claude/ACTIVE-WORK.md" }));
  fs.writeFileSync(path.join(sb.root, ".claude", "ACTIVE-WORK.md"), [
    "# Active work", "", "## Active claims", "",
    "| Claim ID | Owner | Status | Started | Heartbeat | Files / globs |",
    "|---|---|---|---|---|---|",
    ...rows.map(r => `| ${r.id} | ${r.owner} | open | 2026-09-27 | 2026-09-27 | ${r.files} |`),
    ""
  ].join("\n"));
}

function seedRun(sb, runId, state, beat) {
  const runDir = path.join(sb.onegoDir, runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "state.json"), JSON.stringify({ schema: 3, run_id: runId, slug: SLUG, ...state }, null, 2));
  if (beat) fs.writeFileSync(path.join(runDir, "heartbeat.txt"), beat + "\n");
  return runDir;
}

/** The bare board's shape: table lines, then at most ONE other non-empty line. */
function nonTableLines(stdout) {
  return stdout.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith("|"));
}

// ---------------------------------------------------------------- D1 · own claims

test("D1: the conductor's own pre-start claim (names the job) never blocks start, lanes or finish", () => {
  const sb = makeSandbox();
  try {
    seedSealedPlan(sb);
    seedClaims(sb, [{ id: "C-20260927-own", owner: `conductor (/one-go dispatch ${SLUG})`, files: "out/report.txt" }]);
    const lanes = runBoard(["lanes", SLUG], sb.root);
    assert.equal(lanes.code, 0);
    assert.doesNotMatch(lanes.stdout, /held by/, lanes.stdout);
    const finish = runBoard(["finish", SLUG], sb.root);
    assert.equal(finish.code, 0);
    assert.doesNotMatch(finish.stdout, /Another chat window/, finish.stdout);
    const start = runBoard(["start", SLUG], sb.root);
    assert.equal(start.code, 0, start.stdout + start.stderr);
  } finally { sb.teardown(); }
});

test("D1: a claim naming only a DIFFERENT job (slug-2) is foreign, blocks start, and names the claim id and --ignore-claims", () => {
  const sb = makeSandbox();
  try {
    seedSealedPlan(sb);
    seedClaims(sb, [{ id: "C-20260927-other", owner: `conductor (/one-go dispatch ${SLUG}-2)`, files: "out/report.txt" }]);
    const start = runBoard(["start", SLUG], sb.root);
    assert.equal(start.code, 1, start.stdout);
    assert.match(start.stdout, /C-20260927-other/);
    assert.match(start.stdout, /--ignore-claims/);
    assert.equal(fs.existsSync(path.join(sb.onegoDir, "ACTIVE")), false, "a refused start writes nothing");
    const lanes = runBoard(["lanes", SLUG], sb.root);
    assert.match(lanes.stdout, /held by `C-20260927-other`/);
    assert.match(lanes.stdout, /--ignore-claims/);
    const finish = runBoard(["finish", SLUG], sb.root);
    assert.match(finish.stdout, /--ignore-claims/);
    const forced = runBoard(["start", SLUG, "--ignore-claims"], sb.root);
    assert.equal(forced.code, 0, forced.stdout + forced.stderr);
  } finally { sb.teardown(); }
});

test("D1: a pass claim id recorded in the job's own earlier run is its own, even when the row names no slug", () => {
  const sb = makeSandbox();
  try {
    seedSealedPlan(sb);
    seedRun(sb, `2026-05-05-0500-${SLUG}`, {
      started: "2026-05-05 05:00", ended: "2026-05-05 05:10 — stopped by /one-go stop",
      passes: [{ n: 1, title: "Write the report", status: "pending", files: ["out/report.txt"], attempts: 0, claim_id: "C-2026-05-05-0500-p1" }]
    }, "2026-05-05 05:10");
    seedClaims(sb, [{ id: "C-2026-05-05-0500-p1", owner: "pass 1 worker", files: "out/report.txt" }]);
    const lanes = runBoard(["lanes", SLUG], sb.root);
    assert.doesNotMatch(lanes.stdout, /held by/, lanes.stdout);
  } finally { sb.teardown(); }
});

// ---------------------------------------------------------------- D2 · globs never block done

test("D2: pass done with --no-check is never blocked by a glob — even one whose folder is gone", () => {
  const sb = makeSandbox();
  try {
    const runId = `2026-03-03-0000-${SLUG}`;
    seedRun(sb, runId, {
      started: "2026-03-03 00:00", heartbeat: "2026-03-03 00:00",
      passes: [{ n: 1, title: "Move the folder", status: "running", files: ["moved-away/**", "also-gone/*.mjs"], attempts: 1 }]
    }, "2026-03-03 00:00");
    const b = readBoard(sb); b.tasks[SLUG] = { display: "Demo Job", stage: "running", run_id: runId }; writeBoard(sb, b);
    const r = runBoard(["pass", SLUG, "1", "done", "--proven", "folder renamed", "--no-check", "the move is the proof"], sb.root);
    assert.doesNotMatch(r.stdout, /cannot resolve|does not exist|do not exist/, r.stdout);
    assert.equal(r.code, 0, r.stdout + r.stderr);
  } finally { sb.teardown(); }
});

test("D2: a literal declared file must still exist, glob or no glob beside it", () => {
  const sb = makeSandbox();
  try {
    fs.mkdirSync(path.join(sb.root, "made"), { recursive: true });
    const runId = `2026-03-03-0000-${SLUG}`;
    seedRun(sb, runId, {
      started: "2026-03-03 00:00",
      passes: [{ n: 1, title: "Build", status: "running", files: ["made/never-written.txt", "made/**"], attempts: 1 }]
    }, "2026-03-03 00:00");
    const r = runBoard(["pass", SLUG, "1", "done", "--proven", "x", "--no-check", "y"], sb.root);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /declares 1 file.*that does not exist/s);
  } finally { sb.teardown(); }
});

// ---------------------------------------------------------------- D3 · Finished — N things need you

for (const [label, passes] of [
  ["a parked pass", [{ n: 1, title: "Do it", status: "parked", parked_question: "needs you", files: [] }]],
  ["every pass done", [{ n: 1, title: "Do it", status: "done", files: [] }]]
]) {
  test(`D3: a no-parts job closed with open items (${label}) reads "Finished — 2 things need you"`, () => {
    const sb = makeSandbox();
    try {
      const runId = `2026-04-04-0000-${SLUG}`;
      const dir = seedRun(sb, runId, {
        started: "2026-04-04 00:00", ended: "2026-04-04 00:10 — closed", ending: "FINISHED WITH OPEN ITEMS",
        open_items: [{ kind: "parked", pass: 1, text: "a" }, { kind: "unproven", pass: 1, text: "b" }], passes
      }, "2026-04-04 00:10");
      fs.writeFileSync(path.join(dir, "report.md"), "# closed\n");
      const b = readBoard(sb); b.tasks[SLUG] = { display: "Demo Job", stage: "waiting", run_id: runId }; writeBoard(sb, b);
      const r = runBoard([], sb.root);
      assert.equal(r.code, 0);
      const row = r.stdout.split("\n").find(l => l.includes("**Demo Job**"));
      assert.ok(row, "the closed job keeps its row (never hidden as done):\n" + r.stdout);
      assert.match(row, /Finished — 2 things need you/);
      assert.doesNotMatch(row, /resume pass|all passes done|✅ done|⛔ blocked/);
    } finally { sb.teardown(); }
  });
}

// ---------------------------------------------------------------- D6 · hooks note only while live

test("D6: no hooks-stood-down note when ACTIVE's heartbeat is 3 h old or more; shown in the footer while live", () => {
  const sb = makeSandbox();
  try {
    const runId = `2026-06-06-0600-${SLUG}`;
    seedRun(sb, runId, { started: "2026-06-06 06:00", passes: [{ n: 1, title: "Do it", status: "pending", files: [] }] }, stampAgo(4));
    fs.writeFileSync(path.join(sb.onegoDir, "ACTIVE"), runId + "\n");
    let r = runBoard([], sb.root);
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.stdout, /hooks stood down/, "a 4-hour-old heartbeat means the hooks are back on");

    fs.writeFileSync(path.join(sb.onegoDir, runId, "heartbeat.txt"), stampAgo(0.5) + "\n");
    r = runBoard([], sb.root);
    assert.match(r.stdout, new RegExp(`hooks stood down since .* by run \`${runId}\``));
    assert.ok(nonTableLines(r.stdout).length <= 1, "the note lives in the ONE footer line:\n" + r.stdout);
  } finally { sb.teardown(); }
});

// ---------------------------------------------------------------- D8 · one table + one footer line

test("D8: a live run shows in its job's row (🟡 running, Next move = current pass) — no Live now block", () => {
  const sb = makeSandbox();
  try {
    const runId = `2026-07-07-0700-${SLUG}`;
    seedRun(sb, runId, {
      started: "2026-07-07 07:00",
      passes: [{ n: 1, title: "Plan it", status: "done", files: [] }, { n: 2, title: "Build it", status: "running", files: [] }]
    }, stampAgo(0.25));
    const b = readBoard(sb); b.tasks[SLUG] = { display: "Demo Job", stage: "running", run_id: runId }; writeBoard(sb, b);
    const r = runBoard([], sb.root);
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.stdout, /Live now/);
    const row = r.stdout.split("\n").find(l => l.includes("**Demo Job**"));
    assert.match(row, /🟡 running/);
    assert.match(row, /pass 2 — Build it/);
    assert.ok(nonTableLines(r.stdout).length <= 1, "ONE table plus ONE footer line:\n" + r.stdout);
  } finally { sb.teardown(); }
});

test("D8: a stale run (heartbeat 3 h+) is never listed as running — only counted in the ONE footer line", () => {
  const sb = makeSandbox();
  try {
    const runId = `2026-08-08-0800-${SLUG}`;
    seedRun(sb, runId, {
      started: "2026-08-08 08:00", passes: [{ n: 1, title: "Build it", status: "running", files: [] }]
    }, "2026-08-08 08:00");
    const b = readBoard(sb); b.tasks[SLUG] = { display: "Demo Job", stage: "running", run_id: runId }; writeBoard(sb, b);
    const r = runBoard([], sb.root);
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.stdout, /Live now/);
    assert.doesNotMatch(r.stdout, /🟡 running/);
    const extra = nonTableLines(r.stdout);
    assert.equal(extra.length, 1, "exactly one footer line:\n" + r.stdout);
    assert.match(extra[0], /1 unfinished.*\/one-go dispatch <job>/);
  } finally { sb.teardown(); }
});

test("D8: a job WITH parts whose newest run went stale is not shown as running either", () => {
  const sb = makeSandbox();
  try {
    const runId = `2026-09-09-0900-${SLUG}`;
    seedRun(sb, runId, {
      started: "2026-09-09 09:00", passes: [{ n: 1, title: "Review", status: "running", files: [] }]
    }, "2026-09-09 09:00");
    const b = readBoard(sb);
    b.tasks[SLUG] = { display: "Demo Job", stage: "running", run_id: runId,
      subtasks: [{ id: "a", title: "Build", stage: "done" }, { id: "b", title: "Review", stage: "running" }] };
    writeBoard(sb, b);
    const r = runBoard([], sb.root);
    assert.equal(r.code, 0);
    const row = r.stdout.split("\n").find(l => l.includes("**Demo Job**"));
    assert.doesNotMatch(row, /🟡 running/, r.stdout);
    assert.match(row, /\/one-go dispatch demo-job/);
  } finally { sb.teardown(); }
});
