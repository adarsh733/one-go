// p4-dispatch.test.mjs — `/one-go <anything>`: new work never lands on a finished job (obs 0104),
// answers are refused, a weak hit is a new job said in one line, and `--seal` writes a
// self-contained reading brief. Sandbox only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeSandbox, runBoard } from "./helpers.mjs";
import { isAnswerShaped, lookupForDispatch, freshSlug } from "../cmd/dispatch.mjs";

function readBoard(sb) { return JSON.parse(fs.readFileSync(sb.boardPath, "utf8")); }
function seedTasks(sb, tasks) {
  const board = readBoard(sb);
  Object.assign(board.tasks, tasks);
  fs.writeFileSync(sb.boardPath, JSON.stringify(board, null, 2));
}
function seedSealedPlan(sb, slug, passes) {
  const plan = { schema: 1, plan_id: `plan-${slug}`, plan_revision: 1, task_id: slug, passes };
  fs.writeFileSync(path.join(sb.plansDir, `${slug}.plan.json`), JSON.stringify(plan, null, 2));
}
const lines = s => s.trim().split(/\r?\n/).filter(Boolean);
// The public package's deny list, when this runs inside the staging build (never shipped).
function denyWords() {
  const file = process.env.ONEGO_STAGING && path.join(process.env.ONEGO_STAGING, "public-src", "leak-words.txt");
  let text = "";
  try { text = file ? fs.readFileSync(file, "utf8") : ""; } catch { /* not in staging */ }
  return text.split(/\r?\n/).map(x => x.trim()).filter(x => x && !x.startsWith("#"));
}

// ------------------------------------------------------------------ answer-shaped text

test("isAnswerShaped: replies to a question block are answers", () => {
  for (const t of ["use your recommendations", "Use your recommendations.", "use all your recommendations",
    "go with your recommendation", "approved", "Approved all of the above", "approved-all-of-the-above",
    "approve all", "go ahead", "go-ahead-with-stage-2", "Go ahead with stage 2", "yes", "No", "ok", "okay sure",
    "yes please", "1A 2B 3A", "1a, 2c", "sounds good", "lgtm", "recommendations"]) {
    assert.equal(isAnswerShaped(t), true, t);
  }
});

test("isAnswerShaped: real work is not an answer", () => {
  for (const t of ["fix the login", "make the search box handle two words", "approve button on the meals screen",
    "add a yes/no toggle to settings", "go to the meals screen and fix the header", "stop the flicker",
    "use the new colour tokens on the orders page", "yesterday's crash on the orders page", "3d preview for meals",
    "one-go-public-cleanup turn one-go into a public skill"]) {
    assert.equal(isAnswerShaped(t), false, t);
  }
});

test("dispatch refuses answer-shaped text in one line and writes nothing", () => {
  const sb = makeSandbox();
  try {
    const before = fs.readFileSync(sb.boardPath, "utf8");
    for (const t of ["use your recommendations", "approved-all-of-the-above", "go ahead with stage 2", "yes"]) {
      const r = runBoard(["dispatch", t], sb.root);
      assert.equal(r.code, 1, t);
      assert.equal(lines(r.stdout).length, 1, t);
      assert.match(r.stdout, /reads like an answer, not a job/);
      const s = runBoard(["dispatch", t, "--seal"], sb.root);
      assert.equal(s.code, 1, `${t} --seal`);
    }
    assert.equal(fs.readFileSync(sb.boardPath, "utf8"), before);
    assert.deepEqual(fs.readdirSync(sb.plansDir), []);
  } finally { sb.teardown(); }
});

// ------------------------------------------------------------------ never onto a finished job

test("obs 0104: a fresh request whose words start with a finished job's name is a NEW job", () => {
  const sb = makeSandbox();
  try {
    seedTasks(sb, { "one-go": { display: "One go", stage: "done", what: "the old job" } });
    const before = JSON.stringify(readBoard(sb).tasks["one-go"]);
    const r = runBoard(["dispatch", "one-go-public-cleanup turn one-go into a public skill"], sb.root);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /New job: `one-go-public-cleanup-turn`/);
    assert.doesNotMatch(r.stdout, /Matched job/);
    const after = readBoard(sb);
    assert.equal(JSON.stringify(after.tasks["one-go"]), before, "the finished job is untouched");
    assert.equal(after.tasks["one-go-public-cleanup-turn"].what, "one-go-public-cleanup turn one-go into a public skill");
  } finally { sb.teardown(); }
});

test("text naming a finished job exactly makes a new job and says so in one line", () => {
  const sb = makeSandbox();
  try {
    seedTasks(sb, {
      "one-go": { display: "One go", stage: "done" },
      "one-go-extras": { display: "extras", stage: "not_started" }
    });
    fs.writeFileSync(path.join(sb.plansDir, "one-go.md"), "# One go\nState: sealed 2026-01-01\n");
    const r = runBoard(["dispatch", "one-go"], sb.root);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /`one-go` is already finished, so this is a new job/);
    assert.match(r.stdout, /New job: `one-go-2`/);
    assert.doesNotMatch(r.stdout, /one-go-extras/, "never steered onto a loosely similar job either");
  } finally { sb.teardown(); }
});

test("an absorbed job is treated as finished too", () => {
  const sb = makeSandbox();
  try {
    seedTasks(sb, { "meal-plan": { display: "Meal plan", stage: "not_started", absorbed_by: "other" } });
    const r = runBoard(["dispatch", "meal-plan"], sb.root);
    assert.match(r.stdout, /already finished/);
    assert.match(r.stdout, /New job: `meal-plan-2`/);
  } finally { sb.teardown(); }
});

test("a weak (loose) hit on an open job is a new job, and the loose hit is named in one line", () => {
  const sb = makeSandbox();
  try {
    seedTasks(sb, { "meals-screen": { display: "Meals screen", stage: "not_started" } });
    const r = runBoard(["dispatch", "fix the meals-screen header colour on small phones"], sb.root);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Only a loose match for `meals-screen`, so this is a new job \(to continue that one: \/one-go dispatch meals-screen\)/);
    assert.match(r.stdout, /New job: `fix-the-meals-screen-header`/);
  } finally { sb.teardown(); }
});

test("the same long words dispatched twice land on the job the first call made (no duplicate)", () => {
  const sb = makeSandbox();
  try {
    const text = "build a weekly shopping list from the saved meals and share it";
    const a = runBoard(["dispatch", text], sb.root);
    assert.match(a.stdout, /New job: `build-a-weekly-shopping-list`/);
    const b = runBoard(["dispatch", text], sb.root);
    assert.match(b.stdout, /Matched job: `build-a-weekly-shopping-list`/);
    assert.equal(Object.keys(readBoard(sb).tasks).length, 1);
  } finally { sb.teardown(); }
});

test("lookupForDispatch / freshSlug never return a closed job's slug", () => {
  const sb = makeSandbox();
  try {
    const tasks = { "one-go": { stage: "done" }, "one-go-2": { stage: "done" } };
    assert.equal(lookupForDispatch(tasks, "one-go").slug, null);
    assert.equal(freshSlug(tasks, "one go", sb.plansDir), "one-go-3");
  } finally { sb.teardown(); }
});

// ------------------------------------------------------------------ open job preview

test("an open job with a sealed plan previews its passes and the conductor's next commands", () => {
  const sb = makeSandbox();
  try {
    seedTasks(sb, { "test-job": { display: "Test Job", stage: "not_started", subtasks: [] } });
    seedSealedPlan(sb, "test-job", [
      { n: 1, purpose: "Do the first thing", writes: ["a.txt"], prerequisites: [] },
      { n: 2, purpose: "Do the second thing", writes: ["b.txt"], prerequisites: [] },
      { n: 3, purpose: "Then this", writes: ["c.txt"], prerequisites: [1] }
    ]);
    const r = runBoard(["dispatch", "test-job"], sb.root);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /Matched job: `test-job`/);
    assert.match(r.stdout, /board\.mjs brief "test-job" 1 --out/);
    assert.match(r.stdout, /board\.mjs brief "test-job" 2 --out/);
    assert.doesNotMatch(r.stdout, /board\.mjs brief "test-job" 3 --out/);
    assert.match(r.stdout, /Agent\(one-go-worker, model \w+\): Read <path>\. Do exactly that\. Report back in the 12-line format it specifies\./);
    assert.match(r.stdout, /the brief is never pasted into this chat/);
    assert.doesNotMatch(r.stdout, /WORKER BRIEF/);
  } finally { sb.teardown(); }
});

test("an open job with only a draft shows the draft and never restarts the reading", () => {
  const sb = makeSandbox();
  try {
    seedTasks(sb, { "draft-job": { display: "Draft job", stage: "not_started" } });
    fs.writeFileSync(path.join(sb.plansDir, "draft-job.md"), [
      "# Draft job", "State: draft", "", "## What I read before asking", "| File | Why it mattered |", "|---|---|",
      "| src/a.js | the thing |", "", "## Open questions", "1. **Q?** A ★ x · B y.", ""
    ].join("\n"));
    const r = runBoard(["dispatch", "draft-job"], sb.root);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /DO NOT RE-READ/);
    assert.match(r.stdout, /src\/a\.js/);
    assert.match(r.stdout, /check-plan draft-job/);
    assert.match(r.stdout, /## Answers/);
  } finally { sb.teardown(); }
});

// ------------------------------------------------------------------ --seal: the self-contained brief

test("--seal prints only the path and the brief is self-contained", () => {
  const sb = makeSandbox();
  try {
    const text = "build the widget in scripts/widget.mjs and its test scripts/test/widget.test.mjs";
    const r = runBoard(["dispatch", text, "--seal"], sb.root);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(lines(r.stdout).length, 1, "stdout is the path only");
    const p = r.stdout.trim();
    assert.ok(p.endsWith(".seal-brief.md") && fs.existsSync(p));
    assert.equal(path.dirname(p), sb.plansDir);
    const b = fs.readFileSync(p, "utf8");

    // the job text and the files it names
    assert.match(b, /pass 0 \(reading\)/);
    assert.match(b, /## Job \(free text\)\n.*build the widget/);
    assert.match(b, /- `scripts\/widget\.mjs`/);
    assert.match(b, /- `scripts\/test\/widget\.test\.mjs`/);
    assert.match(b, /Append each file to `## What I read before asking`/);
    // where the plan goes
    assert.ok(b.includes(path.join(sb.plansDir, "build-the-widget-in-scripts.md").split(path.sep).join("/")));
    // the plan template with one filled example row
    assert.match(b, /State: draft/);
    assert.match(b, /\| # \| What it does \| Model \| Files it writes \| Proven by \| Depends on \|/);
    assert.match(b, /\| 1 \| .+ \| build \| .+ \| npm test -- query \| — \|/);
    assert.match(b, /## Fixed names/);
    assert.match(b, /## Answers/);
    // the nine gatherables
    const nine = b.split("## What the reading must gather")[1].split("\n## ")[0];
    for (let i = 1; i <= 9; i++) assert.match(nine, new RegExp(`^\\| ${i} \\| `, "m"), `gatherable ${i}`);
    assert.doesNotMatch(nine, /^\| 10 \| /m);
    // the question format
    assert.match(b, /not an engineer/);
    assert.match(b, /\*\*A \/ B \/ C\*\*/);
    assert.match(b, /Exactly one ★/);
    assert.match(b, /use your recommendations/);
    // the seal-gate rules, the dry-run rule, and check-plan until it passes
    assert.match(b, /Proven by" must be a command/);
    assert.match(b, /Dry-run every "Proven by" command/);
    assert.match(b, /exit code/);
    assert.match(b, /escaped|\\\|/);
    assert.match(b, /board\.mjs" check-plan build-the-widget-in-scripts/);
    assert.match(b, /until it prints OK/);
    // models, rules, report
    assert.match(b, /^\| think \| .+ \| `think` \|/m);
    assert.doesNotMatch(b, /Opus|Sonnet|Haiku/);
    assert.match(b, /PARKED/);
    assert.match(b, /Protocols run:/);
    // no house → no house sections; generic words only
    assert.doesNotMatch(b, /House rules/);
    const words = b.replace(/(?:[A-Za-z]:)?[\/][^\s`"]*/g, "").toLowerCase();   // local paths are not words
    for (const w of denyWords()) assert.ok(!words.includes(w.toLowerCase()), `brief leaks "${w}"`);
    // the job is on the board, so check-plan and next can find it
    assert.ok(readBoard(sb).tasks["build-the-widget-in-scripts"]);
  } finally { sb.teardown(); }
});

test("--seal carries the house conductor section, register command and always-allowed paths", () => {
  const sb = makeSandbox();
  try {
    fs.writeFileSync(path.join(sb.onegoDir, "house-rules.md"), [
      "# House rules", "", "## For the conductor", "Screens follow THE ROUTE; an unfreeze stays in one pass.", "",
      "## For every worker", "Run the observer protocol.", ""
    ].join("\n"));
    fs.writeFileSync(path.join(sb.onegoDir, "config.json"), JSON.stringify({
      register_command: "node scripts/register-add.mjs",
      worker_always_allowed: [".claude/observations/**"]
    }));
    const r = runBoard(["dispatch", "redo the settings page copy", "--seal"], sb.root);
    assert.equal(r.code, 0, r.stdout);
    const b = fs.readFileSync(r.stdout.trim(), "utf8");
    assert.match(b, /## House rules — for the conductor/);
    assert.match(b, /Screens follow THE ROUTE; an unfreeze stays in one pass\./);
    assert.doesNotMatch(b, /Run the observer protocol/, "the worker section is not the conductor's");
    assert.match(b, /node scripts\/register-add\.mjs <path> --why "<why>"/);
    assert.match(b, /`\.claude\/observations\/\*\*`/);
  } finally { sb.teardown(); }
});

test("--seal on a finished job's name never writes beside that job's plan", () => {
  const sb = makeSandbox();
  try {
    seedTasks(sb, { "one-go": { display: "One go", stage: "done" } });
    fs.writeFileSync(path.join(sb.plansDir, "one-go.md"), "# One go\nState: sealed 2026-01-01\n");
    const r = runBoard(["dispatch", "one-go", "--seal"], sb.root);
    assert.equal(r.code, 0);
    assert.equal(lines(r.stdout).length, 1);
    assert.equal(path.basename(r.stdout.trim()), "one-go-2.seal-brief.md");
    assert.match(r.stderr, /already finished/);
    assert.ok(!fs.existsSync(path.join(sb.plansDir, "one-go.seal-brief.md")));
  } finally { sb.teardown(); }
});

test("--seal on an open job with a draft says to continue it, not restart", () => {
  const sb = makeSandbox();
  try {
    seedTasks(sb, { "draft-job": { display: "Draft job", stage: "not_started" } });
    fs.writeFileSync(path.join(sb.plansDir, "draft-job.md"), "# Draft job\nState: draft\n");
    const r = runBoard(["dispatch", "draft-job", "--seal"], sb.root);
    assert.equal(path.basename(r.stdout.trim()), "draft-job.seal-brief.md");
    assert.match(fs.readFileSync(r.stdout.trim(), "utf8"), /ALREADY on disk\. Continue it/);
  } finally { sb.teardown(); }
});
