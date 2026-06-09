// fullDictScan.js
// Full scan of all dictionary files and learnedMap
// Run: node scripts/fullDictScan.js

const fs   = require('fs');
const path = require('path');

let issues = 0;
let warnings = 0;

function ok(msg)   { console.log('  ✅', msg); }
function warn(msg) { console.log('  ⚠️ ', msg); warnings++; }
function err(msg)  { console.log('  ❌', msg); issues++; }

// ── 1. learnedMap.json ────────────────────────────────────
console.log('\n── learnedMap.json ──────────────────────────────');
const map = JSON.parse(fs.readFileSync('./learned/learnedMap.json'));
const mapKeys = Object.keys(map);
console.log(`  Total entries: ${mapKeys.length}`);

let nullCorrections   = 0;
let shortSources      = 0;
let selfCorrections   = 0;
let highFailures      = 0;
let missingFields     = 0;
let duplicates        = new Set();

for (const [key, entry] of Object.entries(map)) {
  if (!entry.correction)            { nullCorrections++; err(`null correction: "${key}"`); }
  if (key === entry.correction)     { selfCorrections++; err(`self correction: "${key}"`); }
  if (key.length < 2)               { shortSources++; warn(`very short source: "${key}"`); }
  if (entry.failures > 5)           { highFailures++; warn(`high failures (${entry.failures}): "${key}"`); }
  if (!entry.source)                { missingFields++; warn(`missing source field: "${key}"`); }
  if (duplicates.has(key))          { err(`duplicate key: "${key}"`); }
  duplicates.add(key);
}

nullCorrections === 0   ? ok('no null corrections') : err(`${nullCorrections} null corrections`);
selfCorrections === 0   ? ok('no self corrections') : err(`${selfCorrections} self corrections`);
shortSources === 0      ? ok('no very short sources') : warn(`${shortSources} very short sources`);
highFailures === 0      ? ok('no high failure entries') : warn(`${highFailures} high failure entries`);
missingFields === 0     ? ok('all entries have source field') : warn(`${missingFields} missing source`);

// check chains
let chains = 0;
for (const [key, entry] of Object.entries(map)) {
  if (map[entry.correction]) { chains++; warn(`chain: "${key}" -> "${entry.correction}" -> "${map[entry.correction].correction}"`); }
}
chains === 0 ? ok('no correction chains') : err(`${chains} chains found`);

// source distribution
const sources = {};
for (const entry of Object.values(map)) {
  sources[entry.source] = (sources[entry.source] || 0) + 1;
}
console.log('  Source breakdown:');
Object.entries(sources).sort((a,b) => b[1]-a[1])
  .forEach(([s,c]) => console.log(`    ${s}: ${c}`));

// ── 2. reverseIndex.json ──────────────────────────────────
console.log('\n── reverseIndex.json ────────────────────────────');
const idx = JSON.parse(fs.readFileSync('./learned/reverseIndex.json'));
const idxKeys = Object.keys(idx);
console.log(`  Total entries: ${idxKeys.length}`);

let staleEntries    = 0;
let emptyVariants   = 0;
let mismatchCount   = 0;

for (const [target, data] of Object.entries(idx)) {
  if (!data.variants || data.variants.length === 0) {
    emptyVariants++;
    warn(`empty variants for: "${target}"`);
  }
  for (const variant of (data.variants || [])) {
    if (!map[variant]) {
      staleEntries++;
      warn(`stale variant: "${variant}" -> "${target}" (not in map)`);
    } else if (map[variant].correction !== target) {
      mismatchCount++;
      err(`mismatch: "${variant}" -> map says "${map[variant].correction}" but index says "${target}"`);
    }
  }
}

staleEntries === 0  ? ok('no stale variants') : err(`${staleEntries} stale variants`);
emptyVariants === 0 ? ok('no empty variant lists') : warn(`${emptyVariants} empty variant lists`);
mismatchCount === 0 ? ok('all variants match map') : err(`${mismatchCount} mismatches`);

// coverage check — every map entry should have reverseIndex
let notInIndex = 0;
for (const [key, entry] of Object.entries(map)) {
  const target = entry.correction;
  if (!idx[target]) { notInIndex++; }
  else if (!idx[target].variants.includes(key)) { notInIndex++; }
}
notInIndex === 0
  ? ok('all map entries in reverseIndex')
  : warn(`${notInIndex} map entries missing from reverseIndex`);

// ── 3. dictionary.txt ─────────────────────────────────────
console.log('\n── data/dictionary.txt ──────────────────────────');
const dictLines = fs.readFileSync('./data/dictionary.txt', 'utf8')
  .split('\n').filter(l => l.trim());
console.log(`  Total words: ${dictLines.length}`);

let badFormat    = 0;
let zeroFreq     = 0;
let dupWords     = new Set();
let dupCount     = 0;

for (const line of dictLines) {
  const parts = line.trim().split(' ');
  if (parts.length < 2)          { badFormat++; }
  if (parseInt(parts[1]) === 0)  { zeroFreq++; }
  if (dupWords.has(parts[0]))    { dupCount++; }
  dupWords.add(parts[0]);
}

badFormat === 0 ? ok('all lines have correct format') : warn(`${badFormat} bad format lines`);
zeroFreq === 0  ? ok('no zero frequency words') : warn(`${zeroFreq} zero frequency words`);
dupCount === 0  ? ok('no duplicate words') : warn(`${dupCount} duplicate words`);

// ── 4. dictionary_phrases.txt ─────────────────────────────
console.log('\n── data/dictionary_phrases.txt ──────────────────');
const phraseLines = fs.readFileSync('./data/dictionary_phrases.txt', 'utf8')
  .split('\n').filter(l => l.trim());
console.log(`  Total phrases: ${phraseLines.length}`);

let emptyPhrases  = 0;
let shortPhrases  = 0;
let dupPhrases    = new Set();
let dupPhraseCount = 0;

for (const line of phraseLines) {
  const phrase = line.trim();
  if (!phrase)           { emptyPhrases++; }
  if (phrase.length < 3) { shortPhrases++; }
  if (dupPhrases.has(phrase)) { dupPhraseCount++; }
  dupPhrases.add(phrase);
}

emptyPhrases === 0    ? ok('no empty phrases') : warn(`${emptyPhrases} empty phrases`);
shortPhrases === 0    ? ok('no very short phrases') : warn(`${shortPhrases} very short phrases`);
dupPhraseCount === 0  ? ok('no duplicate phrases') : warn(`${dupPhraseCount} duplicate phrases`);

// ── 5. productDict.txt ────────────────────────────────────
console.log('\n── data/productDict.txt ─────────────────────────');
if (fs.existsSync('./data/productDict.txt')) {
  const prodLines = fs.readFileSync('./data/productDict.txt', 'utf8')
    .split('\n').filter(l => l.trim());
  console.log(`  Total entries: ${prodLines.length}`);

  let badProd   = 0;
  let shortProd = 0;
  let dupProd   = new Set();
  let dupProdCount = 0;

  for (const line of prodLines) {
    const parts = line.trim().split(' ');
    if (parts.length < 2)       { badProd++; }
    if (parts[0]?.length < 4)   { shortProd++; }
    if (dupProd.has(parts[0]))  { dupProdCount++; }
    dupProd.add(parts[0]);
  }

  badProd === 0      ? ok('all entries have correct format') : warn(`${badProd} bad format`);
  shortProd === 0    ? ok('no very short words') : warn(`${shortProd} very short words`);
  dupProdCount === 0 ? ok('no duplicates') : warn(`${dupProdCount} duplicates`);

  // check overlap with main dictionary
  const mainDict = new Set(
    fs.readFileSync('./data/dictionary.txt', 'utf8')
      .split('\n').map(l => l.split(' ')[0]).filter(Boolean)
  );
  let overlap = 0;
  for (const line of prodLines) {
    if (mainDict.has(line.split(' ')[0])) overlap++;
  }
  overlap === 0
    ? ok('no overlap with main dictionary')
    : warn(`${overlap} words also in main dictionary (redundant)`);
} else {
  warn('productDict.txt not found — run scripts/buildProductDict.js');
}

// ── Summary ───────────────────────────────────────────────
console.log('\n─────────────────────────────────────────────────');
console.log(`Issues:   ${issues}`);
console.log(`Warnings: ${warnings}`);
if (issues === 0 && warnings === 0) {
  console.log('✅ All clean — no issues found');
} else if (issues === 0) {
  console.log('✅ No critical issues — review warnings above');
} else {
  console.log('❌ Critical issues found — fix before production');
}
