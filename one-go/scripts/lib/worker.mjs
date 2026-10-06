// lib/worker.mjs — stable worker identities, intent shapes, acknowledgement matching, deadlines, retry limits.

/**
 * Check if the provided worker identity matches the expected active attempt and worker.
 * Returns null if valid, or a mismatch error message if invalid.
 */
export function matchWorkerIdentity({ run_id, pass_id, attempt_id, worker_id }, expected) {
  if (expected.run_id && run_id !== expected.run_id) {
    return `stale: different run (expected ${expected.run_id}, got ${run_id})`;
  }
  if (expected.pass_id && pass_id !== expected.pass_id) {
    return `stale: different pass (expected ${expected.pass_id}, got ${pass_id})`;
  }
  if (expected.attempt_id && attempt_id !== expected.attempt_id) {
    return `stale: different attempt (expected ${expected.attempt_id}, got ${attempt_id})`;
  }
  if (expected.worker_id && worker_id !== expected.worker_id) {
    return `stale: different worker (expected ${expected.worker_id}, got ${worker_id})`;
  }
  return null;
}

/**
 * Create stable identities for a pass launch intent.
 */
export function createLaunchIntent({ runId, passId, attemptId, requestedModel, requestedEffort }) {
  return {
    run_id: runId,
    pass_id: passId,
    attempt_id: attemptId,
    requested_model: requestedModel,
    requested_effort: requestedEffort || null
  };
}

/**
 * Create stable identities for a pass stop intent.
 */
export function createStopIntent({ runId, passId, attemptId, workerId }) {
  return {
    run_id: runId,
    pass_id: passId,
    attempt_id: attemptId,
    worker_id: workerId || null,
    requested_at: new Date().toISOString()
  };
}

/**
 * Check if a worker deadline has expired.
 * A fresh heartbeat NEVER overrides an expired hard deadline.
 */
export function isDeadlineExpired(worker) {
  if (!worker || !worker.deadline_at) return false;
  const deadlineT = Date.parse(worker.deadline_at);
  return !isNaN(deadlineT) && Date.now() > deadlineT;
}

/**
 * Hard retry limit: initial attempt plus at most two retries = 3 total attempts.
 */
export const MAX_ATTEMPTS = 3;

export function canRetry(pass, retryPolicy = {}) {
  const policyMax = Number(retryPolicy?.max_attempts);
  const max = Math.min(MAX_ATTEMPTS, isNaN(policyMax) || policyMax <= 0 ? MAX_ATTEMPTS : policyMax);
  return (pass.attempts || 0) < max;
}