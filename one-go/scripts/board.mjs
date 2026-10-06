#!/usr/bin/env node
// /one-go — the engine's front door. Portable: lives in the skill folder, works in any project.
// Every word it knows sits in exactly one of four lists (WORD_LISTS below).
//
// Public (three): board.mjs dispatch "<text>"  start a job, or carry on an existing one (a cut-off
//                                              run is picked up on its own)
//                 board.mjs stop [<job>]       stop now, ends through close
//                 board.mjs help               prints reference/HELP.md (also --help, -h)
// Silent aliases: finish (= dispatch) · resume, revive (= resume) · abort, cancel (= stop)
// Plumbing:       the bare board (`board.mjs [--all]`: one table plus one footer line — it keeps
//                 working, the agent uses it as its state check, but it is not on the menu) ·
//                 start · pass · brief · next · check-plan · close · watchdog · worker · info · lanes ·
//                 models (the model scout: `models` shows each tool's list and the card status,
//                 `models --check` exits 1 when the cards are stale or missing)
// Retired:        add · sub · done · stage · ready · audit · status · watch · guard — one line,
//                 exit 1, never a job and never the board.
//
// ROUTING RULES (dev contract §4, unchanged)
//   1. A known command word always wins (public, alias, plumbing or retired). If the words after
//      a command do not name a job, it says so in ONE line and points at dispatch — it never
//      guesses what was meant.
//   2. An unknown first word is never shown the board: one line, exit 1. Turning free text into a
//      job is the skill's call (`board.mjs dispatch "<text>"`), not this file's.
//
// Each command lives in cmd/<name>.mjs and is loaded only when it is asked for, so one command's
// file can never stop another from running. Every command gets one `ctx` object:
//   { ARGV, CMD, board, tasks, runsBySlug, claimRows, config, house, src, ...src }
// (`src` is gatherSources' result; its keys are also spread in, so older commands keep reading
// `staleSlugs`, `pendingQuestions`, … by name). The bare board also gets `unfinishedRuns`.
//
// Nothing here writes. Every command that changes something saves for itself, after it has
// decided to go ahead — a refusal leaves no fingerprint.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ROOT } from "./lib/paths.mjs";
import { loadBoard, findTask, resolveTaskStrict, CorruptFileError } from "./lib/board-io.mjs";
import { ConflictError } from "./lib/atomic.mjs";
import { ConfigError, loadConfig } from "./lib/config.mjs";
import { loadHouseRules } from "./lib/house.mjs";
import { positionals } from "./lib/util.mjs";

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const ARGV = process.argv.slice(2);

// ---------------------------------------------------------------- the command table
// file/fn: where the command lives. ctx: "none" (help — reads nothing else) or "full".
// fit: how the words after the word must look for the command to win (rule 1); dispatch and
// finish take free text, and most plumbing words check their own arguments.
export const COMMANDS = Object.freeze({
  // public
  dispatch:    { file: "dispatch.mjs",    fn: "runDispatch", ctx: "full" },
  stop:         { file: "stop.mjs",        fn: "runStop",     ctx: "full", fit: "run" },
  help:         { file: "help.mjs",        fn: "runHelp",     ctx: "none", fit: "nothing" },
  // silent aliases — work, never advertised. `finish` is dispatch itself: same file, same
  // function, same arguments, so the two can never drift.
  finish:       { file: "dispatch.mjs",    fn: "runDispatch", ctx: "full" },
  resume:       { file: "resume.mjs",      fn: "runResume",   ctx: "full", fit: "run" },
  revive:       { file: "resume.mjs",      fn: "runResume",   ctx: "full", fit: "run" },
  // fix D7: the old skill named abort/cancel as ending words (and the hook still treats them as
  // "off"), so they are `stop` — never free text that dispatch would turn into a junk job.
  abort:        { file: "stop.mjs",        fn: "runStop",     ctx: "full", fit: "run" },
  cancel:       { file: "stop.mjs",        fn: "runStop",     ctx: "full", fit: "run" },
  // hidden plumbing — the agent types these. The bare board is one of them (D9, obs 0124): the
  // person never asked for it, the agent runs it as a state check, so `/one-go` still works quietly.
  "":           { file: "board-table.mjs", fn: "renderBoard", ctx: "full" },
  start:       { file: "start.mjs",       fn: "runStart",    ctx: "full" },
  pass:         { file: "pass.mjs",        fn: "runPass",     ctx: "full" },
  brief:        { file: "brief.mjs",       fn: "runBrief",    ctx: "full" },
  next:         { file: "next.mjs",        fn: "runNext",     ctx: "full" },
  "check-plan": { file: "check-plan.mjs",  fn: "runCheckPlan", ctx: "full" },
  close:        { file: "close.mjs",       fn: "runClose",    ctx: "full" },
  watchdog:     { file: "watchdog.mjs",    fn: "runWatchdog", ctx: "full" },
  worker:       { file: "worker.mjs",      fn: "runWorker",   ctx: "full" },
  info:         { file: "info.mjs",        fn: "runInfo",     ctx: "full", fit: "job" },
  lanes:        { file: "lanes.mjs",       fn: "runLanes",    ctx: "full", fit: "job" },
  // the model scout: each tool's own model list against the saved model cards (plumbing only)
  models:       { file: "models.mjs",      fn: "runModels",   ctx: "full" }
});

/** Words that were commands once. Each gets one line and exit 1 — never a job, never the board. */
export const RETIRED = Object.freeze(["add", "sub", "done", "stage", "ready", "audit", "status", "watch", "guard"]);

/** The four lists every known word sits in — exactly one each. */
export const WORD_LISTS = Object.freeze({
  public: Object.freeze(["dispatch", "stop", "help"]),
  alias: Object.freeze(["finish", "resume", "revive", "abort", "cancel"]),
  plumbing: Object.freeze(["", "start", "pass", "brief", "next", "check-plan", "close", "watchdog", "worker", "info", "lanes", "models"]),
  retired: RETIRED
});

/** The one line a retired word gets. */
export function retiredLine(word) {
  return `"${word}" is no longer a command — see /one-go help`;
}

/** First-argument spellings that mean something other than their own word. */
const SPELLINGS = { "--help": "help", "-h": "help", "--all": "", "-a": "" };

/**
 * Which table entry the first argument selects: { word, entry, retired }. `entry` is null for an
 * unknown word and for a retired one (`retired: true` tells the two apart).
 */
export function routeWord(first) {
  const raw = String(first == null ? "" : first).trim();
  const lower = raw.toLowerCase();
  const word = Object.prototype.hasOwnProperty.call(SPELLINGS, lower) ? SPELLINGS[lower] : lower;
  const retired = RETIRED.includes(word);
  const entry = !retired && Object.prototype.hasOwnProperty.call(COMMANDS, word) ? COMMANDS[word] : null;
  return { word, entry, retired };
}

/** A number (`resume 2`) or a run folder name (`2026-09-27-1206-…`) — a run, not a job name. */
function looksLikeRun(text) {
  return /^\d+$/.test(text) || /^\d{4}-\d{2}-\d{2}-\d{4}/.test(text);
}

/**
 * Rule 1: do the words after a command fit it? null = yes; otherwise the one hint line.
 * A name that could mean several jobs counts as fitting — the command lists the choices itself.
 */
export function fitHint(word, entry, argv, tasks) {
  if (!entry || !entry.fit) return null;
  const rest = positionals(argv.slice(1)).join(" ").trim();
  if (!rest) return null;
  const all = [word, rest].filter(Boolean).join(" ");
  const toBuild = `to build this, use /one-go dispatch "${all}"`;
  if (entry.fit === "nothing") return `"${word}" takes no job name — ${toBuild}`;
  if (entry.fit === "run" && looksLikeRun(rest)) return null;
  const name = rest.split("/")[0].trim();
  if (findTask(tasks, rest) || findTask(tasks, name)) return null;
  if (resolveTaskStrict(tasks, name).ambiguous) return null;
  return `no job called "${rest}" — ${toBuild}`;
}

async function load(entry) {
  const file = path.join(SCRIPTS, "cmd", entry.file);
  if (!fs.existsSync(file)) {
    console.log(`⛔ This build has no cmd/${entry.file} yet, so that command cannot run. Nothing was changed.`);
    process.exit(1);
  }
  const mod = await import(pathToFileURL(file).href);
  const fn = mod[entry.fn];
  if (typeof fn !== "function") {
    console.log(`⛔ cmd/${entry.file} does not export ${entry.fn}. Nothing was changed.`);
    process.exit(1);
  }
  return fn;
}

async function unfinishedRunsFor() {
  const file = path.join(SCRIPTS, "cmd", "revive.mjs");
  if (!fs.existsSync(file)) return [];
  const mod = await import(pathToFileURL(file).href);
  return typeof mod.scanRuns === "function" ? mod.scanRuns().filter(r => !r.finished) : [];
}

async function main() {
  const { word, entry, retired } = routeWord(ARGV[0]);

  // Rule 1 for a retired word: it is known, so it wins — with one line, never a job or the board.
  if (retired) {
    console.log(retiredLine(word));
    process.exit(1);
  }

  // Rule 2 — an unknown word (or flag) never falls through to the board.
  if (!entry) {
    console.log(`not a command — to start this as a job, the agent runs dispatch "${ARGV.join(" ").trim()}"`);
    process.exit(1);
  }

  if (entry.ctx === "none") {
    if (entry.fit === "nothing" && positionals(ARGV.slice(1)).length) {
      console.log(fitHint(word, entry, ARGV, {}));
      process.exit(1);
    }
    const fn = await load(entry);
    return fn();
  }

  const config = loadConfig(ROOT);
  const house = loadHouseRules(ROOT);
  const board = loadBoard();
  const tasks = board.tasks;

  const hint = fitHint(word, entry, ARGV, tasks);
  if (hint) {
    console.log(hint);
    process.exit(1);
  }

  let ctx = { ARGV, CMD: word, board, tasks, config, house, root: ROOT };
  if (entry.ctx === "full") {
    const { gatherSources } = await import("./lib/sources.mjs");
    const src = gatherSources({ board, tasks, persist: false, config });
    ctx = { ...src, ...ctx, src, runsBySlug: src.runsBySlug, claimRows: src.claimRows };
    if (word === "") ctx.unfinishedRuns = await unfinishedRunsFor();
  }

  const fn = await load(entry);
  const code = await fn(ctx);
  if (typeof code === "number") process.exitCode = code;
}

// Run only when executed (`node board.mjs …`), so a test may import COMMANDS / routeWord / fitHint.
const invoked = process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
if (invoked) main().catch(err => {
  if (err instanceof CorruptFileError) {
    console.log(`⛔ ${err.file} is damaged — /one-go stopped rather than write over it.\n`);
    console.log(`   ${err.message}\n`);
    console.log(`   Nothing was changed. The file is exactly as it was, so the contents can still`);
    console.log(`   be recovered. Repair the JSON (or restore it), then run /one-go again.`);
    process.exit(1);
  }
  if (err instanceof ConflictError) {
    console.log(`⛔ Another /one-go window wrote ${err.file} while this command was running.\n`);
    console.log(`   ${err.message}\n`);
    console.log(`   Nothing was changed here, so nothing was lost. Run the command again.`);
    process.exit(1);
  }
  if (err instanceof ConfigError) {
    console.log(`⛔ ${err.message}`);
    process.exit(1);
  }
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
