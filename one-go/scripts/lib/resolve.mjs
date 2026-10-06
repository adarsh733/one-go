// lib/resolve.mjs — ONE resolver for a pass's declared file list, shared by `pass` and `resume`.
//
// Every declared-file resolver in the old engine invented its own base, and two of them joined
// absolute paths onto the workspace root (`<root>\<drive>:\…`), so finished work read as "never
// built" (obs 0066). The rules here:
//   1. an absolute declared path stays absolute — never re-joined onto any base;
//   2. relative paths resolve against ONE base: the candidate under which the most of them exist
//      (the workspace root, or a code folder inside it holding .git or package.json);
//   3. zero hits is a claim about the RESOLVER, not the disk — but only when nothing anchors
//      either: if no declared file exists AND not one of their folders exists under any base,
//      the answer is `unresolvable` ("cannot resolve"), never a confident "missing" list. When
//      the folders are there and the files are not, the files really are missing (the worker
//      wrote nothing) and `missing` says so honestly.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT } from "./paths.mjs";

const isAbs = p => path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p);
const hasGlob = p => /[*?]/.test(p);

/** One declared entry → an absolute path. Absolute stays absolute; `~/` = home. */
export function resolveOne(decl, base = ROOT) {
  const s = String(decl == null ? "" : decl).trim().replace(/^["'`]|["'`]$/g, "");
  if (!s) return "";
  if (s === "~") return os.homedir();
  if (/^~[\\/]/.test(s)) return path.join(os.homedir(), s.slice(2));
  if (isAbs(s)) return path.normalize(s);
  return path.join(base, s);
}

/** The workspace root plus every non-hidden child folder holding .git or package.json. */
export function candidateBases(root = ROOT) {
  const out = [root];
  try {
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory() || d.name.startsWith(".")) continue;
      const c = path.join(root, d.name);
      if (fs.existsSync(path.join(c, ".git")) || fs.existsSync(path.join(c, "package.json"))) out.push(c);
    }
  } catch { /* unreadable root — the root alone */ }
  return out;
}

/** The folder part of a declared path before any glob segment (`a/b/**` → `a/b`, `a/*.mjs` → `a`). */
function staticDir(abs) {
  const parts = abs.split(/[\\/]/);
  const firstGlob = parts.findIndex(p => hasGlob(p));
  const keep = firstGlob === -1 ? parts.slice(0, -1) : parts.slice(0, firstGlob);
  return keep.join(path.sep) || path.sep;
}

function globToRegExp(pat) {
  return new RegExp("^" + pat.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i");
}

/** Does a declared (absolute) entry exist? A glob exists when it matches at least one file. */
function exists(abs) {
  if (!abs) return false;
  if (!hasGlob(abs)) return fs.existsSync(abs);
  const dir = staticDir(abs);
  if (!fs.existsSync(dir)) return false;
  const rest = abs.slice(dir.length).replace(/^[\\/]+/, "");
  if (/^\*\*([\\/].*)?$/.test(rest)) {                    // dir/** or dir/**/x — any file below
    const tail = rest.replace(/^\*\*[\\/]?/, "");
    return walkAny(dir, tail ? globToRegExp(path.basename(tail)) : null, 6);
  }
  if (!/[\\/]/.test(rest)) {                               // dir/*.ext
    const rx = globToRegExp(rest);
    try { return fs.readdirSync(dir).some(f => rx.test(f)); } catch { return false; }
  }
  return walkAny(dir, globToRegExp(path.basename(rest)), 6);
}

function walkAny(dir, rx, depth) {
  if (depth < 0) return false;
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
  for (const e of ents) {
    if (e.isFile() && (!rx || rx.test(e.name))) return true;
    if (e.isDirectory() && walkAny(path.join(dir, e.name), rx, depth - 1)) return true;
  }
  return false;
}

/**
 * Resolve a declared file list.
 * @param {string[]} files     declared entries (relative, absolute or glob)
 * @param {{bases?: string[], requireGlobs?: boolean}} opts  candidate bases for relative entries
 *   (default: candidateBases(ROOT)). `requireGlobs: false` (fix D2 — what `pass … done` uses, as
 *   the old engine did) never counts a glob entry as missing or unresolvable: only literal
 *   declared files must exist. A glob is a claim on a folder's future contents, and a pass may
 *   legitimately move or rename that folder away. Default true keeps `resume`'s reconciliation.
 * @returns {{ resolved: {decl, abs, exists}[], missing: string[], unresolvable: boolean, base: string }}
 *   `missing` lists declared entries (as written) that do not exist. `unresolvable` is true when
 *   entries were declared, none exists, and not one of their folders exists either — then
 *   `missing` must be read as "cannot resolve", not "absent".
 */
export function resolveDeclared(files, { bases, requireGlobs = true } = {}) {
  const decls = (files || []).map(f => String(f == null ? "" : f).trim()).filter(Boolean);
  const cands = (bases && bases.length ? bases : candidateBases(ROOT)).map(b => path.resolve(b));
  const rel = decls.filter(d => !isAbs(d) && !/^~([\\/]|$)/.test(d));

  let base = cands[0], bestHits = -1, bestDirs = -1;
  for (const c of cands) {
    const hits = rel.filter(d => exists(resolveOne(d, c))).length;
    const dirs = rel.filter(d => fs.existsSync(staticDir(resolveOne(d, c)))).length;
    if (hits > bestHits || (hits === bestHits && dirs > bestDirs)) { base = c; bestHits = hits; bestDirs = dirs; }
  }

  const resolved = decls.map(decl => {
    const abs = resolveOne(decl, base);
    return { decl, abs, exists: exists(abs) };
  });
  const judged = requireGlobs ? resolved : resolved.filter(r => !hasGlob(r.decl));
  const missing = judged.filter(r => !r.exists).map(r => r.decl);
  const anyExists = judged.some(r => r.exists);
  const anyAnchored = judged.some(r => fs.existsSync(staticDir(r.abs)));
  const unresolvable = judged.length > 0 && !anyExists && !anyAnchored;
  return { resolved, missing, unresolvable, base };
}
