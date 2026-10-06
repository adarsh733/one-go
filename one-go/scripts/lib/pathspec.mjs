// lib/pathspec.mjs — one reading of a "file" entry, for every command that handles one.
//
// WHY THIS FILE EXISTS (2026-09-28, run 2026-09-28-1408-build-the-company-for-wedding)
// A file entry reaches the engine from three places — a plan's "Files it writes" cell, a plan
// JSON `writes` list, and ACTIVE-WORK.md's "Files / globs claimed" column — and each reader
// cleaned it differently, or not at all:
//   - the seal gate kept the backticks, so `.claude/agents/adversary.md` in backticks was
//     reported missing although it was on disk;
//   - `pass … done` never expanded braces, so `.claude/company/{a,b}` resolved to nothing and
//     the run's state.json had to be expanded by hand;
//   - the claim check split a claimed-files cell on every comma, cutting `{a0*,a1*}` into
//     scraps, one of which (`a1*`, no folder) was then read as "every file in the project".
// One cleaner, one brace expander, one brace-aware splitter. Pure functions, no disk access.

/** Words that make a whole cell mean "nothing declared". */
const EMPTY = /^(—|-|–|none|n\/a)$/i;

/** A trailing "(new)" says: this file is created by the pass, so it cannot exist at seal time. */
const NEW_MARK = /\s*\(\s*new\s*\)\s*$/i;

/**
 * Clean one file entry. Strips markdown (backticks, bold/italic markers, quotes), a trailing
 * "(new)" marker, any other trailing "(note)", and an em-dash tail of prose.
 * Returns { path, isNew } — `path` is "" when nothing path-like is left.
 */
export function cleanPathEntry(entry) {
  let s = String(entry == null ? "" : entry).trim();
  let isNew = false;
  // Markdown wrappers first, so "`x.md` (new)" and "`x.md (new)`" read the same.
  // Bold is stripped only when it WRAPS the entry — `docs/**` keeps its glob.
  const strip = t => {
    t = t.replace(/^[`"']+/, "").replace(/[`"']+$/, "").trim();
    const bold = t.match(/^(\*\*|__)(?!\/)(.+?)(?<!\/)\1$/);
    return bold ? bold[2].trim() : t;
  };
  s = strip(s);
  // Prose after a dash ("config.json (new) — nothing else in this project").
  s = s.replace(/\s+[—–]\s+.*$/, "").trim();
  // Trailing notes, as many as there are: "(new)", "(log hooks only)".
  for (let i = 0; i < 4; i++) {
    if (NEW_MARK.test(s)) { isNew = true; s = s.replace(NEW_MARK, "").trim(); s = strip(s); continue; }
    const note = s.match(/\s+\([^()]*\)\s*$/);
    if (note) { s = s.slice(0, note.index).trim(); s = strip(s); continue; }
    break;
  }
  if (EMPTY.test(s)) s = "";
  return { path: s, isNew };
}

/**
 * Expand every `{a,b}` group into its alternatives: `x/{a,b/c}.md` -> [`x/a.md`, `x/b/c.md`].
 * Nested groups work. A group with no comma, or an unbalanced brace, is left as written.
 */
export function expandBraces(s) {
  const str = String(s == null ? "" : s);
  const open = str.indexOf("{");
  if (open === -1) return [str];
  let depth = 0, close = -1;
  const commas = [];
  for (let i = open; i < str.length; i++) {
    const ch = str[i];
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) { close = i; break; } }
    else if (ch === "," && depth === 1) commas.push(i);
  }
  if (close === -1) return [str];                       // unbalanced: not a brace group
  const pre = str.slice(0, open);
  const post = str.slice(close + 1);
  if (!commas.length) {
    // `{x}` is not an alternation; keep it literally but still expand anything after it.
    return expandBraces(post).map(rest => pre + str.slice(open, close + 1) + rest);
  }
  const bounds = [open, ...commas, close];
  const alts = [];
  for (let i = 0; i < bounds.length - 1; i++) alts.push(str.slice(bounds[i] + 1, bounds[i + 1]));
  const out = [];
  for (const alt of alts) for (const x of expandBraces(pre + alt + post)) out.push(x);
  return out;
}

/**
 * Split a cell holding several paths. Commas and semicolons separate paths EXCEPT inside
 * `{...}` (a brace expansion) and inside `(...)` (a note such as "(log hooks only, see D-9)").
 */
export function splitPathList(cell) {
  const s = String(cell || "");
  const out = [];
  let buf = "";
  let brace = 0, paren = 0;
  for (const ch of s) {
    if (ch === "{") brace++;
    else if (ch === "}") brace = Math.max(0, brace - 1);
    else if (ch === "(") paren++;
    else if (ch === ")") paren = Math.max(0, paren - 1);
    if ((ch === "," || ch === ";") && brace === 0 && paren === 0) {
      out.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out.map(f => f.trim()).filter(f => f && !EMPTY.test(f));
}

/**
 * A list of raw entries -> concrete, cleaned, brace-expanded paths, each with its "(new)" flag.
 * A "(new)" written on a brace entry applies to every path it expands into.
 */
export function expandPathEntries(entries) {
  const out = [];
  const seen = new Set();
  for (const raw of entries || []) {
    const outer = cleanPathEntry(raw);
    if (!outer.path) continue;
    for (const one of expandBraces(outer.path)) {
      const inner = cleanPathEntry(one);
      if (!inner.path || seen.has(inner.path)) continue;
      seen.add(inner.path);
      out.push({ path: inner.path, isNew: outer.isNew || inner.isNew });
    }
  }
  return out;
}
