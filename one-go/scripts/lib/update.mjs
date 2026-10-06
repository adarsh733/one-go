// lib/update.mjs — "a newer one-go is out", and the facts `/one-go update` needs.
//
// An install made the INSTALL.md way is a git download of the public package:
//   <download>/.git, <download>/.one-go-package, <download>/one-go/   (= this skill folder)
// Only such an install checks for, or takes, updates. A copied folder or the development copy has
// no download folder above it, so it never checks and `update` explains how to switch.
//
// The check: at most once a day, when a job starts (dispatch), a quiet background process asks the
// download's own GitHub address which version tags exist (`git ls-remote --tags origin`) and saves
// the answer in ~/.one-go/update-check.json. The notice is read from that file, so dispatch never
// waits on the network and works the same with no internet. ONEGO_UPDATE_CHECK=off turns it off.
//
//   node lib/update.mjs --refresh     the background check (started by updateNotice, detached)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(import.meta.url);
export const SKILL_DIR = path.resolve(path.dirname(HERE), "..", "..");
export const PACKAGE_MARKER = ".one-go-package";
export const DAY_MS = 24 * 60 * 60 * 1000;

/** [major, minor, patch] for "1.2.3" or "v1.2.3"; null for anything else. */
export function parseVersion(s) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(s == null ? "" : s).trim());
  return m ? m.slice(1).map(Number) : null;
}

/** >0 when a is newer than b, <0 when older, 0 when equal. An unreadable version is the oldest. */
export function compareVersions(a, b) {
  const pa = parseVersion(a), pb = parseVersion(b);
  if (!pa || !pb) return (pa ? 1 : 0) - (pb ? 1 : 0);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/** This skill's version from its VERSION file, without the "v"; null when missing or unreadable. */
export function readVersion(skillDir = SKILL_DIR) {
  try {
    const v = fs.readFileSync(path.join(skillDir, "VERSION"), "utf8").trim();
    return parseVersion(v) ? v.replace(/^v/, "") : null;
  } catch { return null; }
}

/** The newest version among tag names or `ls-remote --tags` lines; null when none is a version. */
export function newestTag(text) {
  let best = null;
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = /(?:^|refs\/tags\/)(v\d+\.\d+\.\d+)(?:\^\{\})?\s*$/.exec(line.trim());
    if (m && (!best || compareVersions(m[1], best) > 0)) best = m[1];
  }
  return best ? best.slice(1) : null;
}

/** The download folder this skill was installed from, or null (a copied folder, the dev copy). */
export function installClone(skillDir = SKILL_DIR) {
  const root = path.dirname(skillDir);
  if (path.basename(skillDir) !== "one-go") return null;
  if (!fs.existsSync(path.join(root, ".git")) || !fs.existsSync(path.join(root, PACKAGE_MARKER))) return null;
  return root;
}

export function userHome(env = process.env) {
  const h = env.ONEGO_INSTALL_HOME;
  return h && h.trim() ? path.resolve(h) : os.homedir();
}

export function stateFile(home = userHome()) { return path.join(home, ".one-go", "update-check.json"); }

export function checkOff(env = process.env) {
  return ["off", "0", "false", "no"].includes(String(env.ONEGO_UPDATE_CHECK || "").trim().toLowerCase());
}

export function readState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    return s && typeof s === "object" ? s : null;
  } catch { return null; }
}

/** Write the check file whole: a temporary file, then a rename, so a reader never sees half. */
export function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/** Run git in the download folder with no prompts (a missing login must fail, never hang). */
export function git(cwd, args, timeout = 60000) {
  return execFileSync("git", args, {
    cwd, encoding: "utf8", timeout, windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
  });
}

/** The newest version GitHub has, asked without changing anything. Throws when unreachable. */
export function latestRemote(clone, timeout = 20000) {
  return newestTag(git(clone, ["ls-remote", "--tags", "origin"], timeout));
}

/** The one line the person sees, from the saved check. null when nothing newer is known. */
export function noticeLine(local, state) {
  if (!local || !state || !parseVersion(state.latest)) return null;
  if (compareVersions(state.latest, local) <= 0) return null;
  return `A newer one-go is out (v${state.latest}; you have v${local}). Type /one-go update to get it — it never updates in the middle of a job.`;
}

/**
 * Called when a job starts. Returns the notice line (or null) straight away. When the last check is
 * a day old or more, it records the attempt and starts the background check, whose answer shows
 * next time. Never throws, never waits on the network.
 */
export function updateNotice({ skillDir = SKILL_DIR, env = process.env, now = Date.now(), start = startRefresh } = {}) {
  try {
    if (checkOff(env)) return null;
    if (!installClone(skillDir)) return null;
    const local = readVersion(skillDir);
    if (!local) return null;
    const file = stateFile(userHome(env));
    const state = readState(file);
    const last = state ? Date.parse(state.checked) : NaN;
    if (!(now - last < DAY_MS)) {
      // The attempt is written first, so being offline costs one try a day, not one per job.
      writeState(file, { ...(state || {}), checked: new Date(now).toISOString() });
      start(skillDir, env);
    }
    return noticeLine(local, state);
  } catch { return null; }
}

/** Start `node update.mjs --refresh` on its own, detached: this process does not wait for it. */
export function startRefresh(skillDir = SKILL_DIR, env = process.env) {
  const child = spawn(process.execPath, [HERE, "--refresh", "--skill", skillDir], {
    detached: true, stdio: "ignore", windowsHide: true, env
  });
  child.on("error", () => {});
  child.unref();
}

/** The background check itself: ask GitHub, save what it said. Silent either way. */
export function refresh({ skillDir = SKILL_DIR, env = process.env, now = Date.now(), ask = latestRemote } = {}) {
  const clone = installClone(skillDir);
  if (!clone) return null;
  const file = stateFile(userHome(env));
  const latest = ask(clone);
  writeState(file, { ...(readState(file) || {}), checked: new Date(now).toISOString(), latest: latest || null });
  return latest;
}

/** Changelog sections newer than `since`: [{ version, title }], newest first. */
export function changesSince(changelogText, since) {
  const out = [];
  for (const line of String(changelogText || "").split(/\r?\n/)) {
    const m = /^##\s+v(\d+\.\d+\.\d+)\s*(?:[—–-]\s*)?(.*)$/.exec(line.trim());
    if (m && compareVersions(m[1], since) > 0) out.push({ version: m[1], title: m[2].trim() });
  }
  return out;
}

const real = p => { try { return fs.realpathSync(path.resolve(p)); } catch { return path.resolve(p); } };
const isMain = process.argv[1] && real(process.argv[1]) === real(HERE);
if (isMain && process.argv.includes("--refresh")) {
  const i = process.argv.indexOf("--skill");
  try { refresh({ skillDir: i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : SKILL_DIR }); }
  catch { /* offline, no git, GitHub down: the next day's check tries again */ }
}
