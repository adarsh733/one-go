#!/usr/bin/env node
// install.mjs — link the one-go skill into each tool's skills folder on this machine.
//
//   node install.mjs                       dry run (default): print what would happen, change nothing
//   node install.mjs --dry-run             the same
//   node install.mjs --apply               make the links
//   node install.mjs --tool <name>         only one tool: claude | antigravity | codex | opencode
//
// The skill folder linked to is the folder this script lives in (one level above scripts/), so the
// script is portable: run from the live skill folder it links the live skill.
//
// Rules (dev/CONTRACT-2.md §5):
//   - a tool whose target already resolves to the skill folder is SKIPPED, never touched;
//   - a real folder, a real file, or a link that points somewhere else is REFUSED, never overwritten;
//   - exit 0 when every tool is linked or skipped, 1 when any tool is refused, 2 on bad arguments;
//   - ONEGO_INSTALL_HOME replaces the home folder (tests use a sandbox; nothing else needs it).
//
// Claude Code also gets its helper agent: skill/agents/one-go-worker.md is COPIED to
// ~/.claude/agents/one-go-worker.md when missing; an identical file is skipped; a different file is
// refused (never overwritten). Windows file links need rights a normal user lacks, hence a copy.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TOOLS = ["claude", "antigravity", "codex", "opencode"];

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SKILL_DIR = path.resolve(HERE, "..");
const SKILL_NAME = "one-go";
const AGENT_FILE = "one-go-worker.md";

export function installHome(env = process.env) {
  const h = env.ONEGO_INSTALL_HOME;
  return h && h.trim() ? path.resolve(h) : os.homedir();
}

/** Where each tool looks for the skill (dev/CONTRACT-2.md §5). */
export function targetFor(tool, home) {
  switch (tool) {
    case "claude": return path.join(home, ".claude", "skills", SKILL_NAME);
    case "antigravity": return path.join(home, ".agents", "skills", SKILL_NAME);
    case "codex": return path.join(home, ".codex", "skills", SKILL_NAME);
    case "opencode": return path.join(home, ".config", "opencode", "skills", SKILL_NAME);
    default: throw new Error(`unknown tool "${tool}"`);
  }
}

const canon = p => {
  const r = fs.realpathSync.native(p);
  return process.platform === "win32" ? r.toLowerCase() : r;
};
const lstatOrNull = p => { try { return fs.lstatSync(p); } catch (e) { if (e && e.code === "ENOENT") return null; throw e; } };
const show = (p, home) => {
  const n = path.resolve(p);
  const h = path.resolve(home);
  return n === h ? "~" : n.startsWith(h + path.sep) ? "~/" + n.slice(h.length + 1).split(path.sep).join("/") : n.split(path.sep).join("/");
};

/**
 * Decide, without changing anything, what one link needs.
 * @returns {{action: "skip"|"link"|"refuse", why: string}}
 */
export function planLink(target, skillDir = SKILL_DIR) {
  const st = lstatOrNull(target);
  if (!st) return { action: "link", why: "not there yet" };
  let sees = false;
  try { sees = canon(target) === canon(skillDir); } catch { sees = false; }
  if (sees) return { action: "skip", why: "already sees the skill" };
  if (st.isSymbolicLink()) return { action: "refuse", why: "is a link that points somewhere else — not touched" };
  if (st.isDirectory()) return { action: "refuse", why: "is a real folder — not overwritten" };
  return { action: "refuse", why: "is a real file — not overwritten" };
}

function makeLink(target, skillDir) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.symlinkSync(skillDir, target, process.platform === "win32" ? "junction" : "dir");
}

/** The Claude helper agent: copy when missing, skip when identical, refuse when different. */
export function planAgent(home, skillDir = SKILL_DIR) {
  const from = path.join(skillDir, "agents", AGENT_FILE);
  const to = path.join(home, ".claude", "agents", AGENT_FILE);
  if (!fs.existsSync(from)) return { from, to, action: "refuse", why: "the skill has no agents/one-go-worker.md to copy" };
  const st = lstatOrNull(to);
  if (!st) return { from, to, action: "copy", why: "not there yet" };
  if (st.isFile() && Buffer.compare(fs.readFileSync(from), fs.readFileSync(to)) === 0) {
    return { from, to, action: "skip", why: "already the same file" };
  }
  return { from, to, action: "refuse", why: "is a different file — not overwritten (copy by hand)" };
}

/**
 * Run the install. Returns { lines, refused }. Never throws for a per-tool problem.
 * @param {{apply?: boolean, tools?: string[], home?: string, skillDir?: string}} opts
 */
export function runInstall({ apply = false, tools = TOOLS, home = installHome(), skillDir = SKILL_DIR } = {}) {
  const lines = [];
  let refused = 0;
  const say = (tool, verb, target, why) => lines.push(`${tool.padEnd(12)} ${verb.padEnd(7)} ${show(target, home)} — ${why}`);

  for (const tool of tools) {
    const target = targetFor(tool, home);
    let plan;
    try { plan = planLink(target, skillDir); }
    catch (e) { plan = { action: "refuse", why: `cannot be read (${e.message})` }; }

    if (plan.action === "skip") say(tool, "skip", target, plan.why);
    else if (plan.action === "refuse") { refused++; say(tool, "refused", target, plan.why); }
    else if (!apply) say(tool, "would", target, `link to ${show(skillDir, home)}`);
    else {
      try { makeLink(target, skillDir); say(tool, "linked", target, `now points at ${show(skillDir, home)}`); }
      catch (e) { refused++; say(tool, "refused", target, `could not link (${e.message})`); }
    }

    if (tool === "claude") {
      let a;
      try { a = planAgent(home, skillDir); }
      catch (e) { a = { to: path.join(home, ".claude", "agents", AGENT_FILE), action: "refuse", why: `cannot be read (${e.message})` }; }
      if (a.action === "skip") say("claude", "skip", a.to, a.why);
      else if (a.action === "refuse") { refused++; say("claude", "refused", a.to, a.why); }
      else if (!apply) say("claude", "would", a.to, "copy the helper agent");
      else {
        try {
          fs.mkdirSync(path.dirname(a.to), { recursive: true });
          fs.copyFileSync(a.from, a.to, fs.constants.COPYFILE_EXCL);
          say("claude", "copied", a.to, "helper agent installed");
        } catch (e) { refused++; say("claude", "refused", a.to, `could not copy (${e.message})`); }
      }
    }
  }
  return { lines, refused };
}

function parseArgs(argv) {
  const out = { apply: false, dry: false, tools: null, error: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") out.apply = true;
    else if (a === "--dry-run") out.dry = true;
    else if (a === "--tool") {
      const v = argv[++i];
      if (!v) { out.error = "--tool needs a name"; break; }
      out.tools = [...(out.tools || []), v.toLowerCase()];
    } else if (a.startsWith("--tool=")) out.tools = [...(out.tools || []), a.slice(7).toLowerCase()];
    else { out.error = `unknown argument "${a}"`; break; }
  }
  if (!out.error && out.apply && out.dry) out.error = "--apply and --dry-run cannot be used together";
  if (!out.error && out.tools) {
    const bad = out.tools.find(t => !TOOLS.includes(t));
    if (bad) out.error = `unknown tool "${bad}" — known tools: ${TOOLS.join(", ")}`;
  }
  return out;
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.error) {
    console.error(`install: ${args.error}\nusage: node install.mjs [--dry-run | --apply] [--tool ${TOOLS.join("|")}]`);
    return 2;
  }
  if (!fs.existsSync(path.join(SKILL_DIR, "SKILL.md"))) {
    console.error(`install: ${SKILL_DIR} has no SKILL.md — run this from inside the skill folder.`);
    return 2;
  }
  const home = installHome();
  const tools = args.tools ? TOOLS.filter(t => args.tools.includes(t)) : TOOLS;
  const { lines, refused } = runInstall({ apply: args.apply, tools, home });
  for (const l of lines) console.log(l);
  console.log(args.apply
    ? (refused ? `install: ${refused} refused, the rest done.` : "install: done.")
    : `install: dry run — nothing changed.${refused ? ` ${refused} would be refused.` : ""} Add --apply to make the links.`);
  return refused ? 1 : 0;
}

const isMain = process.argv[1] && fs.realpathSync(path.resolve(process.argv[1])) === fs.realpathSync(fileURLToPath(import.meta.url));
if (isMain) process.exit(main(process.argv.slice(2)));
