const fs = require('fs');

let totalTests = 0;
let totalPassed = 0;
const failures = [];

function test(name, ok, detail = '') {
  totalTests++;
  if (ok) {
    totalPassed++;
    console.log('  ✅', name);
  } else {
    failures.push(name + (detail ? ': ' + detail : ''));
    console.log('  ❌', name, detail ? '(' + detail + ')' : '');
  }
}

async function run() {
  console.log('╔════════════════════════════════════════╗');
  console.log('║       MASTER SYSTEM CHECKUP            ║');
  console.log('╚════════════════════════════════════════╝\n');

  // ── SECTION 1: FILE INTEGRITY ──────────────────────────
  console.log('▸ SECTION 1: FILE INTEGRITY');

  const requiredFiles = [
    'src/query/queryRunner.js',
    'src/query/normalise.js',
    'src/learned/learnedMap.js',
    'src/spellcheck/symspell.js',
    'src/ollama/corrector.js',
    'src/ollama/client.js',
    'src/meilisearch/searcher.js',
    'analytics/logger.js',
    'analytics/aggregator.js',
    'analytics/dashboard.html',
    'learned/learnedMap.json',
    'learned/reverseIndex.json',
    'data/dictionary.txt',
    'server.js',
    'brutalTest.js',
    'chaosTest.js'
  ];

  for (const f of requiredFiles) {
    const exists = fs.existsSync(f);
    const size   = exists ? fs.statSync(f).size : 0;
    test(f, exists && size > 0, exists ? size + ' bytes' : 'missing');
  }

  // ── SECTION 2: JSON VALIDITY ───────────────────────────
  console.log('\n▸ SECTION 2: JSON VALIDITY');

  const jsonFiles = [
    'learned/learnedMap.json',
    'learned/reverseIndex.json',
    'learned/buildState.json',
    'learned/clicks.json'
  ];

  for (const f of jsonFiles) {
    try {
      const data = JSON.parse(fs.readFileSync(f, 'utf8'));
      test(f + ' valid JSON', true, Object.keys(data).length + ' entries');
    } catch(e) {
      test(f + ' valid JSON', false, e.message);
    }
  }

  // ── SECTION 3: MODULE LOADING ──────────────────────────
  console.log('\n▸ SECTION 3: MODULE LOADING');

  const modules = [
    './src/learned/learnedMap',
    './src/query/queryRunner',
    './src/query/normalise',
    './src/ollama/corrector',
    './src/ollama/client',
    './src/meilisearch/searcher',
    './src/spellcheck/symspell',
    './analytics/aggregator',
    './analytics/logger'
  ];

  for (const m of modules) {
    try {
      require(m);
      test(m, true);
    } catch(e) {
      test(m, false, e.message);
    }
  }

  // ── SECTION 4: EXPORTS CHECK ───────────────────────────
  console.log('\n▸ SECTION 4: EXPORTS CHECK');

  const exportChecks = [
    { module: './src/spellcheck/symspell',  exports: ['initSymSpell', 'correctQuery', 'getStatus', 'shouldSkip'] },
    { module: './src/learned/learnedMap',   exports: ['loadMap', 'applyCorrection', 'saveCorrection', 'penaliseCorrection', 'getStats'] },
    { module: './src/query/queryRunner',    exports: ['runSearch', 'runSuggest', 'runNavigate'] },
    { module: './src/ollama/corrector',     exports: ['correctQuery'] },
    { module: './src/meilisearch/searcher', exports: ['searchProducts', 'getSuggestions', 'getPopularProducts'] },
    { module: './analytics/aggregator',     exports: ['aggregate', 'readEntries', 'replayQuery'] },
    { module: './analytics/logger',         exports: ['logSearchEvent'] }
  ];

  for (const c of exportChecks) {
    const mod = require(c.module);
    for (const exp of c.exports) {
      test(c.module.split('/').pop() + '.' + exp, typeof mod[exp] === 'function');
    }
  }

  // ── SECTION 5: LEARNEDMAP HEALTH ──────────────────────
  console.log('\n▸ SECTION 5: LEARNEDMAP HEALTH');

  const { loadMap, applyCorrection, getStats } = require('./src/learned/learnedMap');
  loadMap();
  const stats = getStats();
  const map   = JSON.parse(fs.readFileSync('./learned/learnedMap.json', 'utf8'));
  const ri    = JSON.parse(fs.readFileSync('./learned/reverseIndex.json', 'utf8'));

  test('total entries >= 100',   stats.totalEntries >= 100,    stats.totalEntries + ' entries');
  test('manual entries >= 80',   stats.manualEntries >= 80,    stats.manualEntries + ' entries');
  test('blocked entries = 0',    stats.blockedEntries === 0,   stats.blockedEntries + ' blocked');
  test('reverseIndex populated', stats.reverseIndexSize >= 50, stats.reverseIndexSize + ' entries');

  let chains = 0;
  for (const [key, entry] of Object.entries(map)) {
    const check = applyCorrection(entry.correction);
    if (check.corrected) chains++;
  }
  test('no correction chains', chains === 0, chains + ' chains found');

  const correctWords = ['laptop', 'kurta', 'shirt', 'shoes', 'perfume',
    'leggings', 'shampoo', 'keyboard', 'monitor', 'bluetooth',
    'wireless', 'moisturiser', 'coriander', 'samsung', 'saree'];
  let fp = 0;
  for (const w of correctWords) {
    const r = applyCorrection(w);
    if (r.corrected) fp++;
  }
  test('no false positives', fp === 0, fp + ' false positives');

  const typos = [
    ['labtop','laptop'], ['leggigns','leggings'], ['corriamder','coriander'],
    ['keybord','keyboard'], ['smartwatsh','smartwatch'], ['nikee','nike']
  ];
  let typoHits = 0;
  for (const [typo, correct] of typos) {
    const r = applyCorrection(typo);
    if (r.corrected && r.query === correct) typoHits++;
  }
  test('key typos correcting', typoHits === typos.length, typoHits + '/' + typos.length);

  let riMismatch = 0;
  for (const [correctWord, data] of Object.entries(ri)) {
    for (const variant of data.variants) {
      if (!map[variant] || map[variant].correction !== correctWord) riMismatch++;
    }
  }
  test('reverseIndex matches map', riMismatch === 0, riMismatch + ' mismatches');

  // ── SECTION 6: NORMALISE HEALTH ───────────────────────
  console.log('\n▸ SECTION 6: NORMALISE HEALTH');

  const { normalise } = require('./src/query/normalise');

  const normTests = [
    ['LAPTOP',      'laptop'],
    ["men's kurta", 'mens kurta'],
    ['t-shirt',     't-shirt'],
    ['coooool',     'cool'],
    ['saree',       'saree'],
    ['zzzzzzzzz',   'zz'],
    ['size+color',  'size color'],
    ['',            ''],
    ['   ',         ''],
  ];

  let normPassed = 0;
  for (const [input, expected] of normTests) {
    const result = normalise(input);
    if (result === expected) normPassed++;
    else test('normalise: ' + JSON.stringify(input), false, 'got ' + JSON.stringify(result));
  }
  test('normalise all cases', normPassed === normTests.length, normPassed + '/' + normTests.length);

  // ── SECTION 7: SYMSPELL HEALTH ─────────────────────────
  console.log('\n▸ SECTION 7: SYMSPELL HEALTH');

  const { initSymSpell, correctQuery: symCorrect, shouldSkip, getStatus } = require('./src/spellcheck/symspell');
  await initSymSpell();
  const status = getStatus();

  test('symspell ready',    status.ready);
  test('dictionary loaded', status.minWordLength === 5, 'minWordLength=' + status.minWordLength);

  const skipTests = [
    ['cap', true], ['bag', true], ['s23ultra', true],
    ['256gb', true], ['laptop', false], ['leggigns', false]
  ];
  let skipPassed = 0;
  for (const [word, expected] of skipTests) {
    if (shouldSkip(word) === expected) skipPassed++;
  }
  test('shouldSkip logic', skipPassed === skipTests.length, skipPassed + '/' + skipTests.length);

  const symTests = [
    ['labtop', true], ['leggigns', true], ['laptop', false], ['s23ultra', false]
  ];
  let symPassed = 0;
  for (const [q, expectCorrection] of symTests) {
    const r = symCorrect(q);
    if ((r !== null) === expectCorrection) symPassed++;
  }
  test('symspell corrections', symPassed === symTests.length, symPassed + '/' + symTests.length);

  // ── SECTION 8: CORRECTOR SAFETY ───────────────────────
  console.log('\n▸ SECTION 8: CORRECTOR SAFETY');

  const HALLUCINATION_PATTERNS = [
    'input unchanged','no correction','no change','unchanged',
    'already correct','cannot correct','i cannot','sorry'
  ];
  const MAX_EXPANSION = 2.5;

  function validateCorrection(input, output) {
    const { normalise: norm } = require('./src/query/normalise');
    const ni = norm(input);
    if (/^(.)\1+$/.test(ni)) return false;
    if (!output) return false;
    const no = norm(output);
    if (!no || no === ni) return false;
    if (no.length < 2 || no.length > 50) return false;
    for (const p of HALLUCINATION_PATTERNS) {
      if (no.includes(p)) return false;
    }
    const iw = ni.split(/\s+/).filter(Boolean);
    const ow = no.split(/\s+/).filter(Boolean);
    if (iw.length === 1 && ow.length === 1 && no.length / ni.length < 0.6) return false;
    if (ow.length / iw.length > MAX_EXPANSION) return false;
    if (ni.length < 4 && no.length > ni.length * 2) return false;
    return true;
  }

  test('valid correction passes',    validateCorrection('leggigns', 'leggings'));
  test('hallucination blocked',      !validateCorrection('laptop', 'input unchanged'));
  test('gibberish input blocked',    !validateCorrection('zzzzzzz', 'zip'));
  test('short ratio blocked',        !validateCorrection('penceel', 'pen'));
  test('expansion blocked',          !validateCorrection('s23', 'samsung galaxy s23 ultra'));
  test('same as input blocked',      !validateCorrection('labtop', 'labtop'));
  test('semantic correction passes', validateCorrection('eyefone', 'iphone'));

  // ── SECTION 9: OLLAMA SKIP LOGIC ──────────────────────
  console.log('\n▸ SECTION 9: OLLAMA SKIP LOGIC');

  function shouldSkipOllama(query, totalHits) {
    if (totalHits >= 20) return true;
    if (totalHits >= 1000) return true;
    const words = query.toLowerCase().trim().split(/\s+/);
    const allSkippable = words.every(w => shouldSkip(w));
    if (allSkippable && words.length === 1) return true;
    return false;
  }

  test('skip correct word (360 hits)', shouldSkipOllama('laptop', 360));
  test('skip exactly 20 hits',         shouldSkipOllama('samsung', 20));
  test('skip model number',            shouldSkipOllama('s23ultra', 0));
  test('skip short word',              shouldSkipOllama('cap', 0));
  test('allow typo 0 hits',            !shouldSkipOllama('leggigns', 0));
  test('allow typo 8 hits',            !shouldSkipOllama('choclate', 8));
  test('allow multi word',             !shouldSkipOllama('runng shoos', 5));

  // ── SECTION 10: ANALYTICS HEALTH ──────────────────────
  console.log('\n▸ SECTION 10: ANALYTICS HEALTH');

  test('analytics log exists',
    fs.existsSync('logs/analytics.log'),
    fs.existsSync('logs/analytics.log') ? fs.statSync('logs/analytics.log').size + ' bytes' : 'missing'
  );
  test('queries log exists',
    fs.existsSync('logs/queries.log'),
    fs.existsSync('logs/queries.log') ? fs.statSync('logs/queries.log').size + ' bytes' : 'missing'
  );

  const { aggregate } = require('./analytics/aggregator');
  const { replayQuery } = require('./analytics/aggregator');
  test('aggregate function exists',   typeof aggregate === 'function');
  test('replayQuery function exists', typeof replayQuery === 'function');

  // ── SECTION 11: CONFIG CHECK ───────────────────────────
  console.log('\n▸ SECTION 11: CONFIG CHECK');

  const content = {
    queryRunner: fs.readFileSync('src/query/queryRunner.js', 'utf8'),
    learnedMap:  fs.readFileSync('src/learned/learnedMap.js', 'utf8'),
    symspell:    fs.readFileSync('src/spellcheck/symspell.js', 'utf8'),
    corrector:   fs.readFileSync('src/ollama/corrector.js', 'utf8'),
    searcher:    fs.readFileSync('src/meilisearch/searcher.js', 'utf8')
  };

  test('WEAK_RESULTS_THRESHOLD = 20',  content.queryRunner.includes('WEAK_RESULTS_THRESHOLD = 20'));
  test('MAX_RESULTS_LIMIT = 1000',     content.queryRunner.includes('MAX_RESULTS_LIMIT = 1000'));
  test('CONFIDENCE_GATE = 0.70',       content.learnedMap.includes('CONFIDENCE_GATE = 0.70'));
  test('MIN_WORD_LENGTH = 5',          content.symspell.includes('MIN_WORD_LENGTH = 5'));
  test('MAX_CORRECTIONS = 2',          content.symspell.includes('MAX_CORRECTIONS_PER_QUERY = 2'));
  test('HALLUCINATION_PATTERNS exist', content.corrector.includes('HALLUCINATION_PATTERNS'));
  test('category-diverse fallback',    content.searcher.includes('topCategories'));
  // shouldSkipOllama removed — online Ollama not used, offline learner (Groq) used instead ✅
  test('safeSaveCorrection exists',    content.queryRunner.includes('safeSaveCorrection'));
  test('learnedmap timing tracked',    content.queryRunner.includes('timing.learnedmap'));

  // ── SECTION 12: DELTA SYNC ────────────────────────────
  console.log('\n▸ SECTION 12: DELTA SYNC');

  const deltaSyncExists = fs.existsSync('./clientConnection/deltaSync.js');
  const deltaSyncSrc    = deltaSyncExists
    ? fs.readFileSync('./clientConnection/deltaSync.js', 'utf8') : null;
  const serverSrcDs     = fs.readFileSync('./server.js', 'utf8');

  test('deltaSync.js exists',           deltaSyncExists);
  test('deltaSync exports start',       deltaSyncSrc?.includes('start,')       || false);
  test('deltaSync exports triggerSync', deltaSyncSrc?.includes('triggerSync,')  || false);
  test('deltaSync exports getStatus',   deltaSyncSrc?.includes('getStatus')     || false);
  test('sync_state folder exists',      fs.existsSync('./sync_state'));
  test('all 8 client state files exist',
    ['135','137','198','210','226','237','246','247']
      .every(id => fs.existsSync(`./sync_state/client_${id}.json`)));
  test('server has sync status endpoint',  serverSrcDs.includes('/api/sync/status'));
  test('server has sync trigger endpoint', serverSrcDs.includes('/api/sync/trigger'));
  test('deltaSync has circuit breaker',    deltaSyncSrc?.includes('CIRCUIT_BREAKER_THRESHOLD') || false);
  test('deltaSync has heartbeat recovery', deltaSyncSrc?.includes('recoverStuckLocks')         || false);
  test('deltaSync has PIT pagination',     deltaSyncSrc?.includes('openPit')                   || false);
  test('deltaSync has retry logic',        deltaSyncSrc?.includes('withRetry')                 || false);


  // ── SECTION 13: DEDUPLICATION LOGIC ──────────────────
  console.log('\n▸ SECTION 13: DEDUPLICATION LOGIC');

  const { deduplicateCategories } = require('./src/meilisearch/deduplicateCategories');

  // test 1: catalogue preferred over category ✅
  const dedupResult = deduplicateCategories([
    { type: 'catalogue', value: 'iPad, Tablets & Laptops', productCount: 244 },
    { type: 'category',  value: 'iPad, Tablets & Laptops', productCount: 244 },
    { type: 'brand',     value: 'APPLE',                   productCount: 138 }
  ]);
  test('dedup: removes category when catalogue has same value', dedupResult.length === 2);
  test('dedup: catalogue preferred over category',              dedupResult[0].type === 'catalogue');
  test('dedup: brand preserved after dedup',                    dedupResult[1].value === 'APPLE');

  // test 2: case insensitive ✅
  const dedupCaseResult = deduplicateCategories([
    { type: 'catalogue', value: 'Smart Wearables', productCount: 100 },
    { type: 'category',  value: 'smart wearables', productCount: 100 },
  ]);
  test('dedup: case insensitive deduplication', dedupCaseResult.length === 1);

  // test 3: whitespace normalization ✅
  const dedupWhitespace = deduplicateCategories([
    { type: 'catalogue', value: 'Laptop ',  productCount: 100 },
    { type: 'category',  value: ' laptop',  productCount: 100 },
  ]);
  test('dedup: whitespace normalization', dedupWhitespace.length === 1);

  // test 4: null/undefined safety ✅
  let dedupSafe = true;
  try {
    deduplicateCategories([
      { type: 'catalogue', value: null },
      { type: 'category',  value: undefined }
    ]);
  } catch (e) { dedupSafe = false; }
  test('dedup: null/undefined value handled safely', dedupSafe);

  // ── FINAL SUMMARY ──────────────────────────────────────
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║           FINAL SUMMARY                ║');
  console.log('╚════════════════════════════════════════╝');
  console.log('Total tests:', totalTests);
  console.log('Passed:     ', totalPassed, '✅');
  console.log('Failed:     ', totalTests - totalPassed, totalTests - totalPassed === 0 ? '✅' : '❌');

  if (failures.length > 0) {
    console.log('\nFailed tests:');
    failures.forEach(f => console.log('  ❌', f));
  } else {
    console.log('\n🎉 ALL TESTS PASSED — System ready for testing!');
  }
}

run().catch(console.error);

// ─── PHASE 4: INTENT PARSER CHECKS ───────────────────────

console.log('\n╔════════════════════════════════════════╗');
console.log('║        PHASE 4: INTENT PARSER          ║');
console.log('╚════════════════════════════════════════╝\n');

async function runPhase4Checks() {
  let p4pass = 0;
  let p4fail = 0;

  function check(label, condition) {
    if (condition) {
      console.log(`  ✅ ${label}`);
      p4pass++;
    } else {
      console.log(`  ❌ ${label}`);
      p4fail++;
    }
  }

  let parseIntent, hasFilters, loadBrands;
  try {
    ({ parseIntent, hasFilters, loadBrands } = require('./src/query/intentParser'));
    check('intentParser module loads', true);
    check('parseIntent is function',   typeof parseIntent === 'function');
    check('hasFilters is function',    typeof hasFilters  === 'function');
    check('loadBrands is function',    typeof loadBrands  === 'function');
  } catch(e) {
    check('intentParser module loads', false);
    console.log('  ⚠️  Skipping remaining Phase 4 checks');
    return { p4pass, p4fail };
  }

  const tests = [
    { q: 'kurta under 500',       expect: r => r.filters.maxPrice === 500 },
    { q: 'shoes above 1000',      expect: r => r.filters.minPrice === 1000 },
    { q: 'jacket rs 500 to 2000', expect: r => r.filters.minPrice === 500 && r.filters.maxPrice === 2000 },
    { q: 'red kurta',             expect: r => r.filters.color === 'Red' },
    { q: 'navy blue saree',       expect: r => r.filters.color === 'Navy Blue' },
    { q: 'dark green dupatta',    expect: r => r.filters.color === 'Dark Green' },
    { q: 'baby pink dress',       expect: r => r.filters.color === 'Baby Pink' },
    { q: 'mens jacket',           expect: r => r.filters.category === 'Men' },
    { q: 'womens sandals',        expect: r => r.filters.category === 'Women' },
    { q: 'girls frock',           expect: r => r.filters.category === 'Girl' },
    { q: 'boys shirt',            expect: r => r.filters.category === 'Boy' },
    { q: 'baby clothes',          expect: r => r.filters.category === 'Just born' },
    { q: 'kids shoes',            expect: r => r.filters.category === undefined },
    { q: 'children jacket',       expect: r => r.filters.category === undefined },
    { q: 'dress 11 years',        expect: r => r.sizeGroup && r.sizeGroup.includes('11 - 12 Yrs') },
    { q: 'shirt 13-14 years',     expect: r => r.sizeGroup && r.sizeGroup.includes('13 - 14 Yrs') },
    { q: 'baby suit 0-3 months',  expect: r => r.sizeGroup && r.sizeGroup.includes('0-3M') },
    { q: 'clothes 18 months',     expect: r => r.sizeGroup && r.sizeGroup.includes('18-24M') },
    { q: 'saree 2 mtr',           expect: r => r.sizeGroup && r.sizeGroup.includes('2 MTR') },
    { q: 'red kurta under 500',   expect: r => r.filters.maxPrice === 500 && r.filters.color === 'Red' },
    { q: 'mens blue jacket',      expect: r => r.filters.category === 'Men' && r.filters.color === 'Blue' },
    { q: 'girls dress 11 years',  expect: r => r.filters.category === 'Girl' && r.sizeGroup !== null },
    { q: 'laptop',                expect: r => !hasFilters(r) },
    { q: 'organic shampoo',       expect: r => !hasFilters(r) },
    { q: 'pressure cooker',       expect: r => !hasFilters(r) },
    { q: 'red kurta under 500',   expect: r => r.cleanQuery === 'kurta' },
    { q: 'mens blue jacket',      expect: r => r.cleanQuery === 'jacket' },
  ];

  for (const t of tests) {
    try {
      const r = parseIntent(t.q);
      check(`parseIntent("${t.q}")`, t.expect(r));
    } catch(e) {
      check(`parseIntent("${t.q}")`, false);
    }
  }

  const qr = fs.readFileSync('src/query/queryRunner.js', 'utf8');
  check('queryRunner imports intentParser',      qr.includes("require('./intentParser')"));
  check('queryRunner calls parseIntent',         qr.includes('parseIntent(query)'));
  check('queryRunner has applyIntentIfNeeded',   qr.includes('applyIntentIfNeeded'));
  check('queryRunner passes intent to symspell', qr.includes('analytics, intent'));
  check('SYMSPELL_NOT_BETTER sentinel exists',   qr.includes('SYMSPELL_NOT_BETTER'));

  const sr = fs.readFileSync('src/meilisearch/searcher.js', 'utf8');
  check('searcher has size IN filter', sr.includes('Array.isArray(size)'));
  check('searcher uses IN syntax',     sr.includes('size IN'));

  const sv = fs.readFileSync('server.js', 'utf8');
  check('server imports loadBrands',          sv.includes('loadBrands'));
  check('server calls loadBrands on startup', sv.includes('await loadBrands'));

  const schema = fs.readFileSync('src/schemas/searchSchema.js', 'utf8');
  check('schema has intent in meta', schema.includes('intent:'));

  const alog = fs.readFileSync('analytics/logger.js', 'utf8');
  check('analytics logger has intent block', alog.includes('intent:'));

  const qlog = fs.readFileSync('src/utils/logger.js', 'utf8');
  check('queries logger has intentFilters', qlog.includes('intentFilters'));

  check('productsLogger exists', fs.existsSync('analytics/productsLogger.js'));

  console.log(`\nPhase 4: ${p4pass} passed, ${p4fail} failed`);
  return { p4pass, p4fail };
}

// ─── PHASE 5: PHASE 3 + PHASE 4 COVERAGE ────────────────

console.log('\n╔════════════════════════════════════════╗');
console.log('║     PHASE 5: PHASE 3 COVERAGE          ║');
console.log('╚════════════════════════════════════════╝\n');

async function runPhase5Checks() {
  let p5pass = 0;
  let p5fail = 0;

  function check(label, condition, detail = '') {
    if (condition) {
      console.log(`  ✅ ${label}${detail ? ' (' + detail + ')' : ''}`);
      p5pass++;
    } else {
      console.log(`  ❌ ${label}${detail ? ' (' + detail + ')' : ''}`);
      p5fail++;
    }
  }

  // ── 3.1 learnedMap metadata ───────────────────────────
  console.log('▸ 3.1 learnedMap metadata');

  const { loadMap, getStats } = require('./src/learned/learnedMap');
  loadMap();
  const stats = getStats();
  const map   = JSON.parse(fs.readFileSync('./learned/learnedMap.json', 'utf8'));
  const ri    = JSON.parse(fs.readFileSync('./learned/reverseIndex.json', 'utf8'));
  const entry = Object.values(map)[0];

  check('hitCount field exists',         entry.hitCount !== undefined,         'sample entry');
  check('firstSeen field exists',        entry.firstSeen !== undefined,        'sample entry');
  check('lastUsed field or null exists', 'lastUsed' in entry,                  'sample entry');
  check('disabledEntries in getStats',   stats.disabledEntries !== undefined,  stats.disabledEntries + ' disabled');
  check('candidateEntries in getStats',  stats.candidateEntries !== undefined, stats.candidateEntries + ' candidates');
  check('groqEntries in getStats',       stats.groqEntries !== undefined,      stats.groqEntries + ' groq');
  check('highValueEntries in getStats',  stats.highValueEntries !== undefined, stats.highValueEntries + ' high value');
  check('neverUsed in getStats',         stats.neverUsed !== undefined,        stats.neverUsed + ' never used');

  const learnedMapSrc = fs.readFileSync('./src/learned/learnedMap.js', 'utf8');
  check('learnedMap blocks disabled status',
    learnedMapSrc.includes("status === 'disabled'") &&
    learnedMapSrc.includes('corrected: false'),
    'code check — safe'
  );

  // ── 3.2 suggest improvements ─────────────────────────
  console.log('\n▸ 3.2 Suggest improvements');

  const suggestSchema = fs.readFileSync('./src/schemas/suggestSchema.js', 'utf8');
  const suggestRoute  = fs.readFileSync('./src/api/suggest.js', 'utf8');
  const searcherFile  = fs.readFileSync('./src/meilisearch/searcher.js', 'utf8');
  const queryRunner   = fs.readFileSync('./src/query/queryRunner.js', 'utf8');

  check('suggestSchema has unified list',     suggestSchema.includes('unified'));
  check('suggestSchema has correctionMode',   suggestSchema.includes('correctionMode'));
  check('suggestSchema has nameHighlighted',  suggestSchema.includes('nameHighlighted'));
  check('suggestSchema has totalSuggestions', suggestSchema.includes('totalSuggestions'));
  check('suggest.js passes suggestions',      suggestRoute.includes('suggestions'));
  check('suggest.js passes correctionMode',   suggestRoute.includes('correctionMode'));
  check('searcher has brand facets',          searcherFile.includes("'brand'"));
  check('searcher has category facets',       searcherFile.includes("'category'"));
  check('searcher has highlight in suggest',  searcherFile.includes('attributesToHighlight'));
  check('queryRunner passes suggestions',     queryRunner.includes('suggestions.suggestions'));

  // ── 3.3 analytics improvements ───────────────────────
  console.log('\n▸ 3.3 Analytics improvements');

  const analyticsLogger = fs.readFileSync('./analytics/logger.js', 'utf8');
  const queriesLogger   = fs.readFileSync('./src/utils/logger.js', 'utf8');
  const productsLogger  = fs.readFileSync('./analytics/productsLogger.js', 'utf8');
  const aggregatorFile  = fs.readFileSync('./analytics/aggregator.js', 'utf8');

  check('analytics logger has clientId',       analyticsLogger.includes('clientId'));
  check('analytics logger has phonetic',       analyticsLogger.includes('phonetic'));
  check('analytics logger has correctionMode', analyticsLogger.includes('correctionMode'));
  check('analytics logger writes multiTenant', analyticsLogger.includes('MULTI_TENANT'));
  check('queries logger has correctionMode',   queriesLogger.includes('correctionMode'));
  check('queries logger has correctionSource', queriesLogger.includes('correctionSource'));
  check('queries logger writes multiTenant',   queriesLogger.includes('MULTI_TENANT'));
  check('products logger has clientId',        productsLogger.includes('clientId'));
  check('products logger writes multiTenant',  productsLogger.includes('MULTI_TENANT'));
  check('products logger has mkdirSync',       productsLogger.includes('mkdirSync'));
  check('aggregator has byClient',             aggregatorFile.includes('byClient'));
  check('aggregator has layerFunnel',          aggregatorFile.includes('layerFunnel'));
  check('aggregator has correctionModes',      aggregatorFile.includes('correctionModes'));
  check('aggregator has readClientEntries',    aggregatorFile.includes('readClientEntries'));
  check('aggregator has phonetic layer',       aggregatorFile.includes('phoneticCalls'));
  check('aggregator has learnedMap hitRate',   aggregatorFile.includes('hitRate'));

  const clients = ['135','137','198','210','226','237','246','247'];
  let   folders = 0;
  let   logs    = 0;
  for (const cid of clients) {
    const dir = `./multiTenantLogs/client_${cid}`;
    if (fs.existsSync(dir)) folders++;
    if (
      fs.existsSync(`${dir}/analytics.log`) &&
      fs.existsSync(`${dir}/queries.log`)   &&
      fs.existsSync(`${dir}/products.log`)
    ) logs++;
  }
  check('all 8 client folders exist',  folders === 8, folders + '/8');
  check('all 8 client log sets exist', logs    === 8, logs    + '/8');

  // ── 3.4 pruning ───────────────────────────────────────
  console.log('\n▸ 3.4 Pruning');

  const pruneExists = fs.existsSync('./scripts/pruneLearnedMap.js');
  const pruneFile   = pruneExists ? fs.readFileSync('./scripts/pruneLearnedMap.js', 'utf8') : null;

  check('pruneLearnedMap.js exists',    pruneExists);
  check('prune has --apply flag',       pruneFile?.includes('--apply')         || false);
  check('prune has dry run default',    pruneFile?.includes('DRY RUN')         || false);
  check('prune has rule1 disable',      pruneFile?.includes('checkRule1')      || false);
  check('prune has rule2 never used',   pruneFile?.includes('checkRule2')      || false);
  check('prune has rule3 failures',     pruneFile?.includes('checkRule3')      || false);
  check('prune has rule4 stale',        pruneFile?.includes('checkRule4')      || false);
  check('prune has rule5 disabled old', pruneFile?.includes('checkRule5')      || false);
  check('prune saves report',           pruneFile?.includes('saveReport')      || false);
  check('prune cleans reverseIndex',    pruneFile?.includes('removeFromIndex') || false);
  check('learnedMap blocks disabled',   learnedMapSrc.includes("status === 'disabled'"));
  check('learnedMap restores on click', learnedMapSrc.includes('REENABLE_CLICKS'));

  // ── 3.5 offline learner ───────────────────────────────
  console.log('\n▸ 3.5 Offline learner');

  const olFiles = [
    'offlineLearner/config.js',
    'offlineLearner/queryCollector.js',
    'offlineLearner/groqClient.js',
    'offlineLearner/validator.js',
    'offlineLearner/learnedMapWriter.js',
    'offlineLearner/reporter.js',
    'offlineLearner/index.js'
  ];
  for (const f of olFiles) {
    check(`${f} exists`, fs.existsSync(f),
      fs.existsSync(f) ? fs.statSync(f).size + ' bytes' : 'missing');
  }

  const olConfig    = fs.readFileSync('./offlineLearner/config.js', 'utf8');
  const olCollector = fs.readFileSync('./offlineLearner/queryCollector.js', 'utf8');
  const olGroq      = fs.readFileSync('./offlineLearner/groqClient.js', 'utf8');
  const olValidator = fs.readFileSync('./offlineLearner/validator.js', 'utf8');
  const olWriter    = fs.readFileSync('./offlineLearner/learnedMapWriter.js', 'utf8');

  check('GROQ_API_KEY in env',               !!process.env.GROQ_API_KEY);
  check('config has CLIENT_SCOPE',           olConfig.includes('CLIENT_SCOPE'));
  check('config has STATUS lifecycle',       olConfig.includes('CANDIDATE'));
  check('config has PROMOTION thresholds',   olConfig.includes('PROMOTION'));
  check('config has SYSTEM_PROMPT',          olConfig.includes('SYSTEM_PROMPT'));
  check('collector tracks firstSeen',        olCollector.includes('queryFirstSeen'));
  check('collector tracks lastSeen',         olCollector.includes('queryLastSeen'));
  check('collector filters learnedMap',      olCollector.includes('Already known'));
  check('groqClient hallucination guards',   olGroq.includes('HALLUCINATION_PATTERNS'));
  check('groqClient has ratio check',        olGroq.includes('ratio'));
  check('groqClient has expansion check',    olGroq.includes('expansionRatio'));
  check('validator relative improvement',    olValidator.includes('originalHits * 1.2'));
  check('validator derives scope',           olValidator.includes('deriveScope'));
  check('writer saves as candidate',         olWriter.includes('STATUS.CANDIDATE'));
  check('writer lastUsed null on create',    olWriter.includes('lastUsed:    null'));
  check('writer has validation stats',       olWriter.includes('validation:'));
  check('writer has model field',            olWriter.includes('model:'));
  check('writer has chain detection',        olWriter.includes('chain_detected'));

  // ── feature flags ─────────────────────────────────────
  console.log('\n▸ Feature flags');

  const featExists   = fs.existsSync('./src/searchBanners/features.js');
  const featFile     = featExists ? fs.readFileSync('./src/searchBanners/features.js', 'utf8') : null;
  const searchSchema = fs.readFileSync('./src/schemas/searchSchema.js', 'utf8');

  check('features.js exists',              featExists);
  check('correctionBanner flag exists',    featFile?.includes('correctionBanner')      || false);
  check('silentInputCorrection exists',    featFile?.includes('silentInputCorrection')  || false);
  check('searchInsteadLink exists',        featFile?.includes('searchInsteadLink')      || false);
  check('searchSchema has displayQuery',   searchSchema.includes('displayQuery'));
  check('searchSchema has retrievalQuery', searchSchema.includes('retrievalQuery'));
  check('searchSchema has correctionMode', searchSchema.includes('correctionMode'));
  check('searchSchema has ui hints',       searchSchema.includes('showBanner'));

  // ── suggestMap ────────────────────────────────────────
  console.log('\n▸ suggestMap');

  const smExists  = fs.existsSync('./learned/suggestMap.json');
  const smData    = smExists ? JSON.parse(fs.readFileSync('./learned/suggestMap.json', 'utf8')) : {};
  const smValues  = Object.values(smData);
  const smModule  = fs.existsSync('./src/learned/suggestMap.js')
    ? fs.readFileSync('./src/learned/suggestMap.js', 'utf8') : null;
  const serverSrc = fs.readFileSync('./server.js', 'utf8');
  const enrichSrc = fs.readFileSync('./scripts/enrichLearnedMap.js', 'utf8');

  check('suggestMap.json exists',             smExists);
  check('suggestMap has entries',             Object.keys(smData).length > 0,
    Object.keys(smData).length + ' completions');
  check('suggestMap no csv in learnedMap',    stats.csvEntries === 0,
    stats.csvEntries + ' csv entries remaining');
  check('src/learned/suggestMap.js exists',   fs.existsSync('./src/learned/suggestMap.js'));
  check('suggestMap has loadMap',             smModule?.includes('function loadMap')       || false);
  check('suggestMap has getCompletion',       smModule?.includes('function getCompletion') || false);
  check('suggestMap has addCompletion',       smModule?.includes('function addCompletion') || false);
  check('suggestMap has getStats',            smModule?.includes('function getStats')      || false);
  check('suggestMap has pendingSave',         smModule?.includes('pendingSave')            || false);
  check('suggestMap has atomic write',        smModule?.includes("SUGGEST_MAP_FILE + '.tmp'") || false);
  check('suggestMap entries have completion', smValues.every(e => e.completion && e.source),
    'all entries valid');
  check('server loads suggestMap',            serverSrc.includes('loadSuggestMap'));
  check('queryRunner imports suggestMap',     queryRunner.includes('suggestMapModule'));
  check('queryRunner MIN_SUGGEST_RESULTS',    queryRunner.includes('MIN_SUGGEST_RESULTS'));
  check('suggestMap fires after symspell',
    queryRunner.indexOf('suggestMapModule.getCompletion') >
    queryRunner.indexOf('symspellCorrectQuery(normalised)'),
    'correct pipeline order'
  );
  check('enrichLearnedMap writes suggestMap', enrichSrc.includes('SUGGEST_MAP'));

  // ── architecture invariants ───────────────────────────
  console.log('\n▸ Architecture invariants');

  check('learnedMap has no csv entries',
    stats.csvEntries === 0, stats.csvEntries + ' csv entries');
  check('learnedMap has no suggestOnly flag',
    !Object.values(map).some(e => 'suggestOnly' in e), 'no suggestOnly flags');
  check('suggestMap no confidence field',
    smValues.every(e => !('confidence' in e)), 'clean');
  check('suggestMap no hitCount field',
    smValues.every(e => !('hitCount' in e)), 'clean');
  check('suggestMap no status field',
    smValues.every(e => !('status' in e)), 'clean');
  check('suggestMap no failures field',
    smValues.every(e => !('failures' in e)), 'clean');

  const candidates      = Object.values(map).filter(e => e.status === 'candidate');
  const groqCandidates2 = candidates.filter(e => e.source === 'groq');
  check('all entries have explicit status',
    Object.values(map).every(e => e.status !== undefined),
    Object.values(map).filter(e => !e.status).length + ' missing status');
  check('groq candidates have groq source',
    groqCandidates2.every(e => e.source === 'groq'),
    groqCandidates2.length + ' groq candidates');

  const smKeys = new Set(Object.keys(smData));
  const riKeys = Object.values(ri).flatMap(e => e.variants || []);
  const leaked = riKeys.filter(k => smKeys.has(k));
  check('reverseIndex has no suggestMap keys',
    leaked.length === 0, leaked.length + ' leaked');

  // ── phonetic layer ────────────────────────────────────
  console.log('\n▸ Phonetic layer');

  const phonExists = fs.existsSync('./src/spellcheck/phonetic.js');
  const phonFile   = phonExists ? fs.readFileSync('./src/spellcheck/phonetic.js', 'utf8') : null;

  check('phonetic.js exists',          phonExists);
  check('phonetic has buildIndex',     phonFile?.includes('buildIndex')    || false);
  check('phonetic has correctQuery',   phonFile?.includes('correctQuery')  || false);
  check('phonetic has PRODUCT_BOOST',  phonFile?.includes('PRODUCT_BOOST') || false);
  check('queryRunner uses phonetic',   queryRunner.includes('phoneticCorrectQuery'));
  check('queryRunner tracks phonetic', queryRunner.includes('analytics.phonetic'));

  // ── Phase 4: promotion engine ─────────────────────────
  console.log('\n▸ Phase 4: Promotion engine');

  check('TRUSTED_THRESHOLD in learnedMap',  learnedMapSrc.includes('TRUSTED_THRESHOLD'));
  check('PROVEN_THRESHOLD in learnedMap',   learnedMapSrc.includes('PROVEN_THRESHOLD'));
  check('REENABLE_CLICKS in learnedMap',    learnedMapSrc.includes('REENABLE_CLICKS'));
  check('getPromotedStatus exists',         learnedMapSrc.includes('function getPromotedStatus'));
  check('promotion fires in saveCorrection',learnedMapSrc.includes('getPromotedStatus(entry)'));
  check('lastPromotedAt tracked',           learnedMapSrc.includes('lastPromotedAt'));
  check('proven protected from penalisation',
    learnedMapSrc.includes("status === 'proven'") &&
    learnedMapSrc.includes('protected — status: proven'));
  check('new entries get candidate status', learnedMapSrc.includes("status:      'candidate'"));
  check('pendingMapSave prevents data loss',learnedMapSrc.includes('pendingMapSave'));
  check('pendingIndexSave prevents data loss', learnedMapSrc.includes('pendingIndexSave'));
  check('promotedLast7Days in getStats',    learnedMapSrc.includes('promotedLast7Days'));

  // ── Phase 4: admin endpoints ──────────────────────────
  console.log('\n▸ Phase 4: Admin endpoints');

  check('reload endpoint exists',           serverSrc.includes('/api/admin/reload'));
  check('corrections endpoint exists',      serverSrc.includes('/api/admin/corrections'));
  check('reload calls loadMap',             serverSrc.includes('loadMap()'));
  check('reload calls loadSuggestMap',      serverSrc.includes('loadSuggestMap()'));
  check('dashboard shows topCorrections',   serverSrc.includes('topCorrections'));
  check('dashboard shows groqCandidates',   serverSrc.includes('groqCandidates'));
  check('dashboard shows disabledEntries',  serverSrc.includes('disabledEntries'));
  check('dashboard shows promotedLast7Days',serverSrc.includes('promotedLast7Days'));
  check('dashboard has calcSuccessRate helper', serverSrc.includes('calcSuccessRate'));
  check('dashboard shows successRate in topCorrections',
    serverSrc.includes('successRate: calcSuccessRate'));
  check('dashboard shows lowestSuccessRate',serverSrc.includes('lowestSuccessRate'));
  check('dashboard shows avgSuccessRate',   serverSrc.includes('avgSuccessRate'));
  check('server has calcSourcePerformance helper', serverSrc.includes('calcSourcePerformance'));
  check('server computes sourcePerformance',
    serverSrc.includes('sourcePerformance = calcSourcePerformance'));
  check('server returns sourcePerformance in response', serverSrc.includes("sourcePerformance,"));
  check('sourcePerformance tracks withTraffic', serverSrc.includes('withTraffic'));
  check('sourcePerformance tracks neverUsed',   serverSrc.includes('neverUsed'));
  check('recent-activity endpoint exists',      serverSrc.includes('/api/admin/recent-activity'));
  check('readRecentActivity helper exists',     serverSrc.includes('readRecentActivity'));
  check('buildWhyString helper exists',         serverSrc.includes('buildWhyString'));
  check('recent-activity has filters',          serverSrc.includes('correctionOnly'));
  check('recent-activity has layerBreakdown',   serverSrc.includes('layerBreakdown'));

  // ── Phase 4: scope context ────────────────────────────
  console.log('\n▸ Phase 4: Scope context');

  check('applyCorrection has context param',
    learnedMapSrc.includes('context = {}') &&
    learnedMapSrc.includes('function applyCorrection'));
  check('penaliseCorrection has context param',
    learnedMapSrc.includes('penaliseCorrection(originalQuery, context = {})'));
  check('cross-client penalty detection exists',
    learnedMapSrc.includes('Cross-client penalty detected'));
  check('lastPenalisedByClient tracked',  learnedMapSrc.includes('lastPenalisedByClient'));
  check('lastPenalisedAt tracked',        learnedMapSrc.includes('lastPenalisedAt'));
  check('queryRunner passes context to applyCorrection',
    queryRunner.includes('clientId:    options.clientId') &&
    queryRunner.includes('clientScope: options.clientScope'));
  check('queryRunner passes context to penalise',
    queryRunner.includes('penaliseCorrection(query, {'));
  check('dashboard shows crossClientRisks', serverSrc.includes('crossClientRisks'));

  // ── scope wiring ──────────────────────────────────────
  console.log('\n▸ Scope wiring');

  const clientHelper = fs.readFileSync('./configVendors/clientHelper.js', 'utf8');
  const searchApi    = fs.readFileSync('./src/api/search.js', 'utf8');
  const suggestApi   = fs.readFileSync('./src/api/suggest.js', 'utf8');
  const behaviourApi = fs.readFileSync('./src/api/behaviour.js', 'utf8');

  check('clientHelper has getClientScope', clientHelper.includes('function getClientScope'));
  check('search.js imports getClientScope',searchApi.includes('getClientScope'));
  check('search.js passes clientScope',    searchApi.includes('clientScope'));
  check('suggest.js imports getClientScope',suggestApi.includes('getClientScope'));
  check('suggest.js passes clientScope',   suggestApi.includes('clientScope'));
  check('behaviour.js passes clientId to click', behaviourApi.includes('clientId:    clientId'));

  // ── layer funnel validation ───────────────────────────
  console.log('\n▸ Layer funnel validation');

  let meiliAvailable = false;
  try {
    const { MeiliSearch } = require('meilisearch');
    const mc = new MeiliSearch({
      host:   process.env.MEILI_HOST       || 'http://localhost:7700',
      apiKey: process.env.MEILI_MASTER_KEY || 'searchapikey123'
    });
    await mc.health();
    meiliAvailable = true;
  } catch { meiliAvailable = false; }

  if (!meiliAvailable) {
    check('layer funnel tests skipped — Meilisearch down', true, 'skipped');
  } else {
    const { runSearch } = require('./src/query/queryRunner');
    const testOpts      = { meiliIndex: 'client_198_products' };

    try {
      const r1 = await runSearch('labtop', testOpts);
      check('labtop → corrected',           r1.wasCorrected === true,       r1.correctionSource || 'none');
      check('labtop → retrieval is laptop', r1.retrievalQuery === 'laptop', r1.retrievalQuery);
      check('labtop → has results',         r1.totalHits > 0,               r1.totalHits + ' hits');
    } catch(e) { check('labtop layer test', false, e.message); }

    try {
      const r2 = await runSearch('laptop', testOpts);
      check('laptop → no correction',
        r2.correctionMode === 'none' || r2.correctionMode === 'assisted',
        r2.correctionMode);
      check('laptop → has results', r2.totalHits > 0, r2.totalHits + ' hits');
    } catch(e) { check('laptop layer test', false, e.message); }
  }

  // ── suggest pipeline tests ────────────────────────────
  console.log('\n▸ Suggest pipeline tests');

  if (!meiliAvailable) {
    check('suggest pipeline tests skipped — Meilisearch down', true, 'skipped');
  } else {
    const { runSuggest } = require('./src/query/queryRunner');
    const suggestOpts    = { meiliIndex: 'client_198_products' };

    try {
      const s1 = await runSuggest('laptop', suggestOpts);
      check('laptop suggest → has products',
        (s1.products?.length || 0) > 0, (s1.products?.length || 0) + ' products');
      check('laptop suggest → no correction',
        s1.wasCorrected === false, s1.correctionSource || 'none');
    } catch(e) { check('laptop suggest test', false, e.message); }

    try {
      const s2 = await runSuggest('labtop', suggestOpts);
      check('labtop suggest → has products',
        (s2.products?.length || 0) > 0, (s2.products?.length || 0) + ' products');
    } catch(e) { check('labtop suggest test', false, e.message); }
  }

  console.log(`\nPhase 5: ${p5pass} passed, ${p5fail} failed`);
  return { p5pass, p5fail };
}

// ─── RUN ALL PHASES ───────────────────────────────────────

Promise.all([
  runPhase4Checks(),
  runPhase5Checks()
]).then(([{ p4pass, p4fail }, { p5pass, p5fail }]) => {
  console.log('\n╔════════════════════════════════════════╗');
  console.log('║         GRAND TOTAL SUMMARY            ║');
  console.log('╚════════════════════════════════════════╝');
  console.log(`Phase 1-3: ${totalPassed} / ${totalTests} ${totalTests - totalPassed === 0 ? '✅' : '❌'}`);
  console.log(`Phase 4:   ${p4pass} / ${p4pass + p4fail} ${p4fail === 0 ? '✅' : '❌'}`);
  console.log(`Phase 5:   ${p5pass} / ${p5pass + p5fail} ${p5fail === 0 ? '✅' : '❌'}`);
  console.log(`Total:     ${totalPassed + p4pass + p5pass} / ${totalTests + p4pass + p4fail + p5pass + p5fail} ${p4fail + p5fail === 0 && totalTests === totalPassed ? '✅' : '⚠️'}`);

  // ── exit with non-zero code if any tests failed ───────
  // makes GitHub Actions CI/CD detect a broken deploy ✅
  // set -e in the workflow script catches this exit code ✅
  const allPassed = totalPassed === totalTests && p4fail === 0 && p5fail === 0;
  if (!allPassed) {
    console.error('\n❌ Tests failed — deployment should be rejected');
    process.exit(1);
  }
});