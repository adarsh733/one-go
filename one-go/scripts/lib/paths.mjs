// lib/paths.mjs — workspace resolution.
//
// The skill is global; the board is per project. Find the project by walking up from wherever
// the command was run: the first folder holding `.claude/one-go/board.json` wins, then the first
// holding `.claude/one-go/`, then the first holding `.claude/`, then the current folder.
// ONEGO_ROOT overrides everything (tests and the compatibility pass point it at copies).
import fs from "node:fs";
import path from "node:path";

export function findRoot() {
  if (process.env.ONEGO_ROOT) return path.resolve(process.env.ONEGO_ROOT);
  let dir = process.cwd();
  let hasOneGo = null, hasClaude = null;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, ".claude", "one-go", "board.json"))) return dir;
    if (!hasOneGo && fs.existsSync(path.join(dir, ".claude", "one-go"))) hasOneGo = dir;
    if (!hasClaude && fs.existsSync(path.join(dir, ".claude"))) hasClaude = dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return hasOneGo || hasClaude || process.cwd();
}

export const ROOT = findRoot();
export const ONEGO = path.join(ROOT, ".claude", "one-go");
export const BOARD_PATH = path.join(ONEGO, "board.json");
