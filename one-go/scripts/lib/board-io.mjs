// lib/board-io.mjs — board.json load/save, task lookup.
//
// Load/save closes two reproduced defects:
//
//   D2  a truncated board.json parsed as null, `loadBoard` returned an EMPTY board, and the
//       very next save wrote that empty board over the top. Exit 0, no message, board gone.
//       `loadBoard` now distinguishes "no board yet" from "damaged board" and refuses the
//       second, leaving the bytes on disk untouched so they can be recovered.
//   D1  every read command called `saveBoard`, so simply LOOKING at the board rewrote it.
//       Saving is now the caller's decision (see `gatherSources({ persist })`), and the write
//       itself is atomic and takes a lock, so two windows cannot lose each other's update.
import path from "node:path";
import { BOARD_PATH, ONEGO } from "./paths.mjs";
import { stamp, slugify } from "./util.mjs";
import { rollup } from "./render.mjs";
import { readJSONStrict, writeJSONAtomic, saveWithRev, withLock, CorruptFileError } from "./atomic.mjs";

export { CorruptFileError };

const LOCK = path.join(ONEGO, ".board.lock");

export function saveBoard(b) {
  b.schema = 4;
  b.updated = stamp();
  delete b._fresh;
  // saveWithRev enforces the revision that was read: if another caller wrote between our
  // loadBoard and this saveBoard, foundRev !== expectedRev and ConflictError is thrown.
  // withLock serializes the same process's concurrent writes; saveWithRev catches
  // the interleaved-read-then-write race that withLock alone cannot stop.
  const expectedRev = Number.isInteger(b.rev) ? b.rev : 0;
  withLock(LOCK, () => saveWithRev(BOARD_PATH, b, expectedRev));
  return b;
}


/**
 * @throws {CorruptFileError} when board.json exists but cannot be parsed. Callers must let this
 *         reach the top level and print it — swallowing it is what destroyed a board once.
 */
export function loadBoard() {
  const { present, value } = readJSONStrict(BOARD_PATH);   // throws CorruptFileError on damage
  if (!present || !value) return { schema: 4, updated: "", tasks: {}, _fresh: true };
  value.tasks = value.tasks || {};
  return value;
}

// ---------------------------------------------------------------- task lookup
//
// THE LOOSE-MATCH BUG (obs 0104): the old findTask let a long request whose slug merely began
// with an existing key (`one-go-public-cleanup turn one-go into…` → `one-go`) land on that job —
// a job that was already finished. Two rules close it for every lookup:
//   1. a loose (prefix / contains) match never lands on a done or absorbed job;
//   2. the key-is-a-prefix-of-the-text branch is gone for long text (more than LONG_WORDS words).
// An exact name (slug, its slug form, or the display name) still finds any job, done or not, so
// `info <finished-job>` keeps working.

const LONG_WORDS = 3;

/** Done or absorbed: a finished job is never the target of new work. */
export function isClosedTask(t) {
  if (!t) return false;
  if (t.absorbed_by) return true;
  // compat D12: the board's roll-up is the truth. A job whose own `stage` says done while a part
  // is still open shows blocked on the board, and is open work: dispatch continues it.
  try { return rollup(t).stage === "done"; } catch { return t.stage === "done"; }
}

function exactKey(tasks, n) {
  if (tasks[n]) return n;
  const slugged = slugify(n, 9);
  if (slugged && tasks[slugged]) return slugged;
  const keys = Object.keys(tasks);
  const display = keys.filter(k => (tasks[k].display || "").toLowerCase().trim() === n);
  return display.length === 1 ? display[0] : null;
}

function looseKeys(tasks, n) {
  const slugged = slugify(n, 9);
  if (!slugged) return [];
  const words = slugify(n, 60).split("-").filter(Boolean).length;
  const long = words > LONG_WORDS;
  return Object.keys(tasks).filter(k => {
    if (isClosedTask(tasks[k])) return false;
    const display = (tasks[k].display || "").toLowerCase();
    return k.startsWith(slugged) ||
      (!long && slugged.startsWith(k)) ||
      k.includes(slugged) ||
      (n.length >= 3 && display.includes(n));
  });
}

// Find a task by slug, by display name, or loosely — so `info my meals` works.
export function findTask(tasks, needle) {
  if (!needle) return null;
  const n = String(needle).toLowerCase().trim();
  if (!n) return null;
  const exact = exactKey(tasks, n);
  if (exact) return exact;
  const loose = looseKeys(tasks, n);
  return loose[0] || null;
}

/**
 * Strict lookup for the places where guessing is dangerous — starting a run, finishing a job.
 * Returns { slug } on exactly one match, or { ambiguous: [...] } when the name could mean more
 * than one thing. `finish foo` picking the wrong job at 2am is not a recoverable mistake.
 */
export function resolveTaskStrict(tasks, needle) {
  if (!needle) return { error: "no task named" };
  const n = String(needle).toLowerCase().trim();
  const keys = Object.keys(tasks);
  if (tasks[n]) return { slug: n };
  const slugged = slugify(n, 9);
  if (slugged && tasks[slugged]) return { slug: slugged };
  const exactDisplay = keys.filter(k => (tasks[k].display || "").toLowerCase().trim() === n);
  if (exactDisplay.length === 1) return { slug: exactDisplay[0] };
  if (exactDisplay.length > 1) return { ambiguous: exactDisplay };

  const loose = looseKeys(tasks, n);
  if (loose.length === 1) return { slug: loose[0] };
  if (loose.length > 1) return { ambiguous: loose };
  return { error: `no task matches "${needle}"` };
}

/**
 * How well does free text name an existing, OPEN job? For `/one-go <anything>`.
 *   exact  — the text is the job's slug, slug form or display name
 *   strong — short text (≤ LONG_WORDS words) that picks out exactly one open job loosely
 *   weak   — an open job's whole slug (2+ words) appears inside longer text, or a short text
 *            that loosely fits several open jobs (the first is returned as the suggestion)
 *   none   — nothing
 * Never returns a done or absorbed job as a match. When the text names a closed job exactly,
 * `closed` carries that slug so the caller can say "that job is finished" in one line.
 * @returns {{ slug: string|null, strength: "exact"|"strong"|"weak"|"none", task: object|null, closed?: string }}
 */
export function resolveForDispatch(tasks, text) {
  const none = { slug: null, strength: "none", task: null };
  const n = String(text || "").toLowerCase().trim();
  if (!n || !tasks) return none;
  const hit = slug => ({ slug, task: tasks[slug] });

  const exact = exactKey(tasks, n);
  if (exact && !isClosedTask(tasks[exact])) return { ...hit(exact), strength: "exact" };
  const closed = exact && isClosedTask(tasks[exact]) ? { closed: exact } : {};

  const words = slugify(n, 60).split("-").filter(Boolean);
  const long = words.length > LONG_WORDS;
  if (!long) {
    const loose = looseKeys(tasks, n);
    if (loose.length === 1) return { ...hit(loose[0]), strength: "strong", ...closed };
    if (loose.length > 1) return { ...hit(loose[0]), strength: "weak", ...closed };
  }

  // Long text: an open job's full slug (two or more words) sitting inside it, on word edges.
  const full = `-${words.join("-")}-`;
  const inside = Object.keys(tasks)
    .filter(k => !isClosedTask(tasks[k]) && k.split("-").length >= 2 && full.includes(`-${k}-`))
    .sort((a, b) => b.length - a.length);
  if (inside.length) return { ...hit(inside[0]), strength: "weak", ...closed };
  return { ...none, ...closed };
}
