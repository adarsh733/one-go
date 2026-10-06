// p23-seal-waves.test.mjs — proves the seal brief asks for width (item A) and states the
// handoff rule: a mandatory `## Run shape` section, waits only on real need, the summary line,
// the handoff line, and the whole-app words rule (read from the "Proven by" command only).
// Calls buildSealBrief directly; no board, no files written.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSealBrief } from "../cmd/dispatch-seal.mjs";

const brief = buildSealBrief({
  slug: "wide-job",
  text: "build the home and settings screens",
  named: [],
  planPath: "/tmp/plans/wide-job.md",
  boardCmd: 'node "board.mjs"',
  root: "/tmp/proj",
  config: {},
  house: {}
});

function section(text, heading) {
  const i = text.indexOf(heading);
  assert.ok(i >= 0, `missing ${heading}`);
  const rest = text.slice(i + heading.length);
  const j = rest.search(/\n## /);
  return j < 0 ? rest : rest.slice(0, j);
}

test("the plan template has ## Run shape before ## Passes, with five bullets in order", () => {
  const tpl = brief.split("## The plan file")[1].split("\n## Models")[0];
  const shape = tpl.indexOf("## Run shape");
  const passes = tpl.indexOf("## Passes");
  assert.ok(shape >= 0 && passes >= 0 && shape < passes, "Run shape comes before Passes");
  const body = tpl.slice(shape, passes);
  const labels = ["**Pieces:**", "**Needs:**", "**Waves line:**", "**Unlocks:**", "**Summary line:**"];
  let at = -1;
  for (const l of labels) {
    const k = body.indexOf(l);
    assert.ok(k > at, `${l} present and in order`);
    at = k;
  }
  assert.match(body, /Waves: 1\) p1, p2, p3 · 2\) p4/);
  assert.match(body, /\b\d+ passes in \d+ waves\b/);
});

test("the Run shape instruction is mandatory and gives the shape: independent first, wire, one check, fix", () => {
  const s = section(brief, "## Run shape — plan the width before the table (mandatory)");
  assert.match(s, /mandatory|must carry/);
  assert.match(s, /build every independent piece/i);
  assert.match(s, /wire/);
  assert.match(s, /end-to-end check/);
  assert.match(s, /fix what it finds/);
  assert.match(s, /wait on another only when it needs that pass's output/);
  assert.match(s, /engine finds file clashes itself/);
  assert.match(s, /small first pass/);
  assert.match(s, /splitting a shared file or fixing shared names/);
  assert.match(s, /`N passes in M waves`/);
});

test("a pass list in a handoff or pasted note is input, re-shaped, with the X-to-N line", () => {
  assert.match(brief, /handoff or a pasted note already lists passes, that list is INPUT, never the plan/);
  assert.match(brief, /the handoff had X passes in Y waves → this plan has N in M/);
});

test("the whole-app words line is the fixed list, read from the Proven by command only", () => {
  const gate = brief.split("## The seal gate")[1].split("\n## ")[0];
  for (const w of ["capture", "screenshot", "shoot", "review-page", "journey"]) assert.ok(gate.includes(w), w);
  assert.match(gate, /"Proven by" command only, never from the description/);
  assert.match(gate, /runs only when no other pass is still writing/);
  // the old, wider list and its "run alone" rule are gone
  assert.doesNotMatch(brief, /capture, screenshot, shoot, shot, journey, match or review-page/);
  assert.doesNotMatch(gate, /\bshot\b|\bmatch\b/);
  assert.doesNotMatch(brief, /make it run\s+alone/);
});

test("the seal gate says a plan with no Run shape is refused", () => {
  assert.match(brief, /plan without one is refused/);
});
