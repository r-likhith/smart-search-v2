// Standard shape for suggestion responses
function buildSuggestResponse(data) {

  const hasCorrection =
    data.correctedQuery &&
    data.correctedQuery !== data.originalQuery;

  return {
    success: true,
    query: {
      original:   data.originalQuery  || data.query || '',
      normalised: data.normalisedQuery || data.query || ''
    },
    // correction state for search bar ✅
    // frontend uses this to show correction banner
    // and optionally rewrite search bar text
    correction: {
      applied:           hasCorrection || false,
      correctedQuery:    data.correctedQuery || null,
      correctionMode:    data.correctionMode || 'none',
      // State 2 — assisted: "Did you mean X?" ✅
      // State 3 — full:     "Showing results for X" ✅
      showingResultsFor: hasCorrection ? data.correctedQuery : null,
      searchInsteadFor:  hasCorrection ? data.originalQuery  : null,
      confidence:        hasCorrection ? (data.correctionConfidence || null) : null,
      source:            hasCorrection ? (data.correctionSource     || null) : null
    },
    meta: {
      processingTime:   data.processingTime  ?? 0,
      totalCategories:  (data.categories  || []).length,
      totalProducts:    (data.products    || []).length,
      totalSuggestions: (data.suggestions || []).length
    },
    suggestions: {
      // unified list ✅
      // frontend renders by type:
      // catalogue → 📁  category → 📁
      // brand     → 🏷️  product  → 📦
      unified: (data.suggestions || []),

      // backwards compat ✅
      categories: (data.categories || []).map(cat => ({
        id:               cat.id          || null,
        name:             cat.name,
        parent:           cat.parent           || null,
        grandparent:      cat.grandparent      || null,
        greatGrandparent: cat.greatGrandparent || null,
        level:            cat.level            || 'L3',
        path:             cat.path             || null,
        productCount:     cat.productCount     || 0,
        minPrice:         cat.minPrice         || 0,
        maxPrice:         cat.maxPrice         || 0,
        type:             cat.type             || 'category',
        action: {
          type:        'navigate',
          catalogue:   cat.greatGrandparent || cat.grandparent || null,
          category:    cat.grandparent      || cat.parent      || cat.name,
          subcategory: cat.parent ? cat.name : null,
          subCategory: cat.level === 'L4'   ? cat.name : null,
          path:        cat.path || null
        }
      })),
      products: (data.products || []).map(product => ({
        id:              product.id,
        sku:             product.sku             || null,
        name:            product.name,
        // highlighted name ✅
        // shows which part matched query ✅
        // <em>iph</em>one 15
        nameHighlighted: product.nameHighlighted || product.name,
        category:        product.category,
        subcategory:     product.subcategory     || null,
        subCategory:     product.subCategory     || null,
        brand:           product.brand           || null,
        size:            product.size            || null,
        color:           product.color           || null,
        price:           product.price           || 0,
        type:            'product',
        action: {
          type:  'search',
          query: product.name
        }
      }))
    }
  };
}

module.exports = { buildSuggestResponse };

















// // Standard shape for suggestion responses
// function buildSuggestResponse(data) {
//   return {
//     success: true,
//     query: {
//       original: data.originalQuery || data.query || '',
//       normalised: data.normalisedQuery || data.query || ''
//     },
//     meta: {
//       processingTime: data.processingTime ?? 0,
//       totalCategories: (data.categories || []).length,
//       totalProducts: (data.products || []).length
//     },
//     suggestions: {
//       categories: (data.categories || []).map(cat => ({
//         id: cat.id,
//         name: cat.name,
//         parent: cat.parent || null,
//         grandparent: cat.grandparent || null,
//         path: cat.path || null,
//         productCount: cat.productCount || 0,
//         type: 'category',
//         action: {
//           type: 'navigate',
//           // catalogue = grandparent (top level)
//           catalogue: cat.grandparent || null,
//           // category = parent (mid level)
//           category: cat.parent || cat.name,
//           // subcategory = name (specific level)
//           subcategory: cat.parent ? cat.name : null,
//           path: cat.path || null
//         }
//       })),
//       products: (data.products || []).map(product => ({
//         id: product.id,
//         name: product.name,
//         category: product.category,
//         subcategory: product.subcategory || null,
//         price: product.price,
//         type: 'product',
//         action: {
//           type: 'search',
//           query: product.name
//         }
//       }))
//     }
//   };
// }

// module.exports = { buildSuggestResponse };
