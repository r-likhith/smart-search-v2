require('dotenv').config({ path: '../.env' });
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

// ─── CONFIG ───────────────────────────────────────────────
const EXCEL_FILE = path.join(__dirname, '../products_latest_export.xlsx');
const OUTPUT_FILE = path.join(__dirname, '../data/categories.js');

// ─── STOPWORDS ────────────────────────────────────────────
const STOPWORDS = new Set([
  'with', 'from', 'that', 'this', 'have', 'your',
  'will', 'been', 'were', 'they', 'them', 'then',
  'than', 'when', 'what', 'which', 'while', 'also',
  'into', 'over', 'after', 'more', 'other', 'some',
  'such', 'only', 'both', 'each', 'most', 'very',
  'made', 'make', 'like', 'just', 'used', 'uses',
  'ideal', 'perfect', 'great', 'good', 'best',
  'women', 'mens', 'ladies', 'girls', 'boys'
]);

// ─── HELPERS ──────────────────────────────────────────────

function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '_');
}

function cleanText(text) {
  if (!text) return '';
  return String(text)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeRow(row) {
  const newRow = {};
  for (const key in row) {
    newRow[key.toLowerCase().trim()] = row[key];
  }
  return newRow;
}

function extractTags(text) {
  if (!text) return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s,]/g, '')
    .split(/[\s,]+/)
    .filter(w => w.length > 3 && !STOPWORDS.has(w))
    .filter(w => /^[a-z]+$/.test(w));
}

// ─── MAIN ─────────────────────────────────────────────────

async function extractCategories() {
  try {
    console.log('\n--- Category Extraction Started ---\n');

    // Step 1 — read Excel file
    console.log('Reading Excel file...');
    const workbook = XLSX.readFile(EXCEL_FILE);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rawRows = XLSX.utils.sheet_to_json(sheet);
    console.log(`Found ${rawRows.length} rows`);

    // Step 2 — build 4-level hierarchy
    const hierarchy = {};
    let skipped = 0;

    for (const rawRow of rawRows) {
      const row = normalizeRow(rawRow);

      const l1 = cleanText(row['category l1 name']);
      const l2 = cleanText(row['category l2 name']);
      const l3 = cleanText(row['category l3 name']);
      const l4 = cleanText(row['category l4 name']);
      const searchKeys = cleanText(row['search keys'] || '');
      const title = cleanText(row['title'] || '');
      const price = parseFloat(row['sale price']) || 0;

      if (!l1 || !l2) { skipped++; continue; }

      // ── L1 ──
      if (!hierarchy[l1]) {
        hierarchy[l1] = {
          id: `cat_${slugify(l1)}`,
          name: l1,
          subcategories: {}
        };
      }

      // ── L2 ──
      if (!hierarchy[l1].subcategories[l2]) {
        hierarchy[l1].subcategories[l2] = {
          id: `cat_${slugify(l1)}_${slugify(l2)}`,
          name: l2,
          subcategories: {}
        };
      }

      if (!l3) continue;

      // ── L3 ──
      if (!hierarchy[l1].subcategories[l2].subcategories[l3]) {
        hierarchy[l1].subcategories[l2].subcategories[l3] = {
          id: `cat_${slugify(l1)}_${slugify(l2)}_${slugify(l3)}`,
          name: l3,
          subcategories: {},
          tags: new Set(),
          count: 0,
          minPrice: Infinity,
          maxPrice: 0
        };
      }

      const l3Data = hierarchy[l1].subcategories[l2].subcategories[l3];
      l3Data.count++;

      // price range
      if (price > 0) {
        l3Data.minPrice = Math.min(l3Data.minPrice, price);
        l3Data.maxPrice = Math.max(l3Data.maxPrice, price);
      }

      // tags from search keys (better than description)
      if (searchKeys) {
        extractTags(searchKeys).forEach(w => l3Data.tags.add(w));
      }

      // ── L4 ──
      if (!l4) continue;

      if (!l3Data.subcategories[l4]) {
        l3Data.subcategories[l4] = {
          id: `cat_${slugify(l1)}_${slugify(l2)}_${slugify(l3)}_${slugify(l4)}`,
          name: l4,
          tags: new Set(),
          count: 0,
          minPrice: Infinity,
          maxPrice: 0
        };
      }

      const l4Data = l3Data.subcategories[l4];
      l4Data.count++;

      if (price > 0) {
        l4Data.minPrice = Math.min(l4Data.minPrice, price);
        l4Data.maxPrice = Math.max(l4Data.maxPrice, price);
      }

      if (searchKeys) {
        extractTags(searchKeys).forEach(w => l4Data.tags.add(w));
      }
    }

    // Step 3 — convert Sets + fix infinity prices
    for (const l1 of Object.values(hierarchy)) {
      for (const l2 of Object.values(l1.subcategories)) {
        for (const l3 of Object.values(l2.subcategories)) {
          l3.tags = [...l3.tags].slice(0, 20);
          if (l3.minPrice === Infinity) l3.minPrice = 0;

          for (const l4 of Object.values(l3.subcategories)) {
            l4.tags = [...l4.tags].slice(0, 20);
            if (l4.minPrice === Infinity) l4.minPrice = 0;
          }
        }
      }
    }

    // Step 4 — build flat categories (L3 + L4)
    const flatCategories = [];

    for (const [l1Name, l1Data] of Object.entries(hierarchy)) {
      for (const [l2Name, l2Data] of Object.entries(l1Data.subcategories)) {
        for (const [l3Name, l3Data] of Object.entries(l2Data.subcategories)) {

          // add L3
          flatCategories.push({
            id: l3Data.id,
            name: l3Name,
            parent: l2Name,
            grandparent: l1Name,
            level: 'L3',
            path: `${l1Name} > ${l2Name} > ${l3Name}`,
            tags: l3Data.tags,
            productCount: l3Data.count,
            minPrice: l3Data.minPrice,
            maxPrice: l3Data.maxPrice,
            type: 'category'
          });

          // add L4
          for (const [l4Name, l4Data] of Object.entries(l3Data.subcategories)) {
            flatCategories.push({
              id: l4Data.id,
              name: l4Name,
              parent: l3Name,
              grandparent: l2Name,
              greatGrandparent: l1Name,
              level: 'L4',
              path: `${l1Name} > ${l2Name} > ${l3Name} > ${l4Name}`,
              tags: l4Data.tags,
              productCount: l4Data.count,
              minPrice: l4Data.minPrice,
              maxPrice: l4Data.maxPrice,
              type: 'category'
            });
          }
        }
      }
    }

    // Step 5 — stats
    const l1Count = Object.keys(hierarchy).length;
    const l2Count = Object.values(hierarchy)
      .reduce((a, l1) => a + Object.keys(l1.subcategories).length, 0);
    const l3Count = flatCategories.filter(c => c.level === 'L3').length;
    const l4Count = flatCategories.filter(c => c.level === 'L4').length;
    const totalMapped = flatCategories
      .filter(c => c.level === 'L3')
      .reduce((a, c) => a + c.productCount, 0);

    console.log(`\nExtracted:`);
    console.log(`→ L1 categories: ${l1Count}`);
    console.log(`→ L2 categories: ${l2Count}`);
    console.log(`→ L3 categories: ${l3Count}`);
    console.log(`→ L4 categories: ${l4Count}`);
    console.log(`→ Total flat: ${flatCategories.length}`);
    console.log(`→ Products mapped: ${totalMapped}`);
    console.log(`→ Skipped rows: ${skipped}`);

    // Step 6 — write output
    const output = `// Auto generated from Excel — do not edit manually
// Run scripts/extractCategories.js to regenerate
// Generated: ${new Date().toISOString()}

const categories = ${JSON.stringify(hierarchy, null, 2)};

function getFlatCategories() {
  return ${JSON.stringify(flatCategories, null, 2)};
}

module.exports = { categories, getFlatCategories };
`;

    const dataDir = path.join(__dirname, '../data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

    fs.writeFileSync(OUTPUT_FILE, output);

    console.log(`\n✅ categories.js written to data/`);
    console.log('\n--- Extraction Complete ---\n');

  } catch (err) {
    console.error('Extraction failed:', err.message);
    process.exit(1);
  }
}

extractCategories();

































// require('dotenv').config({ path: '../.env' });
// const XLSX = require('xlsx');
// const fs = require('fs');
// const path = require('path');

// // ─── CONFIG ───────────────────────────────────────────────
// const EXCEL_FILE = path.join(__dirname, '../products_export.xlsx');
// const OUTPUT_FILE = path.join(__dirname, '../data/categories.js');

// // ─── STOPWORDS ────────────────────────────────────────────
// const STOPWORDS = new Set([
//   'with', 'from', 'that', 'this', 'have', 'your',
//   'will', 'been', 'were', 'they', 'them', 'then',
//   'than', 'when', 'what', 'which', 'while', 'also',
//   'into', 'over', 'after', 'more', 'other', 'some',
//   'such', 'only', 'both', 'each', 'most', 'very',
//   'made', 'make', 'like', 'just', 'used', 'uses',
//   'ideal', 'perfect', 'great', 'good', 'best'
// ]);

// // ─── HELPERS ──────────────────────────────────────────────

// function slugify(text) {
//   return text
//     .toLowerCase()
//     .trim()
//     .replace(/[^a-z0-9\s]/g, '')
//     .replace(/\s+/g, '_');
// }

// function cleanText(text) {
//   if (!text) return '';
//   return String(text)
//     .replace(/<[^>]*>/g, ' ')   // remove HTML tags
//     .replace(/&nbsp;/g, ' ')
//     .replace(/\s+/g, ' ')
//     .trim();
// }

// // Fix 4 — normalize all row keys to lowercase
// function normalizeRow(row) {
//   const newRow = {};
//   for (const key in row) {
//     newRow[key.toLowerCase().trim()] = row[key];
//   }
//   return newRow;
// }

// // Fix 2 — improved tag extraction with stopwords
// function extractTags(text) {
//   if (!text) return [];
//   return text
//     .toLowerCase()
//     .replace(/[^a-z0-9\s]/g, '')
//     .split(' ')
//     .filter(w => w.length > 3 && !STOPWORDS.has(w))
//     .filter(w => /^[a-z]+$/.test(w));
// }

// // ─── MAIN ─────────────────────────────────────────────────

// async function extractCategories() {
//   try {
//     console.log('\n--- Category Extraction Started ---\n');

//     // Step 1 — read Excel file
//     console.log('Reading Excel file...');
//     const workbook = XLSX.readFile(EXCEL_FILE);
//     const sheetName = workbook.SheetNames[0];
//     const sheet = workbook.Sheets[sheetName];
//     const rawRows = XLSX.utils.sheet_to_json(sheet);
//     console.log(`Found ${rawRows.length} rows`);

//     // Step 2 — extract unique categories
//     const hierarchy = {};

//     for (const rawRow of rawRows) {
//       // Fix 4 — normalize keys
//       const row = normalizeRow(rawRow);

//       const l1 = cleanText(row['category l1 name']);
//       const l2 = cleanText(row['category l2 name']);
//       const l3 = cleanText(row['category l3 name']);
//       const name = cleanText(row['display name of product']);
//       const desc = cleanText(row['description']);

//       if (!l1) continue;

//       // initialise L1
//       if (!hierarchy[l1]) {
//         hierarchy[l1] = {
//           id: `cat_${slugify(l1)}`,
//           subcategories: {}
//         };
//       }

//       if (!l2) continue;

//       // initialise L2
//       if (!hierarchy[l1].subcategories[l2]) {
//         hierarchy[l1].subcategories[l2] = {
//           id: `cat_${slugify(l1)}_${slugify(l2)}`,
//           subcategories: {}
//         };
//       }

//       if (!l3) continue;

//       // initialise L3
//       if (!hierarchy[l1].subcategories[l2].subcategories[l3]) {
//         hierarchy[l1].subcategories[l2].subcategories[l3] = {
//           // Fix 1 — unique ID using full hierarchy
//           id: `cat_${slugify(l1)}_${slugify(l2)}_${slugify(l3)}`,
//           tags: new Set(),
//           count: 0
//         };
//       }

//       const l3Data = hierarchy[l1].subcategories[l2].subcategories[l3];

//       // Fix 5 — increment product count
//       l3Data.count++;

//       // Fix 3 — extract tags from name AND description
//       if (name) {
//         extractTags(name).forEach(w => l3Data.tags.add(w));
//       }
//       if (desc) {
//         extractTags(desc).forEach(w => l3Data.tags.add(w));
//       }
//     }

//     // Step 3 — convert Sets to arrays
//     for (const l1 of Object.values(hierarchy)) {
//       for (const l2 of Object.values(l1.subcategories)) {
//         for (const l3 of Object.values(l2.subcategories)) {
//           l3.tags = [...l3.tags].slice(0, 20);
//         }
//       }
//     }

//     // Step 4 — build flat categories for Meilisearch
//     const flatCategories = [];

//     for (const [l1Name, l1Data] of Object.entries(hierarchy)) {
//       for (const [l2Name, l2Data] of Object.entries(l1Data.subcategories)) {
//         for (const [l3Name, l3Data] of Object.entries(l2Data.subcategories)) {
//           flatCategories.push({
//             id: l3Data.id,
//             name: l3Name,
//             parent: l2Name,
//             grandparent: l1Name,
//             // Fix 6 — hierarchy path
//             path: `${l1Name} > ${l2Name} > ${l3Name}`,
//             tags: l3Data.tags,
//             // Fix 5 — real product count
//             productCount: l3Data.count || 0,
//             type: 'category'
//           });
//         }
//       }
//     }

//     console.log(`\nExtracted:`);
//     console.log(`→ L1 categories: ${Object.keys(hierarchy).length}`);
//     console.log(`→ Total L3 categories: ${flatCategories.length}`);
//     console.log(`→ Total products mapped: ${flatCategories.reduce((a, c) => a + c.productCount, 0)}`);

//     // Step 5 — write to data/categories.js
//     const output = `// Auto generated from Excel — do not edit manually
// // Run scripts/extractCategories.js to regenerate

// const categories = ${JSON.stringify(hierarchy, null, 2)};

// function getFlatCategories() {
//   return ${JSON.stringify(flatCategories, null, 2)};
// }

// module.exports = { categories, getFlatCategories };
// `;

//     // create data folder if not exists
//     const dataDir = path.join(__dirname, '../data');
//     if (!fs.existsSync(dataDir)) {
//       fs.mkdirSync(dataDir);
//     }

//     fs.writeFileSync(OUTPUT_FILE, output);
//     console.log(`\n✅ categories.js written to data/`);
//     console.log('\n--- Extraction Complete ---\n');

//   } catch (err) {
//     console.error('Extraction failed:', err.message);
//     process.exit(1);
//   }
// }

// extractCategories();