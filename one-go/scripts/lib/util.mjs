// lib/util.mjs — small stateless helpers. Extracted verbatim from the original board.mjs
// (no behaviour change — see TASK-ENF-001 stage 2).
import fs from "node:fs";

export function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf-8").replace(/^﻿/, "")); } catch { return fallback; }
}
export function readText(p) { try { return fs.readFileSync(p, "utf-8"); } catch { return null; } }
export function globDirs(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); }
  catch { return []; }
}
export function globFiles(dir, matchFn) { try { return fs.readdirSync(dir).filter(matchFn); } catch { return []; } }
export function pad2(n) { return String(n).padStart(2, "0"); }
export function today(d = new Date()) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
export function stamp(d = new Date()) { return `${today(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
export function slugify(text, words) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
    .split("-").filter(Boolean).slice(0, words || 5).join("-");
}
export function argValues(argv, flag) {
  const out = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === flag && argv[i + 1] != null) out.push(argv[++i]);
  return out;
}
export function positionals(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) { i++; continue; }
    out.push(argv[i]);
  }
  return out;
}
