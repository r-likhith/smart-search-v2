// phoneticBenchmark.js
// Measures phonetic correction quality across categories ✅
// Produces versioned reports for tracking improvements ✅
//
// Metrics:
//   Top-1 accuracy    — winner is correct ✅
//   Top-3 accuracy    — correct answer in top 3 ✅
//   Coverage          — words actually in phonetic index ✅
//   False positives   — correct word incorrectly changed ✅
//   Avg confidence    — mean winner score ✅
//   Avg margin        — mean winner - runnerUp gap ✅
//   Confusion report  — expected vs predicted ✅
//   Category breakdown ✅

const fs   = require('fs');
const path = require('path');

const { buildIndex, correctWord, getTopCandidates } = require('./src/spellcheck/phonetic');

// ─── TEST DATASET ─────────────────────────────────────────
// format: [typo, expected_correction, category]
// null expected = correct word, should NOT be corrected ✅
// note: already-correct words (saree, trouser, sandal)
//       belong in false-positive section, not typo section ✅

const PAIRS = [
  // ── brands ────────────────────────────────────────────
  ['nikee',     'nike',       'brand'],
  ['nokea',     'nokia',      'brand'],
  ['adidass',   'adidas',     'brand'],
  ['samsng',    'samsung',    'brand'],
  ['samzung',   'samsung',    'brand'],
  ['samsang',   'samsung',    'brand'],
  ['appel',     'apple',      'brand'],
  ['soni',      'sony',       'brand'],
  ['onepluss',  'oneplus',    'brand'],
  ['realmi',    'realme',     'brand'],

  // ── electronics ───────────────────────────────────────
  ['blutooth',  'bluetooth',  'electronics'],
  ['bluetoth',  'bluetooth',  'electronics'],
  ['earfone',   'earphone',   'electronics'],
  ['speker',    'speaker',    'electronics'],
  ['iphon',     'iphone',     'electronics'],
  ['iphonne',   'iphone',     'electronics'],
  ['iphine',    'iphone',     'electronics'],
  ['iphoen',    'iphone',     'electronics'],
  ['keyborad',  'keyboard',   'electronics'],
  ['moniter',   'monitor',    'electronics'],
  ['laptpp',    'laptop',     'electronics'],
  ['labtop',    'laptop',     'electronics'],

  // ── fashion ───────────────────────────────────────────
  ['kurtaa',    'kurta',      'fashion'],
  ['leggigns',  'leggings',   'fashion'],
  ['shurt',     'shirt',      'fashion'],
  ['jeket',     'jacket',     'fashion'],
  // note: trouser/sandal/saree moved to FP — already correct ✅

  // ── grocery ───────────────────────────────────────────
  ['tomatoe',   'tomato',     'grocery'],
  ['potatoe',   'potato',     'grocery'],
  ['choclate',  'chocolate',  'grocery'],
  ['chiken',    'chicken',    'grocery'],
  ['brocolli',  'broccoli',   'grocery'],
  ['cofee',     'coffee',     'grocery'],
  ['buter',     'butter',     'grocery'],

  // ── sports ────────────────────────────────────────────
  ['badmintan', 'badminton',  'sports'],
  ['footbal',   'football',   'sports'],
  ['cricekt',   'cricket',    'sports'],
  ['tenniss',   'tennis',     'sports'],
  ['swimmin',   'swimming',   'sports'],

  // ── general ───────────────────────────────────────────
  ['wireles',   'wireless',   'general'],
  ['orgnic',    'organic',    'general'],
  ['deterjent', 'detergent',  'general'],
  ['moisturisr','moisturiser','general'],
  ['shampo',    'shampoo',    'general'],
  ['perfum',    'perfume',    'general'],

  // ── false positives — should NOT be corrected ─────────
  // correct words → algorithm should return null ✅
  ['laptop',    null,         'fp'],
  ['samsung',   null,         'fp'],
  ['iphone',    null,         'fp'],
  ['bluetooth', null,         'fp'],
  ['rice',      null,         'fp'],
  ['shirt',     null,         'fp'],
  ['kurta',     null,         'fp'],
  ['speaker',   null,         'fp'],
  ['keyboard',  null,         'fp'],
  ['monitor',   null,         'fp'],
  // moved from typo section — these were already correct ✅
  ['trouser',   null,         'fp'],
  ['sandal',    null,         'fp'],
  ['saree',     null,         'fp'],
];

// ─── RUN BENCHMARK ────────────────────────────────────────

function runBenchmark() {
  buildIndex();

  const results = {
    total:        0,
    top1:         0,
    top3:         0,
    covered:      0,  // words found in phonetic index ✅
    fp:           0,
    fn:           0,
    skipped:      0,
    confidences:  [],
    margins:      [],
    confusion:    [],
    byCategory:   {}
  };

  for (const [typo, expected, category] of PAIRS) {
    results.total++;
    if (!results.byCategory[category]) {
      results.byCategory[category] = { total: 0, top1: 0, top3: 0, fp: 0, fn: 0, covered: 0 };
    }
    results.byCategory[category].total++;

    const topCands = getTopCandidates(typo, 5);
    const winner   = correctWord(typo);

    // ── false positive check ───────────────────────────
    if (expected === null) {
      if (winner !== null) {
        results.fp++;
        results.byCategory[category].fp++;
        results.confusion.push({
          typo,
          expected:  '(no change)',
          predicted: winner,
          verdict:   'FALSE POSITIVE ❌',
          category
        });
      }
      continue;
    }

    // ── coverage — word has phonetic candidates ────────
    if (topCands.length > 0) {
      results.covered++;
      results.byCategory[category].covered++;
    } else {
      results.skipped++;
    }

    // ── top-1 accuracy ────────────────────────────────
    const top1Correct = winner === expected;
    if (top1Correct) {
      results.top1++;
      results.byCategory[category].top1++;
    }

    // ── top-3 accuracy ────────────────────────────────
    const top3Words   = topCands.map(c => c.word);
    const top3Correct = top3Words.includes(expected);
    if (top3Correct) {
      results.top3++;
      results.byCategory[category].top3++;
    }

    // ── false negative ────────────────────────────────
    if (!top3Correct) {
      results.fn++;
      results.byCategory[category].fn++;
    }

    // ── confidence + margin ───────────────────────────
    if (topCands.length >= 1) {
      results.confidences.push(topCands[0].score);
      if (topCands.length >= 2) {
        results.margins.push(
          parseFloat((topCands[0].score - topCands[1].score).toFixed(4))
        );
      }
    }

    // ── confusion report ──────────────────────────────
    if (!top1Correct) {
      results.confusion.push({
        typo,
        expected,
        predicted:  winner || '(none)',
        runnerUp:   topCands[1]?.word || null,
        margin:     topCands.length >= 2
          ? parseFloat((topCands[0].score - topCands[1].score).toFixed(4))
          : null,
        verdict:    top3Correct ? 'TOP-3 ✅ (wrong rank)' : 'MISS ❌',
        category
      });
    }
  }

  return results;
}

// ─── FORMAT REPORT ────────────────────────────────────────

function formatReport(results) {
  const typoTotal  = results.total - PAIRS.filter(p => p[1] === null).length;
  const fpTotal    = PAIRS.filter(p => p[1] === null).length;
  const top1Pct    = typoTotal > 0 ? (results.top1    / typoTotal * 100).toFixed(1) : 0;
  const top3Pct    = typoTotal > 0 ? (results.top3    / typoTotal * 100).toFixed(1) : 0;
  const coverPct   = typoTotal > 0 ? (results.covered / typoTotal * 100).toFixed(1) : 0;
  const fpRate     = fpTotal   > 0 ? (results.fp      / fpTotal   * 100).toFixed(1) : 0;
  const avgConf    = results.confidences.length > 0
    ? (results.confidences.reduce((a, b) => a + b, 0) / results.confidences.length).toFixed(4)
    : 0;
  const avgMargin  = results.margins.length > 0
    ? (results.margins.reduce((a, b) => a + b, 0) / results.margins.length).toFixed(4)
    : 0;

  const lines = [];
  lines.push('╔════════════════════════════════════════╗');
  lines.push('║       PHONETIC BENCHMARK REPORT        ║');
  lines.push('╚════════════════════════════════════════╝');
  lines.push('');
  lines.push(`Version:        ${new Date().toISOString()}`);
  lines.push(`Dataset:        ${results.total} pairs (${typoTotal} typos, ${fpTotal} fp checks)`);
  lines.push('');
  lines.push('── ACCURACY ─────────────────────────────');
  lines.push(`Top-1 accuracy: ${results.top1}/${typoTotal} = ${top1Pct}%`);
  lines.push(`Top-3 accuracy: ${results.top3}/${typoTotal} = ${top3Pct}%`);
  lines.push(`Coverage:       ${results.covered}/${typoTotal} = ${coverPct}% (words in phonetic index)`);
  lines.push(`False positives: ${results.fp}/${fpTotal} = ${fpRate}%`);
  lines.push(`False negatives: ${results.fn}/${typoTotal}`);
  lines.push(`Skipped:        ${results.skipped} (no phonetic candidates found)`);
  lines.push('');
  lines.push('── CONFIDENCE ───────────────────────────');
  lines.push(`Avg confidence: ${avgConf}`);
  lines.push(`Avg margin:     ${avgMargin}`);
  lines.push(`Min confidence: ${results.confidences.length ? Math.min(...results.confidences).toFixed(4) : 'N/A'}`);
  lines.push(`Max confidence: ${results.confidences.length ? Math.max(...results.confidences).toFixed(4) : 'N/A'}`);
  lines.push(`Min margin:     ${results.margins.length ? Math.min(...results.margins).toFixed(4) : 'N/A'}`);
  lines.push(`Max margin:     ${results.margins.length ? Math.max(...results.margins).toFixed(4) : 'N/A'}`);
  lines.push('');
  lines.push('── BY CATEGORY ──────────────────────────');
  for (const [cat, data] of Object.entries(results.byCategory)) {
    if (cat === 'fp') continue;
    const catTotal  = data.total;
    const catPct    = catTotal > 0 ? (data.top1    / catTotal * 100).toFixed(0) : 0;
    const covPct    = catTotal > 0 ? (data.covered / catTotal * 100).toFixed(0) : 0;
    lines.push(`  ${cat.padEnd(12)} top1:${data.top1}/${catTotal}=${catPct}%  coverage:${covPct}%`);
  }
  lines.push('');

  if (results.confusion.length > 0) {
    lines.push('── CONFUSION REPORT ─────────────────────');
    for (const c of results.confusion) {
      lines.push(`  [${c.category}] "${c.typo}"`);
      lines.push(`    expected:  ${c.expected}`);
      lines.push(`    predicted: ${c.predicted}${c.runnerUp ? ' (runner-up: ' + c.runnerUp + ')' : ''}`);
      if (c.margin !== null && c.margin !== undefined) {
        lines.push(`    margin:    ${c.margin}`);
      }
      lines.push(`    verdict:   ${c.verdict}`);
    }
  } else {
    lines.push('── CONFUSION REPORT ─────────────────────');
    lines.push('  No errors ✅');
  }

  return lines.join('\n');
}

// ─── SAVE REPORT ──────────────────────────────────────────

function saveReport(report) {
  const dir  = path.join(__dirname, 'benchmarks');
  fs.mkdirSync(dir, { recursive: true });
  const ts   = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `phonetic-${ts}.txt`);
  fs.writeFileSync(file, report);
  return file;
}

// ─── MAIN ─────────────────────────────────────────────────

const results = runBenchmark();
const report  = formatReport(results);

console.log(report);

const file = saveReport(report);
console.log(`\nReport saved → ${file}`);