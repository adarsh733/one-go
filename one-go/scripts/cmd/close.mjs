// cmd/close.mjs — the ONE way a run ends.
//
//   board.mjs close <job|run-id> [--reason "<why>"] [--accept-open]
//
// Every ending goes through closeRun() — `close` itself, watchdog (finalize, ceiling, STOP) and
// `stop`. One place means every ending does the same six things, in this order:
//   1. stamps `ended` (and `ending`, `open_items`) on state.json;
//   2. releases the run's claims through the house claims adapter (off when no claims_file);
//   3. writes report.md with one of the three endings (lib/report.mjs);
//   4. deletes THIS run's ACTIVE.d/<run-id> entry (always) and the legacy ACTIVE (only when it
//      names THIS run) — and COMMIT.lock only when this run owns it;
//   5. updates the job on the board (a run closed with open items waits on the person);
//   6. appends one line to the house worklog when one is configured (never reads it).
//
// The three endings (exact words, CONTRACT §8):
//   COMPLETE                  every pass finished with a check the engine ran, nothing open;
//   FINISHED WITH OPEN ITEMS  the work is over, but something needs a person (parked, --no-check,
//                             phone-only, unproven, reviewer flags). A NORMAL, clean ending — the
//                             run is closed, not left hanging;
//   STOPPED                   halted before the work was over (stop, STOP file, ceiling, or a
//                             close with --reason while passes could still run).
//
// `close` refuses exactly one thing: ending a run that still has work it could do (a pass in
// flight or ready to start) without saying why. `--reason "<why>"` ends it anyway, as STOPPED.
// Refusals write nothing.
import fs from "node:fs";
import path from "node:path";
import { ONEGO, ROOT } from "../lib/paths.mjs";
import { saveBoard, resolveTaskStrict } from "../lib/board-io.mjs";
import { readJSON, readText, stamp, positionals, argValues, globDirs } from "../lib/util.mjs";
import { releaseClaims } from "../lib/claims.mjs";
import { resolveHousePath } from "../lib/config.mjs";
import { ENDINGS, openItems, formatReport, renderChatSummary } from "../lib/report.mjs";
import { isDoneStatus, isStuckStatus, isRunningStatus, isStartableStatus } from "../lib/status.mjs";
import { verifyTask, resolveTaskId, UNVERIFIED_NOTE } from "../lib/task-verify.mjs";
import { writeJSONAtomic, writeFileAtomic } from "../lib/atomic.mjs";
import { runIsGated, staleEvidence } from "../lib/evidence.mjs";
import { readyPasses } from "../lib/graph.mjs";
import { liveRunIds, releaseMarkers } from "../lib/marker.mjs";

/** Flags that take no value — stripped before reading positionals (which skip a flag's value). */
const BOOL_FLAGS = new Set(["--accept-open", "--force", "--apply", "--tidy"]);

export function positionalsOf(argv) {
  return positionals(argv.filter(a => !BOOL_FLAGS.has(a)));
}

/** Handed out and not yet reported back. */
const isInFlight = s => isRunningStatus(s) || s === "launch-requested" || s === "stop-requested";

/** The passes that still have work they could do right now: in flight, or ready to start. */
export function remainingWork(state) {
  const passes = (Array.isArray(state && state.passes) ? state.passes : [])
    .map(p => ({ ...p, depends: p.depends || p.prerequisites || [] }));
  const inFlight = passes.filter(p => isInFlight(p.status));
  const ready = readyPasses(passes, {
    isDone: isDoneStatus, isStuck: isStuckStatus, isRunning: isRunningStatus, isStartable: isStartableStatus
  });
  return { inFlight, ready };
}

/** Is this run already closed? `ended` stamped AND report.md written. */
export function isClosed(runDir, state) {
  return Boolean(state && state.ended) && fs.existsSync(path.join(runDir, "report.md"));
}

/** Delete COMMIT.lock only when this run owns it. An empty lock or another run's lock stays. */
export function releaseLockIfOwned(lockPath, runId) {
  if (!runId || !fs.existsSync(lockPath)) return false;
  let owner = "";
  try { owner = fs.readFileSync(lockPath, "utf-8").trim(); } catch {}
  if (!owner) return false;
  const owns = owner === `owner: ${runId}` || owner === `owner:${runId}` || owner === runId ||
    owner.split(/\r?\n/).some(l => l.trim() === `owner: ${runId}` || l.trim() === runId);
  if (!owns) return false;
  try { fs.unlinkSync(lockPath); return true; } catch { return false; }
}

/**
 * Release this run's stand-down markers (D7, obs 0107/0109): its OWN ACTIVE.d/<run-id> entry goes
 * unconditionally, the legacy single ACTIVE only when it names this run. Other runs' markers are
 * never touched. Returns true when any marker was removed.
 */
export function releaseActiveIfOwned(runId, onegoDir = ONEGO) {
  return releaseMarkers(runId, onegoDir);
}

function claimIdsOf(state) {
  const ids = new Set();
  if (state.claim_id) ids.add(state.claim_id);
  if (Array.isArray(state.claim_ids)) state.claim_ids.forEach(id => id && ids.add(id));
  for (const p of state.passes || []) if (p.claim_id) ids.add(p.claim_id);
  return ids;
}

function isScreenJob(slug, config) {
  const pat = config && config.screen_slug_pattern;
  if (!pat) return false;
  try { return new RegExp(pat).test(slug); } catch { return false; }
}

const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/**
 * End one run. Never throws on a house side-effect (board save, worklog) — those are reported
 * in `warnings`; the run itself is closed either way.
 *
 * @param {object} a
 * @param {string} a.runDir      the run folder
 * @param {object} a.state       its parsed state.json (mutated and written back)
 * @param {string} [a.slug]
 * @param {string} [a.reason]    why it ended (report text; required by the caller for an early end)
 * @param {boolean} [a.acceptOpen]  the conductor/person accepted the open items (recorded)
 * @param {boolean} [a.stopped]  halted before the work was over → STOPPED
 * @param {object} [a.config]    house config (report_extras, worklog, claims_file, screen_slug_pattern)
 * @param {object} [a.house]     house rules (beforeFinished → chat-summary checklist)
 * @param {object} [a.board]     board.json object — the job's row is updated and saved when given
 * @param {string} [a.display]   the job's human name
 * @returns {{ ending, reportPath, released: string[], items, reportText, summary, activeRemoved, warnings: string[] }}
 */
export function closeRun({ runDir, state, slug, reason, acceptOpen = false, stopped = false,
  config = {}, house = {}, board = null, display } = {}) {
  const runId = path.basename(runDir);
  slug = slug || state.slug || runId;
  const tasks = (board && board.tasks) || {};
  const task = tasks[slug];
  const name = display || (task && task.display) || slug;
  const passes = Array.isArray(state.passes) ? state.passes : [];
  const now = stamp();
  const warnings = [];

  // A halted run: whatever was still waiting or in flight is now stopped. Parked, failed and
  // blocked passes keep their status — their question is still the question.
  if (stopped) {
    for (const p of passes) {
      if (isDoneStatus(p.status) || isStuckStatus(p.status)) continue;
      p.status = "stopped";
    }
  }

  // What still needs a person.
  const items = openItems(state, runDir);
  let verification = null;
  if (!stopped) {
    const taskId = resolveTaskId({ task, state });
    const v = verifyTask({ root: ROOT, taskId });
    if (v.configured && !v.accepted) {
      items.push({ kind: "unproven", pass: null, text: `task \`${taskId}\` is not ACCEPTED by the task system: ${v.reason}` });
      verification = `NOT verified — task \`${taskId}\` is not ACCEPTED by the task system: ${v.reason}`;
    } else {
      verification = v.configured ? `verified — task \`${taskId}\` is ACCEPTED by the task system: ${v.reason}` : UNVERIFIED_NOTE;
    }
    if (runIsGated(state)) {
      for (const s of staleEvidence(ROOT, state)) {
        items.push({ kind: "unproven", pass: s.n, text: `pass ${s.n} (${s.title || "—"}) was proved over \`${s.file}\`, which has changed since` });
      }
    }
  }

  const ending = stopped ? ENDINGS.STOPPED : items.length ? ENDINGS.OPEN_ITEMS : ENDINGS.COMPLETE;
  const why = String(reason || "").trim();

  // 1. state.json. The `ended` wording matters to other readers: `start` resumes a run whose
  // `ended` says "stop", and treats "ceiling" as failed; the board reads "stopped".
  if (ending === ENDINGS.STOPPED) {
    const r = why || "stopped";
    state.ended = `${now} — ${/stop|ceiling/i.test(r) ? r : `stopped: ${r}`}`;
  } else if (ending === ENDINGS.OPEN_ITEMS) {
    state.ended = `${now} — finished with ${plural(items.length, "open item")}`;
  } else {
    state.ended = `${now} — completed all ${passes.length} passes`;
  }
  state.ending = ending;
  state.open_items = items;
  if (acceptOpen && items.length) state.open_items_accepted = now;
  delete state.verification_refused;       // the refusal is now an open item, not a hanging run
  writeJSONAtomic(path.join(runDir, "state.json"), state);

  // 2. claims
  let released = [];
  try {
    released = releaseClaims(claimIdsOf(state), slug, runId, `${name} — ${ending.toLowerCase()}`, { config });
  } catch (e) {
    warnings.push(`claims were not released: ${e.message}`);
  }

  // 3. report.md — an older report (written before this close) is kept beside it, never lost.
  const reportPath = path.join(runDir, "report.md");
  if (fs.existsSync(reportPath)) {
    try { fs.copyFileSync(reportPath, path.join(runDir, "report-before-close.md")); } catch {}
  }
  const screenJob = isScreenJob(slug, config);
  const extras = (config && config.report_extras) || [];
  const reportReason = why || (ending === ENDINGS.COMPLETE ? "Completed all passes cleanly"
    : ending === ENDINGS.OPEN_ITEMS ? "Finished — the work is over, some items need a person" : "Stopped");
  let reportText = formatReport(state, runId, slug, name, reportReason, released, verification,
    { extras, ending, items, runDir, screenJob });
  if (acceptOpen && items.length) {
    reportText += `\n_The open items above were accepted at ${now} so the run could close; they stay listed until answered._\n`;
  }
  writeFileAtomic(reportPath, reportText);

  // 4. stand-down marker and commit lock
  const activeRemoved = releaseActiveIfOwned(runId);
  releaseLockIfOwned(path.join(ONEGO, "COMMIT.lock"), runId);

  // 5. the board
  if (task) {
    if (ending === ENDINGS.STOPPED) {
      if (task.stage === "running") task.stage = "waiting";
      const next = passes.find(p => !isDoneStatus(p.status));
      task.next_move = next ? `stopped at pass ${next.n} — carry on with /one-go dispatch ${slug}` : "stopped";
    } else if (ending === ENDINGS.OPEN_ITEMS) {
      task.stage = "waiting";
      task.next_move = `Finished — ${plural(items.length, "thing")} need${items.length === 1 ? "s" : ""} you — /one-go dispatch ${slug}`;
    } else {
      task.stage = "waiting";
      task.next_move = "all passes completed — ready for verification/prove";
    }
    delete task.blocked_reason;
    try { saveBoard(board); } catch (e) {
      warnings.push(`board.json was not updated (${e.message}) — it catches up from the run on the next read`);
    }
  }

  // 6. the worklog — append only, never read, never rewritten
  const worklog = resolveHousePath(config && config.worklog, ROOT);
  if (worklog) {
    const line = `- ${now} · one-go · ${name} (\`${runId}\`) closed — ${ending}` +
      (items.length ? ` · ${plural(items.length, "open item")}` : "") + "\n";
    try { fs.appendFileSync(worklog, line); } catch (e) { warnings.push(`worklog line not written: ${e.message}`); }
  }

  const summary = renderChatSummary(
    { ...state, display: name, slug, run_id: runId, run_dir: runDir },
    { extras, ending, items, checklist: house && house.beforeFinished, ui: screenJob }
  );

  return { ending, reportPath, released, items, reportText, summary, activeRemoved, warnings };
}

/** Print what closeRun did, in the same shape for every caller. */
export function printClosed(runId, res) {
  const icon = res.ending === ENDINGS.COMPLETE ? "✅" : res.ending === ENDINGS.STOPPED ? "⏹" : "🟨";
  const tail = res.ending === ENDINGS.OPEN_ITEMS ? ` — ${plural(res.items.length, "thing")} need${res.items.length === 1 ? "s" : ""} a person` : "";
  console.log(`${icon} Run \`${runId}\` closed — ${res.ending}${tail}.`);
  console.log(`   Report: ${res.reportPath}`);
  if (res.released.length) console.log(`   Released ${plural(res.released.length, "claim")}: ${res.released.map(id => `\`${id}\``).join(", ")}`);
  if (res.activeRemoved) {
    console.log(liveRunIds(ONEGO).length
      ? "   Stand-down marker removed for this run — another run is still live, so the hooks stay stood down."
      : "   Stand-down marker removed — the hooks are back on.");
  }
  for (const w of res.warnings) console.log(`   ⚠ ${w}`);
  console.log("");
  console.log(res.summary);
}

/** Every run folder of a job, newest first: [{ runId, dir, state }]. */
export function runsOf(slug, onegoDir = ONEGO) {
  const out = [];
  for (const runId of globDirs(onegoDir).sort().reverse()) {
    if (runId === "plans" || runId === "scripts" || runId === "archive") continue;
    const dir = path.join(onegoDir, runId);
    const state = readJSON(path.join(dir, "state.json"), null);
    if (state && state.slug === slug) out.push({ runId, dir, state });
  }
  return out;
}

export function runClose(ctx = {}) {
  const ARGV = ctx.ARGV || [];
  const rest = ARGV.slice(1);
  const reason = argValues(rest, "--reason")[0];
  const acceptOpen = rest.includes("--accept-open");
  const target = positionalsOf(rest).join(" ").trim();
  const tasks = ctx.tasks || {};

  // Which run.
  let runId = null, slug = null;
  if (!target) {
    // D7: every live marker (ACTIVE.d first, legacy ACTIVE too). Markers of runs that already
    // ended don't count as live. With several live runs there is no "the" run — name one.
    const marked = liveRunIds(ONEGO);
    const live = marked.filter(id => {
      const st = readJSON(path.join(ONEGO, id, "state.json"), null);
      return !(st && isClosed(path.join(ONEGO, id), st));
    });
    if (live.length > 1) {
      console.log(`More than one run is live: ${live.map(id => `\`${id}\``).join(", ")} — name the one to close: board.mjs close <job|run-id>.`);
      process.exit(1);
    }
    runId = live[0] || (marked.length === 1 ? marked[0] : null);
    if (!runId) {
      console.log("Usage: board.mjs close <job|run-id> [--reason \"<why>\"] [--accept-open] — no run is active to close.");
      process.exit(1);
    }
  } else if (fs.existsSync(path.join(ONEGO, target, "state.json"))) {
    runId = target;
  } else {
    const r = resolveTaskStrict(tasks, target);
    if (r.ambiguous) {
      console.log(`"${target}" could mean more than one job: ${r.ambiguous.map(s => `\`${s}\``).join(", ")} — name it exactly.`);
      process.exit(1);
    }
    if (!r.slug) {
      console.log(`${r.error || `no job matches "${target}"`}. Nothing was closed.`);
      process.exit(1);
    }
    slug = r.slug;
    const runs = runsOf(slug);
    if (!runs.length) {
      console.log(`\`${slug}\` has never run — there is nothing to close.`);
      process.exit(1);
    }
    const newest = runs[0];
    if (isClosed(newest.dir, newest.state)) {
      const older = runs.slice(1).filter(x => !isClosed(x.dir, x.state));
      console.log(`The newest run of \`${slug}\` already ended (${newest.state.ended}). Nothing to do.`);
      if (older.length) {
        console.log(`Older runs of it never closed — close one by its folder name:`);
        for (const o of older) console.log(`  board.mjs close ${o.runId}`);
      }
      process.exit(0);
    }
    runId = newest.runId;
  }

  const runDir = path.join(ONEGO, runId);
  const state = readJSON(path.join(runDir, "state.json"), null);
  if (!state) {
    console.log(`Run \`${runId}\` has no readable state.json — nothing was closed.`);
    process.exit(1);
  }
  if (isClosed(runDir, state)) {
    console.log(`Run \`${runId}\` already ended (${state.ended}). Nothing to do.`);
    releaseActiveIfOwned(runId);     // a marker left behind by an older engine is still cleared
    process.exit(0);
  }

  const stopFile = path.join(runDir, "STOP");
  const stopText = fs.existsSync(stopFile) ? (readText(stopFile) || "").trim() : "";
  let stopped = Boolean(stopText) || fs.existsSync(stopFile);

  const { inFlight, ready } = remainingWork(state);
  if (!stopped && (inFlight.length || ready.length)) {
    if (!reason) {
      const list = [...inFlight.map(p => `pass ${p.n} is ${p.status}`), ...ready.map(p => `pass ${p.n} can start`)];
      console.log(`Not closed: this run still has work it can do (${list.join("; ")}).`);
      console.log(`To end it anyway, as STOPPED: board.mjs close ${slug || state.slug || runId} --reason "<why>"`);
      console.log("Nothing was changed.");
      process.exit(1);
    }
    stopped = true;
  }

  const res = closeRun({
    runDir, state, slug: slug || state.slug, reason: reason || (stopped ? (stopText.replace(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}\s*—\s*/, "") || "stop requested") : ""),
    acceptOpen, stopped, config: ctx.config || {}, house: ctx.house || {}, board: ctx.board || null
  });
  printClosed(runId, res);
  process.exit(0);
}
