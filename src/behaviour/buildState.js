const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '../../learned/buildState.json');
const TEMP_FILE = STATE_FILE + '.tmp';

// ─── CONFIG ───────────────────────────────────────────────
const CLICKS_THRESHOLD = 50;
const TIME_THRESHOLD_MS = 60 * 60 * 1000;  // 1 hour
const MIN_BUILD_INTERVAL_MS = 30 * 1000;   // 30 seconds debounce

// ─── STATE ────────────────────────────────────────────────
let state = {
  lastBuildTime: 0,
  clicksSinceLastBuild: 0,
  totalBuilds: 0
};

// ─── LOAD STATE ───────────────────────────────────────────

function loadBuildState() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });

    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      state = JSON.parse(raw);
      console.log(`Build state loaded: ${state.totalBuilds} builds, ${state.clicksSinceLastBuild} pending clicks`);
    } else {
      console.log('No build state found — starting fresh');
      saveBuildState();
    }
  } catch (err) {
    console.error('Failed to load build state:', err.message);
    state = { lastBuildTime: 0, clicksSinceLastBuild: 0, totalBuilds: 0 };
  }
}

// ─── SAVE STATE ───────────────────────────────────────────
// Fix 5 — atomic write prevents corruption

function saveBuildState() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const data = JSON.stringify(state, null, 2);

    // write to temp first
    fs.writeFileSync(TEMP_FILE, data);
    // atomic rename
    fs.renameSync(TEMP_FILE, STATE_FILE);

  } catch (err) {
    console.error('Failed to save build state:', err.message);
  }
}

// ─── INCREMENT CLICKS ─────────────────────────────────────

function incrementClickCount() {
  state.clicksSinceLastBuild++;
  saveBuildState();
}

// ─── CHECK IF BUILD NEEDED ────────────────────────────────

function shouldBuild() {
  const now = Date.now();
  const timeSinceLastBuild = now - state.lastBuildTime;

  // Fix 3 — debounce: minimum 30 seconds between builds
  if (timeSinceLastBuild < MIN_BUILD_INTERVAL_MS) {
    return false;
  }

  // Fix 6 — must have clicks to build
  if (state.clicksSinceLastBuild === 0) {
    return false;
  }

  // clicks threshold reached
  if (state.clicksSinceLastBuild >= CLICKS_THRESHOLD) {
    return true;
  }

  // Fix 4 — time threshold with clicks guard
  if (
    timeSinceLastBuild >= TIME_THRESHOLD_MS &&
    state.clicksSinceLastBuild > 0
  ) {
    return true;
  }

  return false;
}

// ─── UPDATE AFTER BUILD ───────────────────────────────────
// Fix 2 — only update AFTER successful build

function onBuildComplete() {
  state.lastBuildTime = Date.now();
  state.clicksSinceLastBuild = 0;
  state.totalBuilds++;
  saveBuildState();
  console.log(`[BuildState] Build #${state.totalBuilds} complete`);
}

// ─── GET STATE ────────────────────────────────────────────

function getBuildState() {
  return {
    lastBuildTime: state.lastBuildTime
      ? new Date(state.lastBuildTime).toISOString()
      : null,
    clicksSinceLastBuild: state.clicksSinceLastBuild,
    totalBuilds: state.totalBuilds,
    nextBuildAt: state.clicksSinceLastBuild >= CLICKS_THRESHOLD
      ? 'ready now'
      : `${CLICKS_THRESHOLD - state.clicksSinceLastBuild} more clicks needed`
  };
}

module.exports = {
  loadBuildState,
  saveBuildState,
  incrementClickCount,
  shouldBuild,
  onBuildComplete,
  getBuildState,
  CLICKS_THRESHOLD,
  TIME_THRESHOLD_MS,
  MIN_BUILD_INTERVAL_MS
};