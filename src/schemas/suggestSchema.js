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
        name:             cat.value       || cat.name || null, // ← searcher uses value ✅
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
          type:        cat.action?.type || 'navigate',
          catalogue:   cat.action?.catalogue || null,  // ← from searcher action ✅
          category:    cat.action?.category  || null,  // ← from searcher action ✅
          subcategory: cat.action?.subcategory || null,
          subCategory: cat.action?.subCategory || null,
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


