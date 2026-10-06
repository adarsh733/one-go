// cmd/revive.mjs — "which runs never ended, and what is actually true about them"
// Reached as `resume` (cmd/resume.mjs) or `revive` — both silent aliases with every flag. The
// person never needs either: `dispatch` runs the same disk check (`reconcileRun`) on its own
// when the job it resolves to has a run that never ended, then carries that run on.
//
// Why this exists. A run killed mid-flight (usage limit, closed window, crashed host)
// leaves state.json exactly as it was at the last write: lanes still say `running`,
// nothing says the conductor is gone. Observed: two lanes both said `running` — one had
// produced nothing at all, the other had produced its whole file. Same word, opposite truth.
// So the board is a record of INTENT, never of STATE, and after an involuntary stop the only
// honest source is the repo itself.
//
// Modes, all starting from zero knowledge on the reader's part:
//   resume              -> the list. Which runs never ended, newest first, numbered.
//   resume <n|slug>     -> the reconciliation. Every unfinished pass checked against disk.
//   resume --tidy       -> dry-run cleanup (expired claims, ghost claim rows, old run folders).
//
// READ-ONLY by default. `--apply` is the only path that writes: with a run it demotes stale
// `running` lanes to `crashed`; with --tidy it does the cleanup it previewed.
//
// What counts as finished: a run with `ended` stamped AND report.md written (every run closed
// through cmd/close.mjs), or — for runs from the older engine — every pass done AND report.md.
// Anything else is listed, and can be ended one by one with `board.mjs close <run-id>`.
import fs from "node:fs";
import path from "node:path";
import { ONEGO, ROOT } from "../lib/paths.mjs";
import { readJSON, readText, globDirs } from "../lib/util.mjs";
import { isDoneStatus, isStuckStatus, isLiveStatus, isRunningStatus } from "../lib/status.mjs";
import { formatReport, openItems, endingFor, reviewerFlagItems } from "../lib/report.mjs";
import { expireClaims, removeGhostRows } from "../lib/claims.mjs";
import { resolveDeclared } from "../lib/resolve.mjs";
import { positionalsOf } from "./close.mjs";

const STALE_MINUTES = 45;   // beyond this with no beat, a `running` lane belongs to nobody
const CONDUCTOR_STALE_MINUTES = 35; // the addendum's own threshold for "conductor_last_seen"

/** Is `pid` a live OS process right now? EPERM means it exists but we can't signal it — still alive. */
export function isProcessAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return Boolean(e && e.code === "EPERM"); }
}

export function readLiveInfo(dir) {
  return readJSON(path.join(dir, "LIVE.json"), null);
}

/**
 * "Killed", not "slow": true only when BOTH signals agree nobody is coming back — the pid
 * LIVE.json recorded is not a running process right now, AND `conductor_last_seen` (bumped by
 * every watchdog check-in — see cmd/watchdog.mjs) is more than 35 minutes old. A run with no
 * LIVE.json at all (older than this pass, or never started through the current start.mjs) has
 * no liveness record to say otherwise, so it falls back to "gone" — exactly the old, cruder
 * heartbeat-only call this replaces for every run new enough to carry one.
 */
export function isConductorGone(dir, state) {
  const live = readLiveInfo(dir);
  const pidAlive = live && isProcessAlive(live.pid);
  const lastSeenAge = minutesSince(state && state.conductor_last_seen);
  const seenRecently = lastSeenAge != null && lastSeenAge <= CONDUCTOR_STALE_MINUTES;
  return !(pidAlive || seenRecently);
}

/** A closed run: `ended` is stamped AND report.md exists (CONTRACT §5). */
export function isRunFinished(dir, state) {
  return Boolean(state && state.ended) && fs.existsSync(path.join(dir, "report.md"));
}

/** Open lines in the run's reviewer-flags.md (obs 0067: these stall a resume just like a parked pass). */
function flagItemsOf(dir) {
  return reviewerFlagItems(readText(path.join(dir, "reviewer-flags.md")));
}

function minutesSince(text) {
  const m = String(text || "").match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
  return Math.round((Date.now() - t) / 60000);
}
function ago(mins) {
  if (mins == null) return "unknown";
  if (mins < 90) return mins + "m ago";
  if (mins < 60 * 36) return Math.round(mins / 60) + "h ago";
  return Math.round(mins / 1440) + "d ago";
}

// ---------------------------------------------------------------- scan
// Exported so the board can reuse it for the plain-`/one-go` warning line — two scanners would
// disagree, and the one the person sees would be the wrong one (obs 0040).
export function scanRuns() {
  const out = [];
  for (const runId of globDirs(ONEGO).sort().reverse()) {
    if (runId === "plans" || runId === "scripts" || runId === "archive") continue;
    const dir = path.join(ONEGO, runId);
    const state = readJSON(path.join(dir, "state.json"), null);
    if (!state || !Array.isArray(state.passes)) continue;
    const passes = state.passes;
    const done = passes.filter(p => isDoneStatus(p.status)).length;
    const beat = readText(path.join(dir, "heartbeat.txt")) || state.heartbeat || "";
    const beatAge = minutesSince(beat);
    const zombies = passes.filter(p => isRunningStatus(p.status) && (beatAge == null || beatAge > STALE_MINUTES));
    // Nothing stays a zombie: a stale heartbeat alone is not proof the conductor is gone, only
    // that it has been quiet. This is the harder question — is it actually dead? — asked once
    // per run, not printed as a guess wearing the word "killed".
    const conductorGone = zombies.length > 0 ? isConductorGone(dir, state) : false;
    const stuck = passes.filter(p => isStuckStatus(p.status));
    const live = passes.filter(p => isLiveStatus(p.status));
    const hasReport = fs.existsSync(path.join(dir, "report.md"));
    const closed = isRunFinished(dir, state);
    const finished = closed || (done === passes.length && hasReport);
    const flags = flagItemsOf(dir);
    out.push({
      runId, dir, state, passes, done, total: passes.length,
      beat, beatAge, zombies, conductorGone, stuck, live, hasReport, finished, closed,
      ended: state.ended || "", flags,
      title: state.slug || runId
    });
  }
  return out;
}

const plural = (n, one, many = one + "s") => n + " " + (n === 1 ? one : many);

// One line of plain English saying what is outstanding — the whole point of the list.
function outstanding(r) {
  const bits = [];
  if (r.zombies.length) {
    const word = r.conductorGone ? "killed mid-flight" : "stalled — no recent heartbeat, conductor may still be alive";
    bits.push(r.zombies.length + " lane" + (r.zombies.length === 1 ? "" : "s") + " " + word);
  }
  if (r.stuck.length) bits.push(r.stuck.length + " waiting on your answer");
  if (r.flags.length) bits.push(plural(r.flags.length, "reviewer note") + " waiting on your answer");
  const pend = r.live.filter(p => !r.zombies.includes(p)).length;
  if (pend) bits.push(pend + " never started");
  if (r.ended && !r.hasReport) bits.push("ended, but its closing report was never written");
  else if (!bits.length && !r.hasReport) bits.push("work finished, closing report never written");
  return bits.join(" · ") || "nothing outstanding";
}

function printList(runs) {
  const open = runs.filter(r => !r.finished);
  console.log("");
  if (!open.length) {
    console.log("  Every run on this board finished cleanly. Nothing to resume.");
    console.log("");
    return;
  }
  console.log("  " + open.length + " run" + (open.length === 1 ? "" : "s") + " never finished — newest first\n");
  open.forEach((r, i) => {
    const waiting = r.stuck.length || r.flags.length;
    const flag = r.zombies.length ? (r.conductorGone ? "🔴" : "🟠") : waiting ? "🟡" : "⚪";
    // The date is not decoration. A board routinely carries three runs of the same job, and a
    // bare slug makes them indistinguishable — exactly the confusion this command removes.
    const when = (r.state.started || r.runId).slice(0, 16);
    console.log("  " + flag + " " + String(i + 1).padStart(2) + ". " + r.title + "   (" + when + ")");
    console.log("         " + r.done + "/" + r.total + " passes done · last beat " + ago(r.beatAge));
    console.log("         " + outstanding(r));
    console.log("");
  });
  console.log("  🔴 killed mid-flight — its board cannot be trusted, reconcile before anything else");
  console.log("  🟠 stalled — heartbeat is old but the conductor may still be alive, not confirmed dead");
  console.log("  🟡 waiting on a decision from you   ⚪ just never got started\n");
  console.log("  NEXT — pick a number; the agent then runs:");
  console.log("      node <skill>/scripts/board.mjs resume <number>");
  console.log("  That reads the real repo and prints what is actually true. It writes nothing.");
  console.log("  To end one as it stands instead (report, claims released, marker removed):");
  console.log("      node <skill>/scripts/board.mjs close <run folder name>\n");
}

// ---------------------------------------------------------------- reconcile
// Declared files go through the ONE shared resolver (lib/resolve.mjs, obs 0066): absolute paths
// stay absolute, relative ones resolve against the single base under which most of the run's
// files exist, and "nothing and no folder found" is reported as unresolvable, never "missing".
function newestFiles(abs, startAge) {
  if (startAge == null) return [];
  const within = f => {
    try { return Math.round((Date.now() - fs.statSync(f).mtimeMs) / 60000) <= startAge; } catch { return false; }
  };
  if (!/[*?]/.test(abs)) return fs.existsSync(abs) && within(abs) ? [abs] : [];
  const dir = path.dirname(abs), pat = path.basename(abs);
  if (/[*?]/.test(dir)) return [];                   // deep globs: existence only, no freshness list
  const rx = new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
  try { return fs.readdirSync(dir).filter(f => rx.test(f)).map(f => path.join(dir, f)).filter(within); } catch { return []; }
}

/** The disk check `dispatch` runs before carrying a cut-off run on: printOne, read-only, minus
 * its own NEXT block (dispatch prints the run's next step instead). */
export function reconcileRun(r) {
  printOne(r, false, { next: false });
}

function printOne(r, apply, { next = true } = {}) {
  const allDecl = r.passes.flatMap(p => p.files || []);
  const { base } = resolveDeclared(allDecl);
  const startAge = minutesSince(r.state.started);

  console.log("");
  console.log("  " + r.title);
  console.log("  run folder: " + path.relative(ROOT, r.dir));
  console.log("  started " + (r.state.started || "?") + " · last beat " + ago(r.beatAge) +
              " · code read from " + (path.relative(ROOT, base) || "."));
  console.log("  " + r.done + "/" + r.total + " passes marked done" +
              (r.ended ? " · ended " + r.ended : "") +
              (r.hasReport ? "" : " · no closing report was ever written"));
  console.log("");
  console.log("  WHAT THE BOARD SAYS vs WHAT IS ON DISK");
  console.log("  " + "-".repeat(74));

  const demote = [];
  const findings = [];
  for (const p of r.passes) {
    const decl = p.files || [];
    const res = resolveDeclared(decl, { bases: [base] });
    const found = res.resolved.filter(x => x.exists).map(x => x.decl);
    const missing = res.missing;
    const fresh = [];
    for (const x of res.resolved) if (x.exists) for (const f of newestFiles(x.abs, startAge)) { const rel = path.relative(base, f); fresh.push(!rel || rel.startsWith("..") || path.isAbsolute(rel) ? f : rel); }
    let verdict;
    if (isDoneStatus(p.status)) {
      verdict = p.proven || p.verification_record ? "done, and it recorded what it checked"
                         : "marked done but recorded NO proof — re-check this one";
    } else if (!decl.length) {
      verdict = "no files declared — read-only or review pass";
    } else if (res.unresolvable) {
      verdict = "CANNOT RESOLVE — neither its files nor their folders were found; check the paths before the work";
    } else if (!found.length) {
      verdict = "NOT STARTED — none of its files exist";
    } else if (missing.length) {
      verdict = "PARTIAL — " + found.length + "/" + decl.length + " of its files exist";
    } else {
      verdict = "files are all there, but nothing proved them — needs its check run";
    }
    const zombie = r.zombies.includes(p);
    if (zombie) demote.push(p);
    findings.push({ n: p.n, title: p.title || "", verdict, missing, zombie });

    console.log("  Pass " + String(p.n).padStart(2) + "  board: " +
                String(p.status || "?").padEnd(16) + (zombie ? "⚠ nobody is running this" : ""));
    console.log("           " + String(p.title || "").slice(0, 70));
    console.log("           disk : " + verdict);
    if (missing.length) console.log("           " + (res.unresolvable ? "not found: " : "missing: ") + missing.join(", "));
    if (fresh.length) console.log("           written during this run: " + [...new Set(fresh)].join(", "));
    if (p.parked_question) console.log("           waiting on: " + String(p.parked_question).split(".")[0].slice(0, 100) + ".");
    console.log("");
  }

  // Questions the run left for a person — these are the reason a resume stalls again (obs 0067).
  const flags = path.join(r.dir, "reviewer-flags.md");
  const flagsExist = fs.existsSync(flags);
  const parkedN = r.passes.filter(p => p.parked_question || isStuckStatus(p.status)).length;
  if (flagsExist || parkedN) {
    const parts = [];
    if (parkedN) parts.push(plural(parkedN, "parked or failed pass", "parked or failed passes"));
    if (flagsExist) parts.push(plural(r.flags.length, "open reviewer note") + " in " + path.relative(ROOT, flags));
    console.log("  ⚑ Waiting on you: " + parts.join(" · ") + ".");
    for (const t of r.flags.slice(0, 8)) console.log("     - " + t);
    if (r.flags.length > 8) console.log("     … and " + (r.flags.length - 8) + " more");
    console.log("     Answer these in ONE go before relaunching, or it will stop on them again.\n");
  }

  if (demote.length) {
    const verdictWord = r.conductorGone ? "killed" : "stalled — heartbeat is old, but the conductor's pid/last-seen say it may still be alive";
    console.log("  " + demote.length + " lane" + (demote.length === 1 ? "" : "s") +
                " still say \"running\" with nobody running them (" + verdictWord + ").");
    if (apply) {
      const sp = path.join(r.dir, "state.json");
      const st = readJSON(sp, null);
      for (const p of st.passes) {
        if (demote.some(d => d.n === p.n)) {
          p.status = "crashed";
          p.crash_reason = (r.conductorGone
            ? "conductor confirmed gone"
            : "no heartbeat for " + ago(r.beatAge) + ", conductor liveness unconfirmed") +
            " — closing this lane (resume)";
        }
      }
      fs.writeFileSync(sp, JSON.stringify(st, null, 2) + "\n", "utf-8");
      console.log("  ✅ Marked them crashed in state.json. They are now visible as stuck, not in flight.\n");
    } else {
      console.log("  Nothing has been changed. To make the board honest about them, the agent runs:");
      console.log("      node <skill>/scripts/board.mjs resume " + r.runId + " --apply\n");
    }
  }

  const isClean = f => f.verdict.startsWith("done, and it recorded") ||
                        f.verdict === "no files declared — read-only or review pass";
  const hasOutstanding = findings.some(f => !isClean(f)) || demote.length > 0 || r.flags.length > 0;
  if (hasOutstanding && !r.finished) writeResumeBrief(r, findings, demote, flagsExist ? flags : null);

  if (r.finished) {
    console.log("  This run is closed" + (r.ended ? " (" + r.ended + ")" : "") + ". Nothing to resume.\n");
    return;
  }
  if (!next) return;
  console.log("  NEXT — the agent does this, in this order:");
  console.log("    1. Re-run the declared check for every pass marked done with no proof.");
  console.log("    2. Rebuild or finish the lanes marked NOT STARTED / PARTIAL above.");
  console.log("    3. Lanes may BUILD side by side; they may not PROVE side by side — a capture");
  console.log("       reads the whole tree, so run the proving steps one at a time.");
  console.log("    4. Show the person the corrected picture before building anything.");
  console.log("  Or end this run as it stands (report written, claims released, marker removed):");
  console.log("      node <skill>/scripts/board.mjs close " + r.runId + " --reason \"<why>\"\n");
}

// A run killed mid-flight leaves no note that says so. This is that note — regenerated
// every time `resume <n>` runs, never hand-edited, so it is always the reconciliation's
// own findings, not stale prose from an earlier reconcile.
function writeResumeBrief(r, findings, demote, flagsPath) {
  const lines = [];
  lines.push("It was killed mid-flight, so its board is NOT trustworthy. Before doing any work: for");
  lines.push("every lane, check whether its declared files actually exist in the repo and whether its");
  lines.push("declared check actually passes when you run it. Rebuild the board from what you find,");
  lines.push("show me the corrected picture, and stop. Do not build anything until I've seen it.");
  lines.push("");

  const notStarted = findings.filter(f => f.verdict.startsWith("NOT STARTED"));
  const partial = findings.filter(f => f.verdict.startsWith("PARTIAL"));
  const unresolved = findings.filter(f => f.verdict.startsWith("CANNOT RESOLVE"));
  const noProof = findings.filter(f => f.verdict.includes("NO proof"));
  const unproven = findings.filter(f => f.verdict.includes("nothing proved them"));

  if (notStarted.length) {
    lines.push("## Lanes NOT STARTED\n");
    notStarted.forEach(f => lines.push(`- Pass ${f.n} (${f.title || "—"})`));
    lines.push("");
  }
  if (partial.length) {
    lines.push("## Lanes PARTIAL\n");
    partial.forEach(f => {
      lines.push(`- Pass ${f.n} (${f.title || "—"}): ${f.verdict}`);
      if (f.missing.length) lines.push(`  missing: ${f.missing.join(", ")}`);
    });
    lines.push("");
  }
  if (unresolved.length) {
    lines.push("## Lanes whose paths could not be resolved — check the paths first\n");
    unresolved.forEach(f => lines.push(`- Pass ${f.n} (${f.title || "—"}): ${f.missing.join(", ")}`));
    lines.push("");
  }
  if (noProof.length) {
    lines.push("## Marked done but no proof — re-check these\n");
    noProof.forEach(f => lines.push(`- Pass ${f.n} (${f.title || "—"})`));
    lines.push("");
  }
  if (unproven.length) {
    lines.push("## Files exist but nothing proved them\n");
    unproven.forEach(f => lines.push(`- Pass ${f.n} (${f.title || "—"})`));
    lines.push("");
  }
  if (demote.length) {
    lines.push("## Lanes still marked running with nobody running them\n");
    demote.forEach(p => lines.push(`- Pass ${p.n} (${p.title || "—"})`));
    lines.push("");
  }
  if (flagsPath) {
    lines.push(`## Reviewer notes still open (${r.flags.length})\n`);
    r.flags.forEach(t => lines.push(`- ${t}`));
    lines.push("");
    lines.push(`See ${path.relative(r.dir, flagsPath)} — answer these before relaunching.\n`);
  }

  lines.push("Lanes may BUILD side by side; they may not PROVE side by side — a capture reads the");
  lines.push("whole tree, so run the proving steps one at a time.");
  lines.push("");

  fs.writeFileSync(path.join(r.dir, "RESUME-BRIEF.md"), lines.join("\n"), "utf-8");
}

// ---------------------------------------------------------------- tidy
// Cleanup, and it ARCHIVES, never deletes a run. Never touches a run with a 🔴 or 🟡 flag,
// whatever its age. `--apply` is the only path that moves anything; without it, this is a dry
// run — printing what would happen, changing nothing on disk.
const TIDY_DAYS = 14;

function daysSince(text) {
  const m = String(text || "").match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
  return (Date.now() - t) / 86400000;
}

function runTidy({ apply, config }) {
  const runs = scanRuns();
  console.log("");
  console.log(apply ? "  Tidying the board — archiving what is safe to archive." :
                       "  DRY RUN — nothing on disk changes. Add --apply to actually move anything.");
  console.log("");

  // Ghost claim rows first (obs 0089): an Active row whose id is already under "Recently
  // released". The release record stays; only the stale copy that still blocks is removed.
  const ghosts = removeGhostRows({ dryRun: true, config });
  if (ghosts.removed.length) {
    console.log("  " + plural(ghosts.removed.length, "ghost claim row") + " (already released, still listed as active)" +
                (apply ? " — removing" : " — would remove") + ": " + ghosts.removed.join(", "));
    if (apply) removeGhostRows({ dryRun: false, config });
    console.log("");
  }

  // Expire dark claims BEFORE archiving anything below — archiving a run folder moves it under
  // ONEGO/archive, and expireClaims looks for run folders at the top level (see
  // lib/claims.mjs findRunForClaim). Doing this after the archive loop would make a run's own
  // "safe to archive" tidy pass hide it from the claim it was still holding open.
  const expiredPreview = expireClaims(ONEGO, { dryRun: true, config });
  if (expiredPreview.length) {
    console.log("  " + expiredPreview.length + " claim" + (expiredPreview.length === 1 ? "" : "s") +
                " expired (no live conductor, heartbeat over 12h old)" +
                (apply ? " — releasing" : " — would release"));
    if (apply) {
      const released = expireClaims(ONEGO, { dryRun: false, config });
      console.log("     released: " + released.join(", "));
    }
    console.log("");
  }

  if (!runs.length) {
    console.log("  No runs on this board yet.\n");
    process.exit(0);
  }

  let touched = 0;
  for (const r of runs) {
    if (r.zombies.length || r.stuck.length || r.flags.length) {
      console.log("  ⏭  " + r.title + "   (" + r.runId + ") — 🔴/🟡 flagged, never touched by tidy");
      continue;
    }

    const age = daysSince(r.state.ended || r.state.started);
    const isFinishedShape = r.done === r.total;

    if (isFinishedShape && !r.hasReport) {
      console.log("  📝 " + r.title + "   (" + r.runId + ") — finished, no report.md" +
                  (apply ? " — writing one" : " — would write one"));
      if (apply) {
        const items = openItems(r.state, r.dir);
        const ending = endingFor(r.state, { items });
        const text = formatReport(r.state, r.runId, r.title, r.title,
          "Completed (closed by resume --tidy)", [], null, { ending, items, runDir: r.dir });
        fs.writeFileSync(path.join(r.dir, "report.md"), text, "utf-8");
      }
    }

    if (age != null && age > TIDY_DAYS) {
      console.log("  📦 " + r.title + "   (" + r.runId + ") — " + Math.round(age) + "d old" +
                  (apply ? " — archiving" : " — would archive"));
      if (apply) {
        const archiveDir = path.join(ONEGO, "archive");
        fs.mkdirSync(archiveDir, { recursive: true });
        fs.renameSync(r.dir, path.join(archiveDir, r.runId));
      }
      touched++;
    } else {
      console.log("  ·  " + r.title + "   (" + r.runId + ") — kept, not old enough to archive");
    }
  }

  console.log(apply ? "  Done. " + touched + " run" + (touched === 1 ? "" : "s") + " archived." :
                       "  Dry run complete. Re-run with --apply to actually move anything.");
  console.log("");
  process.exit(0);
}

// ---------------------------------------------------------------- entry
export function runRevive(ctx = {}) {
  const ARGV = ctx.ARGV || [];
  const config = ctx.config || {};
  if (ARGV.includes("--tidy")) return runTidy({ apply: ARGV.includes("--apply"), config });
  const apply = ARGV.includes("--apply");
  const args = positionalsOf(ARGV.slice(1));

  // `--apply` with no run number used to fall straight through to the read-only list, write
  // nothing, and exit 0 — the flag looked accepted but was silently inert. Refuse instead: a
  // demotion with no named target is exactly the kind of guess this command never makes.
  if (apply && !args.length) {
    console.log("\n  `resume --apply` needs a run number or name — I will not guess which run to");
    console.log("  demote. Run `resume` with no flags to see the numbered list, then:");
    console.log("      node <skill>/scripts/board.mjs resume <number> --apply\n");
    console.log("  Nothing was written.\n");
    process.exit(1);
  }

  const runs = scanRuns();

  if (!runs.length) {
    console.log("\n  No runs on this board yet.\n");
    process.exit(0);
  }
  if (!args.length) { printList(runs); process.exit(0); }

  const open = runs.filter(r => !r.finished);
  const pick = args.join(" ").trim();
  let r = null;
  if (/^\d+$/.test(pick)) r = open[+pick - 1];
  if (!r) {
    const needle = pick.toLowerCase();
    const exact = runs.filter(x => x.runId.toLowerCase() === needle);
    const hits = exact.length ? exact : runs.filter(x => x.runId.toLowerCase().includes(needle) || x.title.toLowerCase().includes(needle));
    if (hits.length === 1) r = hits[0];
    else if (hits.length > 1) {
      console.log("\n  \"" + pick + "\" matches " + hits.length + " runs — say which:\n");
      hits.forEach(h => console.log("    " + h.runId));
      console.log("");
      process.exit(1);
    }
  }
  if (!r) {
    console.log("\n  No run matches \"" + pick + "\". Run resume with no argument for the list.\n");
    process.exit(1);
  }
  printOne(r, apply);
  process.exit(0);
}
