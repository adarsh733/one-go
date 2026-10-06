// scripts/test/helpers.mjs — sandbox harness for testing board.mjs without touching the real
// board. Builds a throwaway ONEGO_ROOT under the OS temp dir (board.json, plans/, one run
// folder) and runs board.mjs against it as a child process, so paths.mjs re-reads ONEGO_ROOT
// fresh every time (no module-cache bleed between calls). Never references the real
// `.claude/one-go/` path — isolation comes from ONEGO_ROOT always winning in findRoot().
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The engine entry point this harness drives.
export const BOARD_MJS = path.join(__dirname, "..", "board.mjs");

// Minimal valid board.json — schema 4, no tasks. Enough for every read command to run clean
// (loadBoard/gatherSources/renderBoard all tolerate an empty task set).
function seedBoard() {
  return { schema: 4, updated: "", rev: 0, tasks: {} };
}

// One finished run folder so scanRuns() (called unconditionally by board.mjs) has something
// real to walk, matching the "board.json, plans/, one run folder" shape the brief asks for.
function seedRun(onegoDir) {
  const runId = "2026-01-01-0000-sample-run";
  const runDir = path.join(onegoDir, runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, "state.json"),
    JSON.stringify({ slug: "sample-run", passes: [{ n: 1, status: "done" }] }, null, 2)
  );
  fs.writeFileSync(path.join(runDir, "heartbeat.txt"), "2026-01-01 00:00\n");
  fs.writeFileSync(path.join(runDir, "report.md"), "# sample run\ndone\n");
  return runId;
}

/**
 * Builds a throwaway board under the OS temp dir.
 * Returns { root, onegoDir, boardPath, plansDir, runId, teardown() }.
 * `root` is what to pass as ONEGO_ROOT to runBoard() — it is the project root, one level
 * above `.claude/one-go`, exactly like a real project root would be.
 */
export function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "one-go-test-"));
  const onegoDir = path.join(root, ".claude", "one-go");
  const plansDir = path.join(onegoDir, "plans");
  fs.mkdirSync(plansDir, { recursive: true });

  const boardPath = path.join(onegoDir, "board.json");
  fs.writeFileSync(boardPath, JSON.stringify(seedBoard(), null, 2));

  const runId = seedRun(onegoDir);

  function teardown() {
    fs.rmSync(root, { recursive: true, force: true });
  }

  return { root, onegoDir, boardPath, plansDir, runId, teardown };
}

/**
 * Runs `node board.mjs <args>` with ONEGO_ROOT pointed at `root`. Synchronous — these are
 * short-lived CLI invocations, not servers. Returns { stdout, stderr, code }.
 */
export function runBoard(args, root) {
  const env = { ...process.env, ONEGO_ROOT: root };
  const result = spawnSync(process.execPath, [BOARD_MJS, ...args], {
    env,
    encoding: "utf8",
    windowsHide: true
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    code: result.status
  };
}

/**
 * D7 (0107): Read the active run id from either ACTIVE.d/<run-id> or the legacy ACTIVE file.
 * Returns the run id string, or null if no run is active.
 * Works on both old runs (ACTIVE only) and new runs (ACTIVE.d/).
 */
export function activeRunId(onegoDir) {
  // Try ACTIVE.d/ first (new style — any file under ACTIVE.d/ is a live run marker)
  const activeD = path.join(onegoDir, "ACTIVE.d");
  if (fs.existsSync(activeD)) {
    const entries = fs.readdirSync(activeD, { withFileTypes: true });
    for (const e of entries) {
      if (e.isFile()) {
        const id = fs.readFileSync(path.join(activeD, e.name), "utf-8").trim();
        if (id && fs.existsSync(path.join(onegoDir, id, "state.json"))) return id;
      }
    }
  }
  // Fallback to legacy ACTIVE file (old style)
  const activeFile = path.join(onegoDir, "ACTIVE");
  if (fs.existsSync(activeFile)) {
    const id = fs.readFileSync(activeFile, "utf-8").trim();
    if (id && fs.existsSync(path.join(onegoDir, id, "state.json"))) return id;
  }
  return null;
}
