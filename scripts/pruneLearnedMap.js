const fs   = require('fs');
const path = require('path');

const MAP_FILE   = path.join(__dirname, '../learned/learnedMap.json');
const INDEX_FILE = path.join(__dirname, '../learned/reverseIndex.json');
const LOGS_DIR   = path.join(__dirname, '../logs');

// ─── CONFIG ───────────────────────────────────────────────

const APPLY_MODE = process.argv.includes('--apply');

const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

// grace periods
const GRACE_NEW      =   7 * DAY;  // never touch entries < 7 days old
const GRACE_CLICK    = 180 * DAY;  // click entries: 180 day grace
const GRACE_STALE    =  90 * DAY;  // never used: 90 days
const GRACE_LOW      =  60 * DAY;  // low hitCount: 60 days
const GRACE_DISABLED =  60 * DAY;  // disabled entries: 60 days

// thresholds
const HIGH_VALUE_HITS    = 10;     // hitCount >= 10 → always protect
const HIGH_CONFIDENCE    = 0.90;   // confidence >= 0.90 → always protect
const DISABLE_CONFIDENCE = 0.70;   // confidence < 0.70 → disable candidate
const DELETE_CONFIDENCE  = 0.50;   // confidence < 0.50 → delete candidate

// ─── LOAD ─────────────────────────────────────────────────

function load() {
  try {
    const map   = JSON.parse(fs.readFileSync(MAP_FILE,   'utf8'));
    const index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    return { map, index };
  } catch (err) {
    console.error('Failed to load files:', err.message);
    process.exit(1);
  }
}

// ─── SAVE ─────────────────────────────────────────────────

function save(map, index) {
  fs.writeFileSync(MAP_FILE,   JSON.stringify(map,   null, 2));
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
}

// ─── SAVE REPORT ──────────────────────────────────────────
// saved every run — dry or apply ✅
// audit trail for quality monitoring ✅

function saveReport(report) {
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    const date     = new Date().toISOString().split('T')[0];
    const filename = `prune-${date}.json`;
    const filepath = path.join(LOGS_DIR, filename);
    fs.writeFileSync(filepath, JSON.stringify(report, null, 2));
    console.log(`📄 Report saved: logs/${filename}`);
  } catch (err) {
    console.error('Failed to save report:', err.message);
  }
}

// ─── AGE HELPERS ──────────────────────────────────────────

function ageMs(dateStr) {
  if (!dateStr) return Infinity;
  return NOW - new Date(dateStr).getTime();
}

function daysOld(dateStr) {
  return Math.round(ageMs(dateStr) / DAY);
}

// ─── PROTECTION CHECK ─────────────────────────────────────
// returns reason string if protected, null if not ✅

function isProtected(key, entry) {
  // manual entries — always keep ✅
  if (entry.source === 'manual') {
    return 'source=manual';
  }

  // high value by usage ✅
  if ((entry.hitCount || 0) >= HIGH_VALUE_HITS) {
    return `hitCount=${entry.hitCount}`;
  }

  // very high confidence ✅
  if (entry.confidence >= HIGH_CONFIDENCE) {
    return `confidence=${entry.confidence}`;
  }

  // too new to judge ✅
  if (ageMs(entry.firstSeen) < GRACE_NEW) {
    return `firstSeen=${daysOld(entry.firstSeen)}d ago`;
  }

  // click entries have 180 day grace ✅
  if (entry.source === 'click' && ageMs(entry.lastUsed) < GRACE_CLICK) {
    return `source=click lastUsed=${daysOld(entry.lastUsed)}d ago`;
  }

  return null;
}

// ─── RULE CHECKS ──────────────────────────────────────────
// ORDER MATTERS:
// Hard delete rules fire BEFORE disable ✅
// Proven bad corrections deleted immediately ✅
// Only ambiguous entries get disabled first ✅

// Rule 3 — delete: too many failures + very low confidence ✅
// fires first — proven bad correction, no grace needed
function checkRule3(key, entry) {
  if (
    (entry.failures || 0) >= 3 &&
    entry.confidence < DELETE_CONFIDENCE
  ) {
    return `failures=${entry.failures} confidence=${entry.confidence}`;
  }
  return null;
}

// Rule 2 — delete: never used + stale ✅
function checkRule2(key, entry) {
  if (
    (entry.hitCount || 0) === 0 &&
    ageMs(entry.lastUsed)  > GRACE_STALE &&
    ageMs(entry.firstSeen) > GRACE_STALE
  ) {
    return `hitCount=0 lastUsed=${daysOld(entry.lastUsed)}d firstSeen=${daysOld(entry.firstSeen)}d`;
  }
  return null;
}

// Rule 4 — delete: stale low value ✅
function checkRule4(key, entry) {
  if (
    (entry.hitCount || 0) <= 1 &&
    ageMs(entry.lastUsed)  > GRACE_LOW &&
    ageMs(entry.firstSeen) > GRACE_LOW
  ) {
    return `hitCount=${entry.hitCount || 0} lastUsed=${daysOld(entry.lastUsed)}d firstSeen=${daysOld(entry.firstSeen)}d`;
  }
  return null;
}

// Rule 5 — delete: disabled + old ✅
function checkRule5(key, entry) {
  if (
    entry.status === 'disabled' &&
    ageMs(entry.lastUsed) > GRACE_DISABLED
  ) {
    return `status=disabled lastUsed=${daysOld(entry.lastUsed)}d`;
  }
  return null;
}

// Rule 1 — disable: low confidence + low usage + old enough ✅
// fires LAST among rules — gives entry a chance to recover ✅
function checkRule1(key, entry) {
  if (
    entry.confidence < DISABLE_CONFIDENCE &&
    (entry.hitCount || 0) <= 2 &&
    ageMs(entry.firstSeen) > 30 * DAY
  ) {
    return `confidence=${entry.confidence} hitCount=${entry.hitCount || 0} age=${daysOld(entry.firstSeen)}d`;
  }
  return null;
}

// ─── REMOVE FROM REVERSE INDEX ────────────────────────────

function removeFromIndex(wrongWord, index) {
  for (const [correctWord, data] of Object.entries(index)) {
    const idx = data.variants?.indexOf(wrongWord);
    if (idx !== -1 && idx !== undefined) {
      data.variants.splice(idx, 1);
      data.totalVariants = Math.max(0, (data.totalVariants || 1) - 1);
      if (data.variants.length === 0) {
        delete index[correctWord];
      }
      break;
    }
  }
}

// ─── MAIN ─────────────────────────────────────────────────

function run() {
  console.log('');
  console.log('╔════════════════════════════════════════╗');
  console.log('║       LearnedMap Pruning Script        ║');
  console.log('╚════════════════════════════════════════╝');
  console.log(`Mode: ${APPLY_MODE ? '🔴 APPLY (changes will be saved)' : '🟡 DRY RUN (no changes)'}`);
  console.log('');

  const { map, index } = load();
  const total = Object.keys(map).length;
  console.log(`Loaded: ${total} entries\n`);

  // results buckets
  const toDisable = [];
  const toDelete  = [];

  const report = {
    ts:        new Date().toISOString(),
    mode:      APPLY_MODE ? 'apply' : 'dry-run',
    total,
    rule3_tooManyFails:  { count: 0, entries: [] },
    rule2_neverUsed:     { count: 0, entries: [] },
    rule4_staleLowValue: { count: 0, entries: [] },
    rule5_disabledOld:   { count: 0, entries: [] },
    rule1_disable:       { count: 0, entries: [] },
    protected:           { count: 0, entries: [] },
    clean:               { count: 0 },
    applied: {
      disabled:  0,
      deleted:   0,
      remaining: total
    }
  };

  // ── scan all entries ───────────────────────────────────
  for (const [key, entry] of Object.entries(map)) {

    // protection check first ✅
    const protectReason = isProtected(key, entry);
    if (protectReason) {
      report.protected.count++;
      report.protected.entries.push({ key, correction: entry.correction, reason: protectReason });
      continue;
    }

    // hard delete rules fire before disable ✅
    const r3 = checkRule3(key, entry);
    if (r3) {
      toDelete.push({ key, entry, rule: 'rule3_tooManyFails', reason: r3 });
      report.rule3_tooManyFails.count++;
      report.rule3_tooManyFails.entries.push({ key, correction: entry.correction, reason: r3 });
      continue;
    }

    const r2 = checkRule2(key, entry);
    if (r2) {
      toDelete.push({ key, entry, rule: 'rule2_neverUsed', reason: r2 });
      report.rule2_neverUsed.count++;
      report.rule2_neverUsed.entries.push({ key, correction: entry.correction, reason: r2 });
      continue;
    }

    const r4 = checkRule4(key, entry);
    if (r4) {
      toDelete.push({ key, entry, rule: 'rule4_staleLowValue', reason: r4 });
      report.rule4_staleLowValue.count++;
      report.rule4_staleLowValue.entries.push({ key, correction: entry.correction, reason: r4 });
      continue;
    }

    const r5 = checkRule5(key, entry);
    if (r5) {
      toDelete.push({ key, entry, rule: 'rule5_disabledOld', reason: r5 });
      report.rule5_disabledOld.count++;
      report.rule5_disabledOld.entries.push({ key, correction: entry.correction, reason: r5 });
      continue;
    }

    // disable fires last ✅
    const r1 = checkRule1(key, entry);
    if (r1) {
      toDisable.push({ key, entry, reason: r1 });
      report.rule1_disable.count++;
      report.rule1_disable.entries.push({ key, correction: entry.correction, reason: r1 });
      continue;
    }

    // entry is clean ✅
    report.clean.count++;
  }

  // ── print report ───────────────────────────────────────
  console.log('═══ SCAN RESULTS ═══════════════════════\n');

  console.log(`✅ Protected:              ${report.protected.count}`);
  console.log(`✅ Clean:                  ${report.clean.count}`);
  console.log(`🔴 To delete R3 (fails):  ${report.rule3_tooManyFails.count}`);
  console.log(`🔴 To delete R2 (unused): ${report.rule2_neverUsed.count}`);
  console.log(`🔴 To delete R4 (stale):  ${report.rule4_staleLowValue.count}`);
  console.log(`🔴 To delete R5 (old dis):${report.rule5_disabledOld.count}`);
  console.log(`🟡 To disable R1 (lowcon):${report.rule1_disable.count}`);
  console.log('');

  const totalDisable = toDisable.length;
  const totalDelete  = toDelete.length;
  console.log(`Total changes: ${totalDisable + totalDelete} (${totalDisable} disable, ${totalDelete} delete)`);
  console.log('');

  // ── detail: to delete ─────────────────────────────────
  if (toDelete.length > 0) {
    console.log('─── TO DELETE ───────────────────────────');
    toDelete.slice(0, 10).forEach(({ key, entry, rule, reason }) => {
      console.log(`  🔴 "${key}" → "${entry.correction}" | ${rule} | ${reason}`);
    });
    if (toDelete.length > 10) console.log(`  ... and ${toDelete.length - 10} more`);
    console.log('');
  }

  // ── detail: to disable ────────────────────────────────
  if (toDisable.length > 0) {
    console.log('─── TO DISABLE (Rule 1) ─────────────────');
    toDisable.slice(0, 10).forEach(({ key, entry, reason }) => {
      console.log(`  🟡 "${key}" → "${entry.correction}" | ${reason}`);
    });
    if (toDisable.length > 10) console.log(`  ... and ${toDisable.length - 10} more`);
    console.log('');
  }

  // ── detail: protected ─────────────────────────────────
  console.log('─── PROTECTED (sample) ──────────────────');
  report.protected.entries.slice(0, 5).forEach(({ key, reason }) => {
    console.log(`  🛡️  "${key}" | ${reason}`);
  });
  if (report.protected.count > 5) {
    console.log(`  ... and ${report.protected.count - 5} more`);
  }
  console.log('');

  // ── dry run exit ──────────────────────────────────────
  if (!APPLY_MODE) {
    console.log('════════════════════════════════════════');
    console.log('🟡 DRY RUN — no changes made');
    console.log('   Run with --apply to execute changes');
    console.log('════════════════════════════════════════\n');
    saveReport(report);
    return;
  }

  // ── apply: delete first ───────────────────────────────
  let deleted = 0;
  for (const { key } of toDelete) {
    delete map[key];
    removeFromIndex(key, index);
    deleted++;
  }

  // ── apply: disable ────────────────────────────────────
  let disabled = 0;
  for (const { key } of toDisable) {
    map[key].status     = 'disabled';
    map[key].disabledAt = new Date().toISOString();
    map[key].disabledBy = 'pruneLearnedMap';
    disabled++;
  }

  // ── save ──────────────────────────────────────────────
  save(map, index);

  report.applied.disabled  = disabled;
  report.applied.deleted   = deleted;
  report.applied.remaining = Object.keys(map).length;

  console.log('════════════════════════════════════════');
  console.log('✅ Applied:');
  console.log(`   Deleted:   ${deleted}`);
  console.log(`   Disabled:  ${disabled}`);
  console.log(`   Remaining: ${Object.keys(map).length}`);
  console.log('════════════════════════════════════════\n');

  saveReport(report);
}

run();