// lib/plan.mjs — one reader for the sealed plan, so every command sees the same passes.
//
// WHY THIS FILE EXISTS
// `finish` and `start` each had their own copy of the same fragile table parser, and they did
// not agree: `finish` read four columns, `start` read six and then discarded the sixth. So the
// preview the person approved and the run that was created from it were parsed by different code.
// One parser now, used by both.
//
// THE TABLE
//   | # | What it does | Model | Files it writes | Proven by | Depends on | Part |
// The last two columns are optional, so every plan sealed before them still parses. `Part` is
// what makes `finish <job>/<part>` mean something: without it, scoping to one part ran the
// whole job's passes anyway. A further optional column `Generates` (D11) lists the files a pass's
// check rewrites as a side effect; it is parsed into `generated_outputs` and the verification step
// ignores those paths when deciding "a file changed during verification".
//
// THE HUMAN PLAN FILE IS NEVER REWRITTEN
// `plans/<slug>.md` is what a person (or the sealing worker) wrote: reading list, questions,
// answers, notes. The engine only ever writes the machine plan `plans/<slug>.plan.json` beside
// it and a generated readable view into the RUN folder (`<run>/plan.md`, see writePlanView).
// Before this, loading a plan overwrote the `.md` with a passes-only view and erased everything
// else in it. The run's copy is MERGED with the human file (mergeReadablePlan), so a worker
// reading `<run>/plan.md` still sees the reading list, the questions and the notes.
//
// FILE CELLS (2026-09-28 port): every declared file is read through lib/pathspec.mjs — markdown
// stripped, a trailing "(new)" recorded in `new_files`, braces expanded where a single path is
// needed. A "(new)" file is created by its pass, so the seal gate does not look it up.
import fs from "node:fs";
import path from "node:path";
import { parseDepends, validateGraph } from "./graph.mjs";
import { slugify } from "./util.mjs";
import { writeFileAtomic } from "./atomic.mjs";
import { cleanPathEntry, expandPathEntries, splitPathList } from "./pathspec.mjs";
import { pathsOverlap } from "./overlap.mjs";
import { isKnownModelText, isUnsetModel, PLAN_ENGINE } from "./route.mjs";

const SEALED = /^State:\s*sealed/im;

/**
 * Runs created on or after this date are held to the seal gate at `start`; older runs are
 * never re-judged (they were sealed under the older, looser rules).
 */
export const SEAL_GATE_CUTOFF = "2026-09-22";

/** Does the seal gate apply to a run created on `ymd` (YYYY-MM-DD)? */
export function sealGateApplies(ymd) {
  return String(ymd || "") >= SEAL_GATE_CUTOFF;
}

export function isSealed(planText) {
  if (!planText) return false;
  if (typeof planText === "object") return Boolean(planText.plan_id || planText.schema);
  return Boolean(SEALED.test(String(planText)));
}

/**
 * Normalise a plan cell before ANY equality test or shape test runs on it.
 *
 * obs 0051, way 2 ("surviving markdown"): the table parser stores a `Proven by` cell WITH its
 * markdown backticks/fences still attached (`` `node x.mjs` ``, or a full ```` ```block``` ````).
 * Two cells that read identically to a human — one fenced, one bare — compared unequal, and a
 * refusal named them both. Every reader of a check-cell must see the same bare string, so this
 * runs once, here, and both `looksLikeCommand` and `parsePlan` route through it.
 */
export function normalizeCell(s) {
  let out = String(s == null ? "" : s).trim();
  // Triple-backtick fence, optionally with a language tag: ```js\ncmd\n```
  const fence = out.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  if (fence) out = fence[1].trim();
  // Strip any run of leading/trailing backticks left over (single- or double-backtick spans).
  out = out.replace(/^`+/, "").replace(/`+$/, "").trim();
  // Collapse internal whitespace/newlines so a wrapped cell still compares as one command.
  out = out.replace(/\s+/g, " ").trim();
  return out;
}

export function looksLikeCommand(cmd) {
  if (!cmd || typeof cmd !== "string") return false;
  const s = normalizeCell(cmd);
  if (!s || /^(—|-|–|none|n\/a|tbd)$/i.test(s)) return false;
  if (/^(node|npm|npx|python|python3|bash|sh|pytest|git|make|cargo|deno|bun)\b/i.test(s)) return true;
  if (/\.(js|mjs|cjs|py|sh|bat|cmd|exe)\b/i.test(s)) return true;
  if (/^[.\/\\].+/i.test(s)) return true;
  return false;
}

/**
 * Pick the first token in a check command that looks like a file path — what the seal-time
 * root check resolves. Skips the interpreter word and any `--flag`.
 */
export function extractCheckTarget(cmd) {
  const s = normalizeCell(cmd);
  if (!s) return null;
  const tokens = s.split(" ").filter(Boolean);
  for (const t of tokens) {
    if (t.startsWith("-")) continue;
    if (/^(node|npm|npx|python3?|bash|sh|pytest|git|make|cargo|deno|bun)$/i.test(t)) continue;
    if (/[\\/]/.test(t) || /\.(mjs|cjs|js|py|sh|bat|cmd)$/i.test(t)) return t;
  }
  return null;
}

// obs 0053 / 0070: a pass whose CHECK drives the whole app — a capture run, a screenshot sweep,
// a journey suite, a review page — proves the whole tree, not its own files. Only that proof step
// has to run alone: the pass itself may BUILD beside anything whose files it does not share.
// The tag `capture-tree` marks such a pass; `passesConflict` (lib/overlap.mjs) does not treat it
// as a clash (PROOF_ONLY_TAGS), and `wholeTreeConflict` (lib/evidence.mjs) holds only the check.
//
// ONE list, shared with lib/evidence.mjs. Read from the "Proven by" command ONLY — a description
// that says "match the screenshot" is not a check that drives the app.
// playwright, cypress and e2e are the names most projects give the same kind of check.
export const WHOLE_TREE_CHECK_WORDS = ["capture", "screenshot", "shoot", "review-page", "journey", "playwright", "cypress", "e2e"];
const WHOLE_TREE_CHECK_RE = new RegExp(`\\b(${WHOLE_TREE_CHECK_WORDS.join("|")})\\b`, "i");

/** The whole-app word a check command uses (lower-cased), or null. Reads the command only. */
export function wholeTreeCheckWord(command) {
  const m = String(command || "").match(WHOLE_TREE_CHECK_RE);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Tag every pass whose "Proven by" command uses a whole-app check word with `capture-tree` in
 * `shared_resources`, in place. Idempotent — running it twice does not duplicate the tag.
 * Returns the passes it touched, for the seal output to explain itself.
 */
export function applyCaptureTreeTags(plan) {
  const touched = [];
  for (const p of (plan && plan.passes) || []) {
    const check = String((p.required_check && p.required_check.command) || p.proven_by || "");
    const word = wholeTreeCheckWord(check);
    if (!word) continue;
    if (!Array.isArray(p.shared_resources)) p.shared_resources = [];
    if (!p.shared_resources.includes("capture-tree")) p.shared_resources.push("capture-tree");
    touched.push({ n: p.n, matched: word });
  }
  return touched;
}

// ---------------------------------------------------------------- declared-path helpers
const IS_WIN = process.platform === "win32";

/** One comparable form for a folder or file path: absolute, forward slashes, no trailing slash. */
function normPath(p) {
  let s = String(p || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (IS_WIN) s = s.toLowerCase();
  return s;
}

function isGlob(decl) { return /[*{?]/.test(String(decl || "")); }

/** The folder part of a declared glob before its first wildcard segment (`a/b/**` → `a/b`). */
function staticBase(decl) {
  const segs = String(decl).replace(/\\/g, "/").split("/");
  const out = [];
  for (const s of segs) {
    if (/[*{?]/.test(s)) break;
    out.push(s);
  }
  return out.join("/") || ".";
}

/** Is `inner` the same folder as `outer`, or somewhere inside it? (Both already normPath'd.) */
function sameOrInside(inner, outer) {
  return inner === outer || inner.startsWith(outer + "/");
}

/**
 * Will writing what `decl` declares create (or live inside) `folderAbs`?
 *  - a plain file declaration creates its own folder and every folder above it;
 *  - `dir/**` creates `dir`, anything under it, and every folder above it;
 *  - `dir/*.ext` (one level) creates `dir` and the folders above it, nothing below.
 */
function declarationCoversFolder(decl, folderAbs, root) {
  const folder = normPath(folderAbs);
  if (!isGlob(decl)) {
    const own = normPath(path.dirname(path.resolve(root, decl)));
    return sameOrInside(own, folder);
  }
  const base = normPath(path.resolve(root, staticBase(decl)));
  if (sameOrInside(base, folder)) return true;                      // folder is the base or above it
  if (/\*\*/.test(decl) && sameOrInside(folder, base)) return true; // a tree covers everything under it
  return false;
}

/**
 * A pass's declared writes as concrete entries: markdown stripped, braces expanded, each with
 * its "(new)" flag. The flag comes from a "(new)" written in the cell or the JSON `writes`
 * entry, or from the pass's `new_files` list (where parsePlan / normalizePlanFiles put it).
 */
export function declaredWrites(p) {
  const newSet = new Set((p.new_files || []).map(f => cleanPathEntry(f).path));
  const raw = (p.writes || p.files || []).map(f => {
    const c = cleanPathEntry(f);
    return c.isNew || newSet.has(c.path) ? `${c.path} (new)` : c.path;
  });
  return expandPathEntries(raw);
}

/** The folders of a path, deepest first: "a/b/c.md" -> ["a/b", "a"]. Stops at a glob. */
function foldersOf(p) {
  const segs = String(p).replace(/\\/g, "/").split("/");
  const cut = segs.findIndex(x => x.includes("*"));
  const fixed = cut === -1 ? segs.slice(0, -1) : segs.slice(0, cut);
  const out = [];
  for (let i = fixed.length; i > 0; i--) out.push(fixed.slice(0, i).join("/"));
  return out;
}

/** Every pass `n` depends on, directly or through another pass. */
function ancestorsOf(n, byN) {
  const out = new Set();
  const first = byN.get(n) || {};
  const todo = [...(first.prerequisites || first.depends || [])];
  while (todo.length) {
    const d = todo.pop();
    if (out.has(d) || d === n) continue;
    out.add(d);
    const p = byN.get(d);
    if (p) todo.push(...(p.prerequisites || p.depends || []));
  }
  return out;
}

/**
 * Seal-time gate (obs 0051 + obs 0053 + obs 0062 + obs 0102). Call this on a plan that is ABOUT
 * to be sealed or started — not on every later read of an already-sealed plan, which would
 * retroactively strand a run already in flight. Refuses:
 *   1. a `Proven by` / `required_check.command` cell that is not a runnable command (obs 0051,
 *      way 1 & 2 — after `normalizeCell` has already stripped any surviving markdown);
 *   2. a check command whose file target cannot be found under `root` (obs 0051, way 3);
 *   3. a declared file that does not exist under `root` AND whose folder does not exist either
 *      AND whose folder no earlier pass declares (obs 0102: a plan may declare a brand-new file
 *      as long as the place it goes is real or is being made by a pass that runs first).
 *      "Earlier" means a pass this one depends on, directly or through another pass — or, in a
 *      plan that declares no dependencies at all, any lower-numbered pass;
 *   4. a Passes row the markdown reader could not split cleanly (an escaped `\|`, or a cell
 *      count that differs from the header — obs 0062). These come from the plan's text and are
 *      carried on `plan.migration.row_errors` by migrateLegacyPlan.
 * Skips checks 2 and 3 when `root` is not given, so a caller who only wants the cheap
 * command-shape check (1) can ask for just that.
 * Also applies the `capture-tree` tag (obs 0053) and reports which passes it touched.
 */
export function validateSealedPlan(plan, { root, config } = {}) {
  const errors = [];
  const passes = (plan && plan.passes) || [];

  const rowErrors = plan && plan.migration && Array.isArray(plan.migration.row_errors) ? plan.migration.row_errors : [];
  for (const e of rowErrors) errors.push(e);

  // Every declared write across the plan, and the folders it will bring into being (2026-09-28):
  // a check target that does not exist yet is fine when a pass declares it, or when it sits in
  // a folder this plan creates — nothing in that folder can exist at seal time.
  const allWrites = passes.flatMap(p => declaredWrites(p));
  const plannedFolders = new Set();
  if (root) {
    for (const w of allWrites) {
      for (const d of foldersOf(w.path)) {
        if (!fs.existsSync(path.resolve(root, d))) plannedFolders.add(d);
      }
    }
  }

  for (const p of passes) {
    const label = `Pass ${p.n} ("${p.purpose || p.title || "untitled"}")`;
    // The Model cell must be a tier, a model this project configured, or an old family word.
    // Old runs are never re-judged here (the gate only runs on new plans); an empty cell is fine.
    const modelWord = String((p.route && p.route.requested_model) || p.model || "").trim();
    if (modelWord && !/^(—|-|–)$/.test(modelWord) && !isUnsetModel(modelWord) && !isKnownModelText(modelWord, { config })) {
      errors.push(`${label}: the Model cell says "${modelWord}", which is not a tier — write think, build or mechanical.`);
    }
    const rawCheck = (p.required_check && p.required_check.command) || p.proven_by || "";
    const check = normalizeCell(rawCheck);
    // Same "nothing declared" convention parsePlan already uses for an empty cell.
    if (!check || /^(—|-|–|none|n\/a)$/i.test(check)) continue;

    if (!looksLikeCommand(check)) {
      errors.push(`${label}: the "Proven by" cell is not a runnable command ("${check}") — ` +
        `put the explanation in the pass purpose; this cell is executed.`);
      continue; // don't also chase a path inside prose that was never a command.
    }

    if (root) {
      const target = extractCheckTarget(check);
      if (target && !fs.existsSync(path.resolve(root, target))) {
        const declared = allWrites.some(w => pathsOverlap(w.path, target));
        const inNewFolder = foldersOf(target).some(d => plannedFolders.has(d));
        if (!declared && !inNewFolder) {
          errors.push(`${label}: the check command references "${target}", which does not exist ` +
            `under ${root} — fix the path or the declared root, or list it in the files a pass ` +
            `writes, before workers rely on it.`);
        }
      }
    }
  }

  if (root) {
    const byN = new Map(passes.map(p => [p.n, p]));
    const anyDepends = passes.some(p => (p.prerequisites || p.depends || []).length);
    for (const p of passes) {
      const label = `Pass ${p.n} ("${p.purpose || p.title || "untitled"}")`;
      const earlier = anyDepends
        ? [...ancestorsOf(p.n, byN)].map(n => byN.get(n)).filter(Boolean)
        : passes.filter(x => x.n < p.n);
      for (const raw of (p.writes || p.files || [])) {
        const f = cleanPathEntry(raw).path;   // backticks and notes off before any lookup
        if (!f || /[*{]/.test(f)) continue; // globs/brace expansions aren't a single target
        const isNew = declaredWrites({ writes: [raw], new_files: p.new_files }).some(w => w.isNew);
        if (isNew) continue;                // "(new)": this pass creates it
        const abs = path.resolve(root, f);
        if (fs.existsSync(abs)) continue;
        const folder = path.dirname(abs);
        let folderIsDir = false;
        try { folderIsDir = fs.statSync(folder).isDirectory(); } catch {}
        if (folderIsDir) continue; // a brand-new file in a real folder (obs 0102)
        const maker = earlier.find(x => (x.writes || x.files || []).some(d => {
          const c = cleanPathEntry(d).path;
          return c && declarationCoversFolder(c, folder, root);
        }));
        if (maker) continue;       // an earlier pass makes the folder
        errors.push(`${label}: declares the file "${f}", which does not exist under ${root}, and ` +
          `neither does its folder — and no earlier pass declares that folder. Fix the path, ` +
          `declare the folder in a pass this one depends on, fix the declared root, or, if this ` +
          `pass creates it, write "(new)" after it in the plan.`);
      }
    }
  }

  const tags = applyCaptureTreeTags(plan);
  return { errors, tags };
}


/** Split one markdown table row into trimmed cells, dropping the empty edges. */
function cells(row) {
  const parts = row.split("|");
  if (parts.length && parts[0].trim() === "") parts.shift();
  if (parts.length && parts[parts.length - 1].trim() === "") parts.pop();
  return parts.map(c => c.trim());
}

function isSeparator(row) { return /^\|[\s:|-]+\|?\s*$/.test(row); }
function isHeader(row) { return /^\|\s*#\s*\|/.test(row); }

/** The text of the `## Passes` section, stopping at the next `## ` heading ("" when absent). */
function passesBlock(planText) {
  // Stop at the next `## ` heading. Without this the block ran to EOF and every later
  // table in the plan (register paths, the questions, the seal) was read as a pass row —
  // which refused a correctly-templated plan with phantom duplicates.
  return (String(planText || "").split(/^##\s*Passes\s*$/im)[1] || "").split(/^##\s/m)[0];
}

/**
 * Rows the table reader cannot split honestly (obs 0062). The reader splits on EVERY `|`, so an
 * escaped `\|` inside a cell (or any stray pipe) silently cuts a row short: a file list or a
 * check command loses its tail, and nothing says so. This does not try to be clever about
 * escapes — it refuses, naming the row, so the plan is rewritten without the pipe.
 * Returns an array of sentences; empty when every row is the header's shape.
 */
export function rowShapeErrors(planText) {
  const block = passesBlock(planText);
  if (!block) return [];
  const lines = block.split("\n").map(l => l.trim()).filter(l => l.startsWith("|"));
  const header = lines.find(isHeader);
  if (!header) return ["the `## Passes` table has no header row (it must start `| # | What it does | Model | Files it writes | Proven by | Depends on |`)"];
  const width = cells(header).length;
  const out = [];
  if (width < 5) {
    out.push(`the \`## Passes\` header has ${width} columns; it needs at least # · What it does · Model · Files it writes · Proven by`);
  }
  for (const row of lines) {
    if (row === header || isSeparator(row) || isHeader(row)) continue;
    const c = cells(row);
    const label = `Passes row "${row.slice(0, 50)}${row.length > 50 ? "…" : ""}"`;
    if (/\\\|/.test(row)) {
      out.push(`${label} contains an escaped pipe \`\\|\` — the table reader splits on every \`|\`, so this ` +
        `row would be cut short. Rewrite the cell without a pipe character (say "or").`);
      continue;
    }
    if (c.length !== width) {
      out.push(`${label} has ${c.length} cells but the header has ${width} — a \`|\` inside a cell, or a ` +
        `missing cell, shifts every column after it. Make the row match the header.`);
    }
  }
  return out;
}

/**
 * Read the `## Passes` table into structured passes.
 * Returns { passes, errors, rowErrors } — never throws, so the caller can refuse with a
 * readable message. `rowErrors` (obs 0062) is kept apart from `errors` on purpose: an old plan
 * that is already running must keep loading exactly as before; only the seal gate and
 * checkPlan refuse on it.
 */
export function parsePlan(planText) {
  const errors = [];
  if (!planText) return { passes: [], errors: ["the plan file is empty or missing"], rowErrors: [] };

  const block = passesBlock(planText);
  if (!block) return { passes: [], errors: ["the sealed plan has no `## Passes` section"], rowErrors: [] };

  const rows = block.split("\n")
    .map(l => l.trim())
    .filter(l => l.startsWith("|") && !isSeparator(l) && !isHeader(l));

  // D11: an optional `Generates` column — found by its HEADER NAME, so it works wherever it sits
  // (the plan template puts it last). Absent column = no `generated_outputs` key at all.
  const headerRow = block.split("\n").map(l => l.trim()).find(l => l.startsWith("|") && isHeader(l));
  const generatesAt = headerRow ? cells(headerRow).findIndex(h => /^generates$/i.test(h.trim())) : -1;

  const passes = [];
  for (const row of rows) {
    const c = cells(row);
    if (!c.length) continue;
    const n = Number(String(c[0]).replace(/[^\d]/g, ""));
    if (!Number.isInteger(n) || !n) {
      errors.push(`a Passes row has no usable number: "${row.slice(0, 60)}"`);
      continue;
    }
    // Markdown off, "(new)" recorded separately — every reader downstream sees a bare path.
    const entries = splitFileCell(c[3]).map(cleanPathEntry).filter(e => e.path);
    const files = entries.map(e => e.path);
    const newFiles = entries.filter(e => e.isNew).map(e => e.path);
    const generated = generatesAt >= 0 && c[generatesAt] && !/^(—|-|–|none|n\/a)$/i.test(c[generatesAt].trim())
      ? splitFileCell(c[generatesAt]).map(cleanPathEntry).map(e => e.path).filter(Boolean)
      : [];
    passes.push({
      n,
      title: c[1] || `Pass ${n}`,
      model: c[2] || "",
      files,
      ...(newFiles.length ? { new_files: newFiles } : {}),
      ...(generated.length ? { generated_outputs: generated } : {}),
      proven_by: c[4] && !/^(—|-|–)$/.test(c[4]) ? normalizeCell(c[4]) : "",
      depends: parseDepends(c[5]),
      part: c[6] && !/^(—|-|–)$/.test(c[6]) ? slugify(c[6], 4) : null,
      part_label: c[6] && !/^(—|-|–)$/.test(c[6]) ? c[6] : null
    });
  }
  if (!passes.length) errors.push("the `## Passes` table has no rows");
  return { passes, errors, rowErrors: rowShapeErrors(planText) };
}

/**
 * Split a Passes-row "Files it writes" cell into paths.
 *
 * Commas and semicolons separate paths -- EXCEPT inside `{...}`, where a comma belongs to a
 * brace expansion and is part of one path. Before 2026-09-20 this was a bare `split(/[,;]/)`,
 * so the real plan cell `docs/frozen/j0{5,6}-*\/FROZEN.md` was stored as the two fragments
 * `docs/frozen/j0{5` and `6}-*\/FROZEN.md` -- neither of which is a path, so the allowed-writes
 * guard and the overlap check between passes were both reasoning about nonsense.
 */
export function splitFileCell(cell) {
  // Now also keeps a comma inside "(a note, like this)" with its path (2026-09-28).
  return splitPathList(cell);
}

/**
 * Which passes belong to one part?
 *
 * Explicit first: a `Part` column naming this part. Only if the plan has NO Part column at all
 * do we fall back to matching the part's words against the pass title — and a fallback match is
 * flagged, because guessing which passes belong to a part is exactly how D4 marked a whole part
 * finished after its first pass.
 */
export function passesForPart(passes, sub) {
  if (!sub) return { passes, guessed: false };
  const wantId = sub.id;
  const explicit = passes.filter(p => p.part && (p.part === wantId || p.part.startsWith(wantId) || wantId.startsWith(p.part)));
  if (explicit.length) return { passes: explicit, guessed: false };

  const anyPartColumn = passes.some(p => p.part);
  if (anyPartColumn) return { passes: [], guessed: false };   // the plan says which part each pass is; none is this one

  const needle = slugify(sub.title || sub.id, 4);
  const guessedList = passes.filter(p => {
    const t = slugify(p.title, 9);
    return t.includes(needle) || needle.includes(slugify(p.title, 4));
  });
  return { passes: guessedList, guessed: true };
}

/** Reduce a pass list to a self-contained scope: drop dependencies on passes not in the scope. */
export function scopeDependencies(scoped) {
  const inScope = new Set(scoped.map(p => p.n));
  return scoped.map(p => ({
    ...p,
    depends: (p.depends || []).filter(d => inScope.has(d)),
    dropped_depends: (p.depends || []).filter(d => !inScope.has(d))
  }));
}

/**
 * Render any plan field for the human-readable Markdown view.
 *
 * Structured answer objects (e.g. `{ answer: {...}, question_id, source }`) were reaching a
 * template literal directly, so `${a.answer}` on a non-string answer stringified to the
 * useless literal "[object Object]" — the person's actual words, lost from the document people
 * read (observation 0042, reproduced three times). Fixed generally: every field
 * that reaches this view — not just answers — is routed through this one stringifier, so the
 * next object-valued field fails loudly (visible JSON) instead of silently as "[object Object]".
 */
function mdValue(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(mdValue).filter(Boolean).join(", ");
  if (typeof v === "object") {
    // Structured objects (answers, choices, ...) usually carry one human-readable field.
    for (const key of ["text", "answer", "value", "label", "title", "summary"]) {
      if (typeof v[key] === "string" && v[key]) return v[key];
    }
    try { return JSON.stringify(v); } catch { return String(v); }
  }
  return String(v);
}

/**
 * Generate human-readable Markdown view with the authoritative plan fingerprint.
 */
export function generateReadablePlan(plan) {
  const lines = [];
  const title = mdValue(plan.requested_outcome) || mdValue(plan.task_id) || "Plan";
  lines.push(`# ${title}\n`);
  lines.push("State: sealed\n");
  lines.push(`Generated from ${plan.plan_id} revision ${plan.plan_revision}\n`);
  lines.push("## Passes\n");
  // The Generates column appears only when some pass records generated outputs, so a plan
  // without any renders exactly as before (D11).
  const hasGenerates = (plan.passes || []).some(p => Array.isArray(p.generated_outputs) && p.generated_outputs.length);
  lines.push(`| # | What it does | Model | Files it writes | Proven by | Depends on | Part |${hasGenerates ? " Generates |" : ""}`);
  lines.push(`|---|---|---|---|---|---|---|${hasGenerates ? "---|" : ""}`);
  for (const p of plan.passes || []) {
    const what = mdValue(p.purpose || p.title) || `Pass ${p.n}`;
    const model = mdValue(p.route?.requested_model || p.model) || "build";
    const newSet = new Set(p.new_files || []);
    const writes = mdValue((p.writes || p.files || []).map(f => newSet.has(f) ? `${f} (new)` : f)) || "—";
    const proven = mdValue(p.required_check?.command || p.proven_by) || "—";
    const deps = mdValue(p.prerequisites || p.depends) || "—";
    const part = mdValue(p.part) || "—";
    const gen = hasGenerates ? ` ${mdValue(p.generated_outputs) || "—"} |` : "";
    lines.push(`| ${p.n} | ${what} | ${model} | ${writes} | ${proven} | ${deps} | ${part} |${gen}`);
  }
  lines.push("");

  // obs 0053 / 0070 — say out loud which checks read the whole app, and that only the check waits.
  const captureTagged = (plan.passes || []).filter(p => Array.isArray(p.shared_resources) && p.shared_resources.includes("capture-tree"));
  if (captureTagged.length) {
    lines.push("## Shared resources (auto-tagged)\n");
    for (const p of captureTagged) {
      const word = wholeTreeCheckWord((p.required_check && p.required_check.command) || p.proven_by);
      lines.push(`- Pass ${p.n}: \`capture-tree\` — its check reads the whole app${word ? ` ("${word}")` : ""}, so the check runs only when no other pass is still writing; the pass itself builds beside the others`);
    }
    lines.push("");
  }

  if (Array.isArray(plan.aliases) && plan.aliases.length) {
    lines.push("## Aliases\n");
    for (const a of plan.aliases) lines.push(`- ${mdValue(a)}`);
    lines.push("");
  }
  if (Array.isArray(plan.old_run_links) && plan.old_run_links.length) {
    lines.push("## Old run links\n");
    for (const l of plan.old_run_links) lines.push(`- ${mdValue(l)}`);
    lines.push("");
  }
  if (Array.isArray(plan.answers) && plan.answers.length) {
    lines.push("## Answers\n");
    for (const a of plan.answers) lines.push(`> ${mdValue(a && typeof a === "object" && "answer" in a ? a.answer : a)}`);
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Losslessly migrate a legacy Markdown plan into the authoritative JSON schema.
 */
export function migrateLegacyPlan(slug, mdText) {
  const { passes, rowErrors } = parsePlan(mdText);
  const planId = `plan-${slug}`;

  // Parse Aliases
  const aliases = [];
  const aliasMatch = mdText.match(/##\s*Aliases\s*\n([\s\S]*?)(?=\n##|$)/i);
  if (aliasMatch) {
    for (const line of aliasMatch[1].split("\n")) {
      const m = line.match(/^-\s*(.+)/);
      if (m) aliases.push(m[1].trim());
    }
  }

  // Parse Old run links
  const oldRunLinks = [];
  const linksMatch = mdText.match(/##\s*Old run links\s*\n([\s\S]*?)(?=\n##|$)/i);
  if (linksMatch) {
    for (const line of linksMatch[1].split("\n")) {
      const m = line.match(/^-\s*(.+)/);
      if (m) oldRunLinks.push(m[1].trim());
    }
  }

  // Parse Answers — `## Answers`, or `## <Name>'s answers` as older plans titled it.
  const answers = [];
  const answersMatch = mdText.match(/##\s*(?:[^\n#]*?['’]s\s+)?answers\s*\n([\s\S]*?)(?=\n##|$)/i);
  if (answersMatch) {
    let qCount = 0;
    for (const line of answersMatch[1].split("\n")) {
      const m = line.match(/^>\s*(.+)/);
      if (m) {
        qCount++;
        answers.push({ question_id: `q${qCount}`, answer: m[1].trim(), source: "plan" });
      }
    }
  }

  const titleMatch = mdText.match(/^#\s*(.+)/m);
  const title = titleMatch ? titleMatch[1].trim() : slug;

  const allowedWrites = [];
  for (const p of passes) {
    for (const f of p.files || []) {
      if (!allowedWrites.includes(f)) allowedWrites.push(f);
    }
  }

  const structuredPasses = passes.map(p => ({
    n: p.n,
    pass_id: `${planId}:p${p.n}`,
    purpose: p.title || `Pass ${p.n}`,
    reads: [],
    writes: p.files || [],
    ...(p.new_files ? { new_files: p.new_files } : {}),
    ...(p.generated_outputs && p.generated_outputs.length ? { generated_outputs: p.generated_outputs } : {}),
    shared_resources: [],
    prerequisites: p.depends || [],
    exclusions: [],
    required_check: {
      check_id: `${planId}:p${p.n}:check`,
      command: p.proven_by || "node -e \"process.exit(0)\""
    },
    route: {
      tier: "build",
      requested_model: p.model || "build",
      requested_effort: "Medium",
      reason: "legacy migrated route"
    },
    part: p.part || null,
    part_label: p.part_label || null
  }));

  return {
    schema: 1,
    engine: PLAN_ENGINE,          // compat D11: a host this plan names is one this engine wrote
    plan_id: planId,
    plan_revision: 1,
    task_id: slug,
    requested_outcome: title,
    acceptance_conditions: ["the approved check exits zero"],
    inputs: [],
    allowed_writes: allowedWrites,
    shared_resources: [],
    exclusions: [],
    answers,
    aliases,
    old_run_links: oldRunLinks,
    handoff_id: "legacy-migration",
    route_policy: { allow_escalation: true },
    retry_policy: { max_attempts: 3 },
    usage_policy: { record_actual_only: true, unavailable_label: "unavailable" },
    migration: {
      source: `${slug}.md`,
      migrated_at: new Date().toISOString(),
      // obs 0062 — only present when a row could not be split honestly; the seal gate refuses on it.
      ...(rowErrors && rowErrors.length ? { row_errors: rowErrors } : {})
    },
    passes: structuredPasses
  };
}

/**
 * Write the generated readable view of `plan` to `<runDir>/plan.md` and return that path.
 * This is the ONLY place a generated view is written; the human `plans/<slug>.md` is never
 * touched (obs 0042d).
 */
export function writePlanView(runDir, plan, { humanPath = null } = {}) {
  const out = path.join(runDir, "plan.md");
  writeFileAtomic(out, viewText(plan, humanPath));
  return out;
}

/** The generated view, merged with the human plan file when there is one (read, never written). */
function viewText(plan, humanPath) {
  let human = "";
  if (humanPath) { try { human = fs.readFileSync(humanPath, "utf8"); } catch { /* none */ } }
  return mergeReadablePlan(human, generateReadablePlan(plan));
}

/**
 * Clean every pass's declared writes in place: markdown stripped, "(new)" moved out of the path
 * into `new_files`. Called on the in-memory plan only; the sealed JSON on disk is never rewritten.
 */
export function normalizePlanFiles(plan) {
  for (const p of (plan && plan.passes) || []) {
    const key = Array.isArray(p.writes) ? "writes" : Array.isArray(p.files) ? "files" : null;
    if (!key) continue;
    const newFiles = new Set(p.new_files || []);
    const clean = [];
    for (const raw of p[key]) {
      const c = cleanPathEntry(raw);
      if (!c.path) continue;
      if (c.isNew) newFiles.add(c.path);
      clean.push(c.path);
    }
    p[key] = clean;
    if (newFiles.size) p.new_files = [...newFiles];
  }
  return plan;
}

// ------------------------------------------------------------------ the run's view, merged
//
// 2026-09-28 (live fix, ported): the generated view only knows `## Passes`, the shared-resource
// tags and the answers. Written on its own, the reading list, the questions, the roster and
// "Decided by me" were lost. The view is now MERGED with the human file: the generator replaces
// only the sections it owns, and only the line kind it owns inside them. Everything else stays,
// in its place. Here the result goes to the run folder; the human file itself is never written.

// Sections the generator owns -> the kind of line it writes there. Other lines inside an owned
// section (a note under the Passes table, say) are kept. `always`: the generator is the only
// source, so its silence means "none"; otherwise its silence means "leave it alone".
const OWNED = {
  "passes": { item: /^\|/, always: true },
  "shared resources (auto-tagged)": { item: /^- /, always: true },
  "aliases": { item: /^- /, always: false },
  "old run links": { item: /^- /, always: false },
  "answers": { item: /^> /, always: false }
};

function sectionKey(heading) {
  const k = heading.replace(/^##\s*/, "").replace(/[’‘]/g, "'").trim().toLowerCase();
  // `## Answers`, or `## <Name>'s answers` as older plans titled it (same rule as migrateLegacyPlan).
  return /^(?:[^#]*?'s\s+)?answers$/.test(k) ? "answers" : k;
}

function splitSections(text) {
  const pre = [];
  const sections = [];
  for (const line of String(text).replace(/\r\n/g, "\n").split("\n")) {
    if (/^##\s/.test(line)) { sections.push({ heading: line, key: sectionKey(line), body: [] }); continue; }
    (sections.length ? sections[sections.length - 1].body : pre).push(line);
  }
  return { pre, sections };
}

function trimBlank(lines) {
  let a = 0, b = lines.length;
  while (a < b && !lines[a].trim()) a++;
  while (b > a && !lines[b - 1].trim()) b--;
  return lines.slice(a, b);
}

/**
 * Merge a freshly generated view into an existing plan text. The generator owns the title, the
 * `State:` and `Generated from` lines, and the sections in OWNED. Everything else in `existing`
 * survives. Idempotent: merging the same plan twice gives the same bytes.
 */
export function mergeReadablePlan(existing, generated) {
  if (!existing || !String(existing).trim()) return generated;
  const g = splitSections(generated);
  const e = splitSections(existing);

  const OWNED_HEADER = [/^#\s/, /^State\s*:/i, /^Generated from\s/i];
  const ownedHeader = l => OWNED_HEADER.some(rx => rx.test(l));
  const keptPre = trimBlank(e.pre.filter(l => !ownedHeader(l)));
  const out = [...trimBlank(g.pre), ""];
  if (keptPre.length) out.push(...keptPre, "");

  const gByKey = new Map(g.sections.map(x => [x.key, x]));
  const used = new Set();
  const merged = [];
  for (const es of e.sections) {
    const own = OWNED[es.key];
    const gs = gByKey.get(es.key);
    if (!own || (!gs && !own.always)) { merged.push({ heading: es.heading, body: trimBlank(es.body) }); continue; }
    const kept = trimBlank(es.body.filter(l => !own.item.test(l.trimStart())));
    const body = gs ? trimBlank(gs.body) : [];
    if (gs) used.add(es.key);
    if (!body.length && !kept.length) continue;         // an owned section with nothing left
    merged.push({ heading: gs ? gs.heading : es.heading, body: [...body, ...(body.length && kept.length ? [""] : []), ...kept] });
  }
  // Generated sections the file did not have yet: Passes goes first, the rest at the end.
  for (const gs of g.sections) {
    if (used.has(gs.key)) continue;
    const sec = { heading: gs.heading, body: trimBlank(gs.body) };
    if (gs.key === "passes") merged.unshift(sec); else merged.push(sec);
  }
  for (const sec of merged) out.push(sec.heading, "", ...sec.body, "");
  return out.join("\n");
}

/**
 * Load the one authoritative plan (<slug>.plan.json), migrating a sealed Markdown plan if needed.
 *
 * NEVER rewrites the human plan `<slug>.md` (obs 0042d). With `readOnly: false`, a migration
 * writes the machine plan `<slug>.plan.json` beside it; a readable view is written only when
 * the caller names where (`viewPath`, normally `<run>/plan.md` — or use writePlanView).
 */
export function loadAuthoritativePlan(plansDir, slug, { readOnly = false, viewPath = null } = {}) {
  const jsonPath = path.join(plansDir, `${slug}.plan.json`);
  const mdPath = path.join(plansDir, `${slug}.md`);

  if (fs.existsSync(jsonPath)) {
    try {
      const plan = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      // obs 0053 — additive only: tag in memory so `passesConflict` sees it, never rewrite the
      // sealed JSON itself. A run can be in flight against this exact file; this must never be
      // the call that makes an already-sealed plan refuse to load.
      applyCaptureTreeTags(plan);
      normalizePlanFiles(plan);   // in memory only, same rule as the tag above
      if (!readOnly && viewPath) writeFileAtomic(viewPath, viewText(plan, mdPath));
      return { plan, isSealed: true, errors: [] };
    } catch (e) {
      return { plan: null, isSealed: false, errors: [`Failed to parse ${jsonPath}: ${e.message}`] };
    }
  }

  if (fs.existsSync(mdPath)) {
    const mdText = fs.readFileSync(mdPath, "utf8");
    if (!isSealed(mdText)) {
      return { plan: null, isSealed: false, errors: [`Plan is not sealed`] };
    }
    const migrated = migrateLegacyPlan(slug, mdText);
    applyCaptureTreeTags(migrated);
    if (!readOnly) {
      writeFileAtomic(jsonPath, JSON.stringify(migrated, null, 2) + "\n");
      if (viewPath) writeFileAtomic(viewPath, viewText(migrated, mdPath));
    }
    return { plan: migrated, isSealed: true, errors: [] };
  }

  return { plan: null, isSealed: false, errors: [`No sealed plan found for ${slug}`] };
}

/**
 * The seal gate on a DRAFT plan's text, before anything is started (obs 0102): every problem at
 * once, so the sealing worker can fix them in one go instead of meeting them one by one at
 * `start`. Does not require `State: sealed` — a draft is checked before it is sealed.
 *
 * Checks, in order: the Passes section and its rows (obs 0062 row shape), pass numbers and the
 * dependency graph, then validateSealedPlan (command-shaped Proven-by, check targets and
 * declared files under `root`, with the new-file rule).
 *
 * @returns {{ ok: boolean, errors: string[], tags: {n:number, matched:string}[] }}
 */
export function checkPlan(text, { root, config } = {}) {
  const errors = [];
  const { passes, errors: parseErrors, rowErrors } = parsePlan(text);
  errors.push(...parseErrors, ...(rowErrors || []));
  if (!passes.length) return { ok: false, errors, tags: [] };

  errors.push(...validateGraph(passes.map(p => ({ n: p.n, title: p.title, depends: p.depends || [] }))).errors);

  // Route the draft through the same migration `start` uses, so the gate judges exactly what a
  // run would be built from. row_errors were already reported above — strip them here so the
  // gate does not list them twice.
  const plan = migrateLegacyPlan("draft", text);
  if (plan.migration) delete plan.migration.row_errors;
  const { errors: gateErrors, tags } = validateSealedPlan(plan, { root, config });
  errors.push(...gateErrors);
  return { ok: errors.length === 0, errors, tags };
}


