// p2-config.test.mjs — lib/config.mjs: generic defaults, loud errors, house paths.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeSandbox } from "./helpers.mjs";

const sb = makeSandbox();
process.env.ONEGO_ROOT = sb.root;
const { loadConfig, ConfigError, DEFAULT_CONFIG, configPath, resolveHousePath } = await import("../lib/config.mjs");

const write = obj => fs.writeFileSync(configPath(sb.root), typeof obj === "string" ? obj : JSON.stringify(obj));
const clear = () => fs.rmSync(configPath(sb.root), { force: true });

test.after(() => sb.teardown());

test("no config.json = the generic core, every project feature off", () => {
  clear();
  const c = loadConfig(sb.root);
  assert.equal(c.claims_file, null);
  assert.deepEqual(c.frozen_dirs, []);
  assert.equal(c.screen_gate, "off");
  assert.deepEqual(c.extra_sources, { open_loops: null, pending_push: null });
  assert.deepEqual(c.sweep_dirs, []);
  assert.equal(c.worklog, null);
  assert.equal(c.register_command, null);
  assert.deepEqual(c.worker_always_allowed, []);
  assert.deepEqual(c.report_extras, []);
  assert.deepEqual(c.warnings, []);
  assert.equal(DEFAULT_CONFIG.claims_file, null);
});

test("a valid config merges over the defaults and normalises screen_gate", () => {
  write({
    claims_file: "code/.claude/claims.md",
    frozen_dirs: ["docs/frozen"],
    screen_gate: true,
    extra_sources: { open_loops: "loops.md" },
    report_extras: [{ when: "screen_job", text: "check {slug}" }],
    tiers: { think: { label: "Big model" } },
    hosts: { other: { build: "m-2" } },
    _comment: "comments are fine"
  });
  const c = loadConfig(sb.root);
  assert.equal(c.claims_file, "code/.claude/claims.md");
  assert.deepEqual(c.frozen_dirs, ["docs/frozen"]);
  assert.equal(c.screen_gate, "on");
  assert.deepEqual(c.extra_sources, { open_loops: "loops.md", pending_push: null });
  assert.equal(c.tiers.think.label, "Big model");
  assert.equal(c.hosts.other.build, "m-2");
  assert.deepEqual(c.warnings, []);
  clear();
});

test("bad JSON is a loud ConfigError, never silent defaults", () => {
  write("{ claims_file: nope");
  assert.throws(() => loadConfig(sb.root), err => err instanceof ConfigError && /not valid JSON/.test(err.message));
  clear();
});

test("a key of the wrong type is a ConfigError naming the key", () => {
  for (const bad of [
    { claims_file: 42 },
    { frozen_dirs: "docs/frozen" },
    { screen_gate: "maybe" },
    { screen_slug_pattern: "([" },
    { extra_sources: [] },
    { report_extras: [{ when: "sometimes", text: "x" }] },
    { tiers: { think: "big" } },
    []
  ]) {
    write(bad);
    assert.throws(() => loadConfig(sb.root), ConfigError, JSON.stringify(bad));
  }
  clear();
});

test("hosts.<host>.requires_approval is kept (a boolean) and a non-boolean is refused", () => {
  write({ hosts: { antigravity: { build: "g-1", requires_approval: true }, other: { requires_approval: false } } });
  const c = loadConfig(sb.root);
  assert.equal(c.hosts.antigravity.requires_approval, true);
  assert.equal(c.hosts.antigravity.build, "g-1");
  assert.equal(c.hosts.other.requires_approval, false);
  assert.deepEqual(c.warnings, []);
  write({ hosts: { antigravity: { requires_approval: "yes" } } });
  assert.throws(() => loadConfig(sb.root), ConfigError);
  clear();
});

test("unknown keys are ignored but reported as warnings", () => {
  write({ claim_file: "typo.md", tiers: { huge: {} } });
  const c = loadConfig(sb.root);
  assert.equal(c.claims_file, null);
  assert.ok(c.warnings.some(w => w.includes('"claim_file"')));
  assert.ok(c.warnings.some(w => w.includes("tiers.huge")));
  clear();
});

test("resolveHousePath: relative from root, ~ from home, absolute kept, empty = off", () => {
  assert.equal(resolveHousePath("a/b.md", sb.root), path.resolve(sb.root, "a/b.md"));
  assert.equal(resolveHousePath("~/x/y", sb.root), path.join(os.homedir(), "x/y"));
  const abs = path.join(os.tmpdir(), "elsewhere", "claims.md");
  assert.equal(resolveHousePath(abs, sb.root), path.normalize(abs));
  assert.equal(resolveHousePath(null, sb.root), null);
  assert.equal(resolveHousePath("  ", sb.root), null);
});
