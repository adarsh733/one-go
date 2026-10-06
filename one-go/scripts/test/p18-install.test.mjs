// p18-install.test.mjs — install.mjs against a sandbox home (ONEGO_INSTALL_HOME). Never the real home.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const INSTALL = path.join(SKILL, "scripts", "install.mjs");
const AGENT_SRC = path.join(SKILL, "agents", "one-go-worker.md");
const junction = process.platform === "win32" ? "junction" : "dir";

const realpath = p => {
  const r = fs.realpathSync.native(p);
  return process.platform === "win32" ? r.toLowerCase() : r;
};

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "p18-home-"));
  return { home, done: () => fs.rmSync(home, { recursive: true, force: true }) };
}

function run(home, ...args) {
  const r = spawnSync(process.execPath, [INSTALL, ...args], {
    encoding: "utf8", windowsHide: true,
    env: { ...process.env, ONEGO_INSTALL_HOME: home }
  });
  return { code: r.status, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

const T = {
  claude: h => path.join(h, ".claude", "skills", "one-go"),
  antigravity: h => path.join(h, ".agents", "skills", "one-go"),
  codex: h => path.join(h, ".codex", "skills", "one-go"),
  opencode: h => path.join(h, ".config", "opencode", "skills", "one-go")
};
const agentPath = h => path.join(h, ".claude", "agents", "one-go-worker.md");

// Everything under the sandbox, as a sorted list — proves "changed nothing".
function snapshot(dir) {
  const out = [];
  const walk = d => {
    for (const n of fs.readdirSync(d)) {
      const p = path.join(d, n);
      const st = fs.lstatSync(p);
      out.push(path.relative(dir, p) + (st.isSymbolicLink() ? " ->" : ""));
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}

test("install.mjs is a plain file next to SKILL.md and its default is a dry run", () => {
  assert.ok(fs.existsSync(INSTALL));
  const s = fs.readFileSync(INSTALL, "utf8");
  assert.match(s, /apply\s*=\s*false/, "apply must default to false");
});

test("no arguments: dry run, prints what it would do, changes nothing, exit 0", () => {
  const { home, done } = sandbox();
  try {
    const before = snapshot(home);
    const r = run(home);
    assert.equal(r.code, 0, r.out + r.err);
    assert.deepEqual(snapshot(home), before);
    for (const t of ["claude", "antigravity", "codex", "opencode"]) assert.match(r.out, new RegExp(`^${t}\\s+would`, "m"));
    assert.match(r.out, /dry run/);
  } finally { done(); }
});

test("--dry-run is the same as no arguments", () => {
  const { home, done } = sandbox();
  try {
    const a = run(home);
    const b = run(home, "--dry-run");
    assert.equal(b.code, 0);
    assert.equal(b.out, a.out);
    assert.deepEqual(snapshot(home), []);
  } finally { done(); }
});

test("--apply links all four tools to the skill folder and copies the helper agent", () => {
  const { home, done } = sandbox();
  try {
    const r = run(home, "--apply");
    assert.equal(r.code, 0, r.out + r.err);
    for (const t of Object.keys(T)) {
      assert.ok(fs.lstatSync(T[t](home)).isSymbolicLink(), `${t} should be a link`);
      assert.equal(realpath(T[t](home)), realpath(SKILL), `${t} should see the skill folder`);
    }
    assert.ok(fs.readFileSync(agentPath(home)).equals(fs.readFileSync(AGENT_SRC)));
    // opencode's skills/ folder was created on the way.
    assert.ok(fs.existsSync(path.join(home, ".config", "opencode", "skills")));
  } finally { done(); }
});

test("a second --apply skips everything, changes nothing, exit 0", () => {
  const { home, done } = sandbox();
  try {
    assert.equal(run(home, "--apply").code, 0);
    const before = snapshot(home);
    const r = run(home, "--apply");
    assert.equal(r.code, 0, r.out + r.err);
    assert.deepEqual(snapshot(home), before);
    assert.doesNotMatch(r.out, /linked|copied|refused/);
    assert.equal((r.out.match(/\bskip\b/g) || []).length, 5, "four links + the agent, all skipped");
  } finally { done(); }
});

test("a tool that already sees the skill is skipped and its link is never rewritten", () => {
  const { home, done } = sandbox();
  try {
    fs.mkdirSync(path.dirname(T.claude(home)), { recursive: true });
    fs.symlinkSync(SKILL, T.claude(home), junction);
    const marker = fs.lstatSync(T.claude(home)).ino;
    const r = run(home, "--apply", "--tool", "claude");
    assert.match(r.out, /^claude\s+skip\s.*already sees the skill/m);
    assert.equal(fs.lstatSync(T.claude(home)).ino, marker);
    assert.ok(fs.lstatSync(T.claude(home)).isSymbolicLink());
  } finally { done(); }
});

test("the skill folder itself standing at a tool's target counts as already seen (skip)", () => {
  // The live case: ~/.agents/skills/one-go IS the skill folder. Simulated by a link whose target
  // is the skill folder and checking --tool antigravity skips it the same way.
  const { home, done } = sandbox();
  try {
    fs.mkdirSync(path.dirname(T.antigravity(home)), { recursive: true });
    fs.symlinkSync(SKILL, T.antigravity(home), junction);
    const r = run(home, "--apply", "--tool", "antigravity");
    assert.equal(r.code, 0);
    assert.match(r.out, /^antigravity\s+skip/m);
  } finally { done(); }
});

test("a real folder at a target is refused with one line, left exactly as it was, exit 1", () => {
  const { home, done } = sandbox();
  try {
    const t = T.codex(home);
    fs.mkdirSync(t, { recursive: true });
    fs.writeFileSync(path.join(t, "mine.txt"), "keep me");
    const r = run(home, "--apply");
    assert.equal(r.code, 1);
    assert.match(r.out, /^codex\s+refused\s.*real folder/m);
    assert.ok(!fs.lstatSync(t).isSymbolicLink());
    assert.equal(fs.readFileSync(path.join(t, "mine.txt"), "utf8"), "keep me");
    assert.deepEqual(fs.readdirSync(t), ["mine.txt"]);
    // the other tools were still linked
    assert.ok(fs.lstatSync(T.opencode(home)).isSymbolicLink());
  } finally { done(); }
});

test("a real file at a target is refused and not overwritten", () => {
  const { home, done } = sandbox();
  try {
    const t = T.opencode(home);
    fs.mkdirSync(path.dirname(t), { recursive: true });
    fs.writeFileSync(t, "i am a file");
    const r = run(home, "--apply", "--tool", "opencode");
    assert.equal(r.code, 1);
    assert.match(r.out, /^opencode\s+refused\s.*real file/m);
    assert.equal(fs.readFileSync(t, "utf8"), "i am a file");
  } finally { done(); }
});

test("a link that points somewhere else is refused and left alone", () => {
  const { home, done } = sandbox();
  try {
    const elsewhere = path.join(home, "somewhere-else");
    fs.mkdirSync(elsewhere);
    const t = T.codex(home);
    fs.mkdirSync(path.dirname(t), { recursive: true });
    fs.symlinkSync(elsewhere, t, junction);
    const r = run(home, "--apply", "--tool", "codex");
    assert.equal(r.code, 1);
    assert.match(r.out, /^codex\s+refused\s.*somewhere else/m);
    assert.equal(realpath(t), realpath(elsewhere));
  } finally { done(); }
});

test("a helper agent file that differs is refused and not overwritten; an identical one is skipped", () => {
  const { home, done } = sandbox();
  try {
    fs.mkdirSync(path.dirname(agentPath(home)), { recursive: true });
    fs.writeFileSync(agentPath(home), "an older agent");
    let r = run(home, "--apply", "--tool", "claude");
    assert.equal(r.code, 1);
    assert.match(r.out, /^claude\s+refused\s.*one-go-worker\.md.*different file/m);
    assert.equal(fs.readFileSync(agentPath(home), "utf8"), "an older agent");

    fs.copyFileSync(AGENT_SRC, agentPath(home));
    r = run(home, "--apply", "--tool", "claude");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^claude\s+skip\s.*one-go-worker\.md/m);
  } finally { done(); }
});

test("--tool limits the run to one tool and touches no other", () => {
  const { home, done } = sandbox();
  try {
    const r = run(home, "--apply", "--tool", "codex");
    assert.equal(r.code, 0);
    assert.ok(fs.lstatSync(T.codex(home)).isSymbolicLink());
    assert.ok(!fs.existsSync(path.join(home, ".claude")));
    assert.ok(!fs.existsSync(path.join(home, ".agents")));
    assert.ok(!fs.existsSync(path.join(home, ".config")));
    assert.doesNotMatch(r.out, /claude|opencode|antigravity/);
  } finally { done(); }
});

test("bad arguments exit 2 and change nothing", () => {
  const { home, done } = sandbox();
  try {
    for (const args of [["--tool", "vscode"], ["--tool"], ["--apply", "--dry-run"], ["--nope"]]) {
      const r = run(home, ...args);
      assert.equal(r.code, 2, `${args.join(" ")} → ${r.out}${r.err}`);
      assert.deepEqual(snapshot(home), []);
    }
    assert.match(run(home, "--tool", "vscode").err, /claude, antigravity, codex, opencode/);
  } finally { done(); }
});

test("the sandbox home is honoured: every target shown sits under the sandbox home (~/...)", () => {
  const { home, done } = sandbox();
  try {
    const r = run(home, "--apply");
    const targets = r.out.split("\n").filter(l => /\s(linked|copied)\s/.test(l));
    assert.equal(targets.length, 5);
    for (const l of targets) assert.match(l, /\s~\/\./, l);
    assert.match(r.out, /~\/\.codex\/skills\/one-go/);
  } finally { done(); }
});
