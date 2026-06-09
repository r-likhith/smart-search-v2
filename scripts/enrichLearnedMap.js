// enrichLearnedMap.js
// Adds prefix completion patterns from CSV analysis to suggestMap ✅
// NOT learnedMap — completions are separate from corrections ✅
// Run: node scripts/enrichLearnedMap.js

require('dotenv').config();
const fs   = require('fs');
const path = require('path');

const CSV_ANALYSIS  = path.join(__dirname, '../csv-analysis.json');
const SUGGEST_MAP   = path.join(__dirname, '../learned/suggestMap.json');

// minimum times pattern must appear to be added ✅
const MIN_COUNT = 200;

// words to skip — too short or ambiguous ✅
const SKIP_TARGETS = new Set([
  'groc','kitc','cotto','shir','wome',
  'kitt','giro','kitch','groce','door m',
  'dry f','t shi','door ma'
]);

function loadJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch(e) {
    return {};
  }
}

function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

async function enrich() {
  console.log('Enriching suggestMap from CSV analysis...\n');

  if (!fs.existsSync(CSV_ANALYSIS)) {
    console.error('❌ csv-analysis.json not found');
    console.error('   Run: node scripts/analyzeCSV2.js first');
    process.exit(1);
  }

  const csvData    = JSON.parse(fs.readFileSync(CSV_ANALYSIS));
  const suggestMap = loadJSON(SUGGEST_MAP);
  const now        = new Date().toISOString();

  const completions = csvData.topCompletions || [];

  let added   = 0;
  let skipped = 0;
  let existed = 0;

  console.log(`Processing ${completions.length} completion patterns...`);
  console.log(`Minimum count threshold: ${MIN_COUNT}\n`);

  for (const [pattern, count] of completions) {
    if (count < MIN_COUNT) continue;

    // parse "source -> target" ✅
    const parts = pattern.split(' -> ');
    if (parts.length !== 2) continue;

    const source = parts[0].trim().toLowerCase();
    const target = parts[1].trim().toLowerCase();

    // skip if target is still partial ✅
    if (SKIP_TARGETS.has(target)) {
      skipped++;
      continue;
    }

    // skip if source too short ✅
    if (source.length < 3) {
      skipped++;
      continue;
    }

    // skip if source === target ✅
    if (source === target) {
      skipped++;
      continue;
    }

    // skip if target shorter than source ✅
    // can't complete to something shorter ✅
    if (target.length <= source.length) {
      skipped++;
      continue;
    }

    // skip if target doesn't START with source ✅
    // these are typo corrections, not completions ✅
    // completions only here ✅
    if (!target.startsWith(source)) {
      skipped++;
      continue;
    }

    // already in suggestMap ✅
    if (suggestMap[source] && suggestMap[source].completion === target) {
      existed++;
      continue;
    }

    // add to suggestMap ✅
    // simple: prefix → completion + metadata ✅
    // no confidence, no hitCount, no lifecycle ✅
    suggestMap[source] = {
      completion: target,
      source:     'csv',
      addedAt:    now
    };

    console.log(`  ✅ Added: "${source}" → "${target}" (${count}x)`);
    added++;
  }

  // save suggestMap only ✅
  // learnedMap untouched ✅
  saveJSON(SUGGEST_MAP, suggestMap);

  console.log('\n─────────────────────────────────');
  console.log('✅ Enrichment complete');
  console.log(`   Added:   ${added} new completions`);
  console.log(`   Existed: ${existed} already present`);
  console.log(`   Skipped: ${skipped} filtered out`);
  console.log(`   Total suggestMap entries: ${Object.keys(suggestMap).length}`);
}

enrich().catch(console.error);