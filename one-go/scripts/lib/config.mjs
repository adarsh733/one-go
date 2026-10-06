// lib/config.mjs — the house paths: `<ROOT>/.claude/one-go/config.json` (dev/CONTRACT.md §2).
//
// The core ships with every project feature OFF. A project switches features on by naming the
// files and folders in its own config.json — the engine never guesses a project layout again.
//
//   no file            → DEFAULT_CONFIG (generic core, nothing project-specific)
//   bad JSON / bad key → ConfigError, loud; the command stops and writes nothing
//   unknown key        → ignored, but listed in `warnings` so a typo is visible
//
// Paths in the file: relative = from ROOT; `~/` = the user's home; absolute = kept as written.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT } from "./paths.mjs";
import { PREFERENCES, DEFAULT_PREFERENCE, DEFAULT_MAX_AGE_DAYS, DEFAULT_OPENCODE_PROVIDERS } from "./scout.mjs";

export class ConfigError extends Error {
  constructor(message, file) {
    super(message);
    this.name = "ConfigError";
    this.file = file || null;
  }
}

const TIER_IDS = ["think", "build", "mechanical"];
const TIER_FIELDS = ["label", "when", "effort"];
const EXTRA_WHEN = ["always", "screen_job", "open_items", "committed"];
const EXTRA_SOURCE_KEYS = ["open_loops", "pending_push"];

export const DEFAULT_CONFIG = Object.freeze({
  claims_file: null,
  frozen_dirs: Object.freeze([]),
  screen_gate: "off",
  screen_slug_pattern: null,
  extra_sources: Object.freeze({ open_loops: null, pending_push: null }),
  sweep_dirs: Object.freeze([]),
  worklog: null,
  register_command: null,
  worker_always_allowed: Object.freeze([]),
  report_extras: Object.freeze([]),
  default_host: null,
  parallel_limit: null,
  tiers: Object.freeze({}),
  hosts: Object.freeze({}),
  model_cards: null,
  model_scout: Object.freeze({
    max_age_days: DEFAULT_MAX_AGE_DAYS,
    preference: DEFAULT_PREFERENCE,
    opencode_providers: Object.freeze([...DEFAULT_OPENCODE_PROVIDERS])
  })
});

/** A fresh, mutable copy of the defaults (callers may change it without touching the frozen one). */
function freshDefaults() {
  return {
    claims_file: null,
    frozen_dirs: [],
    screen_gate: "off",
    screen_slug_pattern: null,
    extra_sources: { open_loops: null, pending_push: null },
    sweep_dirs: [],
    worklog: null,
    register_command: null,
    worker_always_allowed: [],
    report_extras: [],
    default_host: null,
    parallel_limit: null,
    tiers: {},
    hosts: {},
    model_cards: null,
    model_scout: {
      max_age_days: DEFAULT_MAX_AGE_DAYS,
      preference: DEFAULT_PREFERENCE,
      opencode_providers: [...DEFAULT_OPENCODE_PROVIDERS]
    }
  };
}

// ---------------------------------------------------------------- how many passes run at once
// `parallel_limit` unset means "as many as the waves allow", held to a safety ceiling of 8. A
// project may set a whole number from 1 to 16. Total usage is the same whatever the width; width
// only changes how fast the usage window is spent, and runs already resume after a usage-limit
// stop. Width must come from genuinely independent work, never from chopping passes — each helper
// has a fixed start-up cost.
export const PARALLEL_CEILING = 8;
/** The width used when nothing sets one — start, next and pass all read this one number. */
export const DEFAULT_PARALLEL_LIMIT = PARALLEL_CEILING;
export const PARALLEL_MIN = 1;
export const PARALLEL_MAX = 16;

/** A whole number from PARALLEL_MIN to PARALLEL_MAX, or null. Strings of digits count. */
export function parallelValue(v) {
  if (v == null || v === "") return null;
  const n = typeof v === "number" ? v : /^\s*\d+\s*$/.test(String(v)) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= PARALLEL_MIN && n <= PARALLEL_MAX ? n : null;
}

/**
 * How many passes a run may have going at once, and where that number came from. Order:
 *   1. `--parallel N` on start            ("--parallel")
 *   2. the stopped run's own value, on resume ("the stopped run") — old run states keep their number
 *   3. config.parallel_limit                ("config")
 *   4. PARALLEL_CEILING                     ("default")
 * A `--parallel` value that is not a whole number from 1 to 16 → { error }.
 * @returns {{ limit: number, source: string } | { error: string }}
 */
export function resolveParallelLimit({ flag, resumed, config } = {}) {
  if (flag != null && flag !== "") {
    const n = parallelValue(flag);
    if (n == null) return { error: `--parallel must be a whole number from ${PARALLEL_MIN} to ${PARALLEL_MAX}, got "${flag}".` };
    return { limit: n, source: "--parallel" };
  }
  const old = Number(resumed);
  if (Number.isInteger(old) && old >= 1) return { limit: old, source: "the stopped run" };
  const c = parallelValue(config && config.parallel_limit);
  if (c != null) return { limit: c, source: "config" };
  return { limit: DEFAULT_PARALLEL_LIMIT, source: "default" };
}

export function configPath(root = ROOT) {
  return path.join(root, ".claude", "one-go", "config.json");
}

/**
 * A house path → an absolute path, or null when the setting is off (null / empty).
 * Absolute stays absolute (never re-joined onto ROOT — obs 0066's defect class).
 */
export function resolveHousePath(p, root = ROOT) {
  if (p == null) return null;
  const s = String(p).trim();
  if (!s) return null;
  if (s === "~") return os.homedir();
  if (/^~[\\/]/.test(s)) return path.join(os.homedir(), s.slice(2));
  if (path.isAbsolute(s) || /^[A-Za-z]:[\\/]/.test(s)) return path.normalize(s);
  return path.resolve(root, s);
}

const isPlainObject = v => v != null && typeof v === "object" && !Array.isArray(v);
const typeName = v => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

/**
 * Validate a parsed config object against the schema. Returns { config, warnings }.
 * Throws ConfigError on the first key of the wrong type — never a silent default.
 */
export function validateConfig(raw, file = "config.json") {
  if (!isPlainObject(raw)) {
    throw new ConfigError(`${file}: the top level must be a JSON object, got ${typeName(raw)}.`, file);
  }
  const bad = (key, want, got) => {
    throw new ConfigError(`${file}: "${key}" must be ${want}, got ${typeName(got)}${
      typeof got === "string" ? ` "${got}"` : ""}. Nothing was run.`, file);
  };
  const cfg = freshDefaults();
  const warnings = [];

  const stringOrNull = key => {
    if (!(key in raw)) return;
    const v = raw[key];
    if (v !== null && typeof v !== "string") bad(key, "a string or null", v);
    cfg[key] = v === null || v.trim() === "" ? null : v;
  };
  const stringArray = key => {
    if (!(key in raw)) return;
    const v = raw[key];
    if (!Array.isArray(v) || v.some(x => typeof x !== "string")) bad(key, "a list of strings", v);
    cfg[key] = v.filter(x => x.trim() !== "");
  };

  for (const key of Object.keys(raw)) {
    if (key.startsWith("_") || key === "$schema") continue;          // comments are allowed
    if (!(key in cfg)) warnings.push(`${file}: unknown key "${key}" ignored`);
  }

  stringOrNull("claims_file");
  stringArray("frozen_dirs");
  stringArray("sweep_dirs");
  stringOrNull("worklog");
  stringOrNull("register_command");
  stringArray("worker_always_allowed");

  if ("screen_gate" in raw) {
    const v = raw.screen_gate;
    if (v === true || v === "on") cfg.screen_gate = "on";
    else if (v === false || v === "off") cfg.screen_gate = "off";
    else bad("screen_gate", `"on" or "off"`, v);
  }

  if ("screen_slug_pattern" in raw) {
    const v = raw.screen_slug_pattern;
    if (v !== null && typeof v !== "string") bad("screen_slug_pattern", "a regex string or null", v);
    if (typeof v === "string" && v.trim()) {
      try { new RegExp(v); } catch (e) {
        throw new ConfigError(`${file}: "screen_slug_pattern" is not a valid regex (${e.message}). Nothing was run.`, file);
      }
      cfg.screen_slug_pattern = v;
    }
  }

  if ("extra_sources" in raw) {
    const v = raw.extra_sources;
    if (!isPlainObject(v)) bad("extra_sources", "an object", v);
    for (const k of Object.keys(v)) {
      if (k.startsWith("_")) continue;
      if (!EXTRA_SOURCE_KEYS.includes(k)) { warnings.push(`${file}: unknown key "extra_sources.${k}" ignored`); continue; }
      if (v[k] !== null && typeof v[k] !== "string") bad(`extra_sources.${k}`, "a string or null", v[k]);
      cfg.extra_sources[k] = v[k] === null || v[k].trim() === "" ? null : v[k];
    }
  }

  if ("report_extras" in raw) {
    const v = raw.report_extras;
    if (!Array.isArray(v)) bad("report_extras", "a list", v);
    v.forEach((x, i) => {
      if (!isPlainObject(x)) bad(`report_extras[${i}]`, "an object", x);
      if (!EXTRA_WHEN.includes(x.when)) bad(`report_extras[${i}].when`, EXTRA_WHEN.map(w => `"${w}"`).join(" | "), x.when);
      if (typeof x.text !== "string") bad(`report_extras[${i}].text`, "a string", x.text);
    });
    cfg.report_extras = v.map(x => ({ when: x.when, text: x.text }));
  }

  stringOrNull("default_host");

  // The model scout (lib/scout.mjs). `model_cards` is the path of the saved model cards; unset
  // means the scout is off. A tier value of "auto" under hosts.<host>.<tier> asks the scout to pick.
  stringOrNull("model_cards");
  if ("model_scout" in raw) {
    const v = raw.model_scout;
    if (!isPlainObject(v)) bad("model_scout", "an object", v);
    for (const [k, val] of Object.entries(v)) {
      if (k.startsWith("_")) continue;
      if (k === "max_age_days") {
        if (typeof val !== "number" || !Number.isInteger(val) || val < 1 || val > 365) {
          bad("model_scout.max_age_days", "a whole number of days from 1 to 365", val);
        }
        cfg.model_scout.max_age_days = val;
      } else if (k === "preference") {
        if (!PREFERENCES.includes(val)) bad("model_scout.preference", PREFERENCES.map(p => `"${p}"`).join(" | "), val);
        cfg.model_scout.preference = val;
      } else if (k === "opencode_providers") {
        if (!Array.isArray(val) || val.some(x => typeof x !== "string")) bad("model_scout.opencode_providers", "a list of strings", val);
        cfg.model_scout.opencode_providers = val.map(x => x.trim()).filter(Boolean);
      } else {
        warnings.push(`${file}: unknown key "model_scout.${k}" ignored`);
      }
    }
  }

  if ("parallel_limit" in raw) {
    const v = raw.parallel_limit;
    if (v !== null) {
      if (typeof v !== "number" || parallelValue(v) == null) {
        bad("parallel_limit", `a whole number from ${PARALLEL_MIN} to ${PARALLEL_MAX} (or null for "as many as the waves allow, up to ${PARALLEL_CEILING}")`, v);
      }
      cfg.parallel_limit = v;
    }
  }

  const legacyClaude = {};        // tiers.<id>.claude — read as hosts.claude.<id>, with a warning
  if ("tiers" in raw) {
    const v = raw.tiers;
    if (!isPlainObject(v)) bad("tiers", "an object", v);
    for (const [id, t] of Object.entries(v)) {
      if (id.startsWith("_")) continue;
      if (!TIER_IDS.includes(id)) { warnings.push(`${file}: unknown tier "tiers.${id}" ignored`); continue; }
      if (!isPlainObject(t)) bad(`tiers.${id}`, "an object", t);
      const out = {};
      for (const [f, val] of Object.entries(t)) {
        if (f === "claude") {
          if (typeof val !== "string") bad(`tiers.${id}.claude`, "a string", val);
          legacyClaude[id] = val;
          warnings.push(`${file}: "tiers.${id}.claude" is the old spelling — write it as "hosts.claude.${id}"; it is read as that for now`);
          continue;
        }
        if (!TIER_FIELDS.includes(f)) { warnings.push(`${file}: unknown field "tiers.${id}.${f}" ignored`); continue; }
        if (typeof val !== "string") bad(`tiers.${id}.${f}`, "a string", val);
        out[f] = val;
      }
      cfg.tiers[id] = out;
    }
  }

  if ("hosts" in raw) {
    const v = raw.hosts;
    if (!isPlainObject(v)) bad("hosts", "an object", v);
    for (const [host, models] of Object.entries(v)) {
      if (host.startsWith("_")) continue;
      if (!isPlainObject(models)) bad(`hosts.${host}`, "an object", models);
      const out = {};
      for (const [tier, name] of Object.entries(models)) {
        if (tier === "requires_approval" || tier === "helpers") {   // per-host flags read by lib/route.mjs
          if (typeof name !== "boolean") bad(`hosts.${host}.${tier}`, "true or false", name);
          out[tier] = name;
          continue;
        }
        if (!TIER_IDS.includes(tier)) { warnings.push(`${file}: unknown tier "hosts.${host}.${tier}" ignored`); continue; }
        if (typeof name !== "string") bad(`hosts.${host}.${tier}`, "a string", name);
        out[tier] = name;
      }
      cfg.hosts[host] = out;
    }
  }

  for (const [id, name] of Object.entries(legacyClaude)) {     // an explicit hosts.claude line wins
    cfg.hosts.claude = cfg.hosts.claude || {};
    if (!(id in cfg.hosts.claude)) cfg.hosts.claude[id] = name;
  }

  return { config: cfg, warnings };
}

/**
 * Find and read `<root>/.claude/one-go/config.json`.
 * @returns {{...config, warnings: string[]}} — the defaults when the file is absent.
 * @throws {ConfigError} when the file exists but is not valid JSON or a key has the wrong type.
 */
export function loadConfig(root = ROOT) {
  const file = configPath(root);
  let text;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (e) {
    if (e && e.code === "ENOENT") return { ...freshDefaults(), warnings: [] };
    throw new ConfigError(`${file}: cannot be read (${e.message}). Nothing was run.`, file);
  }
  let raw;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ""));
  } catch (e) {
    throw new ConfigError(`${file}: is not valid JSON (${e.message}). Fix or remove the file — ` +
      `one-go never falls back to defaults silently. Nothing was run.`, file);
  }
  const { config, warnings } = validateConfig(raw, file);
  return { ...config, warnings };
}
