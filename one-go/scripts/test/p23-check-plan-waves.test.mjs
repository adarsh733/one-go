// p23-check-plan-waves.test.mjs — the shape of a plan in waves: `waveShape`, what check-plan prints
// on every OK (the Waves line, the summary, the one-pass-wide warning, the whole-app note), the
// Run shape refusal under the cutoff rule, and the same words in the sealed-plan preview. Sandbox only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeSandbox, runBoard } from "./helpers.mjs";
import { waveShape } from "../cmd/lanes.mjs";
import { RUN_SHAPE_CUTOFF, runShapeRefusal } from "../cmd/check-plan.mjs";

const HEAD = ["| # | What it does | Model | Files it writes | Proven by | Depends on |", "|---|---|---|---|---|---|"];
const SHAPE = ["## Run shape", "- pieces: one pass each", "- needs: see Depends on", "- waves: see below", "- unlocks: none", "- shape line", ""];

function draft(rows, { state = "State: draft", shape = true } = {}) {
  return ["# A job", state, "", ...(shape ? SHAPE : []), "## Passes", ...HEAD, ...rows, "", "## Open questions", "1. **Q?** A ★ x · B y.", ""].join("\n");
}
function row(n, file, deps = "—", check = "npm test") {
  return `| ${n} | Piece ${n} | build | ${file} | ${check} | ${deps} |`;
}
function checkOn(text, name = "wave-job") {
  const sb = makeSandbox();
  try {
    fs.writeFileSync(path.join(sb.plansDir, `${name}.md`), text);
    const r = runBoard(["check-plan", name], sb.root);
    assert.equal(fs.readFileSync(path.join(sb.plansDir, `${name}.md`), "utf8"), text, "check-plan never writes the draft");
    return r;
  } finally { sb.teardown(); }
}

// ---------------------------------------------------------------- waveShape itself

test("waveShape: a wide plan puts the independent passes in one wave", () => {
  const s = waveShape([
    { n: 1, files: ["a.txt"], depends: [] },
    { n: 2, files: ["b.txt"], depends: [] },
    { n: 3, files: ["c.txt"], depends: [] },
    { n: 4, files: ["d.txt"], depends: [1, 2, 3] }
  ]);
  assert.deepEqual(s.waves, [[1, 2, 3], [4]]);
  assert.equal(s.line, "Waves: 1) p1, p2, p3 · 2) p4");
  assert.equal(s.summary, "4 passes in 2 waves");
  assert.equal(s.warning, null);
});

test("waveShape: a line of three with no clash warns, naming each wait", () => {
  const s = waveShape([
    { n: 1, files: ["a.txt"], depends: [] },
    { n: 2, files: ["b.txt"], depends: [1] },
    { n: 3, files: ["c.txt"], depends: [2] }
  ]);
  assert.deepEqual(s.waves, [[1], [2], [3]]);
  assert.equal(s.summary, "3 passes in 3 waves");
  assert.equal(s.warning,
    "warning: every wave is one pass wide. These waits have no file clash — keep each only if the later pass needs the earlier one's output: p2 waits on p1, p3 waits on p2");
});

test("waveShape: a line caused by a real clash gives no warning", () => {
  const s = waveShape([
    { n: 1, files: ["src/home.js"], depends: [] },
    { n: 2, files: ["src/home.js"], depends: [1] },
    { n: 3, files: ["src/home.js"], depends: [2] }
  ]);
  assert.deepEqual(s.waves, [[1], [2], [3]]);
  assert.equal(s.warning, null);
  // and with no declared wait at all, the shared file alone still makes a line
  const bare = waveShape([1, 2, 3].map(n => ({ n, files: ["src/home.js"], depends: [] })));
  assert.deepEqual(bare.waves, [[1], [2], [3]]);
  assert.equal(bare.warning, null);
});

test("waveShape: a two-pass plan is never warned about, and the words are singular when they should be", () => {
  const two = waveShape([{ n: 1, files: ["a.txt"], depends: [] }, { n: 2, files: ["b.txt"], depends: [1] }]);
  assert.deepEqual(two.waves, [[1], [2]]);
  assert.equal(two.warning, null);
  const one = waveShape([{ n: 1, files: ["a.txt"] }]);
  assert.equal(one.summary, "1 pass in 1 wave");
  assert.equal(one.line, "Waves: 1) p1");
});

test("waveShape reads sealed-plan field names too (writes, prerequisites, shared_resources)", () => {
  const s = waveShape([
    { n: 1, writes: ["a.txt"], prerequisites: [] },
    { n: 2, writes: ["b.txt"], prerequisites: [] },
    { n: 3, writes: ["c.txt"], prerequisites: [1], shared_resources: ["port"] },
    { n: 4, writes: ["d.txt"], prerequisites: [1], shared_resources: ["port"] }
  ]);
  assert.deepEqual(s.waves, [[1, 2], [3], [4]]);
});

// ---------------------------------------------------------------- check-plan prints the shape on OK

test("check-plan OK on a wide draft prints the Waves line and the summary, no warning", () => {
  const r = checkOn(draft([
    row(1, "a.txt"), row(2, "b.txt"), row(3, "c.txt"), row(4, "d.txt", "1, 2, 3")
  ]));
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /^check-plan: OK — /);
  assert.match(r.stdout, /^Waves: 1\) p1, p2, p3 · 2\) p4$/m);
  assert.match(r.stdout, /^4 passes in 2 waves$/m);
  assert.doesNotMatch(r.stdout, /warning:/);
});

test("check-plan OK on a line draft warns, and still exits 0", () => {
  const r = checkOn(draft([row(1, "a.txt"), row(2, "b.txt", "1"), row(3, "c.txt", "2")]));
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /^Waves: 1\) p1 · 2\) p2 · 3\) p3$/m);
  assert.match(r.stdout, /^3 passes in 3 waves$/m);
  assert.match(r.stdout, /^warning: every wave is one pass wide\. These waits have no file clash — keep each only if the later pass needs the earlier one's output: p2 waits on p1, p3 waits on p2$/m);
});

test("check-plan OK on a line caused by a real clash does not warn", () => {
  const r = checkOn(draft([row(1, "a.txt"), row(2, "a.txt", "1"), row(3, "a.txt", "2")]));
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /^3 passes in 3 waves$/m);
  assert.doesNotMatch(r.stdout, /warning:/);
});

test("check-plan OK on a two-pass plan: shape shown, no warning", () => {
  const r = checkOn(draft([row(1, "a.txt"), row(2, "b.txt", "1")]));
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /^2 passes in 2 waves$/m);
  assert.doesNotMatch(r.stdout, /warning:/);
});

test("check-plan OK prints the fixed per-pass note for a pass whose check reads the whole app", () => {
  const r = checkOn(draft([row(1, "a.txt"), row(2, "tools/capture.mjs (new)", "—", "node tools/capture.mjs")]));
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /note: pass 2's check reads the whole app \("capture"\), so it runs only when no other pass is still writing\./);
  assert.doesNotMatch(r.stdout, /will run alone/);
});

// ---------------------------------------------------------------- the Run shape refusal

test("a draft with no Run shape is refused; the same draft with one passes", () => {
  const rows = [row(1, "a.txt")];
  const bad = checkOn(draft(rows, { shape: false }));
  assert.equal(bad.code, 1);
  assert.match(bad.stdout, /no `## Run shape` section/);
  assert.equal(checkOn(draft(rows)).code, 0);
});

test("a plan sealed on or after the cutoff with no Run shape is refused; an older sealed plan passes", () => {
  assert.equal(RUN_SHAPE_CUTOFF, "2026-10-03");
  const rows = [row(1, "a.txt")];
  const onCutoff = checkOn(draft(rows, { shape: false, state: "State: sealed 2026-10-03" }));
  assert.equal(onCutoff.code, 1);
  assert.match(onCutoff.stdout, /Run shape/);
  assert.equal(checkOn(draft(rows, { shape: false, state: "State: sealed 2026-11-20" })).code, 1);
  const old = checkOn(draft(rows, { shape: false, state: "State: sealed 2026-10-02" }));
  assert.equal(old.code, 0, old.stdout);
  assert.match(old.stdout, /^1 pass in 1 wave$/m);
  assert.equal(runShapeRefusal(draft(rows, { shape: false, state: "State: sealed 2026-09-01" })), null);
  assert.equal(runShapeRefusal(draft(rows, { shape: true, state: "State: sealed 2026-10-05" })), null);
});

test("the refusal is listed with the other problems, not instead of them", () => {
  const r = checkOn(draft([row(1, "a.txt", "—", "checked by eye")], { shape: false }));
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^check-plan: 2 problems in /);
  assert.match(r.stdout, /not a runnable command/);
  assert.match(r.stdout, /Run shape/);
});

// ---------------------------------------------------------------- the sealed-plan preview

test("the sealed-plan preview prints the same Waves line, summary and warning", () => {
  const sb = makeSandbox();
  try {
    const board = JSON.parse(fs.readFileSync(sb.boardPath, "utf8"));
    board.tasks["line-job"] = { display: "Line job", stage: "not_started", subtasks: [] };
    fs.writeFileSync(sb.boardPath, JSON.stringify(board, null, 2));
    const plan = {
      schema: 1, plan_id: "plan-line-job", plan_revision: 1, task_id: "line-job",
      passes: [
        { n: 1, purpose: "First", writes: ["a.txt"], prerequisites: [] },
        { n: 2, purpose: "Second", writes: ["b.txt"], prerequisites: [1] },
        { n: 3, purpose: "Third", writes: ["c.txt"], prerequisites: [2] }
      ]
    };
    fs.writeFileSync(path.join(sb.plansDir, "line-job.plan.json"), JSON.stringify(plan, null, 2));
    const r = runBoard(["dispatch", "line-job"], sb.root);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /^Waves: 1\) p1 · 2\) p2 · 3\) p3$/m);
    assert.match(r.stdout, /^3 passes in 3 waves$/m);
    assert.match(r.stdout, /^warning: every wave is one pass wide\. .*p2 waits on p1, p3 waits on p2$/m);
  } finally { sb.teardown(); }
});
