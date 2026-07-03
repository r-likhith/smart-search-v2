const express = require('express');
const router = express.Router();
const { runSuggest } = require('../query/queryRunner');
const { buildSuggestResponse } = require('../schemas/suggestSchema');
const { successResponse, errorResponse } = require('../utils/response');
const { isValidClient, getClientIndex, getClientScope } = require('../../configVendors/clientHelper');

router.get('/', async (req, res, next) => {
  // clientId from query param (GET request) OR from API key ✅
  const { q, catalogue, clientId: queryClientId } = req.query;

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

    // ── ClientId resolution ───────────────────────────────
    // per-client key:  clientId injected from API key ✅
    // legacy key:      clientId comes from ?clientId= query param ✅
    // suggest is a GET request so clientId comes from query string,
    // not request body — backward compat preserved ✅
    const clientId = req.resolvedClientId || queryClientId;

    if (!clientId) {
      return errorResponse(res,
        'clientId is required — use a per-client API key or include ?clientId= in the request',
        400
      );
    }
    if (!isValidClient(clientId)) {
      return errorResponse(res, `Unknown or inactive clientId: ${clientId}`, 400);
    }

    // ── Resolve client index + scope ──────────────────────
    const meiliIndex  = getClientIndex(clientId);
    const clientScope = getClientScope(clientId);

    // ── Run suggest pipeline ──────────────────────────────
    const result = await runSuggest(q, {
      clientId,
      clientScope,
      meiliIndex,
      catalogue
    });

    return successResponse(res, buildSuggestResponse({
      originalQuery:        q,
      normalisedQuery:      result.normalisedQuery || result.query || q,
      correctedQuery:       result.correctedQuery       || null,
      wasCorrected:         result.wasCorrected         || false,
      correctionSource:     result.correctionSource     || null,
      correctionConfidence: result.correctionConfidence || null,
      correctionMode:       result.correctionMode       || 'none',
      suggestions:          result.suggestions          || [],
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