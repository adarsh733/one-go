// lib/sources.mjs — merges every read-only source into `tasks`, plus the run/claim/loop
// side-tables the command modules need. Pass statuses are classified by exact match (lib/status.mjs).
//
// Core sources (always on): plans/*.md State: lines, and every run folder's state.json.
// House sources (off unless config.json names them — see lib/config.mjs and lib/house.mjs):
// frozen screens (frozen_dirs), the claims board (claims_file), the open-loops and pending-push
// files (extra_sources), and the backup sweep (sweep_dirs). No project folder name lives here.
import fs from "node:fs";
import path from "node:path";
import { ROOT, ONEGO, BOARD_PATH } from "./paths.mjs";
import { readText, readJSON, globDirs, globFiles, today } from "./util.mjs";
import { saveBoard } from "./board-io.mjs";
import { loadConfig, resolveHousePath } from "./config.mjs";
import { listFrozenScreens, readClaims, readExtraSources } from "./house.mjs";
import { rollup } from "./render.mjs";
import { isDoneStatus, isStuckStatus, isLiveStatus } from "./status.mjs";

function ensureTask(tasks, slug, seed) {
  if (!tasks[slug]) tasks[slug] = { display: seed.display || slug, source: seed.source || "manual", subtasks: [] };
  const cur = tasks[slug];
  // A task already proven done is never dragged back by a stale plan header.
  if (cur.stage === "done" && seed.stage && seed.stage !== "done") delete seed.stage;
  // A task whose subtasks are the truth never takes a stage or a count from a run file —
  // blocked_reason and pending_questions belong on this list too: a hand-corrected subtask
  // was getting its top-level blocked_reason and
  // question count dragged straight back from the old run-file seed on the very next read.
  if (Array.isArray(cur.subtasks) && cur.subtasks.length) {
    delete seed.stage; delete seed.passes_done; delete seed.passes_total; delete seed.next_move;
    delete seed.blocked_reason; delete seed.pending_questions;
  }
  if (seed.next_move === "" || seed.next_move == null) delete seed.next_move;
  Object.assign(cur, seed);
}

// Builds every read-only source into `tasks` (mutated in place), and returns the side-tables
// the command modules need. Runs for every command except the WRITE COMMANDS
// (add/sub/done/stage), exactly as the original file's top-level flow did.
//
// `persist` decides whether the merged view is written back to board.json. It defaults to
// FALSE, which is the fix for D1 (reproduced 2026-09-08): the bare board, `info`, `status`,
// a `finish` preview and every refusal used to rewrite board.json just by being run, so
// looking at the board changed it. The derived view is still computed and printed exactly as
// before — only the write is gone. Commands that genuinely change something (start, pass,
// watchdog, stop) pass persist:true.
//
// `config` is the loadConfig() result; when omitted it is loaded here (a bad config.json throws
// ConfigError — never silently read as "no house features").
export function gatherSources({ board, tasks, persist = false, config }) {
  if (!config) config = loadConfig(ROOT);
  // 1 · plans/*.md — the State: line
  const plansDir = path.join(ONEGO, "plans");
  for (const f of globFiles(plansDir, n => n.endsWith(".md"))) {
    const slug = f.replace(/\.md$/, "");
    const text = readText(path.join(plansDir, f));
    if (!text) continue;
    const m = text.match(/^State:.*$/m);
    if (!m) continue;
    const line = m[0];
    let stage = "not_started", run_id;
    if (/\bdraft\b/i.test(line)) stage = "not_started";
    else if (/\bsealed\b/i.test(line)) stage = "waiting";
    else if (/\bdone\b/i.test(line)) stage = "done";
    const runMatch = line.match(/running\s+`?([A-Za-z0-9._-]+)`?/i);
    if (runMatch) { stage = "running"; run_id = runMatch[1]; }
    ensureTask(tasks, slug, { display: (tasks[slug] && tasks[slug].display) || slug, stage, source: "plan", ...(run_id ? { run_id } : {}) });
  }

  // 2 · <run-id>/state.json — pass-level truth, and the run history `info` prints.
  const pendingQuestions = [];
  const runsBySlug = new Map();
  const runSeeds = new Map(); // slug -> seed from that slug's NEWEST run only
  // slug::subtaskId -> {status, note} from that pass's NEWEST run only. A pass only writes back
  // when it names its subtask explicitly (state.json's `subtask` field) — never guessed from title
  // text: a run file never overrides a hand edit by guessing.
  const subtaskSeeds = new Map();
  // Oldest first, so the newest run is the one whose numbers land on the task.
  for (const runId of globDirs(ONEGO).sort()) {
    if (runId === "plans" || runId === "scripts") continue;
    const state = readJSON(path.join(ONEGO, runId, "state.json"), null);
    if (!state || !Array.isArray(state.passes)) continue;
    const slug = state.slug || runId;
    const passes = state.passes;
    // Pass files have used several words for the same three things. Read them all, or the
    // board silently keeps a stale hand-written next move .
    // Exact match, not prefix: "done-but-actually-broken" is none of
    // these three, so it counts toward none of them, exactly like an unrecognized status should.
    const isDone = p => isDoneStatus(p.status);            // done, done-uncommitted
    const isStuck = p => isStuckStatus(p.status);
    const isLive = p => isLiveStatus(p.status);
    const passesDone = passes.filter(isDone).length;
    const stuck = passes.find(isStuck);
    const anyLive = passes.some(isLive);
    const allDone = passes.every(isDone);
    // watchdog leaves this mark on state.json (never `ended`) when every pass says done but
    // the task system would not ACCEPT the job. Without this check the
    // board would still read a hand-edited state.json as finished, even though watchdog itself
    // refused to. This is the one place that mark is read besides watchdog's own refusal.
    const verificationRefused = allDone && state.verification_refused;
    // A run that carries an `ended` stamp is over, whatever its passes still say.
    const stage = verificationRefused ? "blocked"
      : allDone ? "done" : stuck ? "blocked" : (state.ended ? "waiting" : anyLive ? "running" : "waiting");

    let nextMove = "", blockedReason;
    if (verificationRefused) {
      pendingQuestions.push({ slug, text: state.verification_refused });
      nextMove = `resume — ${state.verification_refused}`;
      blockedReason = state.verification_refused;
    } else if (stuck) {
      const why = stuck.parked_question || `pass ${stuck.n} ${stuck.status}`;
      pendingQuestions.push({ slug, text: why });
      nextMove = `resume pass ${stuck.n} (${stuck.status}) — ${String(why).split(".")[0].slice(0, 70)}`;
      blockedReason = why;
    } else {
      const nextPending = passes.find(isLive);
      if (state.ended && /stopped/i.test(state.ended)) {
        const nextUnfinished = passes.find(p => !isDone(p));
        nextMove = nextUnfinished
          ? `stopped at pass ${nextUnfinished.n} — pick it up with /one-go dispatch ${slug}`
          : "stopped";
      } else if (nextPending) nextMove = `run pass ${nextPending.n} — ${nextPending.title}`;
      else if (allDone) nextMove = "all passes done";
      else nextMove = "no pass is runnable — the run sheet needs a look";
    }
    const uncommitted = passes.filter(p => p.status === "done-uncommitted").length;
    if (uncommitted && allDone) nextMove = `${uncommitted} pass${uncommitted === 1 ? "" : "es"} finished but never committed`;

    for (const p of passes) {
      if (!p.subtask) continue;
      subtaskSeeds.set(`${slug}::${p.subtask}`, { status: p.status || "", note: p.parked_question || "" });
    }

    if (!runsBySlug.has(slug)) runsBySlug.set(slug, []);
    runsBySlug.get(slug).push({
      runId, started: state.started || "", ended: state.ended || "", mode: state.mode || "",
      done: passesDone, total: passes.length, stage,
      passes: passes.map(p => ({ n: p.n, title: p.title, status: p.status, model: p.model, commit: p.commit, proven: p.proven, parked: p.parked_question }))
    });

    runSeeds.set(slug, {
      stage,
      passes_done: passesDone, passes_total: passes.length,
      pending_questions: passes.filter(p => p.parked_question).length,
      next_move: nextMove,
      ...(blockedReason ? { blocked_reason: blockedReason } : {}),
      run_id: runId
    });
  }
  for (const [slug, seed] of runSeeds) {
    ensureTask(tasks, slug, {
      display: (tasks[slug] && tasks[slug].display) || slug,
      source: (tasks[slug] && tasks[slug].source) || "plan",
      ...seed
    });
  }

  // Write pass results back onto the subtask they named. Never downgrades a subtask a human
  // already ticked done by hand — a stale run file resuming late must not un-finish real work.
  for (const [key, seed] of subtaskSeeds) {
    const [slug, subtaskId] = key.split("::");
    const t = tasks[slug];
    const s = t && Array.isArray(t.subtasks) && t.subtasks.find(x => x.id === subtaskId);
    if (!s) continue;
    const mapped = isDoneStatus(seed.status) ? "done"
      : isStuckStatus(seed.status) ? "blocked"
      : isLiveStatus(seed.status) ? "running"
      : null;
    if (!mapped || s.stage === "done" || s.stage === mapped) continue;
    s.stage = mapped; s.updated = today();
    if (seed.note) s.note = seed.note;
  }

  // 3 · Frozen screens — only from config.frozen_dirs, read by the ONE shared reader in
  //     lib/house.mjs (obs 0040). A screen whose step 3 cannot be read says "no reader", never a
  //     confident "not frozen" (obs 0009). No frozen_dirs = this source is off.
  for (const screen of listFrozenScreens(ROOT, config)) {
    if (screen.allFrozen) continue;
    const screenId = screen.id;
    // Already owned by a task — as itself, or as somebody's subtask? Leave it alone.
    const owned = Object.entries(tasks).some(([s, t]) =>
      s === screenId || (t.subtasks || []).some(x => x.id === screenId || x.screen === screenId));
    if (owned) continue;
    const seed = screen.status === "frozen"
      ? { stage: "waiting", next_move: "awaiting build/prove" }
      : screen.status === "not_frozen"
        ? { stage: "blocked", next_move: "contract (step 3) not frozen yet" }
        : { stage: "waiting", next_move: "no reader for step 3 in FROZEN.md — check it by hand" };
    ensureTask(tasks, screenId, { display: screenId, source: "frozen", ...seed });
  }

  // 4 · The claims board — who is holding what right now. Location from config.claims_file;
  //     columns found by header name; released and ghost rows dropped (lib/house.mjs).
  const claimRows = readClaims(ROOT, config);

  // 5 · handoffs are DELIBERATELY NOT a task source: a handoff records work that ENDED, and
  //     scanning them once invented 10 of 11 fake items.

  // 6 · The pending-push file (config.extra_sources.pending_push) — a footnote, not a row.
  const extra = readExtraSources(ROOT, config);
  const pendingPushFootnote = extra.pendingPush;

  // 7 · The open-loops file (config.extra_sources.open_loops) — READ ONLY. Dead loop ids, and
  //     work waiting on the person's own eyes or phone.
  const loops = extra.openLoops;
  const NOW = Date.now();
  function daysSince(d) { const t = Date.parse(d); return Number.isNaN(t) ? null : Math.floor((NOW - t) / 86400000); }

  const staleRefs = [];
  for (const [slug, t] of Object.entries(tasks)) {
    const blob = [t.next_move, t.blocked_reason].concat((t.subtasks || []).map(s => s.note)).filter(Boolean).join(" ");
    for (const id of new Set(blob.match(/L-\d+/g) || [])) {
      if (!extra.openLoopsPath) continue;                 // no loops file configured: nothing to check against
      const loop = loops.get(id);
      if (!loop) staleRefs.push({ slug, id, why: `no longer listed in ${extra.openLoopsName}` });
      else if (loop.closed) staleRefs.push({ slug, id, why: "closed " + loop.date });
    }
  }
  const staleSlugs = new Set(staleRefs.map(r => r.slug));

  const eyes = [];
  for (const [id, loop] of loops) {
    if (loop.closed) continue;
    if (!/phone|your eyes|never seen/i.test(loop.what)) continue;
    if (/corrected|which is false|no longer true/i.test(loop.what)) continue;
    eyes.push({ id, days: daysSince(loop.date), what: loop.what.replace(/\*\*/g, "").replace(/`/g, "").split(/(?<=\.)\s/)[0].slice(0, 140) });
  }
  for (const [slug, t] of Object.entries(tasks)) {
    if (rollup(t).stage === "eyes") eyes.push({ id: slug, days: daysSince(t.eyes_since), what: t.display || slug });
  }

  // 8 · The sweeper — REPORT ONLY. Deletes nothing, ever. Backup files are counted only in
  //     config.sweep_dirs (none by default).
  const sweep = [];
  for (const [id, loop] of loops) {
    if (loop.closed) continue;
    const m = loop.what.match(/grace ends (\d{4}-\d{2}-\d{2})/i) || loop.owner.match(/\((\d{4}-\d{2}-\d{2})\)/);
    if (m && Date.parse(m[1]) <= NOW) sweep.push(`${id} reached its date (${m[1]}) — decide, then close it`);
  }
  let bakCount = 0, bakBytes = 0, bakOldest = 0;
  const sweepDirs = (config.sweep_dirs || []).map(d => ({ shown: d, abs: resolveHousePath(d, ROOT) })).filter(d => d.abs);
  for (const d of sweepDirs) {
    for (const n of globFiles(d.abs, x => /\.bak[-.]/.test(x) || /\.retired$/.test(x))) {
      try {
        const st = fs.statSync(path.join(d.abs, n));
        if (!st.isFile()) continue;
        bakCount++; bakBytes += st.size;
        bakOldest = Math.max(bakOldest, Math.floor((NOW - st.mtimeMs) / 86400000));
      } catch { /* unreadable — skip */ }
    }
  }
  if (bakCount) sweep.push(`${bakCount} backup/retired files under ${sweepDirs[0].shown} (${Math.round(bakBytes / 1024)} KB, oldest ${bakOldest} days)`);

  // Only a command that is actually changing something writes the merged view back. A read
  // never touches the file (D1). And a board is still never created out of thin air in a folder
  // that has no /one-go set up — that once left a stray board in the home folder.
  if (persist && (fs.existsSync(BOARD_PATH) || Object.keys(tasks).length)) saveBoard(board);

  return { runsBySlug, pendingQuestions, claimRows, pendingPushFootnote, loops, staleRefs, staleSlugs, eyes, sweep };
}
