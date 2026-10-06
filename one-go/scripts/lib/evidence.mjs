// lib/evidence.mjs — "done" has to be shown, not asserted.
//
// WHY THIS FILE EXISTS
// Reproduced 2026-09-08 (D11): `pass alpha 1 done` with no --proven and no --commit, followed
// by `watchdog`, printed "Run completed cleanly" and wrote a FINAL REPORT marked COMPLETE. The
// only pass in the run had proven=null. Nothing anywhere had been checked. The report's own
// Proven column said "—" and the run still called itself complete.
//
// TASK-ENF-001 added the right gate for jobs that carry a task_id, and correctly left jobs
// without one behaving as before — jobs without a task_id historically took the unguarded path
// until linked. This file closes that for runs THIS engine creates,
// while leaving older run files exactly as they are: their statuses stay historical and
// self-reported, and no proof is invented for them retroactively.
//
// The bar here is deliberately low and completely unfakeable by accident: a pass that claims
// done must say, in words, what was checked. It does not have to be a passing test — "checked
// by hand on the phone" is evidence. Silence is not.

import { expandPathEntries } from "./pathspec.mjs";
import { wholeTreeCheckWord } from "./plan.mjs";
import { PROOF_ONLY_TAGS } from "./overlap.mjs";
import { isWritingStatus } from "./status.mjs";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** Runs created by this engine carry this marker; older ones do not and are never re-judged. */
export const RUN_SCHEMA = 3;

/** Schema 2 introduced "a done pass must say something". Schema 3 adds the record contract. */
export const EVIDENCE_SCHEMA = 2;
export const RECORD_SCHEMA = 3;

export function runIsGated(state) {
  return Boolean(state && state.schema >= EVIDENCE_SCHEMA);
}

/** Only runs this engine created under the record contract are judged by it. */
export function runNeedsRecords(state) {
  return Boolean(state && state.schema >= RECORD_SCHEMA);
}

/**
 * Is this pass's claim of "done" backed by anything?
 * Returns null when it is fine, or a sentence naming what is missing.
 */
export function evidenceGap(pass) {
  const proven = String(pass.proven == null ? "" : pass.proven).trim();
  if (!proven) {
    const wanted = String(pass.proven_by || "").trim();
    return wanted
      ? `pass ${pass.n} (${pass.title || "—"}) has no evidence recorded. Its plan says it is proven by: ${wanted}`
      : `pass ${pass.n} (${pass.title || "—"}) has no evidence recorded, and its plan named no check either`;
  }
  if (/^(—|-|n\/a|none|na|tbd|todo|\?+)$/i.test(proven)) {
    return `pass ${pass.n} (${pass.title || "—"}) records "${proven}" as its evidence, which says nothing`;
  }
  return null;
}

/**
 * Can this whole run be called COMPLETE?
 * Every pass must be finished AND carry evidence. One gap is enough to refuse.
 */
export function completionGaps(state, { isDone }) {
  const passes = Array.isArray(state.passes) ? state.passes : [];
  const gaps = [];
  for (const p of passes) {
    if (!isDone(p.status)) { gaps.push(`pass ${p.n} (${p.title || "—"}) is "${p.status || "never started"}", not finished`); continue; }
    const gap = evidenceGap(p);
    if (gap) gaps.push(gap);
  }
  return gaps;
}

// ---------------------------------------------------------------- input fingerprints
//
// Evidence is only worth anything against the files it was taken over. When an input changes
// after a pass proved itself, that proof is stale and its pass — and everything downstream of
// it — has to be looked at again. Unrelated verified work is left alone: only what actually
// depends on the changed file is invalidated.

/** Cheap, stable, and good enough to notice a real edit. Missing files are recorded as absent. */
export function fingerprint(root, rel) {
  const full = path.isAbsolute(rel) ? rel : path.join(root, rel);
  try {
    const st = fs.statSync(full);
    if (st.isDirectory()) return `dir:${st.mtimeMs.toFixed(0)}`;
    const buf = fs.readFileSync(full);
    return `sha:${crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16)}:${st.size}`;
  } catch {
    return "absent";
  }
}

export function fingerprintAll(root, files) {
  const out = {};
  // Braces expanded so `dir/{a,b}` is fingerprinted as the two files it names.
  for (const f of expandPathEntries(files || []).map(e => e.path)) {
    if (String(f).includes("*")) continue;      // a glob has no single fingerprint; skip honestly
    out[f] = fingerprint(root, f);
  }
  return out;
}

/**
 * Which passes' evidence no longer holds, because a file they were proved over has changed?
 * Returns [{ n, file, was, now }]. A pass with no recorded fingerprints is not reported here —
 * it is simply un-fingerprinted, which `completionGaps` already treats as unproven.
 */
export function staleEvidence(root, state) {
  const out = [];
  for (const p of state.passes || []) {
    const fp = p.input_fingerprints;
    if (!fp || typeof fp !== "object") continue;
    for (const [file, was] of Object.entries(fp)) {
      const now = fingerprint(root, file);
      if (now !== was) out.push({ n: p.n, title: p.title, file, was, now });
    }
  }
  return out;
}

/**
 * A changed input invalidates the pass that read it AND everything downstream of that pass.
 * Everything else keeps its evidence — that is the difference between a careful re-check and
 * throwing away a night's verified work.
 */
export function invalidatedBy(state, staleList) {
  const passes = state.passes || [];
  const hit = new Set(staleList.map(s => s.n));
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of passes) {
      if (hit.has(p.n)) continue;
      if ((p.depends || []).some(d => hit.has(d))) { hit.add(p.n); changed = true; }
    }
  }
  return [...hit].sort((a, b) => a - b);
}

// ================================================================ THE VERIFICATION RECORD
//
// WHY THIS EXISTS — the R1 defect, 2026-09-09.
// `pass alpha 1 done --proven "tests failed"` was accepted, and the run then announced
// "Run completed cleanly". The prose said the check had FAILED and OneGo completed anyway,
// because nothing here ever read a check — it read a sentence.
//
// The tempting repair is to scan that sentence for words like "failed". That is a fake fix:
// it closes the one phrasing the gate happens to use and leaves every other phrasing open
// ("0 of 3 green", "still broken", or simply lying). Worse, it makes OneGo's honesty depend
// on how a worker chooses to word things.
//
// THE CONTRACT INSTEAD — one sentence:
//
//     Words are a NOTE. Only a check OneGo ran ITSELF is PROOF.
//
// `--proven "<words>"` still exists and is still required to mark a pass done, because a
// pass that cannot say what it did is worse than one that can. But words alone can never
// end a run. To END a run, every pass must carry a VERIFICATION RECORD: a command OneGo
// executed, with the exit code it actually returned, bound to the exact run, pass and
// attempt it was taken for.
//
// A record cannot be written by hand into state.json and survive: `recordGap` re-checks the
// binding, and a record whose run_id / pass_n / attempt does not match the pass it is sitting
// on is rejected. It is not tamper-proof against someone editing the file with full knowledge
// of the format — nothing local can be — but it cannot be produced by ACCIDENT, by prose, or
// by a worker reporting its own homework, which is what R1 is about.
//
// WHAT ABOUT PROOF THAT IS NOT A COMMAND? A screen checked by eye on a phone has no exit
// code, and inventing one would be the same lie in a different costume. So such a run does
// not end itself as COMPLETE: it finishes every pass and closes as FINISHED WITH OPEN ITEMS
// (lib/report.mjs), naming what is missing. The person accepts it, or they don't. An
// automated check is not a device.

import { execSync } from "node:child_process";

/** Digest of what the command printed. Recorded so the record names a specific output. */
function digest(text) {
  return "sha256:" + crypto.createHash("sha256").update(String(text)).digest("hex").slice(0, 16);
}

/**
 * Run a check and return the record for it. NEVER throws on a failing command — a check that
 * fails is a real, recordable result; only the record's exit_code says whether it passed.
 *
 * @param {{ root: string, command: string, runId: string, passN: number, attempt: number, timeoutMs?: number }} a
 */
export function runCheck({ root, command, requiredCommand, runId, passN, attempt, files = [], timeoutMs = 40 * 60 * 1000, generatedOutputs = [] }) {
  const startedAt = new Date().toISOString();
  const checked_files = {};
  let mutatedDuringCheck = false;

  for (const f of files) {
    // D11 (0092): skip generated outputs — they are expected to change during verification.
    if (!f || String(f).includes("*")) continue;
    if (generatedOutputs.includes(f)) continue;
    checked_files[f] = { before: fingerprint(root, f) };
  }

  let exitCode = 0;
  let output = "";
  try {
    output = execSync(command, {
      cwd: root, encoding: "utf8", timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true
    });
  } catch (e) {
    output = `${(e && e.stdout) || ""}${(e && e.stderr) || ""}`;
    // A killed/timed-out child has a signal and no numeric status. Never let that read as 0.
    exitCode = typeof e?.status === "number" ? e.status : (e?.signal ? 124 : 1);
    if (!output.trim()) output = String((e && e.message) || "(no output)");
  }

  for (const f of files) {
    // D11 (0092): skip generated outputs — they are expected to change during verification.
    if (!f || String(f).includes("*")) continue;
    if (generatedOutputs.includes(f)) continue;
    const afterFp = fingerprint(root, f);
    checked_files[f] = checked_files[f] || {};
    checked_files[f].after = afterFp;
    if (checked_files[f].before !== afterFp) {
      mutatedDuringCheck = true;
    }
  }

  const text = String(output);
  return {
    command,
    required_command: requiredCommand || command,
    exit_code: exitCode,
    ran_at: startedAt,
    finished_at: new Date().toISOString(),
    run_id: runId,
    pass_n: passN,
    attempt,
    checked_files,
    mutated_during_check: mutatedDuringCheck,
    output_digest: digest(text),
    output_bytes: Buffer.byteLength(text, "utf8"),
    output_tail: text.slice(-800)
  };
}

/**
 * Is this pass carrying a record that genuinely belongs to it and genuinely passed?
 * Returns null when it is fine, or a sentence naming exactly what is wrong.
 */
export function recordGap(pass, { runId }) {
  const r = pass && pass.verification_record;
  const who = `pass ${pass.n} (${pass.title || "—"})`;
  if (!r || typeof r !== "object") {
    const note = String(pass.proven == null ? "" : pass.proven).trim();
    return note
      ? `${who} recorded a note ("${note}") but no check OneGo ran. A note is not proof`
      : `${who} has no verification record — no check was run for it`;
  }
  if (typeof r.exit_code !== "number") return `${who} has a verification record with no exit code`;
  if (!r.command) return `${who} has a verification record that names no command`;
  if (r.run_id !== runId) {
    return `${who} carries a verification record from a different run (${r.run_id || "—"}, this run is ${runId})`;
  }
  if (r.pass_n !== pass.n) {
    return `${who} carries a verification record taken for pass ${r.pass_n} — it does not belong to this pass`;
  }
  if (r.attempt !== pass.attempts) {
    return `${who} was re-run after its check (record is from attempt ${r.attempt}, the pass is on attempt ${pass.attempts}) — the check no longer covers the work`;
  }
  if (r.exit_code !== 0) {
    return `${who} ran \`${r.command}\` and it FAILED with exit code ${r.exit_code}`;
  }
  if (r.mutated_during_check) {
    return `${who} files changed during verification`;
  }
  return null;
}

/**
 * Everything standing between this run and an honest COMPLETE.
 * Layers on top of completionGaps: finished + has a note + carries a passing, bound record.
 */
export function verificationGaps(state, { isDone }) {
  const gaps = completionGaps(state, { isDone });
  if (!runNeedsRecords(state)) return gaps;
  const runId = state.runId || state.run_id || "";
  for (const p of state.passes || []) {
    if (!isDone(p.status)) continue;                 // already reported by completionGaps
    const gap = recordGap(p, { runId });
    if (gap) gaps.push(gap);
  }
  return gaps;
}

// ================================================================ WHOLE-TREE CHECK LOCK (obs 0070)
//
// Some checks are not about one pass's files at all: a capture run, a journey suite, a
// screenshot sweep drives the WHOLE app. Run beside another pass that is still writing, such a
// check proves a half-built tree — and can even break the other pass's work in progress. Those
// passes are tagged `capture-tree` at seal time (lib/plan.mjs applyCaptureTreeTags) or carry
// `whole-tree` in their shared resources. This answers one question for `pass --verify`: may
// this pass's check run right now?
//
// Only the CHECK waits — the building never does (lib/overlap.mjs PROOF_ONLY_TAGS). And it waits
// only for passes still WRITING: a pass marked `built` has stopped changing the tree, so two
// whole-app passes that both finished writing may each run their check — they never wait on
// each other. The word list is the ONE list in lib/plan.mjs (WHOLE_TREE_CHECK_WORDS), read from
// the check command only.

/** Is this pass's check a whole-tree check? Tag first; the check command's words are a fallback for untagged state. */
export function isWholeTreePass(pass) {
  if (!pass) return false;
  const tags = Array.isArray(pass.shared_resources) ? pass.shared_resources
    : Array.isArray(pass.shared) ? pass.shared : [];
  if (tags.some(t => PROOF_ONLY_TAGS.has(String(t).trim().toLowerCase()))) return true;
  return wholeTreeCheckWord((pass.required_check && pass.required_check.command) || pass.proven_by) !== null;
}

/**
 * null when pass `passN`'s check may run now; otherwise `{ reason, running }` naming the other
 * passes still live. Only a whole-tree pass is ever held back — an ordinary check reads its own
 * files and may run beside anything.
 */
export function wholeTreeConflict(state, passN) {
  const passes = Array.isArray(state && state.passes) ? state.passes : [];
  const me = passes.find(p => p.n === Number(passN));
  if (!me || !isWholeTreePass(me)) return null;
  const running = passes
    .filter(p => p.n !== me.n && isWritingStatus(p.status))
    .map(p => p.n)
    .sort((a, b) => a - b);
  if (!running.length) return null;
  return {
    reason: `pass ${me.n}'s check runs over the whole tree, and pass${running.length === 1 ? "" : "es"} ` +
      `${running.join(", ")} ${running.length === 1 ? "is" : "are"} still running (writing) — it would prove a half-built ` +
      `tree. Wait until ${running.length === 1 ? "it reports" : "they report"} (marked built or done), then run the check again.`,
    running
  };
}
