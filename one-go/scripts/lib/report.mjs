// lib/report.mjs — the one combined run report, and the chat summary the conductor hands over.
//
// Every run ends with exactly one of three endings (exact words — the board and other tools
// read them):
//   COMPLETE                  every pass finished and carries a check the engine ran itself;
//   FINISHED WITH OPEN ITEMS  the work is over, but something still needs a person: a parked
//                             question, a pass done with --no-check, proof that only a phone
//                             or a pair of eyes can give, an unproven pass, or an unanswered
//                             line in reviewer-flags.md;
//   STOPPED                   the run was halted before its work was over.
//
// Nothing here knows about any one project. Project lines (a device-proof reminder, a push
// queue, a compare-page command …) arrive from the caller as `extras` — normally the house
// config's `report_extras` — and are printed as given.
import fs from "node:fs";
import path from "node:path";
import { stamp } from "./util.mjs";
import { isDoneStatus, isBuiltStatus } from "./status.mjs";
import { recordGap, evidenceGap, runNeedsRecords, runIsGated } from "./evidence.mjs";
import { namedModel, NOT_NAMED } from "./route.mjs";

/**
 * The report's Model cell: the model the pass was meant to run on (host · model), then the model
 * it actually ran on — what the host or worker reported back — or "not reported". An old run with
 * no route shows what it recorded.
 */
export function modelCell(p) {
  const ran = p.worker?.actual_model || p.route?.confirmed || p.ran_model || null;
  if (!p.route) return ran || p.model || "—";
  const host = p.route.host || "claude";
  const meant = host === "inline" ? "inline (the chat's own model)" : `${host} · ${namedModel(p.route) || NOT_NAMED}`;
  return `meant: ${meant} · ran: ${ran || "not reported"}`;
}

export const ENDINGS = Object.freeze({
  COMPLETE: "COMPLETE",
  OPEN_ITEMS: "FINISHED WITH OPEN ITEMS",
  STOPPED: "STOPPED"
});

// Proof that no command can give: a real device, a person's eyes.
const PHONE_ONLY = /\b(phone|device|by eye|eyes|by hand|on (the )?screen)\b/i;

/**
 * The open lines in a reviewer-flags.md: top-level bullets and unticked checkboxes, skipping
 * ticked ones, struck-through ones, and anything under a heading that says it was answered,
 * resolved, closed, done or accepted. Returns the item texts (trimmed to 160 characters).
 */
export function reviewerFlagItems(text) {
  const out = [];
  let skipSection = false;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const h = raw.match(/^#{1,6}\s+(.*)$/);
    if (h) { skipSection = /\b(answered|resolved|closed|done|accepted)\b/i.test(h[1]); continue; }
    if (skipSection) continue;
    const b = raw.match(/^[-*]\s+(.*)$/);            // top-level bullets only; sub-bullets are detail
    if (!b) continue;
    let body = b[1].trim();
    if (/^\[[xX]\]/.test(body)) continue;             // ticked
    body = body.replace(/^\[\s\]\s*/, "");
    if (/^~~.*~~$/.test(body)) continue;               // struck through
    body = body.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
    if (!body) continue;
    out.push(body.length > 160 ? body.slice(0, 157) + "…" : body);
  }
  return out;
}

/**
 * Everything in this run that still needs a person, as a flat list.
 *   parked        a pass waiting on a question (or blocked);
 *   no_check      a finished pass recorded with --no-check "<why>";
 *   phone_only    a finished pass whose only proof is a device or a person's eyes;
 *   unproven      a pass that is not finished, or finished without a check the engine ran;
 *   reviewer_flag an open line in <runDir>/reviewer-flags.md.
 * Old runs (created before the proof rules) are never re-judged: only their unfinished and
 * parked passes count.
 */
export function openItems(state, runDir) {
  const items = [];
  const passes = Array.isArray(state && state.passes) ? state.passes : [];
  const needsRecords = runNeedsRecords(state);
  const gated = runIsGated(state);
  const runId = (state && (state.run_id || state.runId)) || "";

  for (const p of passes) {
    const s = String(p.status || "");
    const who = `pass ${p.n} (${p.title || p.what || "—"})`;
    if (!isDoneStatus(s)) {
      if (/^(parked|blocked)/.test(s) || p.parked_question) {
        items.push({ kind: "parked", pass: p.n, text: p.parked_question ? `${who}: ${p.parked_question}` : `${who} is ${s}` });
      } else {
        items.push({ kind: "unproven", pass: p.n, text: `${who} is "${s || "never started"}", not finished` });
      }
      continue;
    }

    const gap = needsRecords ? recordGap(p, { runId }) : (gated ? evidenceGap(p) : null);
    if (needsRecords && !gap) continue;             // a passing check the engine ran — proven
    const noCheck = p.no_check && p.no_check.reason ? String(p.no_check.reason) : "";
    if (p.phone_only || (noCheck && PHONE_ONLY.test(noCheck))) {
      items.push({ kind: "phone_only", pass: p.n, text: `${who}: ${noCheck || "proof needs a real device or a person's eyes"}` });
    } else if (noCheck) {
      items.push({ kind: "no_check", pass: p.n, text: `${who} was marked done without a check: ${noCheck}` });
    } else if (gap) {
      const note = String(p.proven || "");
      items.push(PHONE_ONLY.test(note)
        ? { kind: "phone_only", pass: p.n, text: `${who}: ${note}` }
        : { kind: "unproven", pass: p.n, text: gap });
    }
  }

  if (runDir) {
    let flags = null;
    try { flags = fs.readFileSync(path.join(runDir, "reviewer-flags.md"), "utf8"); } catch {}
    for (const t of reviewerFlagItems(flags)) items.push({ kind: "reviewer_flag", pass: null, text: t });
  }
  return items;
}

/** Which of the three endings this run gets. `stopped` wins; then any open item; else COMPLETE. */
export function endingFor(state, { stopped = false, items } = {}) {
  if (stopped) return ENDINGS.STOPPED;
  const list = Array.isArray(items) ? items : openItems(state);
  return list.length ? ENDINGS.OPEN_ITEMS : ENDINGS.COMPLETE;
}

/**
 * The house lines for this report. `extras` is a list of plain strings (printed as given) or
 * config `report_extras` entries `{ when, text }`, where `when` is one of
 * "always" | "screen_job" | "open_items" | "committed", and `text` may use {slug}, {run_id},
 * {run_dir}, {commits}. Unknown `when` values are dropped, never guessed at.
 */
export function pickExtras(extras, { slug = "", runId = "", runDir = "", commits = [], screenJob = false, hasOpenItems = false } = {}) {
  const out = [];
  for (const e of Array.isArray(extras) ? extras : []) {
    if (typeof e === "string") { if (e.trim()) out.push(e); continue; }
    if (!e || typeof e.text !== "string") continue;
    const when = e.when || "always";
    const on = when === "always"
      || (when === "screen_job" && screenJob)
      || (when === "open_items" && hasOpenItems)
      || (when === "committed" && commits.length > 0);
    if (!on) continue;
    out.push(e.text
      .replace(/\{slug\}/g, slug)
      .replace(/\{run_id\}/g, runId)
      .replace(/\{run_dir\}/g, runDir)
      .replace(/\{commits\}/g, commits.join(", ")));
  }
  return out;
}

const KIND_WORD = {
  parked: "parked", no_check: "no check", phone_only: "needs a device or eyes",
  unproven: "unproven", reviewer_flag: "reviewer flag"
};

/**
 * report.md for one run. The first seven arguments are unchanged from the older engine, so
 * existing callers keep working; the options object adds:
 *   ending     one of ENDINGS (when absent: a reason containing "complete" → COMPLETE, else STOPPED,
 *              exactly as before);
 *   items      the open items (default: openItems(state, runDir));
 *   runDir     where reviewer-flags.md lives;
 *   extras     house lines (see pickExtras); screenJob says whether "screen_job" lines apply.
 */
export function formatReport(state, runId, slug, display, reason, releasedClaimIds, verification,
  { extras = [], ending, items, runDir, screenJob = false } = {}) {
  const passes = Array.isArray(state.passes) ? state.passes : [];
  const isDone = p => isDoneStatus(p.status);
  const doneCount = passes.filter(isDone).length;
  const totalCount = passes.length;
  const pct = totalCount ? Math.round((doneCount / totalCount) * 100) : 0;
  const end = Object.values(ENDINGS).includes(ending)
    ? ending
    : (reason && /complete/i.test(reason) ? ENDINGS.COMPLETE : ENDINGS.STOPPED);
  const finished = end !== ENDINGS.STOPPED;
  const open = Array.isArray(items) ? items : openItems(state, runDir);
  const committed = passes.filter(p => p.commit);
  const lines = [];

  lines.push(`# one-go run ${runId} — FINAL REPORT (${end})\n`);
  lines.push(`**${reason || "Run finished"} at ${stamp()}. ${doneCount} of ${totalCount} passes finished (${pct}%).**\n`);

  lines.push("## Passes\n");
  lines.push("| # | What it did | Model | Status | Commit | Proven |");
  lines.push("|---|---|---|---|---|---|");
  for (const p of passes) {
    const s = p.status || "";
    const st = s === "done" ? "✅ done"
      : s === "done-uncommitted" ? "✅ done · not committed"
      : s === "launch-requested" ? "🚀 launch-requested"
      : s === "stop-requested" ? "⏹ stop-requested"
      : isBuiltStatus(s) ? "🔨 built · check pending"
      : s === "running" ? (finished ? "▶ running" : "⏹ stopped mid-pass")
      : /^failed/.test(s) ? "❌ failed"
      : /^crashed/.test(s) ? "💥 crashed"
      : /^parked/.test(s) ? "⏸ parked"
      : /^blocked/.test(s) ? "⛔ blocked"
      : /^stopped/.test(s) ? "⏹ stopped"
      : "⬜ never started";
    const model = modelCell(p);
    lines.push(`| ${p.n} | ${p.title || p.what || "—"} | ${model} | ${st} | ${p.commit || "—"} | ${p.proven || "—"} |`);
    if (p.worker?.id) {
      const usageStr = p.worker.usage ? JSON.stringify(p.worker.usage) : "unavailable";
      lines.push(`| | ↳ worker: \`${p.worker.id}\` · usage: ${usageStr} | | | | |`);
    }
    if (p.parked_question) {
      lines.push(`| | ↳ parked: ${String(p.parked_question).slice(0, 160)} | | | | |`);
    }
  }

  lines.push(`\nOutcome / status: **${reason || "Stopped"}** at ${stamp()}. Ending: **${end}**.\n`);

  if (verification) {
    lines.push("## Verification\n");
    lines.push(`${verification}\n`);
  }

  if (open.length) {
    lines.push(`## Open items (${open.length})\n`);
    for (const it of open) lines.push(`- [${KIND_WORD[it.kind] || it.kind}] ${it.text}`);
    lines.push("");
  }

  const parked = passes.filter(p => p.parked_question);
  if (parked.length) {
    lines.push("## Parked questions\n");
    parked.forEach((p, i) => {
      lines.push(`${i + 1}. **Pass ${p.n} (${p.title || "—"}):** ${p.parked_question}`);
    });
    lines.push("");
  }

  lines.push("## What is not proven\n");
  if (end === ENDINGS.COMPLETE) {
    lines.push("- Every pass carries a check the engine ran itself. Anything a command cannot see — a real device, a person's eyes — is not covered by those checks.\n");
  } else if (end === ENDINGS.OPEN_ITEMS) {
    lines.push(`- ${open.length} open item${open.length === 1 ? "" : "s"} above — each one needs an answer or an explicit accept.\n`);
  } else {
    lines.push("- Run halted before completion.");
    const unstarted = passes.filter(p => !isDone(p) && !/^stopped/.test(p.status || "") && !p.proven);
    if (unstarted.length) {
      lines.push(`- ${unstarted.length} pass${unstarted.length === 1 ? "" : "es"} never ran to completion.`);
    }
    lines.push("");
  }

  lines.push("## Commits\n");
  if (committed.length) {
    lines.push(`${committed.length} pass${committed.length === 1 ? "" : "es"} committed: ${committed.map(p => `\`${p.commit}\``).join(", ")}. Nothing was pushed.\n`);
  } else {
    lines.push("Nothing was committed.\n");
  }

  lines.push("## Claims\n");
  if (releasedClaimIds && releasedClaimIds.length) {
    lines.push(`Released: ${releasedClaimIds.map(c => `\`${c}\``).join(", ")}.\n`);
  } else {
    lines.push("No claims were held.\n");
  }

  const house = pickExtras(extras, {
    slug, runId, runDir: runDir || "", commits: committed.map(p => p.commit),
    screenJob, hasOpenItems: open.length > 0
  });
  if (house.length) {
    lines.push("## House notes\n");
    for (const h of house) lines.push(`- ${h}`);
    lines.push("");
  }

  lines.push("## Next move\n");
  if (end === ENDINGS.COMPLETE) {
    lines.push("Nothing left in this run.\n");
  } else if (end === ENDINGS.OPEN_ITEMS) {
    lines.push(`Answer or accept each open item above, then \`/one-go dispatch ${slug}\` to go on.\n`);
  } else {
    lines.push(`To pick it up again: \`/one-go dispatch ${slug}\`.\n`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// renderChatSummary — the dispatch-mode summary for the conductor to hand
// the person directly in chat. Plain language, no jargon, job named by what it
// IS (never a bare code). A "Frozen vs built" section appears only when the
// caller says the job is a screen job (opts.ui === true) — the core never
// guesses that from the slug's shape.
// ---------------------------------------------------------------------------

const STATUS_ICON = {
  done: "✅ done",
  "done-uncommitted": "✅ done · not committed",
  parked: "🟨 parked",
  failed: "🟥 failed",
  crashed: "🟥 failed",
  blocked: "🟨 parked",
};

function statusIcon(status) {
  const s = String(status || "");
  if (STATUS_ICON[s]) return STATUS_ICON[s];
  if (isDoneStatus(s)) return "✅ done";
  if (/^failed|^crashed/.test(s)) return "🟥 failed";
  if (/^parked|^blocked/.test(s)) return "🟨 parked";
  return "🟨 parked";
}

function whyPending(p) {
  if (p.parked_question) return String(p.parked_question);
  if (/^failed/.test(p.status || "")) return "it failed and needs another look";
  if (/^crashed/.test(p.status || "")) return "it crashed partway through";
  if (/^blocked/.test(p.status || "")) return "it is blocked on something else finishing first";
  if (isBuiltStatus(p.status)) return "it was built, but its check had not been run yet";
  if (p.status === "running") return "it was still running when this summary was made";
  return "it has not been started yet";
}

function renderHandoff(run, passes, doneCount, totalCount, pct) {
  const pending = passes.filter(p => !isDoneStatus(p.status));
  if (!pending.length) {
    return "Nothing to hand off — job complete.";
  }
  const model = run.next_model || run.model || "build";
  const effort = run.next_effort || "Medium";
  const why = run.next_why || "Finishing the remaining passes below.";
  const files = pending.flatMap(p => Array.isArray(p.files) ? p.files : []);
  const uniqueFiles = [...new Set(files)];

  const block = [];
  block.push("```");
  block.push("▶ NEXT CHAT — SETUP");
  block.push(`Tool:   Claude Code`);
  block.push(`Model:  ${model}`);
  block.push(`Effort: ${effort}`);
  block.push(`Why:    ${why}`);
  block.push(`Pass / Target: ${doneCount} of ${totalCount}, ${pct}% complete`);
  block.push("```");
  block.push("");
  block.push("What's left:");
  pending.forEach(p => {
    block.push(`- Pass ${p.n} (${p.title || p.task || "—"}): ${whyPending(p)}`);
  });
  block.push("");
  block.push(uniqueFiles.length ? `Files: ${uniqueFiles.map(f => `\`${f}\``).join(", ")}` : "Files: none recorded.");
  block.push("");
  block.push(`Do not: ${run.do_not || "touch files outside the list above without asking."}`);
  block.push("");
  block.push(`Unverified: ${run.unverified || "nothing beyond the passes marked parked/failed above."}`);
  return block.join("\n");
}

/** A house "before finished" section (text or lines) as unticked checklist lines. */
function checklistLines(checklist) {
  const raw = Array.isArray(checklist) ? checklist : String(checklist || "").split(/\r?\n/);
  const out = [];
  for (const l of raw) {
    const t = String(l || "").trim();
    if (!t) continue;
    if (/^[-*]\s+\[[ xX]\]/.test(t)) { out.push(t.replace(/^\*/, "-")); continue; }
    out.push(`- [ ] ${t.replace(/^[-*]\s+|^\d+[.)]\s+/, "")}`);
  }
  return out;
}

/**
 * The chat summary. Options (all optional):
 *   extras     house lines — strings, or config report_extras entries (see pickExtras);
 *   ending     one of ENDINGS — printed under "How it ended" (defaults to run.ending);
 *   items      open items (openItems result) listed under the ending;
 *   checklist  the house "Before a run is called finished" section — printed as unticked
 *              lines; each one is an open item the conductor answers or accepts;
 *   ui, comparePage, regions   the "Frozen vs built" section, only when ui === true.
 */
export function renderChatSummary(run, opts = {}) {
  const passes = Array.isArray(run.passes) ? run.passes : [];
  const totalCount = run.planned_count || passes.length;
  const doneCount = passes.filter(p => isDoneStatus(p.status)).length;
  const pct = totalCount ? Math.round((doneCount / totalCount) * 100) : 0;
  const ui = opts.ui === true;
  const ending = opts.ending || run.ending || null;
  const items = Array.isArray(opts.items) ? opts.items : [];

  const lines = [];

  lines.push("## You asked\n");
  lines.push(`${run.display || run.title || run.job || run.slug || "This job"}${run.why ? ` — ${run.why}` : ""}`);
  if (run.notes) lines.push(run.notes);
  lines.push("");

  lines.push("## What got done\n");
  lines.push(`**${doneCount} of ${totalCount} passes done — ${pct}%.**\n`);
  lines.push("| Pass | What it built | Status | Proven by |");
  lines.push("|---|---|---|---|");
  for (const p of passes) {
    lines.push(`| ${p.n} | ${p.title || p.task || "—"} | ${statusIcon(p.status)} | ${p.proven || "—"} |`);
  }
  lines.push("");

  if (ending || items.length) {
    lines.push("## How it ended\n");
    if (ending) lines.push(`**${ending}**${items.length ? ` — ${items.length} thing${items.length === 1 ? "" : "s"} need${items.length === 1 ? "s" : ""} you` : ""}\n`);
    for (const it of items) lines.push(`- [${KIND_WORD[it.kind] || it.kind}] ${it.text}`);
    if (items.length) lines.push("");
  }

  if (ui) {
    lines.push("## Frozen vs built\n");
    if (opts.comparePage) lines.push(`Compare page: ${opts.comparePage}\n`);
    if (Array.isArray(opts.regions) && opts.regions.length) {
      lines.push("| Region | Frozen | Built | Verdict |");
      lines.push("|---|---|---|---|");
      opts.regions.forEach(r => {
        lines.push(`| ${r.region || "—"} | ${r.frozen || "—"} | ${r.built || "—"} | ${r.verdict || "—"} |`);
      });
    } else {
      lines.push("_Fill this table region by region — frozen vs built, with a verdict._");
    }
    lines.push("");
  }

  lines.push("## Still pending — and why\n");
  const pending = passes.filter(p => !isDoneStatus(p.status));
  if (!pending.length) {
    lines.push("Nothing — everything planned got done.");
  } else {
    pending.forEach(p => {
      lines.push(`- Pass ${p.n} (${p.title || p.task || "—"}) is not done: ${whyPending(p)}.`);
    });
  }
  lines.push("");

  lines.push("## Decisions I need\n");
  const decisions = passes.filter(p => p.parked_question);
  if (!decisions.length && !(Array.isArray(run.assumptions) && run.assumptions.length)) {
    lines.push("None.");
  } else {
    let i = 1;
    decisions.forEach(p => {
      lines.push(`${i}. ${p.parked_question}`);
      if (p.options) {
        (Array.isArray(p.options) ? p.options : [p.options]).forEach(o => lines.push(`   - ${o}`));
      }
      if (p.recommendation) lines.push(`   - ★ ${p.recommendation}`);
      lines.push("");
      i++;
    });
    if (Array.isArray(run.assumptions)) {
      run.assumptions.forEach(a => {
        lines.push(`${i}. ${a.question || a}`);
        if (a.recommendation) lines.push(`   - ★ ${a.recommendation}`);
        lines.push("");
        i++;
      });
    }
  }

  const checks = checklistLines(opts.checklist);
  if (checks.length) {
    lines.push("## Before calling it finished\n");
    for (const c of checks) lines.push(c);
    lines.push("");
  }

  const house = pickExtras(opts.extras, {
    slug: run.slug || "", runId: run.run_id || run.runId || "", runDir: run.run_dir || "",
    commits: passes.filter(p => p.commit).map(p => p.commit),
    screenJob: ui, hasOpenItems: items.length > 0
  });
  if (house.length) {
    lines.push("## Notes\n");
    for (const h of house) lines.push(`- ${h}`);
    lines.push("");
  }

  lines.push("## Handoff (paste-ready)\n");
  lines.push(renderHandoff(run, passes, doneCount, totalCount, pct));
  lines.push("");

  return lines.join("\n");
}
