// cmd/dispatch.mjs — `/one-go dispatch <text>`: start a job, or carry on the job the words name.
// `finish` is a silent alias: the router sends it here, same function, same arguments.
//
//   dispatch "<text>"          open job named, with a cut-off run → carry that run on (below)
//                              open job named  → preview its sealed plan + lanes (or its draft)
//                              anything else   → a NEW job, said in one line, captured on the board
//   dispatch "<text>" --seal   writes the self-contained pass-0 reading brief, prints only its path
//
// A CUT-OFF RUN IS PICKED UP ON ITS OWN. Before anything else, for the job the words resolve to:
// if it has a run with no `ended` (usage limit, closed window), dispatch checks the real files the
// same way `resume` does (cmd/revive.mjs), says in one line that it is carrying on, and hands the
// conductor that run's next step (cmd/next.mjs). No new run, no second word to remember.
//
// NEVER A DUPLICATE OF AN OPEN JOB. A long request whose first words spell an open job — its slug
// with dashes read as spaces, or its board title — continues that job; it never makes a new job
// `<slug>-finish` or similar.
//
// THE FINISHED-JOB RULE (obs 0104): new work never lands on a done or absorbed job. The lookup is
// lib/board-io.mjs `resolveForDispatch` (exact / strong / weak / none, never a closed job):
//   exact, strong → that job;   weak → a new job, and the loose hit is named in one line;
//   the text names a finished job exactly → a new job, and it says the old one is finished.
// One more exact case lives here: text that is word for word a job's captured `what` (the
// conductor re-running dispatch on the same words) is that job, never a second copy.
//
// ANSWERS ARE NOT JOBS: "use your recommendations", "approved", "go ahead", a bare "yes", or an
// answer code like "1A 2B" is refused in one line — the old engine turned such replies into junk
// rows on the board.
//
// Never dispatches a worker and never writes run state — intake and preview only.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ONEGO, ROOT } from "../lib/paths.mjs";
import { loadBoard, saveBoard, resolveForDispatch, isClosedTask } from "../lib/board-io.mjs";
import { slugify, today, positionals } from "../lib/util.mjs";
import { loadAuthoritativePlan, isSealed } from "../lib/plan.mjs";
import { cleanPathEntry } from "../lib/pathspec.mjs";
import { pathsOverlap } from "../lib/overlap.mjs";
import { routeFor, agentToolModel, chooseHost, planHost } from "../lib/route.mjs";
import { loadConfig } from "../lib/config.mjs";
import { loadHouseRules } from "../lib/house.mjs";
import { isDoneStatus, isStuckStatus, isRunningStatus } from "../lib/status.mjs";
import { selectParallelBatch, claimConflicts } from "../lib/overlap.mjs";
import { buildSealBrief } from "./dispatch-seal.mjs";
import { waveShape } from "./lanes.mjs";
import { screenGateCheck } from "./start.mjs";
import { ownClaimMarks, foreignClaims, claimWayOut } from "../lib/claims.mjs";

const BOARD_MJS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "board.mjs");
/** How a worker (or the conductor) runs this engine, spelled out so a brief needs nothing else. */
export const BOARD_CMD = `node "${BOARD_MJS.split(path.sep).join("/")}"`;

// ---------------------------------------------------------------------------- answer-shaped text

const ANSWER_WORDS = new Set([
  "yes", "y", "no", "n", "ok", "okay", "k", "sure", "yep", "yeah", "yup", "nope", "nah",
  "approved", "approve", "go", "ahead", "proceed", "lgtm", "agreed", "agree", "confirmed",
  "confirm", "fine", "correct", "right", "please", "thanks", "thank", "you", "all", "good",
  "sounds", "great", "do", "it", "that", "both", "none", "same", "as", "above", "recommended",
  "default", "defaults", "perfect", "cool", "alright"
]);

/** done / abort / stop / cancel, alone or with a filler word ("stop it", "abort now"). */
const ENDING_WORDS = /^(please\s+)?(done|abort|stop|cancel)(\s+(it|now|please|this|that|the|run|job))*$/;

/**
 * Does this read like a reply to a question block rather than a job? Deliberately narrow: a
 * short "fix the login" is a job; "approved", "go ahead with stage 2", "use your
 * recommendations", "yes", "1A 2B 3A" are answers.
 */
export function isAnswerShaped(text) {
  const s = String(text == null ? "" : text).toLowerCase()
    .replace(/[’']/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  if (!s) return false;
  // fix D7: the ending words (the hook's "off" words) are never a job — "stop the flicker" still is.
  if (ENDING_WORDS.test(s)) return true;
  if (/^(please\s+)?(use|take|go\s+with|accept|apply|follow)\s+(all\s+)?((your|the|my|all)\s+)?(own\s+)?(recommend|recs?\b|stars?\b|defaults?\b)/.test(s)) return true;
  if (/^(all\s+)?(your\s+)?recommend\w*(\s+please)?$/.test(s)) return true;
  if (/^approved\b/.test(s)) return true;
  if (/^approve\s+(all|everything|it|them|that|this|the\s+plan|as\s+is)\b/.test(s)) return true;
  if (/^go\s*ahead\b/.test(s)) return true;
  if (/^(q?\d+\s*[a-e]\s*)+$/.test(s)) return true;
  const words = s.split(" ");
  if (words.length <= 4 && words.every(w => ANSWER_WORDS.has(w))) return true;
  if (words.length <= 5 && /^(yes|no|yep|nope|ok|okay|sure)\b/.test(s)) return true;
  return false;
}

// ---------------------------------------------------------------------------- lookup

/**
 * The open job whose name the text's FIRST words spell — its slug (dashes read as spaces) or its
 * board title — or null. Names of two or more words only (a one-word name would swallow ordinary
 * requests that merely start with that word); the longest name wins, and a tie between two
 * different jobs is no answer at all.
 */
export function openJobByFirstWords(tasks, text) {
  const words = slugify(String(text || ""), 60).split("-").filter(Boolean);
  let best = null, bestLen = 0, tie = false;
  for (const [slug, t] of Object.entries(tasks || {})) {
    if (!t || isClosedTask(t)) continue;
    for (const name of [slug, t.display || ""]) {
      const nw = slugify(String(name), 60).split("-").filter(Boolean);
      if (nw.length < 2 || nw.length > words.length) continue;
      if (!nw.every((w, i) => words[i] === w)) continue;
      if (nw.length > bestLen) { best = slug; bestLen = nw.length; tie = false; }
      else if (nw.length === bestLen && best !== slug) tie = true;
    }
  }
  return best && !tie ? best : null;
}

/**
 * resolveForDispatch, plus: text that is exactly an open job's captured `what` is that job, and
 * text whose first words spell an open job is that job (never a `<slug>-finish` duplicate).
 */
export function lookupForDispatch(tasks, text) {
  const n = String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
  for (const [slug, t] of Object.entries(tasks || {})) {
    if (!t || isClosedTask(t)) continue;
    const what = String(t.what || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (what && what === n) return { slug, strength: "exact", task: t };
  }
  const hit = resolveForDispatch(tasks || {}, text);
  if (hit.closed || (hit.slug && (hit.strength === "exact" || hit.strength === "strong"))) return hit;
  const first = openJobByFirstWords(tasks, text);
  if (first) return { slug: first, strength: "strong", task: tasks[first], firstWords: true };
  return hit;
}

const FILLER_TAIL = new Set(["a", "an", "the", "to", "of", "for", "and", "or", "with", "in", "on", "at", "from", "by", "into", "so", "that"]);

/** A slug for a new job that never collides with an existing job or plan file. */
export function freshSlug(tasks, text, plansDir) {
  const title = text.length > 60 ? text.slice(0, 60).trim() : text;
  // A name cut at five words must not end on a joining word ("add-a-greeting-function-to").
  const parts = slugify(title).split("-").filter(Boolean);
  while (parts.length > 2 && FILLER_TAIL.has(parts[parts.length - 1])) parts.pop();
  const base = parts.join("-") || "captured-idea";
  // A draft plan with no job behind it (an older engine sealed without capturing) is reused, not
  // dodged — that is where the reading already got to. A job, or a sealed plan, is never reused.
  const taken = s => {
    if ((tasks || {})[s]) return true;
    if (fs.existsSync(path.join(plansDir, `${s}.plan.json`))) return true;
    let md = null;
    try { md = fs.readFileSync(path.join(plansDir, `${s}.md`), "utf8"); } catch { /* none */ }
    return md != null && isSealed(md);
  };
  if (!taken(base)) return base;
  for (let i = 2; i < 100; i++) if (!taken(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now()}`;
}

/** The one line that says why this is a new job, or null when it is simply new. */
function newJobReason(hit) {
  if (hit.closed) return `\`${hit.closed}\` is already finished, so this is a new job (finished jobs are listed by /one-go --all).`;
  if (hit.strength === "weak" && hit.slug) return `Only a loose match for \`${hit.slug}\`, so this is a new job (to continue that one: /one-go dispatch ${hit.slug}).`;
  return null;
}

// Writes to a FRESH read of board.json, never the in-memory board the router merged run and
// plan sources into — saving that view would quietly persist everything it merged (D1).
function captureJob(_mergedBoard, slug, text) {
  const board = loadBoard();
  const title = text.length > 60 ? text.slice(0, 60).trim() : text;
  board.tasks[slug] = {
    display: title.charAt(0).toUpperCase() + title.slice(1),
    what: text,                 // the FULL free text, not just the truncated title
    stage: "not_started",
    source: "dispatch",
    captured: today(),
    pending_questions: 0,
    next_move: "captured via dispatch — not planned yet",
    blocked_reason: null,
    subtasks: []
  };
  saveBoard(board);
}

// ---------------------------------------------------------------------------- lanes for the preview

async function lanesFor(passes, claimRows) {
  const lanesFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "lanes.mjs");
  if (fs.existsSync(lanesFile)) {
    const mod = await import(new URL("./lanes.mjs", import.meta.url).href);
    if (typeof mod.computeLanes === "function") return mod.computeLanes({ passes, claimRows: claimRows || [], running: [] });
  }
  // Fallback while cmd/lanes.mjs is absent: the first lane only — passes with nothing to wait for
  // that do not clash with each other. `lanes <job>` gives the full picture once it exists.
  const ready = passes.filter(p => !isDoneStatus(p.status) && !isStuckStatus(p.status) && !isRunningStatus(p.status) && !(p.depends || []).length);
  const { chosen } = selectParallelBatch(ready, ready.length, []);
  const inLane = new Set(chosen.map(p => p.n));
  return { lanes: chosen.length ? [chosen] : [], blocked: passes.filter(p => !inLane.has(p.n)).map(p => ({ pass: p, reason: (p.depends || []).length ? `waits on p${p.depends[0]}` : "clashes with another lane-1 pass" })) };
}

/** The Agent tool's `model` for a route — worked out from its tier (lib/route.mjs). */
export function agentModel(route, config) {
  return agentToolModel(route, { config });
}

// ---------------------------------------------------------------------------- a cut-off run

/** The newest run of `slug` that never ended (no `ended`, not finished), or null. */
export async function cutOffRunFor(slug) {
  const { scanRuns } = await import("./revive.mjs");
  return scanRuns().find(r => r.state && r.state.slug === slug && !r.state.ended && !r.finished) || null;
}

/** How recent a change to a declared file must be to suggest another tool is live (obs 0057). */
export const RECENT_CHANGE_MS = 30 * 60 * 1000;

/** Newest modified time among files under `dir` matching `decl` (capped walk), or null. */
function newestUnder(dir, decl, root, cap = 2000) {
  let best = null, seen = 0;
  const walk = d => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (++seen > cap) return;
      if (e.name === "node_modules" || e.name === ".git") continue;
      const abs = path.join(d, e.name);
      if (e.isDirectory()) { walk(abs); continue; }
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (!pathsOverlap(rel, decl)) continue;
      try {
        const m = fs.statSync(abs);
        if (!best || m.mtimeMs > best.mtimeMs) best = { file: rel, mtimeMs: m.mtimeMs };
      } catch { /* gone */ }
    }
  };
  walk(dir);
  return best;
}

/**
 * obs 0057: the declared file of a not-yet-done pass that changed within the last 30 minutes —
 * a sign another tool may be live on it. `{ file, mtimeMs }`, or null. Files come from the run's
 * own record, else the sealed plan; an old run that recorded none is "not recorded", never a refusal.
 */
export function recentDeclaredChange(run, slug, { root = ROOT, now = Date.now(), windowMs = RECENT_CHANGE_MS } = {}) {
  let passes = (run.state && Array.isArray(run.state.passes)) ? run.state.passes : [];
  const todo = passes.filter(p => !isDoneStatus(p.status));
  let decls = todo.flatMap(p => [...(p.files || []), ...(p.writes || [])]);
  if (!decls.length) {
    try {
      const { plan } = loadAuthoritativePlan(path.join(ONEGO, "plans"), slug, { readOnly: true });
      const open = new Set(todo.map(p => p.n));
      decls = ((plan && plan.passes) || []).filter(p => !open.size || open.has(p.n)).flatMap(p => p.writes || p.files || []);
    } catch { decls = []; }
  }
  let best = null;
  for (const raw of decls) {
    const f = cleanPathEntry(raw).path;
    if (!f) continue;
    let hit = null;
    if (/[*{?]/.test(f)) {
      const segs = f.replace(/\\/g, "/").split("/");
      const cut = segs.findIndex(s => /[*{?]/.test(s));
      hit = newestUnder(path.resolve(root, segs.slice(0, cut).join("/") || "."), f, root);
    } else {
      try { hit = { file: f.replace(/\\/g, "/"), mtimeMs: fs.statSync(path.resolve(root, f)).mtimeMs }; } catch { hit = null; }
    }
    if (hit && now - hit.mtimeMs <= windowMs && (!best || hit.mtimeMs > best.mtimeMs)) best = hit;
  }
  return best;
}

/** Carry a cut-off run on: one line, the same disk check `resume` does, then its next step. */
async function carryOn(run, slug, { force = false } = {}) {
  const { reconcileRun } = await import("./revive.mjs");
  const { nextStep } = await import("./next.mjs");
  if (!force) {
    const recent = recentDeclaredChange(run, slug);
    if (recent) {
      const t = new Date(recent.mtimeMs);
      const hhmm = `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
      console.log(`Not carrying on the cut-off run \`${run.runId}\` of \`${slug}\`: another tool may be live — \`${recent.file}\` was written at ${hhmm}, ${Math.max(0, Math.round((Date.now() - recent.mtimeMs) / 60000))} min ago.`);
      console.log("Wait until it has been quiet for 30 minutes, or say so and re-run with `--force` to carry on anyway. Nothing was written.");
      process.exit(1);
    }
  }
  console.log(`Carrying on the cut-off run \`${run.runId}\` of \`${slug}\` — ${run.done}/${run.total} passes done; no new run.`);
  reconcileRun(run);
  const { lines } = nextStep({ slug, state: run.state, runDir: run.dir });
  console.log("NEXT, FOR THE CONDUCTOR (the person types nothing here):");
  console.log(lines.join("\n"));
  console.log(`Then ask \`board.mjs next ${slug}\` for each step after that.`);
  process.exit(0);
}

// ---------------------------------------------------------------------------- the command

export async function runDispatch(ctx = {}) {
  const ARGV = ctx.ARGV || [];
  const config = ctx.config || loadConfig(ROOT);
  const house = ctx.house || loadHouseRules(ROOT);
  const board = ctx.board || loadBoard();
  const tasks = ctx.tasks || board.tasks || {};
  const plansDir = path.join(ONEGO, "plans");

  const text = positionals(ARGV.slice(1).filter(a => a !== "--seal" && a !== "--force")).join(" ").trim();
  if (!text) {
    console.log('Give dispatch something to work with: /one-go dispatch "<what you want, in plain words>"');
    process.exit(1);
  }
  if (ENDING_WORDS.test(String(text).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim())) {
    console.log(`"${text}" is an ending word, not a job — to stop a run: /one-go stop [<job>]. Nothing was written.`);
    process.exit(1);
  }
  if (isAnswerShaped(text)) {
    console.log(`"${text.length > 40 ? text.slice(0, 40) + "…" : text}" reads like an answer, not a job — give it to the question block that asked; to start a job, describe the work in plain words.`);
    process.exit(1);
  }

  const hit = lookupForDispatch(tasks, text);
  // Text that names a finished job exactly is never steered onto a different, loosely similar job.
  const isOpenHit = Boolean(hit.slug) && !hit.closed && (hit.strength === "exact" || hit.strength === "strong");

  // ---------------------------------------------------------------- --seal: pass-0 reading brief
  // Prints ONLY the path: the reading must leave the conductor's chat the way a worker brief does.
  if (ARGV.includes("--seal")) {
    let slug = isOpenHit ? hit.slug : null;
    if (!slug) {
      slug = freshSlug(tasks, text, plansDir);
      captureJob(board, slug, text);
      // stdout carries only the path; the one-line reason for a new job goes to stderr.
      const why = newJobReason(hit);
      if (why) console.error(why);
    }
    // The job's own words, saved when it was created (obs 0236). The engine tells the conductor
    // to call `--seal` with the job NAME, so that argument alone would hand the reader a slug.
    const saved = tasks[slug] && typeof tasks[slug].what === "string" ? tasks[slug].what.trim() : "";
    const jobText = !saved || saved === text ? (saved || text)
      : text === slug ? saved
      : `${saved}\n\n${text}`;
    fs.mkdirSync(plansDir, { recursive: true });
    const planPath = path.join(plansDir, `${slug}.md`);
    const brief = buildSealBrief({
      slug,
      text: jobText,
      named: extractNamedFiles(jobText),
      planPath: planPath.split(path.sep).join("/"),
      boardCmd: BOARD_CMD,
      root: ROOT.split(path.sep).join("/"),
      draftExists: fs.existsSync(planPath),
      config,
      house
    });
    const outPath = path.join(plansDir, `${slug}.seal-brief.md`);
    fs.writeFileSync(outPath, brief);
    console.log(outPath);
    process.exit(0);
  }

  // ---------------------------------------------------------------- an open job: preview it
  if (isOpenHit) {
    const slug = hit.slug;
    const t = tasks[slug];

    // Before anything else: a run of this job that never ended is carried on, not restarted.
    const cut = await cutOffRunFor(slug);
    if (cut) return carryOn(cut, slug, { force: ARGV.includes("--force") });

    console.log(`Matched job: \`${slug}\` — ${t.display || slug}\n`);

    // The house screen gate (start.mjs) refuses here too, so a preview never promises a run
    // that `start` will then refuse. Writes nothing.
    const gate = screenGateCheck(slug, config, ROOT);
    if (gate.blocked) {
      console.log(`\`/one-go\` cannot run \`${slug}\` — ${gate.message} Nothing was written.`);
      process.exit(1);
    }

    const { plan, isSealed: sealed, errors } = loadAuthoritativePlan(plansDir, slug, { readOnly: true });
    if (!sealed) {
      // Not sealed is not the same as nothing on disk: show what the draft already holds, so the
      // next chat resumes the reading instead of restarting it.
      console.log(`No sealed plan yet for \`${slug}\`.`);
      printDraftResume(plansDir, slug);
      process.exit(1);
    }
    if (errors && errors.length) {
      console.log(`The sealed plan for \`${slug}\` cannot be read:`);
      for (const e of errors) console.log(`  - ${e}`);
      process.exit(1);
    }

    // RESUME-BRIEF.md from the newest run, printed before the pass table; refused outright if
    // the plan was resealed BEFORE the brief was written (it would describe an older plan).
    const runsForSlug = (ctx.runsBySlug && ctx.runsBySlug.get && ctx.runsBySlug.get(slug)) || [];
    const lastRun = runsForSlug[runsForSlug.length - 1];
    if (lastRun) {
      const briefPath = path.join(ONEGO, lastRun.runId, "RESUME-BRIEF.md");
      if (fs.existsSync(briefPath)) {
        console.log(fs.readFileSync(briefPath, "utf-8"));
        console.log("");
        const planJsonPath = path.join(plansDir, `${slug}.plan.json`);
        const planMdPath = path.join(plansDir, `${slug}.md`);
        const planPath = fs.existsSync(planJsonPath) ? planJsonPath : planMdPath;
        const briefMtime = fs.statSync(briefPath).mtimeMs;
        const planMtime = fs.existsSync(planPath) ? fs.statSync(planPath).mtimeMs : 0;
        if (briefMtime > planMtime) {
          console.log(`⛔ \`${slug}\` was sealed before the resume brief above existed — reseal the plan (or resolve the brief) before dispatching again.`);
          process.exit(1);
        }
      }
    }

    const allPasses = (plan.passes || []).map(p => ({
      n: p.n,
      title: p.purpose || p.title,
      model: p.route?.requested_model || p.model || "",
      files: p.writes || p.files || [],
      reads: p.reads || [],
      shared: p.shared_resources || p.shared || [],
      depends: p.prerequisites || p.depends || [],
      status: ""
    }));
    const dependantCount = new Map();
    for (const p of allPasses) for (const d of p.depends || []) dependantCount.set(d, (dependantCount.get(d) || 0) + 1);
    const previewPick = chooseHost({ plan: planHost(plan), env: process.env.ONEGO_HOST, config });
    const previewHost = previewPick.error ? "claude" : previewPick.host;
    const routed = allPasses.map(p => ({ ...p, route: routeFor(p, { host: previewHost, dependantCount: dependantCount.get(p.n) || 0, config }) }));

    console.log("| # | Pass | Model |");
    console.log("|---|---|---|");
    for (const p of routed) console.log(`| ${p.n} | ${p.title} | ${p.route.model} · ${p.route.effort} |`);

    // fix D1: this job's own claim rows never hold its own passes back in the preview either.
    const foreign = foreignClaims(ctx.claimRows || [], ownClaimMarks(ONEGO, slug));
    const { lanes, blocked } = await lanesFor(routed, foreign);
    console.log("");
    if (!lanes.length) console.log("Nothing can run right now — every pass is blocked.");
    else lanes.forEach((lane, i) => console.log(`Lane ${i + 1} (${i === 0 ? "parallel" : `after lane ${i}`}): ${lane.map(p => `p${p.n}`).join(", ")}`));
    for (const b of blocked) console.log(`Blocked: p${b.pass.n} — ${b.reason}`);
    const held = claimConflicts(routed, foreign);
    if (held.length) console.log(claimWayOut(slug, held.map(h => h.claim)));

    // The plan's shape in waves — worded by the same helper check-plan uses, so a plan sealed
    // from a handoff shows the same summary and the same one-pass-wide warning.
    const shape = waveShape(allPasses);
    console.log(`\n${shape.line}`);
    console.log(shape.summary);
    if (shape.warning) console.log(shape.warning);

    console.log(`\nPreview only — dispatch writes nothing yet.`);
    console.log(`NEXT, FOR THE CONDUCTOR (the person types nothing here): run \`board.mjs start ${slug}\` yourself, then for each pass in lane 1 run these two commands (or ask \`board.mjs next ${slug}\`):`);
    if (lanes.length) {
      for (const p of lanes[0]) {
        console.log(`  board.mjs brief "${slug}" ${p.n} --out`);
        console.log(`  Agent(one-go-worker, model ${agentModel(p.route, config)}): Read <path>. Do exactly that. Report back in the 12-line format it specifies.`);
      }
    } else {
      console.log(`  (no runnable pass yet — resolve the blocked reasons above first)`);
    }
    console.log(`Rule: the brief is never pasted into this chat.`);
    console.log(`The person's only input to a dispatched job is answering the sealing questions, once.`);
    process.exit(0);
  }

  // ---------------------------------------------------------------- anything else: a new job
  const why = newJobReason(hit);
  const slug = freshSlug(tasks, text, plansDir);
  captureJob(board, slug, text);
  if (why) console.log(why);
  console.log(`New job: \`${slug}\``);
  console.log(`Plan not sealed. CONDUCTOR: run \`board.mjs dispatch "${slug}" --seal\`, fire pass 0 (the reading) as a worker`);
  console.log(`on the path it prints, put its questions to the person in one block, seal, and carry on.`);
  process.exit(0);
}

// ---------------------------------------------------------------------------- named files
// Pulls anything that looks like a file path/name out of free text: a token with a slash, or
// one ending in a short extension. Approximate on purpose — this seeds a reading list for the
// reading worker to check, not a guaranteed-complete parse.
export function extractNamedFiles(text) {
  const matches = String(text || "").match(/[\w.\-]+(?:[\/\\][\w.\-]+)*\.[A-Za-z0-9]{1,6}\b/g) || [];
  return [...new Set(matches)];
}

// ---------------------------------------------------------------------------- draft resume
// Reads the human draft plan (never the JSON authority — a draft has none yet) and reports what
// the last chat already got onto disk. Purely informational; writes nothing.
export function printDraftResume(plansDir, slug) {
  const mdPath = path.join(plansDir, `${slug}.md`);
  let text = null;
  try { text = fs.readFileSync(mdPath, "utf8"); } catch { /* no draft yet */ }

  if (text === null) {
    console.log(`No plan file on disk either (\`${mdPath}\`).`);
    console.log("");
    console.log(`Start the reading as a WORKER, not in this chat: \`board.mjs dispatch "${slug}" --seal\` writes`);
    console.log("its instructions and prints their path. The worker reads every file the job touches and");
    console.log("writes the plan; this chat only puts the questions to the person and seals.");
    return;
  }

  // Line scanning, not a RegExp built from a string: a section parser that silently matches
  // nothing would report a plan full of work as an empty one.
  const allLines = text.split(/\r?\n/);
  const section = (name) => {
    const want = ("## " + name).toLowerCase();
    const i = allLines.findIndex(l => l.trim().toLowerCase().startsWith(want));
    if (i < 0) return [];
    const out = [];
    for (let j = i + 1; j < allLines.length; j++) {
      if (allLines[j].startsWith("## ")) break;
      out.push(allLines[j]);
    }
    return out;
  };
  const tableRows = (arr) =>
    arr.map(l => l.trim())
       .filter(l => l.startsWith("|") && !/^\|[\s|:-]+\|$/.test(l) && !/^\|\s*(File|#)\s*\|/i.test(l));
  const numbered = (arr) => arr.filter(l => /^\s*\d+[.)]\s+\S/.test(l));

  const read = tableRows(section("What I read before asking"));
  const passes = tableRows(section("Passes"));
  const questions = numbered(section("Open questions"));
  const stateLine = (text.match(/^State:.*$/m) || ["State: (none)"])[0];

  console.log(`Draft on disk: \`${mdPath}\``);
  console.log(`  ${stateLine}`);
  console.log(`  reading list: ${read.length} file(s) already read`);
  console.log(`  passes drafted: ${passes.length}`);
  console.log(`  open questions drafted: ${questions.length}`);
  console.log("");

  if (read.length) {
    console.log("DO NOT RE-READ these — they are read, and what they gave is in the plan:");
    for (const r of read) {
      const cell = r.split("|").map(c => c.trim()).filter(Boolean)[0] || r;
      console.log(`  · ${cell}`);
    }
    console.log("");
  }

  if (questions.length) {
    console.log(`Next: run \`board.mjs check-plan ${slug}\` until it passes, then put these ${questions.length} question(s)`);
    console.log("to the person in ONE block, write their answers word for word into the plan's `## Answers`");
    console.log("section the same turn, set `State: sealed <date>`, and carry straight on into the run.");
    console.log("The person answers the questions and nothing else.");
  } else {
    console.log(`Next: continue the reading in a WORKER (\`board.mjs dispatch "${slug}" --seal\`), appending each`);
    console.log("file to `## What I read before asking` as it is read — never in one write at the end.");
  }
}
