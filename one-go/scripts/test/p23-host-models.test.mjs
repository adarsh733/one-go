// p23-host-models.test.mjs — a model per tier on every tool (item G): start prints the
// tier-to-model map and WARNING lines, every brief states the model it was meant to run on and
// asks the worker to name the one it ran on, the run report shows both, and HOSTS.md is one
// rulebook table. Model ids here are made up — real ones live only in a project's config.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeSandbox, runBoard } from "./helpers.mjs";
import {
  tierModelMap, modelFormProblem, meantModelLine, routeFor, HOST_MODEL_FORMS, NOT_NAMED, TOOL_OWN_MODEL
} from "../lib/route.mjs";
import { modelCell } from "../lib/report.mjs";
import { REPORT_TEMPLATE } from "../cmd/brief.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL = path.join(HERE, "..", "..");
const SLUG = "demo-job";

function setConfig(sb, cfg) { fs.writeFileSync(path.join(sb.onegoDir, "config.json"), JSON.stringify(cfg)); }
function seedPlan(sb, model = "build") {
  fs.mkdirSync(path.join(sb.root, "out"), { recursive: true });
  const plan = {
    schema: 1, plan_id: `plan-${SLUG}`, plan_revision: 1,
    passes: [
      { n: 1, purpose: "Write the report", writes: ["out/a.txt"], route: { requested_model: model },
        required_check: { command: "node -e \"process.exit(0)\"" } }
    ]
  };
  fs.writeFileSync(path.join(sb.plansDir, `${SLUG}.plan.json`), JSON.stringify(plan, null, 2));
  const b = JSON.parse(fs.readFileSync(sb.boardPath, "utf8"));
  b.tasks[SLUG] = { display: "Demo Job", stage: "waiting" };
  fs.writeFileSync(sb.boardPath, JSON.stringify(b, null, 2));
}

// ---------------------------------------------------------------- the map

test("claude's built-in map is one line per tier, with no warning", () => {
  const { lines, warnings } = tierModelMap({}, "claude");
  assert.deepEqual(lines, ["think → opus", "build → sonnet", "mechanical → haiku"]);
  assert.deepEqual(warnings, []);
});

test("a host with no model named says so per tier and warns once", () => {
  const { lines, warnings } = tierModelMap({}, "codex");
  assert.equal(NOT_NAMED, "not named — inherits the main model");
  assert.deepEqual(lines, [`think → ${NOT_NAMED}`, `build → ${NOT_NAMED}`, `mechanical → ${NOT_NAMED}`]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^WARNING: no tier names a model for host "codex"/);
  // a <placeholder> names no model either
  const ph = tierModelMap({ hosts: { codex: { think: "<model slug>", build: "<model slug>", mechanical: "<model slug>" } } }, "codex");
  assert.match(ph.warnings[0], /^WARNING: no tier names a model/);
});

test("every tier on the same model warns that the tiers make no difference", () => {
  const cfg = { hosts: { codex: { think: "zz-one-1", build: "zz-one-1", mechanical: "zz-one-1" } } };
  const { warnings } = tierModelMap(cfg, "codex");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^WARNING: every tier resolves to the same model \(zz-one-1\)/);
  // three different models: quiet
  const ok = { hosts: { codex: { think: "zz-a-1", build: "zz-b-1", mechanical: "zz-c-1" } } };
  assert.deepEqual(tierModelMap(ok, "codex").warnings, []);
});

test("a named model not in the form the tool accepts gets a WARNING line", () => {
  const cfg = { hosts: { codex: { think: "Zz 9 Big", build: "zz-b-1", mechanical: "zz-c-1" } } };
  const { lines, warnings } = tierModelMap(cfg, "codex");
  assert.equal(lines[0], "think → Zz 9 Big");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^WARNING: "Zz 9 Big" is not in the form codex accepts/);
  // opencode wants provider/model
  assert.equal(modelFormProblem("opencode", "prov/zz-model"), null);
  assert.match(modelFormProblem("opencode", "zz-model"), /provider\/model/);
  // antigravity takes only its three words
  for (const ok of ["flash_lite", "flash", "pro"]) assert.equal(modelFormProblem("antigravity", ok), null, ok);
  assert.match(modelFormProblem("antigravity", "Zz Flash"), /flash_lite, flash or pro/);
  // claude: an alias or id with no spaces
  assert.equal(modelFormProblem("claude", "opus"), null);
  assert.ok(modelFormProblem("claude", "Big Model"));
  // a host the engine has no shape for, or an unset value, is never flagged
  assert.equal(modelFormProblem("brandnew", "Any Thing"), null);
  assert.equal(modelFormProblem("codex", "<model slug>"), null);
  assert.deepEqual(Object.keys(HOST_MODEL_FORMS).sort(), ["antigravity", "claude", "codex", "opencode"]);
});

test("a model a pass names itself is form-checked too; inline carries no warning", () => {
  const cfg = { hosts: { codex: { think: "zz-a-1", build: "zz-b-1", mechanical: "zz-c-1" } } };
  const { warnings } = tierModelMap(cfg, "codex", { extraModels: ["Odd Name 2"] });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /"Odd Name 2"/);
  const inline = tierModelMap({}, "inline");
  assert.deepEqual(inline.warnings, []);
  assert.match(inline.lines[0], /^think → advice only/);
});

// ---------------------------------------------------------------- start prints it

test("start prints the tier-to-model map and the WARNING lines, and still starts", () => {
  const sb = makeSandbox();
  try {
    seedPlan(sb);
    setConfig(sb, { hosts: { codex: { think: "Zz 9 Big", build: "Zz 9 Big", mechanical: "Zz 9 Big" } } });
    const r = runBoard(["start", SLUG, "--host", "codex"], sb.root);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /Models on codex/);
    assert.match(r.stdout, /- think → Zz 9 Big/);
    assert.match(r.stdout, /- build → Zz 9 Big/);
    assert.match(r.stdout, /- mechanical → Zz 9 Big/);
    assert.match(r.stdout, /^WARNING: every tier resolves to the same model/m);
    assert.match(r.stdout, /^WARNING: "Zz 9 Big" is not in the form codex accepts/m);
  } finally { sb.teardown(); }
});

test("start on claude with the built-in aliases prints the map and no WARNING", () => {
  const sb = makeSandbox();
  try {
    seedPlan(sb);
    const r = runBoard(["start", SLUG], sb.root);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /- think → opus\n- build → sonnet\n- mechanical → haiku/);
    assert.doesNotMatch(r.stdout, /WARNING:/);
  } finally { sb.teardown(); }
});

// ---------------------------------------------------------------- the brief states it

test("every brief states the model it was meant to run on and asks for the one it ran on", () => {
  const sb = makeSandbox();
  try {
    seedPlan(sb);
    fs.writeFileSync(path.join(sb.plansDir, `${SLUG}.md`), "# Demo job\nState: sealed 2026-10-03\n");
    // no run yet: worked out the way start would
    const before = runBoard(["brief", SLUG, "1"], sb.root);
    assert.equal(before.code, 0, before.stdout);
    assert.match(before.stdout, /## Model this pass was meant to run on\nclaude · build · sonnet\n/);
    assert.match(before.stdout, /Name the model you actually ran on/);
    assert.match(before.stdout, /Ran on:/);

    // a run on codex: the brief reads the run's own record
    setConfig(sb, { hosts: { codex: { build: "zz-build-2" } } });
    assert.equal(runBoard(["start", SLUG, "--host", "codex"], sb.root).code, 0);
    const during = runBoard(["brief", SLUG, "1"], sb.root);
    assert.match(during.stdout, /## Model this pass was meant to run on\ncodex · build · zz-build-2\n/);

    // a host with no model for the tier says so
    const opencode = runBoard(["brief", SLUG, "1", "--host", "opencode"], sb.root);
    assert.match(opencode.stdout, new RegExp(`opencode · build · ${NOT_NAMED}`));
  } finally { sb.teardown(); }
  const budget = REPORT_TEMPLATE.slice(1).reduce((sum, l) => sum + Number((l.match(/\((?:max )?(\d+) lines?\)/) || [0, 0])[1]), 0);
  assert.equal(budget, 12, "the report template still adds up to 12 lines");
  assert.ok(REPORT_TEMPLATE.some(l => /Protocols run:.*Ran on:/.test(l)));
});

test("meantModelLine reads host · tier · model", () => {
  const r = routeFor({ n: 1, model: "think", files: ["a"] }, { host: "codex", config: { hosts: { codex: { think: "zz-t-1" } } } });
  assert.equal(meantModelLine(r), "codex · think · zz-t-1");
  const none = routeFor({ n: 1, model: "think", files: ["a"] }, { host: "codex", config: {} });
  assert.equal(none.model, TOOL_OWN_MODEL);
  assert.equal(meantModelLine(none), `codex · think · ${NOT_NAMED}`);
  assert.match(meantModelLine({ ...none, host: "inline" }), /^inline · think · advice only/);
});

// ---------------------------------------------------------------- the run report shows it

test("the run report's Model cell shows the model meant and the model ran", () => {
  const route = { host: "codex", tier: "build", model: "zz-build-2", named: true, confirmed: null };
  assert.equal(modelCell({ route }), "meant: codex · zz-build-2 · ran: not reported");
  assert.equal(modelCell({ route, worker: { actual_model: "zz-build-2" } }), "meant: codex · zz-build-2 · ran: zz-build-2");
  assert.equal(modelCell({ route: { ...route, confirmed: "agent-tool:sonnet" } }), "meant: codex · zz-build-2 · ran: agent-tool:sonnet");
  assert.equal(modelCell({ route: { host: "codex", tier: "build", model: TOOL_OWN_MODEL } }), `meant: codex · ${NOT_NAMED} · ran: not reported`);
  assert.equal(modelCell({ model: "old-word" }), "old-word", "an old run with no route shows what it recorded");
});

// ---------------------------------------------------------------- HOSTS.md is one rulebook

test("HOSTS.md carries one rulebook table with a row per tool", () => {
  const text = fs.readFileSync(path.join(SKILL, "reference", "HOSTS.md"), "utf8");
  assert.match(text, /## The rulebook — one row per tool/);
  const header = text.split("\n").find(l => /^\| Tool \(host\) \|/.test(l));
  assert.ok(header, "the rulebook header row");
  assert.match(header, /How a helper starts/);
  assert.match(header, /How a tier becomes a model/);
  assert.match(header, /When the tier has no model/);
  for (const host of ["claude", "codex", "opencode", "antigravity", "inline"]) {
    assert.ok(text.split("\n").some(l => l.startsWith(`| \`${host}\``)), `row for ${host}`);
  }
  assert.match(text, /codex exec/);
  assert.match(text, /opencode run/);
  assert.match(text, /-m <provider\/model>/);
  assert.match(text, /not named — inherits the main model/);
});
