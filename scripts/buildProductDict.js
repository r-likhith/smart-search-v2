// buildProductDict.js
// Builds product dictionary from:
// 1. CSV analysis final search words
// 2. Meilisearch client product names/brands
// Cross-verified: word must appear in 2+ products ✅
// Run: node scripts/buildProductDict.js

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const { MeiliSearch } = require('meilisearch');
const clients = require('../configVendors/clients');

const meili  = new MeiliSearch({ host: 'http://localhost:7700' });
const OUTPUT = path.join(__dirname, '../data/productDict.txt');

async function build() {
  console.log('Building product dictionary...\n');

  const wordFreq = {};

  // ── Step 1: load CSV analysis final search words ─────
  const csvAnalysis = path.join(__dirname, '../csv-analysis.json');
  if (fs.existsSync(csvAnalysis)) {
    const data = JSON.parse(fs.readFileSync(csvAnalysis));
    console.log('Loading CSV domain words...');
    for (const [phrase, freq] of data.topFinalSearches) {
      const words = phrase.toLowerCase().trim().split(/\s+/);
      for (const w of words) {
        if (
          w.length >= 4 &&
          /^[a-z]+$/.test(w) &&
          freq >= 10
        ) {
          wordFreq[w] = (wordFreq[w] || 0) + freq;
        }
      }
    }
    console.log(`CSV final search words loaded: ${Object.keys(wordFreq).length}`);
  } else {
    console.log('ℹ️  No csv-analysis.json — run scripts/analyzeCSV2.js first');
  }

  // ── Step 2: extract from Meilisearch + count per product
  const activeClients = Object.entries(clients)
    .filter(([, c]) => c.active && c.synced);

  console.log(`\nProcessing ${activeClients.length} client indices...`);

  // track how many PRODUCTS each word appears in ✅
  // word must appear in 2+ products to be valid ✅
  const wordProductCount = {};

  for (const [clientId, clientConfig] of activeClients) {
    console.log(`  client_${clientId} — ${clientConfig.name}`);
    try {
      const results = await meili
        .index(clientConfig.meiliIndex)
        .search('', { limit: 1000 });

      for (const hit of results.hits) {
        const fields = [
          hit.name,
          hit.brand,
          hit.category,
          hit.catalogue,
          hit.subcategory
        ].filter(Boolean);

        // collect unique words per product ✅
        const hitWords = new Set();
        for (const field of fields) {
          field.toLowerCase()
            .replace(/[^a-z\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length >= 4 && /^[a-z]+$/.test(w))
            .forEach(w => hitWords.add(w));
        }

        // count unique products per word ✅
        for (const w of hitWords) {
          wordFreq[w] = (wordFreq[w] || 0) + 10;
          wordProductCount[w] = (wordProductCount[w] || 0) + 1;
        }
      }
    } catch(e) {
      console.error(`  Error client_${clientId}: ${e.message}`);
    }
  }

  console.log(`\nTotal vocabulary before filter: ${Object.keys(wordFreq).length}`);
  console.log(`Total product-verified words: ${Object.keys(wordProductCount).length}`);

  // ── Step 3: filter ────────────────────────────────────

  const dictWords = new Set(
    fs.readFileSync(
      path.join(__dirname, '../data/dictionary.txt'), 'utf8'
    )
    .split('\n')
    .map(l => l.split(' ')[0].toLowerCase())
    .filter(Boolean)
  );

  const stopwords = new Set([
    'with','from','that','this','have','will','your',
    'they','them','their','what','when','which','there',
    'been','were','into','than','then','also','some',
    'more','most','over','only','just','like','very',
    'good','best','size','pack','each','free','plus',
    'sets','item','items','unit','type','make','made',
    'used','uses','high','long','wide','full','half',
    'both','done','come','goes','back','need','take',
    'give','keep','find','help','away','dummy','test',
    'misc','miscellaneous','untensils','combo','offer',
    'brand','color','colour','black','white','blue',
    'green','yellow','brown','pink','grey','gray'
  ]);

  const newWords = Object.entries(wordFreq)
    .filter(([w]) =>
      !dictWords.has(w) &&              // not in main dict ✅
      !stopwords.has(w) &&              // not a stopword ✅
      w.length >= 4 &&                  // min 4 chars ✅
      /^[a-z]+$/.test(w) &&            // letters only ✅
      !/(.)\1{2,}/.test(w) &&          // no "aaa" ✅
      (wordProductCount[w] || 0) >= 5   // in 5+ products ✅
    )
    .sort((a, b) => b[1] - a[1]);

  // ── Step 4: save ──────────────────────────────────────
  const lines = newWords.map(([w, f]) => `${w} ${f}`).join('\n');
  fs.writeFileSync(OUTPUT, lines);

  console.log(`\n✅ Product dictionary built`);
  console.log(`   Words in 2+ products: ${newWords.length}`);
  console.log(`   Saved to: data/productDict.txt`);
  console.log('\nTop 30 new words:');
  newWords.slice(0, 30)
    .forEach(([w, f]) => console.log(`  ${w} (${f})`));

  // show by category
  console.log('\nBreakdown by source:');
  console.log(`  From CSV final searches: ${
    newWords.filter(([w]) => wordFreq[w] > wordProductCount[w] * 10).length
  }`);
  console.log(`  From product catalogue: ${
    newWords.filter(([w]) => (wordProductCount[w] || 0) >= 5).length
  } words appear in 5+ products`);
}

build().catch(console.error);