// p25-scout-docs.test.mjs — the scout docs (pass 25): model cards are named and explained in
// HOSTS.md with the exact warnings; CONDUCTOR.md says when to run board.mjs models; SKILL.md
// has the model card word row. Checks the live skill folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("HOSTS.md names model_cards, model_scout, \"auto\" and both exact warnings", () => {
  const hostsPath = path.join(SKILL_DIR, "..", "reference", "HOSTS.md");
  assert.ok(fs.existsSync(hostsPath), `HOSTS.md exists at ${hostsPath}`);
  const text = fs.readFileSync(hostsPath, "utf8");

  // Check for key concepts
  assert.match(text, /model.?card/i, "HOSTS.md must name model cards");
  assert.match(text, /model_scout/i, "HOSTS.md must name model_scout setting");
  assert.match(text, /"auto"/i, "HOSTS.md must mention \"auto\" tier value");

  // Check for the two exact warning lines (with partial matching to allow formatting variations)
  assert.match(text, /WARNING:.*is no longer in.*model list.*using.*for.*instead/, "first warning about missing model");
  assert.match(text, /WARNING:.*model cards are stale.*run board\.mjs models/, "second warning about stale cards");
});

test("HOSTS.md matches the code: stale cards never stop a run, pins judged by the tool's list", () => {
  const hostsPath = path.join(SKILL_DIR, "..", "reference", "HOSTS.md");
  const text = fs.readFileSync(hostsPath, "utf8");

  // Wording that was wrong must not come back.
  assert.doesNotMatch(text, /refuse to start/i, "stale cards never refuse to start a run");
  assert.doesNotMatch(text, /listed in the cards/i, "a pin is kept by the tool's own list, not the cards");

  // What the code does, stated.
  assert.match(text, /never stop a run/i, "must say stale cards never stop a run");
  assert.match(text, /refresh/i, "must name the dispatch refresh question");
  assert.match(text, /tool's own list/i, "must say a pin is kept while the tool's own list has it");
  assert.match(text, /claude.{0,12}pins? are always kept/i, "must say claude pins are always kept");
  assert.match(text, /ignores a card's age/i, "must say the picker ignores card age");
  assert.match(text, /--host a,b/, "must say --host a,b reads other tools");
  assert.match(text, /only the hosts that `config\.json` sets a tier for/i, "must say models with no --host lists only configured hosts");
});

test("CONDUCTOR.md names board.mjs models", () => {
  const conductorPath = path.join(SKILL_DIR, "..", "reference", "CONDUCTOR.md");
  assert.ok(fs.existsSync(conductorPath), `CONDUCTOR.md exists at ${conductorPath}`);
  const text = fs.readFileSync(conductorPath, "utf8");

  assert.match(text, /board\.mjs models/, "CONDUCTOR.md must name board.mjs models command");
  assert.match(text, /--check/, "CONDUCTOR.md must mention models --check flag");
});

test("SKILL.md has the model card word row in the words table", () => {
  const skillPath = path.join(SKILL_DIR, "..", "SKILL.md");
  assert.ok(fs.existsSync(skillPath), `SKILL.md exists at ${skillPath}`);
  const text = fs.readFileSync(skillPath, "utf8");

  // Look for model card row in the words table
  assert.match(text, /\|\s*\*\*model card\*\*\s*\|/i, "SKILL.md must have a 'model card' word row in the table");
});
