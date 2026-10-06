// cmd/help.mjs — `/one-go help` (also `--help`, `-h`): print reference/HELP.md exactly as written.
// Reads nothing else — no board, no config — so help works even in a folder with no board.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readText } from "../lib/util.mjs";

/** The cheat sheet that ships with this skill: <skill>/reference/HELP.md. */
export const HELP_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "reference", "HELP.md");

export function runHelp(helpPath = HELP_PATH) {
  const helpText = readText(typeof helpPath === "string" ? helpPath : HELP_PATH);
  if (helpText) {
    console.log(helpText.trim());
    process.exit(0);
  }
  console.log("Help file not found at " + helpPath);
  process.exit(1);
}
