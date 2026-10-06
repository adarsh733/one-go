// p15-commands.test.mjs — one-go-final-clean pass 3: the commands cut to the command table.
//   - `finish` is a silent alias of dispatch: same output, same exit code, byte for byte;
//   - dispatch picks up a cut-off run on its own: the resume check first, one line saying it is
//     carrying on, then that run's next step — no new run;
//   - a long request whose first words spell an open job continues that job (no duplicate);
//   - the board footer and every one-line hint name only public words (D9: the bare board is
//     plumbing now — it still runs and still names only public words, but it is not on the menu).
// Sandbox only (helpers.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeSandbox, runBoard } from "./helpers.mjs";
import { WORD_LISTS } from "../board.mjs";
import { lookupForDispatch, openJobByFirstWords } from "../cmd/dispatch.mjs";

const SCRIPTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
// The public menu is dispatch, stop, help (D9); the bare board ("") sits in plumbing, and no hint
// may send a person to anything outside those three.
const NOT_PUBLIC = [...WORD_LISTS.alias, ...WORD_LISTS.plumbing, ...WORD_LISTS.retired].filter(Boolean);

const readBoard = sb => JSON.parse(fs.readFileSync(sb.boardPath, "utf8"));
function seedTask(sb, slug, extra = {}) {
  const b = readBoard(sb);
  b.tasks[slug] = { display: slug, stage: "not_started", subtasks: [], ...extra };
  fs.writeFileSync(sb.boardPath, JSON.stringify(b, null, 2));
}
function seedPlan(sb, slug, passes) {
  fs.writeFileSync(path.join(sb.plansDir, `${slug}.plan.json`),
    JSON.stringify({ schema: 1, plan_id: `plan-${slug}`, plan_revision: 1, task_id: slug, passes }, null, 2));
}
function seedRun(sb, runId, state, { report = false } = {}) {
  const dir = path.join(sb.onegoDir, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ schema: 3, run_id: runId, ...state }, null, 2));
  fs.writeFileSync(path.join(dir, "heartbeat.txt"), "2026-09-27 10:00\n");
  if (report) fs.writeFileSync(path.join(dir, "report.md"), "# report\n");
  return dir;
}
const runFolders = sb => fs.readdirSync(sb.onegoDir).filter(n => /^\d{4}-\d{2}-\d{2}-/.test(n)).sort();

/** A job with a sealed two-pass plan and a run cut off after pass 1. */
function cutOffJob(sb) {
  const slug = "half-job";
  seedTask(sb, slug, { display: "Half job" });
  seedPlan(sb, slug, [
    { n: 1, purpose: "First half", writes: ["out/a.txt"], required_check: { command: "node -e \"process.exit(0)\"" } },
    { n: 2, purpose: "Second half", writes: ["out/b.txt"], prerequisites: [1], required_check: { command: "node -e \"process.exit(0)\"" } }
  ]);
  const runId = "2026-09-27-1000-half-job";
  seedRun(sb, runId, {
    slug, started: "2026-09-27 10:00", heartbeat: "2026-09-27 10:00",
    passes: [
      { n: 1, title: "First half", status: "done", files: [], proven: "ran it", attempts: 1 },
      { n: 2, title: "Second half", status: "pending", files: [], depends: [1], attempts: 0 }
    ]
  });
  return { slug, runId };
}

// ---------------------------------------------------------------- finish = dispatch

test("finish is dispatch: same output and exit code for an open job, a new idea and no words", () => {
  const sb = makeSandbox();
  try {
    seedTask(sb, "demo-job", { display: "Demo job" });
    seedPlan(sb, "demo-job", [{ n: 1, purpose: "Do it", writes: ["out/x.txt"], required_check: { command: "node -e \"process.exit(0)\"" } }]);
    for (const args of [["demo-job"], []]) {
      const d = runBoard(["dispatch", ...args], sb.root);
      const f = runBoard(["finish", ...args], sb.root);
      assert.equal(f.stdout, d.stdout, args.join(" "));
      assert.equal(f.code, d.code, args.join(" "));
    }
    // a new idea through finish is captured exactly as dispatch captures it; then both words
    // land on that same job, the same way
    const text = "build a brand new settings page";
    const made = runBoard(["finish", text], sb.root);
    assert.equal(made.code, 0, made.stdout);
    assert.match(made.stdout, /New job: `build-a-brand-new-settings`/);
    const d = runBoard(["dispatch", text], sb.root);
    const f = runBoard(["finish", text], sb.root);
    assert.equal(f.stdout, d.stdout);
    assert.equal(f.code, d.code);
    assert.match(f.stdout, /Matched job: `build-a-brand-new-settings`/);
    assert.equal(Object.keys(readBoard(sb).tasks).length, 2, "one new job, never a duplicate");
  } finally { sb.teardown(); }
});

// ---------------------------------------------------------------- dispatch picks up a cut-off run

test("dispatch carries a cut-off run on: one line, the disk check, the next step, no new run", () => {
  const sb = makeSandbox();
  try {
    const { slug, runId } = cutOffJob(sb);
    const before = runFolders(sb);
    const r = runBoard(["dispatch", slug], sb.root);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const first = r.stdout.split(/\r?\n/)[0];
    assert.equal(first, `Carrying on the cut-off run \`${runId}\` of \`${slug}\` — 1/2 passes done; no new run.`);
    assert.match(r.stdout, /WHAT THE BOARD SAYS vs WHAT IS ON DISK/, "the same disk check resume does");
    assert.match(r.stdout, /fire: pass 2 — Second half/, "that run's own next step");
    assert.doesNotMatch(r.stdout, /Matched job|Preview only|board\.mjs start/, "never a preview of a fresh run");
    assert.deepEqual(runFolders(sb), before, "no new run folder");
    assert.equal(fs.existsSync(path.join(sb.onegoDir, "ACTIVE")), false, "nothing started");
    assert.equal(Object.keys(readBoard(sb).tasks).length, 1, "no new job");

    // the silent aliases land in the same place
    const f = runBoard(["finish", slug], sb.root);
    assert.equal(f.stdout, r.stdout);
    // a long request naming the job by its first words is carried on too
    const long = runBoard(["dispatch", "half job finish the second half please"], sb.root);
    assert.equal(long.stdout.split(/\r?\n/)[0], first);
  } finally { sb.teardown(); }
});

test("a run that ended (stopped or closed) is not a cut-off run: dispatch previews as before", () => {
  const sb = makeSandbox();
  try {
    const { slug, runId } = cutOffJob(sb);
    const st = JSON.parse(fs.readFileSync(path.join(sb.onegoDir, runId, "state.json"), "utf8"));
    st.ended = "2026-09-27 11:00 — stopped by /one-go stop";
    fs.writeFileSync(path.join(sb.onegoDir, runId, "state.json"), JSON.stringify(st, null, 2));
    const r = runBoard(["dispatch", slug], sb.root);
    assert.doesNotMatch(r.stdout, /Carrying on/);
    assert.match(r.stdout, /Matched job: `half-job`/);
  } finally { sb.teardown(); }
});

test("another job's cut-off run is never picked up by this job", () => {
  const sb = makeSandbox();
  try {
    cutOffJob(sb);
    seedTask(sb, "other-job", { display: "Other job" });
    seedPlan(sb, "other-job", [{ n: 1, purpose: "Other", writes: ["out/o.txt"], required_check: { command: "node -e \"process.exit(0)\"" } }]);
    const r = runBoard(["dispatch", "other-job"], sb.root);
    assert.equal(r.code, 0, r.stdout);
    assert.doesNotMatch(r.stdout, /Carrying on/);
    assert.match(r.stdout, /Matched job: `other-job`/);
  } finally { sb.teardown(); }
});

// ---------------------------------------------------------------- never a duplicate of an open job

test("a long request whose first words spell an open job continues it (slug or title), never <slug>-finish", () => {
  const sb = makeSandbox();
  try {
    seedTask(sb, "one-go-final-clean", { display: "One go final clean" });
    for (const text of ["one-go-final-clean finish the last three passes",
      "one go final clean finish", "One go final clean: carry on with the docs"]) {
      const r = runBoard(["dispatch", text], sb.root);
      assert.match(r.stdout, /Matched job: `one-go-final-clean`/, text);
      assert.doesNotMatch(r.stdout, /New job/, text);
    }
    assert.deepEqual(Object.keys(readBoard(sb).tasks), ["one-go-final-clean"], "no duplicate job");
  } finally { sb.teardown(); }
});

test("first-words rule: open jobs only, two-word names or longer, longest wins, a tie is no answer", () => {
  const tasks = {
    "meals": { display: "Meals", stage: "not_started" },
    "meals-screen": { display: "Meals screen", stage: "not_started" },
    "meals-screen-header": { display: "Header", stage: "not_started" },
    "old-job": { display: "Old job", stage: "done" },
    "orders-page": { display: "Checkout flow", stage: "not_started" },
    "checkout-flow": { display: "Payments", stage: "not_started" }
  };
  assert.equal(openJobByFirstWords(tasks, "meals screen header needs more padding on phones"), "meals-screen-header");
  assert.equal(openJobByFirstWords(tasks, "meals screen totals are wrong on sunday"), "meals-screen");
  assert.equal(openJobByFirstWords(tasks, "meals for the week need a print view"), null, "a one-word name never swallows a request");
  assert.equal(openJobByFirstWords(tasks, "old job needs a second look after the fix"), null, "a finished job is never continued");
  assert.equal(openJobByFirstWords(tasks, "checkout flow breaks when the card is declined"), null, "two jobs spell it — no guess");
  assert.equal(openJobByFirstWords(tasks, "fix the meals screen header"), null, "the job must be the FIRST words");
  assert.equal(lookupForDispatch(tasks, "old job needs a second look after the fix").slug, null);
});

// ---------------------------------------------------------------- only public words in hints

test("no hint in board.mjs or cmd/*.mjs names a non-public word after /one-go", () => {
  const files = [
    ...fs.readdirSync(SCRIPTS).filter(f => /^board.*\.mjs$/.test(f)).map(f => path.join(SCRIPTS, f)),
    ...fs.readdirSync(path.join(SCRIPTS, "cmd")).filter(f => f.endsWith(".mjs")).map(f => path.join(SCRIPTS, "cmd", f))
  ];
  const hits = [];
  for (const file of files) {
    fs.readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      for (const m of line.matchAll(/\/one-go ([a-z][a-z-]*)/g)) {
        if (NOT_PUBLIC.includes(m[1])) hits.push(`${path.relative(SCRIPTS, file)}:${i + 1}: /one-go ${m[1]}`);
      }
    });
  }
  assert.deepEqual(hits, []);
});

test("the bare board (plumbing since D9) still runs, and its footer and rows name only public words", () => {
  const sb = makeSandbox();
  try {
    cutOffJob(sb);
    // a sealed plan more than a day old that never ran
    seedTask(sb, "never-ran", { display: "Never ran" });
    seedPlan(sb, "never-ran", [{ n: 1, purpose: "x", writes: ["out/n.txt"], required_check: { command: "node -e \"process.exit(0)\"" } }]);
    const old = new Date(Date.now() - 3 * 86400000);
    fs.utimesSync(path.join(sb.plansDir, "never-ran.plan.json"), old, old);
    // a job closed with open items
    seedTask(sb, "closed-job", { display: "Closed job", stage: "waiting" });
    seedRun(sb, "2026-09-26-0900-closed-job", {
      slug: "closed-job", started: "2026-09-26 09:00", ended: "2026-09-26 09:30 — finished with 1 open item",
      ending: "FINISHED WITH OPEN ITEMS", open_items: [{ kind: "parked", pass: 1, text: "Q?" }],
      passes: [{ n: 1, title: "x", status: "parked", parked_question: "Q?" }]
    }, { report: true });

    const r = runBoard([], sb.root);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /unfinished/);
    assert.match(r.stdout, /sealed, never launched/);
    assert.match(r.stdout, /Finished — 1 thing needs you — \/one-go dispatch closed-job/);
    const words = [...r.stdout.matchAll(/\/one-go ([a-z][a-z-]*)/g)].map(m => m[1]);
    assert.ok(words.length > 0);
    for (const w of words) assert.ok(!NOT_PUBLIC.includes(w), `the board names "/one-go ${w}"`);
  } finally { sb.teardown(); }
});
