// cmd/brief.mjs — one pass's worker brief, built from the job's sealed plan.
//
//   brief <job> <n>          prints the brief (markdown) to stdout
//   brief <job> <n> --out    writes it to <run-folder>/briefs/p<n>.md and prints ONLY that path
//
// The brief carries everything the worker needs, never a pointer to go and read a rule elsewhere
// (obs 0017): the goal, the files it may write (plus the house's always-allowed paths, obs 0076),
// the plan's reading-list rows for this pass, the plan's `## Fixed names` word for word (obs
// 0023), the plan's `## Answers` word for word (obs 0042), the house `## For every worker` rules word for word, the proof command, the report
// template (with a `Protocols run:` line, obs 0076) and the standing rules.
//
// The sealed plan (plans/<slug>.plan.json, or a sealed plans/<slug>.md) is the authority for the
// passes; the reading list and fixed names come from the human plan plans/<slug>.md. Nothing here
// rewrites either — `--out` writes only the brief file.
import fs from "node:fs";
import path from "node:path";
import { ONEGO, ROOT } from "../lib/paths.mjs";
import { resolveTaskStrict } from "../lib/board-io.mjs";
import { positionals, argValues, globDirs, readJSON, readText } from "../lib/util.mjs";
import { writeFileAtomic } from "../lib/atomic.mjs";
import { loadAuthoritativePlan, looksLikeCommand } from "../lib/plan.mjs";
import { loadConfig } from "../lib/config.mjs";
import { chooseHost, planHost, routeFor, meantModelLine } from "../lib/route.mjs";
import { loadHouseRules } from "../lib/house.mjs";

export const RULES = [
  "never commit/push unless this brief says so",
  "never write outside the file list above",
  "a red check outside your files is reported, never fixed",
  "blocked after 2 attempts → stop, report PARKED with the exact question",
  "final report ≤12 lines, this exact template — a longer report is the worker's error"
];

// The fixed report shape: 4 + 1 + 3 + 3 + 1 = 12 lines at most.
export const REPORT_TEMPLATE = [
  "≤12 lines total, this exact shape:",
  "- what changed (max 4 lines)",
  "- what you proved: the exact command you ran, and its exit code (1 line)",
  "- judgement calls you made (max 3 lines)",
  "- what you left out (max 3 lines)",
  "- Protocols run: each standing protocol you ran (from House rules), or none · Ran on: the model you actually ran on, or unknown (1 line)"
];

/**
 * The route this pass was meant to run on: the run's own record when a run exists (host and route
 * as start wrote them), otherwise worked out the way start would — host from --host / the plan /
 * ONEGO_HOST / config, tier and model from routeFor.
 */
export function meantRoute(slug, pass, { plan, config, hostFlag, onegoDir = ONEGO } = {}) {
  const runDir = findLatestRunDir(slug, onegoDir);
  const state = runDir ? readJSON(path.join(runDir, "state.json"), null) : null;
  const recorded = state && Array.isArray(state.passes) ? state.passes.find(x => x.n === pass.n) : null;
  if (recorded && recorded.route && !hostFlag) return { ...recorded.route, host: recorded.route.host || state.host || "claude" };
  const pick = chooseHost({ flag: hostFlag, plan: planHost(plan), env: process.env.ONEGO_HOST, config });
  const host = pick.host || "claude";
  const input = {
    n: pass.n,
    title: pass.purpose || pass.title,
    model: pass.route?.requested_model || pass.model || "",
    route: pass.route || null,
    files: pass.writes || pass.files || []
  };
  return routeFor(input, { host, config });
}

/**
 * The newest run folder whose state.json names this slug (run ids are date-prefixed, so a
 * reverse sort finds it first). null when the job has never been started.
 */
export function findLatestRunDir(slug, onegoDir = ONEGO) {
  for (const runId of globDirs(onegoDir).sort().reverse()) {
    if (runId === "plans" || runId === "scripts" || runId === "archive") continue;
    const state = readJSON(path.join(onegoDir, runId, "state.json"), null);
    if (state && state.slug === slug) return path.join(onegoDir, runId);
  }
  return null;
}

/** The body of one `## <name>` section of a markdown text ("" when absent). Code fences respected. */
export function sectionBody(text, name) {
  const lines = String(text || "").split(/\r?\n/);
  const want = name.toLowerCase();
  let inside = false, fence = false;
  const out = [];
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && /^##\s/.test(line)) {
      if (inside) break;
      inside = line.replace(/^##\s+/, "").trim().toLowerCase().startsWith(want);
      continue;
    }
    if (inside) out.push(line);
  }
  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.join("\n");
}

/**
 * The person's answers, word for word: the human plan's `## Answers` section (or `## <Name>'s
 * answers`), else the sealed plan's `answers` list. "" when there are none, or only the template's
 * "(left empty ...)" placeholder — a brief never carries an empty heading.
 */
export function answersFor(humanPlan, plan) {
  let body = sectionBody(humanPlan, "Answers");
  if (!body) {
    const m = String(humanPlan || "").match(/^##[ \t]+[^\n#]*?['’]s[ \t]+answers[ \t]*$/im);
    if (m) body = sectionBody(humanPlan, m[0].replace(/^##[ \t]+/, "").trim());
  }
  const real = body.split("\n").filter(l => l.trim() && !/^\(.*\)$/.test(l.trim()));
  if (real.length) return body;
  const list = Array.isArray(plan && plan.answers) ? plan.answers : [];
  const lines = list.map(a => {
    const t = a && typeof a === "object" && "answer" in a ? a.answer : a;
    return typeof t === "string" ? t.trim() : t == null ? "" : JSON.stringify(t);
  }).filter(Boolean).map(t => `> ${t}`);
  return lines.join("\n");
}

/** Plain words a declared path is recognised by in a reading-list row: the path, minus globs. */
function pathKeys(file) {
  const f = String(file || "").replace(/\\/g, "/").replace(/^\.\//, "");
  const keys = new Set();
  const stem = f.split(/[*{]/)[0].replace(/\/+$/, "");
  if (stem) keys.add(stem.toLowerCase());
  const base = path.posix.basename(f).split(/[*{]/)[0];
  if (base && base.length >= 4 && /\w\.\w|\w-\w|\w_\w/.test(base)) keys.add(base.toLowerCase());
  return [...keys].filter(k => k.length >= 3);
}

/**
 * This pass's rows from the plan's `## What I read before asking` table: a row that names one of
 * the pass's files (or its folder), or names the pass itself ("P4", "pass 4").
 */
export function readingRowsFor(planText, pass) {
  const body = sectionBody(planText, "What I read before asking");
  if (!body) return [];
  const rows = body.split("\n").map(l => l.trim())
    .filter(l => l.startsWith("|") && !/^\|[\s|:-]+\|$/.test(l) && !/^\|\s*File\s*\|/i.test(l));
  const files = pass.writes || pass.files || [];
  const keys = files.flatMap(pathKeys);
  const n = pass.n;
  const namesPass = new RegExp(`\\b(?:p|pass\\s*)${n}\\b`, "i");
  const out = [];
  for (const row of rows) {
    const lower = row.toLowerCase().replace(/\\/g, "/");
    if (keys.some(k => lower.includes(k)) || namesPass.test(row)) {
      const cells = row.split("|").map(c => c.trim()).filter(Boolean);
      out.push(cells.length > 1 ? `${cells[0]} — ${cells.slice(1).join(" · ")}` : cells[0] || row);
    }
  }
  return out;
}

export function runBrief(ctx = {}) {
  const ARGV = ctx.ARGV || [];
  const tasks = ctx.tasks || {};
  const config = ctx.config || loadConfig(ROOT);
  const house = ctx.house || loadHouseRules(ROOT);

  const pos = positionals(ARGV.slice(1));
  const target = pos[0] || "";
  const n = Number(pos[1]);
  if (!target || !Number.isInteger(n)) {
    console.log('Usage: board.mjs brief "<job>" <n> [--out]');
    process.exit(1);
  }

  // The brief reads the same on every host; `--host` is checked so a typo is refused, not ignored.
  if (argValues(ARGV.slice(1), "--host")[0]) {
    const pick = chooseHost({ flag: argValues(ARGV.slice(1), "--host")[0], config });
    if (pick.error) { console.log(pick.error); process.exit(1); }
  }

  const resolved = resolveTaskStrict(tasks, target);
  if (resolved.ambiguous) {
    console.log(`"${target}" could mean more than one job — name it exactly:`);
    for (const s of resolved.ambiguous) console.log(`  - \`${s}\` — ${(tasks[s] && tasks[s].display) || s}`);
    process.exit(1);
  }
  if (!resolved.slug) {
    console.log(`${resolved.error}. Run /one-go to see the list.`);
    process.exit(1);
  }
  const slug = resolved.slug;
  const t = tasks[slug];

  const plansDir = path.join(ONEGO, "plans");
  const { plan, isSealed: sealed, errors } = loadAuthoritativePlan(plansDir, slug, { readOnly: true });
  if (!sealed) {
    console.log(`No sealed plan for \`${slug}\` — run the sealing conversation first, then brief again.`);
    process.exit(1);
  }
  if (errors && errors.length) {
    console.log(`The sealed plan for \`${slug}\` cannot be read: ${errors[0]}`);
    process.exit(1);
  }

  const passes = plan.passes || [];
  const total = passes.length;
  const p = passes.find(x => x.n === n);
  if (!p) {
    console.log(`Pass ${n} not found in \`${slug}\`'s sealed plan. It has ${total} pass${total === 1 ? "" : "es"}.`);
    process.exit(1);
  }

  const files = p.writes || p.files || [];
  const provenBy = (p.required_check && p.required_check.command) || p.proven_by || "";
  const hasVerify = provenBy && looksLikeCommand(provenBy);
  const allowed = Array.isArray(config.worker_always_allowed) ? config.worker_always_allowed : [];

  // Reading list: the human plan's rows for this pass, then the pass's own `reads`, then the
  // machine plan's whole-plan list narrowed to this pass's files. Honest "(none)" otherwise.
  const humanPlan = readText(path.join(plansDir, `${slug}.md`)) || "";
  const readingList = [];
  const add = r => { if (r && !readingList.includes(r)) readingList.push(r); };
  for (const r of readingRowsFor(humanPlan, p)) add(r);
  for (const r of p.reads || []) add(`\`${r}\``);
  const wholeList = Array.isArray(plan.reading_list) ? plan.reading_list : Array.isArray(plan.inputs) ? plan.inputs : [];
  for (const entry of wholeList) {
    if (files.some(f => String(entry).includes(f) || String(f).includes(String(entry)))) add(String(entry));
  }
  const fixedNames = sectionBody(humanPlan, "Fixed names");
  const answers = answersFor(humanPlan, plan);
  const houseWorker = house && house.worker ? String(house.worker).trim() : "";

  const lines = [];
  lines.push(`# WORKER BRIEF — ${t?.display || slug} · pass ${n} of ${total}`);
  lines.push("## Goal");
  lines.push(p.purpose || p.title || `Pass ${n}`);
  lines.push("");
  lines.push("## Files you may WRITE (exclusive)");
  if (files.length) for (const f of files) lines.push(`- \`${f}\``);
  else lines.push("- (none recorded in the plan)");
  for (const a of allowed) lines.push(`- \`${a}\` (always allowed — every worker in this project)`);
  lines.push("");
  lines.push("## Do NOT touch");
  const exclusions = p.exclusions || [];
  if (exclusions.length) for (const x of exclusions) lines.push(`- \`${x}\``);
  else lines.push("- (none recorded in the plan)");
  lines.push("");
  lines.push("## You share these");
  const shared = p.shared_resources || p.shared || [];
  if (shared.length) for (const s of shared) lines.push(`- \`${s}\``);
  else lines.push("- (none recorded in the plan)");
  lines.push("");
  lines.push("## Read first");
  if (readingList.length) for (const r of readingList) lines.push(`- ${r}`);
  else lines.push("- (none recorded in the plan)");
  lines.push("");
  if (fixedNames) {
    lines.push("## Fixed names");
    lines.push("Use these names exactly — other passes rely on them.");
    lines.push("");
    lines.push(fixedNames);
    lines.push("");
  }
  if (answers) {
    lines.push("## Answers");
    lines.push("The person's decisions on this job, word for word — they bind this pass.");
    lines.push("");
    lines.push(answers);
    lines.push("");
  }
  if (houseWorker) {
    lines.push("## House rules");
    lines.push("This project's rules for every worker, word for word. Follow them as part of this brief.");
    lines.push("");
    lines.push(houseWorker);
    lines.push("");
  }
  lines.push("## Model this pass was meant to run on");
  lines.push(meantModelLine(meantRoute(slug, p, { plan, config, hostFlag: argValues(ARGV.slice(1), "--host")[0] })));
  lines.push("Name the model you actually ran on in your report (the `Ran on:` line); say `unknown` if you cannot tell.");
  lines.push("");
  lines.push("## What done looks like");
  lines.push(provenBy || "(not recorded in the plan)");
  lines.push("");
  lines.push("## Prove it (--verify command)");
  lines.push(hasVerify ? `\`${provenBy}\`` : "(none recorded — report what you checked)");
  lines.push("");
  lines.push("## Report back (exact format)");
  for (const r of REPORT_TEMPLATE) lines.push(r);
  lines.push("");
  lines.push("## Rules");
  for (const r of RULES) lines.push(`- ${r}`);
  if (allowed.length) lines.push("- the always-allowed paths above may be written by every worker, in addition to this pass's files");

  // --out: the conductor pays for a path, not for the whole brief. Same text either way.
  if (ARGV.includes("--out")) {
    const runDir = findLatestRunDir(slug);
    if (!runDir) {
      console.log(`No run folder for \`${slug}\` yet — start the run first, then ask for --out again.`);
      process.exit(1);
    }
    const outPath = path.join(runDir, "briefs", `p${n}.md`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileAtomic(outPath, lines.join("\n") + "\n");
    console.log(outPath);
    process.exit(0);
  }

  console.log(lines.join("\n"));
  process.exit(0);
}
