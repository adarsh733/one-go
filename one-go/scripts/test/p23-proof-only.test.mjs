// p23-proof-only.test.mjs — item C (obs 0053, 0070, 0132): only the PROOF step of a whole-app
// pass runs alone; the building never waits on the tag.
//   - one shared word list (lib/plan.mjs WHOLE_TREE_CHECK_WORDS), read from the check command only;
//   - `capture-tree` / `whole-tree` are PROOF_ONLY_TAGS — passesConflict ignores them;
//   - a new status `built` (finished writing) keeps the slot but does not hold a whole-app check;
//   - so two whole-app passes build side by side, neither check runs while a writer is live,
//     and once both are built neither waits on the other.
// Sandbox only for the board calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeSandbox, runBoard } from "./helpers.mjs";
import { WHOLE_TREE_CHECK_WORDS, wholeTreeCheckWord } from "../lib/plan.mjs";
import { PROOF_ONLY_TAGS, passesConflict, selectParallelBatch } from "../lib/overlap.mjs";
import { isWholeTreePass, wholeTreeConflict } from "../lib/evidence.mjs";
import { KNOWN_STATUSES, isRunningStatus, isLiveStatus, isBuiltStatus, isWritingStatus } from "../lib/status.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SLUG = "proof-job";
const OK = "node -e \"process.exit(0)\"";

function capPass(n, status, extra = {}) {
  return { n, title: `Screen ${n}`, status, files: [`screens/s${n}.html`], attempts: status === "pending" ? 0 : 1,
    shared: ["capture-tree"], required_check: { command: OK }, ...extra };
}
function seedRun(sb, passes) {
  const runId = "2026-10-03-0000-" + SLUG;
  const runDir = path.join(sb.onegoDir, runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "state.json"), JSON.stringify({
    schema: 3, run_id: runId, slug: SLUG, host: "claude", parallel_limit: 3,
    started: "2026-10-03 00:00", heartbeat: "2026-10-03 00:00", passes
  }, null, 2));
  fs.writeFileSync(path.join(runDir, "heartbeat.txt"), "2026-10-03 00:00\n");
  for (const p of passes) for (const f of p.files || []) {
    fs.mkdirSync(path.dirname(path.join(sb.root, f)), { recursive: true });
    fs.writeFileSync(path.join(sb.root, f), `<p>${p.n}</p>\n`);
  }
  const b = JSON.parse(fs.readFileSync(sb.boardPath, "utf8"));
  b.tasks[SLUG] = { display: "Proof job", stage: "running", run_id: runId };
  fs.writeFileSync(sb.boardPath, JSON.stringify(b, null, 2));
  return path.join(runDir, "state.json");
}
const readState = p => JSON.parse(fs.readFileSync(p, "utf8"));
const verify = (sb, n) => runBoard(["pass", SLUG, String(n), "done", "--proven", "checked", "--verify", OK], sb.root);

// ---------------------------------------------------------------- one shared word list

test("one shared list, read from the check command only", () => {
  assert.deepEqual(WHOLE_TREE_CHECK_WORDS, ["capture", "screenshot", "shoot", "review-page", "journey", "playwright", "cypress", "e2e"]);
  assert.equal(wholeTreeCheckWord("npx playwright test"), "playwright");
  assert.equal(wholeTreeCheckWord("npm run test:e2e"), "e2e");
  assert.equal(wholeTreeCheckWord("node scripts/capture-screens.mjs home"), "capture");
  assert.equal(wholeTreeCheckWord("node --test test/x.test.mjs"), null);
  // A description word never counts.
  assert.equal(isWholeTreePass({ n: 1, title: "Screenshot the journey", proven_by: "node --test" }), false);
  assert.equal(isWholeTreePass({ n: 1, title: "Tidy", proven_by: "node scripts/journey.mjs" }), true);
});

test("lib/evidence.mjs keeps no word list of its own — it imports the shared one", () => {
  const src = fs.readFileSync(path.join(HERE, "..", "lib", "evidence.mjs"), "utf8");
  assert.match(src, /import \{ wholeTreeCheckWord \} from "\.\/plan\.mjs"/);
  assert.doesNotMatch(src, /capture\|screenshot/);
});

// ---------------------------------------------------------------- the tag never holds the building

test("PROOF_ONLY_TAGS: two tagged passes with disjoint files do not clash; a real shared resource still does", () => {
  assert.ok(PROOF_ONLY_TAGS.has("capture-tree") && PROOF_ONLY_TAGS.has("whole-tree"));
  const a = { n: 1, files: ["screens/home.html"], shared: ["capture-tree"] };
  const b = { n: 2, files: ["screens/settings.html"], shared: ["whole-tree", "capture-tree"] };
  assert.equal(passesConflict(a, b), null);
  assert.match(passesConflict({ ...a, shared: ["capture-tree", "port-3000"] }, { ...b, shared: ["port-3000"] }), /port-3000/);
  assert.match(passesConflict(a, { ...b, files: ["screens/home.html"] }), /both write/);
});

test("two whole-app passes are released side by side, and a built one keeps its slot", () => {
  const ready = [capPass(1, "pending"), capPass(2, "pending")];
  assert.deepEqual(selectParallelBatch(ready, 3).chosen.map(p => p.n), [1, 2]);
  // Beside a running whole-app pass too.
  assert.deepEqual(selectParallelBatch([capPass(2, "pending")], 3, [capPass(1, "running")]).chosen.map(p => p.n), [2]);
  // `built` is a known status, counts as running for scheduling, but is not "still writing".
  assert.ok(KNOWN_STATUSES.includes("built"));
  assert.ok(isRunningStatus("built") && isLiveStatus("built") && isBuiltStatus("built"));
  assert.equal(isWritingStatus("built"), false);
  assert.equal(isWritingStatus("running"), true);
});

// ---------------------------------------------------------------- through the real door: board.mjs pass

test("neither check runs while a writer is live, and once both are built they never wait on each other", () => {
  const sb = makeSandbox();
  try {
    const statePath = seedRun(sb, [capPass(1, "running"), capPass(2, "running")]);

    // Both still writing: each whole-app check is refused, and told to mark itself built.
    for (const n of [1, 2]) {
      const r = verify(sb, n);
      assert.equal(r.code, 1, r.stdout);
      assert.match(r.stdout, /REFUSED: pass \d's check runs over the whole tree/);
      assert.match(r.stdout, new RegExp(`board\\.mjs pass ${SLUG} ${n} built`));
    }
    assert.deepEqual(readState(statePath).passes.map(p => p.status), ["running", "running"]);

    // Pass 1 finishes writing. Pass 2 is still writing → pass 1's check still waits.
    const b1 = runBoard(["pass", SLUG, "1", "built"], sb.root);
    assert.equal(b1.code, 0, b1.stdout);
    assert.equal(readState(statePath).passes[0].status, "built");
    const held = verify(sb, 1);
    assert.equal(held.code, 1);
    assert.match(held.stdout, /pass 2 is still running/);
    assert.doesNotMatch(held.stdout, /Running the check/);

    // Pass 2 finishes writing too. Now neither waits on the other: both checks run and pass.
    assert.equal(runBoard(["pass", SLUG, "2", "built"], sb.root).code, 0);
    const v1 = verify(sb, 1);
    assert.equal(v1.code, 0, v1.stdout);
    assert.match(v1.stdout, /check PASSED/);
    const v2 = verify(sb, 2);
    assert.equal(v2.code, 0, v2.stdout);
    assert.match(v2.stdout, /check PASSED/);
    assert.deepEqual(readState(statePath).passes.map(p => p.status), ["done", "done"]);
  } finally { sb.teardown(); }
});

test("a built whole-app pass is still held by an ORDINARY pass that is writing", () => {
  const s = { passes: [capPass(1, "built"), { n: 2, title: "Docs", status: "running", files: ["docs/a.md"] }] };
  assert.deepEqual(wholeTreeConflict(s, 1).running, [2]);
  s.passes[1].status = "built";
  assert.equal(wholeTreeConflict(s, 1), null);
});
