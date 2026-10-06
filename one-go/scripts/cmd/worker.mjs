// cmd/worker.mjs — internal adapter command for acknowledgement, heartbeat, result, and stop
// acknowledgement (host adapter for Codex/Antigravity: `worker ack|heartbeat|result|stop-ack`).
// Hidden plumbing (CONTRACT §4) — not used by the Claude Agent-tool path, but kept working for
// those hosts. Ported from the live skill unchanged in behaviour; only the two calls into
// house-adapted libraries (`releaseClaims`, which now needs `config`) were updated to match
// their new signatures (dev/CONTRACT.md §5).
import fs from "node:fs";
import path from "node:path";
import { ONEGO, ROOT } from "../lib/paths.mjs";
import { findTask, saveBoard } from "../lib/board-io.mjs";
import { readText, stamp, argValues, positionals } from "../lib/util.mjs";
import { readJSONStrict, writeJSONAtomic, writeFileAtomic } from "../lib/atomic.mjs";
import { matchWorkerIdentity } from "../lib/worker.mjs";
import { releaseClaims } from "../lib/claims.mjs";
import { formatReport } from "../lib/report.mjs";
import { runPass } from "./pass.mjs";
import { looksLikeCommand } from "../lib/plan.mjs";
import { isRunningStatus } from "../lib/status.mjs";
import { releaseMarkers } from "../lib/marker.mjs";

export function runWorker(ctx) {
  const { ARGV, tasks, runsBySlug, board, config } = ctx;
  const rest = ARGV.slice(1);
  const subcmd = (rest[0] || "").toLowerCase();
  const target = rest[1];
  const passNum = Number(rest[2]);

  if (!subcmd || !target || isNaN(passNum)) {
    console.log("Usage: board.mjs worker <ack|heartbeat|result|stop-ack> <job> <pass> [options]");
    process.exit(1);
  }

  const slug = findTask(tasks, target);
  if (!slug) {
    console.log(`No task matches "${target}".`);
    process.exit(1);
  }

  const runId = argValues(rest, "--run")[0];
  const attemptId = argValues(rest, "--attempt")[0];
  const workerId = argValues(rest, "--worker")[0];
  const model = argValues(rest, "--model")[0];
  const effort = argValues(rest, "--effort")[0];
  const status = argValues(rest, "--status")[0];
  const note = argValues(rest, "--note")[0];

  const runs = (runsBySlug.get(slug) || []).slice().sort((a, b) => String(b.started).localeCompare(String(a.started)));
  const targetRunId = runId || (runs.length ? runs[0].runId : null);
  if (!targetRunId) {
    console.log(`No run found for "${target}".`);
    process.exit(1);
  }

  const runDir = path.join(ONEGO, targetRunId);
  const statePath = path.join(runDir, "state.json");
  const read = readJSONStrict(statePath);
  if (!read.present || !read.value) {
    console.log(`Could not read state.json for run \`${targetRunId}\`.`);
    process.exit(1);
  }
  const state = read.value;

  const pass = (state.passes || []).find(x => x.n === passNum);
  if (!pass) {
    console.log(`Pass ${passNum} not found in run \`${targetRunId}\`.`);
    process.exit(1);
  }

  if (subcmd === "ack") {
    if (!workerId || !String(workerId).trim()) {
      console.log("REFUSED: worker ID required");
      process.exit(1);
    }
    if (!model || !String(model).trim()) {
      console.log("REFUSED: model required");
      process.exit(1);
    }
    if (!effort || !String(effort).trim()) {
      console.log("REFUSED: effort required");
      process.exit(1);
    }

    const mismatch = matchWorkerIdentity(
      { run_id: targetRunId, pass_id: pass.pass_id, attempt_id: attemptId },
      { run_id: state.run_id, pass_id: pass.pass_id, attempt_id: pass.attempt_id }
    );
    if (mismatch) {
      console.log(`REFUSED: ${mismatch}`);
      process.exit(1);
    }

    pass.status = "running";
    pass.worker = {
      id: workerId,
      actual_model: model || null,
      actual_effort: effort || null,
      acknowledged_at: new Date().toISOString()
    };
    if (pass.route) {
      pass.route.confirmed = model || null;
    }
    writeJSONAtomic(statePath, state);
    console.log(`Worker \`${workerId}\` acknowledged pass ${passNum} (running)`);
    process.exit(0);
  }

  if (subcmd === "heartbeat") {
    const mismatch = matchWorkerIdentity(
      { run_id: targetRunId, pass_id: pass.pass_id, attempt_id: attemptId, worker_id: workerId },
      { run_id: state.run_id, pass_id: pass.pass_id, attempt_id: pass.attempt_id, worker_id: pass.worker?.id }
    );
    if (mismatch) {
      console.log(`REFUSED: ${mismatch}`);
      process.exit(1);
    }

    pass.worker = pass.worker || {};
    pass.worker.heartbeat_at = new Date().toISOString();
    state.heartbeat = stamp();
    writeJSONAtomic(statePath, state);
    console.log(`Worker \`${workerId}\` heartbeat recorded for pass ${passNum}`);
    process.exit(0);
  }

  if (subcmd === "result") {
    const mismatch = matchWorkerIdentity(
      { run_id: targetRunId, pass_id: pass.pass_id, attempt_id: attemptId, worker_id: workerId },
      { run_id: state.run_id, pass_id: pass.pass_id, attempt_id: pass.attempt_id, worker_id: pass.worker?.id }
    );
    if (mismatch) {
      console.log(`REFUSED: ${mismatch}`);
      process.exit(1);
    }

    const resStatus = (status || "done").toLowerCase();
    if (resStatus === "done") {
      const requiredCmd = (pass.required_check && pass.required_check.command) || pass.proven_by || "";
      const passArgs = [
        "pass",
        slug,
        String(passNum),
        "done",
        "--proven", note || "worker completed assigned edit",
        "--run", targetRunId
      ];
      if (requiredCmd && looksLikeCommand(requiredCmd)) {
        passArgs.push("--verify", requiredCmd);
      }
      return runPass({ ...ctx, ARGV: passArgs });
    }

    pass.status = resStatus;
    pass.proven = note || null;
    writeJSONAtomic(statePath, state);
    console.log(`Worker \`${workerId}\` result recorded for pass ${passNum} (${pass.status})`);
    process.exit(0);
  }

  if (subcmd === "stop-ack") {
    const mismatch = matchWorkerIdentity(
      { run_id: targetRunId, pass_id: pass.pass_id, attempt_id: attemptId, worker_id: workerId },
      { run_id: state.run_id, pass_id: pass.pass_id, attempt_id: pass.attempt_id, worker_id: pass.worker?.id }
    );
    if (mismatch) {
      console.log(`REFUSED: ${mismatch}`);
      process.exit(1);
    }

    pass.status = "stopped";
    const otherActive = (state.passes || []).some(p => p.n !== passNum && (isRunningStatus(p.status) || p.status === "stop-requested" || p.status === "launch-requested"));
    if (!otherActive) {
      state.ended = `${stamp()} — stopped by host acknowledgement`;

      // D7: this run's own ACTIVE.d entry always; the legacy ACTIVE only when it names this run
      // (an empty legacy ACTIVE names no run, so it is cleared too, as before).
      releaseMarkers(state.run_id);
      const legacyActive = path.join(ONEGO, "ACTIVE");
      if (fs.existsSync(legacyActive) && !(readText(legacyActive) || "").trim()) {
        try { fs.unlinkSync(legacyActive); } catch {}
      }

      const lockPath = path.join(ONEGO, "COMMIT.lock");
      if (fs.existsSync(lockPath)) {
        let lockOwner = "";
        try { lockOwner = fs.readFileSync(lockPath, "utf-8").trim(); } catch {}
        if (lockOwner === `owner: ${state.run_id}` || lockOwner === `owner:${state.run_id}` || lockOwner === state.run_id || lockOwner.includes(state.run_id)) {
          try { fs.unlinkSync(lockPath); } catch {}
        }
      }

      const releasedClaims = releaseClaims(new Set(), slug, state.run_id, "stopped by host acknowledgement", { config });
      const reportText = formatReport(state, state.run_id, slug, (tasks[slug] && tasks[slug].display) || slug, "Stopped by host acknowledgement", releasedClaims);
      writeFileAtomic(path.join(runDir, "report.md"), reportText);
    }

    writeJSONAtomic(statePath, state);
    console.log(`Worker \`${workerId}\` stop-ack recorded for pass ${passNum} (stopped)`);
    process.exit(0);
  }

  console.log(`Unknown worker subcommand "${subcmd}".`);
  process.exit(1);
}
