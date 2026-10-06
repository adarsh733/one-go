// p25-scout-wiring.test.mjs — the model scout wired into the engine: config keys and the "auto"
// tier value, route.mjs resolving "auto" and vanished pins from lists passed in, `start` printing
// the map and the exact warnings, `board.mjs models`, and the one line every seal brief carries.
// Run it directly (`node p25-scout-wiring.test.mjs`) or under `node --test`.
// No real tool is read: the lists come from a made-up codex models cache in a throwaway home
// folder, and the seal-brief tests inject their own readers. Model ids are made up.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeSandbox, runBoard } from "./helpers.mjs";
import { validateConfig } from "../lib/config.mjs";
import { listFingerprint } from "../lib/scout.mjs";
import {
  tierModelMap, tiersFor, routeFor, resolveScoutModels, withScoutModels, NOT_NAMED, TOOL_OWN_MODEL
} from "../lib/route.mjs";
import { buildSealBrief } from "../cmd/dispatch-seal.mjs";
import { today } from "../lib/util.mjs";

const SLUG = "demo-job";
const TODAY = today();
const OLD = "2000-01-01";
const IDS = ["zeta-max", "zeta-mid", "zeta-mini"];
const CODEX_CACHE = JSON.stringify({
  models: [
    { slug: "zeta-max", description: "Made-up strongest.", visibility: "list" },
    { slug: "zeta-mid", description: "Made-up middle.", visibility: "list" },
    { slug: "zeta-mini", description: "Made-up small.", visibility: "list" },
    { slug: "zeta-hidden", description: "Never shown.", visibility: "hide" }
  ]
});

function card(over = {}) {
  return {
    tier_fit: ["build"], good_at: ["code"], weak_at: [], cost: "medium", speed: "medium",
    source: "https://example.test/models", checked: TODAY, ...over
  };
}
function cards({ checked = TODAY, ids = IDS } = {}) {
  return {
    version: 1,
    hosts: {
      codex: {
        fingerprint: listFingerprint(ids),
        models: {
          "zeta-max": card({ tier_fit: ["think", "build"], cost: "high", speed: "slow", good_at: ["design", "review"], checked }),
          "zeta-mid": card({ tier_fit: ["think", "build", "mechanical"], cost: "medium", speed: "medium", checked }),
          "zeta-mini": card({ tier_fit: ["build", "mechanical"], cost: "low", speed: "fast", weak_at: ["design"], checked })
        }
      }
    }
  };
}
const liveList = () => ({ models: IDS.map(id => ({ id, description: "" })), source: "test", fingerprint: listFingerprint(IDS), exhaustive: true });
const autoConfig = { hosts: { codex: { think: "auto", build: "auto", mechanical: "zeta-old" } } };

// ---------------------------------------------------------------- config keys

test("config: model_cards and model_scout are accepted, defaulted, and checked; auto is a valid tier value", () => {
  const dflt = validateConfig({}).config;
  assert.equal(dflt.model_cards, null);
  assert.deepEqual(dflt.model_scout, { max_age_days: 14, preference: "quality-where-it-counts", opencode_providers: ["opencode", "opencode-go"] });

  const raw = {
    model_cards: ".claude/one-go/model-cards.json",
    model_scout: { max_age_days: 7, preference: "cost", opencode_providers: ["prov-a"] },
    hosts: { codex: { think: "auto", build: "auto", mechanical: "auto" } }
  };
  const { config, warnings } = validateConfig(raw);
  assert.deepEqual(warnings, [], "none of the new keys is reported as unknown");
  assert.equal(config.model_cards, ".claude/one-go/model-cards.json");
  assert.deepEqual(config.model_scout, { max_age_days: 7, preference: "cost", opencode_providers: ["prov-a"] });
  assert.equal(config.hosts.codex.think, "auto");

  assert.match(validateConfig({ model_scout: { max_age_days: 3, nope: 1 } }).warnings.join("\n"), /unknown key "model_scout\.nope"/);
  assert.throws(() => validateConfig({ model_scout: { preference: "best" } }), /model_scout\.preference/);
  assert.throws(() => validateConfig({ model_scout: { max_age_days: 0 } }), /model_scout\.max_age_days/);
  assert.throws(() => validateConfig({ model_scout: { opencode_providers: "x" } }), /opencode_providers/);
  assert.throws(() => validateConfig({ model_cards: 5 }), /model_cards/);
  assert.throws(() => validateConfig({ model_scout: [] }), /model_scout/);
});

// ---------------------------------------------------------------- route.mjs: auto and vanished pins

test("route: auto takes the cards' pick per tier; the word auto never becomes a model name", () => {
  const scout = { list: liveList(), cards: cards(), preference: "quality-where-it-counts" };
  const { models, auto } = resolveScoutModels({ hosts: { codex: { think: "auto", build: "auto", mechanical: "auto" } } }, "codex", scout);
  assert.deepEqual(models, { think: "zeta-max", build: "zeta-mid", mechanical: "zeta-mini" });
  assert.deepEqual(auto, ["think", "build", "mechanical"]);

  const cfg = { hosts: { codex: { think: "auto", build: "auto", mechanical: "auto" } } };
  const map = tierModelMap(cfg, "codex", { scout });
  assert.deepEqual(map.lines, ["think → zeta-max", "build → zeta-mid", "mechanical → zeta-mini"]);
  assert.deepEqual(map.warnings, []);

  // a different preference changes the picks, from the same cards
  const cheap = resolveScoutModels(cfg, "codex", { ...scout, preference: "cost" }).models;
  assert.deepEqual(cheap, { think: "zeta-mid", build: "zeta-mini", mechanical: "zeta-mini" });

  // routes built from the resolved config carry the picked name
  const eff = withScoutModels(cfg, "codex", models);
  assert.equal(routeFor({ n: 1, model: "think", files: ["a"] }, { host: "codex", config: eff }).model, "zeta-max");
  // and without the scout, "auto" is never handed to a tool
  assert.equal(tiersFor(cfg).think.models.codex, undefined);
  assert.equal(routeFor({ n: 1, model: "think", files: ["a"] }, { host: "codex", config: cfg }).model, TOOL_OWN_MODEL);
});

test("route: a pinned model the tool no longer lists falls back to the cards' pick, with the exact warning", () => {
  const scout = { list: liveList(), cards: cards(), preference: "quality-where-it-counts" };
  const { lines, warnings } = tierModelMap(autoConfig, "codex", { scout });
  assert.deepEqual(lines, ["think → zeta-max", "build → zeta-mid", "mechanical → zeta-mini"]);
  assert.deepEqual(warnings, ["WARNING: zeta-old is no longer in codex's model list — using zeta-mini for mechanical instead."]);

  // no card fits the tier → no model named, the tool's own model runs, still only a warning
  const thin = { ...cards() };
  thin.hosts = { codex: { fingerprint: thin.hosts.codex.fingerprint, models: { "zeta-max": thin.hosts.codex.models["zeta-max"] } } };
  const none = tierModelMap({ hosts: { codex: { think: "zeta-max", build: "zeta-max", mechanical: "zeta-old" } } }, "codex", { scout: { ...scout, cards: thin } });
  assert.equal(none.lines[2], `mechanical → ${NOT_NAMED}`);
  assert.ok(none.warnings.includes(`WARNING: zeta-old is no longer in codex's model list — using ${TOOL_OWN_MODEL} for mechanical instead.`));

  // a pin still in the list is kept, quietly
  const kept = tierModelMap({ hosts: { codex: { think: "zeta-mid", build: "zeta-mid", mechanical: "zeta-mini" } } }, "codex", { scout });
  assert.deepEqual(kept.warnings, []);
  assert.equal(kept.lines[0], "think → zeta-mid");
});

test("route: auto with the scout off says so, and claude's own aliases are untouched", () => {
  const off = tierModelMap({ hosts: { codex: { think: "auto", build: "zeta-mid", mechanical: "zeta-mini" } } }, "codex");
  assert.equal(off.lines[0], `think → ${NOT_NAMED}`);
  assert.ok(off.warnings.some(w => /^WARNING: hosts\.codex\.think is "auto" but no model_cards file is set/.test(w)));
  assert.deepEqual(tierModelMap({}, "claude").lines, ["think → opus", "build → sonnet", "mechanical → haiku"]);
  // claude "auto" with no card for it keeps the built-in alias
  const c = resolveScoutModels({ hosts: { claude: { think: "auto" } } }, "claude",
    { list: { models: [{ id: "opus" }], exhaustive: false }, cards: { version: 1, hosts: {} }, preference: "quality" });
  assert.equal(c.models.think, "opus");
});

// ---------------------------------------------------------------- start prints the map and the warnings

function setConfig(sb, cfg) { fs.writeFileSync(path.join(sb.onegoDir, "config.json"), JSON.stringify(cfg)); }
function seedPlan(sb) {
  fs.mkdirSync(path.join(sb.root, "out"), { recursive: true });
  const plan = {
    schema: 1, plan_id: `plan-${SLUG}`, plan_revision: 1,
    passes: [
      { n: 1, purpose: "Write the report", writes: ["out/a.txt"], route: { requested_model: "build" },
        required_check: { command: "node -e \"process.exit(0)\"" } }
    ]
  };
  fs.writeFileSync(path.join(sb.plansDir, `${SLUG}.plan.json`), JSON.stringify(plan, null, 2));
  const b = JSON.parse(fs.readFileSync(sb.boardPath, "utf8"));
  b.tasks[SLUG] = { display: "Demo Job", stage: "waiting" };
  fs.writeFileSync(sb.boardPath, JSON.stringify(b, null, 2));
}
function writeCards(sb, data) { fs.writeFileSync(path.join(sb.onegoDir, "model-cards.json"), JSON.stringify(data, null, 2)); }
function newestState(sb) {
  const dirs = fs.readdirSync(sb.onegoDir).filter(d => d.endsWith(`-${SLUG}`)).sort();
  assert.ok(dirs.length, "a run folder was written");
  return JSON.parse(fs.readFileSync(path.join(sb.onegoDir, dirs[dirs.length - 1], "state.json"), "utf8"));
}

/** A throwaway home folder holding a made-up codex models cache; the child process reads it as ~. */
function withFakeHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "one-go-home-"));
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codex", "models_cache.json"), CODEX_CACHE);
  const keep = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home; process.env.USERPROFILE = home;
  try { return fn(home); } finally {
    for (const [k, v] of Object.entries(keep)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    fs.rmSync(home, { recursive: true, force: true });
  }
}
const SCOUT_CONFIG = { model_cards: ".claude/one-go/model-cards.json", hosts: autoConfig.hosts };

test("start: auto and a vanished pin are settled once, printed, written into the run — fresh cards, no stale line", () => {
  withFakeHome(() => {
    const sb = makeSandbox();
    try {
      seedPlan(sb); setConfig(sb, SCOUT_CONFIG); writeCards(sb, cards());
      const r = runBoard(["start", SLUG, "--host", "codex"], sb.root);
      assert.equal(r.code, 0, r.stdout);
      assert.match(r.stdout, /\*\*Models on codex:\*\*\n- think → zeta-max\n- build → zeta-mid\n- mechanical → zeta-mini/);
      assert.match(r.stdout, /^WARNING: zeta-old is no longer in codex's model list — using zeta-mini for mechanical instead\.$/m);
      assert.doesNotMatch(r.stdout, /model cards are stale/);
      const st = newestState(sb);
      assert.equal(st.passes[0].route.model, "zeta-mid", "a build pass runs the build pick");
      assert.notEqual(st.passes[0].route.model, "auto");
    } finally { sb.teardown(); }
  });
});

test("start: old cards, a changed list and a missing card file each print the exact stale line — and the run still starts", () => {
  withFakeHome(() => {
    const stale = line => new RegExp(`^WARNING: model cards are stale \\(${line}\\) — run board\\.mjs models before the next dispatch\\.$`, "m");
    // one card older than the limit
    let sb = makeSandbox();
    try {
      seedPlan(sb); setConfig(sb, SCOUT_CONFIG);
      const c = cards(); c.hosts.codex.models["zeta-mid"].checked = OLD; writeCards(sb, c);
      const r = runBoard(["start", SLUG, "--host", "codex"], sb.root);
      assert.equal(r.code, 0, r.stdout);
      assert.match(r.stdout, stale("codex/zeta-mid card is \\d+ days old \\(limit 14\\)"));
    } finally { sb.teardown(); }
    // the tool's list changed since the cards were written
    sb = makeSandbox();
    try {
      seedPlan(sb); setConfig(sb, SCOUT_CONFIG); writeCards(sb, cards({ ids: ["zeta-max", "zeta-mid"] }));
      const r = runBoard(["start", SLUG, "--host", "codex"], sb.root);
      assert.equal(r.code, 0, r.stdout);
      assert.match(r.stdout, stale("codex's model list changed since the cards were written"));
    } finally { sb.teardown(); }
    // no card file at all: auto names no model, the run still starts on the tool's own model
    sb = makeSandbox();
    try {
      seedPlan(sb); setConfig(sb, SCOUT_CONFIG);
      const r = runBoard(["start", SLUG, "--host", "codex"], sb.root);
      assert.equal(r.code, 0, r.stdout);
      assert.match(r.stdout, stale("there is no model-cards file"));
      assert.match(r.stdout, new RegExp(`- think → ${NOT_NAMED}`));
      assert.equal(newestState(sb).passes[0].route.model, TOOL_OWN_MODEL);
    } finally { sb.teardown(); }
  });
});

test("start: with no model_cards the scout is off — nothing is read, an auto tier says so", () => {
  const sb = makeSandbox();
  try {
    seedPlan(sb);
    setConfig(sb, { hosts: { codex: { think: "auto", build: "zeta-mid", mechanical: "zeta-mini" } } });
    const r = runBoard(["start", SLUG, "--host", "codex"], sb.root);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /^WARNING: hosts\.codex\.think is "auto" but no model_cards file is set/m);
    assert.doesNotMatch(r.stdout, /model cards are stale/);
    assert.equal(newestState(sb).passes[0].route.model, "zeta-mid");
  } finally { sb.teardown(); }
});

// ---------------------------------------------------------------- board.mjs models

test("models: lists each host's models and the card status; --check exits 1 when stale, 0 when fresh", () => {
  withFakeHome(() => {
    const sb = makeSandbox();
    try {
      setConfig(sb, SCOUT_CONFIG);
      const missing = runBoard(["models", "--host", "codex"], sb.root);
      assert.equal(missing.code, 0, "plain models is a report");
      assert.match(missing.stdout, /\*\*codex\*\* — 3 models/);
      assert.match(missing.stdout, /- zeta-max — NEEDS RESEARCH — no card/);
      assert.match(missing.stdout, /\*\*Needs researching \(3\):\*\*/);
      assert.equal(runBoard(["models", "--check"], sb.root).code, 1, "missing cards fail the check");

      const c = cards(); c.hosts.codex.models["zeta-mini"].checked = OLD; writeCards(sb, c);
      const old = runBoard(["models", "--host", "codex", "--check"], sb.root);
      assert.equal(old.code, 1);
      assert.match(old.stdout, /- zeta-mini — NEEDS RESEARCH — card is \d+ days old/);
      assert.match(old.stdout, /- zeta-max — card ok/);

      writeCards(sb, cards());
      const fresh = runBoard(["models", "--host", "codex", "--check"], sb.root);
      assert.equal(fresh.code, 0, fresh.stdout);
      assert.match(fresh.stdout, /Cards are fresh/);
      assert.equal(runBoard(["models", "--host", "nowhere"], sb.root).code, 1);
    } finally { sb.teardown(); }
  });
});

test("models: with no model_cards set there is nothing to check (exit 0)", () => {
  const sb = makeSandbox();
  try {
    const r = runBoard(["models", "--check"], sb.root);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /not in use here/);
  } finally { sb.teardown(); }
});

// ---------------------------------------------------------------- the seal brief line

const sealArgs = (over = {}) => ({
  slug: "wide-job", text: "build the home screen", named: [], planPath: "/tmp/plans/wide-job.md",
  boardCmd: 'node "board.mjs"', root: "/tmp/proj", house: {}, ...over
});
const cardLines = brief => brief.split("\n").filter(l => l.startsWith("Model cards:"));

test("seal brief: every brief carries exactly one Model cards line, in the Models section", () => {
  const off = buildSealBrief(sealArgs({ config: {} }));
  assert.equal(cardLines(off).length, 1);
  assert.match(cardLines(off)[0], /not in use in this project .* no refresh question needed/);
  const sec = off.split("## Models — column 3 of the Passes table")[1].split("\n## ")[0];
  assert.match(sec, /^Model cards:/m, "the line sits under the Models heading");
});

test("seal brief: fresh cards say so; stale cards tell the reading worker to add the refresh question", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "one-go-seal-"));
  try {
    const config = { model_cards: "model-cards.json", hosts: { codex: { think: "auto", build: "auto", mechanical: "auto" } } };
    const readers = { codex: () => CODEX_CACHE };
    const file = path.join(dir, "model-cards.json");

    fs.writeFileSync(file, JSON.stringify(cards()));
    const fresh = buildSealBrief(sealArgs({ config, root: dir, readers }));
    assert.equal(cardLines(fresh).length, 1);
    assert.match(cardLines(fresh)[0], /^Model cards: fresh for codex — no refresh question needed\.$/);
    assert.doesNotMatch(fresh, /STALE/);

    fs.writeFileSync(file, JSON.stringify(cards({ checked: OLD })));
    const old = buildSealBrief(sealArgs({ config, root: dir, readers }));
    assert.equal(cardLines(old).length, 1);
    assert.match(cardLines(old)[0], /^Model cards: STALE \(.*days old.*\) — add one question to `## Open questions`: refresh the model cards/);
    assert.match(cardLines(old)[0], /A ★ yes/);

    fs.rmSync(file);
    const missing = buildSealBrief(sealArgs({ config, root: dir, readers }));
    assert.match(cardLines(missing)[0], /STALE \(there is no model-cards file\)/);

    // a state worked out by the caller is used as given
    const given = buildSealBrief(sealArgs({ config: {}, cardsState: { state: "stale", reasons: ["codex has no model cards"], hosts: ["codex"], unread: [] } }));
    assert.match(cardLines(given)[0], /STALE \(codex has no model cards\)/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
