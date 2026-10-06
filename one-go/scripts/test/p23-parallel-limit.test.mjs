// p23-parallel-limit.test.mjs — the at-once setting `parallel_limit` (item D): unset means "as many
// as the waves allow" up to a safety ceiling of 8; a project may set a whole number 1 to 16.
// Order: --parallel N on start, then the stopped run's own value on resume, then config, then 8.
// Old run states keep the number they recorded. Sandbox only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeSandbox, runBoard } from "./helpers.mjs";
import {
  validateConfig, ConfigError, DEFAULT_CONFIG, resolveParallelLimit, parallelValue,
  PARALLEL_CEILING, PARALLEL_MIN, PARALLEL_MAX
} from "../lib/config.mjs";

const SLUG = "demo-job";

function setConfig(sb, cfg) { fs.writeFileSync(path.join(sb.onegoDir, "config.json"), JSON.stringify(cfg)); }
function seedPlan(sb) {
  fs.mkdirSync(path.join(sb.root, "out"), { recursive: true });
  const plan = {
    schema: 1, plan_id: `plan-${SLUG}`, plan_revision: 1,
    passes: [1, 2, 3].map(n => ({
      n, purpose: `Write part ${n}`, writes: [`out/${n}.txt`], route: { requested_model: "build" },
      required_check: { command: "node -e \"process.exit(0)\"" }
    }))
  };
  fs.writeFileSync(path.join(sb.plansDir, `${SLUG}.plan.json`), JSON.stringify(plan, null, 2));
  const b = JSON.parse(fs.readFileSync(sb.boardPath, "utf8"));
  b.tasks[SLUG] = { display: "Demo Job", stage: "waiting" };
  fs.writeFileSync(sb.boardPath, JSON.stringify(b, null, 2));
}
function runDirs(sb) { return fs.readdirSync(sb.onegoDir).filter(d => d.endsWith(`-${SLUG}`)).sort(); }
function newestState(sb) {
  const dirs = runDirs(sb);
  assert.ok(dirs.length, "a run folder was written");
  return JSON.parse(fs.readFileSync(path.join(sb.onegoDir, dirs[dirs.length - 1], "state.json"), "utf8"));
}

// ---------------------------------------------------------------- the config key

test("parallel_limit is a known config key, unset by default", () => {
  assert.equal(DEFAULT_CONFIG.parallel_limit, null);
  const { config, warnings } = validateConfig({});
  assert.equal(config.parallel_limit, null);
  const set = validateConfig({ parallel_limit: 4 });
  assert.equal(set.config.parallel_limit, 4);
  assert.deepEqual(set.warnings, [], "not reported as an unknown key");
  assert.equal(validateConfig({ parallel_limit: null }).config.parallel_limit, null);
  assert.deepEqual(warnings, []);
  assert.equal(PARALLEL_CEILING, 8);
  assert.equal(PARALLEL_MIN, 1);
  assert.equal(PARALLEL_MAX, 16);
});

test("parallel_limit accepts 1 to 16 and refuses anything else, loudly", () => {
  for (const ok of [1, 8, 16]) assert.equal(validateConfig({ parallel_limit: ok }).config.parallel_limit, ok);
  for (const bad of [0, 17, -1, 2.5, "4", true, []]) {
    assert.throws(() => validateConfig({ parallel_limit: bad }), ConfigError, String(bad));
  }
  assert.throws(() => validateConfig({ parallel_limit: 20 }), /parallel_limit.*1 to 16/);
  assert.equal(parallelValue("6"), 6);
  assert.equal(parallelValue("x"), null);
  assert.equal(parallelValue(0), null);
});

// ---------------------------------------------------------------- the order

test("the order is --parallel, then the stopped run, then config, then 8", () => {
  const cfg = { parallel_limit: 5 };
  assert.deepEqual(resolveParallelLimit({ flag: "2", resumed: 3, config: cfg }), { limit: 2, source: "--parallel" });
  assert.deepEqual(resolveParallelLimit({ resumed: 3, config: cfg }), { limit: 3, source: "the stopped run" });
  assert.deepEqual(resolveParallelLimit({ config: cfg }), { limit: 5, source: "config" });
  assert.deepEqual(resolveParallelLimit({ config: {} }), { limit: 8, source: "default" });
  assert.deepEqual(resolveParallelLimit({}), { limit: 8, source: "default" });
  // an old run keeps the number it recorded, even one outside today's range
  assert.equal(resolveParallelLimit({ resumed: 20, config: cfg }).limit, 20);
  for (const bad of ["0", "17", "abc", "2.5"]) {
    assert.match(resolveParallelLimit({ flag: bad }).error, /--parallel must be a whole number from 1 to 16/);
  }
});

// ---------------------------------------------------------------- start reads it and prints it

test("start with nothing set records 8 and says where it came from", () => {
  const sb = makeSandbox();
  try {
    seedPlan(sb);
    const r = runBoard(["start", SLUG], sb.root);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(newestState(sb).parallel_limit, 8);
    assert.match(r.stdout, /At once\*\*: up to 8 \(from default\)/);
  } finally { sb.teardown(); }
});

test("start reads config.parallel_limit, and --parallel wins over it", () => {
  const sb = makeSandbox();
  try {
    seedPlan(sb);
    setConfig(sb, { parallel_limit: 2 });
    const r = runBoard(["start", SLUG], sb.root);
    assert.equal(r.code, 0, r.stdout);
    const st = newestState(sb);
    assert.equal(st.parallel_limit, 2);
    assert.match(r.stdout, /up to 2 \(from config\)/);
    assert.equal(st.passes.filter(p => p.status === "launch-requested" || /ready/.test(p.status)).length <= 2, true);
  } finally { sb.teardown(); }
  const sb2 = makeSandbox();
  try {
    seedPlan(sb2);
    setConfig(sb2, { parallel_limit: 2 });
    const r = runBoard(["start", SLUG, "--parallel", "5"], sb2.root);
    assert.equal(r.code, 0, r.stdout);
    assert.equal(newestState(sb2).parallel_limit, 5);
    assert.match(r.stdout, /up to 5 \(from --parallel\)/);
  } finally { sb2.teardown(); }
});

test("a bad --parallel is refused and nothing is written", () => {
  const sb = makeSandbox();
  try {
    seedPlan(sb);
    const r = runBoard(["start", SLUG, "--parallel", "40"], sb.root);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /--parallel must be a whole number from 1 to 16/);
    assert.match(r.stdout, /Nothing was written/);
    assert.equal(runDirs(sb).length, 0);
  } finally { sb.teardown(); }
});

test("a bad parallel_limit in config.json stops start before anything is written", () => {
  const sb = makeSandbox();
  try {
    seedPlan(sb);
    setConfig(sb, { parallel_limit: 99 });
    const r = runBoard(["start", SLUG], sb.root);
    assert.notEqual(r.code, 0, r.stdout);
    assert.match(r.stdout + r.stderr, /parallel_limit/);
    assert.equal(runDirs(sb).length, 0);
  } finally { sb.teardown(); }
});

test("resuming a stopped run keeps the number it recorded over config", () => {
  const sb = makeSandbox();
  try {
    seedPlan(sb);
    setConfig(sb, { parallel_limit: 6 });
    const first = runBoard(["start", SLUG, "--parallel", "3"], sb.root);
    assert.equal(first.code, 0, first.stdout);
    const dir = runDirs(sb).pop();
    const stateFile = path.join(sb.onegoDir, dir, "state.json");
    const st = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    st.ended = "2026-10-03 07:00 — stopped by the person";
    fs.writeFileSync(stateFile, JSON.stringify(st, null, 2));

    const again = runBoard(["start", SLUG], sb.root);
    assert.equal(again.code, 0, again.stdout);
    assert.match(again.stdout, /Resumed run/);
    assert.match(again.stdout, /up to 3 \(from the stopped run\)/);
    assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).parallel_limit, 3);
  } finally { sb.teardown(); }
});
