// p9-audit.test.mjs — the retired words. The name is kept on purpose: dev/verify/p9-carry-over.mjs
// requires this file to exist. Its old cases (the `audit` command's seven numbers) moved to
// dev/retired/test/p9-audit.test.mjs when `audit` retired with eight other words.
//
// A retired word is never turned into a job and never shows the board: board.mjs prints exactly
// one line — `"<word>" is no longer a command — see /one-go help` — and exits 1. One test per
// word (nine), each proving: one line, exit 1, no job made, board unchanged. Sandbox only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeSandbox, runBoard } from "./helpers.mjs";

const lines = s => s.trim().split(/\r?\n/).filter(Boolean);

/** The words, each with the arguments an old habit would have typed after it. */
const RETIRED = [
  ["add", ["Ship the thing", "--why", "because"]],
  ["sub", ["open-job", "first bit"]],
  ["done", ["open-job"]],
  ["stage", ["open-job", "running"]],
  ["ready", ["open-job"]],
  ["audit", []],
  ["status", []],
  ["watch", ["open-job"]],
  ["guard", []]
];

function seedOpenJob(sb) {
  const board = JSON.parse(fs.readFileSync(sb.boardPath, "utf8"));
  board.tasks["open-job"] = { display: "Open job", stage: "not_started", what: "an open job", subtasks: [] };
  fs.writeFileSync(sb.boardPath, JSON.stringify(board, null, 2));
}

/** Every file under the sandbox's one-go folder, with its bytes — "nothing written" in one value. */
function snapshot(dir) {
  const out = {};
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = fs.readFileSync(p, "utf8");
    }
  };
  walk(dir);
  return out;
}

for (const [word, args] of RETIRED) {
  test(`retired word "${word}": one line, exit 1, no job made, board unchanged`, () => {
    const sb = makeSandbox();
    try {
      seedOpenJob(sb);
      const before = snapshot(sb.onegoDir);
      const r = runBoard([word, ...args], sb.root);
      assert.equal(r.code, 1, r.stdout);
      assert.deepEqual(lines(r.stdout), [`"${word}" is no longer a command — see /one-go help`]);
      assert.equal(r.stderr.trim(), "", "nothing on stderr either");
      assert.doesNotMatch(r.stdout, /\| Task \| Stage \|/, "never the board");
      const after = snapshot(sb.onegoDir);
      assert.deepEqual(after, before, "nothing under .claude/one-go was written");
      assert.deepEqual(Object.keys(JSON.parse(after["board.json"]).tasks), ["open-job"], "no job was made");
      // Any case: the router lowercases the first word, so a shouted old habit is retired too.
      const loud = runBoard([word.toUpperCase()], sb.root);
      assert.equal(loud.code, 1);
      assert.deepEqual(lines(loud.stdout), [`"${word}" is no longer a command — see /one-go help`]);
    } finally { sb.teardown(); }
  });
}
