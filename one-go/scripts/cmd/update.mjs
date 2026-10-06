// cmd/update.mjs — `/one-go update`: take the newest one-go from GitHub, never in the middle of a job.
//
//   board.mjs update            update when a newer version exists
//   board.mjs update --check    only say whether one exists; changes nothing
//
// Refuses, changing nothing, when: this copy was not installed from GitHub (INSTALL.md) · a job is
// running in this project · the person edited one-go's own files · GitHub cannot be reached · the
// download's history no longer lines up with GitHub's. An update is a fast-forward of the download
// folder to the newest version tag, so every tool linked to it sees the new files at once.
import fs from "node:fs";
import path from "node:path";
import { ONEGO } from "../lib/paths.mjs";
import { liveRunIds } from "../lib/marker.mjs";
import {
  SKILL_DIR, installClone, readVersion, newestTag, compareVersions, latestRemote, git,
  stateFile, userHome, readState, writeState, changesSince
} from "../lib/update.mjs";

const AGENT = path.join("agents", "one-go-worker.md");

function readOrNull(p) { try { return fs.readFileSync(p, "utf8"); } catch { return null; } }
function short(e) {
  return String((e && (e.stderr || e.message)) || e).split(/\r?\n/).map(s => s.trim()).find(Boolean) || "unknown error";
}
function save(latest, env) {
  try {
    const file = stateFile(userHome(env));
    writeState(file, { ...(readState(file) || {}), checked: new Date().toISOString(), latest: latest || null });
  } catch { /* the saved check is a convenience; the update stands without it */ }
}

/**
 * @param {{ARGV?: string[]}} ctx
 * @param {{skillDir?: string, onegoDir?: string, env?: object, log?: Function}} [deps] for tests
 */
export async function runUpdate(ctx = {}, deps = {}) {
  const { skillDir = SKILL_DIR, onegoDir = ONEGO, env = process.env, log = console.log } = deps;
  const ARGV = ctx.ARGV || [];
  const checkOnly = ARGV.includes("--check");
  const local = readVersion(skillDir);
  const clone = installClone(skillDir);

  if (!clone) {
    log(`This copy of one-go${local ? ` (v${local})` : ""} was not installed from GitHub, so it cannot update itself. Nothing was changed.`);
    log("To switch, follow INSTALL.md once (it downloads one-go with git). After that, /one-go update does it in one step.");
    return 1;
  }

  if (checkOnly) {
    let latest;
    try { latest = latestRemote(clone); }
    catch (e) { log(`Could not reach GitHub (${short(e)}). Nothing was changed.`); return 1; }
    save(latest, env);
    if (latest && compareVersions(latest, local) > 0) log(`A newer one-go is out: v${latest} (you have v${local || "unknown"}). /one-go update gets it.`);
    else log(`one-go is up to date (v${local || "unknown"}).`);
    return 0;
  }

  // 1. Never in the middle of a job: a run changing its rules halfway would break its own proofs.
  const live = liveRunIds(onegoDir);
  if (live.length) {
    log(`A job is running in this project (${live.join(", ")}), so nothing was changed — updating now could change its rules halfway.`);
    log("Run /one-go update after it ends, or /one-go stop it first.");
    return 1;
  }

  // 2. The person's own edits to one-go's files are never overwritten.
  let dirty;
  try { dirty = git(clone, ["status", "--porcelain"]).split(/\r?\n/).filter(Boolean); }
  catch (e) { log(`Could not read the download folder ${clone} (${short(e)}). Nothing was changed.`); return 1; }
  if (dirty.length) {
    log(`You have changed ${dirty.length} of one-go's own file(s), so nothing was changed — an update would clash with them:`);
    for (const d of dirty.slice(0, 10)) log(`  ${d.slice(3)}`);
    if (dirty.length > 10) log(`  …and ${dirty.length - 10} more`);
    log(`To update anyway, undo them first: git -C "${clone}" checkout -- .`);
    return 1;
  }

  // 3. Fetch the versions. Fetching only adds to the download's history; no file changes yet.
  try { git(clone, ["fetch", "--quiet", "--tags", "origin"], 120000); }
  catch (e) { log(`Could not reach GitHub (${short(e)}). Nothing was changed — try again when online.`); return 1; }
  const latest = newestTag(git(clone, ["tag", "--list", "v*"]));
  save(latest, env);
  if (!latest || compareVersions(latest, local) <= 0) {
    log(`one-go is up to date (v${local || "unknown"}).`);
    return 0;
  }

  // 4. Move forward to the newest version. A fast-forward only: it never merges or rewrites.
  const oldAgent = readOrNull(path.join(skillDir, AGENT));
  try { git(clone, ["merge", "--ff-only", "--quiet", `refs/tags/v${latest}`]); }
  catch (e) {
    log(`The download folder's history does not line up with GitHub's (${short(e)}). Nothing was changed.`);
    log(`Reinstall once: delete ${clone} and follow INSTALL.md again. Your project boards are not touched by that.`);
    return 1;
  }
  const now = readVersion(skillDir);
  log(`Updated one-go v${local || "unknown"} → v${now || latest}.`);
  for (const c of changesSince(readOrNull(path.join(skillDir, "CHANGELOG.md")), local || "0.0.0").slice(0, 8)) {
    log(`  · v${c.version}${c.title ? ` — ${c.title}` : ""}`);
  }

  // 5. The Claude Code helper agent is a copy, so it is refreshed here — only when the person never
  //    edited it (it still matches the old version's file).
  const newAgent = readOrNull(path.join(skillDir, AGENT));
  const installed = path.join(userHome(env), ".claude", "agents", "one-go-worker.md");
  const mine = readOrNull(installed);
  if (mine != null && newAgent != null && mine !== newAgent) {
    if (mine === oldAgent) {
      try { fs.writeFileSync(installed, newAgent); log("  The Claude Code helper agent was refreshed too."); }
      catch (e) { log(`  Could not refresh the helper agent (${short(e)}); copy ${path.join(skillDir, AGENT)} over it by hand.`); }
    } else {
      log(`  Your helper agent at ${installed} was edited by hand, so it was left alone. The new one is ${path.join(skillDir, AGENT)}.`);
    }
  }
  log("Chats opened from now on use the new version; a chat already open may still hold the old instructions.");
  return 0;
}
