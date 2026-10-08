// p4-router.test.mjs — the front door (board.mjs): the command table (four public words, silent
// aliases, plumbing, retired words — each in exactly one list), the unknown-word line, the
// "command word wins, with a one-line hint" rule (Q7=A) and help. Sandbox only (ONEGO_ROOT).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeSandbox, runBoard } from "./helpers.mjs";
import { COMMANDS, RETIRED, WORD_LISTS, routeWord } from "../board.mjs";

const HELP_MD = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "reference", "HELP.md");

function seedTasks(sb, tasks) {
  const board = JSON.parse(fs.readFileSync(sb.boardPath, "utf8"));
  Object.assign(board.tasks, tasks);
  fs.writeFileSync(sb.boardPath, JSON.stringify(board, null, 2));
}

const lines = s => s.trim().split(/\r?\n/).filter(Boolean);

test("an unknown first word prints exactly one line, exits 1, and never shows the board", () => {
  const sb = makeSandbox();
  try {
    const before = fs.readFileSync(sb.boardPath, "utf8");
    const r = runBoard(["frobnicate", "the", "meals", "screen"], sb.root);
    assert.equal(r.code, 1);
    assert.deepEqual(lines(r.stdout), ['not a command — to start this as a job, the agent runs dispatch "frobnicate the meals screen"']);
    assert.equal(fs.readFileSync(sb.boardPath, "utf8"), before, "nothing written");
  } finally { sb.teardown(); }
});

test("an unknown flag in first place is treated the same way (one line, exit 1)", () => {
  const sb = makeSandbox();
  try {
    const r = runBoard(["--bogus"], sb.root);
    assert.equal(r.code, 1);
    assert.equal(lines(r.stdout).length, 1);
    assert.match(r.stdout, /^not a command/);
  } finally { sb.teardown(); }
});

test("help, --help and -h print reference/HELP.md exactly and exit 0", () => {
  // Verbatim, minus <!-- … --> notes meant for the agent only.
  const want = fs.readFileSync(HELP_MD, "utf8").replace(/<!--[\s\S]*?-->\s*/g, "").trim();
  assert.ok(!/<!--|For the agent: print this file/.test(want), "the agent's note must not reach the person");
  const sb = makeSandbox();
  try {
    for (const w of ["help", "--help", "-h", "HELP"]) {
      const r = runBoard([w], sb.root);
      assert.equal(r.code, 0, w);
      assert.equal(r.stdout.trim(), want, `${w} must print HELP.md verbatim`);
    }
  } finally { sb.teardown(); }
});

test("help works with no board at all (reads nothing else)", () => {
  const sb = makeSandbox();
  try {
    fs.writeFileSync(sb.boardPath, "{ this is not json");
    const r = runBoard(["help"], sb.root);
    assert.equal(r.code, 0);
  } finally { sb.teardown(); }
});

test("Q7: a command word wins; words that name no job get one hint line pointing at dispatch", () => {
  const sb = makeSandbox();
  try {
    seedTasks(sb, { "meals-screen": { display: "Meals screen", stage: "not_started" } });
    const cases = [
      [["stop", "the", "flicker", "on", "the", "orders", "page"], 'no job called "the flicker on the orders page" — to build this, use /one-go dispatch "stop the flicker on the orders page"'],
      [["info", "a", "thing", "nobody", "made"], 'no job called "a thing nobody made" — to build this, use /one-go dispatch "info a thing nobody made"'],
      [["resume", "the", "orders", "page"], 'no job called "the orders page" — to build this, use /one-go dispatch "resume the orders page"'],
      [["help", "me", "fix", "the", "login"], '"help" takes no job name — to build this, use /one-go dispatch "help me fix the login"'],
      [["status", "of", "the", "login"], '"status" is no longer a command — see /one-go help']
    ];
    for (const [argv, want] of cases) {
      const r = runBoard(argv, sb.root);
      assert.equal(r.code, 1, argv.join(" "));
      assert.deepEqual(lines(r.stdout), [want]);
    }
  } finally { sb.teardown(); }
});

test("Q7: words that DO name a job, a run number or a run folder are left to the command", () => {
  const sb = makeSandbox();
  try {
    seedTasks(sb, {
      "meals-screen": { display: "Meals screen", stage: "not_started" },
      "old-job": { display: "Old job", stage: "done" }
    });
    for (const argv of [["info", "meals-screen"], ["info", "old-job"], ["stop", "meals screen"], ["resume", "2"],
      ["revive", sb.runId], ["finish", "meals-screen/part-a"], ["lanes", "meals-screen"]]) {
      const r = runBoard(argv, sb.root);
      assert.doesNotMatch(r.stdout, /no job called|takes no job name|not a command/, argv.join(" "));
    }
  } finally { sb.teardown(); }
});

test("the router's table puts every word in exactly the list the command table gives it", () => {
  const want = {
    // Pass 12 (2026-10-03): the bare board ("") left the public menu on purpose — it is plumbing.
    public: ["dispatch", "stop", "update", "help"],
    alias: ["finish", "resume", "revive", "abort", "cancel"],
    plumbing: ["", "start", "pass", "brief", "next", "check-plan", "close", "watchdog", "worker", "info", "lanes", "models"],
    retired: ["add", "sub", "done", "stage", "ready", "audit", "status", "watch", "guard"]
  };
  const sorted = a => [...a].sort();
  for (const k of Object.keys(want)) assert.deepEqual(sorted(WORD_LISTS[k]), sorted(want[k]), k);
  const all = Object.values(want).flat();
  assert.equal(new Set(all).size, all.length, "no word is in two lists");
  // COMMANDS holds exactly the working words; retired words are never a table entry.
  assert.deepEqual(sorted(Object.keys(COMMANDS)), sorted([...want.public, ...want.alias, ...want.plumbing]));
  assert.deepEqual(sorted(RETIRED), sorted(want.retired));
  // finish is dispatch itself; resume and revive are one command; abort and cancel are stop.
  assert.deepEqual([COMMANDS.finish.file, COMMANDS.finish.fn], [COMMANDS.dispatch.file, COMMANDS.dispatch.fn]);
  assert.deepEqual(COMMANDS.revive, COMMANDS.resume);
  for (const w of ["abort", "cancel"]) assert.deepEqual([COMMANDS[w].file, COMMANDS[w].fn], [COMMANDS.stop.file, COMMANDS.stop.fn]);
  // every working word's file exists; a retired word routes to no entry
  const cmdDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "cmd");
  for (const [w, e] of Object.entries(COMMANDS)) assert.ok(fs.existsSync(path.join(cmdDir, e.file)), `"${w}" → cmd/${e.file} is missing`);
  for (const w of want.retired) {
    const r = routeWord(w.toUpperCase());
    assert.equal(r.entry, null, w);
    assert.equal(r.retired, true, w);
  }
});

test("every public word, silent alias and plumbing word is a known command (never the unknown-word line)", () => {
  const words = [
    "dispatch", "stop", "help",                                             // public (+ bare board)
    "finish", "resume", "revive", "abort", "cancel",                         // silent aliases
    "start", "pass", "brief", "next", "check-plan", "close", "watchdog", "worker", "info", "lanes", "models"
  ];
  const sb = makeSandbox();
  try {
    for (const w of words) {
      const r = runBoard([w], sb.root);
      assert.doesNotMatch(r.stdout, /^not a command/m, `"${w}" fell through as unknown`);
      assert.doesNotMatch(r.stdout, /is no longer a command/, `"${w}" must not be retired`);
    }
    for (const argv of [[], ["--all"], ["-a"]]) {
      const r = runBoard(argv, sb.root);
      assert.doesNotMatch(r.stdout, /^not a command/m, `board ${argv.join(" ")}`);
    }
  } finally { sb.teardown(); }
});

test("a damaged config.json stops the command loudly, writing nothing", () => {
  const sb = makeSandbox();
  try {
    fs.writeFileSync(path.join(sb.onegoDir, "config.json"), "{ nope");
    const before = fs.readFileSync(sb.boardPath, "utf8");
    const r = runBoard(["dispatch", "build a new settings page"], sb.root);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /config\.json/);
    assert.equal(fs.readFileSync(sb.boardPath, "utf8"), before);
  } finally { sb.teardown(); }
});

test("a damaged board.json is refused, not written over", () => {
  const sb = makeSandbox();
  try {
    fs.writeFileSync(sb.boardPath, "{ half a board");
    const r = runBoard(["dispatch", "build a new settings page"], sb.root);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /damaged/);
    assert.equal(fs.readFileSync(sb.boardPath, "utf8"), "{ half a board");
  } finally { sb.teardown(); }
});
