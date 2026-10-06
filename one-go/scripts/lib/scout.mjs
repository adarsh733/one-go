// lib/scout.mjs — the model scout: read each tool's own model list, compare it with the saved
// model cards, say why the cards are stale, and pick a model per tier from the cards.
//
// Where each list comes from:
//   claude      — the built-in aliases opus, sonnet, haiku (nothing to discover)
//   codex       — ~/.codex/models_cache.json, entries with visibility "list"
//   opencode    — `opencode models` output, kept to the named providers
//   antigravity — the fixed words flash_lite, flash, pro
//
// Every tool is read through a reader (`readers.<host>`), so tests inject their own and never
// call a real tool. A reader that throws, returns nothing, or lists no models makes the host
// `{ unavailable: "<one line why>" }` — reported, never thrown. An empty list is treated as a
// broken read, not as "this tool has no models".
//
// Card file (JSON):
//   { "version": 1, "hosts": { "<host>": { "fingerprint": "<listFingerprint>", "models": {
//       "<id>": { "tier_fit": [...], "good_at": [...], "weak_at": [...], "cost": "low|medium|high",
//                 "speed": "slow|medium|fast", "source": "<url>", "checked": "YYYY-MM-DD",
//                 "quality": 0-100, "quality_source": "<url>", "never_pick": "<why>" } } } } }
// `quality` / `quality_source` are optional: a number from ONE independent benchmark index and
// its web address. Numbers are compared only within one host. A card without `quality` is ranked
// by the price order and never outranks a card that has one (unless none in the tier has one).
// `never_pick` is optional: a one-line reason (e.g. the maker may train on prompts). A card that
// carries it is never chosen by "auto" or by a vanished-pin fallback; a pin the person wrote by
// hand is still honoured, because that is their explicit choice.
//
// No real model name lives in this file beyond the built-in claude aliases; real ids live only
// in a project's config.json and model-cards.json.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { TOOL_OWN_MODEL } from "./route.mjs";
import { today as todayString } from "./util.mjs";

export const TIERS = Object.freeze(["think", "build", "mechanical"]);
export const COSTS = Object.freeze(["low", "medium", "high"]);
export const SPEEDS = Object.freeze(["slow", "medium", "fast"]);
export const PREFERENCES = Object.freeze(["quality-where-it-counts", "quality", "cost"]);
export const DEFAULT_PREFERENCE = "quality-where-it-counts";
export const DEFAULT_MAX_AGE_DAYS = 14;
export const DEFAULT_OPENCODE_PROVIDERS = Object.freeze(["opencode", "opencode-go"]);
export const CARD_FIELDS = Object.freeze(["tier_fit", "good_at", "weak_at", "cost", "speed", "source", "checked"]);
/** Optional card fields: a 0-100 score from one independent benchmark index, and its web address. */
export const QUALITY_FIELDS = Object.freeze(["quality", "quality_source"]);
/** Optional card field: a one-line reason this model must never be picked automatically. */
export const NEVER_PICK_FIELD = "never_pick";

/** The card's never-pick reason, or null when it may be picked. */
export function neverPickOf(card) {
  return isPlainObject(card) && typeof card.never_pick === "string" && card.never_pick.trim()
    ? card.never_pick.trim() : null;
}
export const SCOUT_HOSTS = Object.freeze(["claude", "codex", "opencode", "antigravity"]);

const CLAUDE_ALIASES = Object.freeze(["opus", "sonnet", "haiku"]);
const ANTIGRAVITY_WORDS = Object.freeze(["flash_lite", "flash", "pro"]);
const CODEX_CACHE = "~/.codex/models_cache.json";

const isPlainObject = v => v != null && typeof v === "object" && !Array.isArray(v);
const oneLine = s => String(s == null ? "" : s).split(/\r?\n/).map(l => l.trim()).filter(Boolean)[0] || "";

// ---------------------------------------------------------------- readers (the real tools)

/** The real readers. Tests never use these; they pass their own `readers`. */
export const DEFAULT_READERS = Object.freeze({
  claude: () => CLAUDE_ALIASES.slice(),
  antigravity: () => ANTIGRAVITY_WORDS.slice(),
  codex: () => fs.readFileSync(path.join(os.homedir(), ".codex", "models_cache.json"), "utf8"),
  opencode: () => {
    const opts = { encoding: "utf8", timeout: 30000, windowsHide: true };
    // Windows finds the opencode .cmd shim only through a shell; one string, no argument list.
    const r = process.platform === "win32"
      ? spawnSync("opencode models", { ...opts, shell: true })
      : spawnSync("opencode", ["models"], opts);
    if (r.error) throw new Error(`could not run \`opencode models\`: ${oneLine(r.error.message)}`);
    if (r.status !== 0) {
      throw new Error(`\`opencode models\` exited ${r.status}${oneLine(r.stderr) ? `: ${oneLine(r.stderr)}` : ""}`);
    }
    return r.stdout;
  }
});

/** sha1 of the sorted ids (one per line) — the list's fingerprint. */
export function listFingerprint(ids) {
  const sorted = (ids || []).map(String).slice().sort();
  return crypto.createHash("sha1").update(sorted.join("\n")).digest("hex");
}

function fromWords(raw) {
  const words = Array.isArray(raw) ? raw : String(raw || "").split(/[\s,]+/);
  return words.map(w => (isPlainObject(w) ? w : { id: String(w).trim(), description: "" }))
    .filter(m => m.id);
}

function parseCodex(raw) {
  const data = typeof raw === "string" ? JSON.parse(raw) : raw;
  const entries = Array.isArray(data) ? data : data && Array.isArray(data.models) ? data.models : null;
  if (!entries) throw new Error("the models cache has no models array");
  return entries
    .filter(e => isPlainObject(e) && e.visibility === "list")
    .map(e => ({ id: String(e.slug || e.id || "").trim(), description: String(e.description || e.display_name || "") }))
    .filter(m => m.id);
}

function parseOpencode(raw, providers) {
  const keep = new Set(providers);
  return String(raw || "").split(/\r?\n/).map(l => l.trim())
    .filter(l => /^[^\s/]+\/\S+$/.test(l))
    .filter(l => keep.has(l.slice(0, l.indexOf("/"))))
    .map(id => ({ id, description: "" }));
}

const SOURCES = {
  claude: "the built-in aliases",
  antigravity: "the fixed model words",
  codex: `${CODEX_CACHE} (visibility: list)`,
  opencode: "`opencode models`"
};

/**
 * One host's model list, read through its reader.
 * @param {string} host
 * @param {{ readers?: object, providers?: string[] }} opts  providers = opencode providers kept
 * @returns {{ models: {id:string, description:string}[], source: string, fingerprint: string, exhaustive: boolean }
 *          | { unavailable: string }}
 */
export function readHostModels(host, { readers = {}, providers } = {}) {
  const reader = (readers && readers[host]) || DEFAULT_READERS[host];
  if (!reader) return { unavailable: `no model list is known for the host "${host}"` };
  let raw;
  try {
    raw = reader();
  } catch (e) {
    return { unavailable: `${host}: ${oneLine(e && e.message) || "the reader failed"}` };
  }
  if (raw == null) return { unavailable: `${host}: the reader returned nothing` };
  let models;
  try {
    if (host === "codex") models = parseCodex(raw);
    else if (host === "opencode") {
      const keep = Array.isArray(providers) && providers.length ? providers : DEFAULT_OPENCODE_PROVIDERS;
      models = parseOpencode(raw, keep);
    } else models = fromWords(raw);
  } catch (e) {
    return { unavailable: `${host}: could not read the model list (${oneLine(e && e.message)})` };
  }
  const seen = new Set();
  models = models.filter(m => (seen.has(m.id) ? false : (seen.add(m.id), true)));
  if (!models.length) {
    const why = host === "opencode" ? " for the kept providers" : "";
    return { unavailable: `${host}: the model list was read but named no models${why}` };
  }
  return {
    models,
    source: SOURCES[host] || `the ${host} reader`,
    fingerprint: listFingerprint(models.map(m => m.id)),
    // claude also takes full model ids beyond its aliases, so a pin outside the list is not proof
    // the pin vanished; every other host's list is the whole set it accepts.
    exhaustive: host !== "claude"
  };
}

// ---------------------------------------------------------------- the card file

export class CardsError extends Error {
  constructor(message, file) { super(message); this.name = "CardsError"; this.file = file || null; }
}

/**
 * Read the card file. Missing file → null. Bad JSON or the wrong top-level shape → CardsError
 * (one line). Field-level gaps are not thrown — `cardProblems` lists them.
 */
export function loadCards(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    throw new CardsError(`${file}: could not be read (${oneLine(e && e.message)})`, file);
  }
  let data;
  try {
    data = JSON.parse(text.replace(/^﻿/, ""));
  } catch (e) {
    throw new CardsError(`${file}: is not valid JSON (${oneLine(e && e.message)})`, file);
  }
  if (!isPlainObject(data)) throw new CardsError(`${file}: the top level must be a JSON object`, file);
  if (data.version !== 1) throw new CardsError(`${file}: "version" must be 1`, file);
  if (!isPlainObject(data.hosts)) throw new CardsError(`${file}: "hosts" must be an object`, file);
  return data;
}

const isDate = s => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const isUrl = s => typeof s === "string" && /^https?:\/\/\S+$/.test(s.trim());
const isStrList = v => Array.isArray(v) && v.every(x => typeof x === "string");
const isQuality = v => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100;

/** The card's quality score, or null when it has none (or an unusable one). */
export function qualityOf(card) {
  return isPlainObject(card) && isQuality(card.quality) ? card.quality : null;
}

/** How many cards in the file carry no usable quality score: { missing, total }. */
export function qualityGaps(cards) {
  let missing = 0, total = 0;
  if (!cards || !isPlainObject(cards.hosts)) return { missing, total };
  for (const entry of Object.values(cards.hosts)) {
    if (!isPlainObject(entry) || !isPlainObject(entry.models)) continue;
    for (const card of Object.values(entry.models)) {
      if (!isPlainObject(card)) continue;
      total += 1;
      if (qualityOf(card) == null) missing += 1;
    }
  }
  return { missing, total };
}

/** Every field-level gap in a card file, one line each. Empty = every card is complete. */
export function cardProblems(cards) {
  const out = [];
  if (!cards || !isPlainObject(cards.hosts)) return ["the card file has no hosts"];
  for (const [host, entry] of Object.entries(cards.hosts)) {
    if (!isPlainObject(entry)) { out.push(`${host}: the host entry must be an object`); continue; }
    if (typeof entry.fingerprint !== "string" || !entry.fingerprint) out.push(`${host}: no fingerprint`);
    if (!isPlainObject(entry.models)) { out.push(`${host}: "models" must be an object`); continue; }
    for (const [id, card] of Object.entries(entry.models)) {
      const at = `${host}/${id}`;
      if (!isPlainObject(card)) { out.push(`${at}: the card must be an object`); continue; }
      for (const f of CARD_FIELDS) if (!(f in card)) out.push(`${at}: missing "${f}"`);
      if ("tier_fit" in card && !(Array.isArray(card.tier_fit) && card.tier_fit.length &&
          card.tier_fit.every(t => TIERS.includes(t)))) {
        out.push(`${at}: "tier_fit" must list one or more of ${TIERS.join(", ")}`);
      }
      if ("good_at" in card && !isStrList(card.good_at)) out.push(`${at}: "good_at" must be a list of words`);
      if ("weak_at" in card && !isStrList(card.weak_at)) out.push(`${at}: "weak_at" must be a list of words`);
      if ("cost" in card && !COSTS.includes(card.cost)) out.push(`${at}: "cost" must be ${COSTS.join(", ")}`);
      if ("speed" in card && !SPEEDS.includes(card.speed)) out.push(`${at}: "speed" must be ${SPEEDS.join(", ")}`);
      if ("source" in card && !isUrl(card.source)) out.push(`${at}: "source" must be a web address (http/https)`);
      if ("checked" in card && !isDate(card.checked)) out.push(`${at}: "checked" must be a date YYYY-MM-DD`);
      if ("quality" in card && !isQuality(card.quality)) out.push(`${at}: "quality" must be a number from 0 to 100`);
      if ("quality_source" in card && !isUrl(card.quality_source)) {
        out.push(`${at}: "quality_source" must be a web address (http/https)`);
      }
      if ("quality" in card && !("quality_source" in card)) out.push(`${at}: "quality" needs a "quality_source" web address`);
      if ("never_pick" in card && neverPickOf(card) == null) out.push(`${at}: "never_pick" must be a one-line reason`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- staleness

function dayNumber(d) {
  const s = d instanceof Date ? todayString(d) : String(d);
  return Math.floor(Date.parse(`${s}T00:00:00Z`) / 86400000);
}

/**
 * Why the cards are stale, one line per reason (empty = fresh).
 * @param cards   loadCards result (null = no card file)
 * @param lists   { <host>: readHostModels result } — the hosts in use; unavailable ones are skipped
 * @param opts    { maxAgeDays = 14, today = now (YYYY-MM-DD or Date) }
 */
export function staleCards(cards, lists, { maxAgeDays = DEFAULT_MAX_AGE_DAYS, today } = {}) {
  if (!cards || !isPlainObject(cards.hosts)) return ["there is no model-cards file"];
  const now = dayNumber(today == null ? new Date() : today);
  const limit = Number.isFinite(Number(maxAgeDays)) ? Number(maxAgeDays) : DEFAULT_MAX_AGE_DAYS;
  const out = [];
  for (const [host, list] of Object.entries(lists || {})) {
    if (!list || !Array.isArray(list.models)) continue;          // unreadable tool: reported elsewhere
    const entry = cards.hosts[host];
    if (!isPlainObject(entry) || !isPlainObject(entry.models)) { out.push(`${host} has no model cards`); continue; }
    const fp = list.fingerprint || listFingerprint(list.models.map(m => m.id));
    if (entry.fingerprint !== fp) out.push(`${host}'s model list changed since the cards were written`);
    for (const { id } of list.models) {
      const card = entry.models[id];
      if (!isPlainObject(card)) { out.push(`${host}/${id} has no card`); continue; }
      if (!isDate(card.checked)) { out.push(`${host}/${id} card has no checked date`); continue; }
      const age = now - dayNumber(card.checked);
      if (age > limit) out.push(`${host}/${id} card is ${age} days old (limit ${limit})`);
    }
  }
  return out;
}

/** The exact stale-cards warning line for one or more reasons. */
export function staleWarning(reasons) {
  const list = Array.isArray(reasons) ? reasons : [reasons];
  return `WARNING: model cards are stale (${list.join("; ")}) — run board.mjs models before the next dispatch.`;
}

// ---------------------------------------------------------------- picking

const rank = (arr, v) => { const i = arr.indexOf(v); return i < 0 ? 1 : i; };   // unknown → middle
/** The price-order fallback for a card with no quality: cost first, then good_at vs weak_at. */
const strength = c => rank(COSTS, c.cost) * 100 + ((c.good_at || []).length - (c.weak_at || []).length);
const cheapness = c => (2 - rank(COSTS, c.cost)) * 10 + rank(SPEEDS, c.speed);
/** Measured quality first: a card with a score always beats one without; higher score wins. */
const byQuality = (a, b) => {
  const qa = qualityOf(a), qb = qualityOf(b);
  if (qa == null && qb == null) return 0;
  if (qa == null) return 1;
  if (qb == null) return -1;
  return qb - qa;
};

function listIds(list) {
  if (!list) return null;
  if (Array.isArray(list)) return list.map(m => (typeof m === "string" ? m : m && m.id)).filter(Boolean);
  if (Array.isArray(list.models)) return list.models.map(m => m.id);
  return null;                                                   // unavailable: fall back to the cards
}

/** What a preference asks of one tier: "best", "balanced" or "cheapest". */
export function wantFor(tier, preference = DEFAULT_PREFERENCE) {
  const p = PREFERENCES.includes(preference) ? preference : DEFAULT_PREFERENCE;
  if (p === "quality") return "best";
  if (p === "cost") return "cheapest";
  return tier === "think" ? "best" : tier === "build" ? "balanced" : "cheapest";
}

/**
 * The cards' pick for one tier on one host, or null when no card fits.
 * @param {{ list?: object|string[], cards: object, preference?: string }} opts
 *   list = readHostModels result (or ids); when it is missing/unavailable the cards alone are used.
 * @returns {{ model: string, why: string } | null}
 */
export function pickForTier(host, tier, { list, cards, preference = DEFAULT_PREFERENCE } = {}) {
  const entry = cards && isPlainObject(cards.hosts) ? cards.hosts[host] : null;
  if (!isPlainObject(entry) || !isPlainObject(entry.models)) return null;
  const ids = listIds(list);
  const allowed = ids ? new Set(ids) : null;
  const fits = Object.entries(entry.models)
    .filter(([id, c]) => isPlainObject(c) && (!allowed || allowed.has(id)))
    .filter(([, c]) => Array.isArray(c.tier_fit) && c.tier_fit.includes(tier))
    .filter(([, c]) => neverPickOf(c) == null);                  // never_pick: never chosen automatically
  if (!fits.length) return null;
  const want = wantFor(tier, preference);
  const byId = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  // best     = highest quality; no-quality cards after, in the old price order.
  // balanced = highest quality among the low/medium-cost cards (any card when none is low/medium);
  //            no-quality cards after, nearest medium cost first.
  // cheapest = lowest cost; ties broken by quality, then speed.
  const sorters = {
    best: (a, b) => byQuality(a[1], b[1]) || strength(b[1]) - strength(a[1]) ||
      cheapness(b[1]) - cheapness(a[1]) || byId(a, b),
    balanced: (a, b) => byQuality(a[1], b[1]) ||
      Math.abs(rank(COSTS, a[1].cost) - 1) - Math.abs(rank(COSTS, b[1].cost) - 1) ||
      strength(b[1]) - strength(a[1]) || byId(a, b),
    cheapest: (a, b) => rank(COSTS, a[1].cost) - rank(COSTS, b[1].cost) || byQuality(a[1], b[1]) ||
      rank(SPEEDS, b[1].speed) - rank(SPEEDS, a[1].speed) || strength(b[1]) - strength(a[1]) || byId(a, b)
  };
  let pool = fits;
  if (want === "balanced") {
    const notDear = fits.filter(([, c]) => rank(COSTS, c.cost) <= 1);
    if (notDear.length) pool = notDear;
  }
  const [model, card] = pool.slice().sort(sorters[want])[0];
  const label = { best: "strongest", balanced: "most balanced", cheapest: "cheapest" }[want];
  const p = PREFERENCES.includes(preference) ? preference : DEFAULT_PREFERENCE;
  const q = qualityOf(card);
  return {
    model,
    why: `${label} of ${fits.length} carded model${fits.length === 1 ? "" : "s"} that fit ${tier} ` +
      `(${q == null ? "no quality score" : `quality ${q}`}, cost ${card.cost || "?"}, speed ${card.speed || "?"}; ` +
      `preference ${p})`
  };
}

/** The exact vanished-pin warning line. */
export function vanishedWarning(model, host, fallback, tier) {
  return `WARNING: ${model} is no longer in ${host}'s model list — using ${fallback} for ${tier} instead.`;
}

/**
 * The model to run for a pinned tier. "auto" = the cards' pick. A pin still in the list is kept.
 * A pin that has vanished → the cards' pick for that tier → no model named (the tool's own model
 * runs), with the exact warning line. A run never stops for a model reason.
 * @returns {{ model: string|null, warning: string|null }}
 */
export function resolvePin(host, tier, pinned, { list, cards, preference = DEFAULT_PREFERENCE } = {}) {
  const pin = pinned == null ? "" : String(pinned).trim();
  if (pin === "auto") {
    const pick = pickForTier(host, tier, { list, cards, preference });
    return { model: pick ? pick.model : null, warning: null };
  }
  if (!pin) return { model: null, warning: null };
  const ids = listIds(list);
  if (!ids) return { model: pin, warning: null };                // tool unreadable: cannot judge
  if (ids.includes(pin)) return { model: pin, warning: null };
  if (list && !Array.isArray(list) && list.exhaustive === false) return { model: pin, warning: null };
  const pick = pickForTier(host, tier, { list, cards, preference });
  const model = pick && pick.model !== pin ? pick.model : null;
  return { model, warning: vanishedWarning(pin, host, model || TOOL_OWN_MODEL, tier) };
}
