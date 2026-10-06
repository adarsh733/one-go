// p25-scout-quality.test.mjs — the scout ranks by measured quality, not price.
// think = highest quality among think cards; build = highest quality among low/medium-cost build
// cards (any build card when none is low/medium); mechanical = cheapest, ties by quality then speed.
// A card with no quality never outranks one that has it, unless no card in the tier has one.
// Every model id here is made up; no real tool is called.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pickForTier, cardProblems, qualityOf, qualityGaps, listFingerprint } from "../lib/scout.mjs";
import { qualityNote, checkCards } from "../check-model-cards.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECKER = path.join(HERE, "..", "check-model-cards.mjs");
const QSRC = "https://example.test/index";

function card(over = {}) {
  return {
    tier_fit: ["build"], good_at: ["code"], weak_at: [], cost: "medium", speed: "medium",
    source: "https://example.test/models", checked: "2030-03-15", ...over
  };
}

function hostCards(models, host = "made-host") {
  return { version: 1, hosts: { [host]: { fingerprint: listFingerprint(Object.keys(models)), models } } };
}

const pick = (cards, tier, preference) =>
  pickForTier("made-host", tier, { list: null, cards, ...(preference ? { preference } : {}) });

// ================================================================== think

test("think: the 30-vs-41 case — the cheaper card with the higher score wins over the pricier one", () => {
  const cards = hostCards({
    "made-pro": card({ tier_fit: ["think"], cost: "high", good_at: ["a", "b", "c"], quality: 30, quality_source: QSRC }),
    "made-flash": card({ tier_fit: ["think", "build"], cost: "medium", speed: "fast", quality: 41, quality_source: QSRC })
  });
  const r = pick(cards, "think");
  assert.equal(r.model, "made-flash");
  assert.match(r.why, /strongest of 2 carded models that fit think \(quality 41,/);
});

test("think: a card with no quality never outranks one that has it, even when it costs more", () => {
  const cards = hostCards({
    "made-dear-unscored": card({ tier_fit: ["think"], cost: "high", good_at: ["a", "b", "c", "d"] }),
    "made-cheap-scored": card({ tier_fit: ["think"], cost: "low", quality: 12, quality_source: QSRC })
  });
  assert.equal(pick(cards, "think").model, "made-cheap-scored");
});

test("think: no card in the tier has quality → the old price order (pricier first)", () => {
  const cards = hostCards({
    "made-dear": card({ tier_fit: ["think"], cost: "high" }),
    "made-mid": card({ tier_fit: ["think"], cost: "medium" }),
    // a scored card outside the tier does not change the think order
    "made-scored-build": card({ tier_fit: ["build"], cost: "low", quality: 90, quality_source: QSRC })
  });
  const r = pick(cards, "think");
  assert.equal(r.model, "made-dear");
  assert.match(r.why, /no quality score/);
});

// ================================================================== build

test("build: highest quality among low/medium-cost cards; a high-cost card is passed over even with a higher score", () => {
  const cards = hostCards({
    "made-dear": card({ cost: "high", quality: 60, quality_source: QSRC }),
    "made-mid": card({ cost: "medium", quality: 40, quality_source: QSRC }),
    "made-low": card({ cost: "low", quality: 45, quality_source: QSRC })
  });
  assert.equal(pick(cards, "build").model, "made-low");
});

test("build: when only high-cost cards fit build, any build card is used (highest quality)", () => {
  const cards = hostCards({
    "made-dear-a": card({ cost: "high", quality: 50, quality_source: QSRC }),
    "made-dear-b": card({ cost: "high", quality: 55, quality_source: QSRC }),
    "made-mech": card({ tier_fit: ["mechanical"], cost: "low", quality: 99, quality_source: QSRC })
  });
  assert.equal(pick(cards, "build").model, "made-dear-b");
});

test("build: an unscored card loses to a scored one; with none scored, medium cost first (old order)", () => {
  const scored = hostCards({
    "made-mid-unscored": card({ cost: "medium", good_at: ["a", "b", "c"] }),
    "made-low-scored": card({ cost: "low", quality: 20, quality_source: QSRC })
  });
  assert.equal(pick(scored, "build").model, "made-low-scored");
  const none = hostCards({
    "made-low": card({ cost: "low" }),
    "made-mid": card({ cost: "medium" }),
    "made-dear": card({ cost: "high" })
  });
  assert.equal(pick(none, "build").model, "made-mid");
});

// ================================================================== mechanical

test("mechanical: the cheapest card wins over a pricier one with a higher score", () => {
  const cards = hostCards({
    "made-mid": card({ tier_fit: ["mechanical"], cost: "medium", quality: 70, quality_source: QSRC }),
    "made-low": card({ tier_fit: ["mechanical"], cost: "low", quality: 10, quality_source: QSRC })
  });
  assert.equal(pick(cards, "mechanical").model, "made-low");
});

test("mechanical: same cost → higher quality, then faster", () => {
  const byQ = hostCards({
    "made-fast-low-q": card({ tier_fit: ["mechanical"], cost: "low", speed: "fast", quality: 20, quality_source: QSRC }),
    "made-slow-high-q": card({ tier_fit: ["mechanical"], cost: "low", speed: "slow", quality: 35, quality_source: QSRC }),
    "made-unscored": card({ tier_fit: ["mechanical"], cost: "low", speed: "fast" })
  });
  assert.equal(pick(byQ, "mechanical").model, "made-slow-high-q");
  const bySpeed = hostCards({
    "made-slow": card({ tier_fit: ["mechanical"], cost: "low", speed: "slow", quality: 30, quality_source: QSRC }),
    "made-fast": card({ tier_fit: ["mechanical"], cost: "low", speed: "fast", quality: 30, quality_source: QSRC })
  });
  assert.equal(pick(bySpeed, "mechanical").model, "made-fast");
  const none = hostCards({
    "made-slow": card({ tier_fit: ["mechanical"], cost: "low", speed: "slow" }),
    "made-fast": card({ tier_fit: ["mechanical"], cost: "low", speed: "fast" })
  });
  assert.equal(pick(none, "mechanical").model, "made-fast");
});

// ================================================================== the docs

test("HOSTS.md names the quality and quality_source fields and the ranking rule", () => {
  const text = fs.readFileSync(path.join(HERE, "..", "..", "reference", "HOSTS.md"), "utf8");
  assert.match(text, /`quality`/);
  assert.match(text, /`quality_source`/);
  assert.match(text, /never outranks/);
});

// ================================================================== the card fields and the checker

test("cardProblems accepts quality 0-100 with a quality_source address, and flags bad values", () => {
  assert.deepEqual(cardProblems(hostCards({ "made-a": card({ quality: 0, quality_source: QSRC }),
    "made-b": card({ quality: 100, quality_source: QSRC }), "made-c": card() })), []);
  const p = cardProblems(hostCards({
    "made-high": card({ quality: 101, quality_source: QSRC }),
    "made-word": card({ quality: "41", quality_source: QSRC }),
    "made-badurl": card({ quality: 40, quality_source: "a leaderboard" }),
    "made-nosrc": card({ quality: 40 })
  }));
  for (const want of [/made-high: "quality" must be a number from 0 to 100/, /made-word: "quality" must be a number/,
    /made-badurl: "quality_source" must be a web address/, /made-nosrc: "quality" needs a "quality_source"/]) {
    assert.ok(p.some(l => want.test(l)), `expected ${want} in ${JSON.stringify(p)}`);
  }
  assert.equal(qualityOf(card({ quality: 41 })), 41);
  assert.equal(qualityOf(card()), null);
});

test("the checker counts cards with no quality as a note, not a failure", () => {
  const cards = hostCards({
    "made-a": card({ quality: 41, quality_source: QSRC }), "made-b": card(), "made-c": card()
  });
  assert.deepEqual(qualityGaps(cards), { missing: 2, total: 3 });
  assert.match(qualityNote(cards), /^2 of 3 cards have no "quality" score/);
  assert.equal(qualityNote(hostCards({ "made-a": card({ quality: 41, quality_source: QSRC }) })), null);
  // not a failure: the same cards have no field-level gaps, so checkCards reports none for them
  assert.deepEqual(checkCards(cards, {}).gaps, []);
  // the CLI prints the note (source check only — running the CLI would read the real tools)
  assert.match(fs.readFileSync(CHECKER, "utf8"), /console\.log\(`note: \$\{qn\}`\)/);
});
