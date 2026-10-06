// cmd/lanes.mjs — pass-level parallel groups: what can run together, what has to queue behind
// it, and what is genuinely stuck. Read-only, dispatches nothing. Ported from the live skill.
//
// P5 (dev/PLAN-SNAPSHOT.md): `ready` is now a hidden alias that prints this same view (the old
// `ready.mjs`'s separate "next batch for a live run" reasoning is retired — two views of the
// same question, per the "What I read" table). `computeLanes` stays exported separately from
// the CLI wrapper so `dispatch.mjs` can print the same grouping right after its match preview.
import fs from "node:fs";
import path from "node:path";
import { ONEGO } from "../lib/paths.mjs";
import { findTask } from "../lib/board-io.mjs";
import { positionals } from "../lib/util.mjs";
import { readJSONStrict } from "../lib/atomic.mjs";
import { loadAuthoritativePlan } from "../lib/plan.mjs";
import { isDoneStatus, isStuckStatus, isRunningStatus } from "../lib/status.mjs";
import { selectParallelBatch, claimConflicts, passesConflict } from "../lib/overlap.mjs";
import { ownClaimMarks, foreignClaims, claimWayOut } from "../lib/claims.mjs";

/**
 * Group not-yet-done passes into lanes that may run concurrently.
 *
 * A pass joins the earliest lane whose members it does not conflict with (pairwise, on expanded
 * file sets — see lib/overlap.mjs) and whose dependencies are already satisfied by the time that
 * lane starts (done already, or finished in an earlier lane). A pass a claim on the project's
 * claims board already holds is never placed in a lane — that board is the one authority on who
 * may edit a file, and a lane grouping is not a second one.
 *
 * @param {object[]} passes  every pass in the run or plan, with .n, .depends, .files, .reads,
 *                           .shared, .status (status may be absent — an unstarted plan preview
 *                           treats every pass as not-yet-started).
 * @param {object[]} claimRows  rows from the claims board's Active claims table (sources.mjs shape).
 * @param {object[]} running  passes already isRunningStatus in a live run — a lane must not
 *                             collide with those either. Empty for a plan preview with no run.
 * @returns {{ lanes: object[][], blocked: {pass:object, reason:string}[] }}
 */
export function computeLanes({ passes, claimRows = [], running = [] }) {
  const done = new Set(passes.filter(p => isDoneStatus(p.status)).map(p => p.n));
  let pool = passes.filter(p => !isDoneStatus(p.status) && !isRunningStatus(p.status));

  const claimHits = claimConflicts(pool, claimRows);
  const claimedNs = new Set(claimHits.map(h => h.pass));

  const lanes = [];
  let guard = 0;
  while (pool.length && guard < 50) {
    guard++;
    const readyNow = pool.filter(p =>
      !isStuckStatus(p.status) &&
      !claimedNs.has(p.n) &&
      (p.depends || []).every(d => done.has(d))
    );
    if (!readyNow.length) break;
    const runningForThisLane = lanes.length === 0 ? running : [];
    const { chosen } = selectParallelBatch(readyNow, readyNow.length, runningForThisLane);
    if (!chosen.length) break;
    lanes.push(chosen);
    for (const c of chosen) done.add(c.n);
    const chosenNs = new Set(chosen.map(c => c.n));
    pool = pool.filter(p => !chosenNs.has(p.n));
  }

  const blocked = pool.map(p => {
    if (claimedNs.has(p.n)) {
      const hit = claimHits.find(h => h.pass === p.n);
      return { pass: p, reason: `held by \`${hit ? hit.claim : "another chat window"}\`` };
    }
    if (isStuckStatus(p.status)) {
      return { pass: p, reason: `is ${p.status}` };
    }
    const waitingOn = (p.depends || []).find(d => !done.has(d));
    return { pass: p, reason: waitingOn != null ? `waits on p${waitingOn}` : "a prerequisite is stuck" };
  });

  return { lanes, blocked };
}

/**
 * The plan's shape in waves: who can start together, then who waits for them. The one place that
 * words it, so check-plan (a draft) and the dispatch preview (a sealed plan) say the same thing.
 *
 * A wave is a lane from computeLanes with every pass treated as not started and no claims, so a
 * wait caused by a real file clash and a wait caused by a declared dependency both show up as a
 * later wave. The WARNING names only waits that cause no clash: a pass that declares a
 * dependency on a pass it shares no file, read or resource with could start beside it, so the
 * wait is kept only if it needs the earlier pass's output.
 *
 * @param {object[]} passes  .n, and .depends/.prerequisites, .files/.writes, .reads, .shared/.shared_resources
 * @returns {{ waves: number[][], line: string, summary: string, warning: string|null }}
 *          `warning` is the whole printable line (it starts "warning: ") or null.
 */
export function waveShape(passes) {
  const list = (passes || []).map(p => ({
    n: p.n,
    files: p.files || p.writes || [],
    reads: p.reads || [],
    shared: p.shared || p.shared_resources || [],
    depends: p.depends || p.prerequisites || [],
    status: ""
  }));
  const { lanes } = computeLanes({ passes: list });
  const waves = lanes.map(lane => lane.map(p => p.n));
  const line = "Waves: " + waves.map((w, i) => `${i + 1}) ${w.map(n => `p${n}`).join(", ")}`).join(" · ");
  const count = list.length;
  const summary = `${count} pass${count === 1 ? "" : "es"} in ${waves.length} wave${waves.length === 1 ? "" : "s"}`;

  let warning = null;
  const widest = waves.reduce((m, w) => Math.max(m, w.length), 0);
  if (count >= 3 && widest === 1) {
    const byN = new Map(list.map(p => [p.n, p]));
    const waits = [];
    for (const p of list) {
      for (const d of p.depends) {
        const dep = byN.get(d);
        if (dep && !passesConflict(p, dep)) waits.push(`p${p.n} waits on p${d}`);
      }
    }
    if (waits.length) {
      warning = "warning: every wave is one pass wide. These waits have no file clash — keep each only if the later pass needs the earlier one's output: " + waits.join(", ");
    }
  }
  return { waves, line, summary, warning };
}

export function runLanes({ ARGV, tasks, claimRows }) {
  const needle = positionals(ARGV.slice(1)).join(" ");
  const slug = findTask(tasks, needle);
  if (!slug) {
    console.log(`No task matches "${needle}". Run /one-go to see the list.`);
    process.exit(1);
  }
  const t = tasks[slug];

  // Newest run, if any (scanned directly — runsBySlug from sources.mjs already exists for other
  // commands, but lanes needs full pass objects including files/reads/shared, which the board's
  // rollup view does not carry; state.json is the one place that shape lives).
  let runId = null;
  let running = [];
  let passes = null;
  try {
    const dirs = fs.readdirSync(ONEGO, { withFileTypes: true })
      .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}-/.test(e.name))
      .map(e => e.name).sort((a, b) => b.localeCompare(a));
    for (const d of dirs) {
      const st = readJSONStrict(path.join(ONEGO, d, "state.json"));
      if (st.present && st.value && st.value.slug === slug) { runId = d; passes = st.value.passes || []; break; }
    }
  } catch { /* no runs yet */ }

  if (passes) {
    running = passes.filter(p => isRunningStatus(p.status));
  } else {
    const plansDir = path.join(ONEGO, "plans");
    const { plan, isSealed: sealed } = loadAuthoritativePlan(plansDir, slug, { readOnly: true });
    if (!sealed) {
      console.log(`No sealed plan and no run yet for \`${slug}\`.`);
      console.log(`Run the sealing conversation first, then \`board.mjs lanes ${slug}\` again.`);
      process.exit(1);
    }
    passes = (plan.passes || []).map(p => ({
      n: p.n,
      title: p.purpose || p.title,
      files: p.writes || p.files || [],
      reads: p.reads || [],
      shared: p.shared_resources || p.shared || [],
      depends: p.prerequisites || p.depends || [],
      status: ""
    }));
  }

  // fix D1: the job's own claim rows never hold its own passes back.
  const { lanes, blocked } = computeLanes({ passes, claimRows: foreignClaims(claimRows || [], ownClaimMarks(ONEGO, slug)), running });

  console.log(`# Lanes for \`${slug}\`${t ? ` — ${t.display}` : ""}${runId ? ` · run \`${runId}\`` : " · sealed plan (no run yet)"}\n`);

  if (!lanes.length && !blocked.length) {
    console.log("Nothing left to run — every pass is already done.");
    process.exit(0);
  }

  if (!lanes.length) {
    console.log("Nothing can run right now — every remaining pass is blocked. See below.\n");
  } else {
    lanes.forEach((lane, i) => {
      const label = i === 0 ? "parallel" : `after lane ${i}`;
      console.log(`Lane ${i + 1} (${label}): ${lane.map(p => `p${p.n}`).join(", ")}`);
    });
  }

  if (blocked.length) {
    console.log("");
    for (const b of blocked) console.log(`Blocked: p${b.pass.n} — ${b.reason}`);
    const heldIds = blocked.map(b => (String(b.reason).match(/^held by `([^`]+)`/) || [])[1]).filter(Boolean);
    if (heldIds.length) console.log(`\n${claimWayOut(slug, heldIds)}`);
  }

  process.exit(0);
}
