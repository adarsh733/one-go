// cmd/start.mjs — create the run: scope it, check it, route it, record it. Ported from the live
// skill. Hidden plumbing (CONTRACT §4) — `/one-go dispatch <job>` is how the person reaches it.
//
// Reproduced defects this file still closes:
//   D3  `start alpha/part-a` on a three-pass plan wrote a run holding ALL THREE passes,
//       including the one belonging to part-b. Finishing one part ran the whole job.
//   D4  every pass in that scoped run was stamped `subtask: "part-a"`, so `pass alpha 1 done`
//       marked the entire part finished after the first of three passes.
//   D5  the plan's `Depends on` column was parsed into a variable and then thrown away, so the
//       run had no dependency information at all and `pass` could only ever walk n -> n+1.
//   D6  two starts in the same minute produced the same run id, and the second wrote a fresh
//       state.json straight over the first run's recorded evidence.
//
// Changed for this build (dev/HANDOFFS-BETWEEN-PASSES.md):
//   - the <app-folder>-specific FROZEN.md check is now a house adapter: `screenGateCheck`
//     below reads `config.screen_gate` / `config.frozen_dirs` / `config.screen_slug_pattern`
//     and lib/house.mjs's `readFrozenStatus` — no project folder name lives in this file anymore;
//   - `routeFor` is called with `config` so a house's model-tier overrides apply;
//   - the human plan `plans/<slug>.md` is NEVER rewritten again (obs 0042d) — the regenerated
//     view goes only to the run folder, via `writePlanView` (lib/plan.mjs), MERGED with the
//     human file so the run keeps its reading list, questions and notes (2026-09-28 port).
import fs from "node:fs";
import path from "node:path";
import { ROOT, ONEGO } from "../lib/paths.mjs";
import { resolveTaskStrict, saveBoard } from "../lib/board-io.mjs";
import { readJSON, slugify, today, stamp, argValues, positionals } from "../lib/util.mjs";
import { writeJSONAtomic, writeFileAtomic } from "../lib/atomic.mjs";
import { passesForPart, scopeDependencies, loadAuthoritativePlan, writePlanView, validateSealedPlan, SEAL_GATE_CUTOFF } from "../lib/plan.mjs";
import { validateGraph, readyPasses, criticalPath } from "../lib/graph.mjs";
import { routeFor, chooseHost, planHost, isWorkerHost, namedModel, tierModelMap, resolveScoutModels, withScoutModels } from "../lib/route.mjs";
import { readScout } from "./models.mjs";
import { claimConflicts, selectParallelBatch } from "../lib/overlap.mjs";
import { fingerprintAll, RUN_SCHEMA } from "../lib/evidence.mjs";
import { isDoneStatus, isStuckStatus, isRunningStatus, isStartableStatus } from "../lib/status.mjs";
import { readFrozenStatus } from "../lib/house.mjs";
import { resolveHousePath, resolveParallelLimit, DEFAULT_PARALLEL_LIMIT } from "../lib/config.mjs";
import { ownClaimMarks, foreignClaims, claimWayOut } from "../lib/claims.mjs";
import { takeSnapshot, writeSnapshot } from "../lib/snapshot.mjs";

// `validateSealedPlan` runs only on runs created on or after SEAL_GATE_CUTOFF (lib/plan.mjs), so
// a plan sealed (and a run started) before the seal gate existed is never stranded by a rule it
// predates — the same grandfathering the proof gate uses (see cmd/audit.mjs's date guard).

function refuse(lines) {
  for (const l of [].concat(lines)) console.log(l);
  console.log("\nNothing was written.");
  process.exit(1);
}

/**
 * The one screen-lane block, now house-driven (Q11: wedding's screen gate stays off; H&M's stays
 * on — decided per project in config.json, never guessed from a folder name here).
 *   config.screen_gate !== "on"                       → not gated, proceed
 *   config.screen_slug_pattern set and slug fails it   → not a screen job, proceed
 *   no FROZEN.md found under any config.frozen_dirs    → not a screen job, proceed
 *   found, readFrozenStatus === "frozen"                → proceed
 *   found, "not_frozen"                                  → refused, honestly
 *   found, "no_reader" (obs 0009: never claim "not frozen" when a reader simply cannot parse it)
 *                                                         → refused, honestly, with the different wording
 * @returns {{ blocked: boolean, message?: string }}
 */
export function screenGateCheck(slug, config, root = ROOT) {
  if (!config || config.screen_gate !== "on") return { blocked: false };
  if (config.screen_slug_pattern) {
    let rx = null;
    try { rx = new RegExp(config.screen_slug_pattern); } catch { rx = null; }
    if (rx && !rx.test(slug)) return { blocked: false };
  }
  let text = null, found = null;
  for (const d of config.frozen_dirs || []) {
    const base = resolveHousePath(d, root);
    if (!base) continue;
    const file = path.join(base, slug, "FROZEN.md");
    const t = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null;
    if (t != null) { text = t; found = file; break; }
  }
  if (text == null) return { blocked: false };
  const status = readFrozenStatus(text);
  if (status === "frozen") return { blocked: false };
  if (status === "not_frozen") {
    return { blocked: true, message: `its contract status is not frozen in \`${found}\`. Take that freeze first.` };
  }
  return { blocked: true, message: `its contract status could not be read from \`${found}\` (no reader) — check it by hand, then take a freeze if it genuinely needs one.` };
}

/**
 * The run's tier-to-model map, one line per tier, then any WARNING lines (every tier on the same
 * model or none named; a named model not in the form the host's tool accepts). Passes that name
 * a real model themselves are form-checked too.
 * `scout` is readScout's answer for this host (null when the model scout is off): it adds the
 * "no longer in the list" fallbacks to the map, then its own warnings — a list that could not be
 * read, and the stale-cards line. A warning never stops a run.
 */
function printModelMap(host, config, passes, scout = null) {
  const extraModels = (passes || []).map(p => namedModel(p.route)).filter(Boolean);
  const { lines, warnings } = tierModelMap(config, host, { extraModels, scout });
  console.log(`**Models on ${host}:**`);
  for (const l of lines) console.log(`- ${l}`);
  for (const w of [...warnings, ...(scout ? scout.warnings : [])]) console.log(w);
  console.log("");
}

export function runStart({ ARGV, tasks, board, claimRows, config }) {
  const rest = ARGV.slice(1);
  const target = positionals(rest).join(" ").trim();
  if (!target) {
    console.log("Provide a job to start: board.mjs start <job>[/<part>] [--ceiling 8h] [--host <name>] [--parallel N]");
    process.exit(1);
  }

  const [taskPart, subPart] = target.split("/");
  const resolved = resolveTaskStrict(tasks, taskPart);
  if (resolved.ambiguous) {
    refuse([`"${taskPart}" could mean more than one job — I will not guess which:`,
      ...resolved.ambiguous.map(s => `  - \`${s}\` — ${(tasks[s] && tasks[s].display) || s}`),
      "", "Name it exactly."]);
  }
  if (!resolved.slug) refuse([`${resolved.error}. Run /one-go to see the list.`]);
  const slug = resolved.slug;
  const t = tasks[slug];

  let scopedSub = null;
  if (subPart) {
    const subs = t.subtasks || [];
    scopedSub = subs.find(x => x.id === subPart || slugify(x.title, 9).startsWith(slugify(subPart, 9)));
    if (!scopedSub) {
      refuse([`No part matches "${subPart}" under ${t.display}. Its parts:`,
        ...(subs.length ? subs.map(s => `  - \`${s.id}\` — ${s.title}`) : ["  (none recorded)"])]);
    }
  }

  // ---------------------------------------------------------------- the one screen-lane block
  const gate = screenGateCheck(slug, config, ROOT);
  if (gate.blocked) {
    refuse([`\`/one-go\` cannot start \`${slug}\` — ${gate.message}`]);
  }

  // ---------------------------------------------------------------- the sealed plan
  const plansDir = path.join(ONEGO, "plans");
  // readOnly: true — a refusal below must mean "nothing was written" (see refuse(), which says
  // exactly that). The regenerated view is written once, only on the paths that actually
  // proceed, and only into the run folder — the human plan file is never touched (obs 0042d).
  const { plan, isSealed: sealed, errors: planErrors } = loadAuthoritativePlan(plansDir, slug, { readOnly: true });
  if (!sealed) {
    refuse([`No sealed plan yet for \`${slug}\`.`,
      `Run the sealing conversation first, then start again.`]);
  }
  if (planErrors && planErrors.length) refuse([`The sealed plan for \`${slug}\` cannot be read:`, ...planErrors.map(e => `  - ${e}`)]);

  const allPasses = (plan.passes || []).map(p => ({
    n: p.n,
    pass_id: p.pass_id || `${plan.plan_id || `plan-${slug}`}:p${p.n}`,
    title: p.purpose || p.title,
    model: p.route?.requested_model || p.model || "",
    route: p.route || null,
    files: p.writes || p.files || [],
    reads: p.reads || [],
    shared: p.shared_resources || p.shared || [],
    depends: p.prerequisites || p.depends || [],
    exclusions: p.exclusions || [],
    required_check: p.required_check || {
      check_id: `${p.pass_id || `${plan.plan_id || `plan-${slug}`}:p${p.n}`}:check`,
      command: p.proven_by || "node -e \"process.exit(0)\""
    },
    proven_by: p.required_check?.command || p.proven_by || "",
    part: p.part || null,
    part_label: p.part_label || null
  }));


  // ---------------------------------------------------------------- D3 · scope to the part
  const { passes: picked, guessed } = passesForPart(allPasses, scopedSub);
  if (scopedSub && !picked.length) {
    refuse([`\`${slug}/${scopedSub.id}\` has no passes in the sealed plan.`,
      "",
      "Add a `Part` column to the plan's `## Passes` table naming which part each pass belongs to:",
      "  | # | What it does | Model | Files it writes | Proven by | Depends on | Part |",
      "",
      "Without it I cannot tell this part's passes from its siblings', and running all of them",
      "is how one part's first pass used to mark the whole part finished."]);
  }
  // ---------------------------------------------------------------- D5 · the graph is real now
  // Validate the WHOLE plan's graph BEFORE scoping. This order matters and was wrong once:
  // scoping strips any dependency that is not in the scope, so a genuinely dangling number — a
  // typo like "depends on 9" in a four-pass plan — was being stripped and then reported as
  // "outside this part, assumed already finished". A typo silently became an assumption. The
  // full-plan check catches it while it is still a typo.
  const fullGraph = validateGraph(allPasses);
  if (!fullGraph.ok) {
    refuse([`The plan's dependencies cannot be scheduled:`, ...fullGraph.errors.map(e => `  - ${e}`),
      "", "A cycle or a dependency on a pass that does not exist would deadlock the run at 3am.",
      "Fix the plan first."]);
  }

  const scoped = scopeDependencies(picked);
  // R3 fix: refuse to drop a dependency that sits outside the selected scope without verifying
  // it is done. The old behaviour printed "assumed already finished" and continued — that is the
  // exact defect: a prerequisite that has never run becomes an implicit done. Instead, refuse
  // and tell the user to run the whole job or start the prerequisite part first.
  const droppedNotes = scoped.filter(p => (p.dropped_depends || []).length);
  if (droppedNotes.length) {
    const lines = [`Cannot start \`${slug}/${scopedSub ? scopedSub.id : ""}\` — it has prerequisites outside this part that have not been verified:`];
    for (const p of droppedNotes) {
      lines.push(`  - pass ${p.n} (${p.title}) depends on pass${p.dropped_depends.length > 1 ? "es" : ""} ${p.dropped_depends.join(", ")}, which belong to a different part`);
    }
    lines.push("", "Options:", "  - Run the whole job: board.mjs start " + slug,
      "  - Run the prerequisite part first, verify it, then start this part");
    refuse(lines);
  }

  const graph = validateGraph(scoped);
  if (!graph.ok) {
    refuse([`This part's dependencies cannot be scheduled:`, ...graph.errors.map(e => `  - ${e}`)]);
  }

  // ---------------------------------------------------------------- ownership, before writing
  // fix D1: the job's OWN claim rows (the conductor's pre-start claim, earlier runs' pass claims)
  // never block it — only another chat's do, and the refusal names that claim and the way out.
  const conflicts = claimConflicts(scoped, foreignClaims(claimRows || [], ownClaimMarks(ONEGO, slug)));
  // 0106: print how many claim rows were read (for debugging/observability).
  console.log(`claim rows read: ${(claimRows || []).length}`);
  if (conflicts.length && !ARGV.includes("--ignore-claims")) {
    refuse([`Another chat window is holding files this run would write:`,
      ...conflicts.map(c => `  - pass ${c.pass} writes \`${c.file}\` — held by \`${c.claim}\``),
      "",
      "The claims board is the authority on who may edit a file, and a run id is not a second one.",
      claimWayOut(slug, conflicts.map(c => c.claim)),
      "Or narrow the plan's file list."]);
  }

  // ---------------------------------------------------------------- host + parallel limit
  const hostFlag = argValues(rest, "--host")[0];
  const hostPick = chooseHost({
    flag: hostFlag,
    plan: planHost(plan),          // compat D11: a host the older engine wrote is history, not an instruction
    env: process.env.ONEGO_HOST,
    config
  });
  if (hostPick.error) refuse([hostPick.error]);
  const host = hostPick.host;
  if (hostPick.asked) console.log(`Host ${hostPick.asked} cannot start helpers, so this run goes inline: the chat does each pass itself, one at a time, in plan order.`);
  // At-once setting: --parallel N, then (on resume) the stopped run's own value, then config
  // parallel_limit, then the safety ceiling of 8 (lib/config.mjs resolveParallelLimit).
  const parallelFlag = argValues(rest, "--parallel")[0];
  const parallelPick = resolveParallelLimit({ flag: parallelFlag, config });
  if (parallelPick.error) refuse([parallelPick.error]);
  const parallelLimit = parallelPick.limit || DEFAULT_PARALLEL_LIMIT;

  // ---------------------------------------------------------------- D6 · a run id that cannot collide (or resume stopped run)
  const allRunDirs = fs.existsSync(ONEGO)
    ? fs.readdirSync(ONEGO, { withFileTypes: true })
        .filter(e => e.isDirectory() && /^\d{4}-\d{2}-\d{2}-/.test(e.name))
        .map(e => e.name)
        .sort((a, b) => b.localeCompare(a))
    : [];

  let stoppedRunToResume = null;
  for (const dir of allRunDirs) {
    const st = readJSON(path.join(ONEGO, dir, "state.json"), null);
    if (!st || st.slug !== slug) continue;
    if (scopedSub && st.scope !== scopedSub.id) continue;
    if (!scopedSub && st.scope) continue;

    const runPasses = Array.isArray(st.passes) ? st.passes : [];
    const isDone = p => isDoneStatus(p.status);
    const allDone = runPasses.length > 0 && runPasses.every(isDone);
    const isCeilingFailed = Boolean(st.ended && /ceiling/i.test(st.ended));
    const isGenuinelyStopped = Boolean(
      (st.ended && /stop/i.test(st.ended)) ||
      fs.existsSync(path.join(ONEGO, dir, "STOP"))
    );

    if (isGenuinelyStopped && !allDone && !isCeilingFailed) {
      stoppedRunToResume = { runId: dir, state: st };
    }
    break; // only check the newest run for this slug/scope
  }

  if (stoppedRunToResume) {
    const runId = stoppedRunToResume.runId;
    const runDir = path.join(ONEGO, runId);
    const resumedState = stoppedRunToResume.state;

    // Past every refuse() gate on this path — safe to write the regenerated view now, into the
    // run folder only. The human plan `plans/<slug>.md` is never touched (obs 0042d).
    writePlanView(runDir, plan, { humanPath: path.join(plansDir, `${slug}.md`) });

    delete resumedState.ended;
    // A stopped run this resumes may have been closed once already (close.mjs stamps `ending`
    // and `open_items` alongside `ended` — pass 6 handoff). Starting it again means none of
    // that verdict is true anymore, so it must not linger and be read as still current by a
    // later board read or close.
    delete resumedState.ending;
    delete resumedState.open_items;
    delete resumedState.open_items_accepted;
    try { fs.unlinkSync(path.join(runDir, "STOP")); } catch {}

    for (const p of resumedState.passes || []) {
      if (!isDoneStatus(p.status)) {
        p.status = "pending";
        if (p.parked_question && p.parked_question.includes("stop")) p.parked_question = null;
        delete p.stop_intent;
        delete p.worker;
      }
    }

    const opts = { isDone: isDoneStatus, isStuck: isStuckStatus, isRunning: isRunningStatus, isStartable: isStartableStatus };
    const ready = readyPasses(resumedState.passes, opts);
    const depth = new Map(criticalPath(resumedState.passes, opts).map(c => [c.n, c.remaining]));
    const ordered = ready.slice().sort((a, b) => (depth.get(b.n) || 0) - (depth.get(a.n) || 0) || a.n - b.n);
    const running = (resumedState.passes || []).filter(x => isRunningStatus(x.status));
    const limitPick = resolveParallelLimit({ flag: parallelFlag, resumed: resumedState.parallel_limit, config });
    const limit = limitPick.limit;
    resumedState.parallel_limit = limit;
    // compat D11: a run carries on on the host it actually ran on; only --host moves it.
    const runHost = (!hostFlag && resumedState.host) ? resumedState.host : host;
    resumedState.host = runHost;
    const { chosen } = selectParallelBatch(ordered, Math.max(0, limit - running.length), running);

    const workerHost = isWorkerHost(runHost, config);
    if (workerHost) {
      for (const r of chosen) {
        const p = (resumedState.passes || []).find(x => x.n === r.n);
        if (p) {
          p.attempts = (p.attempts || 0) + 1;
          p.attempt_id = `${runId}:${p.pass_id}:a${p.attempts}`;
          p.status = "launch-requested";
          p.launch_intent = {
            run_id: runId,
            pass_id: p.pass_id,
            attempt_id: p.attempt_id,
            requested_model: namedModel(p.route),
            requested_effort: p.route?.effort || null
          };
        }
      }
    }

    const curStamp = stamp();
    resumedState.heartbeat = curStamp;
    // `conductor_last_seen` is a DIFFERENT clock from `heartbeat`: heartbeat is stamped by pass
    // activity (a worker doing something); this is stamped by the conductor itself checking in
    // (start, watchdog). A worker can go quiet while the conductor is still fine, and vice versa
    // — collapsing them into one field is how "nothing stays a zombie" fails (see revive.mjs).
    resumedState.conductor_last_seen = curStamp;

    writeJSONAtomic(path.join(runDir, "state.json"), resumedState);
    writeFileAtomic(path.join(runDir, "heartbeat.txt"), curStamp + "\n");
    // D7: write per-run marker under ACTIVE.d/ alongside the legacy single-file ACTIVE (still
    // read by older engines and hooks that have not been updated yet).
    writeFileAtomic(path.join(ONEGO, "ACTIVE"), runId + "\n");
    const activeDPath = path.join(ONEGO, "ACTIVE.d", runId);
    fs.mkdirSync(path.join(ONEGO, "ACTIVE.d"), { recursive: true });
    writeFileAtomic(activeDPath, runId + "\n");
    // LIVE.json — a liveness record revive/watchdog can check against the real OS process table,
    // instead of guessing from a text timestamp alone (see cmd/revive.mjs isConductorGone).
    writeJSONAtomic(path.join(runDir, "LIVE.json"), { pid: process.pid, host: runHost, started: curStamp });

    t.stage = "running";
    t.run_id = runId;
    delete t.stage_override;
    t.next_move = chosen.length
      ? `${chosen.length} pass${chosen.length === 1 ? "" : "es"} ready to start`
      : "no pass is ready — check the plan's dependencies";
    if (scopedSub) { scopedSub.stage = "running"; scopedSub.updated = today(); }
    saveBoard(board);

    console.log(`🚀 Resumed run \`${runId}\` for **${t.display || slug}**${scopedSub ? ` · part **${scopedSub.title}**` : ""}\n`);
    console.log(`- **Scope**: ${scopedSub ? `part ${scopedSub.id}` : `all passes`}`);
    console.log(`- **At once**: up to ${limit} (from ${limitPick.source})`);
    console.log(`- **Stand-down flag**: \`.claude/one-go/ACTIVE\`\n`);
    printModelMap(runHost, config, resumedState.passes, readScout({ config, root: ROOT, host: runHost }));
    console.log(`\n**Ready to start now:** ${chosen.length ? chosen.map(p => `pass ${p.n}`).join(", ") : "none"}`);
    process.exit(0);
  }

  const d = new Date();
  // Test seam only: ONEGO_TEST_TODAY lets a seal-gate test simulate being on/after
  // SEAL_GATE_CUTOFF without waiting for the calendar. Unset (always) in production, where this
  // is exactly today().
  const ymd = process.env.ONEGO_TEST_TODAY || today();
  const hm = d.toTimeString().slice(0, 5).replace(":", "");

  // ---------------------------------------------------------------- seal gate (new runs only)
  // Never reached by the resume path above (it returns before this line). `ymd` is this run's
  // creation date, matching the grandfathering rule SEAL_GATE_CUTOFF (lib/plan.mjs) describes.
  if (ymd >= SEAL_GATE_CUTOFF) {
    const sealCheck = validateSealedPlan(plan, { root: ROOT, config });
    if (sealCheck.errors && sealCheck.errors.length) {
      refuse([`The sealed plan for \`${slug}\` fails the seal gate — nothing was started:`,
        ...sealCheck.errors.map(e => `  - ${e}`)]);
    }
  }
  const base = `${ymd}-${hm}-${slug}${scopedSub ? "-" + scopedSub.id : ""}`;
  let runId = base, attempt = 1;
  while (fs.existsSync(path.join(ONEGO, runId))) {
    attempt += 1;
    runId = `${base}-a${attempt}`;
    if (attempt > 50) refuse([`Cannot find a free run id for \`${base}\` — 50 attempts already exist.`]);
  }
  const runDir = path.join(ONEGO, runId);

  // ---------------------------------------------------------------- routing + fingerprints
  const dependantCount = new Map();
  for (const p of scoped) for (const dep of p.depends || []) dependantCount.set(dep, (dependantCount.get(dep) || 0) + 1);

  // The model scout: this run's own host list is read ONCE (only when config.model_cards is set and
  // the host takes its models from the cards). "auto" and vanished pins are settled here, so every
  // route below — and the briefs and the report that read it — carry a plain model name.
  const scout = readScout({ config, root: ROOT, host });
  const scouted = resolveScoutModels(config, host, scout);
  const routeConfig = scout || scouted.auto.length ? withScoutModels(config, host, scouted.models) : config;

  const passes = scoped.map(p => {
    const route = routeFor(p, { host, dependantCount: dependantCount.get(p.n) || 0, config: routeConfig });
    const passId = p.pass_id || `${plan.plan_id || `plan-${slug}`}:p${p.n}`;
    return {
      n: p.n,
      pass_id: passId,
      task: slug,
      title: p.title,
      // The part a pass ACTUALLY belongs to — never the scope it was launched under. This is
      // the D4 fix: stamping every pass with the scoped part is what let pass 1 of 3 finish it.
      subtask: p.part || null,
      model: route.model,
      route,
      files: p.files,
      reads: p.reads || [],
      shared: p.shared || [],
      depends: p.depends,
      exclusions: p.exclusions || [],
      required_check: p.required_check || {
        check_id: `${passId}:check`,
        command: p.proven_by || "node -e \"process.exit(0)\""
      },
      proven_by: p.proven_by,
      claim_id: `C-${runId.slice(0, 15)}-p${p.n}`,
      status: "pending",
      commit: null,
      proven: null,
      parked_question: null,
      attempts: 0,
      attempt_id: null,
      launch_intent: null,
      // Fingerprint output files at launch (pre-work state). When the pass is marked done,
      // these are rebound to the post-work state (see pass.mjs R2 fix). staleEvidence then
      // detects changes made AFTER acceptance — not before, which would be the pass doing its job.
      input_fingerprints: fingerprintAll(ROOT, p.files)
    };
  });

  // Only the passes with no prerequisites may begin. Not "pass 1" — the ones the graph says.
  const opts = { isDone: isDoneStatus, isStuck: isStuckStatus, isRunning: isRunningStatus, isStartable: isStartableStatus };
  const ready = readyPasses(passes, opts);
  const depth = new Map(criticalPath(passes, opts).map(c => [c.n, c.remaining]));
  const ordered = ready.slice().sort((a, b) => (depth.get(b.n) || 0) - (depth.get(a.n) || 0) || a.n - b.n);
  const { chosen, rejected } = selectParallelBatch(ordered, parallelLimit, []);

  const workerHost = isWorkerHost(host, config);
  if (workerHost) {
    for (const r of chosen) {
      const p = passes.find(x => x.n === r.n);
      if (p) {
        p.attempts = 1;
        p.attempt_id = `${runId}:${p.pass_id}:a${p.attempts}`;
        p.status = "launch-requested";
        p.launch_intent = {
          run_id: runId,
          pass_id: p.pass_id,
          attempt_id: p.attempt_id,
          requested_model: namedModel(p.route),
          requested_effort: p.route?.effort || null
        };
      }
    }
  }

  const curStamp = stamp();
  const ceiling = argValues(rest, "--ceiling")[0] || "8h";
  const ceilingHours = Number(String(ceiling).replace(/[^\d.]/g, "")) || 8;

  const state = {
    schema: RUN_SCHEMA,          // marks this run as one the evidence gate applies to
    run_id: runId,
    plan_id: plan.plan_id || `plan-${slug}`,
    plan_revision: plan.plan_revision || 1,
    handoff_id: plan.handoff_id || `${plan.plan_id || `plan-${slug}`}:handoff`,
    retry_policy: plan.retry_policy || { max_attempts: 3 },
    usage_policy: plan.usage_policy || { record_actual_only: true, unavailable_label: "unavailable" },
    exclusions: plan.exclusions || [],
    allowed_writes: plan.allowed_writes || [],
    shared_resources: plan.shared_resources || [],
    answers: plan.answers || [],
    aliases: plan.aliases || [],
    old_run_links: plan.old_run_links || [],
    attempt,
    slug,
    scope: scopedSub ? scopedSub.id : null,
    scope_guessed: guessed || false,
    task_id: (scopedSub && scopedSub.task_id) || t.task_id || null,
    started: curStamp,
    mode: argValues(rest, "--mode")[0] || "run",
    host,
    parallel_limit: parallelLimit,
    ceiling: `${ceiling} — started ${curStamp}`,
    ceiling_hours: ceilingHours,
    heartbeat: curStamp,
    // See the resume path above for why this is a separate field from heartbeat.
    conductor_last_seen: curStamp,
    passes
  };

  // ---------------------------------------------------------------- write, once, atomically
  fs.mkdirSync(path.join(runDir, "passes"), { recursive: true });
  writeFileAtomic(path.join(runDir, "heartbeat.txt"), curStamp + "\n");
  writeJSONAtomic(path.join(runDir, "state.json"), state);
  writeFileAtomic(path.join(ONEGO, "ACTIVE"), runId + "\n");
  // D7: per-run marker under ACTIVE.d/ alongside legacy single-file ACTIVE.
  const activeDPath = path.join(ONEGO, "ACTIVE.d", runId);
  fs.mkdirSync(path.join(ONEGO, "ACTIVE.d"), { recursive: true });
  writeFileAtomic(activeDPath, runId + "\n");
  // LIVE.json — see the resume path above.
  writeJSONAtomic(path.join(runDir, "LIVE.json"), { pid: process.pid, host, started: curStamp });
  // The generated readable view — into the run folder only. Never `plans/<slug>.md` (obs 0042d).
  writePlanView(runDir, plan, { humanPath: path.join(plansDir, `${slug}.md`) });

  // D8 · what was on disk at the start — every file any pass declares it will write, as it stood
  // before a single pass ran. `pass <job> <n> done` compares against this (lib/snapshot.mjs). A
  // snapshot that cannot be taken never stops the run: it is said, and the run carries on.
  let snapshotLine;
  try {
    const snap = takeSnapshot(passes);
    writeSnapshot(runDir, snap);
    snapshotLine = `snapshot: ${Object.keys(snap.files).length} declared file${Object.keys(snap.files).length === 1 ? "" : "s"} and ` +
      `${snap.patterns.length} pattern${snap.patterns.length === 1 ? "" : "s"} recorded in \`${path.basename(runDir)}/snapshot.json\``;
  } catch (e) {
    snapshotLine = `snapshot: not recorded for this run (${e.message})`;
  }


  t.stage = "running";
  t.run_id = runId;
  delete t.stage_override;
  t.next_move = chosen.length
    ? `${chosen.length} pass${chosen.length === 1 ? "" : "es"} ready to start`
    : "no pass is ready — check the plan's dependencies";
  if (scopedSub) { scopedSub.stage = "running"; scopedSub.updated = today(); }
  saveBoard(board);

  // ---------------------------------------------------------------- say what happened
  console.log(`🚀 Started run \`${runId}\` for **${t.display || slug}**${scopedSub ? ` · part **${scopedSub.title}**` : ""}\n`);
  if (attempt > 1) {
    console.log(`> This is attempt ${attempt}. An earlier run already owns \`${base}\`, and it was left`);
    console.log(`> exactly as it was — its evidence is intact.\n`);
  }
  if (guessed) {
    console.log(`> ⚠ The plan has no \`Part\` column, so this part's passes were matched by their wording.`);
    console.log(`> Check the list below is right before letting it run.\n`);
  }



  console.log(`- **Scope**: ${scopedSub ? `${passes.length} of the job's ${allPasses.length} passes` : `all ${passes.length} passes`}`);
  console.log(`- **Ceiling**: ${ceiling}`);
  console.log(`- **At once**: up to ${parallelLimit} (from ${parallelPick.source})`);
  console.log(`- **Stand-down flag**: \`.claude/one-go/ACTIVE\``);
  console.log(`- ${snapshotLine}\n`);
  printModelMap(host, config, passes, scout);

  console.log("| # | Pass | Model | Why that model | Needs | Status |");
  console.log("|---|---|---|---|---|---|");
  for (const p of passes) {
    const isReady = chosen.some(r => r.n === p.n);
    console.log(`| ${p.n} | ${p.title} | ${p.route.model} · ${p.route.effort} | ${p.route.reason} | ` +
      `${p.depends.length ? p.depends.join(", ") : "—"} | ${isReady ? "▶ ready" : "⬜ waiting"} |`);
  }

  console.log(`\n**Ready to start now:** ${chosen.length ? chosen.map(p => `pass ${p.n}`).join(", ") : "none"}`);
  console.log(`Run \`board.mjs lanes ${slug}\` to see which of those can run side by side.`);
  console.log(`\nEvery pass must record evidence: \`board.mjs pass ${slug} <n> done --proven "<what you checked>"\`.`);
  console.log(`A pass marked done with nothing to show is refused — that is the point.`);
  process.exit(0);
}
