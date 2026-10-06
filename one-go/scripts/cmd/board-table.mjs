// cmd/board-table.mjs — THE BOARD: ONE table plus ONE footer line. Nothing else.
// Ported from the live skill's board.mjs final section.
//
// The owner's standing ask: a table of the jobs and their overall status, nothing more
// (fix D8, pass 10 NO-GO). So:
//   - a live run (heartbeat under 3 h) shows IN ITS JOB'S ROW: Stage 🟡 running, Next move = the
//     pass it is on. There is no separate "Live now" block on the bare board any more;
//     `computeLiveRuns` / `renderLiveRunLines` below still build the detailed live view for any
//     caller that wants it (the old `status` word is retired).
//   - a stale run (heartbeat 3 h or older, never closed) is never listed; it is only counted in
//     the footer ("N unfinished — /one-go dispatch <job>"), and its job's row stops claiming "running".
//   - a job with no parts whose newest run was closed with open items reads
//     "Finished — N things need you" (fix D3, CONTRACT §8), never "done" or "resume pass N".
//   - the hooks-stood-down note (obs 0005) goes into the footer, and only while the ACTIVE
//     marker is live by the hooks' own rule — its run's heartbeat under 3 h (fix D6).
//
// `sealedNeverLaunched` and `computeLiveRuns` both read `scanRuns()` (cmd/revive.mjs) — the ONE
// shared run-folder reader, now that pass 6 has landed it. Two readers of the same run state
// disagreeing is exactly the failure recorded in obs 0040 (board vs. the old board-table's own
// scanner) and obs 0067 — so this file carries no run-folder scan of its own any more.
import fs from "node:fs";
import path from "node:path";
import { ICON, WORD, bar, rollup } from "../lib/render.mjs";
import { ONEGO } from "../lib/paths.mjs";
import { readText } from "../lib/util.mjs";
import { isLiveStatus, isStuckStatus } from "../lib/status.mjs";
import { loadAuthoritativePlan } from "../lib/plan.mjs";
import { scanRuns } from "./revive.mjs";
import { liveRunIds } from "../lib/marker.mjs";

const NEVER_LAUNCHED_HOURS = 24;

/**
 * Slugs with a sealed plan on disk, more than 24h old, that no run folder has ever named as its
 * `state.slug` — i.e. `start` was never run for them.
 */
function sealedNeverLaunched(tasks) {
  const plansDir = path.join(ONEGO, "plans");
  const launchedSlugs = new Set(scanRuns().map(r => r.state && r.state.slug).filter(Boolean));
  const cutoffMs = NEVER_LAUNCHED_HOURS * 3600 * 1000;
  const out = [];
  for (const [slug, t] of Object.entries(tasks)) {
    if (t.absorbed_by || launchedSlugs.has(slug)) continue;
    let sealedAt = null;
    try {
      const jsonPath = path.join(plansDir, `${slug}.plan.json`);
      const mdPath = path.join(plansDir, `${slug}.md`);
      if (fs.existsSync(jsonPath)) {
        sealedAt = fs.statSync(jsonPath).mtimeMs;
      } else if (fs.existsSync(mdPath)) {
        const { isSealed: sealed } = loadAuthoritativePlan(plansDir, slug, { readOnly: true });
        if (sealed) sealedAt = fs.statSync(mdPath).mtimeMs;
      }
    } catch { /* no readable plan for this slug — not a candidate */ }
    if (sealedAt != null && (Date.now() - sealedAt) > cutoffMs) out.push(slug);
  }
  return out;
}

// ---------------------------------------------------------------- live-run line(s)
// The detailed live view (once the retired `status` word; kept for callers that want it).

/** Which task/run pairs are actively running or blocked right now, with their current pass.
 * Reads scanRuns() once (cmd/revive.mjs, the one shared reader) both to decide whether the
 * latest run for a slug has actually ended — whatever sources.mjs's summarised `stage` says, a
 * run closed as FINISHED WITH OPEN ITEMS can still carry a "blocked" stage from a pass that
 * parked before the close (pass 6 handoff) — and to carry the full pass/host detail
 * `modelForLivePass` needs, instead of that function re-reading state.json a second time. */
export function computeLiveRuns(tasks, runsBySlug) {
  const byRunId = new Map(scanRuns().map(r => [r.runId, r]));
  const live = [];
  for (const [slug, runs] of runsBySlug) {
    const latest = runs.slice().sort((a, b) => String(b.started).localeCompare(String(a.started)))[0];
    if (!latest || (latest.stage !== "running" && latest.stage !== "blocked")) continue;
    const scanned = byRunId.get(latest.runId);
    if (scanned && scanned.ended) continue;
    const t = tasks[slug];
    const curPass = latest.passes.find(p => isLiveStatus(p.status))
      || latest.passes.find(p => isStuckStatus(p.status));
    const fullPass = scanned && curPass ? scanned.passes.find(p => p.n === curPass.n) : null;
    live.push({
      slug, display: (t && t.display) || slug, stage: latest.stage, runId: latest.runId,
      done: latest.done, total: latest.total, pass: curPass,
      host: scanned && scanned.state ? scanned.state.host : null, fullPass
    });
  }
  return live;
}

function modelForLivePass(l) {
  if (!l.pass) return "—";
  const realPass = l.fullPass;
  if (realPass?.worker?.actual_model) return realPass.worker.actual_model;
  if (realPass?.route?.confirmed) return realPass.route.confirmed;
  if (l.host === "inline") return "this chat's own model";
  if ((l.host && l.host !== "claude") || realPass?.status === "launch-requested" || (realPass?.route && !realPass?.route?.confirmed)) {
    return "unavailable (unconfirmed)";
  }
  return realPass?.model || l.pass.model || "—";
}

/** The live-run table as printable lines — used by both the bare board and `status`. */
export function renderLiveRunLines(live) {
  if (!live.length) return [];
  const out = [];
  out.push("| Job | Stage | Pass | Model | Progress |");
  out.push("|---|---|---|---|---|");
  for (const l of live) {
    let passLabel = "—";
    if (l.pass) {
      const statusTag = (l.pass.status && l.pass.status !== "running" && l.pass.status !== "pending") ? ` [${l.pass.status}]` : "";
      passLabel = `${l.pass.n} — ${l.pass.title || "—"}${statusTag}`;
    }
    out.push(`| **${l.display}** | ${ICON[l.stage]} ${WORD[l.stage]} | ${passLabel} | ${modelForLivePass(l)} | ${l.done}/${l.total} |`);
    if (l.pass && l.pass.parked) out.push(`| | ↳ parked on: ${String(l.pass.parked).slice(0, 160)} | | | |`);
  }
  return out;
}

// ---------------------------------------------------------------- the 3-hour rule
// The hooks (quiet.py, CONTRACT §8) call a run dead once its heartbeat is 3 h old. The board uses
// the SAME rule, so it never says "running" or "hooks stood down" when the hooks say otherwise.
export const LIVE_HOURS = 3;

/** Minutes since a `YYYY-MM-DD HH:MM` stamp (local time, as start/pass write it), or null. */
function minutesSince(text) {
  const m = String(text || "").match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
  return Math.round((Date.now() - t) / 60000);
}

/** A heartbeat counts as live only when it parses and is under LIVE_HOURS old. */
export function isHeartbeatLive(beat) {
  const age = minutesSince(beat);
  return age != null && age < LIVE_HOURS * 60;
}

/**
 * obs 0005 + fix D6 + D7: the hooks-stood-down note, or null unless some marker is LIVE.
 * Reads every run marker (ACTIVE.d first, legacy ACTIVE too); a marker only counts while its
 * run's heartbeat is fresh. One live run reads as before; several are all named.
 */
export function hooksStoodDownNote() {
  const live = [];
  for (const runId of liveRunIds(ONEGO)) {
    const beat = (readText(path.join(ONEGO, runId, "heartbeat.txt")) || "").trim();
    if (isHeartbeatLive(beat)) live.push({ runId, beat });
  }
  if (!live.length) return null;
  if (live.length === 1) return `🔕 hooks stood down since ${live[0].beat} by run \`${live[0].runId}\``;
  return `🔕 hooks stood down by ${live.length} runs: ${live.map(l => `\`${l.runId}\``).join(", ")}`;
}

const plural = (n, one) => `${n} ${n === 1 ? one : one + "s"}`;

export function renderBoard({ ARGV, tasks, runsBySlug, staleSlugs, eyes, sweep, pendingPushFootnote, unfinishedRuns = [] }) {
  const showAll = ARGV.includes("--all") || ARGV.includes("-a");

  // One read of every run folder (cmd/revive.mjs scanRuns — the one shared reader): newest first,
  // so the first run seen for a slug is that job's newest run.
  const scanned = scanRuns();
  const newestBySlug = new Map();
  for (const r of scanned) {
    const s = r.state && r.state.slug;
    if (s && !newestBySlug.has(s)) newestBySlug.set(s, r);
  }
  const beatOf = runId => { const r = scanned.find(x => x.runId === runId); return r ? r.beat : ""; };
  // Live runs with a heartbeat under 3 h — these, and only these, show as running in their row.
  const liveBySlug = new Map();
  for (const l of computeLiveRuns(tasks, runsBySlug || new Map())) {
    if (isHeartbeatLive(beatOf(l.runId)) && !liveBySlug.has(l.slug)) liveBySlug.set(l.slug, l);
  }

  const rows = [];
  let hiddenDone = 0;
  for (const [slug, t] of Object.entries(tasks)) {
    // A row folded into a bigger task is never printed on its own — that is what stops
    // one high-level job (My Meals, Food) from spraying ten rows across the board.
    if (t.absorbed_by) continue;
    const r = { ...rollup(t) };
    const hasParts = Array.isArray(t.subtasks) && t.subtasks.length > 0;
    const newest = newestBySlug.get(slug);
    const live = liveBySlug.get(slug);
    if (!hasParts && newest && newest.ended && newest.state.ending === "FINISHED WITH OPEN ITEMS") {
      // fix D3: the run is over; what is left is the person's list, never "resume pass N".
      const n = Array.isArray(newest.state.open_items) ? newest.state.open_items.length : 0;
      r.stage = "waiting";
      r.next = `Finished — ${plural(n, "thing")} need${n === 1 ? "s" : ""} you — /one-go dispatch ${slug}`;
    } else if (live && live.stage === "running") {
      // fix D8: the live run lives in its job's row.
      r.stage = "running";
      if (live.pass) r.next = `pass ${live.pass.n} — ${live.pass.title || "—"}`;
    } else if (r.stage === "running" && newest && !newest.ended && !isHeartbeatLive(newest.beat)) {
      // fix D8: a stale run is not "running" — it is one of the footer's unfinished runs.
      r.stage = "waiting";
      r.next = `unfinished, no heartbeat since ${String(newest.beat || "").trim() || "—"} — /one-go dispatch ${slug}`;
    }
    if (r.stage === "done" && !showAll) { hiddenDone++; continue; }
    rows.push({ slug, t, r });
  }
  const ORDER = { running: 0, blocked: 1, waiting: 2, eyes: 3, not_started: 4, done: 5 };
  rows.sort((a, b) => (ORDER[a.r.stage] ?? 9) - (ORDER[b.r.stage] ?? 9) ||
    String(a.t.display || a.slug).localeCompare(String(b.t.display || b.slug)));

  const out = [];
  out.push("| Task | Stage | Progress | Pending | Next move |");
  out.push("|---|---|---|---|---|");
  for (const { slug, t, r } of rows) {
    const flag = staleSlugs.has(slug) ? " ⚠" : "";
    const q = r.questions ? `⏳ ${r.questions}` : "—";
    const next = String(r.next || "—").replace(/\|/g, "/").slice(0, 90);
    out.push(`| **${t.display || slug}** | ${ICON[r.stage]} ${WORD[r.stage]} | ${bar(r.done, r.total, r.stage)} | ${q} | ${next}${flag} |`);
  }

  console.log(out.join("\n"));

  // ---------------------------------------------------------------- the ONE footer line
  const bits = [];
  // Unfinished runs that are not live right now (a live one already shows in its row). "killed"
  // means confirmed (revive.mjs isConductorGone) — a merely stalled lane is not called killed.
  const stale = unfinishedRuns.filter(r => !(isHeartbeatLive(r.beat) && liveBySlug.has(r.state && r.state.slug)));
  if (stale.length) {
    const killed = stale.filter(r => r.conductorGone).length;
    bits.push(`⚠ ${stale.length} unfinished${killed ? ` (${killed} killed mid-flight)` : ""} — /one-go dispatch <job>`);
  }
  const neverLaunched = sealedNeverLaunched(tasks);
  if (neverLaunched.length) bits.push(`⚠ ${neverLaunched.length} sealed, never launched — /one-go dispatch <job>`);
  const stoodDown = hooksStoodDownNote();
  if (stoodDown) bits.push(stoodDown);
  if (hiddenDone) bits.push(`${hiddenDone} finished (hidden — \`/one-go --all\`)`);
  if (eyes.length) bits.push(`${eyes.length} waiting on your phone`);
  if (sweep.length) bits.push(`${sweep.length} sweeper item${sweep.length === 1 ? "" : "s"}`);
  if (pendingPushFootnote) bits.push("a push is pending");
  if (bits.length) console.log(`\n_${bits.join(" · ")}._`);
}
