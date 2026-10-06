// p2-claims.test.mjs — lib/claims.mjs: release, expire and ghost removal on a configured board,
// using the same header-driven reader as the board.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeSandbox } from "./helpers.mjs";

const sb = makeSandbox();
process.env.ONEGO_ROOT = sb.root;
const C = await import("../lib/claims.mjs");
const { readClaims } = await import("../lib/house.mjs");

test.after(() => sb.teardown());

const BOARD = path.join(sb.root, "code", ".claude", "claims.md");
const config = { claims_file: "code/.claude/claims.md" };
const seed = text => { fs.mkdirSync(path.dirname(BOARD), { recursive: true }); fs.writeFileSync(BOARD, text); };
const read = () => fs.readFileSync(BOARD, "utf8");

// Files in column 4, a second Active-claims block later in the file, one ghost.
const TEXT = [
  "# Claims", "", "## Active claims", "",
  "| Claim ID | Started | Task | Files | Status | Heartbeat |",
  "|---|---|---|---|---|---|",
  "| C-2026-01-01-0900-myjob-p1 | 09:00 | pass 1 | `a/**` | running | 09:00 |",
  "| C-other | 09:00 | other window | `b/**` | running | 09:00 |",
  "| C-ghost | 08:00 | done already | `c/**` | running | 08:00 |",
  "", "## Recently released", "",
  "- **C-ghost** released 2026-01-01 — finished",
  "", "## Active claims", "",
  "| Claim ID | Started | Task | Files | Status | Heartbeat |",
  "|---|---|---|---|---|---|",
  "| C-x-onego-myjob | 10:00 | second block | `d/**` | running | 10:00 |",
  ""
].join("\n");

test("claims off (no claims_file) = every function is a no-op", () => {
  seed(TEXT);
  assert.equal(C.resolveClaimsPath(sb.root, {}), null);
  assert.deepEqual(C.releaseClaims(new Set(["C-other"]), "x", "y", "why", { config: {} }), []);
  assert.deepEqual(C.expireClaims(sb.onegoDir, { dryRun: false, config: {} }), []);
  assert.deepEqual(C.removeGhostRows({ dryRun: false, config: {} }), { removed: [] });
  assert.equal(read(), TEXT);
});

test("resolveActiveWorkPath with no config.json = null (no guessed project folder)", () => {
  assert.equal(C.resolveActiveWorkPath(), null);
});

test("releaseClaims moves matching rows in every Active block into Recently released", () => {
  seed(TEXT);
  const ids = C.releaseClaims(new Set(), "myjob", "2026-01-01-0900-myjob", "finished clean", { config });
  assert.deepEqual(ids.sort(), ["C-2026-01-01-0900-myjob-p1", "C-x-onego-myjob"]);
  const after = read();
  assert.ok(!/^\| C-2026-01-01-0900-myjob-p1 /m.test(after));
  assert.ok(!/^\| C-x-onego-myjob /m.test(after));
  assert.match(after, /- \*\*C-2026-01-01-0900-myjob-p1\*\* released \d{4}-\d{2}-\d{2} — finished clean/);
  assert.ok(/^\| C-other /m.test(after), "another window's claim is untouched");
  assert.deepEqual(readClaims(sb.root, config).map(r => r.id), ["C-other"]);
});

test("removeGhostRows: dry run by default, then deletes only already-released rows", () => {
  seed(TEXT);
  assert.deepEqual(C.removeGhostRows({ config }), { removed: ["C-ghost"] });
  assert.equal(read(), TEXT, "dry run wrote nothing");
  assert.deepEqual(C.removeGhostRows({ dryRun: false, config }), { removed: ["C-ghost"] });
  const after = read();
  assert.ok(!/^\| C-ghost /m.test(after));
  assert.match(after, /- \*\*C-ghost\*\* released 2026-01-01/, "the release record stays");
  assert.deepEqual(C.removeGhostRows({ dryRun: false, config }), { removed: [] });
});

test("expireClaims: a dark run's claim expires; a ghost is not re-released", () => {
  const runId = "2026-01-01-0900-myjob";
  const runDir = path.join(sb.onegoDir, runId);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, "heartbeat.txt"), "2026-01-01 09:00\n");
  seed(TEXT);
  assert.deepEqual(C.expireClaims(sb.onegoDir, { dryRun: true, config }), ["C-2026-01-01-0900-myjob-p1"]);
  assert.equal(read(), TEXT);
  fs.writeFileSync(path.join(runDir, "LIVE.json"), "{}");
  assert.deepEqual(C.expireClaims(sb.onegoDir, { dryRun: true, config }), [], "a live conductor keeps it");
  fs.rmSync(path.join(runDir, "LIVE.json"));
  assert.deepEqual(C.expireClaims(sb.onegoDir, { dryRun: false, config }), ["C-2026-01-01-0900-myjob-p1"]);
  assert.match(read(), /C-2026-01-01-0900-myjob-p1\*\* released .* expired/);
});
