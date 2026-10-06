// lib/task-verify.mjs — asks the independent task system, never the run's own say-so.
// TASK-ENF-001 stage 3.
//
// One-Go never imports the task system (it is a separate, not-always-present repo — "One-Go
// is global, that repo is not always present"). It shells out to the one public, frozen
// command instead: `node <repo>/scripts/task/cli.mjs status --task <id> --json`, which exits 0
// and prints `{ accepted: true, ... }` only on a genuine checker-issued result.
//
// A job is "configured" for verification when a task_id string is recorded for it (on the
// board.json task object, or copied into a run's state.json at `start` time — see cmd/start.mjs
// and cmd/capture.mjs). No job on this machine has one today, so every job in production takes
// the `configured: false` branch below — same behaviour as before this file existed, except it
// now says so out loud instead of staying silent about the gap.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const UNVERIFIED_NOTE =
  "unverified — no task record; this is a self-reported status, not a proven one";

// Looks for scripts/task/cli.mjs directly under `root`, and one level down (the real
// deployment has ONEGO_ROOT at the workspace root and the task system in a project folder
// below it, e.g. `<root>/<app-folder>/scripts/task/cli.mjs`). Project-agnostic on
// purpose — One-Go does not hard-code any project's folder name.
export function findTaskCli(root) {
  const direct = path.join(root, "scripts", "task", "cli.mjs");
  if (fs.existsSync(direct)) return direct;
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(root, entry.name, "scripts", "task", "cli.mjs");
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch { /* root unreadable — report not-found below */ }
  return null;
}

/**
 * @param {{ root: string, taskId: string | null | undefined }} args
 * @returns {{ configured: boolean, accepted?: boolean, reason?: string, error?: string }}
 *
 * configured=false  → no task_id was recorded for this job. Not an error — this is today's
 *                      normal, unconfigured state. Callers must keep working exactly as they
 *                      did before this file existed, but must say so plainly (UNVERIFIED_NOTE).
 * configured=true   → a task_id was recorded. `accepted` is the trusted verdict; when it is
 *                      false, `reason` names why (a bad --task id, a missing CLI, a genuine
 *                      NOT ACCEPTED from the checker — all fail closed the same way).
 */
export function verifyTask({ root, taskId }) {
  if (!taskId) return { configured: false };

  const cli = findTaskCli(root);
  if (!cli) {
    return {
      configured: true,
      accepted: false,
      reason: `task system not found under "${root}" (looked for scripts/task/cli.mjs) — cannot verify task "${taskId}"`,
      error: "cli-missing"
    };
  }

  let stdout = "";
  try {
    stdout = execFileSync(process.execPath, [cli, "status", "--task", taskId, "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      cwd: root
    });
  } catch (e) {
    // `status` exits 1 on a genuine NOT ACCEPTED — that is still valid JSON on stdout, not a
    // failure to run. Only treat it as a run failure when there is no stdout to parse at all.
    stdout = (e && e.stdout) || "";
    if (!stdout.trim()) {
      const firstLine = String((e && (e.stderr || e.message)) || "unknown error").split("\n")[0];
      return { configured: true, accepted: false, reason: `task verifier failed to run: ${firstLine}`, error: "cli-error" };
    }
  }

  let verdict;
  try {
    verdict = JSON.parse(stdout);
  } catch {
    return { configured: true, accepted: false, reason: "task verifier returned output that could not be parsed as JSON", error: "bad-json" };
  }

  return {
    configured: true,
    accepted: verdict && verdict.accepted === true,
    reason: (verdict && verdict.reason) || "(no reason given)"
  };
}

// Resolves the task_id a job (and, if a run is live, its state.json) should be verified
// against. state.task_id wins when present, so a run stays pinned to whatever was configured
// at `start` time even if board.json changes under it later.
export function resolveTaskId({ task, state }) {
  if (state && state.task_id) return state.task_id;
  if (task && task.task_id) return task.task_id;
  return null;
}
