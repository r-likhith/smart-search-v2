// scripts/searchQualityBenchmark.js
//
// Full pipeline benchmark — tests query → correction → results ✅
// Separates core tests (dataset-independent) from
// catalog tests (client-specific, loaded from JSON) ✅
//
// Usage:
//   node scripts/searchQualityBenchmark.js
//   node scripts/searchQualityBenchmark.js 198
//   node scripts/searchQualityBenchmark.js 198 --save before
//   node scripts/searchQualityBenchmark.js 198 --save after

require('dotenv').config();
const fs   = require('fs');
const path = require('path');

const _arg = process.argv[2] || '198';
const CLIENT_ID = _arg.replace('client_','').replace('_products','');
const INDEX_NAME = `client_${CLIENT_ID}_products`;
const saveTag   = process.argv[4];
const API_URL   = `http://localhost:${process.env.PORT || 3000}`;
const API_KEY   = process.env.API_KEY || 'searchapikey123';
const BENCH_DIR = path.join(__dirname, '../benchmarks');

// ─── CORE TESTS (dataset-independent) ────────────────────
// These test BEHAVIOR not specific products ✅
// Pass/fail based on:
//   shouldCorrect: did correction fire?
//   shouldHaveResults: did search return results?
//   notExpected: these words should NOT appear in top results ✅

const coreTests = [
  // typo correction should fire ✅
  { query: 'laptpo',     shouldCorrect: true,  shouldHaveResults: true,  category: 'recall' },
  { query: 'samsng',     shouldCorrect: true,  shouldHaveResults: true,  category: 'recall' },
  { query: 'iphnoe',     shouldCorrect: true,  shouldHaveResults: true,  category: 'recall' },
  { query: 'keyborad',   shouldCorrect: true,  shouldHaveResults: true,  category: 'recall' },
  { query: 'smratwatch', shouldCorrect: true,  shouldHaveResults: true,  category: 'recall' },
  { query: 'bluetoth',   shouldCorrect: true,  shouldHaveResults: true,  category: 'recall' },
  { query: 'headphon',   shouldCorrect: true,  shouldHaveResults: true,  category: 'recall' },

  // no correction needed — exact words ✅
  { query: 'laptop',     shouldCorrect: false, shouldHaveResults: true,  category: 'recall' },
  { query: 'samsung',    shouldCorrect: false, shouldHaveResults: true,  category: 'recall' },
  { query: 'iphone',     shouldCorrect: false, shouldHaveResults: true,  category: 'recall' },

  // false positives — fashion terms for electronics client ✅
  { query: 'saree',      shouldCorrect: false, shouldHaveResults: false, category: 'precision',
    note: 'fashion term — should return 0 for electronics' },
  { query: 'kurti',      shouldCorrect: false, shouldHaveResults: false, category: 'precision' },
  { query: 'dupatta',    shouldCorrect: false, shouldHaveResults: false, category: 'precision' },

  // edge cases ✅
  { query: 's9',         shouldCorrect: false, shouldHaveResults: true,  category: 'edge',
    note: 'short model number — no correction needed' },
  { query: '256gb',      shouldCorrect: false, shouldHaveResults: true,  category: 'edge',
    note: 'spec search — no correction needed' },
];

// ─── CATALOG TESTS (client-specific) ─────────────────────
// Loaded from benchmarks/client_198.json ✅
// Format: { query, expectedNameFragment, shouldHaveResults }

function loadCatalogTests(clientId) {
  const file = path.join(BENCH_DIR, `client_${clientId}.json`);
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

// ─── SEARCH VIA FULL PIPELINE ─────────────────────────────

async function search(query, clientId) {
  const start = Date.now();
  const resp  = await fetch(`${API_URL}/api/search`, {
    method:  'POST',
    headers: {
      'x-api-key':    API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, clientId })
  });
  const data    = await resp.json();
  const latency = Date.now() - start;
  return { data: data?.data, latency };
}

// ─── RUN ─────────────────────────────────────────────────

async function run() {
  if (!fs.existsSync(BENCH_DIR)) fs.mkdirSync(BENCH_DIR);

  const tag = saveTag ? ` [${process.argv[3]} ${saveTag}]` : '';
  console.log(`\n╔════════════════════════════════════════╗`);
  console.log(`║   SEARCH QUALITY BENCHMARK${tag.padEnd(13)}║`);
  console.log(`╚════════════════════════════════════════╝`);
  console.log(`Client: ${CLIENT_ID}\n`);

  const catalogTests = loadCatalogTests(CLIENT_ID);
  const results = {
    clientId:  CLIENT_ID,
    timestamp: new Date().toISOString(),
    tag:       saveTag || null,
    recall:    { passed: 0, total: 0 },
    precision: { passed: 0, total: 0 },
    edge:      { passed: 0, total: 0 },
    catalog:   { passed: 0, total: 0 },
    latencies: [],
    failures:  []
  };

  // ── run core tests ────────────────────────────────────
  console.log('▸ Core tests (dataset-independent)\n');

  for (const t of coreTests) {
    const { data, latency } = await search(t.query, CLIENT_ID);
    results.latencies.push(latency);

    const correction     = data?.correction;
    const didCorrect     = correction?.applied === true;
    const hits           = data?.meta?.totalHits || 0;
    const correctedTo    = correction?.correctedQuery || null;
    const correctionSrc  = correction?.source || null;

    const recallOk    = t.shouldCorrect ? didCorrect : true;
    const isFallback  = data?.meta?.isFallback || false;
    const precisionOk = t.shouldHaveResults ? (hits > 0 && !isFallback) : (isFallback || hits === 0);
    const correct     = recallOk && precisionOk;

    results[t.category].total++;
    if (correct) results[t.category].passed++;
    else results.failures.push({
      query:     t.query,
      category:  t.category,
      expected:  t.shouldHaveResults ? 'results' : 'no results',
      got:       `${hits} hits`,
      corrected: correctedTo,
      note:      t.note || null
    });

    const status    = correct ? '✅' : '❌';
    const corrStr   = didCorrect ? `→ "${correctedTo}" (${correctionSrc})` : '(no correction)';
    const noteStr   = t.note ? ` [${t.note}]` : '';
    console.log(`${status} [${t.category}] "${t.query}" ${corrStr} | ${hits} hits | ${latency}ms${noteStr}`);
  }

  // ── run catalog tests ─────────────────────────────────
  if (catalogTests.length > 0) {
    console.log('\n▸ Catalog tests (client-specific)\n');

    for (const t of catalogTests) {
      const { data, latency } = await search(t.query, CLIENT_ID);
      results.latencies.push(latency);

      const hits       = data?.meta?.totalHits || 0;
    const isFallback = data?.meta?.isFallback || false;
      const topNames = (data?.results || []).slice(0,5)
        .map(r => r.name?.toLowerCase() || '');
      const topMatches = t.expectedName
        ? topNames.some(n => n.includes(t.expectedName.toLowerCase()))
        : true;

      const correct = t.shouldHaveResults
        ? hits > 0 && topMatches
        : hits === 0;

      results.catalog.total++;
      if (correct) results.catalog.passed++;
      else results.failures.push({
        query:    t.query,
        category: 'catalog',
        expected: t.expectedName,
        got:      topNames.slice(0,3).join(' | ')
      });

      const status = correct ? '✅' : '❌';
      console.log(`${status} [catalog] "${t.query}" → ${hits} hits | ${latency}ms`);
      if (!correct && topNames.length) {
        console.log(`   expected: "${t.expectedName}"`);
        console.log(`   got: ${topNames.slice(0,3).join(' | ')}`);
      }
    }
  }

  // ── summary ───────────────────────────────────────────
  const avgLatency = Math.round(
    results.latencies.reduce((a,b) => a+b, 0) / results.latencies.length
  );
  results.avgLatency = avgLatency;

  const totalPassed = results.recall.passed + results.precision.passed +
                      results.edge.passed   + results.catalog.passed;
  const totalTests  = results.recall.total  + results.precision.total +
                      results.edge.total    + results.catalog.total;

  console.log('\n─────────────────────────────────────────');
  console.log(`Recall    (typo correction): ${results.recall.passed}/${results.recall.total}`);
  console.log(`Precision (false positives): ${results.precision.passed}/${results.precision.total}`);
  console.log(`Edge cases:                  ${results.edge.passed}/${results.edge.total}`);
  if (catalogTests.length > 0)
    console.log(`Catalog   (client-specific): ${results.catalog.passed}/${results.catalog.total}`);
  console.log(`Overall:                     ${totalPassed}/${totalTests}`);
  console.log(`Avg latency:                 ${avgLatency}ms`);

  if (results.failures.length > 0) {
    console.log('\nFailures:');
    results.failures.forEach(f => {
      console.log(`  ❌ "${f.query}" [${f.category}]`);
      if (f.note) console.log(`     note: ${f.note}`);
      if (f.corrected) console.log(`     corrected to: ${f.corrected}`);
      console.log(`     expected: ${f.expected} | got: ${f.got}`);
    });
  }
  console.log('─────────────────────────────────────────\n');

  // ── save + compare ────────────────────────────────────
  if (saveTag) {
    const date     = new Date().toISOString().split('T')[0];
    const filename = `${date}-client_${CLIENT_ID}-${saveTag}.json`;
    const filepath = path.join(BENCH_DIR, filename);
    fs.writeFileSync(filepath, JSON.stringify({ ...results, totalPassed, totalTests }, null, 2));
    console.log(`✅ Saved: benchmarks/${filename}`);

    if (saveTag === 'after') {
      const beforeFile = fs.readdirSync(BENCH_DIR)
        .filter(f => f.includes(`client_${CLIENT_ID}`) && f.includes('before'))
        .sort().pop();

      if (beforeFile) {
        const before = JSON.parse(
          fs.readFileSync(path.join(BENCH_DIR, beforeFile), 'utf8')
        );
        console.log('\n── Before vs After ──────────────────────');
        console.log(`Recall:    ${before.recall.passed}/${before.recall.total} → ${results.recall.passed}/${results.recall.total}`);
        console.log(`Precision: ${before.precision.passed}/${before.precision.total} → ${results.precision.passed}/${results.precision.total}`);
        console.log(`Latency:   ${before.avgLatency}ms → ${avgLatency}ms`);
        const recallDelta    = results.recall.passed - before.recall.passed;
        const precisionDelta = results.precision.passed - before.precision.passed;
        console.log(`\nRecall change:    ${recallDelta >= 0 ? '+' : ''}${recallDelta}`);
        console.log(`Precision change: ${precisionDelta >= 0 ? '+' : ''}${precisionDelta}`);
        console.log('─────────────────────────────────────────\n');
      }
    }
  }
}

run().catch(console.error);
