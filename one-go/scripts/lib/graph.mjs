// lib/graph.mjs — the dependency graph. What may run, what must wait, and what can never run.
//
// WHY THIS FILE EXISTS
// The sealed plan's Passes table has always had a "Depends on" column, and `start` has always
// parsed it — into a variable it then threw away. Reproduced 2026-09-08: a plan declaring
// "pass 2 depends on 1" produced a state.json whose pass 2 carried no dependency field at all
// (D5). With nothing recorded, `pass` advanced strictly n -> n+1, so the order was whatever the
// author happened to type, and nothing could ever run beside anything else.
//
// This file makes the column mean something: it is parsed, validated BEFORE launch (a cycle or
// a dangling id refuses the run rather than deadlocking it at 3am), and then used to answer the
// only question the scheduler ever asks — "given what is finished, what is allowed to start?"

/**
 * Parse one "Depends on" cell into pass numbers.
 * Accepts: "1", "1,2", "1 and 2", "p1, p3", "—", "-", "", "none".
 * Anything that is not a number is ignored rather than guessed at.
 */
export function parseDepends(cell) {
  const text = String(cell == null ? "" : cell).trim();
  if (!text || /^(—|-|–|none|n\/a)$/i.test(text)) return [];
  const nums = text.match(/\d+/g) || [];
  return [...new Set(nums.map(Number))].sort((a, b) => a - b);
}

/**
 * Validate a pass list as a graph. Returns { ok, errors[] }.
 * Called before a run is created — never after. A plan that cannot be scheduled is refused
 * while the person is awake to hear why, not discovered by a worker that then sits forever.
 */
export function validateGraph(passes) {
  const errors = [];
  const byN = new Map();
  for (const p of passes) {
    if (!Number.isInteger(p.n)) { errors.push(`pass "${p.title || p.n}" has no usable number`); continue; }
    if (byN.has(p.n)) { errors.push(`two passes are both numbered ${p.n}`); continue; }
    byN.set(p.n, p);
  }

  for (const p of byN.values()) {
    for (const d of p.depends || []) {
      if (!byN.has(d)) errors.push(`pass ${p.n} depends on pass ${d}, which is not in the plan`);
      if (d === p.n) errors.push(`pass ${p.n} depends on itself`);
    }
  }

  // Cycle detection: iterative depth-first search with an on-stack marker, so the error can
  // name the actual loop rather than just saying one exists.
  const WHITE = 0, GREY = 1, BLACK = 2;
  const colour = new Map([...byN.keys()].map(n => [n, WHITE]));
  const stack = [];
  const seenCycles = new Set();
  function visit(n) {
    colour.set(n, GREY);
    stack.push(n);
    for (const d of (byN.get(n).depends || [])) {
      if (!byN.has(d) || d === n) continue;
      const c = colour.get(d);
      if (c === GREY) {
        const from = stack.indexOf(d);
        const loop = stack.slice(from).concat(d).join(" → ");
        if (!seenCycles.has(loop)) { seenCycles.add(loop); errors.push(`passes form a cycle: ${loop}`); }
      } else if (c === WHITE) visit(d);
    }
    stack.pop();
    colour.set(n, BLACK);
  }
  for (const n of byN.keys()) if (colour.get(n) === WHITE) visit(n);

  return { ok: errors.length === 0, errors };
}

/**
 * Which passes may start right now?
 *
 * A pass is ready when it is not finished, not already live, not failed, and EVERY prerequisite
 * has finished. `isDone` and `isBlocked` are injected so this file never has to know how a
 * status string is spelled — lib/status.mjs owns that, and only that.
 */
export function readyPasses(passes, { isDone, isStuck, isRunning, isStartable }) {
  const byN = new Map(passes.map(p => [p.n, p]));
  const out = [];
  for (const p of passes) {
    // A pass is a candidate only if it has not started. `pending` HAS not started — reading it
    // as "already live" is what made the scheduler return an empty ready set every time.
    if (isDone(p.status) || isStuck(p.status) || isRunning(p.status)) continue;
    if (isStartable && !isStartable(p.status)) continue;
    const deps = p.depends || [];
    const blockedBy = deps.filter(d => {
      const dep = byN.get(d);
      return !dep || !isDone(dep.status);
    });
    if (blockedBy.length === 0) out.push(p);
  }
  return out.sort((a, b) => a.n - b.n);
}

/**
 * Passes that can never run now, because something they need has failed or parked.
 * A dependant PAUSES with a reason — it does not fail, and it does not silently vanish.
 * Independent branches are untouched, which is the whole point of keeping the graph.
 */
export function blockedPasses(passes, { isDone, isStuck }) {
  const byN = new Map(passes.map(p => [p.n, p]));
  const dead = new Set();
  // Walk outward from every stuck pass until nothing new is reached.
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of passes) {
      if (dead.has(p.n) || isDone(p.status)) continue;
      const bad = (p.depends || []).some(d => {
        const dep = byN.get(d);
        return dep && (isStuck(dep.status) || dead.has(d));
      });
      if (bad) { dead.add(p.n); changed = true; }
    }
  }
  return passes
    .filter(p => dead.has(p.n) && !isStuck(p.status))
    .map(p => {
      const cause = (p.depends || [])
        .map(d => byN.get(d))
        .find(dep => dep && (isStuck(dep.status) || dead.has(dep.n)));
      return { pass: p, waitingOn: cause ? cause.n : null, reason: cause ? `pass ${cause.n} (${cause.title || "—"}) is ${cause.status}` : "a prerequisite failed" };
    });
}

/**
 * The longest chain of passes still to run. The scheduler prefers work on this chain when it
 * has to choose, because shortening the critical path is the only thing that shortens the run.
 */
export function criticalPath(passes, { isDone }) {
  const byN = new Map(passes.map(p => [p.n, p]));
  const memo = new Map();
  function depth(n) {
    if (memo.has(n)) return memo.get(n);
    const p = byN.get(n);
    if (!p) return 0;
    memo.set(n, 0); // guard against a cycle that slipped through
    const own = isDone(p.status) ? 0 : 1;
    let best = 0;
    for (const other of passes) {
      if ((other.depends || []).includes(n)) best = Math.max(best, depth(other.n));
    }
    const total = own + best;
    memo.set(n, total);
    return total;
  }
  return passes.map(p => ({ n: p.n, remaining: depth(p.n) })).sort((a, b) => b.remaining - a.remaining);
}
