require('dotenv').config({ path: '../.env' });
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

// ─── CONFIG ───────────────────────────────────────────────
const EXCEL_FILE = path.join(__dirname, '../products_latest_export.xlsx');
const OUTPUT_FILE = path.join(__dirname, '../data/dictionary.txt');
const PHRASES_FILE = path.join(__dirname, '../data/dictionary_phrases.txt');

// ─── SHORT WORDS ALLOWLIST ────────────────────────────────
// size terms critical for fashion search
const ALLOWED_SHORT_WORDS = new Set([
  'xl', 'xxl', 'xxxl', 'xs', 's', 'm', 'l'
]);

// ─── NOISE WORDS ─────────────────────────────────────────
// functional words with zero spell-correction value
// these appear millions of times but never searched alone
const NOISE_WORDS = new Set([
  'for', 'and', 'the', 'with', 'from', 'that', 'this',
  'are', 'was', 'has', 'its', 'our', 'get', 'all',
  'new', 'add', 'can', 'not', 'too', 'but', 'out'
]);

// ─── HELPERS ──────────────────────────────────────────────

function cleanText(text) {
  if (!text) return '';
  return String(text)
    .replace(/<[^>]*>/g, ' ')
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function normalizeRow(row) {
  const newRow = {};
  for (const key in row) {
    newRow[key.toLowerCase().trim()] = row[key];
  }
  return newRow;
}

function extractWords(text) {
  return cleanText(text)
    .split(' ')
    .filter(w =>
      (w.length >= 2 || ALLOWED_SHORT_WORDS.has(w)) &&
      !NOISE_WORDS.has(w)
    )
    .filter(w => /^[a-z]+$/.test(w));
}

function isCleanPhrase(phrase) {
  // letters and spaces only
  if (!/^[a-z\s]+$/.test(phrase)) return false;

  const words = phrase.split(' ').filter(w => w.length > 0);

  // min 2 words, max 5 words
  if (words.length < 2) return false;
  if (words.length > 5) return false;

  // min 8 chars total
  if (phrase.length < 8) return false;

  // max 60 chars total
  if (phrase.length > 60) return false;

  // every word must be at least 2 chars
  if (words.some(w => w.length < 2)) return false;

  // first word must be at least 3 chars
  // prevents "a line", "b grade" type garbage
  if (words[0].length < 3) return false;

  // reject if starts with noise word
  if (NOISE_WORDS.has(words[0])) return false;

  return true;
}

// ─── MAIN ─────────────────────────────────────────────────

async function buildDictionary() {
  try {
    console.log('\n--- Dictionary Builder Started ---\n');

    // Step 1 — read Excel
    console.log('Reading Excel file...');
    const workbook = XLSX.readFile(EXCEL_FILE);
    const sheet = workbook.Sheets['Products'];
    const rawRows = XLSX.utils.sheet_to_json(sheet);
    console.log(`Found ${rawRows.length} rows\n`);

    // Step 2 — extract words + phrases
    console.log('Extracting words and phrases...');
    const wordFreq = new Map();
    const phrases = new Set();

    for (const rawRow of rawRows) {
      const row = normalizeRow(rawRow);

      // ── boosted word sources ──────────────────────────
      const sources = [
        { text: row['title'] || '',                boost: 1  },
        { text: row['category l1 name'] || '',     boost: 10 },
        { text: row['category l2 name'] || '',     boost: 10 },
        { text: row['category l3 name'] || '',     boost: 10 },
        { text: row['category l4 name'] || '',     boost: 10 },
        { text: row['brand name'] || '',           boost: 5  },
        { text: row['search keys'] || '',          boost: 5  },
        { text: row['description'] || '',          boost: 1  },
        { text: row['color'] || '',                boost: 3  },
        { text: row['size'] || '',                 boost: 3  }
      ];

      for (const { text, boost } of sources) {
        const words = extractWords(text);
        for (const word of words) {
          wordFreq.set(word, (wordFreq.get(word) || 0) + boost);
        }
      }

      // ── phrases from Search Keys ONLY ─────────────────
      // description excluded — too much HTML noise
      const searchKeys = String(row['search keys'] || '')
        .split(',')
        .map(k => k.trim().toLowerCase())
        .filter(k => k.length >= 3);

      for (const key of searchKeys) {
        // boost individual words
        extractWords(key).forEach(w => {
          wordFreq.set(w, (wordFreq.get(w) || 0) + 5);
        });

        // only add clean multi-word phrases
        if (isCleanPhrase(key)) {
          phrases.add(key);
        }
      }
    }

    console.log(`Extracted ${wordFreq.size} unique words`);
    console.log(`Extracted ${phrases.size} unique phrases\n`);

    // Step 3 — filter low frequency words
    const filtered = [...wordFreq.entries()]
      .filter(([word, freq]) => freq >= 2)
      .sort((a, b) => b[1] - a[1]);

    console.log(`After filtering (min freq 2): ${filtered.length} words\n`);

    // Step 4 — write main dictionary
    const dataDir = path.join(__dirname, '../data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

    const lines = filtered.map(([word, freq]) => `${word} ${freq}`);
    fs.writeFileSync(OUTPUT_FILE, lines.join('\n'));
    console.log(`✅ Dictionary written: ${filtered.length} words`);
    console.log(`📁 Location: data/dictionary.txt`);

    // Step 5 — write phrase dictionary
    const uniquePhrases = [...phrases].sort();
    fs.writeFileSync(PHRASES_FILE, uniquePhrases.join('\n'));
    console.log(`✅ Phrases written: ${uniquePhrases.length} phrases`);
    console.log(`📁 Location: data/dictionary_phrases.txt`);

    // Step 6 — show top 30 words
    console.log('\nTop 30 most frequent words:');
    filtered.slice(0, 30).forEach(([word, freq], i) => {
      console.log(`  ${i + 1}. ${word} (${freq})`);
    });

    // Step 7 — show sample phrases
    console.log('\nSample phrases (first 20):');
    uniquePhrases.slice(0, 20).forEach((phrase, i) => {
      console.log(`  ${i + 1}. ${phrase}`);
    });

    // Step 8 — stats summary
    console.log('\n--- Stats Summary ---');
    console.log(`Total rows processed:  ${rawRows.length}`);
    console.log(`Unique words found:    ${wordFreq.size}`);
    console.log(`Words after filter:    ${filtered.length}`);
    console.log(`Unique phrases:        ${uniquePhrases.length}`);
    console.log(`Top word frequency:    ${filtered[0][1].toLocaleString()}`);
    console.log(`Min word frequency:    ${filtered[filtered.length - 1][1]}`);

    console.log('\n--- Dictionary Build Complete ---\n');

  } catch (err) {
    console.error('Dictionary build failed:', err.message);
    process.exit(1);
  }
}

buildDictionary();