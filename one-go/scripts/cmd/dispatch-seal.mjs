// cmd/dispatch-seal.mjs — the pass-0 reading brief that `dispatch "<text>" --seal` writes.
//
// It must be SELF-CONTAINED (obs 0104): the reading worker gets this one file and nothing else —
// no SKILL.md, no conductor guide. So everything the reading needs is written into it: the job
// text, where the plan goes, the plan template with one filled example row, the nine things the
// reading must gather, how to write the questions, the seal-gate rules, the dry-run rule
// (obs 0101), "run check-plan until it passes" (obs 0102), and the house's conductor section
// and paths when the project has them. No owner name, no project path is baked in here.
import { tiersFor } from "../lib/route.mjs";
import { WHOLE_TREE_CHECK_WORDS } from "../lib/plan.mjs";
import { cardsStatus, sealCardsLine } from "./models.mjs";

/** The nine things every reading gathers. Same words as reference/CONDUCTOR.md. */
export const GATHERABLES = [
  ["The reading list — every file read before a question was written", "\"I read it all\" becomes checkable"],
  ["The pass list — what each pass does, in order", "the shape of the run"],
  ["The exact files each pass writes", "separate sets, and the input to running passes side by side"],
  ["Every new file path that a project guard must approve first", "listed with its register command (below), run before `start`"],
  ["Every other guard or hook that could stop a pass", "cleared with the person's yes, or the pass reshaped to avoid it"],
  ["Every assumption that would otherwise be taken silently", "each becomes a numbered question"],
  ["What \"done\" looks like per pass, and the command that proves it", "so the report cannot lie"],
  ["The model for each pass (table below)", "the heavy thinking goes to the strong model, the rest does not"],
  ["What the run is likely to hit — a missing tool, an absent test file, a login", "checked, not assumed"]
];

/**
 * Build the seal brief text.
 * @param {object} o
 * @param {string} o.slug         the job's slug (the plan file is plans/<slug>.md)
 * @param {string} o.text         the person's words, exactly
 * @param {string[]} o.named      file-like tokens found in the text
 * @param {string} o.planPath     absolute path of the plan file the worker writes
 * @param {string} o.boardCmd     how to run the engine, e.g. `node "<skill>/scripts/board.mjs"`
 * @param {string} o.root         the project folder (declared paths are relative to it)
 * @param {boolean} o.draftExists a draft plan is already on disk (continue it, never restart)
 * @param {object} o.config       loadConfig() result
 * @param {object} o.house        loadHouseRules() result
 * @param {object} [o.cardsState]  cardsStatus() result — worked out here from config.model_cards when omitted
 * @param {object} [o.readers]     injected tool readers for that check (tests); never set in production
 * @returns {string}
 */
export function buildSealBrief({ slug, text, named = [], planPath, boardCmd, root = "", draftExists = false, config = {}, house = {}, cardsState, readers }) {
  const L = [];
  // One line about the model cards. Never throws: a card check that fails must not stop a seal brief.
  let cardsLine;
  try {
    cardsLine = sealCardsLine(cardsState || cardsStatus({ config, root, readers }));
  } catch (e) {
    cardsLine = `Model cards: could not be checked (${String(e && e.message).split("\n")[0]}) — no refresh question needed.`;
  }
  const tiers = tiersFor(config);
  const allowed = Array.isArray(config.worker_always_allowed) ? config.worker_always_allowed : [];

  L.push(`# SEAL BRIEF — ${slug} · pass 0 (reading)`);
  L.push("");
  L.push("You are the reading worker. Read every file this job will touch, then write the plan below.");
  L.push("You do not build anything. Everything you need is in this file; read nothing else about how");
  L.push("the runner works.");
  L.push("");
  L.push("## Job (free text)");
  L.push(text);
  L.push("");
  L.push("## Files it names");
  if (named.length) for (const f of named) L.push(`- \`${f}\``);
  else L.push("- (none found in the text)");
  L.push("");
  L.push("## What you write");
  L.push(`- ONE file: \`${planPath}\` — the plan, in the template below.`);
  if (allowed.length) {
    L.push("- Also always allowed (every worker in this project):");
    for (const p of allowed) L.push(`  - \`${p}\``);
  }
  L.push("- Nothing else. Never edit the project's own files; the passes do that after the questions are answered.");
  if (draftExists) {
    L.push("- A draft of this plan is ALREADY on disk. Continue it: keep every row it has, do not re-read the files");
    L.push("  its reading list names, and never start the reading again.");
  }
  L.push("");
  L.push("## Rule");
  L.push("Append each file to `## What I read before asking` as you read it — never in one write at the end.");
  L.push("A worker that is cut off must still leave a real reading list behind.");
  L.push("");

  L.push("## What the reading must gather — nine things, every time");
  L.push("| # | What | Why |");
  L.push("|---|---|---|");
  GATHERABLES.forEach(([what, why], i) => L.push(`| ${i + 1} | ${what} | ${why} |`));
  L.push("");
  L.push("A question that a file on the reading list would have answered is a planning failure.");
  L.push("");

  L.push("## The plan file — copy this shape exactly");
  L.push("```markdown");
  L.push("# <Job name in plain words>");
  L.push("State: draft");
  L.push("");
  L.push("## What \"done\" looks like");
  L.push("One or two plain lines. If this cannot be written plainly, the job is not ready — say so.");
  L.push("");
  L.push("## What I read before asking");
  L.push("| File | Why it mattered |");
  L.push("|---|---|");
  L.push("| src/search/query.js | builds the query; splits on spaces, so two-word foods return nothing |");
  L.push("");
  L.push("## Fixed names");
  L.push("(Optional.) Every name two passes must agree on — a function, a file, a setting. Copied word");
  L.push("for word into every pass's instructions so passes running side by side cannot drift apart.");
  L.push("");
  L.push("## Run shape");
  L.push("- **Pieces:** home screen (p1), settings screen (p2), profile screen (p3), wiring (p4), end-to-end check (p5), fixes (p6) — each is its own pass because it writes its own files and can be checked alone");
  L.push("- **Needs:** p4 needs p1, p2 and p3 (it wires their output together); p5 needs p4; p6 needs p5; p1, p2 and p3 need nothing");
  L.push("- **Waves line:** Waves: 1) p1, p2, p3 · 2) p4 · 3) p5 · 4) p6");
  L.push("- **Unlocks:** none needed — or name a small first pass (splitting a shared file, fixing shared names) that would let more passes run at once");
  L.push("- **Summary line:** 6 passes in 4 waves");
  L.push("(If the job came from a handoff or pasted note, add one more line: `the handoff had X passes in Y waves → this plan has N in M`.)");
  L.push("");
  L.push("## Passes");
  L.push("| # | What it does | Model | Files it writes | Proven by | Depends on |");
  L.push("|---|---|---|---|---|---|");
  L.push(`| 1 | Make the query keep multi-word terms together, with a test | build | src/search/query.js, test/query.test.js | npm test -- query | — |`);
  L.push("");
  L.push("Dry-run today: p1 exit 1 (the new test does not exist yet — expected)");
  L.push("");
  L.push("(Optional last column `Generates` — files the pass's own check rewrites as a side effect, e.g. a built page:");
  L.push("the header then ends `| Depends on | Part | Generates |` and a row ends `| — | — | dist/index.html |`. The engine ignores those paths when it asks \"did a file");
  L.push("change while the check ran\". Leave the column out when there is nothing to list.)");
  L.push("");
  L.push("## Paths to register before the run");
  L.push("| Path | Why | Registered? |");
  L.push("|---|---|---|");
  L.push("");
  L.push("## Open questions");
  L.push("1. **Plain question?** A ★ option · B option · C option. *Trade-off in one line.*");
  L.push("");
  L.push("## Answers");
  L.push("(left empty — the conductor writes the person's words here, with the date)");
  L.push("```");
  L.push("- The second line stays `State: draft`. Sealing is the conductor's job, after the answers.");
  L.push("- \"Depends on\" holds pass numbers (`1, 2`) or `—`. An optional last column `Part` names which");
  L.push("  part of the job a pass belongs to.");
  L.push("");

  L.push("## Run shape — plan the width before the table (mandatory)");
  L.push("The plan must carry a `## Run shape` section, placed before `## Passes`, with these five bullets in this order:");
  L.push("1. **Pieces** — the pieces of the job, and why each is its own pass.");
  L.push("2. **Needs** — what truly needs what.");
  L.push("3. **Waves** — the same line `check-plan` prints, e.g. `Waves: 1) p1, p2, p3 · 2) p4`.");
  L.push("4. **Unlocks** — a small first pass, such as splitting a shared file or fixing shared names, that would let");
  L.push("   more passes run at once. Propose it as its own small first pass; write \"none needed\" when there is none.");
  L.push("5. **Summary** — the summary line, exactly in the form `N passes in M waves` (e.g. `4 passes in 2 waves`).");
  L.push("");
  L.push("How to shape it:");
  L.push("- Build every independent piece (each screen, each module) as its own pass in the first wave, then wire them");
  L.push("  together, then run one end-to-end check, then fix what it finds.");
  L.push("- Make a pass wait on another only when it needs that pass's output. A wait added \"to be safe\" is a plan");
  L.push("  fault. The engine finds file clashes itself, so never add a wait just because two passes touch the same folder.");
  L.push("- If the job text, a handoff or a pasted note already lists passes, that list is INPUT, never the plan:");
  L.push("  re-shape it through this section, and add the line `the handoff had X passes in Y waves → this plan has N in M`.");
  L.push("");

  L.push("## Models — column 3 of the Passes table");
  L.push("| Tier | Use for | Write |");
  L.push("|---|---|---|");
  for (const id of ["think", "build", "mechanical"]) {
    const t = tiers[id];
    L.push(`| ${id} | ${t.when} | \`${id}\` |`);
  }
  L.push("Choose the passes first and the models second; never invent a pass to use a model. A pass earns");
  L.push("its own worker only when its work is clearly bigger than a worker's start-up — merge smaller ones.");
  L.push(cardsLine);
  L.push("");

  L.push("## The seal gate — what `check-plan` refuses");
  L.push("- **\"Proven by\" must be a command the engine can run** (`npm test`, `node scripts/check.mjs`,");
  L.push("  `pytest tests/x.py`). Words like \"checked by eye\" are refused — put them in \"What it does\" and use");
  L.push("  `—` in the cell when there is truly nothing to run.");
  L.push("- **Dry-run every \"Proven by\" command before you finish** and record its exit code today in the plan,");
  L.push("  one line under the Passes table (`Dry-run today: p1 exit 1 (the new test does not exist yet) · p2 exit 2 (why)`).");
  L.push("  A check that already fails for an unrelated reason can never go green — reshape it now, or say so as a question.");
  L.push("- **A check that is already green proves nothing.** A `Dry-run today` entry of `exit 0` is refused by");
  L.push("  `check-plan`: the check passed before the work, so it cannot show the work was done. Reshape it so it");
  L.push("  fails until the pass has done its job (a test the pass writes, a string only the new code contains).");
  L.push("- **\"Proven by\" covers only the pass's own files.** It must not run a whole-suite sweep: a red test in");
  L.push("  a file no pass owns would hold this pass hostage. Whole-suite sweeps belong to one final review pass at the");
  L.push("  end, which depends on every other pass.");
  L.push("- **Every declared file must be findable**: a file that exists; a new file whose folder exists; a new");
  L.push("  file whose folder an earlier pass declares; or a pattern (`src/search/*.js`). Paths are relative to");
  L.push("  the project folder, or absolute.");
  L.push("- **Every row has exactly as many cells as the header**, and no cell contains `\\|` or a bare `|`");
  L.push("  (write \"or\" instead).");
  L.push("- **List every file a pass writes, exactly.** The engine compares them and finds file clashes itself, so");
  L.push("  two passes that could run side by side must not share a file. Patterns count once expanded:");
  L.push("  `src/**` and `src/a.js` overlap.");
  L.push("- **The plan has a `## Run shape` section** (see above); a plan without one is refused.");
  L.push(`- A "Proven by" command that contains one of the words ${WHOLE_TREE_CHECK_WORDS.slice(0, -1).join(", ")} or ${WHOLE_TREE_CHECK_WORDS[WHOLE_TREE_CHECK_WORDS.length - 1]}`);
  L.push("  reads the whole app, so that pass runs only when no other pass is still writing. The words are read from the");
  L.push("  \"Proven by\" command only, never from the description. Use them only when the check truly reads the whole app.");
  L.push("");
  L.push("**Run this until it prints OK, fixing the plan each time:**");
  L.push("```");
  L.push(`${boardCmd} check-plan ${slug}`);
  L.push("```");
  if (root) L.push(`Run it from the project folder: \`${root}\`.`);
  L.push("It lists every problem at once. A plan that fails it is not finished.");
  L.push("");

  L.push("## The questions — how to write them");
  L.push("The person answering is not an engineer. For every question:");
  L.push("- Plain everyday words. If a technical term cannot be avoided, explain it right there with a short");
  L.push("  everyday example (\"a cache — a saved copy, like a photo of a page instead of the page\").");
  L.push("- Options lettered **A / B / C**, each one short line saying what happens.");
  L.push("- **Exactly one ★** — your recommendation — on each question.");
  L.push("- One line of trade-off in italics: what they give up with each choice.");
  L.push("- Numbered, all in the one `## Open questions` section, so they can answer in one line (`1A 2B 3A`)");
  L.push("  or say \"use your recommendations\". There is no limit on how many; every assumption is one.");
  L.push("- Never ask what a file on your reading list already answers.");
  L.push("");

  if (config.register_command) {
    L.push("## New files this project must approve first");
    L.push("For every NEW `.md` or `.html` path any pass declares, add a row to `## Paths to register before the");
    L.push("run` and put this command beside it (do not run it — the person approves it first):");
    L.push("```");
    L.push(`${config.register_command} <path> --why "<why>"`);
    L.push("```");
    L.push("");
  }

  const conductor = house && house.conductor ? String(house.conductor).trim() : "";
  if (conductor) {
    L.push("## House rules — for the conductor (this project's own rules, word for word)");
    L.push("They change what the plan must contain. Where they disagree with this brief, they win.");
    L.push("");
    L.push(conductor);
    L.push("");
  }

  L.push("## Rules");
  L.push("- never commit or push");
  L.push("- never write outside the files named under \"What you write\"");
  L.push("- blocked after 2 attempts at the same thing → stop, report PARKED with the exact question");
  L.push("- final report ≤12 lines");
  L.push("");
  L.push("## Report back (exact format)");
  L.push("≤12 lines total:");
  L.push("- the plan's path (1 line)");
  L.push("- files read, passes drafted, questions written — three numbers (1 line)");
  L.push("- what you proved: the exact check-plan command you ran, and its exit code (1 line)");
  L.push("- the dry-run exit code of every Proven-by command (max 3 lines)");
  L.push("- anything parked, or risky, in one line each (max 3 lines)");
  L.push("- Protocols run: which standing protocols you ran, or none (1 line)");
  return L.join("\n") + "\n";
}
