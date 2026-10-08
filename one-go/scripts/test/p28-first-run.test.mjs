// p28-first-run.test.mjs — a stranger's very first job, following the engine's own printed
// commands literally (dispatch "<sentence>", then dispatch "<job name>" --seal).
//   obs 0236: the reading brief must carry the person's sentence, not just the job name.
//   obs 0233: the seal brief is never a job row — neither a new one nor one an older engine saved.
//   a new job's name never ends on a joining word ("…-function-to").
//   a check's output over Node's 1 MB default never turns a pass into a fail.
// Sandbox only (helpers.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { makeSandbox, runBoard } from "./helpers.mjs";
import { freshSlug } from "../cmd/dispatch.mjs";
import { runCheck } from "../lib/evidence.mjs";

const readBoard = sb => JSON.parse(fs.readFileSync(sb.boardPath, "utf8"));
const SENTENCE = "add a greeting function to index.js with a test";

test("obs 0236: --seal called with the job name still hands the reader the person's sentence", () => {
  const sb = makeSandbox();
  try {
    const made = runBoard(["dispatch", SENTENCE], sb.root);
    assert.equal(made.code, 0, made.stdout + made.stderr);
    const slug = /New job: `([^`]+)`/.exec(made.stdout)[1];
    // The engine's own next instruction names the job, not the sentence.
    assert.match(made.stdout, new RegExp(`dispatch "${slug}" --seal`));
    const sealed = runBoard(["dispatch", slug, "--seal"], sb.root);
    assert.equal(sealed.code, 0, sealed.stdout + sealed.stderr);
    const brief = fs.readFileSync(sealed.stdout.trim(), "utf8");
    const job = brief.split("## Job (free text)")[1].split("## Files it names")[0];
    assert.match(job, /add a greeting function to index\.js with a test/);
    assert.match(brief, /## Files it names\s*\n- `?index\.js/);
  } finally { sb.teardown(); }
});

test("obs 0233: the seal brief never shows as a job, and rows an older engine saved are hidden without a write", () => {
  const sb = makeSandbox();
  try {
    const made = runBoard(["dispatch", SENTENCE], sb.root);
    const slug = /New job: `([^`]+)`/.exec(made.stdout)[1];
    runBoard(["dispatch", slug, "--seal"], sb.root);
    // An older engine saved a ghost row for an earlier seal brief.
    const b = readBoard(sb);
    b.tasks["old-job.seal-brief"] = { display: "old-job.seal-brief", source: "plan", subtasks: [], stage: "not_started" };
    fs.writeFileSync(sb.boardPath, JSON.stringify(b, null, 2));
    const before = fs.readFileSync(sb.boardPath, "utf8");
    const board = runBoard([], sb.root);
    assert.equal(board.code, 0, board.stdout + board.stderr);
    assert.doesNotMatch(board.stdout, /seal-brief/);
    assert.match(board.stdout, /Add a greeting function to index\.js with a test/);
    assert.equal((board.stdout.match(/^\| \*\*/gm) || []).length, 1, "exactly one job row");
    assert.equal(fs.readFileSync(sb.boardPath, "utf8"), before, "looking never changes the board");
  } finally { sb.teardown(); }
});

test("a new job's name never ends on a joining word", () => {
  const sb = makeSandbox();
  try {
    assert.equal(freshSlug({}, SENTENCE, sb.plansDir), "add-a-greeting-function");
    assert.equal(freshSlug({}, "fix the bug in the", sb.plansDir), "fix-the-bug");
    assert.equal(freshSlug({}, "build a weekly shopping list", sb.plansDir), "build-a-weekly-shopping-list");
    assert.equal(freshSlug({}, "to the", sb.plansDir), "to-the");
  } finally { sb.teardown(); }
});

test("a passing check that prints more than 1 MB is still recorded as passing", () => {
  const sb = makeSandbox();
  try {
    const cmd = `"${process.execPath}" -e "process.stdout.write('x'.repeat(3 * 1024 * 1024))"`;
    const r = runCheck({ root: sb.root, command: cmd, runId: "r", passN: 1, attempt: 1 });
    assert.equal(r.exit_code, 0, r.output_tail.slice(0, 200));
    assert.equal(r.output_bytes, 3 * 1024 * 1024);
  } finally { sb.teardown(); }
});
