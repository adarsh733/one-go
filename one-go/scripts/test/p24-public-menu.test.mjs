// p24-public-menu.test.mjs — D9 (obs 0124): the public menu is dispatch, stop, help. The bare
// board is plumbing: it still runs quietly, but no cheat sheet or SKILL.md row advertises it.
// Also: the worker agent's "never search from a root" rule is in both copies, kept identical (obs 0129).
// Sandbox only (helpers.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeSandbox, runBoard } from "./helpers.mjs";
import { COMMANDS, WORD_LISTS, routeWord } from "../board.mjs";
import { PUBLIC, problemsIn, checkSkill } from "../check-help-rows.mjs";

const SKILL = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = rel => fs.readFileSync(path.join(SKILL, rel), "utf8");

test("the public menu is exactly dispatch, stop, update, help; the bare board is plumbing", () => {
  assert.deepEqual([...WORD_LISTS.public].sort(), ["dispatch", "help", "stop", "update"]);
  assert.ok(WORD_LISTS.plumbing.includes(""), "the bare board sits in plumbing");
  assert.ok(!WORD_LISTS.public.includes(""));
  const all = Object.values(WORD_LISTS).flat();
  assert.equal(new Set(all).size, all.length, "no word is in two lists");
  assert.ok(COMMANDS[""], "the bare board is still a working command");
  assert.deepEqual([...PUBLIC].sort(), ["dispatch", "help", "stop", "update"]);
});

test("the bare board and --all keep working, quietly", () => {
  const sb = makeSandbox();
  try {
    for (const args of [[], ["--all"]]) {
      const r = runBoard(args, sb.root);
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.ok(r.stdout.trim().length > 0, "it prints the board");
    }
    assert.equal(routeWord("").entry, COMMANDS[""]);
  } finally { sb.teardown(); }
});

test("SKILL.md and reference/HELP.md list the four public commands once and no bare /one-go row", () => {
  const r = checkSkill(SKILL);
  assert.deepEqual(r.problems, []);
  assert.equal(r.code, 0);
  for (const f of ["SKILL.md", "reference/HELP.md"]) {
    assert.doesNotMatch(read(f), /^\|\s*`\/one-go(\s+--all)?`/m, `${f} advertises the bare board`);
  }
});

test("check-help-rows flags a bare /one-go row as not public, and a missing public row", () => {
  const withBoard = "| `/one-go` | board |\n| `/one-go dispatch <x>` | a |\n| `/one-go stop` | b |\n| `/one-go update` | u |\n| `/one-go help` | c |\n";
  assert.match(problemsIn("T", withBoard).join("\n"), /advertises `\/one-go`/);
  const noStop = "| `/one-go dispatch <x>` | a |\n| `/one-go update` | u |\n| `/one-go help` | c |\n";
  assert.match(problemsIn("T", noStop).join("\n"), /\/one-go stop.*0 command rows/);
  const ok = "| `/one-go dispatch <x>` | a |\n| `/one-go stop` | b |\n| `/one-go update` | u |\n| `/one-go help` | c |\n";
  assert.deepEqual(problemsIn("T", ok), []);
});

test("both copies of the worker agent are identical and forbid searching from a root", () => {
  const live = fs.readFileSync(path.join(SKILL, "agents", "one-go-worker.md"), "utf8");
  assert.match(live, /Never search from `\/` or a drive root/);
  assert.match(live, /name a folder/);
  assert.match(live, /timeout/);
  const installed = path.join(process.env.USERPROFILE || process.env.HOME || "", ".claude", "agents", "one-go-worker.md");
  if (fs.existsSync(installed)) assert.equal(fs.readFileSync(installed, "utf8"), live, "the two copies drifted");
});
