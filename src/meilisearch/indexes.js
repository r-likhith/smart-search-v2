const client = require('./client');

const PRODUCTS_INDEX = process.env.CLIENT_INDEX || 'products';
const CATEGORIES_INDEX = 'categories';

async function createIndexes() {
  try {
    // ─── PRODUCTS INDEX ───────────────────────────────────
    await client.createIndex(PRODUCTS_INDEX, { primaryKey: 'id' });

    await client.index(PRODUCTS_INDEX).updateSettings({
      searchableAttributes: [
        'name',           // highest priority
        'searchKeys',     // keywords + synonyms ← new
        'brand',          // brand name
        'description',    // product details
        'category',       // L2
        'subcategory',    // L3
        'subCategory',    // L4 ← new
        'catalogue',      // L1
        'color',          // color variant ← new
        'size',           // size variant ← new
        'searchText'      // full text fallback
      ],
      filterableAttributes: [
        'catalogue',      // L1 filter
        'category',       // L2 filter
        'subcategory',    // L3 filter
        'subCategory',    // L4 filter ← new
        'brand',          // brand filter ← new
        'color',          // color filter ← new
        'size',           // size filter ← new
        'price'           // price filter (real prices now!)
      ],
      sortableAttributes: [
        'price',          // sort by price ← real prices now
        'popularity',
        'sales'
      ],
      rankingRules: [
        'words',
        'typo',
        'proximity',
        'attribute',
        'sort',
        'exactness',
        'popularity:desc',
        'sales:desc'
      ],
      typoTolerance: {
        enabled: true,
        minWordSizeForTypos: {
          oneTypo: 4,
          twoTypos: 8
        }
      },
      pagination: {
        maxTotalHits: 1000
      }
    });

    console.log('Products index created with ranking');

    // ─── CATEGORIES INDEX ─────────────────────────────────
    await client.createIndex(CATEGORIES_INDEX, { primaryKey: 'id' });

    await client.index(CATEGORIES_INDEX).updateSettings({
      searchableAttributes: [
        'name',
        'parent',
        'grandparent',
        'greatGrandparent', // L1 for L4 categories ← new
        'tags',
        'path'
      ],
      filterableAttributes: [
        'parent',
        'grandparent',
        'greatGrandparent', // ← new
        'level',            // L3 or L4 ← new
        'type'
      ],
      sortableAttributes: [
        'productCount'      // sort by popularity ← new
      ],
      rankingRules: [
        'words',
        'typo',
        'proximity',
        'attribute',
        'exactness',
        'productCount:desc'
      ]
    });

    console.log('Categories index created');

  } catch (err) {
    if (err.code === 'index_already_exists') {
      console.log('Indexes already exist — skipping creation');
    } else {
      console.error('Error creating indexes:', err.message);
      throw err;
    }
  }
}

module.exports = { createIndexes, PRODUCTS_INDEX, CATEGORIES_INDEX };

























// const client = require('./client');

// // Index names
// const PRODUCTS_INDEX = 'products';
// const CATEGORIES_INDEX = 'categories';

// async function createIndexes() {
//   try {
//     // ─── PRODUCTS INDEX ───────────────────────────────────
//     await client.createIndex(PRODUCTS_INDEX, { primaryKey: 'id' });

//     await client.index(PRODUCTS_INDEX).updateSettings({
//       searchableAttributes: [
//         'name',
//         'description',
//         'category',
//         'subcategory',
//         'brand',
//         'tags',
//         'searchText'  // added — improves recall
//       ],
//       filterableAttributes: [
//         'category',
//         'subcategory',
//         'catalogue',
//         'brand',
//         'price'
//       ],
//       sortableAttributes: [
//         'price',
//         'popularity',
//         'sales'
//       ],
//       rankingRules: [
//         'words',
//         'typo',
//         'proximity',
//         'attribute',
//         'sort',
//         'exactness',
//         'popularity:desc',
//         'sales:desc'
//       ],
//       typoTolerance: {
//         enabled: true,
//         minWordSizeForTypos: {
//           oneTypo: 4,
//           twoTypos: 8
//         }
//       },
//       pagination: {
//         maxTotalHits: 1000
//       }
//     });

//     console.log('Products index created with ranking');

//     // ─── CATEGORIES INDEX ─────────────────────────────────
//     await client.createIndex(CATEGORIES_INDEX, { primaryKey: 'id' });

//     await client.index(CATEGORIES_INDEX).updateSettings({
//       // fixed — added all searchable fields
//       searchableAttributes: [
//         'name',
//         'parent',
//         'grandparent',
//         'tags',
//         'path'
//       ],
//       // fixed — added grandparent for hierarchy filtering
//       filterableAttributes: [
//         'parent',
//         'grandparent',
//         'type'
//       ],
//       rankingRules: [
//         'words',
//         'typo',
//         'proximity',
//         'attribute',
//         'exactness',
//         'productCount:desc'
//       ]
//     });

//     console.log('Categories index created');

//   } catch (err) {
//     if (err.code === 'index_already_exists') {
//       console.log('Indexes already exist — skipping creation');
//     } else {
//       console.error('Error creating indexes:', err.message);
//       throw err;
//     }
//   }
// }

// module.exports = { createIndexes, PRODUCTS_INDEX, CATEGORIES_INDEX };