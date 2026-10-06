// lib/overlap.mjs — does pass A touch anything pass B touches?
//
// WHY THIS FILE EXISTS
// SKILL.md §E has always said the rule out loud: "`js/food/**` and `js/food/foodLog.js`
// OVERLAP. Compare expanded paths, not strings." Nothing in the engine implemented it. Two
// passes were only ever compared by eye, and a wrong call there costs a whole night's work and
// can lose an edit outright, because two workers writing one file is a last-writer-wins race.
//
// This file is deliberately paranoid, because the cost is lopsided: a false "they overlap"
// costs a little wall-clock (the passes run one after another). A false "they're fine" costs
// real work. When in doubt, it says they overlap.

import path from "node:path";
import { cleanPathEntry, expandBraces, splitPathList } from "./pathspec.mjs";

/** Resolve '..' and '.' segments in a posix-style path string without touching the filesystem. */
function normalizeDots(s) {
  const parts = s.split("/");
  const out = [];
  for (const seg of parts) {
    if (seg === "..") { if (out.length) out.pop(); }
    else if (seg !== ".") out.push(seg);
  }
  return out.join("/");
}

// Windows compares paths case-insensitively; Linux does not. The board is used on Windows, but
// this file is portable, so fold case only where the platform actually does.
const FOLD_CASE = process.platform === "win32" || process.platform === "darwin";

/**
 * One path string -> a comparable shape.
 * Handles: backslashes, "./" prefixes, trailing slashes, quotes, and the three glob forms the
 * plans actually use — `dir/**`, `dir/*`, and `dir/*.ext`.
 */
export function canonical(entry) {
  // Markdown and trailing notes off first: "`x.md` (new)" is the file x.md (2026-09-28).
  let s = cleanPathEntry(entry).path;
  if (!s) return null;
  s = s.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  s = normalizeDots(s);

  if (FOLD_CASE) s = s.toLowerCase();

  const starstar = s.indexOf("/**");
  if (starstar !== -1) return { kind: "tree", base: s.slice(0, starstar), raw: entry };
  if (s.endsWith("/**")) return { kind: "tree", base: s.slice(0, -3), raw: entry };
  if (s === "**") return { kind: "tree", base: "", raw: entry };

  const lastSlash = s.lastIndexOf("/");
  const tail = lastSlash === -1 ? s : s.slice(lastSlash + 1);
  if (tail.includes("*")) {
    const dir = lastSlash === -1 ? "" : s.slice(0, lastSlash);
    // "*.mjs" -> suffix ".mjs"; "*" -> any file directly in dir
    const suffix = tail === "*" ? "" : tail.replace(/^\*/, "");
    return { kind: "dirglob", base: dir, suffix, raw: entry };
  }
  return { kind: "file", base: s, raw: entry };
}

// One path segment against another, either of which may hold a `*` (e.g. `j0*` vs `j05-x`).
// A wildcard segment is compared by what it can match, never skipped as "anything".
function segEq(a, b) {
  if (a === b) return true;
  const rx = t => new RegExp("^" + t.split("*").map(x => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*") + "$");
  return (a.includes("*") && rx(a).test(b)) || (b.includes("*") && rx(b).test(a));
}

function segsEq(a, b) {
  const as = a === "" ? [] : a.split("/");
  const bs = b === "" ? [] : b.split("/");
  return as.length === bs.length && as.every((seg, i) => segEq(seg, bs[i]));
}

function isUnder(child, base) {
  if (base === "") return true;
  const cs = child === "" ? [] : child.split("/");
  const bs = base.split("/");
  if (cs.length < bs.length) return false;
  return bs.every((seg, i) => segEq(seg, cs[i]));
}

/** Do two canonical shapes touch any of the same bytes on disk? */
export function shapesOverlap(a, b) {
  if (!a || !b) return false;

  if (a.kind === "file" && b.kind === "file") return segsEq(a.base, b.base);

  if (a.kind === "tree" || b.kind === "tree") {
    const tree = a.kind === "tree" ? a : b;
    const other = a.kind === "tree" ? b : a;
    if (other.kind === "tree") {
      // Two trees clash if either contains the other — "js/**" swallows "js/food/**".
      return isUnder(other.base, tree.base) || isUnder(tree.base, other.base);
    }
    if (other.kind === "dirglob") {
      // `dir/*` names files directly inside `dir`, so it touches a tree only when `dir` is
      // inside that tree. It used to be compared both ways, and a dir-glob with no folder
      // (base "", e.g. the scrap `a1*`) sits "above" every tree — it matched everything
      // (2026-09-28: `.claude/company/**` collided with 36 claims). Compared by path now.
      return isUnder(other.base, tree.base);
    }
    // A bare path may name a folder written without a trailing slash, so a file ABOVE the
    // tree still counts. Paranoid on purpose — see the top of this file.
    return isUnder(other.base, tree.base) || isUnder(tree.base, other.base);
  }

  if (a.kind === "dirglob" && b.kind === "dirglob") {
    if (!segsEq(a.base, b.base)) return false;
    if (!a.suffix || !b.suffix) return true;            // "*" matches everything the other does
    return a.suffix === b.suffix || a.suffix.endsWith(b.suffix) || b.suffix.endsWith(a.suffix);
  }

  // one file, one dir-glob
  const glob = a.kind === "dirglob" ? a : b;
  const file = a.kind === "dirglob" ? b : a;
  const dir = file.base.includes("/") ? file.base.slice(0, file.base.lastIndexOf("/")) : "";
  if (!segsEq(dir, glob.base)) return false;
  return !glob.suffix || file.base.endsWith(glob.suffix);
}

/** One raw entry -> every shape it names. `x/{a,b}.md` is two files, compared one by one. */
export function shapesOf(entry) {
  const cleaned = cleanPathEntry(entry).path;
  if (!cleaned) return [];
  return expandBraces(cleaned).map(canonical).filter(Boolean);
}

/**
 * Drop a leading code-folder prefix (`app-folder/`) from one raw path entry, when it has it.
 * No prefix, or a path that does not start with it, comes back unchanged.
 */
export function stripCodePrefix(entry, prefix) {
  const pre = String(prefix || "").replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/*$/, "/");
  if (pre === "/") return entry;
  const cleaned = cleanPathEntry(entry).path;
  if (!cleaned) return entry;
  const s = cleaned.replace(/\\/g, "/").replace(/^\.\//, "");
  const same = FOLD_CASE ? s.toLowerCase().startsWith(pre.toLowerCase()) : s.startsWith(pre);
  return same ? s.slice(pre.length) : entry;
}

/** Convenience for two raw path strings. */
export function pathsOverlap(a, b) {
  const as = shapesOf(a), bs = shapesOf(b);
  return as.some(x => bs.some(y => shapesOverlap(x, y)));
}

/**
 * Compare two passes.
 *
 * Returns null when they may run together, or a reason string when they may not.
 * `writes` clash with `writes` AND with `reads` — a pass reading a file another pass is
 * rewriting gets a torn half-edited view, which is its own quiet kind of wrong. Two passes
 * merely READING the same file is fine and is the common case.
 *
 * `shared` covers what is not a path at all: a port, an output folder, a fixture database, a
 * dev server, a schema. Two passes naming the same shared resource are serialized even when
 * their file lists are perfectly disjoint.
 *
 * Except the PROOF-ONLY tags: `capture-tree` / `whole-tree` say a pass's CHECK reads the whole
 * app. That holds back the check (lib/evidence.mjs wholeTreeConflict), never the building — so
 * two tagged passes with disjoint files build side by side.
 */
export const PROOF_ONLY_TAGS = new Set(["capture-tree", "whole-tree"]);

export function passesConflict(a, b) {
  const aw = (a.files || []).flatMap(shapesOf);
  const bw = (b.files || []).flatMap(shapesOf);
  const ar = (a.reads || []).flatMap(shapesOf);
  const br = (b.reads || []).flatMap(shapesOf);

  for (const x of aw) for (const y of bw) {
    if (shapesOverlap(x, y)) return `both write ${x.raw}${x.raw === y.raw ? "" : ` / ${y.raw}`}`;
  }
  for (const x of aw) for (const y of br) {
    if (shapesOverlap(x, y)) return `pass ${a.n} writes ${x.raw} while pass ${b.n} reads ${y.raw}`;
  }
  for (const x of bw) for (const y of ar) {
    if (shapesOverlap(x, y)) return `pass ${b.n} writes ${x.raw} while pass ${a.n} reads ${y.raw}`;
  }

  const sharedOf = p => (p.shared || []).map(s => String(s).trim().toLowerCase()).filter(s => s && !PROOF_ONLY_TAGS.has(s));
  const as = new Set(sharedOf(a));
  for (const s of sharedOf(b)) {
    if (as.has(s)) return `both need the shared resource "${s}"`;
  }
  return null;
}

/**
 * Given passes that are all READY (their prerequisites are met), pick the biggest set that can
 * safely run at once, honouring `limit`.
 *
 * Greedy, and ordered by the caller — the scheduler hands these in critical-path order, so the
 * work that unblocks the most other work gets a slot first. Greedy is not provably optimal;
 * it is predictable and explainable, which matters more here than optimal.
 */
export function selectParallelBatch(ready, limit = 3, running = []) {
  const chosen = [];
  const rejected = [];
  for (const p of ready) {
    if (chosen.length >= limit) { rejected.push({ pass: p, reason: `no slot free (limit ${limit})` }); continue; }
    let clash = null;
    for (const r of running) {
      const why = passesConflict(p, r);
      if (why) { clash = `waits for running pass ${r.n} — ${why}`; break; }
    }
    if (!clash) {
      for (const c of chosen) {
        const why = passesConflict(p, c);
        if (why) { clash = `waits for pass ${c.n} — ${why}`; break; }
      }
    }
    if (clash) rejected.push({ pass: p, reason: clash });
    else chosen.push(p);
  }
  return { chosen, rejected };
}

/**
 * Cross-check a run's declared writes against the claims other chat windows hold RIGHT NOW.
 * ACTIVE-WORK.md stays the single authority on who may edit a file (SKILL.md §E test 2); this
 * only reads it. A run identity is not a second authority over file ownership.
 */
export function claimConflicts(passes, claimRows, { ignoreClaimIds = new Set(), stripPrefix = "" } = {}) {
  const out = [];
  for (const row of claimRows || []) {
    if (ignoreClaimIds.has(row.claim)) continue;
    // A released claim holds nothing. parseClaimRows (lib/claims.mjs) already drops them; this
    // guards any caller that builds rows by hand.
    if (row.released) continue;
    // Brace-aware split: a bare split(",") cut `{a0*,a1*}` into scraps that were not paths.
    const claimed = splitPathList(row.files);
    // 0115: plans are workspace-rooted, claim rows are often written from inside the code folder
    // (`js/x.js` vs `<code-folder>/js/x.js`). Strip that folder from BOTH sides before comparing.
    const prefix = stripPrefix || row.prefix || "";
    for (const p of passes) {
      for (const mine of p.files || []) {
        for (const theirs of claimed) {
          if (pathsOverlap(stripCodePrefix(mine, prefix), stripCodePrefix(theirs, prefix))) {
            out.push({ pass: p.n, file: mine, claim: row.claim, theirs });
          }
        }
      }
    }
  }
  return out;
}
