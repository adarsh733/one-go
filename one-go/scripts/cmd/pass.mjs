// cmd/pass.mjs — record a pass transition, stamp the heartbeat, release whatever that unblocks.
// Ported from the live skill. Hidden plumbing (CONTRACT §4).
//
// Two refusals from the live skill are kept intact:
//   - an unknown status like "done-but-actually-broken" is refused by name, not read as a
//     near-miss of "done";
//   - the transition that would finish the run is gated on a trusted ACCEPTED when the job has
//     a task_id recorded.
// And two more:
//   D11 `pass alpha 1 done` with no --proven was accepted, and the run then reported COMPLETE
//       with nothing checked anywhere. A pass in a run this engine created must now say what
//       was checked. Runs created by the OLD engine (no `schema` on state.json) are left
//       exactly as they are — their statuses stay historical and self-reported.
//   D5  "done" advanced strictly to pass n+1. It now consults the dependency graph and
//       releases every pass whose prerequisites are met.
//
// Changed for this build (dev/HANDOFFS-BETWEEN-PASSES.md, "from pass 2" and "from pass 3"):
//   - the declared-file existence check now calls the ONE shared resolver, `resolveDeclared`
//     (lib/resolve.mjs), instead of carrying its own copy of the candidate-base search;
//   - `wholeTreeConflict` (lib/evidence.mjs) is asked before running a `--verify` check that
//     reads the whole tree, so a capture/screenshot check can no longer prove a half-built tree
//     while a sibling pass is still writing to it.
//   - `built` (2026-10-03): `pass <job> <n> built` records that the worker finished writing. The
//     pass keeps its slot and files, but no longer counts as writing — so two whole-app passes
//     that built side by side can each run their check without waiting on the other.
import fs from "node:fs";
import path from "node:path";
import { ONEGO, ROOT } from "../lib/paths.mjs";
import { findTask, saveBoard, loadBoard } from "../lib/board-io.mjs";
import { stamp, today, argValues, positionals } from "../lib/util.mjs";
import { readJSONStrict, writeJSONAtomic, writeFileAtomic, reconcileJSON, ConflictError } from "../lib/atomic.mjs";
import { KNOWN_STATUSES, isKnownStatus, isDoneStatus, isStuckStatus, isLiveStatus, isRunningStatus, isStartableStatus, isBuiltStatus } from "../lib/status.mjs";
import { verifyTask, resolveTaskId, UNVERIFIED_NOTE } from "../lib/task-verify.mjs";
import { readyPasses, blockedPasses } from "../lib/graph.mjs";
import { runIsGated, evidenceGap, fingerprintAll, runCheck, recordGap, wholeTreeConflict } from "../lib/evidence.mjs";
import { resolveDeclared } from "../lib/resolve.mjs";
import { looksLikeCommand } from "../lib/plan.mjs";
import { expandPathEntries } from "../lib/pathspec.mjs";
import { confirmAgentToolRoute, isWorkerHost, runsInline, namedModel, chooseHost } from "../lib/route.mjs";
import { loadConfig, DEFAULT_PARALLEL_LIMIT } from "../lib/config.mjs";
import { readSnapshot, outsideChanges, refreshBaseline, describeChange } from "../lib/snapshot.mjs";

import { selectParallelBatch, passesConflict } from "../lib/overlap.mjs";

// Plan cells quote commands in markdown backticks ("`node --test x.mjs`"). The command a
// worker actually passes to --verify never carries them. Compare on the bare command, not the
// markdown around it — a correct command must not be refused for punctuation neither side
// agreed to use.
function stripBackticks(s) {
  return String(s == null ? "" : s).trim().replace(/^`+/, "").replace(/`+$/, "").trim();
}

export function runPass({ ARGV, tasks, runsBySlug, board, config: ctxConfig }) {
  const rest = ARGV.slice(1);
  let config = ctxConfig;
  if (!config) { try { config = loadConfig(ROOT); } catch { config = undefined; } }
  const pos = positionals(rest);
  const target = pos[0];
  const passNum = Number(pos[1]);
  const newStatus = (pos[2] || "").toLowerCase();

  if (!target || isNaN(passNum) || !newStatus) {
    console.log("Usage: board.mjs pass <job> <pass-num> <status> [--commit <hash>] [--proven <what you checked>] [--verify <command to run>] [--parked <why>] [--ran <model the worker named>]");
    console.log("  --proven records WORDS (a note). --verify makes OneGo RUN the command itself and record the exit code — only that ends a run.");
    console.log("  built = the worker finished writing; mark it before running the check, so a whole-app check elsewhere is not held by it.");
    console.log(`Statuses: ${KNOWN_STATUSES.join(", ")}`);
    process.exit(1);
  }

  // Exact match only — not a prefix. "done-but-actually-broken" is not "done".
  if (!isKnownStatus(newStatus)) {
    console.log(`REFUSED: "${newStatus}" is not a status board.mjs pass understands.`);
    console.log(`Known statuses: ${KNOWN_STATUSES.join(", ")}`);
    process.exit(1);
  }

  // `--host <name>`: any configured host, or inline. It decides how the passes this call releases
  // are started; an unknown name is refused with one line listing the known hosts.
  let hostOverride = null;
  if (argValues(rest, "--host")[0]) {
    const pick = chooseHost({ flag: argValues(rest, "--host")[0], config });
    if (pick.error) { console.log(`REFUSED: ${pick.error}`); process.exit(1); }
    hostOverride = pick.host;
  }

  const slug = findTask(tasks, target);
  if (!slug) { console.log(`No task matches "${target}".`); process.exit(1); }

  const runs = (runsBySlug.get(slug) || []).slice().sort((a, b) => String(b.started).localeCompare(String(a.started)));
  const requestedRunId = argValues(rest, "--run")[0];
  const targetRun = requestedRunId
    ? (runs.find(r => r.runId === requestedRunId) || { runId: requestedRunId })
    : runs[0];
  if (!targetRun || !targetRun.runId) {
    console.log(`No runs found for "${(tasks[slug] && tasks[slug].display) || slug}".`);
    process.exit(1);
  }

  const latest = targetRun;
  const runDir = path.join(ONEGO, latest.runId);
  const statePath = path.join(runDir, "state.json");
  const read = readJSONStrict(statePath);              // throws CorruptFileError, caught in board.mjs
  const state = read.present ? read.value : null;
  if (!state) { console.log(`Could not read state.json for run \`${latest.runId}\`.`); process.exit(1); }

  if (state.ended) {
    console.log(`Run \`${latest.runId}\` already ended (${state.ended}).`);
    console.log(`A result arriving now belongs to a run that is over — it cannot change it.`);
    process.exit(1);
  }

  const p = (state.passes || []).find(x => x.n === passNum);
  if (!p) {
    console.log(`Pass ${passNum} not found in run \`${latest.runId}\`. Available: ${(state.passes || []).map(x => x.n).join(", ")}`);
    process.exit(1);
  }

  const t = tasks[slug];
  const gated = runIsGated(state);

  // ---------------------------------------------------------------- D11 · evidence, or no "done"
  if (isDoneStatus(newStatus) && gated) {
    const proven = argValues(rest, "--proven")[0];
    const probe = { ...p, proven: proven != null ? proven : p.proven };
    const gap = evidenceGap(probe);
    if (gap) {
      console.log(`REFUSED: ${gap}.\n`);
      if (p.proven_by) console.log(`  The sealed plan says this pass is proven by: **${p.proven_by}**`);
      console.log(`  Run it, then record what happened:`);
      console.log(`    board.mjs pass ${slug} ${passNum} done --proven "<what you actually checked>"\n`);
      console.log(`  If it cannot be proven, say so honestly instead:`);
      console.log(`    board.mjs pass ${slug} ${passNum} parked --parked "<what is in the way>"\n`);
      console.log(`  Nothing was changed.`);
      process.exit(1);
    }
  }

  // ---------------------------------------------------------------- R5 · prerequisites must be done
  // A pass cannot be marked done while a pass it depends on is still running or pending.
  // Knowing the status spelling is not enough — every entry point must validate accepted prereqs.
  if (isDoneStatus(newStatus)) {
    const prereqs = p.depends || [];
    for (const depN of prereqs) {
      const dep = (state.passes || []).find(x => x.n === depN);
      if (dep && !isDoneStatus(dep.status)) {
        console.log(`REFUSED: pass ${passNum} depends on pass ${depN} (${dep.title || "—"}), which is "${dep.status}", not done.`);
        console.log(`  Finish the prerequisite first.`);
        console.log(`  Nothing was changed.`);
        process.exit(1);
      }
    }
  }

  // ---------------------------------------------------------------- files must exist before "done"
  // The ONE shared resolver (lib/resolve.mjs): absolute paths stay absolute, and "cannot resolve"
  // is only claimed when NOTHING anchors (no file, no folder) — never invented from a false
  // "nothing was built" reading when the folder is simply new.
  // fix D2: only LITERAL declared files must exist, as in the old engine. A glob never blocks
  // `done` (with or without --no-check): a pass may move or rename the folder its glob names.
  if (isDoneStatus(newStatus)) {
    // Braces expanded, markdown stripped (2026-09-28 port): `.claude/company/{a,b}` is two files
    // to look for, not one path that can never exist.
    const declared = expandPathEntries(p.files || []).map(e => e.path);
    const { missing, unresolvable } = resolveDeclared(declared, { requireGlobs: false });
    if (unresolvable) {
      console.log(`REFUSED: cannot resolve any of pass ${passNum}'s ${declared.length} declared files under any candidate base.`);
      console.log(`  This is a path-resolution failure, not proof the files are absent. Nothing was changed.`);
      process.exit(1);
    }
    if (missing.length) {
      console.log(`REFUSED: pass ${passNum} declares ${missing.length} file${missing.length === 1 ? "" : "s"} ` +
        `that ${missing.length === 1 ? "does" : "do"} not exist on disk:`);
      for (const f of missing) console.log(`  - ${f}`);
      console.log(`  Nothing was changed.`);
      process.exit(1);
    }
  }

  // ---------------------------------------------------------------- R1 · run the check ourselves
  // `--verify "<cmd>"` is the only thing that produces proof. OneGo executes it here, in the
  // project root, and records the exit code it actually returned — pass or fail. A failing
  // check is still recorded: the record tells the truth, and the completion gate reads it.
  // The record is bound to this run, this pass, and the attempt this call is about to become,
  // so a later re-run of the pass leaves its old record visibly out of date.
  let freshRecord = null;
  const verifyCmd = argValues(rest, "--verify")[0];
  if (verifyCmd) {
    const requiredCmd = (p.required_check && p.required_check.command) || p.proven_by || "";
    if (requiredCmd && looksLikeCommand(requiredCmd) && stripBackticks(verifyCmd) !== stripBackticks(requiredCmd)) {
      console.log(`REFUSED: command "${verifyCmd}" does not match the approved plan's required check ("${requiredCmd}").`);
      console.log("  The plan's approved check owns verification; an unrelated check cannot substitute for it.");
      console.log("  Nothing was changed.");
      process.exit(1);
    }

    // A whole-tree check (capture/screenshot/journey — lib/evidence.mjs isWholeTreePass) run
    // while a sibling pass is still writing would prove a half-built tree. Refuse before running it.
    const conflict = wholeTreeConflict(state, passNum);
    if (conflict) {
      console.log(`REFUSED: ${conflict.reason}`);
      if (!isBuiltStatus(p.status)) {
        console.log(`  Meanwhile mark this pass finished writing, so it does not hold anyone else's check:`);
        console.log(`    board.mjs pass ${slug} ${passNum} built`);
      }
      console.log(`  Nothing was changed.`);
      process.exit(1);
    }

    const hasActiveAttempt = Boolean(p.attempt_id);
    const attemptNow = hasActiveAttempt ? (p.attempts || 1) : ((p.attempts || 0) + 1);
    console.log(`Running the check for pass ${passNum}: \`${verifyCmd}\``);
    const filesToCheck = Array.from(new Set([...(p.files || []), ...(p.writes || [])]));
    const generatedOutputs = p.generated_outputs || [];
    freshRecord = runCheck({
      root: ROOT, command: verifyCmd, requiredCommand: (looksLikeCommand(requiredCmd) ? requiredCmd : verifyCmd), runId: state.run_id, passN: passNum, attempt: attemptNow, files: filesToCheck, timeoutMs: 40 * 60 * 1000, generatedOutputs
    });
    if (freshRecord.mutated_during_check) {
      console.log("");
      console.log(`REFUSED: a file changed during verification. Fingerprints do not match.`);
      console.log("  Verification cannot bless a mixture of revisions.");
      console.log("  Nothing was changed.");
      process.exit(1);
    }
    console.log(freshRecord.exit_code === 0
      ? `  check PASSED (exit 0)`
      : `  check FAILED (exit ${freshRecord.exit_code})`);
    if (freshRecord.exit_code !== 0 && isDoneStatus(newStatus)) {
      console.log("");
      console.log(`REFUSED: you asked to mark pass ${passNum} done, but the check you gave FAILED.`);
      console.log(`  command: ${verifyCmd}`);
      console.log(`  exit code: ${freshRecord.exit_code}`);
      const tail = String(freshRecord.output_tail || "").trim();
      if (tail) {
        console.log("  last output:");
        for (const line of tail.split(/\r?\n/)) console.log("    " + line);
      }
      console.log("");
      console.log("  Fix the work and run it again, or park the pass honestly:");
      console.log(`    board.mjs pass ${slug} ${passNum} parked --parked "<what is in the way>"`);
      console.log("");
      console.log("  Nothing was changed.");
      process.exit(1);
    }
  }

  // ---------------------------------------------------------------- proof or explicit opt-out, or refuse
  // A "done" must be backed by a passing verification record OneGo actually ran — either the
  // one this call just produced (--verify, above) or one already bound to this pass and
  // attempt from an earlier call — OR an explicit --no-check "<why>" for a pass that genuinely
  // cannot be run (e.g. a read-only review). Neither present → refused. A failing check was
  // already refused earlier, above; this only closes the "said nothing at all" gap.
  const noCheckReason = argValues(rest, "--no-check")[0];
  if (isDoneStatus(newStatus) && gated) {
    const hasFreshPass = Boolean(freshRecord && freshRecord.exit_code === 0);
    const hasExistingPass = !recordGap(p, { runId: state.run_id });
    const hasNoCheck = Boolean(noCheckReason || (p.no_check && p.no_check.reason));
    if (!hasFreshPass && !hasExistingPass && !hasNoCheck) {
      console.log(`REFUSED: pass ${passNum} has neither a passing verification record nor --no-check "<why>".`);
      console.log(`  Run the check yourself and record it:`);
      console.log(`    board.mjs pass ${slug} ${passNum} done --verify "<command>"`);
      console.log(`  Or, if this pass genuinely cannot be run (e.g. a read-only review), say so honestly:`);
      console.log(`    board.mjs pass ${slug} ${passNum} done --no-check "<why this can't be run>"`);
      console.log(`  Nothing was changed.`);
      process.exit(1);
    }
  }

  // ---------------------------------------------------------------- the completing transition
  // A real check this call ran (or already had bound to it) is PROOF and is never thrown away —
  // Gate 2's task-record sentence is a second, appended clause, never a substitution for it.
  // Only when there is no check at all does the note fall back to saying so honestly.
  let verificationNote = null;
  const checkClause = (freshRecord && freshRecord.exit_code === 0)
    ? `check ran: ${freshRecord.command} → exit 0 at ${freshRecord.ran_at}`
    : null;
  if (isDoneStatus(newStatus)) {
    const wouldCompleteRun = (state.passes || []).every(x => x.n === passNum || isDoneStatus(x.status));
    let taskClause = null;
    if (wouldCompleteRun) {
      const taskId = resolveTaskId({ task: t, state });
      const verification = verifyTask({ root: ROOT, taskId });
      if (verification.configured && !verification.accepted) {
        console.log(`REFUSED: pass ${passNum} would finish run \`${latest.runId}\`, but task \`${taskId}\` ` +
          `is not ACCEPTED by the task system.`);
        console.log(`  reason: ${verification.reason}`);
        console.log(`  Get the independent exam + accept first, then mark this pass done. Nothing was changed.`);
        process.exit(1);
      }
      taskClause = verification.configured
        ? `verified — task \`${taskId}\` is ACCEPTED by the task system: ${verification.reason}`
        : null;
    }
    verificationNote = checkClause && taskClause
      ? `${checkClause}; ${taskClause}`
      : (checkClause || taskClause || UNVERIFIED_NOTE);
  }

  // ---------------------------------------------------------------- D8 · nothing written outside, nothing lost
  // Compared with the snapshot `start` took. It FLAGS, never refuses: parallel passes write their
  // own files, so only a file on no running pass's list counts as "outside". A run with no
  // snapshot.json (every run started before D8) is not judged — it says so and carries on.
  let snapLine = null;
  let outside = [];
  if (isDoneStatus(newStatus)) {
    try {
      const snap = readSnapshot(runDir);
      if (!snap) snapLine = "snapshot: not recorded for this run";
      else outside = outsideChanges(snap, state, passNum).changes;
    } catch (e) {
      snapLine = `snapshot: could not be read (${e.message}) — carrying on`;
    }
  }

  // ---------------------------------------------------------------- apply with reconciliation
  const commit = argValues(rest, "--commit")[0];
  const proven = argValues(rest, "--proven")[0];
  const parked = argValues(rest, "--parked")[0] || argValues(rest, "--why")[0];
  const ranModel = (argValues(rest, "--ran")[0] || "").trim();

  let chosen = [];
  let rejected = [];
  let stalled = [];
  let allDone = false;
  let finalPass = p;

  const finalState = reconcileJSON(statePath, (latestState) => {
    const curr = (latestState.passes || []).find(x => x.n === passNum);
    if (!curr) throw new Error(`Pass ${passNum} not found in run \`${latestState.run_id}\``);

    curr.status = newStatus;
    const hasActive = Boolean(curr.attempt_id);
    if (!hasActive) {
      curr.attempts = (curr.attempts || 0) + 1;
    }
    if (verificationNote) curr.verification = verificationNote;
    if (commit) curr.commit = commit;
    if (proven) curr.proven = proven;
    if (ranModel) curr.ran_model = ranModel;
    if (freshRecord) {
      freshRecord.attempt = curr.attempts;
      curr.verification_record = freshRecord;
    }
    if (parked) curr.parked_question = parked;
    else if (newStatus === "done") curr.parked_question = null;

    if (isDoneStatus(newStatus) && (curr.files || []).length) {
      curr.input_fingerprints = fingerprintAll(ROOT, curr.files);
    }

    const curStamp = stamp();
    latestState.heartbeat = curStamp;
    if (noCheckReason) curr.no_check = { reason: noCheckReason, recorded_at: curStamp };
    if (outside.length) {
      const text = `pass ${passNum} (${curr.title || "—"}): ${outside.length} file${outside.length === 1 ? "" : "s"} changed outside its list — ` +
        outside.slice(0, 5).map(c => describeChange(c, ROOT)).join("; ") + (outside.length > 5 ? `; and ${outside.length - 5} more` : "");
      latestState.snapshot_flags = [...(latestState.snapshot_flags || []),
        { pass: passNum, at: curStamp, files: outside.map(c => ({ path: c.path, kind: c.kind })) }];
      latestState.open_items = [...(Array.isArray(latestState.open_items) ? latestState.open_items : []),
        { kind: "outside_write", pass: passNum, text }];
    }

    // D5 · release what this unblocks
    if (hostOverride) latestState.host = hostOverride;
    const opts = { isDone: isDoneStatus, isStuck: isStuckStatus, isRunning: isRunningStatus, isStartable: isStartableStatus };
    const ready = readyPasses(latestState.passes || [], opts);
    const limit = Number(latestState.parallel_limit) || DEFAULT_PARALLEL_LIMIT;
    const running = (latestState.passes || []).filter(x => isRunningStatus(x.status));
    const liveCount = running.length;
    const batch = selectParallelBatch(ready, Math.max(0, limit - liveCount), running);
    chosen = batch.chosen;
    rejected = batch.rejected;
    for (const c of chosen) {
      const real = (latestState.passes || []).find(x => x.n === c.n);
      if (real && isStartableStatus(real.status)) {
        if (isWorkerHost(latestState.host, config)) {
          real.attempts = 1;
          real.attempt_id = `${latestState.run_id}:${real.pass_id}:a${real.attempts}`;
          real.status = "launch-requested";
          real.launch_intent = {
            run_id: latestState.run_id,
            pass_id: real.pass_id,
            attempt_id: real.attempt_id,
            requested_model: namedModel(real.route),
            requested_effort: real.route?.effort || null
          };
        } else {
          real.status = "running";
          if (!runsInline(latestState.host, config)) confirmAgentToolRoute(real.route, real.route?.model, { config });
        }
      }
    }

    stalled = blockedPasses(latestState.passes || [], opts);
    allDone = (latestState.passes || []).every(x => isDoneStatus(x.status));
    finalPass = curr;
    return latestState;
  });

  const curStamp = stamp();
  try { writeFileAtomic(path.join(runDir, "heartbeat.txt"), curStamp + "\n"); } catch {}

  // ---------------------------------------------------------------- write back onto the part
  const applyBoardChanges = (b) => {
    const currTask = b.tasks && b.tasks[slug];
    if (currTask) {
      if (Array.isArray(currTask.subtasks) && p.subtask) {
        const s = currTask.subtasks.find(x => x.id === p.subtask);
        if (s) {
          const siblings = (finalState.passes || []).filter(x => x.subtask === p.subtask);
          const allSiblingsDone = siblings.length > 0 && siblings.every(x => isDoneStatus(x.status));
          if (isDoneStatus(newStatus)) {
            if (allSiblingsDone) { s.stage = "done"; s.updated = today(); s.note = ""; }
            else {
              const left = siblings.filter(x => !isDoneStatus(x.status)).length;
              s.stage = "running"; s.updated = today();
              s.note = `${siblings.length - left}/${siblings.length} passes done`;
            }
          } else if (isStuckStatus(newStatus)) {
            s.stage = "blocked"; s.updated = today();
            if (p.parked_question) s.note = p.parked_question;
          } else if (newStatus === "running" || newStatus === "built") { s.stage = "running"; s.updated = today(); }
        }
      }
      if (allDone) currTask.next_move = `all passes done — /one-go dispatch ${slug} closes it`;
      else if (chosen.length) currTask.next_move = `${chosen.length} pass${chosen.length === 1 ? "" : "es"} now running`;
      else if (stalled.length) currTask.next_move = `${stalled.length} pass${stalled.length === 1 ? "" : "es"} paused — a prerequisite failed`;
      delete currTask.stage_override;
    }
  };

  try {
    applyBoardChanges(board);
    saveBoard(board);
  } catch (err) {
    if (err instanceof ConflictError) {
      const freshBoard = loadBoard();
      applyBoardChanges(freshBoard);
      saveBoard(freshBoard);
    } else {
      throw err;
    }
  }


  // ---------------------------------------------------------------- report
  console.log(`Pass ${passNum} (${finalPass.title}) → ${finalPass.status}` +
    (finalPass.commit ? ` · commit ${finalPass.commit}` : "") +
    (finalPass.proven ? ` · proven: ${finalPass.proven}` : "") +
    (finalPass.parked_question ? ` · parked on: ${finalPass.parked_question}` : ""));
  if (verificationNote) console.log(`Verification: ${verificationNote}`);
  if (finalPass.no_check && finalPass.no_check.reason) console.log(`No-check: ${finalPass.no_check.reason}`);
  console.log(`Heartbeat stamped: ${curStamp}`);
  if (isDoneStatus(newStatus)) {
    if (snapLine) console.log(snapLine);
    else if (!outside.length) console.log("snapshot: nothing written outside, nothing lost");
    else {
      console.log(`WARNING — snapshot: ${outside.length} file${outside.length === 1 ? "" : "s"} changed that are not on pass ${passNum}'s list, ` +
        `nor on any running pass's list:`);
      for (const c of outside.slice(0, 20)) console.log(`   - ${describeChange(c, ROOT)}`);
      if (outside.length > 20) console.log(`   … and ${outside.length - 20} more (all in the run's state.json under snapshot_flags)`);
      console.log(`   Recorded as an open item on the run. Nothing was refused — look at these before you close the run.`);
    }
    // The accepted work becomes the new baseline, so the next pass is judged against it.
    if (!snapLine) { try { refreshBaseline(runDir, passNum, outside); } catch {} }
  }

  if (chosen.length) {
    console.log(`\n▶ Released ${chosen.length} pass${chosen.length === 1 ? "" : "es"} to start now:`);
    for (const c of chosen) console.log(`   ${c.n} — ${c.title} (${c.route ? c.route.model : c.model})`);
  }
  for (const r of rejected) {
    console.log(`   ⏸ pass ${r.pass.n} is ready but ${r.reason}`);
  }
  if (stalled.length) {
    console.log(`\n⏸ Paused because something they need did not finish:`);
    for (const s of stalled) console.log(`   pass ${s.pass.n} — ${s.pass.title}: ${s.reason}`);
    console.log(`   Everything not downstream of that keeps going.`);
  }
  if (allDone) {
    console.log(`\n🎉 All ${state.passes.length} passes finished. Run \`board.mjs close ${slug}\` to finalize.`);
  }
  process.exit(0);
}
