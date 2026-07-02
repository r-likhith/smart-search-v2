// src/resilience/withRetry.js
//
// Deadline-based retry wrapper for transient external failures.
// Used to wrap any call to an external dependency (Meilisearch
// today; Groq or other services later — this module is NOT
// coupled to Meilisearch specifically). ✅
//
// Design principles:
//   - Hard total deadline, never exceeded (deadline-based,
//     not independently-summed timeouts) ✅
//   - Only retries TRANSIENT failures — permanent failures
//     (bad auth, malformed query) fail fast, no wasted budget ✅
//   - Small jitter on retry pause to avoid synchronized
//     retry storms ✅
//   - Every attempt can be logged via onAttemptLog callback,
//     enabling retry/recovery metrics later (Layer C) ✅
//   - On success, returns { result, attempts, recovered } so
//     callers/analytics never need to parse logs to know
//     whether retry actually saved a request ✅
//
// VERIFIED BEHAVIOR (tested against meilisearch-js@0.36.0,
// confirmed by stopping smart-search-meili mid-request):
//   meilisearch-js@0.36.0 does NOT preserve underlying Node
//   error codes (ECONNREFUSED etc.) on connection failure.
//   It wraps everything as MeiliSearchCommunicationError with
//   message "fetch failed", regardless of whether the cause
//   is a temporary outage or a permanently misconfigured host.
//   Since the error gives no way to distinguish these, the
//   whole error class is classified as transient (retryable) —
//   the cost of occasionally retrying a true misconfiguration
//   is small (~350-400ms, one time, self-revealing via health
//   endpoints), while NOT retrying would mean the most common
//   real failure (brief Meilisearch restart) gets zero retry
//   benefit at all. ✅
//
// KNOWN LIMITATION (documented, not silently dropped):
//   The underlying fn() is NOT cancelled when a timeout fires.
//   meilisearch-js@0.36.0 does not expose AbortSignal support
//   through its public search() API, so there is currently no
//   hook to actually cancel the in-flight request —
//   Promise.race() only stops *waiting* on it, the original
//   request keeps running server-side. Revisit when/if
//   meilisearch-js is upgraded to a version with fetch-based
//   cancellation (confirmed compatible: 0.58.0 requires Node
//   >=22.12.0, which this project's node:22-alpine image
//   satisfies — upgrade deferred to its own dedicated session
//   with full regression testing, not bundled here). ⚠️

class TimeoutError extends Error {
  constructor(ms, attempt, label) {
    super(`${label || 'operation'} timed out after ${ms}ms (attempt ${attempt})`);
    this.code    = 'ETIMEOUT';
    this.attempt = attempt;
    this.label   = label;
  }
}

const TRANSIENT_CODES  = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ETIMEOUT']);
const TRANSIENT_STATUS = new Set([502, 503, 504]);
// meilisearch-js@0.36.0 wraps all connection failures in this
// class with no preserved error code — see VERIFIED BEHAVIOR
// above. Treated as transient. ✅
const TRANSIENT_NAMES  = new Set(['MeiliSearchCommunicationError']);

function isTransient(err) {
  if (!err) return false;
  if (TRANSIENT_CODES.has(err.code)) return true;
  if (TRANSIENT_STATUS.has(err.httpStatus || err.status)) return true;
  if (TRANSIENT_NAMES.has(err.name)) return true;
  return false;
}

function withTimeout(promise, ms, attempt, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new TimeoutError(ms, attempt, label)), ms)
    )
  ]);
}

function jitter(ms, spreadPct = 0.2) {
  const delta = ms * spreadPct;
  return ms + (Math.random() * delta * 2 - delta);
}

/**
 * Runs fn() with a hard total deadline.
 * Never exceeds maxTotalMs across all attempts combined ✅
 * Only retries errors classified as transient ✅
 *
 * On success: returns { result, attempts, recovered }
 *   - result:    the value fn() resolved to
 *   - attempts:  how many tries it took (1 = first try worked)
 *   - recovered: true if it succeeded only after ≥1 prior failure
 *
 * On failure: throws the last error, tagged with:
 *   - err.degraded = true/false (true = retried and still failed
 *     or timed out; false = permanent error, failed fast)
 *   - err.attempts = number of attempts made
 *
 * @param {Function} fn - async function to execute
 * @param {Object} opts
 * @param {number} opts.maxTotalMs - hard ceiling for all attempts combined
 * @param {number} opts.attemptMs - per-attempt timeout
 * @param {string} opts.label - identifies this operation in logs
 * @param {string|null} opts.requestId - correlates retries to a request
 * @param {Function|null} opts.onAttemptLog - called after every attempt
 */
async function withRetry(fn, {
  maxTotalMs   = 400,
  attemptMs    = 100,
  label        = 'operation',
  requestId    = null,
  onAttemptLog = null
} = {}) {
  const deadline = Date.now() + maxTotalMs;
  let attempt = 0;
  let lastErr;

  while (true) {
    attempt++;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break; // budget exhausted ✅

    const thisTimeout  = Math.min(attemptMs, remaining);
    const attemptStart = Date.now();

    try {
      // see KNOWN LIMITATION above re: fn() is not cancellable
      const result = await withTimeout(fn(), thisTimeout, attempt, label);

      const recovered = attempt > 1;
      if (recovered && onAttemptLog) {
        onAttemptLog({
          requestId, label, attempt,
          outcome: 'recovered',
          tookMs: Date.now() - attemptStart
        });
      }

      return { result, attempts: attempt, recovered };

    } catch (err) {
      lastErr = err;

      if (onAttemptLog) {
        onAttemptLog({
          requestId, label, attempt,
          outcome: err.code === 'ETIMEOUT' ? 'timeout' : 'error',
          errorCode: err.code || err.name || null,
          tookMs: Date.now() - attemptStart
        });
      }

      // permanent error — fail fast, don't waste remaining budget ✅
      // tag it the same way as the exhausted-budget path, so
      // callers can rely on .attempts/.degraded being present
      // on ANY error this function throws, not just timeouts ✅
      if (!isTransient(err)) {
        err.degraded = false; // explicitly not a resilience-layer
                               // failure — this is a real, permanent
                               // error from the operation itself
        err.attempts = attempt;
        throw err;
      }

      const nowRemaining = deadline - Date.now();
      if (nowRemaining <= 0) break;

      // small jittered pause before retry, capped to remaining budget ✅
      const pause = Math.min(jitter(30), nowRemaining);
      if (pause > 0) await new Promise(r => setTimeout(r, pause));
    }
  }

  // exhausted budget — tag for structured degradation downstream ✅
  lastErr = lastErr || new Error(`${label} failed — no attempts succeeded`);
  lastErr.degraded = true;
  lastErr.attempts = attempt;
  throw lastErr;
}

module.exports = { withRetry, isTransient, TimeoutError };