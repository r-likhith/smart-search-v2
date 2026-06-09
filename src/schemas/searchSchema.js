// Standard shape for search responses
function buildSearchResponse(data) {

  const hasCorrection =
    data.correctedQuery &&
    data.correctedQuery !== data.originalQuery;

  return {
    success: true,
    query: {
      original:   data.originalQuery  || '',
      normalised: data.normalisedQuery || ''
    },
    correction: {
      applied:          hasCorrection || false,
      correctedQuery:   data.correctedQuery || null,
      displayQuery:     data.displayQuery   || null,
      retrievalQuery:   data.retrievalQuery || null,
      correctionMode:   data.correctionMode || 'none',
      // State 1 — none:     no banner ✅
      // State 2 — assisted: "Did you mean nokia phone?" ✅
      // State 3 — full:     "Showing results for nokia phone" ✅
      showingResultsFor: hasCorrection
        ? (data.displayQuery || data.correctedQuery)
        : null,
      searchInsteadFor:  hasCorrection ? data.originalQuery          : null,
      confidence:        hasCorrection ? (data.correctionConfidence  || null) : null,
      source:            hasCorrection ? (data.correctionSource      || null) : null
    },
    meta: {
      totalHits:      data.totalHits      || 0,
      processingTime: data.processingTime ?? 0,
      isFallback:     data.isFallback     || false,
      fallbackReason: data.fallbackReason || null,
      relevanceScore: data.score          || null,
      // ui hints for frontend ✅
      // controlled by feature flags in .env ✅
      // showBanner:         show correction banner ✅
      // silentInputRewrite: rewrite search bar text ✅
      // allowSearchInstead: show "search instead" link ✅
      // correctionMode:     none/assisted/full ✅
      ui: data.ui || {
        showBanner:         false,
        silentInputRewrite: false,
        allowSearchInstead: false,
        correctionMode:     'none'
      },
      intent: data.intentFilters ? {
        filtersApplied: true,
        filters:        data.intentFilters,
        cleanQuery:     data.intentCleanQuery || null
      } : null
    },
    pagination: {
      limit:  data.limit  || 20,
      offset: data.offset || 0
    },
    results: (data.results || []).map(hit => ({
      id:          hit.id,
      sku:         hit.sku         || null,
      name:        hit.name,
      description: hit.description,
      catalogue:   hit.catalogue   || null,
      category:    hit.category,
      subcategory: hit.subcategory || null,
      subCategory: hit.subCategory || null,
      brand:       hit.brand       || null,
      size:        hit.size        || null,
      color:       hit.color       || null,
      price:       hit.price       || 0,
      popularity:  hit.popularity  || 0,
      sales:       hit.sales       || 0,
      rankingScore: hit._rankingScore || null,
      type:        'product',
      highlight:   hit._formatted ? {
        name:        hit._formatted.name        || null,
        description: hit._formatted.description || null
      } : null
    }))
  };
}

// Standard shape for navigation responses
function buildNavigateResponse(data) {
  return {
    success: true,
    navigation: {
      category:    data.category,
      subcategory: data.subcategory || null
    },
    meta: {
      totalHits:      data.totalHits      || 0,
      processingTime: data.processingTime ?? 0,
      isFallback:     data.isFallback     || false,
      fallbackReason: data.fallbackReason || null
    },
    pagination: {
      limit:  data.limit  || 20,
      offset: data.offset || 0
    },
    results: (data.results || []).map(hit => ({
      id:          hit.id,
      sku:         hit.sku         || null,
      name:        hit.name,
      description: hit.description,
      catalogue:   hit.catalogue   || null,
      category:    hit.category,
      subcategory: hit.subcategory || null,
      subCategory: hit.subCategory || null,
      brand:       hit.brand       || null,
      size:        hit.size        || null,
      color:       hit.color       || null,
      price:       hit.price       || 0,
      popularity:  hit.popularity  || 0,
      sales:       hit.sales       || 0,
      rankingScore: hit._rankingScore || null,
      type:        'product',
      highlight:   hit._formatted ? {
        name:        hit._formatted.name        || null,
        description: hit._formatted.description || null
      } : null
    }))
  };
}

module.exports = { buildSearchResponse, buildNavigateResponse };























// // Standard shape for search responses
// function buildSearchResponse(data) {

//   // Fix 1 — safe correction check
//   const hasCorrection =
//     data.correctedQuery &&
//     data.correctedQuery !== data.originalQuery;

//   return {
//     success: true,
//     query: {
//       original: data.originalQuery || '',
//       normalised: data.normalisedQuery || ''
//     },
//     correction: {
//       applied: hasCorrection || false,
//       correctedQuery: data.correctedQuery || null,
//       showingResultsFor: hasCorrection ? data.correctedQuery : null,
//       searchInsteadFor: hasCorrection ? data.originalQuery : null,
//       // Fix 3 — correction visibility for frontend
//       confidence: hasCorrection ? (data.correctionConfidence || null) : null,
//       source: hasCorrection ? (data.correctionSource || null) : null
//     },
//     meta: {
//       totalHits: data.totalHits || 0,
//       processingTime: data.processingTime ?? 0,
//       isFallback: data.isFallback || false,
//       fallbackReason: data.fallbackReason || null,
//       relevanceScore: data.score || null  // Fix 2 — renamed from score
//     },
//     pagination: {
//       limit: data.limit || 20,
//       offset: data.offset || 0
//     },
//     results: (data.results || []).map(hit => ({
//       id: hit.id,
//       name: hit.name,
//       description: hit.description,
//       category: hit.category,
//       subcategory: hit.subcategory || null,
//       brand: hit.brand || null,
//       price: hit.price,
//       popularity: hit.popularity || 0,
//       sales: hit.sales || 0,
//       rankingScore: hit._rankingScore || null,  // Fix 2 — renamed from score
//       type: 'product',
//       highlight: hit._formatted ? {
//         name: hit._formatted.name || null,
//         description: hit._formatted.description || null
//       } : null
//     }))
//   };
// }

// // Standard shape for navigation responses
// function buildNavigateResponse(data) {
//   return {
//     success: true,
//     navigation: {
//       category: data.category,
//       subcategory: data.subcategory || null
//     },
//     meta: {
//       totalHits: data.totalHits || 0,
//       processingTime: data.processingTime ?? 0,
//       isFallback: data.isFallback || false,
//       fallbackReason: data.fallbackReason || null
//     },
//     pagination: {
//       limit: data.limit || 20,
//       offset: data.offset || 0
//     },
//     results: (data.results || []).map(hit => ({
//       id: hit.id,
//       name: hit.name,
//       description: hit.description,
//       category: hit.category,
//       subcategory: hit.subcategory || null,
//       brand: hit.brand || null,
//       price: hit.price,
//       popularity: hit.popularity || 0,
//       sales: hit.sales || 0,
//       rankingScore: hit._rankingScore || null,  // Fix 2 — renamed
//       type: 'product',
//       highlight: hit._formatted ? {
//         name: hit._formatted.name || null,
//         description: hit._formatted.description || null
//       } : null
//     }))
//   };
// }

// module.exports = { buildSearchResponse, buildNavigateResponse };