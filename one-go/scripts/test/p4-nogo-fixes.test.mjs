// p4-nogo-fixes.test.mjs — pass 10 NO-GO, D7 (dev/FIXES-AFTER-P10.md): `/one-go abort` and
// `/one-go cancel` are aliases of `stop` (the old skill named them as ending words, and the hook
// still treats them as "off"), and dispatch never turns an ending word into a job. Sandbox only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { makeSandbox, runBoard } from "./helpers.mjs";
import { COMMANDS, routeWord } from "../board.mjs";
import { isAnswerShaped } from "../cmd/dispatch.mjs";

const taskCount = sb => Object.keys(JSON.parse(fs.readFileSync(sb.boardPath, "utf8")).tasks).length;

test("D7: abort and cancel route to stop's own file and function", () => {
  for (const w of ["abort", "cancel", "ABORT"]) {
    const { entry } = routeWord(w);
    assert.ok(entry, `${w} must be a known command`);
    assert.equal(entry.file, COMMANDS.stop.file);
    assert.equal(entry.fn, COMMANDS.stop.fn);
  }
});

test("D7: /one-go abort and /one-go cancel print exactly what stop prints and create no job", () => {
  const sb = makeSandbox();
  try {
    const before = taskCount(sb);
    const stop = runBoard(["stop"], sb.root);
    for (const w of ["abort", "cancel"]) {
      const r = runBoard([w], sb.root);
      assert.doesNotMatch(r.stdout, /^not a command/m, `${w} must never fall through as unknown`);
      assert.equal(r.stdout, stop.stdout, `${w} = stop`);
      assert.equal(r.code, stop.code);
    }
    assert.equal(taskCount(sb), before, "no job was created");
  } finally { sb.teardown(); }
});

test("D7: dispatch refuses the ending words and writes nothing; 'stop the flicker …' is still a job", () => {
  for (const w of ["done", "abort", "stop", "cancel", "Abort!", "stop it", "cancel now"]) {
    assert.equal(isAnswerShaped(w), true, `"${w}" is an ending word, not a job`);
  }
  assert.equal(isAnswerShaped("stop the flicker on the orders page"), false);
  assert.equal(isAnswerShaped("cancel button does nothing on checkout"), false);

  const sb = makeSandbox();
  try {
    const before = fs.readFileSync(sb.boardPath, "utf8");
    for (const w of ["abort", "cancel"]) {
      const r = runBoard(["dispatch", w], sb.root);
      assert.equal(r.code, 1, r.stdout);
      assert.match(r.stdout, /\/one-go stop/);
    }
    assert.equal(fs.readFileSync(sb.boardPath, "utf8"), before, "board.json untouched — no junk job");
  } finally { sb.teardown(); }
});
