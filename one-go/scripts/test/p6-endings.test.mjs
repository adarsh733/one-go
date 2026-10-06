// p6-endings.test.mjs — every run ends through `close`: close itself, watchdog (STOP, finalize,
// ceiling) and stop. Each ending writes report.md, stamps `ended`, releases claims, deletes
// ACTIVE only when it names this run, and updates the board. FINISHED WITH OPEN ITEMS is a
// normal, clean close — never a run left hanging.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeSandbox, runBoard } from "./helpers.mjs";
import { stamp } from "../lib/util.mjs";

const SLUG = "alpha-job";
const RUN = "2026-09-27-1000-alpha-job";

function sandbox({ config } = {}) {
  const sb = makeSandbox();
  if (config) fs.writeFileSync(path.join(sb.onegoDir, "config.json"), JSON.stringify(config, null, 2));
  const b = JSON.parse(fs.readFileSync(sb.boardPath, "utf8"));
  b.tasks[SLUG] = { display: "Alpha job", stage: "running", subtasks: [] };
  fs.writeFileSync(sb.boardPath, JSON.stringify(b, null, 2));
  return sb;
}

function addRun(sb, passes, { runId = RUN, active = true, extra = {} } = {}) {
  const dir = path.join(sb.onegoDir, runId);
  fs.mkdirSync(dir, { recursive: true });
  const now = stamp();
  const state = { schema: 3, run_id: runId, slug: SLUG, started: now, ceiling_hours: 8,
    heartbeat: now, conductor_last_seen: now, passes, ...extra };
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify(state, null, 2));
  fs.writeFileSync(path.join(dir, "heartbeat.txt"), now + "\n");
  if (active) fs.writeFileSync(path.join(sb.onegoDir, "ACTIVE"), runId + "\n");
  return dir;
}

const rec = (runId, n) => ({ exit_code: 0, command: "node -e 0", run_id: runId, pass_n: n, attempt: 1 });
const readState = dir => JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
const readReport = dir => fs.readFileSync(path.join(dir, "report.md"), "utf8");
const activeOf = sb => { try { return fs.readFileSync(path.join(sb.onegoDir, "ACTIVE"), "utf8").trim(); } catch { return null; } };
const taskOf = sb => JSON.parse(fs.readFileSync(sb.boardPath, "utf8")).tasks[SLUG];

/** Done-with-no-check, parked, and one pass that can never run because it waits on the parked one. */
const OPEN_PASSES = () => [
  { n: 1, title: "review", status: "done", no_check: { reason: "read-only review" }, attempts: 1 },
  { n: 2, title: "build", status: "parked", parked_question: "Which colour?", depends: [1], claim_id: "C-2026-09-27-1000-p2" },
  { n: 3, title: "polish", status: "pending", depends: [2] }
];

const CLAIMS = [
  "# Claims", "", "## Active claims", "",
  "| Claim ID | Owner | Status | Started | Heartbeat | Files/globs |",
  "|---|---|---|---|---|---|",
  "| C-2026-09-27-1000-p2 | one-go | running | 10:00 | 10:00 | `src/**` |",
  "| C-other-window | someone | running | 10:00 | 10:00 | `other/**` |",
  "", "## Recently released", "",
  "- **C-old-1** released 2026-09-01 — done", ""
].join("\n");

// ---------------------------------------------------------------- close

test("close: parked + --no-check + a pass that can never run → FINISHED WITH OPEN ITEMS, cleanly closed", () => {
  const sb = sandbox({ config: { claims_file: "claims.md", worklog: "log.md" } });
  try {
    fs.writeFileSync(path.join(sb.root, "claims.md"), CLAIMS);
    fs.writeFileSync(path.join(sb.root, "log.md"), "# log\n- an older line\n");
    const dir = addRun(sb, OPEN_PASSES());

    const r = runBoard(["close", SLUG], sb.root);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /FINISHED WITH OPEN ITEMS/);

    const st = readState(dir);
    assert.ok(st.ended, "ended is stamped");
    assert.doesNotMatch(st.ended, /stop/i, "an open-items ending is not a stop");
    assert.equal(st.ending, "FINISHED WITH OPEN ITEMS");
    assert.equal(st.open_items.length, 3);
    assert.deepEqual(st.open_items.map(i => i.kind).sort(), ["no_check", "parked", "unproven"]);

    const report = readReport(dir);
    assert.match(report, /FINAL REPORT \(FINISHED WITH OPEN ITEMS\)/);
    assert.match(report, /Which colour\?/);
    assert.match(report, /C-2026-09-27-1000-p2/, "released claim named in the report");

    assert.equal(activeOf(sb), null, "ACTIVE naming this run is deleted");

    const claims = fs.readFileSync(path.join(sb.root, "claims.md"), "utf8");
    const active = claims.split("## Recently released")[0];
    assert.doesNotMatch(active, /C-2026-09-27-1000-p2/, "the run's claim left Active claims");
    assert.match(active, /C-other-window/, "another window's claim is untouched");
    assert.match(claims.split("## Recently released")[1], /\*\*C-2026-09-27-1000-p2\*\* released/);

    const t = taskOf(sb);
    assert.equal(t.stage, "waiting", "the job waits on the person");
    assert.match(t.next_move, /^Finished — 3 things need you/);

    const log = fs.readFileSync(path.join(sb.root, "log.md"), "utf8");
    assert.ok(log.startsWith("# log\n- an older line\n"), "worklog is appended to, never rewritten");
    assert.equal(log.trim().split("\n").length, 3);
    assert.match(log, new RegExp(`${RUN}.*FINISHED WITH OPEN ITEMS`));
  } finally { sb.teardown(); }
});

test("close: every pass proven by a check the engine ran → COMPLETE", () => {
  const sb = sandbox();
  try {
    const dir = addRun(sb, [
      { n: 1, title: "a", status: "done", attempts: 1, verification_record: rec(RUN, 1) },
      { n: 2, title: "b", status: "done", attempts: 1, verification_record: rec(RUN, 2), depends: [1] }
    ]);
    const r = runBoard(["close", SLUG], sb.root);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const st = readState(dir);
    assert.equal(st.ending, "COMPLETE");
    assert.match(st.ended, /completed all 2 passes/);
    assert.match(readReport(dir), /FINAL REPORT \(COMPLETE\)/);
    assert.equal(activeOf(sb), null);
  } finally { sb.teardown(); }
});

test("close: refuses while work can still run (writes nothing); --reason ends it STOPPED", () => {
  const sb = sandbox();
  try {
    const dir = addRun(sb, [
      { n: 1, title: "a", status: "done", no_check: { reason: "review" }, attempts: 1 },
      { n: 2, title: "b", status: "pending", depends: [1] },
      { n: 3, title: "c", status: "parked", parked_question: "Q?" }
    ]);
    const before = fs.readFileSync(path.join(dir, "state.json"), "utf8");
    const r = runBoard(["close", SLUG], sb.root);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /pass 2 can start/);
    assert.match(r.stdout, /--reason/);
    assert.equal(fs.readFileSync(path.join(dir, "state.json"), "utf8"), before, "refusal writes nothing");
    assert.equal(fs.existsSync(path.join(dir, "report.md")), false);
    assert.equal(activeOf(sb), RUN);

    const r2 = runBoard(["close", SLUG, "--reason", "out of time"], sb.root);
    assert.equal(r2.code, 0, r2.stdout + r2.stderr);
    const st = readState(dir);
    assert.equal(st.ending, "STOPPED");
    assert.match(st.ended, /stopped: out of time/);
    assert.equal(st.passes[1].status, "stopped", "the waiting pass is stopped");
    assert.equal(st.passes[2].status, "parked", "a parked pass keeps its question");
    assert.match(readReport(dir), /FINAL REPORT \(STOPPED\)/);
    assert.equal(activeOf(sb), null);
    assert.match(taskOf(sb).next_move, /carry on with \/one-go dispatch alpha-job/);
  } finally { sb.teardown(); }
});

test("close: ACTIVE naming another run is left alone", () => {
  const sb = sandbox();
  try {
    const dir = addRun(sb, OPEN_PASSES(), { active: false });
    fs.writeFileSync(path.join(sb.onegoDir, "ACTIVE"), "2026-09-27-0900-someone-else\n");
    const r = runBoard(["close", RUN], sb.root);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.ok(readState(dir).ended);
    assert.equal(activeOf(sb), "2026-09-27-0900-someone-else");
  } finally { sb.teardown(); }
});

test("close: a closed run is not closed twice; an older unclosed run is closed by its folder name", () => {
  const sb = sandbox();
  try {
    const OLD = "2026-09-20-0800-alpha-job";
    const oldDir = addRun(sb, OPEN_PASSES(), { runId: OLD, active: false });
    fs.writeFileSync(path.join(oldDir, "report.md"), "# the old report\n");
    const newDir = addRun(sb, OPEN_PASSES());
    assert.equal(runBoard(["close", SLUG], sb.root).code, 0);
    const firstReport = readReport(newDir);

    const again = runBoard(["close", SLUG], sb.root);
    assert.equal(again.code, 0);
    assert.match(again.stdout, /already ended/);
    assert.match(again.stdout, new RegExp(`board\\.mjs close ${OLD}`), "points at the older run that never closed");
    assert.equal(readReport(newDir), firstReport, "a second close writes nothing");

    const r = runBoard(["close", OLD], sb.root);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.ok(readState(oldDir).ended);
    assert.match(readReport(oldDir), /FINISHED WITH OPEN ITEMS/);
    assert.equal(fs.readFileSync(path.join(oldDir, "report-before-close.md"), "utf8"), "# the old report\n",
      "an older report is kept, never lost");
  } finally { sb.teardown(); }
});

test("close: house 'before finished' checklist and report extras reach the summary and report", () => {
  const sb = sandbox({ config: { report_extras: [{ when: "open_items", text: "Prove it on a real device ({slug})." }] } });
  try {
    fs.writeFileSync(path.join(sb.onegoDir, "house-rules.md"),
      "## For the conductor\nx\n\n## Before a run is called finished\n- the release check ran\n");
    const dir = addRun(sb, OPEN_PASSES());
    const r = runBoard(["close", SLUG], sb.root);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /- \[ \] the release check ran/);
    assert.match(readReport(dir), /Prove it on a real device \(alpha-job\)\./);
  } finally { sb.teardown(); }
});

// ---------------------------------------------------------------- watchdog

test("watchdog: a STOP file closes the run STOPPED through close", () => {
  const sb = sandbox();
  try {
    const dir = addRun(sb, [{ n: 1, title: "a", status: "pending" }]);
    fs.writeFileSync(path.join(dir, "STOP"), "2026-09-27 10:30 — the person said stop\n");
    const r = runBoard(["watchdog"], sb.root);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const st = readState(dir);
    assert.equal(st.ending, "STOPPED");
    assert.match(st.ended, /stop/i, "start can still resume a stopped run");
    assert.match(readReport(dir), /FINAL REPORT \(STOPPED\)/);
    assert.equal(activeOf(sb), null);
  } finally { sb.teardown(); }
});

test("watchdog: all done with only declared open items (--no-check) closes FINISHED WITH OPEN ITEMS, no refusal", () => {
  const sb = sandbox();
  try {
    const dir = addRun(sb, [
      { n: 1, title: "a", status: "done", attempts: 1, verification_record: rec(RUN, 1) },
      { n: 2, title: "b", status: "done", attempts: 1, no_check: { reason: "needs the phone" } }
    ]);
    const r = runBoard(["watchdog"], sb.root);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /REFUSED/);
    const st = readState(dir);
    assert.equal(st.ending, "FINISHED WITH OPEN ITEMS");
    assert.equal(st.open_items[0].kind, "phone_only");
    assert.equal(activeOf(sb), null);
  } finally { sb.teardown(); }
});

test("watchdog: a real gap refuses (run stays open) and names the way out; --accept-open closes it", () => {
  const sb = sandbox();
  try {
    const dir = addRun(sb, [{ n: 1, title: "a", status: "done", attempts: 1, proven: "I looked at it" }]);
    const r = runBoard(["watchdog"], sb.root);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /WATCHDOG REFUSED TO FINALIZE/);
    assert.match(r.stdout, /--accept-open/);
    assert.match(r.stdout, /board\.mjs close alpha-job/);
    assert.equal(readState(dir).ended, undefined);
    assert.equal(activeOf(sb), RUN);

    const r2 = runBoard(["watchdog", "--accept-open"], sb.root);
    assert.equal(r2.code, 0, r2.stdout + r2.stderr);
    const st = readState(dir);
    assert.equal(st.ending, "FINISHED WITH OPEN ITEMS");
    assert.ok(st.open_items_accepted);
    assert.equal(st.verification_refused, undefined, "the refusal mark is cleared once closed");
    assert.match(readReport(dir), /accepted at/);
    assert.equal(activeOf(sb), null);
  } finally { sb.teardown(); }
});

test("watchdog: the ceiling closes the run STOPPED (exit 1), worded so start will not resume it", () => {
  const sb = sandbox();
  try {
    const dir = addRun(sb, [{ n: 1, title: "a", status: "pending" }], { extra: { started: "2026-01-01 00:00", ceiling_hours: 8 } });
    const r = runBoard(["watchdog"], sb.root);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /ceiling/);
    const st = readState(dir);
    assert.equal(st.ending, "STOPPED");
    assert.match(st.ended, /8h ceiling expired/);
    assert.ok(fs.existsSync(path.join(dir, "report.md")));
    assert.equal(activeOf(sb), null);
  } finally { sb.teardown(); }
});

test("watchdog: ACTIVE naming an already-closed run is cleared, nothing else touched", () => {
  const sb = sandbox();
  try {
    const dir = addRun(sb, [{ n: 1, title: "a", status: "done" }], { extra: { ended: "2026-09-27 09:00 — completed all 1 passes" } });
    fs.writeFileSync(path.join(dir, "report.md"), "# done\n");
    const r = runBoard(["watchdog"], sb.root);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /already ended/);
    assert.equal(activeOf(sb), null);
    assert.equal(readReport(dir), "# done\n");
  } finally { sb.teardown(); }
});

// ---------------------------------------------------------------- stop

test("stop: nothing running → closed now, STOPPED, through close", () => {
  const sb = sandbox({ config: { claims_file: "claims.md" } });
  try {
    fs.writeFileSync(path.join(sb.root, "claims.md"), CLAIMS);
    const dir = addRun(sb, OPEN_PASSES());
    const r = runBoard(["stop", SLUG], sb.root);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const st = readState(dir);
    assert.equal(st.ending, "STOPPED");
    assert.match(st.ended, /Stopped by \/one-go stop/);
    assert.equal(st.passes[1].status, "parked");
    assert.equal(st.passes[2].status, "stopped");
    assert.ok(fs.existsSync(path.join(dir, "STOP")));
    assert.match(readReport(dir), /FINAL REPORT \(STOPPED\)/);
    assert.equal(activeOf(sb), null);
    assert.doesNotMatch(fs.readFileSync(path.join(sb.root, "claims.md"), "utf8").split("## Recently released")[0], /C-2026-09-27-1000-p2/);
  } finally { sb.teardown(); }
});

test("stop: a running worker → stop requested; `next` then hands the conductor close; close ends it STOPPED", () => {
  const sb = sandbox();
  try {
    const dir = addRun(sb, [
      { n: 1, title: "a", status: "running", attempts: 1 },
      { n: 2, title: "b", status: "pending", depends: [1] }
    ]);
    const r = runBoard(["stop", SLUG], sb.root);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /Stop requested/);
    let st = readState(dir);
    assert.equal(st.ended, undefined, "not ended while a worker may still be writing");
    assert.equal(st.passes[0].status, "stop-requested");
    assert.ok(fs.existsSync(path.join(dir, "STOP")), "a STOP file means the run cannot hang");

    const n = runBoard(["next", SLUG], sb.root);
    assert.match(n.stdout, /board\.mjs close alpha-job --reason "stop requested"/);

    const c = runBoard(["close", SLUG, "--reason", "stop requested"], sb.root);
    assert.equal(c.code, 0, c.stdout + c.stderr);
    st = readState(dir);
    assert.equal(st.ending, "STOPPED");
    assert.match(st.ended, /stop/i);
    assert.equal(activeOf(sb), null);
  } finally { sb.teardown(); }
});
