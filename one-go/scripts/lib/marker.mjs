// lib/marker.mjs — the run markers, read and released in one place (obs 0107, 0109).
//
// One file per live run: `.claude/one-go/ACTIVE.d/<run-id>` (content: the run id). The old single
// file `.claude/one-go/ACTIVE` is still READ everywhere (runs started by an older engine have no
// ACTIVE.d entry) and is deleted only when it names the run being closed. Nothing here ever picks
// "the first marker it finds" as the caller's run: callers get the whole list and decide.
import fs from "node:fs";
import path from "node:path";
import { ONEGO } from "./paths.mjs";

function readTrim(p) {
  try { return fs.readFileSync(p, "utf-8").trim(); } catch { return ""; }
}

/**
 * Every run id a marker says is live: each ACTIVE.d entry whose run folder has a state.json, plus
 * the legacy ACTIVE id when it is not already listed (kept even without a run folder — the reader
 * decides what a missing folder means). Sorted, de-duplicated, never throws.
 */
export function liveRunIds(onegoDir = ONEGO) {
  const ids = [];
  try {
    for (const e of fs.readdirSync(path.join(onegoDir, "ACTIVE.d"), { withFileTypes: true })) {
      if (!e.isFile()) continue;
      if (fs.existsSync(path.join(onegoDir, e.name, "state.json"))) ids.push(e.name);
    }
  } catch { /* no ACTIVE.d — an old project */ }
  ids.sort();
  const legacy = readTrim(path.join(onegoDir, "ACTIVE"));
  if (legacy && !ids.includes(legacy)) ids.push(legacy);
  return ids;
}

/**
 * Release one run's markers. Its own ACTIVE.d entry goes unconditionally (other runs' entries are
 * never touched); the legacy ACTIVE goes only when it names THIS run. Returns true when any
 * marker was removed.
 */
export function releaseMarkers(runId, onegoDir = ONEGO) {
  if (!runId) return false;
  let removed = false;
  try { fs.unlinkSync(path.join(onegoDir, "ACTIVE.d", runId)); removed = true; } catch { /* absent */ }
  const legacyPath = path.join(onegoDir, "ACTIVE");
  if (readTrim(legacyPath) === runId) {
    try { fs.unlinkSync(legacyPath); removed = true; } catch { /* already gone */ }
  }
  return removed;
}
