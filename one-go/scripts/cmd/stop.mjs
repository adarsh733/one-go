// cmd/stop.mjs — `/one-go stop [<job>]`: stop now. Every stop ends through cmd/close.mjs.
//
// Carried over from the older engine. What changed: the report, the `ended` stamp, the claim
// release, the ACTIVE removal and the board update are no longer done here by hand — they are
// closeRun()'s job, so a stopped run ends exactly like every other run (ending: STOPPED).
//
// Two cases, as before:
//   - workers still running → their passes become `stop-requested`, a STOP file is written and
//     the run waits for them to report. It does not hang: `next` sees the STOP file and hands the
//     conductor `board.mjs close <job> --reason "stop requested"`, and a watchdog check closes it
//     too;
//   - nothing running → closed now, STOPPED.
// Parked, failed and blocked passes keep their status (their question is still the question).
// `stop` never claims a run is complete, so it needs no task verification gate.
import fs from "node:fs";
import path from "node:path";
import { ONEGO } from "../lib/paths.mjs";
import { resolveTaskStrict, saveBoard } from "../lib/board-io.mjs";
import { readJSON, stamp } from "../lib/util.mjs";
import { writeJSONAtomic } from "../lib/atomic.mjs";
import { isBuiltStatus } from "../lib/status.mjs";
import { closeRun, printClosed, isClosed, positionalsOf } from "./close.mjs";

const REASON = "Stopped by /one-go stop";

export function runStop(ctx = {}) {
  const { ARGV = [], tasks = {}, runsBySlug = new Map(), board = null, config = {}, house = {} } = ctx;
  const rest = ARGV.slice(1);
  const target = positionalsOf(rest).join(" ").trim();

  const candidates = [];
  if (target && fs.existsSync(path.join(ONEGO, target, "state.json"))) {
    const st = readJSON(path.join(ONEGO, target, "state.json"), {});
    candidates.push({ slug: st.slug || target, runId: target });
  } else if (target) {
    const r = resolveTaskStrict(tasks, target);
    if (r.ambiguous) {
      console.log(`"${target}" could mean more than one job: ${r.ambiguous.map(s => `\`${s}\``).join(", ")} — name it exactly.`);
      process.exit(1);
    }
    if (!r.slug) {
      console.log(`No job matches "${target}". Run /one-go to see the list.`);
      process.exit(1);
    }
    const runs = (runsBySlug.get(r.slug) || []).slice().sort((a, b) => String(b.started).localeCompare(String(a.started)));
    if (!runs.length) {
      console.log(`No runs found for "${(tasks[r.slug] && tasks[r.slug].display) || r.slug}".`);
      process.exit(1);
    }
    candidates.push({ slug: r.slug, runId: runs[0].runId });
  } else {
    for (const [slug, runs] of runsBySlug) {
      const latest = runs.slice().sort((a, b) => String(b.started).localeCompare(String(a.started)))[0];
      if (!latest) continue;
      if (latest.stage === "running" || (!latest.ended && (latest.stage === "blocked" || latest.stage === "waiting"))) {
        candidates.push({ slug, runId: latest.runId });
      }
    }
  }

  if (!candidates.length) {
    console.log("Nothing running right now to stop.");
    process.exit(0);
  }

  for (const c of candidates) {
    const runDir = path.join(ONEGO, c.runId);
    const statePath = path.join(runDir, "state.json");
    const state = readJSON(statePath, null);
    const t = tasks[c.slug] || { display: c.slug };

    if (!state) {
      console.log(`Could not read state.json for run \`${c.runId}\`.`);
      continue;
    }
    if (isClosed(runDir, state)) {
      if (target) console.log(`Run \`${c.runId}\` (${t.display || c.slug}) already ended (${state.ended}). Nothing to stop.`);
      continue;
    }

    const passes = Array.isArray(state.passes) ? state.passes : [];
    const stopTime = stamp();

    if (passes.some(p => p.status === "running")) {
      for (const p of passes) {
        if (p.status === "running") {
          p.status = "stop-requested";
          p.stop_intent = {
            run_id: c.runId,
            pass_id: p.pass_id,
            attempt_id: p.attempt_id,
            worker_id: p.worker?.id || null,
            requested_at: new Date().toISOString()
          };
        } else if (isBuiltStatus(p.status) || p.status === "launch-requested" || p.status === "queued" || p.status === "pending") {
          p.status = "stopped";
        }
      }
      writeJSONAtomic(statePath, state);
      try { fs.writeFileSync(path.join(runDir, "STOP"), `${stopTime} — ${REASON}\n`); } catch {}
      if (tasks[c.slug] && board) {
        tasks[c.slug].stage = "waiting";
        tasks[c.slug].next_move = "stop requested — closes once the running workers report";
        try { saveBoard(board); } catch { /* the board catches up from the run on the next read */ }
      }
      console.log(`⏹ Stop requested for \`${c.runId}\` (${t.display || c.slug}). Workers still running: ` +
        passes.filter(p => p.status === "stop-requested").map(p => `pass ${p.n}`).join(", ") + ".");
      console.log(`   When they report (or are gone), end it: board.mjs close ${c.slug} --reason "stop requested"`);
      console.log("");
      continue;
    }

    try { fs.writeFileSync(path.join(runDir, "STOP"), `${stopTime} — ${REASON}\n`); } catch {}
    const res = closeRun({ runDir, state, slug: c.slug, reason: REASON, stopped: true, config, house, board, display: t.display });
    printClosed(c.runId, res);
  }

  process.exit(0);
}
