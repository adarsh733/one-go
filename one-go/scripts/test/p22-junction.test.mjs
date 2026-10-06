// p22-junction.test.mjs — the engine must run when reached through a junction or symlink.
// Claude reaches the skill as ~/.claude/skills/one-go, a junction to the real folder. A "was I
// run directly?" check that compares the typed path with the real path is false through that
// junction, so every command printed nothing and exited 0 (found 2026-09-29, right after the swap).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("board.mjs help prints through a junction to the skill folder", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "onego-junction-"));
  const link = path.join(dir, "one-go");
  fs.symlinkSync(SKILL, link, process.platform === "win32" ? "junction" : "dir");
  try {
    const r = spawnSync(process.execPath, [path.join(link, "scripts", "board.mjs"), "help"], { encoding: "utf8", cwd: dir });
    assert.equal(r.status, 0);
    assert.ok(r.stdout.trim().length > 0, "help printed nothing through the junction");
  } finally {
    fs.rmSync(link, { force: true, recursive: false });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
