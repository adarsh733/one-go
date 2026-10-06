// lib/atomic.mjs — durable writes, strict reads, and a lock two windows can both respect.
//
// WHY THIS FILE EXISTS
// The old engine used bare `fs.writeFileSync` for board.json and every state.json, and
// `readJSON(p, fallback)` for reads. Two consequences were reproduced on 2026-09-08 against
// the current split modules:
//
//   D2  a truncated board.json parsed as `null`, fell back to an EMPTY board, and the next
//       save wrote that empty board over the real one. Exit code 0. No message. Total loss.
//   D6  two `start`s in the same minute produced the same run id, and the second one wrote
//       a fresh state.json straight over the first run's recorded evidence.
//
// Both are the same root cause: a write that cannot fail, layered on a read that cannot
// complain. Everything here exists to make a damaged or contested file LOUD instead of quiet.
//
// Nothing in here is clever. A rename is atomic on one filesystem, `mkdir` either wins or
// loses, and a version counter catches the writer who read before you and wrote after you.
import fs from "node:fs";
import path from "node:path";

/** A file exists but could not be parsed. Never swallow this — it means real data is at risk. */
export class CorruptFileError extends Error {
  constructor(file, cause) {
    super(`${file} exists but is not valid JSON: ${cause}`);
    this.name = "CorruptFileError";
    this.file = file;
  }
}

/** Someone else wrote this file between our read and our write. */
export class ConflictError extends Error {
  constructor(file, expected, found) {
    super(`${file} changed underneath us (expected revision ${expected}, found ${found})`);
    this.name = "ConflictError";
    this.file = file;
    this.expected = expected;
    this.found = found;
  }
}

/**
 * Write via a temp file in the SAME directory, then rename over the target.
 * Same directory matters: rename is only atomic within one filesystem.
 * A crash mid-write leaves either the whole old file or the whole new one — never half.
 */
export function writeFileAtomic(file, text) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, "w");
    fs.writeFileSync(fd, text);
    try { fs.fsyncSync(fd); } catch { /* fsync is unsupported on some mounts — the rename still orders the write */ }
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

export function writeJSONAtomic(file, obj) {
  writeFileAtomic(file, JSON.stringify(obj, null, 2) + "\n");
}

/**
 * Read JSON and tell the truth about what happened.
 *   missing file  -> { present: false, value: null }
 *   valid file    -> { present: true,  value }
 *   damaged file  -> throws CorruptFileError, with the raw bytes preserved on disk untouched.
 *
 * The old `readJSON(p, fallback)` collapsed the last two into the second. That is exactly how
 * D2 destroyed a board: an unreadable file and an empty one became indistinguishable.
 */
export function readJSONStrict(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (e) {
    if (e && e.code === "ENOENT") return { present: false, value: null };
    throw e;
  }
  try {
    return { present: true, value: JSON.parse(raw.replace(/^﻿/, "")) };
  } catch (e) {
    throw new CorruptFileError(file, String(e.message || e).split("\n")[0]);
  }
}

/**
 * Optimistic concurrency for a JSON document.
 *
 * Every document this engine owns carries a `rev` integer. `saveWithRev` refuses to write when
 * the copy on disk has moved past the revision the caller read. The caller re-reads, re-applies
 * and retries — a lost update becomes a visible ConflictError instead of silently winning.
 */
export function saveWithRev(file, obj, expectedRev) {
  let onDisk = null;
  try {
    const r = readJSONStrict(file);
    onDisk = r.present ? r.value : null;
  } catch (e) {
    if (e instanceof CorruptFileError) throw e;   // never overwrite damage
    throw e;
  }
  const foundRev = onDisk && Number.isInteger(onDisk.rev) ? onDisk.rev : 0;
  const wantRev = Number.isInteger(expectedRev) ? expectedRev : foundRev;
  if (onDisk && foundRev !== wantRev) throw new ConflictError(file, wantRev, foundRev);
  const next = { ...obj, rev: foundRev + 1 };
  writeJSONAtomic(file, next);
  return next;
}

/**
 * A cross-process lock built on `mkdir`, which is atomic on every filesystem this runs on.
 * `withLock` always releases, including on a throw. A lock older than `staleMs` is broken —
 * the process that made it is gone, and blocking the board forever is worse than the race.
 */
export function withLock(lockDir, fn, { staleMs = 120000, waitMs = 5000 } = {}) {
  const deadline = Date.now() + waitMs;
  let held = false;
  while (!held) {
    try {
      fs.mkdirSync(lockDir, { recursive: false });
      held = true;
    } catch (e) {
      if (!e || e.code !== "EEXIST") throw e;
      let age = 0;
      try { age = Date.now() - fs.statSync(lockDir).mtimeMs; } catch { age = Infinity; }
      if (age > staleMs) {
        try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {}
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`could not take the lock at ${lockDir} within ${waitMs}ms — another /one-go command is writing`);
      }
      // Busy-wait briefly. These holds are milliseconds long; a sleep dependency is not worth it.
      const until = Date.now() + 25;
      while (Date.now() < until) { /* spin */ }
    }
  }
  try {
    fs.writeFileSync(path.join(lockDir, "owner"), `${process.pid} ${new Date().toISOString()}\n`);
  } catch { /* the lock is the directory; the owner note is a courtesy */ }
  try {
    return fn();
  } finally {
    try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Optimistic concurrency reconciliation for simultaneous results.
 * Reads the latest revision, applies mutator, and retries on ConflictError.
 */
export function reconcileJSON(file, mutator, { maxRetries = 50, retryDelayMs = 25 } = {}) {
  let attempt = 0;
  while (true) {
    attempt++;
    const { present, value } = readJSONStrict(file);
    const current = present && value ? value : {};
    const expectedRev = Number.isInteger(current.rev) ? current.rev : 0;
    const clone = JSON.parse(JSON.stringify(current));
    const modified = mutator(clone);
    try {
      return saveWithRev(file, modified, expectedRev);
    } catch (err) {
      if (err instanceof ConflictError && attempt < maxRetries) {
        const until = Date.now() + retryDelayMs;
        while (Date.now() < until) { /* spin */ }
        continue;
      }
      throw err;
    }
  }
}

