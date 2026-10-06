#!/usr/bin/env node
// scripts/check-model-cards.mjs — is the model-cards file complete for the tools on this machine?
//
//   node scripts/check-model-cards.mjs <cards-file> [--providers a,b]
//
// Exit 0 when the file parses, every card has every field and a source web address, and every
// model the tools list today (the hosts that can be read on this machine) has a card.
// The optional "quality" (a number 0-100) and "quality_source" (a web address) are checked when
// present; how many cards lack "quality" is printed as a note, never a failure.
// Exit 1 listing each gap. Exit 2 = no file was named.
// A tool that cannot be read is noted and skipped — never a failure on its own.
// The opencode providers kept come from config.json `model_scout.opencode_providers`, or
// `--providers`, or the default two.
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  loadCards, cardProblems, readHostModels, qualityGaps, neverPickOf, SCOUT_HOSTS, DEFAULT_OPENCODE_PROVIDERS
} from "./lib/scout.mjs";

/**
 * The note on cards with no quality score — a note, never a gap: such cards are ranked by price.
 * Null when every card has one.
 */
export function qualityNote(cards) {
  const { missing, total } = qualityGaps(cards);
  if (!missing) return null;
  return `${missing} of ${total} card${total === 1 ? "" : "s"} have no "quality" score ` +
    `(ranked by price instead; optional field)`;
}
import { argValues, positionals } from "./lib/util.mjs";

/**
 * Every gap between a parsed card file and today's lists.
 * @param cards  loadCards result
 * @param lists  { <host>: readHostModels result }
 * @returns {{ gaps: string[], notes: string[] }}  notes = hosts that could not be read
 */
export function checkCards(cards, lists) {
  const gaps = cardProblems(cards);
  const notes = [];
  for (const [host, list] of Object.entries(lists || {})) {
    if (!list || !Array.isArray(list.models)) {
      notes.push(`skipped ${host}: ${(list && list.unavailable) || "could not be read"}`);
      continue;
    }
    const entry = cards && cards.hosts ? cards.hosts[host] : null;
    const have = entry && entry.models && typeof entry.models === "object" ? entry.models : {};
    for (const { id } of list.models) if (!(id in have)) gaps.push(`${host}/${id}: no card (the tool lists it today)`);
  }
  return { gaps, notes };
}

async function opencodeProviders(argv) {
  const flag = argValues(argv, "--providers");
  if (flag.length) return flag.join(",").split(",").map(s => s.trim()).filter(Boolean);
  try {
    const { loadConfig } = await import("./lib/config.mjs");
    const p = loadConfig().model_scout?.opencode_providers;
    if (Array.isArray(p) && p.length) return p;
  } catch { /* no readable config: the default providers */ }
  return DEFAULT_OPENCODE_PROVIDERS.slice();
}

async function main(argv) {
  const file = positionals(argv).filter(a => !a.startsWith("--"))[0];
  if (!file) {
    console.error("usage: node check-model-cards.mjs <cards-file> [--providers a,b]");
    return 2;
  }
  let cards;
  try {
    cards = loadCards(file);
  } catch (e) {
    console.log(`FAIL ${e.message}`);
    return 1;
  }
  if (!cards) { console.log(`FAIL ${file}: no such file`); return 1; }
  const providers = await opencodeProviders(argv);
  const lists = {};
  for (const host of SCOUT_HOSTS) lists[host] = readHostModels(host, { providers });
  const { gaps, notes } = checkCards(cards, lists);
  for (const n of notes) console.log(`note: ${n}`);
  const qn = qualityNote(cards);
  if (qn) console.log(`note: ${qn}`);
  const never = [];
  for (const [host, entry] of Object.entries(cards.hosts || {})) {
    for (const [id, card] of Object.entries((entry && entry.models) || {})) if (neverPickOf(card)) never.push(`${host}/${id}`);
  }
  if (never.length) console.log(`note: ${never.length} card${never.length === 1 ? "" : "s"} marked never_pick (never chosen automatically)`);
  if (gaps.length) {
    for (const g of gaps) console.log(`GAP ${g}`);
    console.log(`${gaps.length} gap${gaps.length === 1 ? "" : "s"} in ${file}`);
    return 1;
  }
  console.log(`OK ${file}: every card complete; every listed model has a card`);
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main(process.argv.slice(2)).then(code => process.exit(code));
