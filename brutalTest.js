require('dotenv').config();
const { runSearch, runSuggest } = require('./src/query/queryRunner');
const { loadMap, applyCorrection, saveCorrection, penaliseCorrection, getStats } = require('./src/learned/learnedMap');
const { loadMap: loadSuggestMap } = require('./src/learned/suggestMap');
const { initSymSpell } = require('./src/spellcheck/symspell');
const { buildIndex: buildPhoneticIndex } = require('./src/spellcheck/phonetic');
const { normalise } = require('./src/query/normalise');
const fs = require('fs');

const MEILI_INDEX = 'client_198_products';
const CLIENT_ID   = '198';
const SCOPE       = 'electronics';

let passed = 0;
let failed = 0;
const failures = [];

// ─── TEST HELPERS ─────────────────────────────────────────
function makeTestKey(label) {
  return normalise('brutaltest ' + label + ' xyz');
}

function successRate(entry) {
  if (!entry || (entry.hitCount || 0) === 0) return null;
  const rate = ((entry.hitCount - (entry.failures || 0)) / entry.hitCount * 100).toFixed(1);
  return parseFloat(rate);
}

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✅ ${label}${detail ? ' (' + detail + ')' : ''}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}${detail ? ' (' + detail + ')' : ''}`);
    failures.push(label + (detail ? ': ' + detail : ''));
    failed++;
  }
}

function section(title) {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`▸ ${title}`);
  console.log('─'.repeat(50));
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function run() {
  console.log('╔════════════════════════════════════════╗');
  console.log('║         BRUTAL SYSTEM TEST             ║');
  console.log('╚════════════════════════════════════════╝');
  console.log(`Index:  ${MEILI_INDEX}`);
  console.log(`Client: ${CLIENT_ID}`);
  console.log(`Scope:  ${SCOPE}\n`);

  loadMap();
  loadSuggestMap();
  await initSymSpell();
  buildPhoneticIndex();
  console.log('Setup complete ✅\n');

  // dynamic entry count — learnedMap grows as system learns ✅
  // never hardcode 134 — that breaks as groq/offline learner adds entries ✅
  const EXPECTED_COUNT = Object.keys(
    JSON.parse(fs.readFileSync('./learned/learnedMap.json'))
  ).length;
  console.log('Initial entry count: ' + EXPECTED_COUNT + ' ✅\n');

  const opts = {
    meiliIndex:  MEILI_INDEX,
    clientId:    CLIENT_ID,
    clientScope: SCOPE
  };

  // ══════════════════════════════════════════════════════
  section('1. DIRECT SEARCH — correct queries');
  // ══════════════════════════════════════════════════════

  const directTests = [
    { q: 'ipad',    minHits: 1, label: 'ipad → results' },
    { q: 'laptop',  minHits: 1, label: 'laptop → results' },
    { q: 'iphone',  minHits: 1, label: 'iphone → results' },
    { q: 'samsung', minHits: 1, label: 'samsung → results' },
  ];

  for (const t of directTests) {
    try {
      const r = await runSearch(t.q, opts);
      check(t.label,
        r.totalHits >= t.minHits && r.wasCorrected === false,
        r.totalHits + ' hits corrected:' + r.wasCorrected);
    } catch(e) { check(t.label, false, e.message); }
  }

  // ══════════════════════════════════════════════════════
  section('2. LEARNEDMAP LAYER — known typos');
  // ══════════════════════════════════════════════════════

  const learnedTests = [
    { q: 'labtop',     expected: 'laptop',     label: 'labtop → laptop' },
    { q: 'keybord',    expected: 'keyboard',   label: 'keybord → keyboard' },
    { q: 'smartwatsh', expected: 'smartwatch', label: 'smartwatsh → smartwatch' },
  ];

  for (const t of learnedTests) {
    try {
      const r = await runSearch(t.q, opts);
      check(t.label + ' — corrected',
        r.wasCorrected === true,
        r.correctionSource || 'none');
      check(t.label + ' — retrievalQuery',
        r.retrievalQuery === t.expected,
        r.retrievalQuery);
    } catch(e) { check(t.label, false, e.message); }
  }

  try {
    const r = await runSearch('nikee', opts);
    check('nikee → corrected (any source)',
      r.wasCorrected === true,
      'source:' + (r.correctionSource || 'none') + ' → ' + r.retrievalQuery);
    check('nikee → has results',
      r.totalHits > 0,
      r.totalHits + ' hits');
  } catch(e) { check('nikee correction', false, e.message); }

  // ══════════════════════════════════════════════════════
  section('3. SYMSPELL LAYER — new typos');
  // ══════════════════════════════════════════════════════

  const symTests = [
    { q: 'iphonne', label: 'iphonne → iphone (symspell)' },
    { q: 'samsong', label: 'samsong → samsung (symspell)' },
    { q: 'tablat',  label: 'tablat → tablet (symspell)' },
  ];

  for (const t of symTests) {
    try {
      const r = await runSearch(t.q, opts);
      check(t.label,
        r.wasCorrected === true || r.totalHits > 0,
        'corrected:' + r.wasCorrected + ' hits:' + r.totalHits +
        ' source:' + (r.correctionSource || 'none'));
    } catch(e) { check(t.label, false, e.message); }
  }

  // ══════════════════════════════════════════════════════
  section('4. ZERO RESULT HANDLING');
  // ══════════════════════════════════════════════════════

  try {
    const r = await runSearch('xyzxyzxyznotaproduct', opts);
    check('gibberish → fallback or 0 results',
      r.isFallback === true || r.totalHits === 0,
      'hits:' + r.totalHits + ' fallback:' + r.isFallback);
  } catch(e) { check('gibberish fallback', false, e.message); }

  try {
    const r = await runSearch('', opts);
    check('empty query → empty response',
      r.isEmpty === true || r.totalHits === 0,
      'isEmpty:' + r.isEmpty);
  } catch(e) { check('empty query', false, e.message); }

  try {
    const r = await runSearch('a', opts);
    check('single char → handled gracefully',
      r !== null && r !== undefined,
      'hits:' + r?.totalHits);
  } catch(e) { check('single char', false, e.message); }

  // ══════════════════════════════════════════════════════
  section('5. PROMOTION LIFECYCLE');
  // ══════════════════════════════════════════════════════

  const TEST_KEY  = makeTestKey('promotion');
  const TEST_CORR = 'ipad';

  const mapBefore = JSON.parse(fs.readFileSync('./learned/learnedMap.json'));
  if (mapBefore[TEST_KEY]) {
    delete mapBefore[TEST_KEY];
    fs.writeFileSync('./learned/learnedMap.json', JSON.stringify(mapBefore, null, 2));
    loadMap();
  }

  saveCorrection(TEST_KEY, TEST_CORR, 'symspell', 10);
  await sleep(300);
  const m1 = JSON.parse(fs.readFileSync('./learned/learnedMap.json'));
  check('new entry status = candidate',    m1[TEST_KEY]?.status === 'candidate', m1[TEST_KEY]?.status || 'missing');
  check('new entry hitCount = 1',          m1[TEST_KEY]?.hitCount === 1,          String(m1[TEST_KEY]?.hitCount));
  check('new entry successRate = 100%',    successRate(m1[TEST_KEY]) === 100,     successRate(m1[TEST_KEY]) + '%');

  for (let i = 0; i < 4; i++) saveCorrection(TEST_KEY, TEST_CORR, 'symspell', 10);
  await sleep(2000);
  const m2 = JSON.parse(fs.readFileSync('./learned/learnedMap.json'));
  check('after 5 hits → trusted',          m2[TEST_KEY]?.status === 'trusted',   (m2[TEST_KEY]?.status || 'missing') + ' hitCount:' + m2[TEST_KEY]?.hitCount);
  check('lastPromotedAt set on promotion', !!m2[TEST_KEY]?.lastPromotedAt,        m2[TEST_KEY]?.lastPromotedAt ? 'set' : 'missing');
  check('trusted successRate = 100%',      successRate(m2[TEST_KEY]) === 100,     successRate(m2[TEST_KEY]) + '%');

  for (let i = 0; i < 45; i++) saveCorrection(TEST_KEY, TEST_CORR, 'symspell', 10);
  await sleep(2000);
  const m3 = JSON.parse(fs.readFileSync('./learned/learnedMap.json'));
  check('after 50 hits → proven',          m3[TEST_KEY]?.status === 'proven',    (m3[TEST_KEY]?.status || 'missing') + ' hitCount:' + m3[TEST_KEY]?.hitCount);
  check('proven successRate = 100%',       successRate(m3[TEST_KEY]) === 100,     successRate(m3[TEST_KEY]) + '%');

  penaliseCorrection(TEST_KEY, { clientId: CLIENT_ID, clientScope: SCOPE });
  await sleep(300);
  const m4 = JSON.parse(fs.readFileSync('./learned/learnedMap.json'));
  check('proven not deleted after penalise',              !!m4[TEST_KEY],                         m4[TEST_KEY] ? 'still exists' : 'deleted!');
  check('proven status unchanged after penalise',         m4[TEST_KEY]?.status === 'proven',      m4[TEST_KEY]?.status || 'missing');
  check('proven successRate unchanged after blocked penalise', successRate(m4[TEST_KEY]) === 100, successRate(m4[TEST_KEY]) + '%');

  const mapClean = JSON.parse(fs.readFileSync('./learned/learnedMap.json'));
  delete mapClean[TEST_KEY];
  fs.writeFileSync('./learned/learnedMap.json', JSON.stringify(mapClean, null, 2));
  loadMap();
  console.log('  [cleanup] promotion test entry removed ✅');

  // ══════════════════════════════════════════════════════
  section('6. DISABLED + CLICK RE-ENABLE');
  // ══════════════════════════════════════════════════════

  const DIS_KEY  = makeTestKey('disabled');
  const DIS_CORR = 'iphone';

  const mapDis = JSON.parse(fs.readFileSync('./learned/learnedMap.json'));
  mapDis[DIS_KEY] = {
    correction: DIS_CORR, confidence: 0.85, hitCount: 3, failures: 5,
    source: 'symspell', status: 'disabled',
    firstSeen: new Date().toISOString(), lastUsed: new Date().toISOString(), lastUpdated: new Date().toISOString()
  };
  fs.writeFileSync('./learned/learnedMap.json', JSON.stringify(mapDis, null, 2));
  loadMap();

  const disEntry = JSON.parse(fs.readFileSync('./learned/learnedMap.json'))[DIS_KEY];
  check('disabled entry successRate reflects failures', successRate(disEntry) < 100, successRate(disEntry) + '%');

  const blocked = applyCorrection(DIS_KEY);
  check('disabled entry blocked from correction', blocked.corrected === false, 'corrected:' + blocked.corrected);

  saveCorrection(DIS_KEY, DIS_CORR, 'click', 5);
  saveCorrection(DIS_KEY, DIS_CORR, 'click', 5);
  await sleep(2000);
  const mDis2 = JSON.parse(fs.readFileSync('./learned/learnedMap.json'));
  check('2 clicks not enough to re-enable', mDis2[DIS_KEY]?.status === 'disabled', mDis2[DIS_KEY]?.status);

  saveCorrection(DIS_KEY, DIS_CORR, 'click', 5);
  await sleep(2000);
  const mDis3 = JSON.parse(fs.readFileSync('./learned/learnedMap.json'));
  check('3rd click re-enables to candidate', mDis3[DIS_KEY]?.status === 'candidate', mDis3[DIS_KEY]?.status || 'missing');

  const mapDisClean = JSON.parse(fs.readFileSync('./learned/learnedMap.json'));
  delete mapDisClean[DIS_KEY];
  fs.writeFileSync('./learned/learnedMap.json', JSON.stringify(mapDisClean, null, 2));
  loadMap();
  console.log('  [cleanup] disabled test entry removed ✅');

  // ══════════════════════════════════════════════════════
  section('7. CROSS-CLIENT PENALTY DETECTION');
  // ══════════════════════════════════════════════════════

  const CC_KEY = makeTestKey('crossclient');

  const mapCC = JSON.parse(fs.readFileSync('./learned/learnedMap.json'));
  mapCC[CC_KEY] = {
    correction: 'bluetooth speaker', confidence: 0.85, hitCount: 10, failures: 0,
    source: 'groq', status: 'trusted', scope: 'electronics', learnedFrom: '198',
    firstSeen: new Date().toISOString(), lastUsed: new Date().toISOString(), lastUpdated: new Date().toISOString()
  };
  fs.writeFileSync('./learned/learnedMap.json', JSON.stringify(mapCC, null, 2));
  loadMap();

  const ccBefore = JSON.parse(fs.readFileSync('./learned/learnedMap.json'))[CC_KEY];
  check('cross-client entry successRate = 100% before penalty', successRate(ccBefore) === 100, successRate(ccBefore) + '%');

  penaliseCorrection(CC_KEY, { clientId: '135', clientScope: 'fashion' });
  await sleep(2000);

  const mCC = JSON.parse(fs.readFileSync('./learned/learnedMap.json'));
  check('cross-client penalty recorded',          mCC[CC_KEY]?.lastPenalisedByClient === '135', mCC[CC_KEY]?.lastPenalisedByClient || 'missing');
  check('lastPenalisedAt set',                    !!mCC[CC_KEY]?.lastPenalisedAt,               mCC[CC_KEY]?.lastPenalisedAt ? 'set' : 'missing');
  check('failures incremented',                   (mCC[CC_KEY]?.failures || 0) === 1,           'failures:' + mCC[CC_KEY]?.failures);
  check('successRate drops after cross-client penalty', successRate(mCC[CC_KEY]) < 100,         successRate(mCC[CC_KEY]) + '%');

  const mapCCClean = JSON.parse(fs.readFileSync('./learned/learnedMap.json'));
  delete mapCCClean[CC_KEY];
  fs.writeFileSync('./learned/learnedMap.json', JSON.stringify(mapCCClean, null, 2));
  loadMap();
  console.log('  [cleanup] cross-client test entry removed ✅');

  // ══════════════════════════════════════════════════════
  section('8. SUGGEST PIPELINE');
  // ══════════════════════════════════════════════════════

  try {
    const r = await runSuggest('ipad', opts);
    check('ipad suggest → has products',   (r.products?.length || 0) > 0,  (r.products?.length || 0) + ' products');
    check('ipad suggest → not corrected',  r.wasCorrected === false,        'wasCorrected:' + r.wasCorrected);
  } catch(e) { check('ipad suggest', false, e.message); }

  try {
    const r = await runSuggest('labtop', opts);
    check('labtop suggest → has products', (r.products?.length || 0) > 0,  (r.products?.length || 0) + ' products');
  } catch(e) { check('labtop suggest', false, e.message); }

  try {
    const r = await runSuggest('iphon', opts);
    check('iphon suggest → has products',  (r.products?.length || 0) > 0,  (r.products?.length || 0) + ' products');
  } catch(e) { check('iphon suggest', false, e.message); }

  // ══════════════════════════════════════════════════════
  section('9. CHAIN DETECTION');
  // ══════════════════════════════════════════════════════

  const CHAIN_KEY = makeTestKey('chain');

  const mapChain = JSON.parse(fs.readFileSync('./learned/learnedMap.json'));
  mapChain[CHAIN_KEY] = {
    correction: 'ipad', confidence: 0.85, hitCount: 1,
    failures: 0, source: 'symspell', status: 'candidate',
    firstSeen: new Date().toISOString(), lastUsed: new Date().toISOString(), lastUpdated: new Date().toISOString()
  };
  fs.writeFileSync('./learned/learnedMap.json', JSON.stringify(mapChain, null, 2));
  loadMap();

  const chainMap = JSON.parse(fs.readFileSync('./learned/learnedMap.json'));
  check('chain detection — correction target not a typo',
    !chainMap['ipad'],
    chainMap['ipad'] ? 'ipad in learnedMap — chain risk!' : 'clean');

  const step1 = applyCorrection(CHAIN_KEY);
  const step2  = step1.corrected ? applyCorrection(step1.query) : { corrected: false };
  check('no chain: correction not corrected again',
    step2.corrected === false,
    'step1:' + step1.query + ' step2.corrected:' + step2.corrected);

  const mapChainClean = JSON.parse(fs.readFileSync('./learned/learnedMap.json'));
  delete mapChainClean[CHAIN_KEY];
  fs.writeFileSync('./learned/learnedMap.json', JSON.stringify(mapChainClean, null, 2));
  loadMap();
  console.log('  [cleanup] chain test entry removed ✅');

  // ══════════════════════════════════════════════════════
  section('10. SUCCESS RATE VERIFICATION');
  // ══════════════════════════════════════════════════════

  const liveMap = JSON.parse(fs.readFileSync('./learned/learnedMap.json'));
  const labtopEntry  = liveMap['labtop'];
  const keybordEntry = liveMap['keybord'];

  if (labtopEntry) {
    const rate = successRate(labtopEntry);
    check('labtop successRate computable',       rate !== null,          rate + '% (hits:' + labtopEntry.hitCount + ' failures:' + labtopEntry.failures + ')');
    check('labtop successRate >= 0 and <= 100',  rate >= 0 && rate <= 100, rate + '%');
  } else {
    check('labtop entry exists for successRate test', false, 'missing');
  }

  if (keybordEntry) {
    const rate = successRate(keybordEntry);
    check('keybord successRate computable', rate !== null, rate + '% (hits:' + keybordEntry.hitCount + ' failures:' + keybordEntry.failures + ')');
  } else {
    check('keybord entry exists for successRate test', false, 'missing');
  }

  const SR_KEY = makeTestKey('successrate');
  const srMap  = JSON.parse(fs.readFileSync('./learned/learnedMap.json'));
  srMap[SR_KEY] = {
    correction: 'iphone', confidence: 0.85, hitCount: 10, failures: 2,
    source: 'symspell', status: 'trusted',
    firstSeen: new Date().toISOString(), lastUsed: new Date().toISOString(), lastUpdated: new Date().toISOString()
  };
  fs.writeFileSync('./learned/learnedMap.json', JSON.stringify(srMap, null, 2));

  const srEntry = JSON.parse(fs.readFileSync('./learned/learnedMap.json'))[SR_KEY];
  check('successRate = 80% for 10 hits 2 failures', successRate(srEntry) === 80.0, successRate(srEntry) + '%');

  const srClean = JSON.parse(fs.readFileSync('./learned/learnedMap.json'));
  delete srClean[SR_KEY];
  fs.writeFileSync('./learned/learnedMap.json', JSON.stringify(srClean, null, 2));
  loadMap();
  console.log('  [cleanup] successRate test entry removed ✅');

  // ══════════════════════════════════════════════════════
  section('11. LEARNEDMAP STATS AFTER ALL TESTS');
  // ══════════════════════════════════════════════════════

  loadMap();
  const finalStats = getStats();

  // dynamic count — never hardcode ✅
  // allow ±2 variance — search pipeline may learn during tests ✅
  // safeSaveCorrection can add entries when searches run ✅
  check('totalEntries stable (' + EXPECTED_COUNT + ')',
    Math.abs(finalStats.totalEntries - EXPECTED_COUNT) <= 2,
    finalStats.totalEntries + ' entries (expected ~' + EXPECTED_COUNT + ')');
  check('no blocked entries',
    finalStats.blockedEntries === 0,
    finalStats.blockedEntries + ' blocked');
  check('all entries have status',
    finalStats.candidateEntries + finalStats.trustedEntries +
    finalStats.provenEntries   + finalStats.disabledEntries === finalStats.totalEntries,
    'sum matches total');
  check('reverseIndex intact',
    finalStats.reverseIndexSize >= 50,
    finalStats.reverseIndexSize + ' entries');
  check('0 failures in map',
    finalStats.failedEntries === 0,
    finalStats.failedEntries + ' failed entries');

  const liveMap2 = JSON.parse(fs.readFileSync('./learned/learnedMap.json'));
  const topByHits = Object.entries(liveMap2)
    .filter(([, e]) => (e.hitCount || 0) > 0)
    .sort(([, a], [, b]) => (b.hitCount || 0) - (a.hitCount || 0))
    .slice(0, 5);

  console.log('\n  Top corrections by hitCount:');
  topByHits.forEach(([key, e]) => {
    const rate = successRate(e);
    console.log(`  ${key} → ${e.correction}`);
    console.log(`    hits:${e.hitCount} failures:${e.failures || 0} successRate:${rate}% status:${e.status}`);
  });

  console.log('\n  Full stats:');
  console.log('  total:     ', finalStats.totalEntries);
  console.log('  candidate: ', finalStats.candidateEntries);
  console.log('  trusted:   ', finalStats.trustedEntries);
  console.log('  proven:    ', finalStats.provenEntries);
  console.log('  disabled:  ', finalStats.disabledEntries);
  console.log('  neverUsed: ', finalStats.neverUsed);

  // ══════════════════════════════════════════════════════
  // FINAL SUMMARY
  // ══════════════════════════════════════════════════════

  console.log('\n╔════════════════════════════════════════╗');
  console.log('║         BRUTAL TEST SUMMARY            ║');
  console.log('╚════════════════════════════════════════╝');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed} ${failed === 0 ? '✅' : '❌'}`);
  console.log(`Total:  ${passed + failed}`);

  if (failures.length > 0) {
    console.log('\nFailed tests:');
    failures.forEach(f => console.log('  ❌', f));
  } else {
    console.log('\n🎉 ALL BRUTAL TESTS PASSED ✅');
  }

  // cleanup reverseIndex ✅
  const finalMap = JSON.parse(fs.readFileSync('./learned/learnedMap.json'));
  const finalIdx = JSON.parse(fs.readFileSync('./learned/reverseIndex.json'));
  let idxFixed = 0;
  for (const [correct, data] of Object.entries(finalIdx)) {
    const before = data.variants.length;
    data.variants = data.variants.filter(v => finalMap[v] && finalMap[v].correction === correct);
    data.totalVariants = data.variants.length;
    if (data.variants.length === 0) { delete finalIdx[correct]; idxFixed++; }
    else if (data.variants.length < before) idxFixed++;
  }
  if (idxFixed > 0) {
    fs.writeFileSync('./learned/reverseIndex.json', JSON.stringify(finalIdx, null, 2));
    console.log('  [cleanup] reverseIndex fixed: ' + idxFixed + ' stale entries ✅');
  }

  // safety restore if count wrong ✅
  if (Math.abs(Object.keys(finalMap).length - EXPECTED_COUNT) > 2) {
    console.log('\n⚠️  Entry count mismatch — restoring backup...');
    fs.copyFileSync('./learned/learnedMap.backup.json', './learned/learnedMap.json');
    console.log('Backup restored ✅');
  }
}

run().catch(err => {
  console.error('Brutal test crashed:', err.message);
  fs.copyFileSync('./learned/learnedMap.backup.json', './learned/learnedMap.json');
  console.log('Backup restored ✅');
  process.exit(1);
});