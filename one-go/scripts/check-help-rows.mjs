#!/usr/bin/env node
// scripts/check-help-rows.mjs — keeps the cheat sheet and SKILL.md true to the public command table.
//
//   node scripts/check-help-rows.mjs                 check this skill folder
//   node scripts/check-help-rows.mjs --skill <dir>   check another copy (used by tests)
//
// A "command row" is a markdown table row whose first cell starts with `/one-go`. In BOTH
// SKILL.md and reference/HELP.md:
//   1. each of the three public commands (dispatch, stop, help) has exactly one command row;
//   2. no command row advertises anything else (plumbing and silent aliases stay off the menu —
//      the agent's plumbing table in SKILL.md writes commands without the `/one-go` prefix, and
//      the bare `/one-go <anything>` form is a silent alias and the bare `/one-go` board is
//      plumbing, so neither is ever a row).
// Also: SKILL.md must point at reference/HELP.md, reference/CONDUCTOR.md and reference/HOSTS.md,
// and all three files exist.
// Exit 0 = true, 1 = something is wrong (every problem is listed), 2 = a file is missing.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The public command table (D9, obs 0124: the bare board is plumbing now, not on the menu). Key = what the first cell's command resolves to.
export const PUBLIC = ["dispatch", "stop", "help"];

/** What a `/one-go …` first cell stands for: "board", "anything", or the first word. */
export function commandKey(cell) {
  const rest = String(cell).replace(/^\/one-go/, "").trim();
  if (!rest || rest.startsWith("-")) return "board";
  if (rest.startsWith("<") || rest.startsWith('"')) return "anything";
  return rest.split(/\s+/)[0].toLowerCase();
}

/** Every command row in a markdown text: [{ line, key, cell }]. */
export function commandRows(text) {
  const rows = [];
  String(text).split(/\r?\n/).forEach((line, i) => {
    const m = line.match(/^\|\s*`(\/one-go(?:\s[^`]*)?)`/);
    if (m) rows.push({ line: i + 1, key: commandKey(m[1]), cell: m[1] });
  });
  return rows;
}

/** All problems with one file's command rows, as plain sentences. */
export function problemsIn(name, text) {
  const problems = [];
  const rows = commandRows(text);
  for (const key of PUBLIC) {
    const hits = rows.filter(r => r.key === key);
    if (hits.length !== 1) {
      const where = hits.length ? ` (lines ${hits.map(h => h.line).join(", ")})` : "";
      problems.push(`${name}: public command "${label(key)}" has ${hits.length} command rows, expected exactly 1${where}`);
    }
  }
  for (const r of rows) {
    if (!PUBLIC.includes(r.key)) {
      problems.push(`${name}:${r.line}: advertises \`${r.cell}\`, which is not a public command — plumbing and aliases stay off the menu`);
    }
  }
  return problems;
}

function label(key) {
  if (key === "board") return "/one-go";
  return `/one-go ${key}`;
}

export function checkSkill(skillDir) {
  const skillPath = path.join(skillDir, "SKILL.md");
  const helpPath = path.join(skillDir, "reference", "HELP.md");
  const conductorPath = path.join(skillDir, "reference", "CONDUCTOR.md");
  const hostsPath = path.join(skillDir, "reference", "HOSTS.md");
  const missing = [skillPath, helpPath, conductorPath, hostsPath].filter(p => !fs.existsSync(p));
  if (missing.length) return { code: 2, problems: missing.map(p => `missing file: ${p}`) };

  const skill = fs.readFileSync(skillPath, "utf8");
  const help = fs.readFileSync(helpPath, "utf8");
  const problems = [...problemsIn("SKILL.md", skill), ...problemsIn("reference/HELP.md", help)];
  for (const ref of ["reference/HELP.md", "reference/CONDUCTOR.md", "reference/HOSTS.md"]) {
    if (!skill.includes(ref)) problems.push(`SKILL.md never mentions ${ref}`);
  }
  return { code: problems.length ? 1 : 0, problems };
}

function main(argv) {
  const i = argv.indexOf("--skill");
  const skillDir = i >= 0 && argv[i + 1]
    ? path.resolve(argv[i + 1])
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { code, problems } = checkSkill(skillDir);
  if (code === 0) {
    console.log(`help rows: SKILL.md and reference/HELP.md each list the ${PUBLIC.length} public commands once, and nothing else.`);
  } else {
    for (const p of problems) console.error(`ERROR: ${p}`);
  }
  return code;
}

if (process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
