// lib/render.mjs — stages, icons, bars, rollup. Extracted verbatim from the original board.mjs
// (no behaviour change — see TASK-ENF-001 stage 2).
export const STAGES = ["not_started", "waiting", "running", "blocked", "eyes", "done"];
export const ICON = { not_started: "⬜", waiting: "⏳", running: "🟡", blocked: "⛔", eyes: "👁", done: "✅" };
export const WORD = { not_started: "not started", waiting: "waiting on you", running: "running", blocked: "blocked", eyes: "on your phone", done: "done" };
export const BAR_WIDTH = 10;
export const GREEN = "🟩", AMBER = "🟨", RED = "🟥", EMPTY = "⬜";
export const FILL = { done: GREEN, running: GREEN, not_started: GREEN, waiting: AMBER, eyes: AMBER, blocked: RED };

export function bar(done, total, stage) {
  if (!total) return "—";
  let filled = Math.round((done / total) * BAR_WIDTH);
  if (done > 0 && filled === 0) filled = 1;                          // any progress shows a segment
  if (done < total && filled === BAR_WIDTH) filled = BAR_WIDTH - 1;  // only truly full reads full
  const seg = FILL[stage] || GREEN;
  return seg.repeat(filled) + EMPTY.repeat(BAR_WIDTH - filled) + ` ${done}/${total}`;
}

// Rolled-up truth for one task: its own numbers when it has no subtasks, its children's when it does.
export function rollup(t) {
  const subs = Array.isArray(t.subtasks) ? t.subtasks : [];
  if (!subs.length) {
    return {
      stage: t.stage || "not_started",
      done: t.passes_done || 0,
      total: t.passes_total || 0,
      questions: t.pending_questions || 0,
      next: t.next_move || "—",
      subs: []
    };
  }
  const done = subs.filter(s => s.stage === "done").length;
  const has = st => subs.some(s => s.stage === st);
  let stage;
  if (done === subs.length) stage = "done";
  else if (has("running")) stage = "running";
  else if (has("blocked")) stage = "blocked";
  else if (has("waiting")) stage = "waiting";
  else if (has("eyes")) stage = "eyes";
  else if (done > 0) stage = "waiting";
  else stage = "not_started";
  if (t.stage_override) stage = t.stage_override;
  const questions = subs.reduce((a, s) => a + (s.questions || 0), 0) + (t.pending_questions || 0);
  // The next move is the most urgent unfinished child.
  let next = t.next_move || "—";
  for (const st of ["running", "blocked", "waiting", "eyes", "not_started"]) {
    const s = subs.find(x => x.stage === st);
    if (s) { next = s.title + (s.note ? " — " + s.note : ""); break; }
  }
  return { stage, done, total: subs.length, questions, next, subs };
}
