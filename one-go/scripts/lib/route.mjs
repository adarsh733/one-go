// lib/route.mjs — which model runs which pass, and the reason, in one place.
//
// WHY THIS FILE EXISTS
// The tier table lived in prose documents and nowhere in the code. `start` took whatever word was typed in the plan's Model column,
// lowercased it, stripped the spaces, and wrote it into state.json. So "a versioned name", "Sonnet",
// an old family word and a typo were four different values, none of them checked against anything,
// and a pass's model was never justified — it was just a string somebody typed.
//
// Two honesty rules this file exists to keep:
//   1. Partition the work FIRST, choose a model SECOND. Never invent a third pass so that three
//      model names can appear. `suggestTier` is called on passes that already exist.
//   2. A model name written into a state file is NOT proof that model ran. Requested and
//      confirmed are stored separately, and an unconfirmed route says so out loud.
//
// TIERS AND HOSTS (dev/CONTRACT-2.md §3, §4)
// `think`, `build`, `mechanical` are the only model words in the core. The core ships ONE host,
// `claude`, with the Agent tool's own aliases (`opus` / `sonnet` / `haiku`, which always mean the
// newest model of each family) as its only built-in default. Every other host, and every model
// name, comes from the project's config.json `hosts` block. A brand-new model name needs one
// config line and never a code change. A host with no model for a tier gets NO model named: the
// tool's own configured model runs.

// The model scout (lib/scout.mjs) answers "auto" and "this pin has vanished". Its functions are
// pure — the lists and cards are read by the caller and passed in, so this file reads nothing.
import { resolvePin } from "./scout.mjs";

/** The tier table: id, label, when to use it, effort. No host, no model name. */
export const TIERS = Object.freeze({
  think: Object.freeze({
    id: "think",
    label: "Think & decide",
    when: "diagnosis, architecture, plans, contracts, reviewing another agent's output",
    effort: "High"
  }),
  build: Object.freeze({
    id: "build",
    label: "Build to an approved plan",
    when: "bounded work where the decisions are already made",
    effort: "Medium"
  }),
  mechanical: Object.freeze({
    id: "mechanical",
    label: "Mechanical",
    when: "moving files, renames, docs, running an established check",
    effort: "Low"
  })
});

export const TIER_IDS = Object.freeze(["think", "build", "mechanical"]);
const TIER_FIELDS = ["label", "when", "effort"];

/** The core's single built-in default: host `claude`, the Agent tool's aliases. */
export const DEFAULT_HOSTS = Object.freeze({
  claude: Object.freeze({ think: "opus", build: "sonnet", mechanical: "haiku" })
});

/** Host names the engine always knows. Any key of config.hosts is known as well. */
export const BUILTIN_HOSTS = Object.freeze(["claude", "codex", "antigravity", "opencode", "inline"]);

/** What a route says when no model is named: the tool's own configured model runs. */
export const TOOL_OWN_MODEL = "the tool's own model";

/**
 * A configured host model that is empty, or wrapped in angle brackets (`<your model>`, the
 * shipped example's placeholder), means "not set". It is never passed to a tool as a model name.
 */
export function isUnsetModel(v) {
  if (typeof v !== "string") return true;
  const s = v.trim();
  return s === "" || /^<.*>$/.test(s);
}

/** The tier value that asks the scout to pick from the model cards (`hosts.<host>.<tier>: "auto"`). */
export const AUTO_MODEL = "auto";

/** Is this config value the word "auto"? (Not a model name — never passed to a tool.) */
export function isAutoModel(v) {
  return typeof v === "string" && v.trim().toLowerCase() === AUTO_MODEL;
}

const isPlainObject = v => v != null && typeof v === "object" && !Array.isArray(v);
const squash = v => String(v == null ? "" : v).toLowerCase().replace(/\s+/g, "");

function configHosts(config) {
  return isPlainObject(config && config.hosts) ? config.hosts : {};
}

/**
 * The tier table with a house config laid over it. Each entry is
 *   { id, label, when, effort, models: { <host>: "<model name>" } }
 * `models` holds only hosts that name a model for that tier: `claude`'s built-in aliases, then
 * anything `config.hosts.<host>.<tier>` sets (an unset value — empty or `<placeholder>` — is
 * skipped, so the built-in or the tool's own model stays in force).
 *   config.tiers = { <tier>: { label?, when?, effort? } }   partial override per tier.
 * Unknown tiers and fields are ignored. Never mutates TIERS. No config → the core defaults.
 */
export function tiersFor(config) {
  const out = {};
  for (const [id, t] of Object.entries(TIERS)) {
    out[id] = { ...t, models: {} };
    for (const [host, names] of Object.entries(DEFAULT_HOSTS)) out[id].models[host] = names[id];
  }
  const tiers = isPlainObject(config && config.tiers) ? config.tiers : {};
  for (const [id, over] of Object.entries(tiers)) {
    if (!out[id] || !isPlainObject(over)) continue;
    for (const f of TIER_FIELDS) if (typeof over[f] === "string" && over[f]) out[id][f] = over[f];
  }
  for (const [host, models] of Object.entries(configHosts(config))) {
    if (!isPlainObject(models) || host.startsWith("_")) continue;
    // "auto" is a request to the scout, not a model name: until a caller has resolved it
    // (resolveScoutModels / withScoutModels) it names no model, so the built-in or the tool's own runs.
    for (const id of TIER_IDS) if (!isUnsetModel(models[id]) && !isAutoModel(models[id])) out[id].models[host] = models[id].trim();
  }
  return out;
}

/**
 * What the scout makes of one host's three tiers.
 *   scout = { list, cards, preference }   list = readHostModels result (or ids); cards = loadCards
 *           result; null/absent = the scout is off (no model_cards file is set).
 * Per tier:
 *   "auto"            → the cards' pick; none fits → no model named (claude: its built-in alias)
 *   a model name      → kept while the tool still lists it; gone from the list → the cards' pick for
 *                       the tier, else no model named, with the exact vanished-pin WARNING line
 *   nothing set       → whatever tiersFor gives (claude's alias, or no model named)
 * The scout is never run for `inline` or for a scout-less call, so nothing here reads a tool.
 * @returns {{ models: Record<string, string|null>, warnings: string[], auto: string[] }}
 *   `auto` lists the tiers whose value is "auto" (the caller says so when no scout was given).
 */
export function resolveScoutModels(config, host, scout) {
  const table = tiersFor(config);
  const raw = isPlainObject(configHosts(config)[host]) ? configHosts(config)[host] : {};
  const models = {}, warnings = [], auto = [];
  const live = Boolean(scout) && host !== "inline" && !runsInline(host, config);
  for (const id of TIER_IDS) {
    const base = modelFor(table, id, host);
    const pin = raw[id];
    if (isAutoModel(pin)) {
      auto.push(id);
      if (!live) { models[id] = base; continue; }
      const r = resolvePin(host, id, AUTO_MODEL, scout);
      models[id] = r.model || (host === "claude" ? DEFAULT_HOSTS.claude[id] : null);
      continue;
    }
    if (!live || isUnsetModel(pin)) { models[id] = base; continue; }
    const r = resolvePin(host, id, pin.trim(), scout);
    models[id] = r.model;
    if (r.warning) warnings.push(r.warning);
  }
  return { models, warnings, auto };
}

/**
 * A copy of the config with one host's tier models replaced by what the scout resolved, so
 * everything downstream (routeFor, the map, the briefs) reads plain model names and never "auto".
 * A tier the scout left without a model is written as "" — unset, so the tool's own model runs.
 */
export function withScoutModels(config, host, models) {
  const hosts = { ...configHosts(config) };
  const mine = { ...(isPlainObject(hosts[host]) ? hosts[host] : {}) };
  for (const id of TIER_IDS) if (id in models) mine[id] = models[id] || "";
  hosts[host] = mine;
  return { ...(config || {}), hosts };
}

/** The model a host uses for a tier, or null when none is named (the tool's own model runs). */
export function modelFor(table, tier, host) {
  const m = table && table[tier] && table[tier].models && table[tier].models[host];
  return isUnsetModel(m) ? null : m;
}

/** Does this host need approval when a helper starts? (config.hosts.<host>.requires_approval) */
export function hostNeedsApproval(host, config) {
  const h = configHosts(config)[host];
  return Boolean(h && h.requires_approval === true);
}

/** The host names this project knows: the five built in plus every key of config.hosts. */
export function knownHosts(config) {
  const out = [...BUILTIN_HOSTS];
  for (const k of Object.keys(configHosts(config))) if (!k.startsWith("_") && !out.includes(k)) out.push(k);
  return out;
}

/** Does a pass on this host run inline (the conductor does it itself, one at a time)? */
export function runsInline(host, config) {
  if (host === "inline") return true;
  const h = configHosts(config)[host];
  return Boolean(h && h.helpers === false);
}

/**
 * A host whose passes are started through the worker adapter (`board.mjs worker …`): any host
 * that is neither the Agent tool (`claude`) nor `inline`.
 */
export function isWorkerHost(host, config) {
  return Boolean(host) && host !== "claude" && !runsInline(host, config);
}

/**
 * Which host a run uses — the first of these that says something wins (CONTRACT-2 §4):
 *   1. `flag`  (--host on start / pass / brief)   2. `plan`  (planHost(plan): route_policy.host of a plan this engine wrote)
 *   3. `env`   (ONEGO_HOST)                       4. config.default_host      5. claude.
 * A host that cannot start helpers (`helpers: false`) is recorded as `inline`.
 * An unknown name → { error: "<one line listing the known hosts>" }.
 * @returns {{ host: string, source: string, asked?: string } | { error: string }}
 */
export function chooseHost({ flag, plan, env, config } = {}) {
  const tries = [["--host", flag], ["the plan", plan], ["ONEGO_HOST", env], ["default_host", config && config.default_host]];
  let asked = null, source = "default";
  for (const [src, v] of tries) {
    const name = String(v == null ? "" : v).trim().toLowerCase();
    if (name) { asked = name; source = src; break; }
  }
  if (!asked) return { host: "claude", source };
  const known = knownHosts(config);
  const match = known.find(k => k.toLowerCase() === asked);
  if (!match) return { error: `Unknown host "${asked}" (from ${source}) — known hosts: ${known.join(", ")}.` };
  if (runsInline(match, config) && match !== "inline") return { host: "inline", source, asked: match };
  return { host: match, source };
}

/**
 * Every plan.json THIS engine writes carries `engine: PLAN_ENGINE` (compat D11). The older engine
 * wrote `route_policy.host` ("codex" on every migration, "claude-code" on hand seals) and never
 * read it; such a value is history, not an instruction.
 */
export const PLAN_ENGINE = 2;

/** The host a plan names for chooseHost, or null — only a plan this engine wrote can name one. */
export function planHost(plan) {
  if (!plan || typeof plan !== "object" || !(Number(plan.engine) >= PLAN_ENGINE)) return null;
  const h = plan.route_policy && plan.route_policy.host;
  return h == null || h === "" ? null : h;
}

/** The model to NAME to a tool for this route, or null (the tool's own model runs). */
export function namedModel(route) {
  if (!route) return null;
  const m = route.model;
  if (isUnsetModel(m) || m === TOOL_OWN_MODEL || m === "unavailable") return null;
  return m;
}

// The model words older plans typed in the Model column, family words only — no version number.
// Every word of an entry must be present (as a whole word); the first entry that matches wins.
// This table only ever yields a TIER; the model name always comes from tiersFor().
export const LEGACY_MODEL_WORDS = Object.freeze([
  { words: ["gemini", "pro"], tier: "think" },
  { words: ["gemini", "lite"], tier: "mechanical" },
  { words: ["gemini"], tier: "build" },
  { words: ["opus"], tier: "think" },
  { words: ["sol"], tier: "think" },
  { words: ["sonnet"], tier: "build" },
  { words: ["terra"], tier: "build" },
  { words: ["haiku"], tier: "mechanical" },
  { words: ["luna"], tier: "mechanical" }
]);

const hasWord = (raw, w) => new RegExp(`(^|[^a-z])${w}([^a-z]|$)`).test(raw);

/**
 * Read whatever the plan's Model column said and map it onto a tier, in this order:
 *   1. a tier id (think / build / mechanical, any case);
 *   2. a model name configured under hosts.<host>.<tier> (or claude's built-in alias);
 *   3. the legacy family table LEGACY_MODEL_WORDS;
 *   4. anything else → null (an old run or board is shown as written; the seal gate refuses a NEW plan).
 */
export function tierFromText(text, { config } = {}) {
  const raw = String(text == null ? "" : text).toLowerCase().trim();
  if (!raw || isUnsetModel(raw)) return null;
  for (const id of TIER_IDS) if (hasWord(raw, id)) return id;
  const squashed = squash(raw);
  for (const t of Object.values(tiersFor(config))) {
    for (const m of Object.values(t.models)) if (squash(m) === squashed) return t.id;
  }
  for (const e of LEGACY_MODEL_WORDS) if (e.words.every(w => hasWord(raw, w))) return e.tier;
  return null;
}

/** Is this Model-cell text something the engine understands (a tier, a configured name, an old family word)? */
export function isKnownModelText(text, { config } = {}) {
  return tierFromText(text, { config }) !== null;
}

// Wording that reliably indicates the kind of work, drawn from how the plans are actually
// written. Deliberately short: this is a fallback for when the plan did not name a tier, not a
// pretence at understanding the work.
// Stems carry \w* on purpose: an earlier version wrote `\bdiagnos\b`, which cannot match
// "diagnose" — the word does not end there. That bug routed a diagnosis pass to the build
// tier, and it was only caught because a test asserted the top tier does not escalate.
const THINK_WORDS = /\b(design\w*|decide|decision|diagnos\w*|architect\w*|investigat\w*|review\w*|audit\w*|plan\w*|contract|choose|why|root cause|reconcile|assess\w*|judge\w*)\b/i;
const MECHANICAL_WORDS = /\b(rename\w*|move|copy|delete|format\w*|reformat|regenerat\w*|screenshot\w*|typo|bump|register|append|tidy|lint)\b|\brun (the|all|every)\b/i;

/**
 * Suggest a tier for a pass that did not name one, and always give the reason.
 *
 * The reason is stored on the pass and printed in the report, so a route can be argued with.
 * "Because a model was open" is never a reason this function can produce.
 */
export function suggestTier(pass, { dependantCount = 0 } = {}) {
  const text = `${pass.title || ""} ${pass.what || ""} ${pass.proven || ""}`;
  const fileCount = (pass.files || []).length;

  if (THINK_WORDS.test(text)) {
    return { tier: "think", reason: "the work is a judgement call, and a wrong answer here is expensive to undo" };
  }
  if (dependantCount >= 2) {
    return { tier: "think", reason: `${dependantCount} later passes build on this one, so a wrong result spreads` };
  }
  if (MECHANICAL_WORDS.test(text) && fileCount <= 3) {
    return { tier: "mechanical", reason: "a narrow, already-decided transformation" };
  }
  if (fileCount === 0) {
    return { tier: "mechanical", reason: "writes nothing — it runs a check and reports" };
  }
  return { tier: "build", reason: "bounded implementation against a plan that already settled the decisions" };
}

/**
 * The route for one pass: tier, the model name for the host in use, effort, and why.
 * `declared` is the plan's Model column — it wins when it is recognisable, because the person
 * sealed it. A model the plan names itself (`pass.route.requested_model`) is used as written
 * unless it is only a tier or old family word — those name a tier, not a model.
 * A host with no model for the tier gets no model named: the route says so and the tool's own
 * configured model runs. On `inline` the tier is advice only — the chat runs whatever it runs.
 */
export function routeFor(pass, { host = "claude", dependantCount = 0, config } = {}) {
  const table = tiersFor(config);
  const requested = pass.route?.requested_model;
  const requestedUsable = !isUnsetModel(requested);
  const declared = tierFromText(pass.model, { config })
    || (requestedUsable ? tierFromText(requested, { config }) : null);
  const picked = declared
    ? { tier: declared, reason: "named in the sealed plan" }
    : suggestTier(pass, { dependantCount });
  const t = table[picked.tier];
  let model = modelFor(table, picked.tier, host);
  let effort = t.effort;
  let reason = picked.reason;
  let named = Boolean(model);

  // A plan that names a real model (not a tier or family word) is followed as written.
  const hostNames = new Set(TIER_IDS.map(id => squash(table[id].models[host] || "")));
  const asWritten = requestedUsable
    && (tierFromText(requested, { config }) === null || hostNames.has(squash(requested)));
  if (asWritten) {
    model = requested;
    named = true;
    if (pass.route.requested_effort) effort = pass.route.requested_effort;
    if (pass.route.reason) reason = pass.route.reason;
  } else if (!model) {
    model = TOOL_OWN_MODEL;
    reason = `${reason}; no ${picked.tier} model is set for host "${host}", so its own configured model runs`;
  }
  if (host === "inline") reason = `${reason}; advice only — this chat runs whatever model it runs`;

  return {
    tier: t.id,
    host,
    model,
    named,
    effort,
    reason,
    declared: pass.model || null,
    confirmed: null            // filled in ONLY by a host that reports back what it actually ran
  };
}

/**
 * One step up when a pass fails for a reason that looks like the tier was too low.
 * Mechanical -> build -> think, and think does not escalate — there is nothing above it, and
 * pretending otherwise would just retry the same thing forever.
 */
export function escalate(route, why, { config } = {}) {
  const order = ["mechanical", "build", "think"];
  const i = order.indexOf(route.tier);
  if (i === -1 || i === order.length - 1) return null;
  const table = tiersFor(config);
  const next = table[order[i + 1]];
  const host = route.host || "claude";
  const nextModel = modelFor(table, next.id, host);

  return {
    ...route,
    tier: next.id,
    model: nextModel || TOOL_OWN_MODEL,
    named: Boolean(nextModel),
    effort: next.effort,
    reason: `escalated from ${route.tier}: ${why}`,
    escalated_from: route.tier,
    confirmed: null
  };
}

/**
 * The Agent tool's `model` for a route, worked out from its TIER. Claude's own aliases are the
 * default; a model the project configured under hosts.claude (or one the plan named that the
 * engine does not recognise) passes through. A tier word or old family word (an old plan's model cell) in an
 * old run's route maps back to the tier's alias — never sent as a model name.
 * This is the conductor dispatching a pass to itself via the Agent tool, not a separate worker
 * adapter (other hosts go through cmd/worker.mjs's `ack`, which sets `route.confirmed` from what
 * the worker reports back).
 */
export function agentToolModel(route, { config } = {}) {
  const fallback = DEFAULT_HOSTS.claude;
  if (!route) return fallback.build;
  const table = tiersFor(config);
  const tierAlias = table[route.tier] ? modelFor(table, route.tier, "claude") : null;
  const m = namedModel(route);
  if (!m) return tierAlias || fallback.build;
  const claudeNames = new Set(TIER_IDS.map(id => squash(modelFor(table, id, "claude"))));
  if (claudeNames.has(squash(m))) return m;
  if (tierFromText(m, { config }) === null) return m;
  return tierAlias || fallback[tierFromText(m, { config })] || fallback.build;
}

/**
 * Confirm a route because the conductor itself dispatched the pass via the Agent tool with an
 * explicit model — mutates and returns the route. "Requested" is still not "confirmed" (the
 * whole point of this file, see the header); recording it as `agent-tool:<model>` keeps that
 * distinction visible. Called from `cmd/pass.mjs`'s `claude` branch right next to
 * `real.status = "running"`.
 */
export function confirmAgentToolRoute(route, claudeModelName, { config } = {}) {
  if (!route) return route;
  const name = String(claudeModelName == null ? "" : claudeModelName).trim();
  const mapped = name ? agentToolModel({ ...route, model: name }, { config }).toLowerCase() : "unknown";
  route.confirmed = `agent-tool:${mapped}`;
  return route;
}

/**
 * What the report is allowed to say about a route.
 *
 * `confirmed` is only ever set by a host adapter that got an acknowledgement back. Until then
 * this returns the honest sentence, not the flattering one — the whole reason the field exists
 * is that a name in a state file had been reading as proof of dispatch.
 */
export function describeRoute(route) {
  if (!route) return "no route recorded";
  const asked = `${route.model} · ${route.effort} (${route.tier} — ${route.reason})`;
  if (route.host === "inline") return `${asked} — tier advice only; the chat that ran it chose its own model`;
  if (!route.confirmed) return `${asked} — requested; the host did not report back what it actually ran, so this is unconfirmed`;
  if (route.confirmed === route.model) return `${asked} — confirmed by the host`;
  return `${asked} — but the host reports it actually ran ${route.confirmed}`;
}

// ---------------------------------------------------------------- the tier-to-model map, per tool
// What each tool accepts as a model id, read from the tools themselves (reference/HOSTS.md has the
// rulebook table and where each fact came from). Shapes only — never a model name: model ids live
// in config.json and nowhere in the code.

/** The text a run prints for a tier with no model named. */
export const NOT_NAMED = "not named — inherits the main model";

/**
 * Per host: the shape of a model id the tool accepts, and the words that describe it.
 * A host not listed here (a project's own) has no shape check.
 */
export const HOST_MODEL_FORMS = Object.freeze({
  claude: Object.freeze({
    rx: /^[a-z][a-z0-9.\-]*(\[[a-z0-9]+\])?$/,
    wants: "a lowercase alias or model id with no spaces (the Agent tool's `model`)"
  }),
  codex: Object.freeze({
    rx: /^[a-z0-9][a-z0-9._\-]*$/,
    wants: "a lowercase model slug with no spaces, as in Codex's own models list (`codex exec -m <slug>`)"
  }),
  opencode: Object.freeze({
    rx: /^[^\s/]+\/\S+$/,
    wants: "provider/model, as `opencode models` lists it (`opencode run -m provider/model`)"
  }),
  antigravity: Object.freeze({
    rx: /^(flash_lite|flash|pro)$/,
    wants: "flash_lite, flash or pro (the only values `agentapi new-conversation --model=` takes)"
  })
});

/** null when the model fits what the host accepts (or the host has no known shape), else one sentence why not. */
export function modelFormProblem(host, model) {
  const form = HOST_MODEL_FORMS[host];
  if (!form || isUnsetModel(model)) return null;
  const m = String(model).trim();
  if (form.rx.test(m)) return null;
  return `"${m}" is not in the form ${host} accepts — it wants ${form.wants}.`;
}

/**
 * The run's tier-to-model map for one host, and the WARNING lines that go with it.
 *   lines    — `think → <model>`, `build → <model>`, `mechanical → <model>` (or NOT_NAMED)
 *   warnings — each starts `WARNING:`; one when every tier resolves to the same model or none is
 *              named, one per named model not in the form the host accepts. `inline` starts no
 *              helper, so its map is advice only and it carries no same-model warning.
 * `extraModels` — models the passes name themselves (a plan that named a real model), form-checked too.
 * `scout` — { list, cards, preference } when the model scout is on (see resolveScoutModels): "auto"
 *   tiers take the cards' pick and a pinned model the tool no longer lists falls back, each with
 *   its WARNING line. Without it, "auto" names no model and says so.
 */
export function tierModelMap(config, host = "claude", { extraModels = [], scout } = {}) {
  const resolved = resolveScoutModels(config, host, scout);
  const map = TIER_IDS.map(id => ({ tier: id, model: isUnsetModel(resolved.models[id]) ? null : resolved.models[id] }));
  const inline = host === "inline" || runsInline(host, config);
  const lines = map.map(({ tier, model }) =>
    `${tier} → ${inline ? "advice only — this chat runs whatever model it runs" : (model || NOT_NAMED)}`);
  const warnings = [];
  if (!inline) {
    warnings.push(...resolved.warnings);
    for (const id of resolved.auto) {
      if (!scout) {
        warnings.push(`WARNING: hosts.${host}.${id} is "auto" but no model_cards file is set in config.json — no model named, the tool's own model runs.`);
      } else if (!map.find(x => x.tier === id).model) {
        warnings.push(`WARNING: no model card fits ${id} on ${host} — no model named, the tool's own model runs.`);
      }
    }
    const named = map.filter(x => x.model);
    if (!named.length) {
      warnings.push(`WARNING: no tier names a model for host "${host}", so every helper inherits the main model — set hosts.${host}.<tier> in config.json to give each tier its own.`);
    } else if (named.length === map.length && new Set(named.map(x => x.model.toLowerCase())).size === 1) {
      warnings.push(`WARNING: every tier resolves to the same model (${named[0].model}) on host "${host}", so the tiers make no difference.`);
    }
    const seen = new Set();
    for (const m of [...named.map(x => x.model), ...extraModels]) {
      if (isUnsetModel(m) || m === TOOL_OWN_MODEL || seen.has(m)) continue;
      seen.add(m);
      const why = modelFormProblem(host, m);
      if (why) warnings.push(`WARNING: ${why} Fix hosts.${host} in config.json with an id the tool lists.`);
    }
  }
  return { map, lines, warnings };
}

/**
 * What a brief says about the model: `host · tier · model`. A route with no model named says
 * NOT_NAMED; `inline` says the chat runs whatever it runs.
 */
export function meantModelLine(route) {
  if (!route) return `unknown · unknown · ${NOT_NAMED}`;
  const host = route.host || "claude";
  const model = host === "inline"
    ? "advice only — this chat runs whatever model it runs"
    : (namedModel(route) || NOT_NAMED);
  return `${host} · ${route.tier || "unknown"} · ${model}`;
}
