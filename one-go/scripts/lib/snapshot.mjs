// lib/snapshot.mjs — D8: what was on disk when the run started, so a pass that finishes can be
// asked "did you write anything that is not yours, and did anything of anyone's go missing?"
//
// WHY THIS FILE EXISTS (obs 0065, 0111, 0135)
// A worker told to write five files can also overwrite a sixth, or delete one, and nothing in the
// run noticed: `pass done` only looked at the pass's own list. The start of the run now records
// every file the plan's passes declare (path → sha1 + size, or "absent") in `<run>/snapshot.json`,
// and `pass <job> <n> done` compares the tree against it.
//
// WHAT COUNTS AS "OUTSIDE" — parallel passes legitimately write their own files, so a changed file
// is only reported when it is on NEITHER pass n's list NOR the list of a pass that is running
// beside it. Two kinds of file are compared:
//   - every file on any pass's list (a pending pass's file that moved, a finished pass's file that
//     was overwritten or deleted);
//   - every other file sitting directly in a folder that pass n writes into (a stray new file, an
//     undeclared edit or delete next to its work). One level only — never a whole-tree walk.
//
// PATTERNS — braces are expanded (the engine's one brace expander, lib/pathspec.mjs). A glob
// (`dir/**`, `dir/*.ext`) is NOT walked: it is recorded as a pattern, with the folder it lives in
// listed one level deep, so the snapshot says out loud what it could not enumerate.
//
// ROLLING BASELINE — when pass n is accepted, its own files (and anything just reported) become the
// new baseline, so a later pass is judged against the tree as it stood after the earlier work, not
// against a start line that finished work has long since moved past.
//
// This flags; it never refuses. Old runs have no snapshot.json and are never judged.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { expandPathEntries } from "./pathspec.mjs";
import { resolveDeclared } from "./resolve.mjs";
import { canonical, shapesOverlap } from "./overlap.mjs";
import { isRunningStatus } from "./status.mjs";
import { writeJSONAtomic } from "./atomic.mjs";

export const SNAPSHOT_FILE = "snapshot.json";
export const SNAPSHOT_SCHEMA = 1;

/** A folder with more files than this is recorded as "too big to list" and not compared. */
const MAX_FOLDER_FILES = 300;
/** Bigger files are recorded by size alone. */
const MAX_HASH_BYTES = 8 * 1024 * 1024;

const hasGlob = p => /[*?]/.test(p);
const FOLD = process.platform === "win32" || process.platform === "darwin";
const slashed = p => String(p).replace(/\\/g, "/");
const keyOf = p => { const s = slashed(path.resolve(p)); return FOLD ? s.toLowerCase() : s; };

/** { state:"absent" } | { state:"dir" } | { state:"file", sha1, size }. Never throws. */
export function hashPath(abs) {
  try {
    const st = fs.statSync(abs);
    if (st.isDirectory()) return { state: "dir" };
    if (st.size > MAX_HASH_BYTES) return { state: "file", sha1: `large:${st.size}`, size: st.size };
    return { state: "file", sha1: crypto.createHash("sha1").update(fs.readFileSync(abs)).digest("hex"), size: st.size };
  } catch {
    return { state: "absent" };
  }
}

const same = (a, b) => a.state === b.state && (a.sha1 || null) === (b.sha1 || null) && (a.size ?? null) === (b.size ?? null);

/** The folder a declared entry works in: its parent, or the part before the first glob segment. */
function folderOf(abs) {
  const parts = slashed(abs).split("/");
  const g = parts.findIndex(hasGlob);
  const keep = g === -1 ? parts.slice(0, -1) : parts.slice(0, g);
  const dir = keep.join("/");
  if (!dir) return null;
  const resolved = path.resolve(dir);
  return path.parse(resolved).root === resolved ? null : resolved;   // never a drive root
}

/** The files directly inside a folder (one level), by name. `truncated` when it is too big. */
function listFolder(dir) {
  const out = { exists: false, truncated: false, files: {} };
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  out.exists = true;
  const names = ents.filter(e => e.isFile() && !/\.tmp$/i.test(e.name)).map(e => e.name);
  if (names.length > MAX_FOLDER_FILES) { out.truncated = true; return out; }
  for (const n of names) out.files[n] = hashPath(path.join(dir, n));
  return out;
}

/** Everything the given passes declare they will write, taken as it is right now. */
export function takeSnapshot(passes) {
  const decls = new Map();                           // decl -> { passes:Set }
  for (const p of passes || []) {
    for (const e of expandPathEntries(p.files || p.writes || [])) {
      if (!decls.has(e.path)) decls.set(e.path, new Set());
      decls.get(e.path).add(p.n);
    }
  }
  const resolved = resolveDeclared([...decls.keys()], { requireGlobs: false }).resolved;
  const snap = { schema: SNAPSHOT_SCHEMA, taken: new Date().toISOString(), files: {}, patterns: [], folders: {} };
  const addFolder = (abs, nums) => {
    const dir = folderOf(abs);
    if (!dir) return;
    const k = keyOf(dir);
    if (!snap.folders[k]) snap.folders[k] = { dir, passes: [], ...listFolder(dir) };
    for (const n of nums) if (!snap.folders[k].passes.includes(n)) snap.folders[k].passes.push(n);
  };
  for (const r of resolved) {
    const nums = [...decls.get(r.decl)].sort((a, b) => a - b);
    if (hasGlob(r.decl)) {
      snap.patterns.push({ decl: r.decl, abs: slashed(r.abs), passes: nums, expanded: false,
        note: "a glob is recorded as a pattern, not walked" });
    } else {
      snap.files[keyOf(r.abs)] = { decl: r.decl, abs: slashed(r.abs), passes: nums, ...hashPath(r.abs) };
    }
    addFolder(r.abs, nums);
  }
  return snap;
}

export function writeSnapshot(runDir, snap) {
  writeJSONAtomic(path.join(runDir, SNAPSHOT_FILE), snap);
}

/** null when the run has no snapshot (an older run), else the parsed snapshot. Throws if unreadable. */
export function readSnapshot(runDir) {
  const p = path.join(runDir, SNAPSHOT_FILE);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

/** A pass the engine knows is (or may be) writing right now, other than pass n. */
const isWritingNow = s => isRunningStatus(s) || s === "launch-requested" || s === "stop-requested";

/**
 * What changed that no running pass owns. Pure read.
 * @returns {{ changes: {path:string, kind:"changed"|"deleted"|"created", where:string}[] }}
 */
export function outsideChanges(snap, state, passN) {
  const exempt = new Set([passN]);
  for (const p of state.passes || []) if (p.n !== passN && isWritingNow(p.status)) exempt.add(p.n);
  const owned = nums => (nums || []).some(n => exempt.has(n));
  const exemptPatterns = (snap.patterns || []).filter(p => owned(p.passes)).map(p => canonical(p.abs)).filter(Boolean);
  const coveredByPattern = abs => { const c = canonical(abs); return Boolean(c) && exemptPatterns.some(x => shapesOverlap(c, x)); };

  const changes = [];
  const seen = new Set();
  const note = (abs, kind, where) => {
    const k = keyOf(abs);
    if (seen.has(k)) return;
    seen.add(k);
    changes.push({ path: slashed(abs), kind, where });
  };
  const verdict = (was, now) => {
    if (same(was, now)) return null;
    if (was.state !== "absent" && now.state === "absent") return "deleted";
    if (was.state === "absent" && now.state !== "absent") return "created";
    return "changed";
  };

  for (const [k, f] of Object.entries(snap.files || {})) {
    if (owned(f.passes) || coveredByPattern(f.abs)) continue;
    const kind = verdict(f, hashPath(f.abs));
    if (kind) note(f.abs, kind, `on pass ${f.passes.join(", ")}'s list`);
  }
  for (const [fk, fold] of Object.entries(snap.folders || {})) {
    if (!(fold.passes || []).includes(passN) || fold.truncated) continue;
    const now = listFolder(fold.dir);
    if (now.truncated) continue;
    const names = new Set([...Object.keys(fold.files || {}), ...Object.keys(now.files)]);
    for (const name of names) {
      const abs = path.join(fold.dir, name);
      if (snap.files && snap.files[keyOf(abs)]) continue;            // judged above, by its owner
      if (coveredByPattern(abs)) continue;
      const kind = verdict((fold.files || {})[name] || { state: "absent" }, now.files[name] || { state: "absent" });
      if (kind) note(abs, kind, "in a folder this pass writes into");
    }
  }
  return { changes };
}

/**
 * Accept pass n's work as the new baseline: its own files, anything just reported, and the
 * folders it writes into. Re-reads snapshot.json first so two passes finishing together each
 * keep the other's update.
 */
export function refreshBaseline(runDir, passN, reported = []) {
  const snap = readSnapshot(runDir);
  if (!snap) return;
  const flagged = new Set(reported.map(c => keyOf(c.path)));
  for (const [k, f] of Object.entries(snap.files || {})) {
    if ((f.passes || []).includes(passN) || flagged.has(k)) snap.files[k] = { decl: f.decl, abs: f.abs, passes: f.passes, ...hashPath(f.abs) };
  }
  for (const fold of Object.values(snap.folders || {})) {
    if (!(fold.passes || []).includes(passN)) continue;
    const now = listFolder(fold.dir);
    Object.assign(fold, { exists: now.exists, truncated: now.truncated, files: now.files });
  }
  snap.rebased = { pass: passN, at: new Date().toISOString() };
  writeSnapshot(runDir, snap);
}

/** One line for a reported change, with the path made short when it sits under `root`. */
export function describeChange(c, root) {
  const r = slashed(root || "").replace(/\/+$/, "");
  const shown = r && slashed(c.path).toLowerCase().startsWith(r.toLowerCase() + "/") ? slashed(c.path).slice(r.length + 1) : c.path;
  return `${c.kind}: ${shown} (${c.where})`;
}
