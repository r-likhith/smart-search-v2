require('dotenv').config({ path: '../.env' });
const XLSX = require('xlsx');
const path = require('path');
const { MeiliSearch } = require('meilisearch');
const { createIndexes } = require('../src/meilisearch/indexes');

// ─── CONFIG ───────────────────────────────────────────────
const EXCEL_FILE = path.join(__dirname, '../products_latest_export.xlsx');
const BATCH_SIZE = 500;

const client = new MeiliSearch({
  host: process.env.MEILI_HOST || 'http://localhost:7700',
  apiKey: process.env.MEILI_MASTER_KEY || 'masterKey123'
});

// ─── HELPERS ──────────────────────────────────────────────

function cleanText(text) {
  if (!text) return '';
  return String(text)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
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

function cleanTitle(title) {
  if (!title) return '';
  // strip SKU appended at end of title
  // e.g. "Rayon Embroidered Kurti 000065L40DARGRE2" → "Rayon Embroidered Kurti"
  return cleanText(title)
    .replace(/\s+[A-Z0-9]{6,}$/, '')
    .trim();
}

function cleanSearchKeys(searchKeys) {
  if (!searchKeys) return [];
  return String(searchKeys)
    .split(',')
    .map(k => k.trim().toLowerCase())
    .filter(k => k.length > 1)
    .slice(0, 30); // cap at 30 keywords
}

function buildSearchText(name, description, l1, l2, l3, l4, brand, searchKeys, size, color) {
  const parts = [
    name,
    l1, l2, l3, l4,
    brand,
    size,
    color,
    searchKeys.join(' '),
    description.slice(0, 200) // partial description for search
  ].filter(Boolean);

  return parts.join(' ').toLowerCase();
}

function mapRow(row) {
  const r = normalizeRow(row);

  // ── required fields ──
  const sku = cleanText(r['sku']);
  const rawTitle = cleanText(r['title']);
  const l1 = cleanText(r['category l1 name']);
  const l2 = cleanText(r['category l2 name']);

  if (!sku || !rawTitle || !l1) return null;

  // ── clean fields ──
  const name = cleanTitle(rawTitle);
  const l3 = cleanText(r['category l3 name']) || null;
  const l4 = cleanText(r['category l4 name']) || null;
  const brand = cleanText(r['brand name']) || null;
  const description = cleanText(r['description']) || '';
  const size = cleanText(r['size']) || null;
  const color = cleanText(r['color']) || null;
  const price = parseFloat(r['sale price']) || 0;
  const searchKeys = cleanSearchKeys(r['search keys'] || '');

  // ── build search text ──
  const searchText = buildSearchText(
    name, description, l1, l2, l3, l4,
    brand, searchKeys, size, color
  );

  return {
    id: `prod_${sku}`,           // unique per variant
    sku,
    name,
    description,
    catalogue: l1,
    category: l2,
    subcategory: l3,
    subCategory: l4,             // new L4 level
    brand,
    size,
    color,
    price,
    searchKeys,                  // indexed for search
    searchText,                  // full text search field
    popularity: 0,
    sales: 0
  };
}

// ─── PROGRESS ─────────────────────────────────────────────

function showProgress(indexed, total, failed) {
  const percent = Math.floor((indexed / total) * 100);
  const bar = '█'.repeat(Math.floor(percent / 5)) +
              '░'.repeat(20 - Math.floor(percent / 5));
  process.stdout.write(
    `\r[${bar}] ${percent}% | Indexed: ${indexed} | Failed: ${failed} | Total: ${total}`
  );
}

// ─── MAIN ─────────────────────────────────────────────────

async function importProducts() {
  try {
    console.log('\n--- Import Started ---\n');

    // Step 1 — setup indexes
    console.log('Setting up Meilisearch indexes...');
    await createIndexes();
    console.log('Indexes ready\n');

    // Step 2 — read Excel (Products sheet only)
    console.log('Reading Excel file...');
    const workbook = XLSX.readFile(EXCEL_FILE);
    const sheet = workbook.Sheets['Products'];
    if (!sheet) {
      console.error('❌ Products sheet not found!');
      process.exit(1);
    }
    const rawRows = XLSX.utils.sheet_to_json(sheet);
    console.log(`Found ${rawRows.length} rows in Products sheet\n`);

    // Step 3 — map products
    // NO deduplication — each row is unique variant
    console.log('Mapping products...');
    const products = [];
    let invalid = 0;
    const skuSeen = new Set();
    let dupSku = 0;

    for (const rawRow of rawRows) {
      const product = mapRow(rawRow);

      if (!product) {
        invalid++;
        continue;
      }

      // only skip if truly same SKU (data error)
      if (skuSeen.has(product.sku)) {
        dupSku++;
        continue;
      }

      skuSeen.add(product.sku);
      products.push(product);
    }

    console.log(`✅ Valid products:    ${products.length}`);
    console.log(`⚠️  Invalid rows:     ${invalid}`);
    console.log(`🔁 Duplicate SKUs:   ${dupSku}\n`);

    // Step 4 — clear old index first
    console.log('Clearing old products index...');
    try {
      await client.index('products').deleteAllDocuments();
      console.log('Old products cleared ✅\n');
    } catch (err) {
      console.warn('Could not clear old index:', err.message);
    }

    // Step 5 — index products in batches
    console.log('Indexing products into Meilisearch...\n');
    let indexed = 0;
    let failed = 0;

    for (let i = 0; i < products.length; i += BATCH_SIZE) {
      const batch = products.slice(i, i + BATCH_SIZE);

      try {
        await client.index('products').addDocuments(batch);
        indexed += batch.length;
      } catch (err) {
        failed += batch.length;
        console.error(`\nBatch ${Math.floor(i / BATCH_SIZE) + 1} failed:`, err.message);
      }

      showProgress(indexed, products.length, failed);
    }

    // Step 6 — index categories
    console.log('\n\nIndexing categories...');
    let categoriesIndexed = 0;
    try {
      const { getFlatCategories } = require('../data/categories');
      const cats = getFlatCategories();

      // clear old categories
      await client.index('categories').deleteAllDocuments();

      await client.index('categories').addDocuments(cats);
      categoriesIndexed = cats.length;
      console.log(`✅ Categories indexed: ${categoriesIndexed}`);
    } catch (err) {
      console.error('❌ Category indexing failed:', err.message);
    }

    // Step 7 — summary
    console.log('\n--- Import Complete ---');
    console.log(`✅ Products indexed:  ${indexed}`);
    console.log(`❌ Products failed:   ${failed}`);
    console.log(`📁 Categories:        ${categoriesIndexed}`);
    console.log(`📦 Total variants:    ${products.length}`);
    console.log(`🔁 Duplicate SKUs:    ${dupSku}`);
    console.log(`⚠️  Invalid rows:      ${invalid}`);
    console.log(`📊 Raw rows:          ${rawRows.length}`);

    // Step 8 — sample output
    console.log('\n--- Sample Product ---');
    console.log(JSON.stringify(products[0], null, 2));

  } catch (err) {
    console.error('Import failed:', err.message);
    process.exit(1);
  }
}

importProducts();





























// require('dotenv').config({ path: '../.env' });
// const XLSX = require('xlsx');
// const path = require('path');
// const { MeiliSearch } = require('meilisearch');
// const { createIndexes } = require('../src/meilisearch/indexes');

// // ─── CONFIG ───────────────────────────────────────────────
// const EXCEL_FILE = path.join(__dirname, '../products_export.xlsx');
// const BATCH_SIZE = 500;

// const client = new MeiliSearch({
//   host: process.env.MEILI_HOST || 'http://localhost:7700',
//   apiKey: process.env.MEILI_MASTER_KEY || 'masterKey123'
// });

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

// function cleanText(text) {
//   if (!text) return '';
//   return String(text)
//     .replace(/<[^>]*>/g, ' ')
//     .replace(/&nbsp;/g, ' ')
//     .replace(/&amp;/g, '&')
//     .replace(/&lt;/g, '<')
//     .replace(/&gt;/g, '>')
//     .replace(/\s+/g, ' ')
//     .trim();
// }

// function normalizeRow(row) {
//   const newRow = {};
//   for (const key in row) {
//     newRow[key.toLowerCase().trim()] = row[key];
//   }
//   return newRow;
// }

// function slugify(text) {
//   if (!text) return '';
//   return text
//     .toLowerCase()
//     .trim()
//     .replace(/[^a-z0-9\s]/g, '')
//     .replace(/\s+/g, '_');
// }

// function generateId(name, l1, l2, l3) {
//   const base = `${slugify(l1)}_${slugify(l2)}_${slugify(l3)}_${slugify(name)}`;
//   return `prod_${base}`.slice(0, 200);
// }

// function extractTags(name, description) {
//   const text = `${name} ${description}`;
//   return text
//     .toLowerCase()
//     .replace(/[^a-z0-9\s]/g, '')
//     .split(' ')
//     .filter(w => w.length > 3 && !STOPWORDS.has(w))
//     .filter(w => /^[a-z]+$/.test(w))
//     .slice(0, 15);
// }

// function mapRow(row) {
//   const r = normalizeRow(row);

//   const l1 = cleanText(r['category l1 name']);
//   const l2 = cleanText(r['category l2 name']);
//   const l3 = cleanText(r['category l3 name']);
//   const name = cleanText(r['display name']);
//   const description = cleanText(r['description']);

//   if (!name || !l1) return null;

//   const tags = extractTags(name, description);

//   return {
//     id: generateId(name, l1, l2 || '', l3 || ''),
//     name,
//     description,
//     catalogue: l1,
//     category: l2 || null,
//     subcategory: l3 || null,
//     brand: '',
//     tags,
//     searchText: `${name} ${description} ${l1} ${l2 || ''} ${l3 || ''} ${tags.join(' ')}`,
//     price: 0,
//     popularity: 0,
//     sales: 0
//   };
// }

// // ─── PROGRESS TRACKER ─────────────────────────────────────

// function showProgress(indexed, total, failed) {
//   const percent = Math.floor((indexed / total) * 100);
//   const bar = '█'.repeat(Math.floor(percent / 5)) +
//               '░'.repeat(20 - Math.floor(percent / 5));
//   process.stdout.write(
//     `\r[${bar}] ${percent}% | Indexed: ${indexed} | Failed: ${failed} | Total: ${total}`
//   );
// }

// // ─── MAIN ─────────────────────────────────────────────────

// async function importProducts() {
//   try {
//     console.log('\n--- Import Started ---\n');

//     // Step 1 — setup indexes
//     console.log('Setting up Meilisearch indexes...');
//     await createIndexes();
//     console.log('Indexes ready\n');

//     // Step 2 — read Excel
//     console.log('Reading Excel file...');
//     const workbook = XLSX.readFile(EXCEL_FILE);
//     const sheetName = workbook.SheetNames[0];
//     const sheet = workbook.Sheets[sheetName];
//     const rawRows = XLSX.utils.sheet_to_json(sheet);
//     console.log(`Found ${rawRows.length} rows\n`);

//     // Step 3 — map products
//     console.log('Mapping products...');
//     const seen = new Set();
//     const products = [];
//     let trueduplicates = 0;

//     for (const rawRow of rawRows) {
//       const product = mapRow(rawRow);
//       if (!product) continue;

//       const dedupKey = `${product.name.toLowerCase()}||${(product.category || '').toLowerCase()}||${(product.subcategory || '').toLowerCase()}`;

//       if (seen.has(dedupKey)) {
//         trueduplicates++;
//         continue;
//       }
//       seen.add(dedupKey);
//       products.push(product);
//     }

//     const invalid = rawRows.length - products.length - trueduplicates;

//     console.log(`Valid products:     ${products.length}`);
//     console.log(`True duplicates:    ${trueduplicates}`);
//     console.log(`Invalid rows:       ${invalid}\n`);

//     // Step 4 — index products in batches
//     console.log('Indexing products into Meilisearch...\n');
//     let indexed = 0;
//     let failed = 0;

//     for (let i = 0; i < products.length; i += BATCH_SIZE) {
//       const batch = products.slice(i, i + BATCH_SIZE);

//       try {
//         await client.index('products').addDocuments(batch);
//         indexed += batch.length;
//       } catch (err) {
//         failed += batch.length;
//         console.error(`\nBatch ${Math.floor(i / BATCH_SIZE) + 1} failed:`, err.message);
//       }

//       showProgress(indexed, products.length, failed);
//     }

//     // Step 5 — index categories
//     console.log('\n\nIndexing categories...');
//     let categoriesIndexed = 0;
//     try {
//       const { getFlatCategories } = require('../data/categories');
//       const cats = getFlatCategories();
//       await client.index('categories').addDocuments(cats);
//       categoriesIndexed = cats.length;
//       console.log(`✅ Categories indexed: ${categoriesIndexed}`);
//     } catch (err) {
//       console.error('❌ Category indexing failed:', err.message);
//       console.error('Run extractCategories.js first if data/categories.js is missing');
//     }

//     // Step 6 — summary
//     console.log('\n--- Import Complete ---');
//     console.log(`✅ Products indexed:  ${indexed}`);
//     console.log(`❌ Products failed:   ${failed}`);
//     console.log(`📁 Categories:        ${categoriesIndexed}`);
//     console.log(`📦 Unique products:   ${products.length}`);
//     console.log(`🔁 True duplicates:   ${trueduplicates}`);
//     console.log(`⚠️  Invalid rows:      ${invalid}`);
//     console.log(`📊 Raw rows:          ${rawRows.length}`);

//   } catch (err) {
//     console.error('Import failed:', err.message);
//     process.exit(1);
//   }
// }

// importProducts();

















// require('dotenv').config({ path: '../.env' });
// const XLSX = require('xlsx');
// const path = require('path');
// const { MeiliSearch } = require('meilisearch');
// const { createIndexes } = require('../src/meilisearch/indexes');

// // ─── CONFIG ───────────────────────────────────────────────
// const EXCEL_FILE = path.join(__dirname, '../products_export.xlsx');
// const BATCH_SIZE = 500;

// const client = new MeiliSearch({
//   host: process.env.MEILI_HOST || 'http://localhost:7700',
//   apiKey: process.env.MEILI_MASTER_KEY || 'masterKey123'
// });

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

// function cleanText(text) {
//   if (!text) return '';
//   return String(text)
//     .replace(/<[^>]*>/g, ' ')
//     .replace(/&nbsp;/g, ' ')
//     .replace(/&amp;/g, '&')
//     .replace(/&lt;/g, '<')
//     .replace(/&gt;/g, '>')
//     .replace(/\s+/g, ' ')
//     .trim();
// }

// function normalizeRow(row) {
//   const newRow = {};
//   for (const key in row) {
//     newRow[key.toLowerCase().trim()] = row[key];
//   }
//   return newRow;
// }

// function slugify(text) {
//   if (!text) return '';
//   return text
//     .toLowerCase()
//     .trim()
//     .replace(/[^a-z0-9\s]/g, '')
//     .replace(/\s+/g, '_');
// }

// function generateId(name, l1, l2, l3) {
//   const base = `${slugify(l1)}_${slugify(l2)}_${slugify(l3)}_${slugify(name)}`;
//   return `prod_${base}`.slice(0, 200);
// }

// function extractTags(name, description) {
//   const text = `${name} ${description}`;
//   return text
//     .toLowerCase()
//     .replace(/[^a-z0-9\s]/g, '')
//     .split(' ')
//     .filter(w => w.length > 3 && !STOPWORDS.has(w))
//     .filter(w => /^[a-z]+$/.test(w))
//     .slice(0, 15);
// }

// function mapRow(row) {
//   const r = normalizeRow(row);

//   const l1 = cleanText(r['category l1 name']);
//   const l2 = cleanText(r['category l2 name']);
//   const l3 = cleanText(r['category l3 name']);
//   const name = cleanText(r['display name']);
//   const description = cleanText(r['description']);

//   if (!name || !l1) return null;

//   const tags = extractTags(name, description);

//   return {
//     id: generateId(name, l1, l2 || '', l3 || ''),
//     name,
//     description,
//     catalogue: l1,
//     category: l2 || null,
//     subcategory: l3 || null,
//     brand: '',
//     tags,
//     searchText: `${name} ${description} ${l1} ${l2 || ''} ${l3 || ''} ${tags.join(' ')}`,
//     price: 0,
//     popularity: 0,
//     sales: 0
//   };
// }

// // ─── PROGRESS TRACKER ─────────────────────────────────────

// function showProgress(indexed, total, failed) {
//   const percent = Math.floor((indexed / total) * 100);
//   const bar = '█'.repeat(Math.floor(percent / 5)) +
//               '░'.repeat(20 - Math.floor(percent / 5));
//   process.stdout.write(
//     `\r[${bar}] ${percent}% | Indexed: ${indexed} | Failed: ${failed} | Total: ${total}`
//   );
// }

// // ─── MAIN ─────────────────────────────────────────────────

// async function importProducts() {
//   try {
//     console.log('\n--- Import Started ---\n');

//     // Step 1 — setup indexes
//     console.log('Setting up Meilisearch indexes...');
//     await createIndexes();
//     console.log('Indexes ready\n');

//     // Step 2 — read Excel
//     console.log('Reading Excel file...');
//     const workbook = XLSX.readFile(EXCEL_FILE);
//     const sheetName = workbook.SheetNames[0];
//     const sheet = workbook.Sheets[sheetName];
//     const rawRows = XLSX.utils.sheet_to_json(sheet);
//     console.log(`Found ${rawRows.length} rows\n`);

//     // Step 3 — map products
//     console.log('Mapping products...');
//     const seen = new Set();
//     const products = [];
//     let trueduplicates = 0;

//     for (const rawRow of rawRows) {
//       const product = mapRow(rawRow);
//       if (!product) continue;

//       const dedupKey = `${product.name.toLowerCase()}||${(product.category || '').toLowerCase()}||${(product.subcategory || '').toLowerCase()}`;

//       if (seen.has(dedupKey)) {
//         trueduplicates++;
//         continue;
//       }
//       seen.add(dedupKey);
//       products.push(product);
//     }

//     const invalid = rawRows.length - products.length - trueduplicates;

//     console.log(`Valid products:     ${products.length}`);
//     console.log(`True duplicates:    ${trueduplicates}`);
//     console.log(`Invalid rows:       ${invalid}\n`);

//     // Step 4 — index products in batches
//     console.log('Indexing products into Meilisearch...\n');
//     let indexed = 0;
//     let failed = 0;

//     for (let i = 0; i < products.length; i += BATCH_SIZE) {
//       const batch = products.slice(i, i + BATCH_SIZE);

//       try {
//         await client.index('products').addDocuments(batch);
//         indexed += batch.length;
//       } catch (err) {
//         failed += batch.length;
//         console.error(`\nBatch ${Math.floor(i / BATCH_SIZE) + 1} failed:`, err.message);
//       }

//       showProgress(indexed, products.length, failed);
//     }

//     // Step 5 — index categories
//     console.log('\n\nIndexing categories...');
//     let categoriesIndexed = 0;
//     try {
//       const { getFlatCategories } = require('../data/categories');
//       const cats = getFlatCategories();
//       await client.index('categories').addDocuments(cats);
//       categoriesIndexed = cats.length;
//       console.log(`✅ Categories indexed: ${categoriesIndexed}`);
//     } catch (err) {
//       console.error('❌ Category indexing failed:', err.message);
//       console.error('Run extractCategories.js first if data/categories.js is missing');
//     }

//     // Step 6 — summary
//     console.log('\n--- Import Complete ---');
//     console.log(`✅ Products indexed:  ${indexed}`);
//     console.log(`❌ Products failed:   ${failed}`);
//     console.log(`📁 Categories:        ${categoriesIndexed}`);
//     console.log(`📦 Unique products:   ${products.length}`);
//     console.log(`🔁 True duplicates:   ${trueduplicates}`);
//     console.log(`⚠️  Invalid rows:      ${invalid}`);
//     console.log(`📊 Raw rows:          ${rawRows.length}`);

//   } catch (err) {
//     console.error('Import failed:', err.message);
//     process.exit(1);
//   }
// }

// importProducts();










