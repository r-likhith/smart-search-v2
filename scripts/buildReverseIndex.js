const fs = require('fs');
const path = require('path');
const { normalise } = require('../src/query/normalise');

const MAP_FILE = path.join(__dirname, '../learned/learnedMap.json');
const INDEX_FILE = path.join(__dirname, '../learned/reverseIndex.json');

// max variants per correct word
const MAX_VARIANTS = 20;

function buildReverseIndex() {
  try {
    console.log('\n--- Building Reverse Index ---\n');

    // read learned map
    const raw = fs.readFileSync(MAP_FILE, 'utf8');
    const learnedMap = JSON.parse(raw);

    const reverseIndex = {};

    // Pass 1 — build index
    for (const [wrongWord, entry] of Object.entries(learnedMap)) {
      // Fix 3 — normalise correct word key
      const correctWord = normalise(entry.correction);
      if (!correctWord) continue;

      const count = entry.count || 1;
      const confidence = entry.confidence || 0.75;

      if (!reverseIndex[correctWord]) {
        reverseIndex[correctWord] = {
          variants: [],
          totalVariants: 0,
          // Fix 1 — track total count
          totalCount: 0,
          // weighted sum for confidence calculation
          _weightedConfidenceSum: 0,
          confidence: 0,
          // Fix 5 — sources as set
          sources: new Set()
        };
      }

      const entry2 = reverseIndex[correctWord];

      // add variant if not already there
      if (!entry2.variants.find(v => v.word === wrongWord)) {
        entry2.variants.push({
          word: wrongWord,
          count,
          confidence
        });
        entry2.totalVariants++;
      }

      // Fix 1 — accumulate count
      entry2.totalCount += count;

      // Fix 2 — weighted confidence sum
      entry2._weightedConfidenceSum += confidence * count;

      // Fix 5 — collect sources
      if (entry.source) entry2.sources.add(entry.source);
    }

    // Pass 2 — finalise entries
    for (const [correctWord, data] of Object.entries(reverseIndex)) {
      // Fix 2 — weighted confidence
      data.confidence = parseFloat(
        (data._weightedConfidenceSum / data.totalCount).toFixed(3)
      );
      delete data._weightedConfidenceSum;

      // Fix 4 — sort variants by frequency
      data.variants.sort((a, b) => b.count - a.count);

      // Fix 6 — cap at MAX_VARIANTS
      data.variants = data.variants.slice(0, MAX_VARIANTS);

      // Fix 5 — convert Set to array
      data.sources = [...data.sources];

      // clean variant structure for output
      data.variants = data.variants.map(v => v.word);
    }

    // sort by totalCount descending
    const sorted = Object.entries(reverseIndex)
      .sort((a, b) => b[1].totalCount - a[1].totalCount)
      .reduce((acc, [k, v]) => {
        acc[k] = v;
        return acc;
      }, {});

    // write reverse index
    fs.writeFileSync(INDEX_FILE, JSON.stringify(sorted, null, 2));

    console.log(`✅ Reverse index built`);
    console.log(`→ Correct words:  ${Object.keys(sorted).length}`);
    console.log(`→ Total variants: ${Object.values(sorted)
      .reduce((a, c) => a + c.totalVariants, 0)}`);
    console.log(`→ Total count:    ${Object.values(sorted)
      .reduce((a, c) => a + c.totalCount, 0)}`);

    console.log('\nTop 5 entries by variant count:');
    Object.entries(sorted)
      .sort((a, b) => b[1].totalVariants - a[1].totalVariants)
      .slice(0, 5)
      .forEach(([word, data]) => {
        console.log(`  "${word}"`);
        console.log(`    variants:   [${data.variants.join(', ')}]`);
        console.log(`    confidence: ${data.confidence}`);
        console.log(`    count:      ${data.totalCount}`);
        console.log(`    sources:    [${data.sources.join(', ')}]`);
      });

    console.log('\n--- Done ---\n');

  } catch (err) {
    console.error('Failed:', err.message);
    process.exit(1);
  }
}

buildReverseIndex();