// cmd/watchdog.mjs — heartbeat freshness, stall detection, ceiling guard, clean finalize.
// Carried over from the older engine and changed in one way that matters: EVERY ending here goes
// through cmd/close.mjs closeRun() — the STOP file, the ceiling and the finalize — so every ending
// writes report.md, stamps `ended`, releases claims, deletes ACTIVE (only when it names this run)
// and updates the board, exactly like `close` and `stop` do.
//
// Finalize. When every pass reports done:
//   - nothing open                              → closes COMPLETE;
//   - only DECLARED open items (a pass done with --no-check, phone-only proof, a reviewer flag)
//                                               → closes FINISHED WITH OPEN ITEMS — a normal ending;
//   - a real gap (done with no check the engine ran, stale evidence, a task the task system
//     would not ACCEPT)                         → refuses, exactly as before, and prints the one
//     command that closes it anyway as FINISHED WITH OPEN ITEMS (`--accept-open`). A refusal
//     never leaves the conductor without a way to end the run.
// A run whose passes are parked is not "all done"; `next` sends the conductor to `close`, which
// ends it FINISHED WITH OPEN ITEMS.
import fs from "node:fs";
import path from "node:path";
import { ONEGO, ROOT } from "../lib/paths.mjs";
import { saveBoard, resolveTaskStrict } from "../lib/board-io.mjs";
import { readText, readJSON, stamp, argValues } from "../lib/util.mjs";
import { liveRunIds } from "../lib/marker.mjs";
import { isDoneStatus, isLiveStatus, isRunningStatus, isBuiltStatus } from "../lib/status.mjs";
import { verifyTask, resolveTaskId } from "../lib/task-verify.mjs";
import { writeJSONAtomic } from "../lib/atomic.mjs";
import { runIsGated, staleEvidence, verificationGaps } from "../lib/evidence.mjs";
import { openItems } from "../lib/report.mjs";
import { isDeadlineExpired, createLaunchIntent, MAX_ATTEMPTS } from "../lib/worker.mjs";
import { namedModel } from "../lib/route.mjs";
import { isConductorGone } from "./revive.mjs";
import { closeRun, printClosed, isClosed, releaseActiveIfOwned, positionalsOf, runsOf } from "./close.mjs";

/** Open items the conductor already DECLARED when recording a pass — they never block a close. */
const DECLARED = new Set(["no_check", "phone_only", "reviewer_flag"]);

/**
 * D7 (obs 0107, 0109): which run(s) does this call act on?
 *   - `watchdog <job|run-id>` acts on THAT run only (a job → its newest run, preferring a live one);
 *   - no argument → every live marker (ACTIVE.d/*, legacy ACTIVE), each handled on its own merits.
 * It never takes "the first marker it finds" as the caller's run, and never touches a run it was
 * not pointed at or did not find live.
 */
export function runWatchdog(ctx = {}) {
  const { ARGV = [], tasks = {} } = ctx;
  const rest = ARGV.slice(1);
  const target = positionalsOf(rest).join(" ").trim();

  let runIds = [];
  if (target) {
    if (fs.existsSync(path.join(ONEGO, target, "state.json"))) {
      runIds = [target];
    } else {
      const r = resolveTaskStrict(tasks, target);
      if (r.ambiguous) {
        console.log(`"${target}" could mean more than one job: ${r.ambiguous.map(s => `\`${s}\``).join(", ")} — name it exactly.`);
        process.exit(1);
      }
      if (!r.slug) {
        console.log(`${r.error || `no job matches "${target}"`}. Nothing was checked.`);
        process.exit(1);
      }
      const runs = runsOf(r.slug);
      if (!runs.length) {
        console.log(`\`${r.slug}\` has never run — nothing to check.`);
        process.exit(0);
      }
      const live = new Set(liveRunIds(ONEGO));
      const open = runs.filter(x => !isClosed(x.dir, x.state));
      runIds = [(open.find(x => live.has(x.runId)) || open[0] || runs[0]).runId];
    }
  } else {
    runIds = liveRunIds(ONEGO);
    if (!runIds.length) {
      const legacy = path.join(ONEGO, "ACTIVE");
      if (fs.existsSync(legacy)) {
        console.log("ACTIVE flag was empty — removing.");
        try { fs.unlinkSync(legacy); } catch {}
        process.exit(0);
      }
      console.log("No active run — all quiet.");
      process.exit(0);
    }
  }

  // --accept-open means "close THIS run anyway"; with several runs and no name it would close
  // runs the caller never looked at, so it only applies when exactly one run is being handled.
  const several = runIds.length > 1;
  let ARGV2 = ARGV;
  if (several && ARGV.includes("--accept-open")) {
    ARGV2 = ARGV.filter(a => a !== "--accept-open");
    console.log("Several runs are live — --accept-open is ignored; name the run: board.mjs watchdog <job|run-id> --accept-open.\n");
  }

  let worst = 0;
  for (const id of runIds) {
    if (several) console.log(`── ${id} ──`);
    const code = watchRun(id, { ...ctx, ARGV: ARGV2 });
    if (code > worst) worst = code;
    if (several) console.log("");
  }
  process.exit(worst);
}

/** One run's watchdog pass. Returns the exit code instead of exiting, so the next run still gets its turn. */
function watchRun(runId, { ARGV = [], tasks = {}, board = null, config = {}, house = {} } = {}) {
  const runDir = path.join(ONEGO, runId);
  const statePath = path.join(runDir, "state.json");
  const state = readJSON(statePath, null);
  if (!state) {
    console.log(`Run directory \`${runId}\` missing state.json.`);
    return 1;
  }

  // A marker naming a run that already ended (left behind by an older engine) only keeps the
  // hooks stood down for nothing — clear it, and touch nothing else.
  if (isClosed(runDir, state)) {
    releaseActiveIfOwned(runId);
    console.log(`Run \`${runId}\` already ended (${state.ended}) — its stand-down marker was left behind and is now removed.`);
    return 0;
  }

  const slug = state.slug || runId;
  const acceptOpen = ARGV.includes("--accept-open");
  const closeWith = opts => closeRun({ runDir, state, slug, config, house, board, ...opts });

  // Every watchdog invocation IS the conductor checking in — a signal heartbeat.txt (written by
  // pass/worker activity, a different actor) cannot give on its own. `conductorGoneBefore` reads
  // the value from BEFORE this stamp, so the stall check below (§4) reports what was actually
  // true going into this call, not a verdict this very call just made true.
  const conductorGoneBefore = isConductorGone(runDir, state);
  state.conductor_last_seen = stamp();
  writeJSONAtomic(statePath, state);

  // 1. STOP sentinel → close, STOPPED.
  const stopFile = path.join(runDir, "STOP");
  if (fs.existsSync(stopFile)) {
    const stopReason = (readText(stopFile) || "").trim()
      .replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}\s*—\s*/, "") || "STOP sentinel detected";
    const res = closeWith({ reason: stopReason, stopped: true });
    console.log(`⏹ Run \`${runId}\` halted by STOP sentinel.\n`);
    printClosed(runId, res);
    return 0;
  }

  // 2. Every pass reports done → finalize through close.
  const isDone = p => isDoneStatus(p.status);
  const passes = Array.isArray(state.passes) ? state.passes : [];
  const allDone = passes.length > 0 && passes.every(isDone);
  if (allDone) {
    // Real gaps: a done pass with no check the engine ran (and no declared reason), evidence
    // gone stale, a task the task system would not ACCEPT. Declared items (--no-check,
    // phone-only, reviewer flags) are not gaps — they close as FINISHED WITH OPEN ITEMS.
    const hard = openItems(state, runDir).filter(i => !DECLARED.has(i.kind)).map(i => i.text);
    const taskId = resolveTaskId({ task: tasks[slug], state });
    const verification = verifyTask({ root: ROOT, taskId });
    if (verification.configured && !verification.accepted) {
      hard.push(`task \`${taskId}\` is not ACCEPTED by the task system: ${verification.reason}`);
    }
    if (runIsGated(state)) {
      for (const st of staleEvidence(ROOT, state)) {
        hard.push(`pass ${st.n} (${st.title}) was proved over \`${st.file}\`, which has changed since`);
      }
    }

    if (hard.length && !acceptOpen) {
      // Recorded on state.json (never `ended`) so the board reads this run as blocked, not done.
      state.verification_refused = `not complete: ${hard[0]}`;
      writeJSONAtomic(statePath, state);
      if (tasks[slug] && board) {
        tasks[slug].stage = "blocked";
        tasks[slug].blocked_reason = state.verification_refused;
        tasks[slug].next_move = `resume — ${state.verification_refused}`;
        try { saveBoard(board); } catch { /* the board catches up from state.json on the next read */ }
      }
      console.log(`⛔ WATCHDOG REFUSED TO FINALIZE: every pass reports done, but the run cannot show its work.\n`);
      for (const g of hard) console.log(`   - ${g}`);
      console.log(`\n   Either have one-go RUN the check, not describe it:`);
      console.log(`     board.mjs pass ${slug} <n> done --verify "<command that proves it>"`);
      console.log(`   or close the run now as FINISHED WITH OPEN ITEMS (the gaps stay listed for the person):`);
      console.log(`     board.mjs watchdog ${runId} --accept-open      (same as: board.mjs close ${slug})`);
      console.log(`   Nothing is marked ended yet; the board shows this job as blocked until one of those runs.`);
      return 1;
    }

    const res = closeWith({ acceptOpen, reason: hard.length ? "Every pass reports done — open items accepted to close" : "" });
    printClosed(runId, res);
    return 0;
  }


  // 3. Ceiling — checked BEFORE the stall check, which is the D9 fix.
  //
  // Reproduced 2026-09-08: a run seven days past its 8h ceiling was never halted, because the
  // stale heartbeat made the stall check exit first and the ceiling check sat BELOW it and was
  // never reached. A deadline has to hold whether or not the worker is still talking to us —
  // a silent worker is exactly when a deadline matters most.
  if (state.started) {
    const startT = Date.parse(state.started);
    const limitHours = Number(state.ceiling_hours) || 8;
    if (!isNaN(startT)) {
      const elapsedHours = (Date.now() - startT) / 3600000;
      if (elapsedHours > limitHours) {
        const res = closeWith({ reason: `${limitHours}h ceiling expired`, stopped: true });
        console.log(`⛔ Run \`${runId}\` exceeded its ${limitHours}-hour ceiling (${elapsedHours.toFixed(1)}h elapsed). Halted.\n`);
        printClosed(runId, res);
        return 1;
      }
    }
  }

  // 3b. Worker deadline check — a worker deadline wins even when its heartbeat is fresh.
  // Enforces at most two retries (total 3 attempts).
  for (const p of passes) {
    // A built pass's worker has finished writing: its deadline is moot and relaunching it would
    // redo finished work. Nudge the conductor to run its check instead.
    if (isBuiltStatus(p.status) && p.worker && isDeadlineExpired(p.worker)) {
      console.log(`⏳ Pass ${p.n} (${p.title}) is built · check still pending — its worker is done; run its check: board.mjs pass ${slug} ${p.n} done --proven "<what was checked>" --verify "<Proven by cell>"`);
      continue;
    }
    if (isRunningStatus(p.status) && !isBuiltStatus(p.status) && p.worker && isDeadlineExpired(p.worker)) {
      const attempts = Number(p.attempts) || 1;
      const maxAttempts = Math.min(MAX_ATTEMPTS, Number(state.retry_policy?.max_attempts) || MAX_ATTEMPTS);
      if (attempts < maxAttempts) {
        p.attempts = attempts + 1;
        p.attempt_id = `${runId}:${p.pass_id}:a${p.attempts}`;
        p.status = "launch-requested";
        p.launch_intent = createLaunchIntent({
          runId,
          passId: p.pass_id,
          attemptId: p.attempt_id,
          requestedModel: namedModel(p.route),
          requestedEffort: p.route?.effort || null
        });
        delete p.worker;
        writeJSONAtomic(statePath, state);
        console.log(`⛔ Worker deadline expired for pass ${p.n} (${p.title}) — attempt ${attempts}/${maxAttempts}. Requesting retry ${p.attempts}.`);
        return 1;
      } else {
        p.status = "failed";
        p.parked_question = `Worker deadline expired: attempts exhausted (${attempts}/${maxAttempts})`;
        writeJSONAtomic(statePath, state);
        console.log(`⛔ Worker deadline expired for pass ${p.n} (${p.title}) — retries exhausted (${attempts}/${maxAttempts}). Pass failed.`);
        return 1;
      }
    }
  }

  // 4. Heartbeat freshness check (> 35m) — liveness, not a deadline.
  const heartbeatFile = path.join(runDir, "heartbeat.txt");
  const heartbeatText = (readText(heartbeatFile) || state.heartbeat || "").trim();
  let ageMinutes = 0;
  if (heartbeatText) {
    const tStamp = Date.parse(heartbeatText);
    if (!isNaN(tStamp)) ageMinutes = Math.floor((Date.now() - tStamp) / 60000);
  }

  const maxMinutes = Number(argValues(ARGV.slice(1), "--max-minutes")[0]) || 35;
  const isLive = p => isLiveStatus(p.status);
  const livePass = passes.find(isLive);

  if (ageMinutes > maxMinutes && livePass) {
    // Same test as cmd/revive.mjs isConductorGone: a stale worker heartbeat is not, by itself,
    // proof the conductor is gone — only that the WORKER has gone quiet. Say which one this is.
    const label = conductorGoneBefore
      ? "⚠️ CONDUCTOR GONE, WORKER STALLED"
      : "⚠️ STALL DETECTED (worker slow — the conductor is still checking in)";
    console.log(`${label}: Run \`${runId}\` heartbeat is ${ageMinutes}m old (limit: ${maxMinutes}m).`);
    console.log(`Stalled on pass ${livePass.n} (${livePass.title} · ${livePass.model}).`);
    console.log(`Resume with: board.mjs pass ${slug} ${livePass.n} running`);
    return 2;
  }

  // 5. Still going
  const doneCount = passes.filter(isDone).length;
  console.log(`🟢 Run \`${runId}\`: heartbeat ${ageMinutes}m ago · ${doneCount}/${passes.length} passes done` +
    (livePass ? ` · on pass ${livePass.n} (${livePass.title})` : "") + `.`);
  console.log(`   That is the heartbeat FILE. Nothing here has confirmed a worker is alive — a recent
   timestamp in a text file is not proof of work.`);
  return 0;
}
