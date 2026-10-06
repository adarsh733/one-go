// p24-snapshot.test.mjs — D8 (obs 0065, 0111, 0135): `start` snapshots every file the plan's passes
// declare; `pass <job> <n> done` compares the tree with it, flags (never refuses) what was written
// outside the pass's list, and leaves old runs (no snapshot.json) alone. Sandbox only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { makeSandbox, runBoard } from "./helpers.mjs";

const SLUG = "snap-job";
const sha1 = s => crypto.createHash("sha1").update(s).digest("hex");

/** Three independent passes: a.txt, b.txt, and c.txt plus a glob. `out/old.txt` exists before the run. */
function seed(sb) {
  const out = path.join(sb.root, "out");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "old.txt"), "before\n");
  fs.writeFileSync(path.join(out, "b.txt"), "b-before\n");
  const mk = (n, writes) => ({
    n, purpose: `Write part ${n}`, writes, route: { requested_model: "build" },
    required_check: { command: "node -e \"process.exit(0)\"" }
  });
  const plan = {
    schema: 1, plan_id: `plan-${SLUG}`, plan_revision: 1,
    passes: [mk(1, ["out/a.txt"]), mk(2, ["out/b.txt"]), mk(3, ["out/{c,d}.txt", "gen/**"])]
  };
  fs.writeFileSync(path.join(sb.plansDir, `${SLUG}.plan.json`), JSON.stringify(plan, null, 2));
  const b = JSON.parse(fs.readFileSync(sb.boardPath, "utf8"));
  b.tasks[SLUG] = { display: "Snap Job", stage: "waiting" };
  fs.writeFileSync(sb.boardPath, JSON.stringify(b, null, 2));
}
const runDirOf = sb => {
  const d = fs.readdirSync(sb.onegoDir).filter(x => x.endsWith(`-${SLUG}`)).sort().pop();
  assert.ok(d, "a run folder was written");
  return path.join(sb.onegoDir, d);
};
const readState = sb => JSON.parse(fs.readFileSync(path.join(runDirOf(sb), "state.json"), "utf8"));
const done = (sb, n) => runBoard(["pass", SLUG, String(n), "done", "--proven", "wrote it", "--no-check", "test"], sb.root);
const write = (sb, rel, text) => { const f = path.join(sb.root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };

test("start writes snapshot.json: declared files (sha1 + size, or absent), braces expanded, globs kept as patterns", () => {
  const sb = makeSandbox();
  try {
    seed(sb);
    const r = runBoard(["start", SLUG], sb.root);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /snapshot: 4 declared files and 1 pattern recorded/);
    const snap = JSON.parse(fs.readFileSync(path.join(runDirOf(sb), "snapshot.json"), "utf8"));
    const byDecl = Object.fromEntries(Object.values(snap.files).map(f => [f.decl, f]));
    assert.deepEqual(Object.keys(byDecl).sort(), ["out/a.txt", "out/b.txt", "out/c.txt", "out/d.txt"]);
    assert.equal(byDecl["out/a.txt"].state, "absent");
    assert.equal(byDecl["out/b.txt"].state, "file");
    assert.equal(byDecl["out/b.txt"].sha1, sha1("b-before\n"));
    assert.equal(byDecl["out/b.txt"].size, "b-before\n".length);
    assert.deepEqual(byDecl["out/c.txt"].passes, [3]);
    assert.equal(snap.patterns.length, 1);
    assert.equal(snap.patterns[0].decl, "gen/**");
    assert.equal(snap.patterns[0].expanded, false, "a pattern is recorded as a pattern, not silently skipped");
    // the folder the pass writes into is listed one level deep, so a stray file next to the work is seen
    const outFolder = Object.values(snap.folders).find(f => f.dir.replace(/\\/g, "/").endsWith("/out"));
    assert.ok(outFolder && outFolder.files["old.txt"], "out/ listed with old.txt");
  } finally { sb.teardown(); }
});

test("a clean pass prints the clean line and the run carries on", () => {
  const sb = makeSandbox();
  try {
    seed(sb);
    assert.equal(runBoard(["start", SLUG], sb.root).code, 0);
    write(sb, "out/a.txt", "a\n");
    const r = done(sb, 1);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /nothing written outside, nothing lost/);
    assert.doesNotMatch(r.stdout, /WARNING/);
    const st = readState(sb);
    assert.equal(st.snapshot_flags, undefined, "nothing flagged");
    assert.equal(st.passes.find(p => p.n === 1).status, "done");
  } finally { sb.teardown(); }
});

test("a write outside the list is flagged, recorded in state, and the pass is still accepted", () => {
  const sb = makeSandbox();
  try {
    seed(sb);
    assert.equal(runBoard(["start", SLUG], sb.root).code, 0);
    write(sb, "out/a.txt", "a\n");              // its own file — fine
    write(sb, "out/b.txt", "OVERWRITTEN\n");    // pass 2's file, pass 2 not running — outside
    write(sb, "out/stray.txt", "oops\n");       // undeclared, in the folder pass 1 writes into — outside
    fs.rmSync(path.join(sb.root, "out", "old.txt")); // something that was there before is gone — lost
    const r = done(sb, 1);
    assert.equal(r.code, 0, "flags, never refuses: " + r.stdout);
    assert.match(r.stdout, /WARNING/);
    assert.match(r.stdout, /changed: out\/b\.txt/);
    assert.match(r.stdout, /created: out\/stray\.txt/);
    assert.match(r.stdout, /deleted: out\/old\.txt/);
    assert.doesNotMatch(r.stdout, /out\/a\.txt \(/, "its own file is never reported");
    assert.doesNotMatch(r.stdout, /nothing written outside, nothing lost/);
    const st = readState(sb);
    assert.equal(st.passes.find(p => p.n === 1).status, "done");
    assert.equal(st.snapshot_flags.length, 1);
    assert.deepEqual(st.snapshot_flags[0].files.map(f => `${f.kind}:${path.basename(f.path)}`).sort(),
      ["changed:b.txt", "created:stray.txt", "deleted:old.txt"]);
    assert.ok(st.open_items.some(i => i.kind === "outside_write" && i.pass === 1), "an open item is recorded");
    // reported once: the next clean pass is not blamed for the same files
    write(sb, "out/b.txt", "b-final\n");
    const second = runBoard(["pass", SLUG, "2", "done", "--proven", "wrote it", "--no-check", "test"], sb.root);
    assert.match(second.stdout, /nothing written outside, nothing lost/);
  } finally { sb.teardown(); }
});

test("a file on a RUNNING pass's list is that pass's own business, not outside", () => {
  const sb = makeSandbox();
  try {
    seed(sb);
    assert.equal(runBoard(["start", SLUG], sb.root).code, 0);
    const statePath = path.join(runDirOf(sb), "state.json");
    const st = JSON.parse(fs.readFileSync(statePath, "utf8"));
    st.passes.find(p => p.n === 2).status = "running";
    fs.writeFileSync(statePath, JSON.stringify(st, null, 2));
    write(sb, "out/a.txt", "a\n");
    write(sb, "out/b.txt", "pass 2 is mid-write\n");   // pass 2 is running beside pass 1
    write(sb, "gen/x/y.txt", "generated\n");           // under pass 3's glob; the glob is never walked
    const r = done(sb, 1);
    assert.equal(r.code, 0, r.stdout);
    assert.doesNotMatch(r.stdout, /b\.txt/, "a running pass's file is not reported");
    // gen/ is not a folder pass 1 writes into, and a glob is recorded, not walked: nothing to report
    assert.match(r.stdout, /nothing written outside, nothing lost/);
  } finally { sb.teardown(); }
});

test("a run with no snapshot.json says so and carries on (every run started before D8)", () => {
  const sb = makeSandbox();
  try {
    seed(sb);
    assert.equal(runBoard(["start", SLUG], sb.root).code, 0);
    fs.rmSync(path.join(runDirOf(sb), "snapshot.json"));
    write(sb, "out/a.txt", "a\n");
    write(sb, "out/b.txt", "touched\n");
    const r = done(sb, 1);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /snapshot: not recorded for this run/);
    assert.doesNotMatch(r.stdout, /WARNING/);
    assert.equal(readState(sb).passes.find(p => p.n === 1).status, "done");
    assert.equal(fs.existsSync(path.join(runDirOf(sb), "snapshot.json")), false, "no snapshot is invented afterwards");
  } finally { sb.teardown(); }
});
