// ─── OLLAMA BUDGET MANAGER ────────────────────────────────
const MAX_CONCURRENT = 2;
const TIMEOUT_MS = 30000;

let activeRequests = 0;
let totalRequests = 0;
let totalSkipped = 0;
let totalTimeouts = 0;

function canRequest() {
  return activeRequests < MAX_CONCURRENT;
}

function acquire() {
  activeRequests++;
  totalRequests++;
}

function release() {
  // Math.max prevents negative count
  activeRequests = Math.max(0, activeRequests - 1);
}

function recordSkip() {
  totalSkipped++;
}

// Fix — removed release() from here
// client.js finally block always handles release
function recordTimeout() {
  totalTimeouts++;
  console.log('[BudgetManager] Timeout recorded');
}

function getStats() {
  return {
    activeRequests,
    maxConcurrent: MAX_CONCURRENT,
    totalRequests,
    totalSkipped,
    totalTimeouts,
    timeoutMs: TIMEOUT_MS
  };
}

function reset() {
  activeRequests = 0;
  totalRequests = 0;
  totalSkipped = 0;
  totalTimeouts = 0;
}

module.exports = {
  canRequest,
  acquire,
  release,
  recordSkip,
  recordTimeout,
  getStats,
  reset,
  TIMEOUT_MS,
  MAX_CONCURRENT
};