// cmd/info.mjs — the deep dive on one job. Ported from the live skill's board.mjs INFO
// section. Public command (Q6=B). Strict on the caller: board.mjs's `fit: "job"` already refuses
// text that names no job before this file is even loaded (dev/CONTRACT.md §4) — the `findTask`
// miss below is the belt-and-braces case (a direct call, or a needle that is literally empty).
import { findTask } from "../lib/board-io.mjs";
import { positionals } from "../lib/util.mjs";
import { ICON, WORD, bar, rollup, EMPTY } from "../lib/render.mjs";

export function runInfo({ ARGV, tasks, runsBySlug, claimRows, pendingQuestions, staleRefs }) {
  const needle = positionals(ARGV.slice(1)).join(" ");
  const slug = findTask(tasks, needle);
  if (!slug) {
    console.log(`No task matches "${needle}".\n`);
    console.log("On the board right now:\n");
    for (const [s, t] of Object.entries(tasks)) console.log(`- \`${s}\` — ${t.display || s}`);
    process.exit(1);
  }
  const t = tasks[slug];
  const r = rollup(t);
  const runs = (runsBySlug.get(slug) || []).slice().sort((a, b) => String(b.started).localeCompare(String(a.started))).slice(0, 3);
  const pct = r.total ? Math.round((r.done / r.total) * 100) : 0;

  console.log(`# ${t.display || slug}\n`);
  console.log(`\`${slug}\` · ${ICON[r.stage]} **${WORD[r.stage]}** · ${bar(r.done, r.total, r.stage)}` + (r.total ? ` · ${pct}%` : ""));
  if (t.what) console.log(`\n${t.what}`);
  console.log("");
  console.log("| | |");
  console.log("|---|---|");
  console.log(`| **Next move** | ${r.next} |`);
  if (t.blocked_reason) console.log(`| **Blocked by** | ${t.blocked_reason} |`);
  console.log(`| **Pending on you** | ${r.questions ? `${r.questions} question${r.questions === 1 ? "" : "s"}` : "nothing"} |`);
  console.log(`| **Where it came from** | ${t.source || "manual"}` + (t.run_id ? ` · last run \`${t.run_id}\`` : "") + " |");
  if (t.files) console.log(`| **Files it owns** | ${t.files} |`);
  const firstWord = String(t.display || slug).toLowerCase().split(" ")[0];
  const held = claimRows.filter(c => String(c.task || "").toLowerCase().includes(firstWord));
  if (held.length) console.log(`| **Held by a chat now** | ${held.map(c => c.claim).join(", ")} |`);

  if (r.subs.length) {
    console.log("\n## The parts\n");
    console.log("| # | Part | Stage | Pending | Where it stands |");
    console.log("|---|---|---|---|---|");
    r.subs.forEach((s, i) => {
      console.log(`| ${i + 1} | ${s.title} | ${ICON[s.stage] || EMPTY} ${WORD[s.stage] || s.stage} | ${s.questions || 0} | ${s.note || "—"} |`);
    });
    // The strip: the whole task at a glance, left to right. Titles are clipped so it
    // stays one readable line — the table above already carries the full wording.
    const clip = s => (s.length > 20 ? s.slice(0, 19) + "…" : s);
    console.log("\n```");
    console.log(r.subs.map(s => `${ICON[s.stage] || EMPTY} ${clip(s.title)}`).join(" → "));
    console.log("```");
  } else {
    console.log(`\n## The parts\n\n_No subtasks recorded yet._ The sealing round writes them.`);
  }

  if (runs.length) {
    console.log("\n## The last runs\n");
    console.log("| Run | When | Passes | How it ended |");
    console.log("|---|---|---|---|");
    for (const run of runs) {
      const crashed = run.passes.find(p => /^crashed/.test(p.status || ""));
      const failed = run.passes.filter(p => /^failed/.test(p.status || "")).length;
      const parked = run.passes.filter(p => /^parked/.test(p.status || "")).length;
      const how = run.stage === "done" ? "finished clean"
        : crashed ? `crashed at pass ${crashed.n}`
        : parked ? `${parked} parked on a question`
        : failed ? `${failed} failed`
        : run.stage === "running" ? "still running" : "stopped part-way";
      console.log(`| \`${run.runId}\` | ${String(run.started || "—").slice(0, 16)} | ${run.done}/${run.total} | ${how} |`);
    }
    const last = runs[0];
    console.log(`\n### Pass by pass — \`${last.runId}\`\n`);
    console.log("| # | Pass | Status | Model | Committed | Proven |");
    console.log("|---|---|---|---|---|---|");
    for (const p of last.passes) {
      const s = p.status || "";
      const st = s === "done" ? "✅ done"
        : s === "done-uncommitted" ? "✅ done · not committed"
        : /^failed/.test(s) ? "❌ failed"
        : /^crashed/.test(s) ? "💥 crashed"
        : /^parked/.test(s) ? "⏸ parked"
        : /^blocked/.test(s) ? "⛔ blocked"
        : /^stopped/.test(s) ? "⏹ stopped"
        : /^running/.test(s) ? "🟡 running" : "⬜ pending";
      console.log(`| ${p.n} | ${p.title || "—"} | ${st} | ${p.model || "—"} | ${p.commit ? "yes" : "no"} | ${p.proven ? "yes" : "no"} |`);
      if (p.parked) console.log(`| | ↳ parked on: ${String(p.parked).slice(0, 160)} | | | | |`);
    }
  } else {
    console.log("\n## The last runs\n\n_Never run through `/one-go dispatch <job>`._");
  }

  const qs = pendingQuestions.filter(q => q.slug === slug);
  const stales = staleRefs.filter(s => s.slug === slug);
  if (qs.length || stales.length) {
    console.log("\n## Pending on you\n");
    let i = 0;
    for (const q of qs) console.log(`${++i}. ${q.text}\n   ★ resume that parked pass`);
    for (const s of stales) console.log(`${++i}. This task still quotes ${s.id}, but that loop is ${s.why}\n   ★ correct its next move`);
  }

  console.log(`\n---\n**To start it, or carry it on:** \`/one-go dispatch ${slug}\`.`);
  console.log("If it has no sealed plan yet, I read every file it touches first, then ask you everything in one go — and nothing after that.");
  process.exit(0);
}
