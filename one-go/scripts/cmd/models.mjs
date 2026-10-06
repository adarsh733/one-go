// cmd/models.mjs — the model scout's plumbing: `board.mjs models` and `board.mjs models --check`.
// Never a public `/one-go` row (the public menu is dispatch, stop, help).
//
//   models            prints each host's model list, the card status, and which models need researching
//   models --check    the same, and exits 1 when the cards are stale or missing for the hosts in use
//   models --host <h> (repeatable) look at those hosts only
//
// Also the one place that READS the tools and the card file for the rest of the engine:
// `readScout` (start.mjs, one host) and `cardsStatus` (dispatch-seal.mjs, the hosts in use).
// lib/route.mjs and lib/scout.mjs stay free of reading: lists and cards are passed in.
//
// The scout is on only when config.model_cards names a card file. With it unset nothing here reads
// a tool, so a project that never opted in sees no change at all.
import path from "node:path";
import { resolveHousePath } from "../lib/config.mjs";
import {
  readHostModels, loadCards, staleCards, staleWarning, SCOUT_HOSTS, CardsError,
  DEFAULT_MAX_AGE_DAYS, DEFAULT_PREFERENCE, DEFAULT_OPENCODE_PROVIDERS
} from "../lib/scout.mjs";
import { TIER_IDS, isUnsetModel } from "../lib/route.mjs";
import { argValues } from "../lib/util.mjs";

const isPlainObject = v => v != null && typeof v === "object" && !Array.isArray(v);

/** The scout settings with the defaults filled in (config may be `{}` in a test). */
export function scoutSettings(config) {
  const s = isPlainObject(config && config.model_scout) ? config.model_scout : {};
  return {
    maxAgeDays: Number.isInteger(s.max_age_days) ? s.max_age_days : DEFAULT_MAX_AGE_DAYS,
    preference: typeof s.preference === "string" && s.preference ? s.preference : DEFAULT_PREFERENCE,
    providers: Array.isArray(s.opencode_providers) && s.opencode_providers.length
      ? s.opencode_providers : [...DEFAULT_OPENCODE_PROVIDERS]
  };
}

/** Is the scout on? Only when the project names a card file. */
export function scoutOn(config) {
  return Boolean(config && typeof config.model_cards === "string" && config.model_cards.trim());
}

/** Does this host take its models from the cards? It must be a scoutable tool the config sets a tier for. */
export function cardsMatter(config, host) {
  if (!SCOUT_HOSTS.includes(host)) return false;
  const h = config && isPlainObject(config.hosts) ? config.hosts[host] : null;
  return isPlainObject(h) && TIER_IDS.some(id => !isUnsetModel(h[id]));
}

/** The hosts whose cards matter in this project: every scoutable host the config sets a tier for. */
export function hostsInUse(config) {
  const hosts = config && isPlainObject(config.hosts) ? Object.keys(config.hosts) : [];
  const out = hosts.filter(h => !h.startsWith("_") && cardsMatter(config, h));
  const d = config && config.default_host;
  if (d && cardsMatter(config, d) && !out.includes(d)) out.push(d);
  return out;
}

/**
 * Read the card file and the named hosts' lists, once each.
 * @returns {{ file: string|null, cards: object|null, cardsError: string|null,
 *             lists: Record<string, object>, reasons: string[], settings: object }}
 *   reasons = why the cards are stale, one line each (empty = fresh). `file` null = the scout is off.
 */
export function gatherScout({ config, root, hosts, readers }) {
  const settings = scoutSettings(config);
  const file = scoutOn(config) ? resolveHousePath(config.model_cards, root || undefined) : null;
  if (!file) return { file: null, cards: null, cardsError: null, lists: {}, reasons: [], settings };
  let cards = null, cardsError = null;
  try {
    cards = loadCards(file);
  } catch (e) {
    cardsError = e instanceof CardsError ? e.message : `${file}: could not be read (${e && e.message})`;
  }
  const lists = {};
  for (const h of hosts || []) lists[h] = readHostModels(h, { readers, providers: settings.providers });
  const reasons = cardsError
    ? [`the model-cards file cannot be read: ${cardsError}`]
    : staleCards(cards, lists, { maxAgeDays: settings.maxAgeDays });
  return { file, cards, cardsError, lists, reasons, settings };
}

/**
 * What `start` needs for the run's own host: the host's list read once, the cards, and the warnings.
 * Returns null when the scout is off or this host does not take its models from the cards.
 * @returns {{ list: object, cards: object|null, preference: string, warnings: string[], file: string } | null}
 */
export function readScout({ config, root, host, readers }) {
  if (!scoutOn(config) || !cardsMatter(config, host)) return null;
  const g = gatherScout({ config, root, hosts: [host], readers });
  const list = g.lists[host];
  const warnings = [];
  if (list && list.unavailable) {
    warnings.push(`WARNING: ${host}'s model list could not be read (${list.unavailable}) — pinned models are used as written, and "auto" falls back to the cards alone.`);
  }
  if (g.reasons.length) warnings.push(staleWarning(g.reasons));
  return { list, cards: g.cards, preference: g.settings.preference, warnings, file: g.file };
}

const MAX_REASONS = 3;
const brief = reasons => reasons.length <= MAX_REASONS
  ? reasons.join("; ")
  : `${reasons.slice(0, MAX_REASONS).join("; ")}; and ${reasons.length - MAX_REASONS} more`;

/**
 * Are the cards fresh for the hosts in use? One answer for the seal brief.
 * @returns {{ state: "off"|"none"|"fresh"|"stale", reasons: string[], hosts: string[], unread: string[] }}
 *   off = no model_cards set · none = no host takes its models from the cards · stale/fresh otherwise
 */
export function cardsStatus({ config, root, readers, hosts }) {
  if (!scoutOn(config)) return { state: "off", reasons: [], hosts: [], unread: [] };
  const use = (hosts && hosts.length ? hosts : hostsInUse(config));
  if (!use.length) return { state: "none", reasons: [], hosts: [], unread: [] };
  const g = gatherScout({ config, root, hosts: use, readers });
  const unread = use.filter(h => g.lists[h] && g.lists[h].unavailable);
  return { state: g.reasons.length ? "stale" : "fresh", reasons: g.reasons, hosts: use, unread };
}

/** The one line a seal brief carries about the cards (dispatch-seal.mjs). */
export function sealCardsLine(status) {
  if (!status || status.state === "off") {
    return "Model cards: not in use in this project (config.json has no `model_cards`) — no refresh question needed.";
  }
  if (status.state === "none") {
    return "Model cards: no tool in this project takes its models from the cards — no refresh question needed.";
  }
  if (status.state === "fresh") {
    const note = status.unread.length ? ` (could not read ${status.unread.join(", ")} — not checked)` : "";
    return `Model cards: fresh for ${status.hosts.join(", ")}${note} — no refresh question needed.`;
  }
  return `Model cards: STALE (${brief(status.reasons)}) — add one question to \`## Open questions\`: ` +
    "refresh the model cards before the run? A ★ yes, refresh them first (`board.mjs models`, then a research pass) · " +
    "B no, run on the old cards. *Trade-off: a refresh costs one research pass; old cards can pick a model the tool no longer lists or miss a new one.*";
}

// ---------------------------------------------------------------- the command

function cardState(entry, id, aged) {
  const card = entry && isPlainObject(entry.models) ? entry.models[id] : null;
  if (!isPlainObject(card)) return { ok: false, text: "NEEDS RESEARCH — no card" };
  if (typeof card.checked !== "string") return { ok: false, text: "NEEDS RESEARCH — card has no checked date" };
  if (aged.has(id)) return { ok: false, text: `NEEDS RESEARCH — card is ${aged.get(id)} days old` };
  return { ok: true, text: `card ok (checked ${card.checked})` };
}

/**
 * `board.mjs models [--check] [--host <h> …]`. Returns the exit code.
 * Plain `models` is a report and exits 0; `--check` exits 1 when the cards are stale or missing.
 */
export function runModels({ ARGV, config, root, readers }) {
  const rest = ARGV.slice(1);
  const check = rest.includes("--check");
  const named = argValues(rest, "--host").flatMap(h => String(h).split(",")).map(h => h.trim()).filter(Boolean);
  const bad = named.filter(h => !SCOUT_HOSTS.includes(h));
  if (bad.length) {
    console.log(`No model list is known for ${bad.join(", ")} — the tools it reads are: ${SCOUT_HOSTS.join(", ")}.`);
    return 1;
  }
  const settings = scoutSettings(config);
  if (!scoutOn(config)) {
    console.log("Model cards are not in use here: config.json has no `model_cards` path. Nothing to check.");
    if (!named.length) return 0;
  }
  const inUse = hostsInUse(config);
  const hosts = named.length ? named : inUse.length ? inUse : SCOUT_HOSTS.slice();
  const g = scoutOn(config)
    ? gatherScout({ config, root, hosts, readers })
    : { file: null, cards: null, cardsError: null, lists: Object.fromEntries(hosts.map(h => [h, readHostModels(h, { readers, providers: settings.providers })])), reasons: [], settings };

  if (g.file) {
    const where = path.relative(root || process.cwd(), g.file) || g.file;
    console.log(`**Model cards:** \`${where}\` — ${g.cardsError ? "cannot be read" : g.cards ? "found" : "missing"}; ` +
      `older than ${settings.maxAgeDays} days counts as stale; preference ${settings.preference}.`);
  }
  if (!inUse.length && g.file) console.log("(No host in config.json takes its models from the cards, so every tool is shown.)");

  const aged = new Map();      // host -> Map(model id -> age in days), from the stale reasons
  for (const r of g.reasons) {
    const m = /^([^/\s]+)\/(\S+) card is (\d+) days old/.exec(r);
    if (m) { if (!aged.has(m[1])) aged.set(m[1], new Map()); aged.get(m[1]).set(m[2], m[3]); }
  }
  const needs = [];
  for (const host of hosts) {
    const list = g.lists[host];
    if (!list || !Array.isArray(list.models)) {
      console.log(`\n**${host}** — could not be read: ${(list && list.unavailable) || "no list"}`);
      continue;
    }
    console.log(`\n**${host}** — ${list.models.length} model${list.models.length === 1 ? "" : "s"}, from ${list.source}`);
    const entry = g.cards && isPlainObject(g.cards.hosts) ? g.cards.hosts[host] : null;
    for (const { id } of list.models) {
      const st = g.file ? cardState(entry, id, aged.get(host) || new Map()) : { ok: false, text: "no card file set" };
      console.log(`- ${id} — ${st.text}`);
      if (g.file && !st.ok) needs.push(`${host}/${id}`);
    }
    if (entry && isPlainObject(entry.models)) {
      const listed = new Set(list.models.map(m => m.id));
      const gone = Object.keys(entry.models).filter(id => !listed.has(id));
      if (gone.length) console.log(`- cards for models the tool no longer lists (can be dropped): ${gone.join(", ")}`);
    }
  }

  if (!g.file) return 0;
  const all = needs;
  console.log("");
  if (all.length) console.log(`**Needs researching (${all.length}):** ${all.join(", ")}`);
  else console.log("**Needs researching:** nothing — every listed model has a current card.");
  if (g.reasons.length) {
    console.log(`**Cards are stale:** ${brief(g.reasons)}`);
    if (!check) console.log("Refresh them (a research pass on the think tier), then run `board.mjs models --check`.");
  } else {
    console.log("**Cards are fresh.**");
  }
  return check && g.reasons.length ? 1 : 0;
}
