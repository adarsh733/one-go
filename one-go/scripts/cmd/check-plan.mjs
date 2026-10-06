// cmd/check-plan.mjs — `check-plan <slug>`: run the seal gate on a DRAFT plan, before anything
// is started (obs 0102). Every problem is listed at once, so the reading worker fixes them in one
// go instead of meeting them one by one at `start`. Reads only; writes nothing.
//
//   check-plan <slug>          plans/<slug>.md (the slug, a job name, or a path to a .md file)
//   exit 0  "check-plan: OK …"       the draft passes the gate
//   exit 1  every problem, one line each
import fs from "node:fs";
import path from "node:path";
import { ONEGO, ROOT } from "../lib/paths.mjs";
import { findTask } from "../lib/board-io.mjs";
import { positionals, slugify } from "../lib/util.mjs";
import { checkPlan, parsePlan } from "../lib/plan.mjs";
import { cleanPathEntry } from "../lib/pathspec.mjs";
import { listFrozenScreens } from "../lib/house.mjs";
import { loadConfig } from "../lib/config.mjs";
import { waveShape } from "./lanes.mjs";

/**
 * A plan sealed on or after this date, and every draft, must carry a `## Run shape` section
 * (pieces, what needs what, waves, unlocks, `N passes in M waves`). Older sealed plans are never
 * re-judged. The date is read from `State: sealed YYYY-MM-DD`.
 */
export const RUN_SHAPE_CUTOFF = "2026-10-03";

const RUN_SHAPE_HEADING = /^##\s*Run shape\s*$/im;

/** The refusal sentence when the plan needs a Run shape and has none; null when it is fine. */
export function runShapeRefusal(text) {
  const s = String(text || "");
  if (RUN_SHAPE_HEADING.test(s)) return null;
  const sealed = s.match(/^State:\s*sealed\b[ \t]*(\d{4}-\d{2}-\d{2})?/im);
  if (sealed && !(sealed[1] && sealed[1] >= RUN_SHAPE_CUTOFF)) return null;   // sealed before the rule (or undated): never re-judged
  return "the plan has no `## Run shape` section — add it before `## Passes`: the pieces and why each is its own pass; " +
    "what truly needs what; the waves; what a small first pass could unlock; and the line `N passes in M waves`.";
}

/**
 * obs 0019 / 0032: a pass whose `Dry-run today` entry is exit 0 has a check that was already green
 * before any work — it proves nothing. One sentence per such pass; [] when none (or no such line).
 * Reads every line `Dry-run today: p1 exit 1 (why) · p2 exit 0`; `pass 2 exit 0` reads the same.
 */
export function dryRunRefusals(text) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.match(/^\W*Dry-run today\W*:(.*)$/i);
    if (!m) continue;
    for (const e of m[1].matchAll(/\bp(?:ass)?\s*(\d+)\s*[:=→-]*\s*exit\s*(?:code\s*)?(\d+)/gi)) {
      if (Number(e[2]) === 0) {
        out.push(`Pass ${e[1]}: its \`Dry-run today\` entry is exit 0 — a check that was already green before the work proves nothing. ` +
          "Reshape the check so it fails until the pass has done its job (a test the pass writes, a string only the new code holds).");
      }
    }
  }
  return out;
}

function normAbs(p) {
  const s = path.resolve(String(p)).replace(/\\/g, "/").replace(/\/+$/, "");
  return process.platform === "win32" ? s.toLowerCase() : s;
}

/**
 * obs 0068: a declared write inside a screen folder (under `config.frozen_dirs`) whose FROZEN.md
 * marks it frozen. A WARNING, never a refusal: reopening a frozen screen is sometimes the job, but
 * it must be said out loud. [] when the project configures no frozen folders.
 */
export function frozenWriteWarnings(passes, root, config) {
  if (!config || !(config.frozen_dirs || []).length) return [];
  let screens = [];
  try { screens = listFrozenScreens(root, config).filter(s => s.status === "frozen" || s.allFrozen); } catch { return []; }
  const out = [];
  for (const p of passes || []) {
    for (const raw of p.files || p.writes || []) {
      const f = cleanPathEntry(raw).path;
      if (!f) continue;
      const segs = f.replace(/\\/g, "/").split("/");
      const cut = segs.findIndex(s => /[*{?]/.test(s));
      const isGlob = cut !== -1;
      const base = normAbs(path.resolve(root, (isGlob ? segs.slice(0, cut) : segs).join("/") || "."));
      for (const s of screens) {
        const dir = normAbs(s.dir);
        const inside = base === dir || base.startsWith(dir + "/");
        const covers = isGlob && dir.startsWith(base + "/");
        if (!inside && !covers) continue;
        const shown = path.relative(root, s.file).split(path.sep).join("/") || s.file;
        out.push(`warning: pass ${p.n} writes \`${f}\`, in screen \`${s.id}\` — \`${shown}\` marks it frozen. ` +
          "Reopening a frozen screen needs a deliberate re-freeze; make sure that is what this pass is for.");
      }
    }
  }
  return out;
}

/** Which plan file an argument means: a .md path, plans/<arg>.md, a job's plan, or its slug form. */
export function planFileFor(arg, tasks = {}, onegoDir = ONEGO) {
  const plansDir = path.join(onegoDir, "plans");
  const raw = String(arg || "").trim();
  if (!raw) return null;
  if (/\.md$/i.test(raw)) {
    const abs = path.isAbsolute(raw) ? raw : path.resolve(raw);
    if (fs.existsSync(abs)) return abs;
    const inPlans = path.join(plansDir, path.basename(raw));
    return fs.existsSync(inPlans) ? inPlans : null;
  }
  const candidates = [raw, findTask(tasks, raw), slugify(raw, 9), slugify(raw)].filter(Boolean);
  for (const c of candidates) {
    const f = path.join(plansDir, `${c}.md`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

export function runCheckPlan(ctx = {}) {
  const ARGV = ctx.ARGV || [];
  const tasks = ctx.tasks || {};
  const root = ctx.root || ROOT;
  const arg = positionals(ARGV.slice(1)).join(" ").trim();
  if (!arg) {
    console.log("Usage: board.mjs check-plan <slug>");
    process.exit(1);
  }
  const file = planFileFor(arg, tasks);
  if (!file) {
    console.log(`No draft plan found for "${arg}" (looked for ${path.join(ONEGO, "plans", `${arg}.md`)}).`);
    process.exit(1);
  }
  const text = fs.readFileSync(file, "utf8");
  const config = (() => { try { return loadConfig(root); } catch { return undefined; } })();
  const { ok: gateOk, errors, tags } = checkPlan(text, { root, config });
  const shapeProblem = runShapeRefusal(text);
  if (shapeProblem) errors.push(shapeProblem);
  const dryRunProblems = dryRunRefusals(text);
  errors.push(...dryRunProblems);
  const ok = gateOk && !shapeProblem && !dryRunProblems.length;
  const warnings = frozenWriteWarnings(parsePlan(text).passes, root, config);
  const shown = path.relative(root, file).split(path.sep).join("/") || file;
  if (ok) {
    console.log(`check-plan: OK — ${shown} passes the seal gate.`);
    // The shape of the plan in waves: the same words the dispatch preview prints for a sealed plan.
    const tagged = new Set((tags || []).map(t => t.n));
    const shape = waveShape(parsePlan(text).passes.map(p => ({ ...p, shared: tagged.has(p.n) ? ["capture-tree"] : [] })));
    console.log(shape.line);
    console.log(shape.summary);
    if (shape.warning) console.log(shape.warning);
    for (const t of tags || []) console.log(`  note: pass ${t.n}'s check reads the whole app ("${t.matched}"), so it runs only when no other pass is still writing.`);
    for (const w of warnings) console.log(`  ${w}`);
    process.exit(0);
  }
  console.log(`check-plan: ${errors.length} problem${errors.length === 1 ? "" : "s"} in ${shown} — fix every one, then run check-plan again:`);
  for (const e of errors) console.log(`  - ${e}`);
  for (const w of warnings) console.log(`  ${w}`);
  process.exit(1);
}
