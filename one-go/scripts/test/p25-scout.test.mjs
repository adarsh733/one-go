// p25-scout.test.mjs — the model scout (lib/scout.mjs) and the card checker CLI.
// Every tool is read through an injected reader: no test here runs a real tool. Model ids are
// made up (the claude aliases and the antigravity words are the built-in lists themselves).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  readHostModels, listFingerprint, loadCards, cardProblems, staleCards, staleWarning,
  pickForTier, resolvePin, CardsError
} from "../lib/scout.mjs";
import { checkCards } from "../check-model-cards.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECKER = path.join(HERE, "..", "check-model-cards.mjs");
const TODAY = "2030-03-20";

const CODEX_CACHE = JSON.stringify({
  fetched_at: "2030-03-01", models: [
    { slug: "zeta-max", description: "Made-up strongest.", visibility: "list" },
    { slug: "zeta-mid", description: "Made-up middle.", visibility: "list" },
    { slug: "zeta-mini", description: "Made-up small.", visibility: "list" },
    { slug: "zeta-hidden", description: "Never shown.", visibility: "hide" }
  ]
});
const OPENCODE_OUT = [
  "opencode/alpha-big", "opencode-go/beta-small", "otherprov/gamma-x", "", "  not a model line  "
].join("\n");

const readers = {
  codex: () => CODEX_CACHE,
  opencode: () => OPENCODE_OUT
};

function card(over = {}) {
  return {
    tier_fit: ["build"], good_at: ["code"], weak_at: [], cost: "medium", speed: "medium",
    source: "https://example.test/models", checked: "2030-03-15", ...over
  };
}

function codexCards(over = {}) {
  const ids = ["zeta-max", "zeta-mid", "zeta-mini"];
  return {
    version: 1,
    hosts: {
      codex: {
        fingerprint: listFingerprint(ids),
        models: {
          "zeta-max": card({ tier_fit: ["think", "build"], cost: "high", speed: "slow", good_at: ["design", "review"] }),
          "zeta-mid": card({ tier_fit: ["think", "build", "mechanical"], cost: "medium", speed: "medium" }),
          "zeta-mini": card({ tier_fit: ["build", "mechanical"], cost: "low", speed: "fast", weak_at: ["design"] }),
          ...over
        }
      }
    }
  };
}

function tmpFile(name, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "p25-scout-"));
  const p = path.join(dir, name);
  if (text != null) fs.writeFileSync(p, text);
  return p;
}

// ================================================================== reading each host's list

test("listFingerprint is sha1 of the sorted ids, whatever the order", () => {
  const want = crypto.createHash("sha1").update(["a-1", "b-2", "c-3"].join("\n")).digest("hex");
  assert.equal(listFingerprint(["c-3", "a-1", "b-2"]), want);
  assert.equal(listFingerprint(["b-2", "c-3", "a-1"]), want);
  assert.notEqual(listFingerprint(["a-1", "b-2"]), want);
});

test("claude: the built-in aliases, nothing discovered, list not exhaustive", () => {
  const r = readHostModels("claude", { readers: {} });
  assert.deepEqual(r.models.map(m => m.id), ["opus", "sonnet", "haiku"]);
  assert.equal(r.fingerprint, listFingerprint(["opus", "sonnet", "haiku"]));
  assert.equal(r.exhaustive, false);
  assert.ok(r.source);
});

test("antigravity: the fixed words flash_lite, flash, pro", () => {
  const r = readHostModels("antigravity", { readers: {} });
  assert.deepEqual(r.models.map(m => m.id), ["flash_lite", "flash", "pro"]);
  assert.equal(r.exhaustive, true);
});

test("codex: entries with visibility list only, descriptions kept", () => {
  const r = readHostModels("codex", { readers });
  assert.deepEqual(r.models.map(m => m.id), ["zeta-max", "zeta-mid", "zeta-mini"]);
  assert.equal(r.models[0].description, "Made-up strongest.");
  assert.match(r.source, /models_cache\.json/);
  assert.equal(r.fingerprint, listFingerprint(["zeta-mini", "zeta-max", "zeta-mid"]));
});

test("opencode: `opencode models` lines kept to the named providers", () => {
  const r = readHostModels("opencode", { readers });
  assert.deepEqual(r.models.map(m => m.id), ["opencode/alpha-big", "opencode-go/beta-small"]);
  const wider = readHostModels("opencode", { readers, providers: ["otherprov"] });
  assert.deepEqual(wider.models.map(m => m.id), ["otherprov/gamma-x"]);
});

test("an unreadable tool is reported as unavailable, never thrown", () => {
  const boom = { codex: () => { throw new Error("ENOENT: no models cache\nsecond line"); } };
  const a = readHostModels("codex", { readers: boom });
  assert.deepEqual(Object.keys(a), ["unavailable"]);
  assert.match(a.unavailable, /^codex: ENOENT: no models cache$/);

  const bad = readHostModels("codex", { readers: { codex: () => "{not json" } });
  assert.match(bad.unavailable, /could not read the model list/);

  const empty = readHostModels("opencode", { readers: { opencode: () => "otherprov/x\n" } });
  assert.match(empty.unavailable, /named no models/);

  const none = readHostModels("codex", { readers: { codex: () => null } });
  assert.match(none.unavailable, /returned nothing/);

  const unknown = readHostModels("mystery-tool", { readers: {} });
  assert.match(unknown.unavailable, /no model list is known/);
});

// ================================================================== the card file

test("loadCards: missing file is null, bad JSON or shape is a one-line CardsError", () => {
  assert.equal(loadCards(tmpFile("absent.json")), null);
  assert.throws(() => loadCards(tmpFile("bad.json", "{oops")), CardsError);
  assert.throws(() => loadCards(tmpFile("v2.json", JSON.stringify({ version: 2, hosts: {} }))), /"version" must be 1/);
  const ok = loadCards(tmpFile("ok.json", JSON.stringify(codexCards())));
  assert.equal(ok.hosts.codex.models["zeta-max"].cost, "high");
});

test("cardProblems lists every missing field and a missing source address", () => {
  assert.deepEqual(cardProblems(codexCards()), []);
  const c = codexCards({ "zeta-mid": { tier_fit: ["build"], cost: "cheap", source: "a blog", checked: "soon" } });
  const p = cardProblems(c);
  for (const want of [/zeta-mid: missing "good_at"/, /zeta-mid: missing "weak_at"/, /zeta-mid: missing "speed"/,
    /zeta-mid: "cost" must be/, /zeta-mid: "source" must be a web address/, /zeta-mid: "checked" must be a date/]) {
    assert.ok(p.some(l => want.test(l)), `expected ${want} in ${JSON.stringify(p)}`);
  }
});

// ================================================================== staleness

test("staleCards: fresh cards give no reasons", () => {
  const lists = { codex: readHostModels("codex", { readers }) };
  assert.deepEqual(staleCards(codexCards(), lists, { maxAgeDays: 14, today: TODAY }), []);
});

test("staleCards: a card older than max_age_days is stale", () => {
  const lists = { codex: readHostModels("codex", { readers }) };
  const old = codexCards({ "zeta-mini": card({ tier_fit: ["mechanical"], cost: "low", checked: "2030-03-01" }) });
  const r = staleCards(old, lists, { maxAgeDays: 14, today: TODAY });
  assert.deepEqual(r, ["codex/zeta-mini card is 19 days old (limit 14)"]);
  assert.deepEqual(staleCards(old, lists, { maxAgeDays: 30, today: TODAY }), []);
});

test("staleCards: a new model in the list makes the cards stale (list changed + no card)", () => {
  const grown = JSON.parse(CODEX_CACHE);
  grown.models.push({ slug: "zeta-new", description: "Made-up newcomer.", visibility: "list" });
  const lists = { codex: readHostModels("codex", { readers: { codex: () => JSON.stringify(grown) } }) };
  const r = staleCards(codexCards(), lists, { today: TODAY });
  assert.ok(r.includes("codex's model list changed since the cards were written"), JSON.stringify(r));
  assert.ok(r.includes("codex/zeta-new has no card"), JSON.stringify(r));
});

test("staleCards: no card file, a host with no cards, and an unreadable host", () => {
  assert.deepEqual(staleCards(null, {}, { today: TODAY }), ["there is no model-cards file"]);
  const lists = {
    codex: readHostModels("codex", { readers }),
    opencode: readHostModels("opencode", { readers }),
    antigravity: { unavailable: "antigravity: not installed" }
  };
  const r = staleCards(codexCards(), lists, { today: TODAY });
  assert.deepEqual(r, ["opencode has no model cards"]);
});

test("the stale warning line is exact", () => {
  assert.equal(staleWarning(["codex/zeta-new has no card"]),
    "WARNING: model cards are stale (codex/zeta-new has no card) — run board.mjs models before the next dispatch.");
});

// ================================================================== picking per tier

test("preference quality-where-it-counts: best for think, balanced for build, cheapest for mechanical", () => {
  const list = readHostModels("codex", { readers });
  const cards = codexCards();
  const pick = t => pickForTier("codex", t, { list, cards, preference: "quality-where-it-counts" });
  assert.equal(pick("think").model, "zeta-max");
  assert.equal(pick("build").model, "zeta-mid");
  assert.equal(pick("mechanical").model, "zeta-mini");
  assert.match(pick("think").why, /strongest of 2 carded models that fit think/);
  // the default preference is the same one
  assert.equal(pickForTier("codex", "build", { list, cards }).model, "zeta-mid");
});

test("preference quality: the strongest that fits, every tier", () => {
  const list = readHostModels("codex", { readers });
  const cards = codexCards();
  const pick = t => pickForTier("codex", t, { list, cards, preference: "quality" }).model;
  assert.equal(pick("think"), "zeta-max");
  assert.equal(pick("build"), "zeta-max");
  assert.equal(pick("mechanical"), "zeta-mid");
});

test("preference cost: the cheapest that fits, every tier", () => {
  const list = readHostModels("codex", { readers });
  const cards = codexCards();
  const pick = t => pickForTier("codex", t, { list, cards, preference: "cost" }).model;
  assert.equal(pick("think"), "zeta-mid");
  assert.equal(pick("build"), "zeta-mini");
  assert.equal(pick("mechanical"), "zeta-mini");
});

test("pickForTier: only models in today's list, null when no card fits", () => {
  const cards = codexCards();
  const shrunk = { models: [{ id: "zeta-mini", description: "" }], fingerprint: listFingerprint(["zeta-mini"]) };
  assert.equal(pickForTier("codex", "build", { list: shrunk, cards }).model, "zeta-mini");
  assert.equal(pickForTier("codex", "think", { list: shrunk, cards }), null);
  assert.equal(pickForTier("opencode", "think", { list: null, cards }), null);
  assert.equal(pickForTier("codex", "think", { list: null, cards: null }), null);
  // an unreadable tool: the cards alone are used
  assert.equal(pickForTier("codex", "think", { list: { unavailable: "x" }, cards }).model, "zeta-max");
});

// ================================================================== a pinned model that vanished

test("resolvePin: a pin still listed is kept with no warning", () => {
  const list = readHostModels("codex", { readers });
  assert.deepEqual(resolvePin("codex", "think", "zeta-mid", { list, cards: codexCards() }),
    { model: "zeta-mid", warning: null });
});

test("resolvePin: a vanished pin falls back to the cards' pick, with the exact warning", () => {
  const list = readHostModels("codex", { readers });
  const r = resolvePin("codex", "think", "zeta-gone", { list, cards: codexCards() });
  assert.deepEqual(r, {
    model: "zeta-max",
    warning: "WARNING: zeta-gone is no longer in codex's model list — using zeta-max for think instead."
  });
});

test("resolvePin: a vanished pin with no fitting card → no model named, the tool's own model runs", () => {
  const list = readHostModels("codex", { readers });
  const cards = codexCards({ "zeta-max": card({ tier_fit: ["build"] }), "zeta-mid": card({ tier_fit: ["build"] }) });
  const r = resolvePin("codex", "think", "zeta-gone", { list, cards });
  assert.equal(r.model, null);
  assert.equal(r.warning,
    "WARNING: zeta-gone is no longer in codex's model list — using the tool's own model for think instead.");
  const noCards = resolvePin("antigravity", "build", "ultra", { list: readHostModels("antigravity", { readers: {} }), cards: null });
  assert.equal(noCards.model, null);
  assert.match(noCards.warning, /^WARNING: ultra is no longer in antigravity's model list — using the tool's own model for build instead\.$/);
});

test("resolvePin: auto, unset, an unreadable tool, and claude's non-exhaustive list", () => {
  const list = readHostModels("codex", { readers });
  const cards = codexCards();
  assert.deepEqual(resolvePin("codex", "mechanical", "auto", { list, cards }), { model: "zeta-mini", warning: null });
  assert.deepEqual(resolvePin("codex", "think", "auto", { list, cards: null }), { model: null, warning: null });
  assert.deepEqual(resolvePin("codex", "think", null, { list, cards }), { model: null, warning: null });
  assert.deepEqual(resolvePin("codex", "think", "zeta-gone", { list: { unavailable: "x" }, cards }),
    { model: "zeta-gone", warning: null });
  const claude = readHostModels("claude", { readers: {} });
  assert.deepEqual(resolvePin("claude", "think", "made-up-full-id", { list: claude, cards: null }),
    { model: "made-up-full-id", warning: null });
});

// ================================================================== the card checker

test("checkCards: a listed model with no card is a gap; an unreadable tool is a note, not a gap", () => {
  const lists = {
    codex: readHostModels("codex", { readers }),
    antigravity: { unavailable: "antigravity: not installed" }
  };
  assert.deepEqual(checkCards(codexCards(), lists).gaps, []);
  const thin = codexCards();
  delete thin.hosts.codex.models["zeta-mini"];
  const r = checkCards(thin, lists);
  assert.deepEqual(r.gaps, ["codex/zeta-mini: no card (the tool lists it today)"]);
  assert.deepEqual(r.notes, ["skipped antigravity: antigravity: not installed"]);
});

test("check-model-cards CLI: exit 1 on an unparseable file, exit 2 with no file named", () => {
  const bad = spawnSync(process.execPath, [CHECKER, tmpFile("bad.json", "{oops")], { encoding: "utf8" });
  assert.equal(bad.status, 1, bad.stdout + bad.stderr);
  assert.match(bad.stdout, /FAIL .*not valid JSON/);
  const missing = spawnSync(process.execPath, [CHECKER, tmpFile("absent.json")], { encoding: "utf8" });
  assert.equal(missing.status, 1);
  const none = spawnSync(process.execPath, [CHECKER], { encoding: "utf8" });
  assert.equal(none.status, 2);
});
