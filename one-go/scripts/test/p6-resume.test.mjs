// p6-resume.test.mjs — `resume` (public) = `revive` (silent alias): a run with `ended` + report.md
// counts as finished, reviewer-flags.md open items are counted (obs 0067), declared absolute
// paths stay absolute (obs 0066), `--tidy` removes ghost claim rows (obs 0089), `--apply` rules
// unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeSandbox, runBoard } from "./helpers.mjs";
import { isRunFinished } from "../cmd/revive.mjs";

function addRun(sb, runId, slug, passes, extra = {}) {
  const dir = path.join(sb.onegoDir, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "state.json"),
    JSON.stringify({ schema: 3, run_id: runId, slug, started: "2026-09-27 10:00", passes, ...extra }, null, 2));
  fs.writeFileSync(path.join(dir, "heartbeat.txt"), "2026-09-27 10:00\n");
  return dir;
}

test("isRunFinished: ended AND report.md, nothing less", () => {
  const sb = makeSandbox();
  try {
    const dir = addRun(sb, "2026-09-27-1000-a", "a", [{ n: 1, status: "parked" }]);
    assert.equal(isRunFinished(dir, { ended: "" }), false);
    assert.equal(isRunFinished(dir, { ended: "2026-09-27 11:00 — finished with 1 open item" }), false, "no report yet");
    fs.writeFileSync(path.join(dir, "report.md"), "# r\n");
    assert.equal(isRunFinished(dir, { ended: "2026-09-27 11:00 — finished with 1 open item" }), true);
    assert.equal(isRunFinished(dir, {}), false, "a report alone is not an ending");
  } finally { sb.teardown(); }
});

test("resume lists only runs that never ended; a closed run with open items counts as finished", () => {
  const sb = makeSandbox();
  try {
    const closed = addRun(sb, "2026-09-27-0900-closed-job", "closed-job",
      [{ n: 1, title: "x", status: "parked", parked_question: "Q?" }],
      { ended: "2026-09-27 09:30 — finished with 1 open item", ending: "FINISHED WITH OPEN ITEMS" });
    fs.writeFileSync(path.join(closed, "report.md"), "# closed\n");
    addRun(sb, "2026-09-27-1000-open-job", "open-job", [{ n: 1, title: "y", status: "parked", parked_question: "Q?" }]);
    addRun(sb, "2026-09-27-1100-half-job", "half-job", [{ n: 1, title: "z", status: "done" }],
      { ended: "2026-09-27 11:30 — stopped: no report" });

    const r = runBoard(["resume"], sb.root);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /2 runs never finished/);
    assert.match(r.stdout, /open-job/);
    assert.doesNotMatch(r.stdout, /closed-job/);
    assert.doesNotMatch(r.stdout, /sample-run/, "an older-engine run with every pass done and a report stays finished");
    assert.match(r.stdout, /half-job[\s\S]*ended, but its closing report was never written/);
    assert.match(r.stdout, /board\.mjs close <run folder name>/, "the list says how to end one");

    const alias = runBoard(["revive"], sb.root);
    assert.equal(alias.code, 0);
    assert.equal(alias.stdout, r.stdout, "revive is the same command");
  } finally { sb.teardown(); }
});

test("resume counts open reviewer-flags.md items (ticked and answered ones excluded)", () => {
  const sb = makeSandbox();
  try {
    const dir = addRun(sb, "2026-09-27-1000-flag-job", "flag-job", [
      { n: 1, title: "a", status: "done", proven: "ran it" },
      { n: 2, title: "b", status: "parked", parked_question: "Which font?" }
    ]);
    fs.writeFileSync(path.join(dir, "reviewer-flags.md"), [
      "# Reviewer flags", "",
      "- [ ] Is the spacing right on small screens?",
      "- The empty state copy needs a decision",
      "- [x] Already sorted",
      "", "## Answered", "",
      "- Old question, answered", ""
    ].join("\n"));

    const list = runBoard(["resume"], sb.root);
    assert.equal(list.code, 0);
    assert.match(list.stdout, /1 waiting on your answer · 2 reviewer notes waiting on your answer/);
    assert.match(list.stdout, /🟡/);

    const one = runBoard(["resume", "1"], sb.root);
    assert.equal(one.code, 0, one.stdout + one.stderr);
    assert.match(one.stdout, /Waiting on you: 1 parked or failed pass · 2 open reviewer notes/);
    assert.match(one.stdout, /Is the spacing right on small screens\?/);
    assert.doesNotMatch(one.stdout, /Already sorted|Old question/);
    assert.match(one.stdout, /board\.mjs close 2026-09-27-1000-flag-job/);
    const brief = fs.readFileSync(path.join(dir, "RESUME-BRIEF.md"), "utf8");
    assert.match(brief, /Reviewer notes still open \(2\)/);
  } finally { sb.teardown(); }
});

test("resume <run>: an absolute declared path stays absolute (obs 0066)", () => {
  const sb = makeSandbox();
  try {
    const outside = fs.mkdtempSync(path.join(path.dirname(sb.root), "one-go-abs-"));
    try {
      const file = path.join(outside, "built.txt");
      fs.writeFileSync(file, "x");
      addRun(sb, "2026-09-27-1000-abs-job", "abs-job", [
        { n: 1, title: "writes outside the workspace", status: "running", files: [file] }
      ]);
      const r = runBoard(["resume", "2026-09-27-1000-abs-job"], sb.root);
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /files are all there/);
      assert.doesNotMatch(r.stdout, /disk : NOT STARTED/);
      assert.ok(r.stdout.includes(file), "a file outside the workspace is shown by its own absolute path");
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  } finally { sb.teardown(); }
});

test("resume --apply with no run refuses and writes nothing", () => {
  const sb = makeSandbox();
  try {
    const r = runBoard(["resume", "--apply"], sb.root);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /needs a run number or name/);
  } finally { sb.teardown(); }
});

test("resume --tidy previews ghost claim rows; --tidy --apply removes them (obs 0089)", () => {
  const sb = makeSandbox();
  try {
    fs.writeFileSync(path.join(sb.onegoDir, "config.json"), JSON.stringify({ claims_file: "claims.md" }));
    const claims = path.join(sb.root, "claims.md");
    const text = [
      "# Claims", "", "## Active claims", "",
      "| Claim ID | Owner | Status | Started | Heartbeat | Files/globs |",
      "|---|---|---|---|---|---|",
      "| C-ghost-1 | one-go | running | 09:00 | 09:00 | `a/**` |",
      "| C-live-2 | someone | running | 09:00 | 09:00 | `b/**` |",
      "", "## Recently released", "",
      "- **C-ghost-1** released 2026-09-26 — finished", ""
    ].join("\n");
    fs.writeFileSync(claims, text);

    const dry = runBoard(["resume", "--tidy"], sb.root);
    assert.equal(dry.code, 0, dry.stdout + dry.stderr);
    assert.match(dry.stdout, /1 ghost claim row .* would remove: C-ghost-1/);
    assert.equal(fs.readFileSync(claims, "utf8"), text, "a dry run changes nothing");

    const wet = runBoard(["resume", "--tidy", "--apply"], sb.root);
    assert.equal(wet.code, 0, wet.stdout + wet.stderr);
    const after = fs.readFileSync(claims, "utf8");
    const [active, released] = after.split("## Recently released");
    assert.doesNotMatch(active, /C-ghost-1/);
    assert.match(active, /C-live-2/);
    assert.match(released, /C-ghost-1/, "the release record stays");
  } finally { sb.teardown(); }
});
