// lib/claims.mjs — release, expire and tidy claims on the project's claims board.
//
// Where the board lives is a house setting (config.json `claims_file`); no setting = the claims
// feature is off and every function here is a no-op returning an empty answer. Rows are read
// with the SAME grammar as the board reader (lib/house.mjs scanClaimLines): every
// `## Active claims` section is scanned (not just the first), the id and Files columns are found
// by header name, and a row sitting above its header row still counts.
//
//   releaseClaims    a run ends → its rows move to "Recently released" in one write
//   expireClaims     `resume --tidy` → rows whose run went dark (>12h, no LIVE.json) move too
//   removeGhostRows  `resume --tidy` → an Active row whose id is already released is deleted
//                    (obs 0089: a release that copied instead of moved left a blocking ghost)
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./paths.mjs";
import { readText, today } from "./util.mjs";
import { loadConfig } from "./config.mjs";
import { scanClaimLines, parseClaimsTable, claimsFilePath } from "./house.mjs";

/** The claims board for this project, or null when the claims feature is off. */
export function resolveClaimsPath(root = ROOT, config) {
  return claimsFilePath(root, config || loadConfig(root));
}

/** Kept for old callers: the configured claims board, or null. */
export function resolveActiveWorkPath() {
  return resolveClaimsPath(ROOT);
}

function hasActiveSection(text) {
  return /^#{1,6}\s+.*active\s+claims/im.test(text || "");
}

/**
 * Drop every Active-claims row for which `matchRow(entry)` is true. Returns
 * { removed: [{ id, files, task }], lines } — `lines` is the document minus those rows,
 * everything else byte-for-byte the same.
 */
function stripMatchingRows(text, matchRow) {
  const lines = text.split("\n");
  const drop = new Set();
  const removed = [];
  for (const e of scanClaimLines(text)) {
    if (e.section !== "active" || e.kind !== "row" || !e.id) continue;
    if (!matchRow(e)) continue;
    drop.add(e.i);
    const h = e.header || {};
    removed.push({
      id: e.id,
      files: h.files >= 0 ? e.cells[h.files] || "" : "",
      task: h.task >= 0 ? e.cells[h.task] || "" : ""
    });
  }
  return { removed, lines: lines.filter((_, i) => !drop.has(i)) };
}

/** Insert `bullets` right under the FIRST "Recently released" heading found in `lines`. */
function insertReleasedBullets(lines, bullets) {
  let insertIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^#{1,6}\s+.*recently\s+released/i.test(lines[i])) { insertIdx = i + 1; break; }
  }
  if (insertIdx === -1) return lines;       // no such section to insert under — nothing to do
  const out = lines.slice();
  let idx = insertIdx;
  while (idx < out.length && !out[idx].trim()) idx++;
  out.splice(idx, 0, ...bullets, "");
  return out;
}

/**
 * Archive "Recently released" entries beyond the newest 5 into `archive/` beside the claims
 * board (`<board-name>-released-<date>.md`).
 */
function archiveOverflow(text, boardPath) {
  const footerMatch = text.match(/Older rows live in[\s\S]*$/i);
  const footer = footerMatch ? footerMatch[0] : "";
  const beforeFooter = footerMatch ? text.slice(0, footerMatch.index) : text;

  const rrParts = beforeFooter.split(/##\s*Recently released/i);
  if (rrParts.length < 2) return text;

  const preRR = rrParts[0] + "## Recently released\n\n";
  const rrBody = rrParts.slice(1).join("## Recently released").trim();
  const rawItems = rrBody.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
  if (rawItems.length <= 5) return text;

  const keepItems = rawItems.slice(0, 5);
  const archiveItems = rawItems.slice(5);
  const stem = path.basename(boardPath).replace(/\.md$/i, "");
  const archPath = path.join(path.dirname(boardPath), "archive", `${stem}-released-${today()}.md`);
  let archContent = readText(archPath) || `# ${stem} — released rows archived ${today()}\n\n`;
  archContent = archContent.trim() + "\n\n" + archiveItems.join("\n\n") + "\n";
  fs.mkdirSync(path.dirname(archPath), { recursive: true });
  fs.writeFileSync(archPath, archContent);

  return preRR + keepItems.join("\n\n") + "\n\n" + footer;
}

/**
 * A run ended: move its claim rows from Active claims to Recently released in ONE write.
 * A row matches when its id is in `claimIds`, contains `runId`, or contains `onego-<taskSlug>`.
 * @returns {string[]} the released ids ([] when claims are off or nothing matched)
 */
export function releaseClaims(claimIds, taskSlug, runId, outcomeText, { config } = {}) {
  const awPath = resolveClaimsPath(ROOT, config);
  if (!awPath) return [];
  const text = readText(awPath);
  if (!text || !hasActiveSection(text)) return [];

  const matchRow = ({ id }) =>
    (claimIds && claimIds.has(id)) ||
    (runId && id.includes(runId)) ||
    (taskSlug && id.includes(`onego-${taskSlug}`));

  const { removed, lines } = stripMatchingRows(text, matchRow);
  if (!removed.length) return [];

  const bullets = removed.map(r => `- **${r.id}** released ${today()} — ${outcomeText}`);
  const withBullets = insertReleasedBullets(lines, bullets);
  const updatedText = archiveOverflow(withBullets.join("\n"), awPath);

  fs.writeFileSync(awPath, updatedText);
  return removed.map(r => r.id);
}

// ---------------------------------------------------------------- expireClaims (resume --tidy)

const EXPIRE_HOURS = 12;

/** A claim id is `C-<runId prefix>-p<n>` (see cmd/start.mjs) — tie it back to the run folder it
 * came from by prefix match. No match → null, and the caller never guesses: an un-tied claim is
 * left alone. */
function findRunForClaim(onegoDir, claimId) {
  const m = /^C-(.+)-p\d+$/.exec(claimId);
  if (!m) return null;
  const prefix = m[1];
  let dirs = [];
  try {
    dirs = fs.readdirSync(onegoDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
  } catch { return null; }
  const hits = dirs.filter(d => d.startsWith(prefix));
  if (!hits.length) return null;
  hits.sort((a, b) => b.localeCompare(a)); // newest first, in case of a shared prefix
  return hits[0];
}

function hoursSinceHeartbeat(runDir) {
  const beat = readText(path.join(runDir, "heartbeat.txt"));
  const m = String(beat || "").match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
  return (Date.now() - t) / 3600000;
}

/**
 * True only with positive evidence nobody is coming back for this claim: its run has no
 * LIVE.json AND its heartbeat.txt is more than 12h old. A claim that can't be tied to a run
 * folder, or whose run has no heartbeat to read, is never guessed at — it is left alone.
 */
function isClaimExpired(onegoDir, claimId) {
  const runId = findRunForClaim(onegoDir, claimId);
  if (!runId) return false;
  const runDir = path.join(onegoDir, runId);
  if (fs.existsSync(path.join(runDir, "LIVE.json"))) return false;
  const hours = hoursSinceHeartbeat(runDir);
  return hours != null && hours > EXPIRE_HOURS;
}

/**
 * Move every Active claim whose run has gone dark into Recently released, marked `expired`.
 * Called ONLY from `resume --tidy`, and a dry run unless `dryRun: false` is passed explicitly.
 * Ghost rows (already released) are left to removeGhostRows, which deletes instead of copying.
 */
export function expireClaims(onegoDir, { dryRun = false, config } = {}) {
  const awPath = resolveClaimsPath(ROOT, config);
  if (!awPath) return [];
  const text = readText(awPath);
  if (!text || !hasActiveSection(text)) return [];

  const { released } = parseClaimsTable(text);
  const { removed, lines } = stripMatchingRows(text, ({ id }) => !released.has(id) && isClaimExpired(onegoDir, id));
  if (!removed.length) return [];
  if (dryRun) return removed.map(r => r.id);

  const bullets = removed.map(r =>
    `- **${r.id}** released ${today()} — expired (no live conductor, heartbeat over ${EXPIRE_HOURS}h old)`
  );
  const withBullets = insertReleasedBullets(lines, bullets);
  fs.writeFileSync(awPath, withBullets.join("\n"));
  return removed.map(r => r.id);
}

/**
 * Delete every Active-claims row whose id is already released — listed under "Recently
 * released", or marked released/expired in its own Status cell. The release record stays; only
 * the stale copy goes. A certainty, not an inference (obs 0089), so no heartbeat is consulted.
 * @returns {{ removed: string[] }} — with `dryRun` (the default) nothing is written.
 */
export function removeGhostRows({ dryRun = true, config } = {}) {
  const awPath = resolveClaimsPath(ROOT, config);
  if (!awPath) return { removed: [] };
  const text = readText(awPath);
  if (!text || !hasActiveSection(text)) return { removed: [] };

  const { released } = parseClaimsTable(text);
  const { removed, lines } = stripMatchingRows(text, ({ id }) => released.has(id));
  const ids = [...new Set(removed.map(r => r.id))];
  if (ids.length && !dryRun) fs.writeFileSync(awPath, lines.join("\n"));
  return { removed: ids };
}

// ================================================================ own vs foreign claims
// fix D1 (pass 10 NO-GO): a job's OWN claim rows — the conductor claims the plan's files before
// `start` (the house protocol), and every pass carries a `claim_id` — used to count as another
// chat's, so start refused the job its own claim. A row is the job's own when its id is one of
// the job's run/pass claim ids, or its task/owner/id text names the job's slug or one of its run
// ids as a whole word (`fix-the-login` never matches `fix-the-login-2`).

const escapeRx = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const namesWord = (text, word) => Boolean(word) &&
  new RegExp(`(^|[^A-Za-z0-9_-])${escapeRx(word)}($|[^A-Za-z0-9_-])`, "i").test(String(text || ""));

/**
 * What marks a claim row as this job's own: its slug, every run id started for it, and every
 * claim id those runs recorded (state.claim_id, state.claim_ids[], passes[].claim_id).
 * @returns {{ slug: string, runIds: string[], claimIds: string[] }}
 */
export function ownClaimMarks(onegoDir, slug) {
  const runIds = [], claimIds = [];
  let dirs = [];
  try { dirs = fs.readdirSync(onegoDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch { /* no runs */ }
  for (const d of dirs) {
    if (!/^\d{4}-\d{2}-\d{2}-/.test(d)) continue;
    let state = null;
    try { state = JSON.parse(fs.readFileSync(path.join(onegoDir, d, "state.json"), "utf8")); } catch { continue; }
    if (!state || (state.slug || "") !== slug) continue;
    runIds.push(d);
    if (state.claim_id) claimIds.push(state.claim_id);
    if (Array.isArray(state.claim_ids)) claimIds.push(...state.claim_ids.filter(Boolean));
    for (const p of state.passes || []) if (p && p.claim_id) claimIds.push(p.claim_id);
  }
  return { slug, runIds, claimIds };
}

/** Is this claims-board row the job's own claim (see ownClaimMarks)? */
export function isOwnClaim(row, { slug, runIds = [], claimIds = [] } = {}) {
  if (!row) return false;
  const id = row.id || row.claim || "";
  if (id && claimIds.includes(id)) return true;
  const text = [id, row.task, row.owner].filter(Boolean).join(" | ");
  if (namesWord(text, slug)) return true;
  return runIds.some(r => namesWord(text, r));
}

/** The rows that belong to some OTHER chat — the only ones that may block this job. */
export function foreignClaims(rows, own) {
  return (rows || []).filter(r => !isOwnClaim(r, own));
}

/** The one refusal tail every claim-blocked message ends with: the claim ids and the way out. */
export function claimWayOut(slug, claimIds) {
  const ids = [...new Set(claimIds || [])].map(id => `\`${id}\``).join(", ");
  return `Held by another chat's claim ${ids}. Wait for it to be released, or — if you know that chat is done with those files — ` +
    `start anyway with \`board.mjs start ${slug} --ignore-claims\`.`;
}
