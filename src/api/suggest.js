const express = require('express');
const router = express.Router();
const { runSuggest } = require('../query/queryRunner');
const { buildSuggestResponse } = require('../schemas/suggestSchema');
const { successResponse, errorResponse } = require('../utils/response');
const { isValidClient, getClientIndex, getClientScope } = require('../../configVendors/clientHelper');

router.get('/', async (req, res, next) => {
  const { q, catalogue, clientId } = req.query;

  try {
    // ── Query validation ──────────────────────────────────
    if (!q || q.length < 1) {
      return successResponse(res, buildSuggestResponse({
        originalQuery:   '',
        normalisedQuery: '',
        suggestions:     [],
        categories:      [],
        products:        []
      }));
    }

    if (q.length > 100) {
      return errorResponse(res, 'Query too long', 400);
    }

    // ── ClientId validation ───────────────────────────────
    if (!clientId) {
      return errorResponse(res, 'clientId is required', 400);
    }
    if (!isValidClient(clientId)) {
      return errorResponse(res, `Unknown or inactive clientId: ${clientId}`, 400);
    }

    // ── Resolve client index + scope ──────────────────────
    const meiliIndex  = getClientIndex(clientId);
    const clientScope = getClientScope(clientId); // ← scope for context ✅

    // ── Run suggest pipeline ──────────────────────────────
    const result = await runSuggest(q, {
      clientId,
      clientScope,    // ← passed to applyCorrection ✅
      meiliIndex,
      catalogue
    });

    return successResponse(res, buildSuggestResponse({
      originalQuery:        q,
      normalisedQuery:      result.normalisedQuery || result.query || q,
      // correction fields ✅
      correctedQuery:       result.correctedQuery       || null,
      wasCorrected:         result.wasCorrected         || false,
      correctionSource:     result.correctionSource     || null,
      correctionConfidence: result.correctionConfidence || null,
      correctionMode:       result.correctionMode       || 'none',
      // unified suggestions ✅
      suggestions:          result.suggestions          || [],
      // backwards compat ✅
      categories:           result.categories           || [],
      products:             result.products             || [],
      processingTime:       result.processingTime       || 0
    }));

  } catch (err) {
    next(err);
  }
});

module.exports = router;














// *********************** ALL BEFORE THE MULTI TENANT PHASE **********************************






// const express = require('express');
// const router = express.Router();
// const { runSuggest } = require('../query/queryRunner');
// const { buildSuggestResponse } = require('../schemas/suggestSchema');
// const { successResponse, errorResponse } = require('../utils/response');

// router.get('/', async (req, res, next) => {
//   const { q, catalogue } = req.query;

//   try {
//     // validate — empty query
//     if (!q || q.length < 1) {
//       return successResponse(res, buildSuggestResponse({
//         originalQuery: '',
//         normalisedQuery: '',
//         categories: [],
//         products: []
//       }));
//     }

//     // validate — query too long
//     if (q.length > 100) {
//       return errorResponse(res, 'Query too long', 400);
//     }

//     // run suggest pipeline
//     const result = await runSuggest(q, { catalogue });

//     return successResponse(res, buildSuggestResponse({
//       originalQuery: q,
//       normalisedQuery: result.query,  // fix — correct field name
//       categories: result.categories,
//       products: result.products,
//       processingTime: result.processingTime || 0
//     }));

//   } catch (err) {
//     next(err);
//   }
// });

// module.exports = router;