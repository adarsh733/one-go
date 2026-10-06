// cmd/next.mjs — `next <job>`: the ONE next thing the conductor should do, and nothing else.
//
// Obs 0061: a written "never read source files" rule failed three times, because the conductor
// kept working out the order itself and reading to do it. This hands it one step at a time,
// as commands — never a file's contents (the brief and the plan stay on disk; only paths print).
//
// The steps, in order of what the run needs first:
//   seal      no sealed plan yet          → the --seal / check-plan commands
//   start     sealed, never started       → board.mjs start <job>
//   ended     the newest run has ended    → nothing to do (report path)
//   close     STOP requested, or every pass finished / nothing left can ever run
//   record    a pass is running           → `pass … built` (finished writing), then the exact
//                                           `pass … done --verify "<Proven by>"` line
//   hold      a built pass whose whole-app check must wait for passes still writing
//   fire      passes that may start now   → brief --out + the Agent line, per pass
//   wait      running passes, nothing new may start beside them
// A pass carrying `blocked_by` is never fired (obs 0068): it is listed as blocked instead.
//
// The house `## For the conductor` section is shown once per run (the first `next` of the run),
// then remembered by a marker file in the run folder — the only thing this command writes.
import fs from "node:fs";
import path from "node:path";
import { ONEGO, ROOT } from "../lib/paths.mjs";
import { resolveTaskStrict } from "../lib/board-io.mjs";
import { positionals, readJSON } from "../lib/util.mjs";
import { loadAuthoritativePlan } from "../lib/plan.mjs";
import { loadHouseRules } from "../lib/house.mjs";
import { readyPasses, blockedPasses, criticalPath } from "../lib/graph.mjs";
import { selectParallelBatch } from "../lib/overlap.mjs";
import { isDoneStatus, isStuckStatus, isRunningStatus, isStartableStatus, isLiveStatus, isBuiltStatus } from "../lib/status.mjs";
import { wholeTreeConflict } from "../lib/evidence.mjs";
import { findLatestRunDir } from "./brief.mjs";
import { agentModel } from "./dispatch.mjs";
import { loadConfig, DEFAULT_PARALLEL_LIMIT } from "../lib/config.mjs";
import { isWorkerHost, runsInline } from "../lib/route.mjs";

const HOUSE_SHOWN = ".house-rules-shown";

function hasBlocker(p) {
  const b = p && p.blocked_by;
  if (b == null || b === false) return false;
  if (Array.isArray(b)) return b.length > 0;
  return String(b).trim() !== "";
}

function checkOf(p) {
  return (p.required_check && p.required_check.command) || p.proven_by || "";
}

/** Work out the next step for a run's state. Pure — returns { step, lines }. */
export function nextStep({ slug, state, runDir, config }) {
  const L = [];
  const passes = (state.passes || []).map(p => ({ ...p, files: p.files || p.writes || [], depends: p.depends || p.prerequisites || [] }));

  if (state.ended) {
    const report = path.join(runDir, "report.md");
    L.push(`ended: the newest run of \`${slug}\` ended ${state.ended}${fs.existsSync(report) ? ` — report: ${report}` : ""}.`);
    L.push(`Nothing to do. To run it again: board.mjs start ${slug}`);
    return { step: "ended", lines: L };
  }
  if (fs.existsSync(path.join(runDir, "STOP"))) {
    L.push(`close: a stop was requested for \`${slug}\`.`);
    L.push(`  board.mjs close ${slug} --reason "stop requested"`);
    return { step: "close", lines: L };
  }

  const opts = { isDone: isDoneStatus, isStuck: isStuckStatus, isRunning: isRunningStatus, isStartable: isStartableStatus };
  const running = passes.filter(p => isRunningStatus(p.status) || p.status === "launch-requested");
  const blockers = passes.filter(p => !isDoneStatus(p.status) && !isStuckStatus(p.status) && hasBlocker(p));
  const blockerNs = new Set(blockers.map(p => p.n));
  const ready = readyPasses(passes, opts).filter(p => !blockerNs.has(p.n));
  const depth = new Map(criticalPath(passes, opts).map(c => [c.n, c.remaining]));
  const ordered = ready.slice().sort((a, b) => (depth.get(b.n) || 0) - (depth.get(a.n) || 0) || a.n - b.n);
  const limit = Math.max(0, (Number(state.parallel_limit) || DEFAULT_PARALLEL_LIMIT) - running.length);
  const { chosen } = selectParallelBatch(ordered, limit, running);

  for (const p of running) {
    const check = checkOf(p);
    const doneLine = `  board.mjs pass ${slug} ${p.n} done --proven "<one line on what was checked>"${check ? ` --verify "${check}"` : ` --no-check "<why>"`}`;
    if (isBuiltStatus(p.status)) {
      // Finished writing. A whole-app check still waits for passes that are writing.
      const hold = wholeTreeConflict({ passes }, p.n);
      if (hold) {
        L.push(`hold: pass ${p.n} is built — its check reads the whole app; run it once pass${hold.running.length === 1 ? "" : "es"} ${hold.running.join(", ")} ${hold.running.length === 1 ? "is" : "are"} marked built or done:`);
      } else {
        L.push(`record: pass ${p.n} is built — run its check and record it:`);
      }
      L.push(doneLine);
    } else {
      L.push(`record: pass ${p.n} is running — when its worker reports, mark it built first, then run its check:`);
      L.push(`  board.mjs pass ${slug} ${p.n} built`);
      L.push(doneLine);
    }
    L.push(`  (worker PARKED → board.mjs pass ${slug} ${p.n} parked)`);
  }

  if (runsInline(state.host, config) && chosen.length && !running.length) {
    // Inline: the chat does each pass itself, one at a time, in plan order (CONTRACT-2 §4).
    const p = chosen.slice().sort((a, b) => a.n - b.n)[0];
    L.push(`fire: pass ${p.n} — ${p.title || p.purpose || "untitled"} — do it yourself, inline (no helpers on this run, one pass at a time).`);
    L.push(`  board.mjs brief ${slug} ${p.n} --out   (read it, do exactly that, run its Proven-by command)`);
  } else if (runsInline(state.host, config) && chosen.length) {
    L.push(`wait: pass ${running[0].n} is not recorded yet — this run is inline, so finish it and record it before the next.`);
  } else if (isWorkerHost(state.host, config) && chosen.length) {
    L.push(`fire: pass${chosen.length === 1 ? "" : "es"} ${chosen.map(p => p.n).join(", ")} may start — this run's host is ${state.host}; its worker adapter launches them (board.mjs worker …).`);
  } else {
    for (const p of chosen) {
      const brief = path.join(runDir, "briefs", `p${p.n}.md`);
      L.push(`fire: pass ${p.n} — ${p.title || p.purpose || "untitled"}`);
      L.push(`  board.mjs brief ${slug} ${p.n} --out`);
      L.push(`  Agent(subagent_type: "one-go-worker", model: "${agentModel(p.route, config)}", prompt: "Read ${brief.split(path.sep).join("/")}. Do exactly that. Report back in the format it specifies.")`);
    }
  }
  for (const p of blockers) {
    const b = Array.isArray(p.blocked_by) ? p.blocked_by.join("; ") : String(p.blocked_by);
    L.push(`blocked: pass ${p.n} is not fired — blocked by ${b}. Clear it, or park the pass: board.mjs pass ${slug} ${p.n} parked`);
  }

  if (L.length) return { step: chosen.length ? "fire" : running.length ? "record" : "blocked", lines: L };

  const open = passes.filter(p => !isDoneStatus(p.status));
  const stuck = passes.filter(p => isStuckStatus(p.status));
  const cut = blockedPasses(passes, opts);
  const waitingLive = open.filter(p => isLiveStatus(p.status) && !isStartableStatus(p.status));
  if (waitingLive.length) {
    L.push(`wait: pass${waitingLive.length === 1 ? "" : "es"} ${waitingLive.map(p => `${p.n} (${p.status})`).join(", ")} — nothing else may start yet. Ask again when one reports.`);
    return { step: "wait", lines: L };
  }
  if (!open.length) {
    L.push(`close: every pass of \`${slug}\` is done.`);
    L.push(`  board.mjs close ${slug}`);
    return { step: "close", lines: L };
  }
  const why = [];
  if (stuck.length) why.push(`${stuck.length} parked or failed (${stuck.map(p => p.n).join(", ")})`);
  if (cut.length) why.push(`${cut.length} waiting on those (${cut.map(c => c.pass.n).join(", ")})`);
  L.push(`close: nothing left can run — ${why.join(", ") || `${open.length} pass(es) cannot start`}. The run ends FINISHED WITH OPEN ITEMS.`);
  L.push(`  board.mjs close ${slug}`);
  return { step: "close", lines: L };
}

export function runNext(ctx = {}) {
  const ARGV = ctx.ARGV || [];
  const tasks = ctx.tasks || {};
  const house = ctx.house || loadHouseRules(ROOT);
  const target = positionals(ARGV.slice(1)).join(" ").trim();
  if (!target) {
    console.log("Usage: board.mjs next <job>");
    process.exit(1);
  }
  const resolved = resolveTaskStrict(tasks, target);
  if (resolved.ambiguous) {
    console.log(`"${target}" could mean more than one job: ${resolved.ambiguous.map(s => `\`${s}\``).join(", ")} — name it exactly.`);
    process.exit(1);
  }
  if (!resolved.slug) {
    console.log(`${resolved.error}. Run /one-go to see the list.`);
    process.exit(1);
  }
  const slug = resolved.slug;
  const runDir = findLatestRunDir(slug);

  if (!runDir) {
    const plansDir = path.join(ONEGO, "plans");
    const { isSealed: sealed } = loadAuthoritativePlan(plansDir, slug, { readOnly: true });
    if (sealed) {
      console.log(`start: \`${slug}\` is sealed and has never run.`);
      console.log(`  board.mjs start ${slug}`);
    } else if (fs.existsSync(path.join(plansDir, `${slug}.md`))) {
      console.log(`seal: \`${slug}\` has a draft plan. Check it, ask its questions in one block, then seal it:`);
      console.log(`  board.mjs check-plan ${slug}`);
    } else {
      console.log(`seal: \`${slug}\` has no plan yet. Fire the reading as a worker on the path this prints:`);
      console.log(`  board.mjs dispatch "${slug}" --seal`);
    }
    process.exit(0);
  }

  const state = readJSON(path.join(runDir, "state.json"), null);
  if (!state) {
    console.log(`The run folder ${runDir} has no readable state.json — run board.mjs resume ${slug} to see what is true.`);
    process.exit(1);
  }

  const conductor = house && house.conductor ? String(house.conductor).trim() : "";
  const marker = path.join(runDir, HOUSE_SHOWN);
  if (conductor && !state.ended && !fs.existsSync(marker)) {
    console.log("House rules — for the conductor (shown once per run):");
    console.log(conductor);
    console.log("");
    try { fs.writeFileSync(marker, new Date().toISOString() + "\n"); } catch { /* shown again next time — harmless */ }
  }

  let config = ctx.config;
  if (!config) { try { config = loadConfig(ROOT); } catch { config = undefined; } }
  const { lines } = nextStep({ slug, state, runDir, config });
  console.log(lines.join("\n"));
  process.exit(0);
}
