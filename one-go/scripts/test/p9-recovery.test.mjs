// p9-recovery.test.mjs — carried over from the old skill's test/recovery.test.mjs (ported,
// generic). "Nothing stays a zombie."
//
// Covers, all against throwaway sandboxes via helpers.mjs (never a real project's own
// `.claude/one-go/`):
//   - start.mjs writes LIVE.json {pid, host, started} and a conductor_last_seen field on
//     state.json distinct from heartbeat.
//   - revive.mjs's "killed" vs "stalled" call, using LIVE.json's pid + conductor_last_seen,
//     not heartbeat age alone.
//   - the `revive --apply` bug: no run number used to silently print the list and exit 0
//     (obs 0063 — already fixed; see also p9-frontdoor.test.mjs's "every flag acts or refuses").
//   - lib/claims.mjs, reading through a CONFIGURED claims_file (config.json), not a hard-coded
//     project folder name: every `## Active claims` section is scanned, not just the first.
//   - lib/claims.mjs expireClaims(), wired ONLY through `revive --tidy` / `resume --tidy`.
//   - board-table.mjs's second warning line for a sealed-but-never-launched job.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeSandbox, runBoard } from "./helpers.mjs";

function seedSealedPlan(sandbox, slug, passes) {
  const plan = {
    schema: 1,
    plan_id: `plan-${slug}`,
    plan_revision: 1,
    task_id: slug,
    passes: passes || [
      { n: 1, purpose: "Do the thing", writes: ["a.txt"], reads: [], prerequisites: [] }
    ]
  };
  const p = path.join(sandbox.plansDir, `${slug}.plan.json`);
  fs.writeFileSync(p, JSON.stringify(plan, null, 2));
  return p;
}

function seedTask(sandbox, slug, display) {
  const board = JSON.parse(fs.readFileSync(sandbox.boardPath, "utf8"));
  board.tasks[slug] = {
    display, what: display, stage: "not_started", source: "test",
    pending_questions: 0, next_move: "", blocked_reason: null, subtasks: []
  };
  fs.writeFileSync(sandbox.boardPath, JSON.stringify(board, null, 2));
}

function nowStamp() {
  const d = new Date();
  const p2 = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
const OLD_STAMP = "2020-01-01 00:00"; // always far more than 45m/12h/24h old

/** Manually build a run folder — bypasses `start` entirely, for tests that need a specific,
 * possibly pre-LIVE.json, shape. */
function seedManualRun(sandbox, runId, { slug, passes, heartbeat, live, active = true }) {
  const runDir = path.join(sandbox.onegoDir, runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "state.json"), JSON.stringify({
    slug, started: OLD_STAMP, passes: passes || [], schema: 3
  }, null, 2));
  if (heartbeat !== undefined) fs.writeFileSync(path.join(runDir, "heartbeat.txt"), heartbeat + "\n");
  if (live) fs.writeFileSync(path.join(runDir, "LIVE.json"), JSON.stringify(live, null, 2));
  if (active) fs.writeFileSync(path.join(sandbox.onegoDir, "ACTIVE"), runId + "\n");
  return runDir;
}

/** Writes a configured claims board (config.json `claims_file`) at an arbitrary path under the
 * sandbox root — NOT a hard-coded project folder name, matching how a real project's config.json
 * points at its own board (§2 of dev/CONTRACT.md). */
function seedClaimsConfig(sandbox, relPath, text) {
  const claimsPath = path.join(sandbox.root, relPath);
  fs.mkdirSync(path.dirname(claimsPath), { recursive: true });
  fs.writeFileSync(claimsPath, text);
  fs.writeFileSync(path.join(sandbox.onegoDir, "config.json"), JSON.stringify({ claims_file: relPath.replace(/\\/g, "/") }));
  return claimsPath;
}

// ---------------------------------------------------------------- start.mjs: LIVE.json + conductor_last_seen

test("start writes LIVE.json {pid, host, started} and a conductor_last_seen distinct from heartbeat", () => {
  const sandbox = makeSandbox();
  try {
    seedTask(sandbox, "test-job", "Test Job");
    seedSealedPlan(sandbox, "test-job");

    const { code, stdout } = runBoard(["start", "test-job"], sandbox.root);
    assert.equal(code, 0, stdout);

    const runId = fs.readFileSync(path.join(sandbox.onegoDir, "ACTIVE"), "utf8").trim();
    const runDir = path.join(sandbox.onegoDir, runId);

    const live = JSON.parse(fs.readFileSync(path.join(runDir, "LIVE.json"), "utf8"));
    assert.equal(typeof live.pid, "number");
    assert.ok(live.pid > 0);
    assert.equal(live.host, "claude");
    assert.equal(typeof live.started, "string");
    assert.ok(live.started.length > 0);

    const state = JSON.parse(fs.readFileSync(path.join(runDir, "state.json"), "utf8"));
    assert.ok("heartbeat" in state, "state.json should still carry heartbeat");
    assert.ok("conductor_last_seen" in state, "state.json should carry conductor_last_seen");
    assert.equal(typeof state.conductor_last_seen, "string");
  } finally {
    sandbox.teardown();
  }
});

// ---------------------------------------------------------------- revive: killed vs stalled, and the --apply bug

test("revive --apply with no run number refuses and writes nothing (obs 0063, confirmed fixed)", () => {
  const sandbox = makeSandbox();
  try {
    const before = fs.readFileSync(sandbox.boardPath, "utf8");
    const { code, stdout } = runBoard(["revive", "--apply"], sandbox.root);
    assert.equal(code, 1, stdout);
    assert.match(stdout, /will not guess/i);
    assert.match(stdout, /Nothing was written/i);
    assert.equal(fs.readFileSync(sandbox.boardPath, "utf8"), before);
  } finally {
    sandbox.teardown();
  }
});

test("revive <n> --apply still works: a run with NO LIVE.json is reported and demoted as killed", () => {
  const sandbox = makeSandbox();
  try {
    seedManualRun(sandbox, "2026-02-01-0100-ghost-job", {
      slug: "ghost-job",
      passes: [{ n: 1, title: "Do it", status: "running", files: [] }],
      heartbeat: OLD_STAMP
      // no `live` — simulates a run whose LIVE.json is gone.
    });

    const list = runBoard(["revive"], sandbox.root);
    assert.equal(list.code, 0, list.stdout);
    // Scope to the per-run listing, not the legend below it (which always names both words).
    const runLine = list.stdout.split("🔴 killed mid-flight —")[0];
    assert.match(runLine, /killed mid-flight/);
    assert.doesNotMatch(runLine, /conductor may still be alive/);

    const applied = runBoard(["revive", "1", "--apply"], sandbox.root);
    assert.equal(applied.code, 0, applied.stdout);

    const state = JSON.parse(fs.readFileSync(
      path.join(sandbox.onegoDir, "2026-02-01-0100-ghost-job", "state.json"), "utf8"));
    assert.equal(state.passes[0].status, "crashed");
    assert.match(state.passes[0].crash_reason, /conductor confirmed gone/);
  } finally {
    sandbox.teardown();
  }
});

test("revive: a live pid + recent conductor_last_seen reports stalled, not killed", () => {
  const sandbox = makeSandbox();
  try {
    seedManualRun(sandbox, "2026-02-01-0200-slow-job", {
      slug: "slow-job",
      passes: [{ n: 1, title: "Do it", status: "running", files: [] }],
      heartbeat: OLD_STAMP, // stale beat -> still a zombie CANDIDATE
      live: { pid: process.pid, host: "claude", started: OLD_STAMP } // but the pid IS alive
    });
    // conductor_last_seen recent -> the second half of "killed" is false too.
    const statePath = path.join(sandbox.onegoDir, "2026-02-01-0200-slow-job", "state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    state.conductor_last_seen = nowStamp();
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

    const list = runBoard(["revive"], sandbox.root);
    assert.equal(list.code, 0, list.stdout);
    const runLine = list.stdout.split("🔴 killed mid-flight —")[0];
    assert.match(runLine, /stalled.*conductor may still be alive/);
    assert.doesNotMatch(runLine, /killed mid-flight/);

    const applied = runBoard(["revive", "1", "--apply"], sandbox.root);
    assert.equal(applied.code, 0, applied.stdout);
    const after = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(after.passes[0].status, "crashed");
    assert.match(after.passes[0].crash_reason, /liveness unconfirmed/);
  } finally {
    sandbox.teardown();
  }
});

// ---------------------------------------------------------------- lib/claims.mjs, through a CONFIGURED board

test("watchdog releases claims from the CONFIGURED claims board, across every Active-claims section", () => {
  const sandbox = makeSandbox();
  try {
    // No hard-coded project folder name — the board lives wherever config.json's `claims_file`
    // says (dev/CONTRACT.md §2). Two `## Active claims` sections, one unrelated section between
    // them, to prove every section is scanned (not just the first).
    const realBefore = [
      "# ACTIVE WORK",
      "",
      "## Active claims",
      "",
      "| Claim ID | Owner | Status | Started | Heartbeat | Files / globs |",
      "|---|---|---|---|---|---|",
      "| onego-test-job-c1 | Claude | running | 2026-01-01 00:00 | 2026-01-01 00:00 | a.txt |",
      "| some-other-claim | Someone | running | 2026-01-01 00:00 | 2026-01-01 00:00 | z.txt |",
      "",
      "## Some unrelated section",
      "",
      "not a claims table",
      "",
      "## Active claims",
      "",
      "| Claim ID | Owner | Status | Started | Heartbeat | Files / globs |",
      "|---|---|---|---|---|---|",
      "| onego-test-job-c2 | Claude | running | 2026-01-01 00:00 | 2026-01-01 00:00 | b.txt |",
      "",
      "## Recently released",
      "",
      ""
    ].join("\n");
    const claimsPath = seedClaimsConfig(sandbox, path.join("project", ".claude", "ACTIVE-WORK.md"), realBefore);

    seedManualRun(sandbox, "2026-01-01-0000-test-job", {
      slug: "test-job", passes: [], heartbeat: OLD_STAMP
    });
    fs.writeFileSync(path.join(sandbox.onegoDir, "2026-01-01-0000-test-job", "STOP"), "test halt\n");

    const { code } = runBoard(["watchdog"], sandbox.root);
    assert.equal(code, 0);

    const realAfter = fs.readFileSync(claimsPath, "utf8");
    assert.ok(!realAfter.split("## Recently released")[0].includes("onego-test-job-c1"),
      "c1 (first Active-claims section) should be removed");
    assert.ok(!realAfter.split("## Recently released")[0].includes("onego-test-job-c2"),
      "c2 (SECOND Active-claims section) should also be removed — every section is scanned");
    assert.match(realAfter, /some-other-claim/, "a non-matching row must survive untouched");
    assert.match(realAfter.split("## Recently released")[1] || "", /onego-test-job-c1/);
    assert.match(realAfter.split("## Recently released")[1] || "", /onego-test-job-c2/);
  } finally {
    sandbox.teardown();
  }
});

// ---------------------------------------------------------------- expireClaims, only via `revive --tidy`

test("revive --tidy expires a claim whose run has no LIVE.json and a >12h heartbeat, dry-run first", () => {
  const sandbox = makeSandbox();
  try {
    const before = [
      "# ACTIVE WORK",
      "",
      "## Active claims",
      "",
      "| Claim ID | Owner | Status | Started | Heartbeat | Files / globs |",
      "|---|---|---|---|---|---|",
      "| C-2026-01-01-0000-expired-claim-job-p1 | Claude | running | 2026-01-01 00:00 | 2026-01-01 00:00 | a.txt |",
      "| C-2026-01-01-0000-alive-claim-job-p1 | Claude | running | 2026-01-01 00:00 | 2026-01-01 00:00 | b.txt |",
      "",
      "## Recently released",
      "",
      ""
    ].join("\n");
    const claimsPath = seedClaimsConfig(sandbox, path.join("project", ".claude", "ACTIVE-WORK.md"), before);

    seedManualRun(sandbox, "2026-01-01-0000-expired-claim-job", {
      slug: "expired-claim-job", passes: [{ n: 1, status: "done" }], heartbeat: OLD_STAMP, active: false
    });
    seedManualRun(sandbox, "2026-01-01-0000-alive-claim-job", {
      slug: "alive-claim-job", passes: [{ n: 1, status: "done" }], heartbeat: OLD_STAMP,
      live: { pid: process.pid, host: "claude", started: OLD_STAMP }, active: false
    });

    const dry = runBoard(["revive", "--tidy"], sandbox.root);
    assert.equal(dry.code, 0, dry.stdout);
    assert.match(dry.stdout, /1 claim expired/);
    assert.match(dry.stdout, /would release/);
    assert.equal(fs.readFileSync(claimsPath, "utf8"), before, "dry run must change nothing");

    const applied = runBoard(["revive", "--tidy", "--apply"], sandbox.root);
    assert.equal(applied.code, 0, applied.stdout);
    assert.match(applied.stdout, /releasing/);

    const after = fs.readFileSync(claimsPath, "utf8");
    const [activeSection, releasedSection] = after.split("## Recently released");
    assert.ok(!activeSection.includes("expired-claim-job-p1"), "the dark claim should be gone from Active claims");
    assert.ok(activeSection.includes("alive-claim-job-p1"), "the live claim must NOT be expired");
    assert.match(releasedSection || "", /expired-claim-job-p1/);
    assert.match(releasedSection || "", /expired/);
  } finally {
    sandbox.teardown();
  }
});

// ---------------------------------------------------------------- board-table.mjs: sealed, never launched

test("board shows a second warning line for a sealed plan never launched after 24h, and excludes launched/fresh ones", () => {
  const sandbox = makeSandbox();
  try {
    const dayMs = 26 * 3600 * 1000;
    const old = new Date(Date.now() - dayMs);

    seedTask(sandbox, "never-launched-job", "Never Launched Job");
    const neverPlanPath = seedSealedPlan(sandbox, "never-launched-job");
    fs.utimesSync(neverPlanPath, old, old);

    seedTask(sandbox, "fresh-plan-job", "Fresh Plan Job");
    seedSealedPlan(sandbox, "fresh-plan-job"); // mtime left as "now" -> under 24h, must not trigger

    seedTask(sandbox, "already-started-job", "Already Started Job");
    const startedPlanPath = seedSealedPlan(sandbox, "already-started-job");
    fs.utimesSync(startedPlanPath, old, old);
    // A run folder naming this slug means `start` already ran for it — must not be flagged.
    seedManualRun(sandbox, "2026-01-01-0000-already-started-job", {
      slug: "already-started-job", passes: [{ n: 1, status: "done" }], heartbeat: OLD_STAMP, active: false
    });

    const { code, stdout } = runBoard([], sandbox.root);
    assert.equal(code, 0, stdout);
    assert.match(stdout, /⚠ 1 sealed, never launched/);
    assert.match(stdout, /never launched — \/one-go dispatch <job>/);
  } finally {
    sandbox.teardown();
  }
});
