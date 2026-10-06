// lib/house.mjs — house adapters: the only place the engine reads a project's own files.
//
// Every reader here takes its location from config.json (lib/config.mjs) — there is no project
// folder name in this file. Absent setting = feature off = an empty answer, never a guess.
//
//   loadHouseRules     house-rules.md → the three sections the engine hands on (CONTRACT §3)
//   readFrozenStatus   one FROZEN.md → "frozen" | "not_frozen" | "no_reader"   (obs 0009 / 0040)
//   listFrozenScreens  every <frozen_dir>/<screen>/FROZEN.md
//   parseClaimsTable   a claims board → rows, found by HEADER NAME, plus the released ids (obs 0089)
//   readClaims         the live claims (released and ghost rows dropped, pointer stub = none)
//   readExtraSources   the optional open-loops and pending-push files
import path from "node:path";
import { ROOT } from "./paths.mjs";
import { readText, globDirs } from "./util.mjs";
import { resolveHousePath } from "./config.mjs";

// ================================================================ house-rules.md

const SECTIONS = {
  "for the conductor": "conductor",
  "for every worker": "worker",
  "before a run is called finished": "beforeFinished"
};

export function houseRulesPath(root = ROOT) {
  return path.join(root, ".claude", "one-go", "house-rules.md");
}

/**
 * Read `<root>/.claude/one-go/house-rules.md`. Exactly three `## ` sections are read; a body runs
 * to the next `## ` heading (outside a code fence) or end of file. Missing file/section = "".
 */
export function loadHouseRules(root = ROOT) {
  const file = houseRulesPath(root);
  const out = { present: false, path: file, conductor: "", worker: "", beforeFinished: "" };
  const text = readText(file);
  if (text == null) return out;
  out.present = true;

  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  let current = null, buf = [], fence = false;
  const flush = () => {
    if (current && !out[current]) out[current] = trimBlankLines(buf).join("\n");
    buf = [];
  };
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && /^##\s/.test(line)) {
      flush();
      const name = line.replace(/^##\s+/, "").replace(/\s+#*\s*$/, "").trim().toLowerCase();
      current = SECTIONS[name] || null;
      continue;
    }
    if (current) buf.push(line);
  }
  flush();
  return out;
}

function trimBlankLines(lines) {
  let a = 0, b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b);
}

// ================================================================ FROZEN.md status reader
//
// ONE reader for the board, start and finish (obs 0040: two readers of one table disagreed and
// the one shown to the person was wrong). Negation-aware (obs 0009: "drafted, not frozen",
// "Unfrozen", "REOPENED" all contain the word FROZEN and used to read as frozen). And when the
// table cannot be read it says so — "no_reader" — never a confident "not frozen".

const NEGATED = [
  /\b(?:not|never|no\s+longer|isn'?t|wasn'?t|no)\s+(?:yet\s+|been\s+|fully\s+)*frozen\b/i,
  /\bun-?\s?frozen\b/i,
  /\bde-?frozen\b/i,
  /\bre-?opened\b/i,
  /\bthawed\b/i,
  /\bwas\s+frozen\b/i,
  /\bunfreez/i
];
const AFFIRMATIVE = /(?<![A-Za-z])frozen(?![A-Za-z])/i;
// The in-progress words the old reader counted, plus the drafting words obs 0009 names. Kept
// narrow on purpose: "Proven, one open finding" is not an unfrozen step.
const OPEN_WORDS = /\b(?:in\s+progress|not\s+started|waiting|drafting|drafted|draft)\b/i;

/** One status cell → "frozen" | "open" | "other" | "empty". `other` = a non-freeze word (built, proven…). */
export function classifyFrozenCell(cell) {
  const s = String(cell == null ? "" : cell).replace(/[*_`]/g, " ").replace(/\s+/g, " ").trim();
  if (!s || /^[-—–]+$/.test(s)) return "empty";
  if (NEGATED.some(rx => rx.test(s))) return "open";
  if (AFFIRMATIVE.test(s)) return "frozen";
  if (OPEN_WORDS.test(s)) return "open";
  return "other";
}

/** Split a markdown table row into its cells (keeps empty cells; `\|` and backtick spans stay whole). */
export function splitRow(line) {
  let s = String(line).trim();
  if (!s.startsWith("|")) return null;
  const cells = [];
  let cur = "", tick = false;
  for (let i = 1; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") { cur += "|"; i++; continue; }
    if (ch === "`") tick = !tick;
    if (ch === "|" && !tick) { cells.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) cells.push(cur.trim());      // a row with no closing pipe keeps its last cell
  return cells;
}

const stripMarks = s => String(s || "").replace(/[*_`]/g, "").trim();

/**
 * Every step row in a FROZEN.md status table: [{ step, label, state, status }] where `status` is
 * classifyFrozenCell(state). A step row is a table row whose first cell starts with a number
 * ("**3 · Contract**", "3. Contract", "Step 3 — Contract"). Rows inside a table whose header's
 * first cell says "Step" are preferred; other numbered tables are used only when no such table exists.
 */
export function readFrozenSteps(text) {
  const inStep = [], loose = [];
  let fence = false, stepTable = false;
  for (const line of String(text || "").split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; stepTable = false; continue; }
    if (fence) continue;
    const cells = splitRow(line);
    if (!cells) { stepTable = false; continue; }
    if (cells.length < 2) continue;
    const first = stripMarks(cells[0]);
    if (/^step\b/i.test(first) && !/\d/.test(first)) { stepTable = true; continue; }
    const m = first.match(/^(?:step\s*)?(\d{1,2})\b\s*[·.\-—–:)]?\s*(.*)$/i);
    if (!m) continue;
    const row = { step: Number(m[1]), label: m[2].trim(), state: cells[1], status: classifyFrozenCell(cells[1]) };
    (stepTable ? inStep : loose).push(row);
  }
  return inStep.length ? inStep : loose;
}

/**
 * Is step 3 (the Contract) frozen? → "frozen" | "not_frozen" | "no_reader".
 * Reads the status-table row for step 3; when there is no table, the old one-line form
 * ("Step 3 — Contract: FROZEN 2026-09-03") is read from the text after the word Contract.
 * Nothing readable = "no_reader": absence of a parse is not evidence of an unfrozen step.
 */
export function readFrozenStatus(text) {
  if (!text || !String(text).trim()) return "no_reader";
  const verdict = c => (c === "frozen" ? "frozen" : c === "empty" ? "no_reader" : "not_frozen");
  const rows = readFrozenSteps(text).filter(r => r.step === 3);
  const row = rows.find(r => /contract/i.test(r.label)) || rows[0];
  if (row) return verdict(row.status);
  let fence = false;
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence || line.trim().startsWith("|")) continue;
    if (!/(?:step\s*3\b|(?:^|[^\d])3\s*[·.\-)])/i.test(line)) continue;
    const at = line.search(/contract/i);
    if (at === -1) continue;
    const rest = line.slice(at + "contract".length).replace(/^[\s*_`:|—–-]+/, "");
    return verdict(classifyFrozenCell(rest));
  }
  return "no_reader";
}

/**
 * Every screen under the configured frozen folders: [{ id, dir, status, allFrozen, file }].
 * `status` = readFrozenStatus (step 3). `allFrozen` = no step row still reads open — the board
 * skips those screens. Folders starting with `_` or `.` (e.g. `_superseded`) are not screens.
 */
export function listFrozenScreens(root = ROOT, config = {}) {
  const out = [];
  for (const d of config.frozen_dirs || []) {
    const base = resolveHousePath(d, root);
    if (!base) continue;
    for (const id of globDirs(base).sort()) {
      if (id.startsWith("_") || id.startsWith(".")) continue;
      const file = path.join(base, id, "FROZEN.md");
      const text = readText(file);
      if (text == null) continue;
      const steps = readFrozenSteps(text);
      const status = readFrozenStatus(text);
      const counted = steps.filter(s => s.status === "frozen" || s.status === "open");
      const allFrozen = counted.length > 0 && counted.every(s => s.status === "frozen");
      out.push({ id, dir: path.join(base, id), file, status, allFrozen });
    }
  }
  return out;
}

// ================================================================ claims board
//
// Three real layouts exist (files in column 6, 4 and 5 — obs triage, plan "Claim boards"), so a
// fixed column number was wrong in two of three projects. The Files column is found by its
// HEADER NAME. A row sitting above its header row (one board does this) takes the section's
// header. An id that also appears under "Recently released", or whose Status cell says released
// or expired, is released — the old row is a ghost (obs 0089).

const COL = {
  id: /claim\s*id/i,
  files: /^files/i,
  task: /^task/i,
  owner: /^owner/i,
  status: /^status/i
};
// abandoned / finished added with the 2026-09-28 port (the live claim reader's FINISHED words).
const RELEASED_STATUS = /^(?:released|expired|closed|done|abandoned|finished)\b/i;
const RELEASED_CELL = /^(?:released|expired)\s+(?:\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2})/i;
const ID_SHAPE = /^[A-Za-z][\w.:#/-]*[-\d][\w.:#/-]*$/;   // one token with a dash or digit (C-…, CL-12)

function headerMap(cells) {
  const find = rx => cells.findIndex(c => rx.test(stripMarks(c)));
  return { id: find(COL.id), files: find(COL.files), task: find(COL.task), owner: find(COL.owner), status: find(COL.status) };
}

// 0106: a table row outside the Active claims table that still reads as a live claim: an
// id-shaped first cell and a cell that opens with the word OPEN (`OPEN 2026-09-23 …`), none of
// them saying released/expired.
function looksOpenRow(cells) {
  if (cells.length < 3) return false;
  const marks = cells.map(stripMarks);
  const id = marks[0];
  if (!id || /^open$/i.test(id) || !ID_SHAPE.test(id)) return false;
  if (marks.some(c => RELEASED_STATUS.test(c) || RELEASED_CELL.test(c))) return false;
  return marks.slice(1).some(c => /^open\b/i.test(c));
}

function sectionOf(line) {
  const m = line.match(/^(#{1,6})\s+(.*)$/);
  if (!m) return undefined;                                  // not a heading
  const name = m[2];
  if (/active\s+claims/i.test(name)) return "active";
  if (/recently\s+released/i.test(name)) return "released";
  return m[1].length <= 2 ? null : undefined;                // a level-3+ heading stays inside
}

/**
 * Walk a claims board line by line. Returns one entry per line:
 *   { i, section: "active"|"released"|null, kind: "header"|"sep"|"row"|"bullet"|"other",
 *     cells?, header?, id? }
 * Rows in an active section that come before any header get the section's first header.
 * Used by parseClaimsTable (read) and lib/claims.mjs (rewrite), so both read one grammar.
 */
export function scanClaimLines(text) {
  const lines = String(text || "").split("\n");
  const out = [];
  let section = null, fence = false;
  let header = null, sectionHeader = null, pending = [], firstHeader = null;
  const closeSection = () => {
    for (const e of pending) e.header = sectionHeader || firstHeader || null;
    pending = [];
    header = null; sectionHeader = null;
  };
  lines.forEach((raw, i) => {
    const line = raw.replace(/\r$/, "");
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; out.push({ i, section, kind: "other" }); return; }
    if (!fence) {
      const s = sectionOf(line);
      if (s !== undefined) {
        closeSection();
        section = s;
        out.push({ i, section, kind: "other" });
        return;
      }
    }
    const cells = !fence ? splitRow(line) : null;
    if (cells && section !== "active") {
      // 0106: an OPEN claim row written outside the Active claims table is reported, not skipped.
      const isSep = /^\|?\s*:?-{3,}/.test(line.trim()) && cells.every(c => /^:?-*:?$/.test(c));
      const isHead = cells.some(c => COL.id.test(stripMarks(c)));
      if (!isSep && !isHead && looksOpenRow(cells)) {
        const e = { i, section, kind: "misplaced", cells, header: header || null };
        out.push(e); return;
      }
    }
    if (cells && section) {
      if (/^\|?\s*:?-{3,}/.test(line.trim()) && cells.every(c => /^:?-*:?$/.test(c))) {
        out.push({ i, section, kind: "sep" }); return;
      }
      if (cells.some(c => COL.id.test(stripMarks(c)))) {
        header = headerMap(cells);
        if (!sectionHeader) sectionHeader = header;
        if (!firstHeader) firstHeader = header;
        for (const e of pending) e.header = header;
        pending = [];
        out.push({ i, section, kind: "header", cells, header }); return;
      }
      const e = { i, section, kind: "row", cells, header };
      if (!header && section === "active") pending.push(e);
      out.push(e); return;
    }
    if (!fence && section === "released" && /^\s*[-*+]\s+/.test(line)) {
      const tok = stripMarks(line.replace(/^\s*[-*+]\s+/, "")).split(/\s+/)[0] || "";
      out.push({ i, section, kind: "bullet", id: tok.replace(/[,;:.]+$/, "") }); return;
    }
    out.push({ i, section, kind: "other" });
  });
  closeSection();
  for (const e of out) {
    if (e.kind === "misplaced" && !e.header) e.header = firstHeader || null;
    if (e.kind !== "row" && e.kind !== "misplaced") continue;
    const h = e.header;
    const idCell = h && h.id >= 0 ? e.cells[h.id] : e.cells[0];
    e.id = stripMarks(idCell);
  }
  return out;
}

/** Brace expansion for a claimed path: `docs/{a,b}/**` → two entries (overlap does not expand braces). */
function expandBraces(p, limit = 64) {
  const m = p.match(/^(.*?)\{([^{}]*)\}(.*)$/);
  if (!m) return [p];
  const out = [];
  for (const alt of m[2].split(",")) {
    for (const x of expandBraces(m[1] + alt.trim() + m[3], limit)) {
      if (out.length >= limit) return out;
      out.push(x);
    }
  }
  return out;
}

/**
 * A Files cell → path list. Split on top-level commas/semicolons (not inside backticks, braces,
 * brackets or parentheses); drop a parenthesised note that follows a path (` (new, pass 11)`);
 * in a part that carries backtick spans, the spans are the paths and the rest is prose.
 * Globs (`**`) are kept; `{a,b}` is expanded.
 */
export function parseFilesCell(cell) {
  const s = String(cell || "");
  const parts = [];
  let depth = 0, tick = false, cur = "";
  for (const ch of s) {
    if (ch === "`") tick = !tick;
    if (!tick && (ch === "(" || ch === "{" || ch === "[")) depth++;
    if (!tick && (ch === ")" || ch === "}" || ch === "]")) depth = Math.max(0, depth - 1);
    if ((ch === "," || ch === ";") && depth === 0 && !tick) { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  parts.push(cur);

  const out = [];
  for (let part of parts) {
    part = part.replace(/\s\((?:[^()]|\([^()]*\))*\)/g, " ");          // notes, not route groups
    const ticks = [...part.matchAll(/`([^`]+)`/g)].map(m => m[1]);
    for (let x of ticks.length ? ticks : [part]) {
      x = x.replace(/^[\s"'\\]+|[\s"'\\]+$/g, "").trim();
      if (/^\*\*[^/*].*[^/*]\*\*$/.test(x)) x = x.slice(2, -2).trim();  // **bold** wrapper, not a glob
      if (!x || /^[—–-]+$/.test(x)) continue;
      for (const e of expandBraces(x)) if (e.trim()) out.push(e.trim());
    }
  }
  return out;
}

/**
 * @returns {{ rows: {id, claim, files: string[], task, owner, status, cells}[],
 *             released: Set<string>, filesColumn: number }}
 * `rows` = every row under an `## Active claims` heading (released ones included — readClaims
 * filters). `released` = ids under a "Recently released" heading plus active rows whose Status
 * says released/expired. `filesColumn` = 0-based index of the Files column in the first header
 * found, or -1 when no header names one.
 */
export function parseClaimsTable(text) {
  const rows = [];
  const released = new Set();
  const misplaced = [], bad = [];
  const lines = String(text || "").split("\n");
  let filesColumn = -1, sawHeader = false;
  for (const e of scanClaimLines(text)) {
    if (e.kind === "header" && !sawHeader) { sawHeader = true; filesColumn = e.header.files; }
    if (e.kind === "misplaced") {
      const h = e.header || { id: -1, files: -1, task: -1, owner: -1, status: -1 };
      const at = k => (h[k] >= 0 ? e.cells[h[k]] || "" : "");
      const why = badClaimReason(lines[e.i], at("files"));
      if (why) bad.push({ id: e.id, line: e.i + 1, reason: why });
      else misplaced.push({ id: e.id, line: e.i + 1, files: parseFilesCell(at("files")), task: stripMarks(at("task")) });
      continue;
    }
    if (e.section === "released") {
      if ((e.kind === "row" || e.kind === "bullet") && e.id && ID_SHAPE.test(e.id)) released.add(e.id);
      continue;
    }
    if (e.section !== "active" || e.kind !== "row") continue;
    if (!e.id || !ID_SHAPE.test(e.id)) continue;
    const h = e.header || { id: -1, files: -1, task: -1, owner: -1, status: -1 };
    const at = k => (h[k] >= 0 ? e.cells[h[k]] || "" : "");
    // 0115: a row holding control characters, or a drive path with no slash after `C:`, matches
    // no real path. Refuse it and name it — never let it pass as a reservation.
    const why = badClaimReason(lines[e.i], at("files"));
    if (why) { bad.push({ id: e.id, line: e.i + 1, reason: why }); continue; }
    const row = {
      id: e.id,
      claim: e.id,                                   // alias read by lib/overlap.mjs claimConflicts
      files: parseFilesCell(at("files")),
      task: stripMarks(at("task")),
      owner: stripMarks(at("owner")),
      status: stripMarks(at("status")),
      cells: e.cells
    };
    // Released in place: the Status cell says so, or (a row pasted from another table) some
    // other cell opens with "released <date|time>" / "expired <date|time>".
    if (RELEASED_STATUS.test(row.status) ||
        e.cells.some((c, k) => k !== h.id && RELEASED_CELL.test(stripMarks(c)))) released.add(row.id);
    rows.push(row);
  }
  return { rows, released, filesColumn, misplaced, bad };
}

const CONTROL_CHARS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const BROKEN_DRIVE = /(^|[\s`"'(,;])[A-Za-z]:(?![\\/])[^\s`"',;)]/;

/** 0115: why a claim row cannot be trusted (control character, `C:Users…` drive path), or "". */
export function badClaimReason(rawLine, filesCell) {
  if (CONTROL_CHARS.test(String(rawLine || ""))) return "holds a control character (a backslash was eaten when the row was written)";
  const m = String(filesCell || "").match(BROKEN_DRIVE);
  if (m) return "has a drive path with no slash after the colon (`" + m[0].trim().replace(/^[`"'(,;]/, "").slice(0, 30) + "…`)";
  return "";
}

/**
 * The code folder the claims file lives in — the folder that holds its `.claude` directory, as a
 * prefix like `app-folder/` — or "" when the claims file sits at the workspace root. Claim rows
 * are often written repo-relative while plans are workspace-rooted; this is the prefix to strip
 * from both sides before comparing (0115).
 */
export function claimsFolderPrefix(claimsFile) {
  const s = String(claimsFile || "").replace(/\\/g, "/").replace(/^\.\//, "");
  const at = s.indexOf("/.claude/");
  if (at > 0) return s.slice(0, at + 1);
  const parts = s.split("/");
  return parts.length > 2 ? parts.slice(0, -1).join("/") + "/" : "";
}

/** The claims file for this project, or null when the claims feature is off. */
export function claimsFilePath(root = ROOT, config = {}) {
  return resolveHousePath(config.claims_file, root);
}

/**
 * The claims held right now. Off (no `claims_file`), missing file, or a pointer stub with no
 * `## Active claims` table → []. Released and ghost rows are dropped.
 */
export function readClaims(root = ROOT, config = {}) {
  const file = claimsFilePath(root, config);
  if (!file) return [];
  const text = readText(file);
  if (!text || !/^#{1,6}\s+.*active\s+claims/im.test(text)) return [];
  const { rows, released, misplaced, bad } = parseClaimsTable(text);
  const prefix = claimsFolderPrefix(config.claims_file);
  const live = rows.filter(r => !released.has(r.id)).map(r => ({ ...r, prefix }));
  // 0106 / 0115: what the reader would otherwise skip in silence. Non-enumerable, so the array
  // still compares equal to a plain list of rows; `start` and `lanes` print `claimProblems`.
  Object.defineProperty(live, "misplaced", { value: misplaced, enumerable: false });
  Object.defineProperty(live, "bad", { value: bad, enumerable: false });
  Object.defineProperty(live, "problems", { value: claimProblems({ misplaced, bad }), enumerable: false });
  return live;
}

/** One plain line per row the reader refused or found outside the table, naming the row. */
export function claimProblems({ misplaced = [], bad = [] } = {}) {
  return [
    ...bad.map(b => `claim row \`${b.id}\` (line ${b.line}) refused: ${b.reason}`),
    ...misplaced.map(m => `claim row \`${m.id}\` (line ${m.line}) is marked OPEN but sits outside the Active claims table, so it holds nothing — move it into the table or release it`)
  ];
}

// ================================================================ extra sources

/**
 * The optional extra board sources. Both are off unless config.extra_sources names them.
 * @returns {{ openLoops: Map<string,{date,what,owner,closed}>, openLoopsPath: string|null,
 *             openLoopsName: string, pendingPush: string|null, pendingPushPath: string|null }}
 * `pendingPush` = the first meaningful line of the pending-push file (a board footnote).
 */
export function readExtraSources(root = ROOT, config = {}) {
  const xs = config.extra_sources || {};
  const openLoopsPath = resolveHousePath(xs.open_loops, root);
  const pendingPushPath = resolveHousePath(xs.pending_push, root);

  const openLoops = new Map();
  const loopsText = openLoopsPath ? readText(openLoopsPath) || "" : "";
  for (const line of loopsText.split(/\r?\n/)) {
    if (!/^\|\s*L-\d+/.test(line)) continue;
    const cells = line.split("|").map(c => c.trim());
    const id = cells[1], date = cells[2] || "", what = cells[3] || "", owner = cells[4] || "";
    openLoops.set(id, { date, what, owner, closed: /^closed$/i.test(owner) || /\bCLOSED\b/.test(what) });
  }

  let pendingPush = null;
  const ppText = pendingPushPath ? readText(pendingPushPath) : null;
  if (ppText) {
    const first = ppText.split(/\r?\n/).find(l => {
      const x = l.trim();
      return x.length > 2 && !x.startsWith("#") && !x.startsWith(">") && !x.startsWith("|") && !/^[-=_\s]+$/.test(x);
    });
    if (first) pendingPush = first.trim();
  }

  return {
    openLoops, openLoopsPath,
    openLoopsName: openLoopsPath ? path.basename(openLoopsPath) : "the open-loops file",
    pendingPush, pendingPushPath
  };
}
