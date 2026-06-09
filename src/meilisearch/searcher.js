const client = require('./client');
const { PRODUCTS_INDEX, CATEGORIES_INDEX } = require('./indexes');

// ─── FIELDS TO RETRIEVE ───────────────────────────────────

const PRODUCT_FIELDS = [
  'id', 'sku',
  'name', 'description',
  'catalogue', 'category', 'subcategory', 'subCategory',
  'brand', 'size', 'color',
  'price', 'popularity', 'sales'
];

const PRODUCT_FIELDS_SUGGEST = [
  'id', 'sku', 'name',
  'catalogue', 'category', 'subcategory', 'subCategory',
  'brand', 'size', 'color', 'price'
];

const PRODUCT_FIELDS_MINIMAL = [
  'id', 'name', 'category', 'price'
];

const CATEGORY_FIELDS = [
  'id', 'name', 'parent', 'grandparent', 'greatGrandparent',
  'path', 'level', 'productCount', 'minPrice', 'maxPrice'
];

// ─── MAIN SEARCH ──────────────────────────────────────────

async function searchProducts(query, options = {}) {
  try {
    const {
      catalogue,
      category,
      subcategory,
      subCategory,
      brand,
      color,
      size,
      minPrice,
      maxPrice,
      sortBy,
      limit = 20,
      offset = 0,
      highlight = true,
      meiliIndex
    } = options;

    const indexName = meiliIndex || PRODUCTS_INDEX;

    const filters = [];
    if (catalogue)   filters.push(`catalogue = "${catalogue}"`);
    if (category)    filters.push(`category = "${category}"`);
    if (subcategory) filters.push(`subcategory = "${subcategory}"`);
    if (subCategory) filters.push(`subCategory = "${subCategory}"`);
    if (brand)       filters.push(`brand = "${brand}"`);
    if (color)       filters.push(`color = "${color}"`);

    if (size) {
      if (Array.isArray(size)) {
        const sizeList = size.map(s => `"${s}"`).join(', ');
        filters.push(`size IN [${sizeList}]`);
      } else {
        filters.push(`size = "${size}"`);
      }
    }

    if (minPrice) filters.push(`price >= ${minPrice}`);
    if (maxPrice) filters.push(`price <= ${maxPrice}`);

    const searchParams = {
      limit,
      offset,
      attributesToRetrieve: PRODUCT_FIELDS
    };

    if (highlight) {
      searchParams.attributesToHighlight = ['name', 'description'];
      searchParams.highlightPreTag  = '<em>';
      searchParams.highlightPostTag = '</em>';
    }

    if (filters.length > 0) {
      searchParams.filter = filters.join(' AND ');
    }

    if (sortBy) {
      searchParams.sort = [sortBy];
    }

    const results = await client.index(indexName).search(query, searchParams);

    return {
      hits:           results.hits,
      totalHits:      results.estimatedTotalHits,
      processingTime: results.processingTimeMs,
      query:          results.query
    };

  } catch (err) {
    console.error('Search error:', err.message);
    return { hits: [], totalHits: 0, processingTime: 0 };
  }
}

// ─── LIVE SUGGESTIONS ─────────────────────────────────────

async function getSuggestions(query, options = {}) {
  try {
    const {
      catalogue,
      limit = 5,
      meiliIndex
    } = options;

    const indexName = meiliIndex || PRODUCTS_INDEX;

    // ── product suggestions with highlight ────────────────
    const productParams = {
      limit,
      attributesToRetrieve:  PRODUCT_FIELDS_SUGGEST,
      // highlight matching text in name ✅
      // frontend shows: <em>iph</em>one 15
      attributesToHighlight: ['name'],
      highlightPreTag:       '<em>',
      highlightPostTag:      '</em>'
    };

    if (catalogue) {
      productParams.filter = `catalogue = "${catalogue}"`;
    }

    // ── category + brand suggestions from client index ────
    // uses facets to get real categories/brands ✅
    // per-client isolation maintained ✅
    const facetParams = {
      limit:  0,   // no hits needed — just facets ✅
      facets: ['catalogue', 'category', 'brand']
    };

    if (catalogue) {
      facetParams.filter = `catalogue = "${catalogue}"`;
    }

    // run both in parallel ✅
    const [productResults, facetResults] = await Promise.all([
      client.index(indexName).search(query, productParams),
      client.index(indexName).search(query, facetParams)
    ]);

    // ── extract categories from facets ────────────────────
    const catalogueFacets = facetResults.facetDistribution?.catalogue || {};
    const categoryFacets  = facetResults.facetDistribution?.category  || {};
    const brandFacets     = facetResults.facetDistribution?.brand     || {};

    // build category suggestions ✅
    // sorted by product count descending ✅
    const categorySuggestions = [
      // catalogue level (L1) ✅
      ...Object.entries(catalogueFacets)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([name, count]) => ({
          type:         'catalogue',
          value:        name,
          productCount: count,
          action: {
            type:      'navigate',
            catalogue: name,
            category:  null
          }
        })),
      // category level (L2) ✅
      ...Object.entries(categoryFacets)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([name, count]) => ({
          type:         'category',
          value:        name,
          productCount: count,
          action: {
            type:     'navigate',
            category: name
          }
        })),
      // brand suggestions ✅
      ...Object.entries(brandFacets)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .filter(([name]) => name && name !== 'null')
        .map(([name, count]) => ({
          type:         'brand',
          value:        name,
          productCount: count,
          action: {
            type:  'filter',
            brand: name
          }
        }))
    ];

    // ── unified suggestion list ───────────────────────────
    // type field allows frontend to render differently ✅
    // categories → 📁, brands → 🏷️, products → 📦
    const unifiedSuggestions = [
      ...categorySuggestions,
      ...productResults.hits.map(h => ({
        type:        'product',
        value:       h.name,
        id:          h.id,
        sku:         h.sku         || null,
        name:        h.name,
        // highlighted name for search bar ✅
        // shows which part matched the query ✅
        nameHighlighted: h._formatted?.name || h.name,
        category:    h.category,
        subcategory: h.subcategory || null,
        subCategory: h.subCategory || null,
        brand:       h.brand       || null,
        size:        h.size        || null,
        color:       h.color       || null,
        price:       h.price       || 0,
        action: {
          type:  'search',
          query: h.name
        }
      }))
    ];

    return {
      // unified list ✅ — frontend renders by type
      suggestions: unifiedSuggestions,
      // backwards compat ✅ — existing frontends still work
      products:    productResults.hits.map(h => ({
        id:          h.id,
        sku:         h.sku         || null,
        name:        h.name,
        nameHighlighted: h._formatted?.name || h.name,
        category:    h.category,
        subcategory: h.subcategory || null,
        subCategory: h.subCategory || null,
        brand:       h.brand       || null,
        size:        h.size        || null,
        color:       h.color       || null,
        price:       h.price       || 0,
        type:        'product',
        action: {
          type:  'search',
          query: h.name
        }
      })),
      categories:  categorySuggestions
    };

  } catch (err) {
    console.error('Suggestion error:', err.message);
    return { suggestions: [], products: [], categories: [] };
  }
}

// ─── CATEGORY NAVIGATION ──────────────────────────────────

async function navigateCategory(category, subcategory, options = {}) {
  try {
    const {
      sortBy = 'popularity:desc',
      limit = 20,
      subCategory,
      brand,
      color,
      size,
      minPrice,
      maxPrice,
      meiliIndex
    } = options;

    const indexName = meiliIndex || PRODUCTS_INDEX;

    const filters = [`category = "${category}"`];
    if (subcategory) filters.push(`subcategory = "${subcategory}"`);
    if (subCategory) filters.push(`subCategory = "${subCategory}"`);
    if (brand)       filters.push(`brand = "${brand}"`);
    if (color)       filters.push(`color = "${color}"`);
    if (size)        filters.push(`size = "${size}"`);
    if (minPrice)    filters.push(`price >= ${minPrice}`);
    if (maxPrice)    filters.push(`price <= ${maxPrice}`);

    const results = await client.index(indexName).search('', {
      filter: filters.join(' AND '),
      sort:   [sortBy],
      limit,
      attributesToRetrieve: PRODUCT_FIELDS
    });

    return {
      hits:      results.hits,
      totalHits: results.estimatedTotalHits,
      category,
      subcategory
    };

  } catch (err) {
    console.error('Navigation error:', err.message);
    return { hits: [], totalHits: 0 };
  }
}

// ─── POPULAR FALLBACK ─────────────────────────────────────

async function getPopularProducts(limit = 10, meiliIndex = null) {
  try {
    const indexName = meiliIndex || PRODUCTS_INDEX;

    const statsResult = await client.index(indexName).search('', {
      limit:  0,
      facets: ['catalogue']
    });

    const facets        = statsResult.facetDistribution?.catalogue || {};
    const topCategories = Object.entries(facets)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([cat]) => cat);

    if (topCategories.length === 0) {
      const r = await client.index(indexName).search('', {
        limit,
        attributesToRetrieve: PRODUCT_FIELDS_MINIMAL
      });
      return r.hits.map(h => ({ ...h, type: 'fallback' }));
    }

    const perCategory = Math.ceil(limit / topCategories.length);
    const allHits     = [];

    for (const cat of topCategories) {
      if (allHits.length >= limit) break;
      const r = await client.index(indexName).search('', {
        limit:  perCategory,
        filter: `catalogue = "${cat}"`,
        attributesToRetrieve: PRODUCT_FIELDS_MINIMAL
      });
      allHits.push(...r.hits);
    }

    return allHits
      .slice(0, limit)
      .map(h => ({ ...h, type: 'fallback' }));

  } catch (err) {
    console.error('Popular products error:', err.message);
    return [];
  }
}

module.exports = {
  searchProducts,
  getSuggestions,
  navigateCategory,
  getPopularProducts
};




































// *********************** ALL BEFORE THE MULTI TENANT PHASE **********************************


// const client = require('./client');
// const { PRODUCTS_INDEX, CATEGORIES_INDEX } = require('./indexes');

// // ─── FIELDS TO RETRIEVE ───────────────────────────────────

// const PRODUCT_FIELDS = [
//   'id', 'sku',
//   'name', 'description',
//   'catalogue', 'category', 'subcategory', 'subCategory',
//   'brand', 'size', 'color',
//   'price', 'popularity', 'sales'
// ];

// const PRODUCT_FIELDS_SUGGEST = [
//   'id', 'sku', 'name',
//   'catalogue', 'category', 'subcategory', 'subCategory',
//   'brand', 'size', 'color', 'price'
// ];

// const PRODUCT_FIELDS_MINIMAL = [
//   'id', 'name', 'category', 'price'
// ];

// const CATEGORY_FIELDS = [
//   'id', 'name', 'parent', 'grandparent', 'greatGrandparent',
//   'path', 'level', 'productCount', 'minPrice', 'maxPrice'
// ];

// // ─── MAIN SEARCH ──────────────────────────────────────────

// async function searchProducts(query, options = {}) {
//   try {
//     const {
//       catalogue,
//       category,
//       subcategory,
//       subCategory,
//       brand,
//       color,
//       size,
//       minPrice,
//       maxPrice,
//       sortBy,
//       limit = 20,
//       offset = 0,
//       highlight = true
//     } = options;

//     const filters = [];
//     if (catalogue)   filters.push(`catalogue = "${catalogue}"`);
//     if (category)    filters.push(`category = "${category}"`);
//     if (subcategory) filters.push(`subcategory = "${subcategory}"`);
//     if (subCategory) filters.push(`subCategory = "${subCategory}"`);
//     if (brand)       filters.push(`brand = "${brand}"`);
//     if (color)       filters.push(`color = "${color}"`);

//     // size: array → IN filter (size group)
//     //       string → exact match
//     if (size) {
//       if (Array.isArray(size)) {
//         const sizeList = size.map(s => `"${s}"`).join(', ');
//         filters.push(`size IN [${sizeList}]`);
//       } else {
//         filters.push(`size = "${size}"`);
//       }
//     }

//     if (minPrice)    filters.push(`price >= ${minPrice}`);
//     if (maxPrice)    filters.push(`price <= ${maxPrice}`);

//     const searchParams = {
//       limit,
//       offset,
//       attributesToRetrieve: PRODUCT_FIELDS
//     };

//     if (highlight) {
//       searchParams.attributesToHighlight = ['name', 'description'];
//       searchParams.highlightPreTag = '<em>';
//       searchParams.highlightPostTag = '</em>';
//     }

//     if (filters.length > 0) {
//       searchParams.filter = filters.join(' AND ');
//     }

//     if (sortBy) {
//       searchParams.sort = [sortBy];
//     }

//     const results = await client.index(PRODUCTS_INDEX).search(
//       query,
//       searchParams
//     );

//     return {
//       hits: results.hits,
//       totalHits: results.estimatedTotalHits,
//       processingTime: results.processingTimeMs,
//       query: results.query
//     };

//   } catch (err) {
//     console.error('Search error:', err.message);
//     return { hits: [], totalHits: 0, processingTime: 0 };
//   }
// }

// // ─── LIVE SUGGESTIONS ─────────────────────────────────────

// async function getSuggestions(query, options = {}) {
//   try {
//     const { catalogue, limit = 5 } = options;

//     const productParams = {
//       limit,
//       attributesToRetrieve: PRODUCT_FIELDS_SUGGEST
//     };

//     if (catalogue) {
//       productParams.filter = `catalogue = "${catalogue}"`;
//     }

//     const productResults = await client
//       .index(PRODUCTS_INDEX)
//       .search(query, productParams);

//     const categoryResults = await client
//       .index(CATEGORIES_INDEX)
//       .search(query, {
//         limit: 3,
//         attributesToRetrieve: CATEGORY_FIELDS
//       });

//     return {
//       products: productResults.hits.map(h => ({
//         id: h.id,
//         sku: h.sku || null,
//         name: h.name,
//         category: h.category,
//         subcategory: h.subcategory || null,
//         subCategory: h.subCategory || null,
//         brand: h.brand || null,
//         size: h.size || null,
//         color: h.color || null,
//         price: h.price || 0,
//         type: 'product',
//         action: {
//           type: 'search',
//           query: h.name
//         }
//       })),
//       categories: categoryResults.hits.map(h => ({
//         id: h.id,
//         name: h.name,
//         parent: h.parent,
//         grandparent: h.grandparent || null,
//         greatGrandparent: h.greatGrandparent || null,
//         path: h.path,
//         level: h.level || 'L3',
//         productCount: h.productCount || 0,
//         minPrice: h.minPrice || 0,
//         maxPrice: h.maxPrice || 0,
//         type: 'category',
//         action: {
//           type: 'navigate',
//           catalogue: h.greatGrandparent || h.grandparent,
//           category: h.grandparent || h.parent,
//           subcategory: h.parent,
//           path: h.path
//         }
//       }))
//     };

//   } catch (err) {
//     console.error('Suggestion error:', err.message);
//     return { products: [], categories: [] };
//   }
// }

// // ─── CATEGORY NAVIGATION ──────────────────────────────────

// async function navigateCategory(category, subcategory, options = {}) {
//   try {
//     const {
//       sortBy = 'popularity:desc',
//       limit = 20,
//       subCategory,
//       brand,
//       color,
//       size,
//       minPrice,
//       maxPrice
//     } = options;

//     const filters = [`category = "${category}"`];
//     if (subcategory)  filters.push(`subcategory = "${subcategory}"`);
//     if (subCategory)  filters.push(`subCategory = "${subCategory}"`);
//     if (brand)        filters.push(`brand = "${brand}"`);
//     if (color)        filters.push(`color = "${color}"`);
//     if (size)         filters.push(`size = "${size}"`);
//     if (minPrice)     filters.push(`price >= ${minPrice}`);
//     if (maxPrice)     filters.push(`price <= ${maxPrice}`);

//     const results = await client.index(PRODUCTS_INDEX).search('', {
//       filter: filters.join(' AND '),
//       sort: [sortBy],
//       limit,
//       attributesToRetrieve: PRODUCT_FIELDS
//     });

//     return {
//       hits: results.hits,
//       totalHits: results.estimatedTotalHits,
//       category,
//       subcategory
//     };

//   } catch (err) {
//     console.error('Navigation error:', err.message);
//     return { hits: [], totalHits: 0 };
//   }
// }

// // ─── POPULAR FALLBACK ─────────────────────────────────────
// // used when no results found for a query
// // returns varied products using random offset
// // avoids always showing same "womens kurta" products

// async function getPopularProducts(limit = 10) {
//   try {
//     // popularity = 0 for all products currently
//     // category-diverse fallback for better UX than random products
//     // when real popularity scores exist (post-integration),
//     // add sort: ['popularity:desc'] to each query ✅
//     const topCategories = [
//       'Men', 'Women', 'Girl', 'Boy',
//       'Appliances', 'Kitchen', 'Audio',
//       'Bags & BackPacks', 'Personal Care', 'Home'
//     ];

//     const perCategory = Math.ceil(limit / topCategories.length);
//     const allHits = [];

//     for (const cat of topCategories) {
//       if (allHits.length >= limit) break;
//       const r = await client.index(PRODUCTS_INDEX).search('', {
//         limit: perCategory,
//         filter: `category = "${cat}"`,
//         attributesToRetrieve: PRODUCT_FIELDS_MINIMAL
//       });
//       allHits.push(...r.hits);
//     }

//     return allHits
//       .slice(0, limit)
//       .map(h => ({ ...h, type: 'fallback' }));

//   } catch (err) {
//     console.error('Popular products error:', err.message);
//     return [];
//   }
// }

// module.exports = {
//   searchProducts,
//   getSuggestions,
//   navigateCategory,
//   getPopularProducts
// };































// const client = require('./client');
// const { PRODUCTS_INDEX, CATEGORIES_INDEX } = require('./indexes');

// // ─── FIELDS TO RETRIEVE ───────────────────────────────────
// // centralised — update once, applies everywhere

// const PRODUCT_FIELDS = [
//   'id', 'sku',
//   'name', 'description',
//   'catalogue', 'category', 'subcategory', 'subCategory',
//   'brand', 'size', 'color',
//   'price', 'popularity', 'sales'
// ];

// const PRODUCT_FIELDS_SUGGEST = [
//   'id', 'sku', 'name',
//   'catalogue', 'category', 'subcategory', 'subCategory',
//   'brand', 'size', 'color', 'price'
// ];

// const CATEGORY_FIELDS = [
//   'id', 'name', 'parent', 'grandparent', 'greatGrandparent',
//   'path', 'level', 'productCount', 'minPrice', 'maxPrice'
// ];

// // ─── MAIN SEARCH ──────────────────────────────────────────

// async function searchProducts(query, options = {}) {
//   try {
//     const {
//       catalogue,
//       category,
//       subcategory,
//       subCategory,
//       brand,
//       color,
//       size,
//       minPrice,
//       maxPrice,
//       sortBy,
//       limit = 20
//     } = options;

//     const filters = [];
//     if (catalogue)   filters.push(`catalogue = "${catalogue}"`);
//     if (category)    filters.push(`category = "${category}"`);
//     if (subcategory) filters.push(`subcategory = "${subcategory}"`);
//     if (subCategory) filters.push(`subCategory = "${subCategory}"`);
//     if (brand)       filters.push(`brand = "${brand}"`);
//     if (color)       filters.push(`color = "${color}"`);
//     if (size)        filters.push(`size = "${size}"`);
//     if (minPrice)    filters.push(`price >= ${minPrice}`);
//     if (maxPrice)    filters.push(`price <= ${maxPrice}`);

//     const searchParams = {
//       limit,
//       attributesToRetrieve: PRODUCT_FIELDS,
//       attributesToHighlight: ['name', 'description'],
//       highlightPreTag: '<em>',
//       highlightPostTag: '</em>'
//     };

//     if (filters.length > 0) {
//       searchParams.filter = filters.join(' AND ');
//     }

//     if (sortBy) {
//       searchParams.sort = [sortBy];
//     }

//     const results = await client.index(PRODUCTS_INDEX).search(
//       query,
//       searchParams
//     );

//     return {
//       hits: results.hits,
//       totalHits: results.estimatedTotalHits,
//       processingTime: results.processingTimeMs,
//       query: results.query
//     };

//   } catch (err) {
//     console.error('Search error:', err.message);
//     return { hits: [], totalHits: 0, processingTime: 0 };
//   }
// }

// // ─── LIVE SUGGESTIONS ─────────────────────────────────────

// async function getSuggestions(query, options = {}) {
//   try {
//     const { catalogue, limit = 5 } = options;

//     const productParams = {
//       limit,
//       attributesToRetrieve: PRODUCT_FIELDS_SUGGEST
//     };

//     if (catalogue) {
//       productParams.filter = `catalogue = "${catalogue}"`;
//     }

//     const productResults = await client
//       .index(PRODUCTS_INDEX)
//       .search(query, productParams);

//     const categoryResults = await client
//       .index(CATEGORIES_INDEX)
//       .search(query, {
//         limit: 3,
//         attributesToRetrieve: CATEGORY_FIELDS
//       });

//     return {
//       products: productResults.hits.map(h => ({
//         id: h.id,
//         sku: h.sku || null,
//         name: h.name,
//         category: h.category,
//         subcategory: h.subcategory || null,
//         subCategory: h.subCategory || null,
//         brand: h.brand || null,
//         size: h.size || null,
//         color: h.color || null,
//         price: h.price || 0,
//         type: 'product',
//         action: {
//           type: 'search',
//           query: h.name
//         }
//       })),
//       categories: categoryResults.hits.map(h => ({
//         id: h.id,
//         name: h.name,
//         parent: h.parent,
//         grandparent: h.grandparent || null,
//         greatGrandparent: h.greatGrandparent || null,
//         path: h.path,
//         level: h.level || 'L3',
//         productCount: h.productCount || 0,
//         minPrice: h.minPrice || 0,
//         maxPrice: h.maxPrice || 0,
//         type: 'category',
//         action: {
//           type: 'navigate',
//           catalogue: h.greatGrandparent || h.grandparent,
//           category: h.grandparent || h.parent,
//           subcategory: h.parent,
//           path: h.path
//         }
//       }))
//     };

//   } catch (err) {
//     console.error('Suggestion error:', err.message);
//     return { products: [], categories: [] };
//   }
// }

// // ─── CATEGORY NAVIGATION ──────────────────────────────────

// async function navigateCategory(category, subcategory, options = {}) {
//   try {
//     const {
//       sortBy = 'popularity:desc',
//       limit = 20,
//       subCategory,
//       brand,
//       color,
//       size,
//       minPrice,
//       maxPrice
//     } = options;

//     const filters = [`category = "${category}"`];
//     if (subcategory)  filters.push(`subcategory = "${subcategory}"`);
//     if (subCategory)  filters.push(`subCategory = "${subCategory}"`);
//     if (brand)        filters.push(`brand = "${brand}"`);
//     if (color)        filters.push(`color = "${color}"`);
//     if (size)         filters.push(`size = "${size}"`);
//     if (minPrice)     filters.push(`price >= ${minPrice}`);
//     if (maxPrice)     filters.push(`price <= ${maxPrice}`);

//     const results = await client.index(PRODUCTS_INDEX).search('', {
//       filter: filters.join(' AND '),
//       sort: [sortBy],
//       limit,
//       attributesToRetrieve: PRODUCT_FIELDS
//     });

//     return {
//       hits: results.hits,
//       totalHits: results.estimatedTotalHits,
//       category,
//       subcategory
//     };

//   } catch (err) {
//     console.error('Navigation error:', err.message);
//     return { hits: [], totalHits: 0 };
//   }
// }

// // ─── POPULAR FALLBACK ─────────────────────────────────────

// async function getPopularProducts(limit = 10) {
//   try {
//     const results = await client.index(PRODUCTS_INDEX).search('', {
//       sort: ['popularity:desc', 'sales:desc'],
//       limit,
//       attributesToRetrieve: PRODUCT_FIELDS
//     });

//     return results.hits;

//   } catch (err) {
//     console.error('Popular products error:', err.message);
//     return [];
//   }
// }

// module.exports = {
//   searchProducts,
//   getSuggestions,
//   navigateCategory,
//   getPopularProducts
// };




























// const client = require('./client');
// const { PRODUCTS_INDEX, CATEGORIES_INDEX } = require('./indexes');

// // ─── MAIN SEARCH ──────────────────────────────────────────

// async function searchProducts(query, options = {}) {
//   try {
//     const {
//       catalogue,
//       category,
//       subcategory,
//       minPrice,
//       maxPrice,
//       sortBy,
//       limit = 10
//     } = options;

//     // Build filter string
//     const filters = [];
//     if (catalogue) filters.push(`catalogue = "${catalogue}"`);
//     if (category) filters.push(`category = "${category}"`);
//     if (subcategory) filters.push(`subcategory = "${subcategory}"`);
//     if (minPrice) filters.push(`price >= ${minPrice}`);
//     if (maxPrice) filters.push(`price <= ${maxPrice}`);

//     const searchParams = {
//       limit,
//       attributesToHighlight: ['name', 'description'],
//       highlightPreTag: '<em>',
//       highlightPostTag: '</em>',
//       attributesToRetrieve: [
//         'id', 'name', 'description',
//         'category', 'subcategory', 'catalogue',
//         'brand', 'price', 'popularity', 'sales', 'tags'
//       ]
//     };

//     if (filters.length > 0) {
//       searchParams.filter = filters.join(' AND ');
//     }

//     if (sortBy) {
//       searchParams.sort = [sortBy];
//     }

//     const results = await client.index(PRODUCTS_INDEX).search(
//       query,
//       searchParams
//     );

//     return {
//       hits: results.hits,
//       totalHits: results.estimatedTotalHits,
//       processingTime: results.processingTimeMs,
//       query: results.query
//     };

//   } catch (err) {
//     console.error('Search error:', err.message);
//     return { hits: [], totalHits: 0, processingTime: 0 };
//   }
// }

// // ─── LIVE SUGGESTIONS ─────────────────────────────────────

// async function getSuggestions(query, options = {}) {
//   try {
//     const { catalogue, limit = 5 } = options;

//     // Search products
//     const productParams = {
//       limit,
//       attributesToRetrieve: [
//         'id', 'name', 'category',
//         'subcategory', 'catalogue', 'price'
//       ]
//     };

//     if (catalogue) {
//       productParams.filter = `catalogue = "${catalogue}"`;
//     }

//     const productResults = await client
//       .index(PRODUCTS_INDEX)
//       .search(query, productParams);

//     // Search categories — fixed retrieve fields
//     const categoryResults = await client
//       .index(CATEGORIES_INDEX)
//       .search(query, {
//         limit: 3,
//         attributesToRetrieve: [
//           'id', 'name', 'parent',
//           'grandparent', 'path', 'productCount'
//         ]
//       });

//     return {
//       products: productResults.hits.map(h => ({
//         id: h.id,
//         name: h.name,
//         category: h.category,
//         subcategory: h.subcategory,
//         price: h.price,
//         type: 'product'
//       })),
//       // fixed — now includes grandparent and path
//       categories: categoryResults.hits.map(h => ({
//         id: h.id,
//         name: h.name,
//         parent: h.parent,
//         grandparent: h.grandparent,
//         path: h.path,
//         productCount: h.productCount,
//         type: 'category'
//       }))
//     };

//   } catch (err) {
//     console.error('Suggestion error:', err.message);
//     return { products: [], categories: [] };
//   }
// }

// // ─── CATEGORY NAVIGATION ──────────────────────────────────

// async function navigateCategory(category, subcategory, options = {}) {
//   try {
//     const { sortBy = 'popularity:desc', limit = 20 } = options;

//     const filters = [`category = "${category}"`];
//     if (subcategory) filters.push(`subcategory = "${subcategory}"`);

//     const results = await client.index(PRODUCTS_INDEX).search('', {
//       filter: filters.join(' AND '),
//       sort: [sortBy],
//       limit,
//       attributesToRetrieve: [
//         'id', 'name', 'description',
//         'category', 'subcategory', 'catalogue',
//         'brand', 'price', 'popularity', 'sales'
//       ]
//     });

//     return {
//       hits: results.hits,
//       totalHits: results.estimatedTotalHits,
//       category,
//       subcategory
//     };

//   } catch (err) {
//     console.error('Navigation error:', err.message);
//     return { hits: [], totalHits: 0 };
//   }
// }

// // ─── POPULAR FALLBACK ─────────────────────────────────────

// async function getPopularProducts(limit = 10) {
//   try {
//     const results = await client.index(PRODUCTS_INDEX).search('', {
//       sort: ['popularity:desc', 'sales:desc'],
//       limit,
//       attributesToRetrieve: [
//         'id', 'name', 'description',
//         'category', 'subcategory',
//         'price', 'popularity', 'sales'
//       ]
//     });

//     return results.hits;

//   } catch (err) {
//     console.error('Popular products error:', err.message);
//     return [];
//   }
// }

// module.exports = {
//   searchProducts,
//   getSuggestions,
//   navigateCategory,
//   getPopularProducts
// };