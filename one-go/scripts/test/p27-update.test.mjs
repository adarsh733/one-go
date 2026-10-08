// p27-update.test.mjs — v1.0.0: version numbers, the once-a-day new-version line, `/one-go update`.
// The "GitHub" here is a bare git repository in the OS temp folder; nothing touches the network,
// the real skill folder or the real home folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  parseVersion, compareVersions, newestTag, changesSince, noticeLine, updateNotice, installClone,
  readVersion, stateFile, readState, writeState, refresh, DAY_MS
} from "../lib/update.mjs";
import { runUpdate } from "../cmd/update.mjs";
import { COMMANDS, WORD_LISTS } from "../board.mjs";

const SKILL = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmp = name => fs.mkdtempSync(path.join(os.tmpdir(), `one-go-p27-${name}-`));
const rm = (...dirs) => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); };
// A copy of the skill made by hand (no git download above it). Built in the temp folder, so the
// tests below hold even when they are run from a real GitHub install of one-go.
function copiedSkill() {
  const base = tmp("copied");
  const dir = path.join(base, "one-go");
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(SKILL, "VERSION"), path.join(dir, "VERSION"));
  return { base, dir };
}

function g(cwd, ...args) {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false",
    "-c", "core.autocrlf=false", "-c", "init.defaultBranch=main", ...args], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" }
  });
}

/** Write one release's files into a package folder and commit + tag it. */
function release(work, version, agentText) {
  fs.mkdirSync(path.join(work, "one-go", "agents"), { recursive: true });
  fs.writeFileSync(path.join(work, ".one-go-package"), "marker\n");
  fs.writeFileSync(path.join(work, "one-go", "VERSION"), `${version}\n`);
  fs.writeFileSync(path.join(work, "one-go", "SKILL.md"), "# one-go\n");
  fs.writeFileSync(path.join(work, "one-go", "agents", "one-go-worker.md"), agentText);
  const old = fs.existsSync(path.join(work, "one-go", "CHANGELOG.md")) ? fs.readFileSync(path.join(work, "one-go", "CHANGELOG.md"), "utf8") : "# Changelog\n";
  fs.writeFileSync(path.join(work, "one-go", "CHANGELOG.md"), old.replace("# Changelog\n", `# Changelog\n\n## v${version} — 2026-10-06 — release ${version}\n`));
  g(work, "add", "-A");
  g(work, "commit", "-q", "-m", `one-go v${version}`);
  g(work, "tag", "-a", `v${version}`, "-m", `v${version}`);
}

/** A bare "GitHub", an install cloned from it at v1.0.0, and v1.1.0 published after. */
function world() {
  const base = tmp("world");
  const origin = path.join(base, "origin.git");
  const work = path.join(base, "work");
  const install = path.join(base, "install");
  const home = path.join(base, "home");
  const project = path.join(base, "project", ".claude", "one-go");
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  g(base, "init", "-q", "--bare", origin);
  g(work, "init", "-q");
  release(work, "1.0.0", "agent v1\n");
  g(work, "remote", "add", "origin", origin);
  g(work, "push", "-q", "origin", "main", "v1.0.0");
  g(base, "clone", "-q", origin, install);
  g(install, "config", "core.autocrlf", "false"); // this machine's own git settings must not rewrite line endings
  release(work, "1.1.0", "agent v2\n");
  g(work, "push", "-q", "origin", "main", "v1.1.0");
  const skillDir = path.join(install, "one-go");
  const env = { ...process.env, ONEGO_INSTALL_HOME: home, ONEGO_UPDATE_CHECK: "" };
  const lines = [];
  const deps = { skillDir, onegoDir: project, env, log: l => lines.push(l) };
  return { base, install, skillDir, home, project, env, lines, deps };
}

test("versions: read, compared, and the newest tag found", () => {
  assert.deepEqual(parseVersion("v1.2.3"), [1, 2, 3]);
  assert.equal(parseVersion("1.2"), null);
  assert.ok(compareVersions("1.10.0", "1.9.9") > 0);
  assert.equal(compareVersions("v1.0.0", "1.0.0"), 0);
  assert.ok(compareVersions("1.0.0", null) > 0, "an unreadable version is the oldest");
  assert.equal(newestTag("aaa\trefs/tags/v1.2.0\nbbb\trefs/tags/v1.10.0^{}\nccc\trefs/tags/nightly\n"), "1.10.0");
  assert.equal(newestTag("v0.9.0\nv1.0.0\n"), "1.0.0");
  assert.equal(newestTag(""), null);
  assert.equal(readVersion(SKILL) !== null, true, "the skill ships a VERSION file");
});

test("the changelog titles newer than the old version are listed, newest first", () => {
  const text = "# Changelog\n\n## v1.2.0 — 2026-11-01 — faster plans\n\n## v1.1.0 — 2026-10-20 — fix\n\n## v1.0.0 — 2026-10-06 — first\n";
  assert.deepEqual(changesSince(text, "1.0.0").map(c => c.version), ["1.2.0", "1.1.0"]);
  assert.equal(changesSince(text, "1.2.0").length, 0);
});

test("the notice line: only when the saved check knows of something newer", () => {
  assert.equal(noticeLine("1.0.0", { latest: "1.0.0" }), null);
  assert.equal(noticeLine("1.0.0", { latest: "0.9.0" }), null);
  assert.equal(noticeLine("1.0.0", null), null);
  assert.match(noticeLine("1.0.0", { latest: "1.3.0" }), /A newer one-go is out \(v1\.3\.0; you have v1\.0\.0\)\. Type \/one-go update/);
});

test("updateNotice never checks for a copy not installed from GitHub (the dev copy, a copied folder)", () => {
  const c = copiedSkill();
  try {
    assert.equal(installClone(c.dir), null, "a copied folder is not a download");
    let started = 0;
    assert.equal(updateNotice({ skillDir: c.dir, start: () => started++ }), null);
    assert.equal(started, 0);
  } finally { rm(c.base); }
});

test("updateNotice: background check at most once a day, notice read from the saved answer, never throws", () => {
  const w = world();
  try {
    let started = 0;
    const start = () => started++;
    const now = Date.parse("2026-10-06T10:00:00Z");
    // first job: nothing known yet → no line, one background check, attempt recorded
    assert.equal(updateNotice({ skillDir: w.skillDir, env: w.env, now, start }), null);
    assert.equal(started, 1);
    assert.ok(readState(stateFile(w.home)).checked);
    // later the same day: no second check
    updateNotice({ skillDir: w.skillDir, env: w.env, now: now + 3600e3, start });
    assert.equal(started, 1);
    // the background check found v1.1.0 → the next job shows the line
    writeState(stateFile(w.home), { checked: new Date(now).toISOString(), latest: "1.1.0" });
    assert.match(updateNotice({ skillDir: w.skillDir, env: w.env, now: now + 7200e3, start }), /v1\.1\.0; you have v1\.0\.0/);
    // a day on: one more check
    updateNotice({ skillDir: w.skillDir, env: w.env, now: now + DAY_MS + 1, start });
    assert.equal(started, 2);
    // switched off: silent and no check
    assert.equal(updateNotice({ skillDir: w.skillDir, env: { ...w.env, ONEGO_UPDATE_CHECK: "off" }, now: now + 3 * DAY_MS, start }), null);
    assert.equal(started, 2);
    // a damaged check file is not an error
    fs.writeFileSync(stateFile(w.home), "{not json");
    assert.doesNotThrow(() => updateNotice({ skillDir: w.skillDir, env: w.env, now, start: () => { throw new Error("boom"); } }));
  } finally { rm(w.base); }
});

test("refresh asks the download's own GitHub address and saves the newest version", () => {
  const w = world();
  try {
    assert.equal(refresh({ skillDir: w.skillDir, env: w.env }), "1.1.0");
    assert.equal(readState(stateFile(w.home)).latest, "1.1.0");
  } finally { rm(w.base); }
});

test("update --check says a newer one is out and changes nothing", async () => {
  const w = world();
  try {
    assert.equal(await runUpdate({ ARGV: ["update", "--check"] }, w.deps), 0);
    assert.match(w.lines.join("\n"), /newer one-go is out: v1\.1\.0 \(you have v1\.0\.0\)/);
    assert.equal(readVersion(w.skillDir), "1.0.0");
  } finally { rm(w.base); }
});

test("update moves to the newest version, lists what changed and refreshes an unedited helper agent", async () => {
  const w = world();
  try {
    const agent = path.join(w.home, ".claude", "agents", "one-go-worker.md");
    fs.mkdirSync(path.dirname(agent), { recursive: true });
    fs.writeFileSync(agent, "agent v1\n");
    assert.equal(await runUpdate({ ARGV: ["update"] }, w.deps), 0, w.lines.join("\n"));
    const out = w.lines.join("\n");
    assert.match(out, /Updated one-go v1\.0\.0 → v1\.1\.0/);
    assert.match(out, /v1\.1\.0 — 2026-10-06 — release 1\.1\.0/);
    assert.doesNotMatch(out, /v1\.0\.0 — 2026-10-06/, "only the releases it brought in");
    assert.equal(readVersion(w.skillDir), "1.1.0");
    assert.equal(fs.readFileSync(agent, "utf8"), "agent v2\n");
    // a second update: already up to date
    w.lines.length = 0;
    assert.equal(await runUpdate({ ARGV: ["update"] }, w.deps), 0);
    assert.match(w.lines.join("\n"), /up to date \(v1\.1\.0\)/);
  } finally { rm(w.base); }
});

test("update leaves a hand-edited helper agent alone", async () => {
  const w = world();
  try {
    const agent = path.join(w.home, ".claude", "agents", "one-go-worker.md");
    fs.mkdirSync(path.dirname(agent), { recursive: true });
    fs.writeFileSync(agent, "my own agent\n");
    assert.equal(await runUpdate({ ARGV: ["update"] }, w.deps), 0);
    assert.equal(fs.readFileSync(agent, "utf8"), "my own agent\n");
    assert.match(w.lines.join("\n"), /edited by hand, so it was left alone/);
  } finally { rm(w.base); }
});

test("update refuses, changing nothing, while a job is running in the project", async () => {
  const w = world();
  try {
    const run = "2026-10-06-1000-some-job";
    fs.mkdirSync(path.join(w.project, run), { recursive: true });
    fs.writeFileSync(path.join(w.project, run, "state.json"), "{}");
    fs.mkdirSync(path.join(w.project, "ACTIVE.d"), { recursive: true });
    fs.writeFileSync(path.join(w.project, "ACTIVE.d", run), run);
    assert.equal(await runUpdate({ ARGV: ["update"] }, w.deps), 1);
    assert.match(w.lines.join("\n"), /A job is running in this project/);
    assert.equal(readVersion(w.skillDir), "1.0.0");
  } finally { rm(w.base); }
});

test("update refuses, changing nothing, when one-go's own files were edited", async () => {
  const w = world();
  try {
    fs.appendFileSync(path.join(w.skillDir, "SKILL.md"), "my note\n");
    assert.equal(await runUpdate({ ARGV: ["update"] }, w.deps), 1);
    assert.match(w.lines.join("\n"), /You have changed 1 of one-go's own file/);
    assert.match(w.lines.join("\n"), /one-go\/SKILL\.md/);
    assert.equal(readVersion(w.skillDir), "1.0.0");
    assert.equal(fs.readFileSync(path.join(w.skillDir, "SKILL.md"), "utf8"), "# one-go\nmy note\n");
  } finally { rm(w.base); }
});

test("update refuses for a copy not installed from GitHub", async () => {
  const c = copiedSkill();
  const none = tmp("none");
  try {
    const lines = [];
    const code = await runUpdate({ ARGV: ["update"] }, { skillDir: c.dir, onegoDir: none, env: process.env, log: l => lines.push(l) });
    assert.equal(code, 1);
    assert.match(lines.join("\n"), /was not installed from GitHub, so it cannot update itself\. Nothing was changed\./);
  } finally { rm(c.base, none); }
});

test("update is a public command that reads no board", () => {
  assert.ok(WORD_LISTS.public.includes("update"));
  assert.equal(COMMANDS.update.ctx, "none");
  assert.equal(COMMANDS.update.fit, "nothing");
});
