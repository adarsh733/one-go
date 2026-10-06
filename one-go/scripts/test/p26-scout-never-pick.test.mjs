// p26-scout-never-pick.test.mjs — a card marked `never_pick` (e.g. the maker may train on prompts)
// is never chosen by "auto" or by a vanished-pin fallback; a pin the person wrote by hand is kept.
// Every model id here is made up; no real tool is called.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pickForTier, resolvePin, cardProblems, neverPickOf, listFingerprint } from "../lib/scout.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const QSRC = "https://example.test/index";

function card(over = {}) {
  return {
    tier_fit: ["build", "mechanical"], good_at: ["code"], weak_at: [], cost: "low", speed: "fast",
    source: "https://example.test/models", checked: "2030-03-15", ...over
  };
}
const hostCards = models =>
  ({ version: 1, hosts: { "made-host": { fingerprint: listFingerprint(Object.keys(models)), models } } });

const cards = hostCards({
  "free-trainer": card({ quality: 90, quality_source: QSRC, never_pick: "the maker may train on prompts" }),
  "safe-a": card({ quality: 40, quality_source: QSRC }),
  "safe-b": card({ cost: "medium", quality: 50, quality_source: QSRC })
});

test("auto never picks a never_pick card, even when it scores highest and is cheapest", () => {
  for (const tier of ["build", "mechanical"]) {
    const p = pickForTier("made-host", tier, { list: null, cards });
    assert.ok(p, `${tier} has a pick`);
    assert.notEqual(p.model, "free-trainer", `${tier} must skip the never_pick card`);
  }
  assert.equal(resolvePin("made-host", "build", "auto", { list: null, cards }).model, "safe-b");
});

test("a vanished pin never falls back to a never_pick card", () => {
  const list = { models: [{ id: "free-trainer" }, { id: "safe-a" }] };
  const r = resolvePin("made-host", "mechanical", "gone-model", { list, cards });
  assert.equal(r.model, "safe-a");
  assert.match(r.warning, /gone-model is no longer in made-host's model list/);
});

test("a tier whose only cards are never_pick gets no pick (the tool's own model runs)", () => {
  const only = hostCards({ "free-trainer": card({ never_pick: "logs usage" }) });
  assert.equal(pickForTier("made-host", "build", { list: null, cards: only }), null);
  assert.equal(resolvePin("made-host", "build", "auto", { list: null, cards: only }).model, null);
});

test("a pin written by hand is honoured even when its card says never_pick", () => {
  const list = { models: [{ id: "free-trainer" }, { id: "safe-a" }] };
  assert.equal(resolvePin("made-host", "build", "free-trainer", { list, cards }).model, "free-trainer");
});

test("never_pick must be a one-line reason; a blank one is a card problem", () => {
  assert.equal(neverPickOf(card({ never_pick: "  trains on prompts " })), "trains on prompts");
  assert.equal(neverPickOf(card()), null);
  const bad = hostCards({ "x": card({ never_pick: "  " }) });
  assert.ok(cardProblems(bad).some(p => /never_pick/.test(p)));
  assert.deepEqual(cardProblems(cards), []);
});

test("HOSTS.md documents never_pick", () => {
  const hosts = fs.readFileSync(path.join(HERE, "..", "..", "reference", "HOSTS.md"), "utf8");
  assert.match(hosts, /`never_pick`/);
});
