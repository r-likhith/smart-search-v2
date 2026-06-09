const express = require('express');
const router = express.Router();
const { runSearch } = require('../query/queryRunner');
const { buildSearchResponse } = require('../schemas/searchSchema');
const { successResponse } = require('../utils/response');
const { logQuery } = require('../utils/logger');
const { ValidationError } = require('../utils/errors');
const { logProducts } = require('../../analytics/productsLogger');
const { isValidClient, getClientIndex, getClient, getClientScope } = require('../../configVendors/clientHelper');

// whitelist of allowed sort options
const ALLOWED_SORT = [
  'price:asc',
  'price:desc',
  'popularity:desc',
  'popularity:asc',
  'sales:desc',
  'sales:asc'
];

router.post('/', async (req, res, next) => {
  const {
    query,
    clientId,
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
    limit,
    offset
  } = req.body;

  try {
    // ── Query validation ──────────────────────────────────
    if (!query) {
      return next(new ValidationError('Query is required'));
    }
    if (typeof query !== 'string') {
      return next(new ValidationError('Invalid query'));
    }
    if (!query.trim()) {
      return next(new ValidationError('Query cannot be empty'));
    }
    if (query.length > 150) {
      return next(new ValidationError('Query too long'));
    }

    // ── ClientId validation ───────────────────────────────
    if (!clientId) {
      return next(new ValidationError('clientId is required'));
    }
    if (!isValidClient(clientId)) {
      return next(new ValidationError(`Unknown or inactive clientId: ${clientId}`));
    }

    // ── Filter validation ─────────────────────────────────
    if (catalogue   && typeof catalogue   !== 'string') return next(new ValidationError('Invalid catalogue'));
    if (category    && typeof category    !== 'string') return next(new ValidationError('Invalid category'));
    if (subcategory && typeof subcategory !== 'string') return next(new ValidationError('Invalid subcategory'));
    if (subCategory && typeof subCategory !== 'string') return next(new ValidationError('Invalid subCategory'));
    if (brand       && typeof brand       !== 'string') return next(new ValidationError('Invalid brand'));
    if (color       && typeof color       !== 'string') return next(new ValidationError('Invalid color'));
    if (size        && typeof size        !== 'string') return next(new ValidationError('Invalid size'));

    if (sortBy && !ALLOWED_SORT.includes(sortBy)) {
      return next(new ValidationError(
        `Invalid sort option. Allowed: ${ALLOWED_SORT.join(', ')}`
      ));
    }
    if (minPrice !== undefined && isNaN(Number(minPrice))) {
      return next(new ValidationError('Invalid minPrice'));
    }
    if (maxPrice !== undefined && isNaN(Number(maxPrice))) {
      return next(new ValidationError('Invalid maxPrice'));
    }
    if (minPrice && maxPrice && Number(minPrice) > Number(maxPrice)) {
      return next(new ValidationError('minPrice cannot be greater than maxPrice'));
    }

    const parsedLimit  = Number(limit);
    const parsedOffset = Number(offset);

    const safeLimit = Number.isInteger(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, 50)
      : 20;

    const safeOffset = Number.isInteger(parsedOffset) && parsedOffset >= 0
      ? parsedOffset
      : 0;

    // ── Resolve client index + scope ──────────────────────
    const meiliIndex  = getClientIndex(clientId);
    const clientInfo  = getClient(clientId);
    const clientScope = getClientScope(clientId); // ← scope for context ✅

    const result = await runSearch(query, {
      clientId,
      clientScope,    // ← passed to applyCorrection + penalise ✅
      meiliIndex,
      catalogue,
      category,
      subcategory,
      subCategory,
      brand,
      color,
      size,
      minPrice: minPrice ? Number(minPrice) : undefined,
      maxPrice: maxPrice ? Number(maxPrice) : undefined,
      sortBy,
      limit:  safeLimit,
      offset: safeOffset
    });

    const normalisedQuery = result.normalisedQuery || query;

    // ── Log query ─────────────────────────────────────────
    try {
      logQuery({
        requestId:            res.locals.requestId        || null,
        source:               'search',
        clientId,
        clientName:           clientInfo?.name            || null,
        query,
        normalised:           normalisedQuery,
        correctedQuery:       result.correctedQuery       || null,
        appliedCorrection:    result.wasCorrected         || false,
        // correction details ✅
        correctionSource:     result.correctionSource     || null,
        correctionMode:       result.correctionMode       || 'none',
        correctionConfidence: result.correctionConfidence || null,
        // filters ✅
        catalogue:            catalogue    || null,
        category:             category     || null,
        subcategory:          subcategory  || null,
        subCategory:          subCategory  || null,
        brand:                brand        || null,
        color:                color        || null,
        size:                 size         || null,
        // results ✅
        results:              result.totalHits    || 0,
        isFallback:           result.isFallback   || false,
        processingTime:       result.processingTime || 0,
        // intent ✅
        intentFilters:        result.intentFilters    || null,
        intentCleanQuery:     result.intentCleanQuery || null
      });
    } catch (e) {
      console.error('Log failed:', e.message);
    }

    // ── Log products ──────────────────────────────────────
    try {
      logProducts(query, result.results || [], {
        originalQuery:    query,
        clientId,
        correctedQuery:   result.correctedQuery   || null,
        correctionSource: result.correctionSource || null,
        correctionMode:   result.correctionMode   || 'none',
        intentFilters:    result.intentFilters    || null,
        totalHits:        result.totalHits        || 0
      });
    } catch (e) {
      console.error('Products log failed:', e.message);
    }

    return successResponse(res, buildSearchResponse({
      originalQuery:        query,
      normalisedQuery,
      // backwards compat ✅
      correctedQuery:       result.correctedQuery       || null,
      wasCorrected:         result.wasCorrected         || false,
      correctionConfidence: result.correctionConfidence || null,
      correctionSource:     result.correctionSource     || null,
      // query lifecycle ✅
      displayQuery:         result.displayQuery         || null,
      retrievalQuery:       result.retrievalQuery       || null,
      correctionMode:       result.correctionMode       || 'none',
      // ui hints ✅
      ui:                   result.ui                   || null,
      // intent ✅
      intentFilters:        result.intentFilters        || null,
      intentCleanQuery:     result.intentCleanQuery     || null,
      // results ✅
      totalHits:            result.totalHits,
      processingTime:       result.processingTime,
      isFallback:           result.isFallback,
      fallbackReason:       result.fallbackReason,
      limit:                safeLimit,
      offset:               safeOffset,
      results:              result.results || []
    }));

  } catch (err) {
    next(err);
  }
});

module.exports = router;






























// *********************** ALL BEFORE THE MULTI TENANT PHASE **********************************




// const express = require('express');
// const router = express.Router();
// const { runSearch } = require('../query/queryRunner');
// const { buildSearchResponse } = require('../schemas/searchSchema');
// const { successResponse } = require('../utils/response');
// const { logQuery } = require('../utils/logger');
// const { ValidationError } = require('../utils/errors');
// const { logProducts } = require('../../analytics/productsLogger');

// // whitelist of allowed sort options
// const ALLOWED_SORT = [
//   'price:asc',
//   'price:desc',
//   'popularity:desc',
//   'popularity:asc',
//   'sales:desc',
//   'sales:asc'
// ];

// router.post('/', async (req, res, next) => {
//   const {
//     query,
//     catalogue,
//     category,
//     subcategory,
//     subCategory,
//     brand,
//     color,
//     size,
//     minPrice,
//     maxPrice,
//     sortBy,
//     limit,
//     offset
//   } = req.body;

//   try {
//     if (!query) {
//       return next(new ValidationError('Query is required'));
//     }
//     if (typeof query !== 'string') {
//       return next(new ValidationError('Invalid query'));
//     }
//     if (!query.trim()) {
//       return next(new ValidationError('Query cannot be empty'));
//     }
//     if (query.length > 150) {
//       return next(new ValidationError('Query too long'));
//     }
//     if (catalogue && typeof catalogue !== 'string') {
//       return next(new ValidationError('Invalid catalogue'));
//     }
//     if (category && typeof category !== 'string') {
//       return next(new ValidationError('Invalid category'));
//     }
//     if (subcategory && typeof subcategory !== 'string') {
//       return next(new ValidationError('Invalid subcategory'));
//     }
//     if (subCategory && typeof subCategory !== 'string') {
//       return next(new ValidationError('Invalid subCategory'));
//     }
//     if (brand && typeof brand !== 'string') {
//       return next(new ValidationError('Invalid brand'));
//     }
//     if (color && typeof color !== 'string') {
//       return next(new ValidationError('Invalid color'));
//     }
//     if (size && typeof size !== 'string') {
//       return next(new ValidationError('Invalid size'));
//     }
//     if (sortBy && !ALLOWED_SORT.includes(sortBy)) {
//       return next(new ValidationError(
//         `Invalid sort option. Allowed: ${ALLOWED_SORT.join(', ')}`
//       ));
//     }
//     if (minPrice !== undefined && isNaN(Number(minPrice))) {
//       return next(new ValidationError('Invalid minPrice'));
//     }
//     if (maxPrice !== undefined && isNaN(Number(maxPrice))) {
//       return next(new ValidationError('Invalid maxPrice'));
//     }
//     if (minPrice && maxPrice && Number(minPrice) > Number(maxPrice)) {
//       return next(new ValidationError('minPrice cannot be greater than maxPrice'));
//     }

//     const parsedLimit = Number(limit);
//     const parsedOffset = Number(offset);

//     const safeLimit = Number.isInteger(parsedLimit) && parsedLimit > 0
//       ? Math.min(parsedLimit, 50)
//       : 20;

//     const safeOffset = Number.isInteger(parsedOffset) && parsedOffset >= 0
//       ? parsedOffset
//       : 0;

//     const result = await runSearch(query, {
//       catalogue,
//       category,
//       subcategory,
//       subCategory,
//       brand,
//       color,
//       size,
//       minPrice: minPrice ? Number(minPrice) : undefined,
//       maxPrice: maxPrice ? Number(maxPrice) : undefined,
//       sortBy,
//       limit: safeLimit,
//       offset: safeOffset
//     });

//     const normalisedQuery = result.normalisedQuery || query;

//     // ── Log query ─────────────────────────────────────────
//     try {
//       logQuery({
//         requestId: res.locals.requestId || null,
//         source: 'search',
//         query,
//         normalised: normalisedQuery,
//         correctedQuery: result.correctedQuery || null,
//         appliedCorrection: result.wasCorrected || false,
//         catalogue: catalogue || null,
//         category: category || null,
//         subcategory: subcategory || null,
//         subCategory: subCategory || null,
//         brand: brand || null,
//         color: color || null,
//         size: size || null,
//         results: result.totalHits || 0,
//         isFallback: result.isFallback || false,
//         processingTime: result.processingTime || 0,
//         intentFilters: result.intentFilters || null,
//         intentCleanQuery: result.intentCleanQuery || null
//       });
//     } catch (e) {
//       console.error('Log failed:', e.message);
//     }

//     // ── Log products for relevance checking ───────────────
//     try {
//       logProducts(query, result.results || [], {
//         originalQuery: query,
//         correctedQuery: result.correctedQuery || null,
//         intentFilters: result.intentFilters || null,
//         totalHits: result.totalHits || 0
//       });
//     } catch (e) {
//       console.error('Products log failed:', e.message);
//     }

//     return successResponse(res, buildSearchResponse({
//       originalQuery: query,
//       normalisedQuery,
//       correctedQuery: result.correctedQuery || null,
//       wasCorrected: result.wasCorrected || false,
//       correctionConfidence: result.correctionConfidence || null,
//       correctionSource: result.correctionSource || null,
//       intentFilters: result.intentFilters || null,
//       intentCleanQuery: result.intentCleanQuery || null,
//       totalHits: result.totalHits,
//       processingTime: result.processingTime,
//       isFallback: result.isFallback,
//       fallbackReason: result.fallbackReason,
//       limit: safeLimit,
//       offset: safeOffset,
//       results: result.results || []
//     }));

//   } catch (err) {
//     next(err);
//   }
// });

// module.exports = router;
























// const express = require('express');
// const router = express.Router();
// const { runSearch } = require('../query/queryRunner');
// const { buildSearchResponse } = require('../schemas/searchSchema');
// const { successResponse } = require('../utils/response');
// const { logQuery } = require('../utils/logger');
// const { ValidationError } = require('../utils/errors');

// // whitelist of allowed sort options
// const ALLOWED_SORT = [
//   'price:asc',
//   'price:desc',
//   'popularity:desc',
//   'popularity:asc',
//   'sales:desc',
//   'sales:asc'
// ];

// router.post('/', async (req, res, next) => {
//   const {
//     query,
//     catalogue,
//     category,
//     subcategory,
//     minPrice,
//     maxPrice,
//     sortBy,
//     limit,
//     offset
//   } = req.body;

//   try {
//     // validate — query exists
//     if (!query) {
//       return next(new ValidationError('Query is required'));
//     }

//     // validate — query must be string
//     if (typeof query !== 'string') {
//       return next(new ValidationError('Invalid query'));
//     }

//     // Fix 4 — empty string check
//     if (!query.trim()) {
//       return next(new ValidationError('Query cannot be empty'));
//     }

//     // validate — query too long
//     if (query.length > 150) {
//       return next(new ValidationError('Query too long'));
//     }

//     // validate — category fields
//     if (catalogue && typeof catalogue !== 'string') {
//       return next(new ValidationError('Invalid catalogue'));
//     }
//     if (category && typeof category !== 'string') {
//       return next(new ValidationError('Invalid category'));
//     }
//     if (subcategory && typeof subcategory !== 'string') {
//       return next(new ValidationError('Invalid subcategory'));
//     }

//     // validate — sort whitelist
//     if (sortBy && !ALLOWED_SORT.includes(sortBy)) {
//       return next(new ValidationError(
//         `Invalid sort option. Allowed: ${ALLOWED_SORT.join(', ')}`
//       ));
//     }

//     // Fix 2 — price validation
//     if (minPrice !== undefined && isNaN(Number(minPrice))) {
//       return next(new ValidationError('Invalid minPrice'));
//     }
//     if (maxPrice !== undefined && isNaN(Number(maxPrice))) {
//       return next(new ValidationError('Invalid maxPrice'));
//     }
//     if (minPrice && maxPrice && Number(minPrice) > Number(maxPrice)) {
//       return next(new ValidationError('minPrice cannot be greater than maxPrice'));
//     }

//     // Fix 1 — safe parseInt using Number()
//     const parsedLimit = Number(limit);
//     const parsedOffset = Number(offset);

//     const safeLimit = Number.isInteger(parsedLimit) && parsedLimit > 0
//       ? Math.min(parsedLimit, 50)
//       : 20;

//     const safeOffset = Number.isInteger(parsedOffset) && parsedOffset >= 0
//       ? parsedOffset
//       : 0;

//     // run search pipeline
//     const result = await runSearch(query, {
//       catalogue,
//       category,
//       subcategory,
//       minPrice: minPrice ? Number(minPrice) : undefined,
//       maxPrice: maxPrice ? Number(maxPrice) : undefined,
//       sortBy,
//       limit: safeLimit,
//       offset: safeOffset
//     });

//     // define once
//     const normalisedQuery = result.normalisedQuery || query;

//     // log every search — wrapped safely
//     try {
//       logQuery({
//         requestId: res.locals.requestId || null,
//         source: 'search',
//         query,
//         normalised: normalisedQuery,
//         correctedQuery: result.correctedQuery || null,
//         appliedCorrection: result.wasCorrected || false,
//         catalogue: catalogue || null,
//         category: category || null,
//         subcategory: subcategory || null,
//         results: result.totalHits || 0,
//         isFallback: result.isFallback || false,
//         processingTime: result.processingTime || 0
//       });
//     } catch (e) {
//       console.error('Log failed:', e.message);
//     }

//     return successResponse(res, buildSearchResponse({
//       originalQuery: query,
//       normalisedQuery,
//       correctedQuery: result.correctedQuery || null,
//       wasCorrected: result.wasCorrected || false,
//       correctionConfidence: result.correctionConfidence || null,
//       correctionSource: result.correctionSource || null,
//       totalHits: result.totalHits,
//       processingTime: result.processingTime,
//       isFallback: result.isFallback,
//       fallbackReason: result.fallbackReason,
//       limit: safeLimit,
//       offset: safeOffset,
//       results: result.results || []
//     }));

//   } catch (err) {
//     next(err);
//   }
// });

// module.exports = router;












// const express = require('express');
// const router = express.Router();
// const { runSearch } = require('../query/queryRunner');
// const { buildSearchResponse } = require('../schemas/searchSchema');
// const { successResponse } = require('../utils/response');
// const { logQuery } = require('../utils/logger');
// const { ValidationError } = require('../utils/errors');

// // whitelist of allowed sort options
// const ALLOWED_SORT = [
//   'price:asc',
//   'price:desc',
//   'popularity:desc',
//   'popularity:asc',
//   'sales:desc',
//   'sales:asc'
// ];

// router.post('/', async (req, res, next) => {
//   const {
//     query,
//     catalogue,
//     category,
//     subcategory,
//     minPrice,
//     maxPrice,
//     sortBy,
//     limit,
//     offset
//   } = req.body;

//   try {
//     // validate — query exists
//     if (!query) {
//       return next(new ValidationError('Query is required'));
//     }

//     // validate — query must be string
//     if (typeof query !== 'string') {
//       return next(new ValidationError('Invalid query'));
//     }

//     // validate — query too long
//     if (query.length > 150) {
//       return next(new ValidationError('Query too long'));
//     }

//     // validate — category fields
//     if (catalogue && typeof catalogue !== 'string') {
//       return next(new ValidationError('Invalid catalogue'));
//     }
//     if (category && typeof category !== 'string') {
//       return next(new ValidationError('Invalid category'));
//     }
//     if (subcategory && typeof subcategory !== 'string') {
//       return next(new ValidationError('Invalid subcategory'));
//     }

//     // validate — sort whitelist
//     if (sortBy && !ALLOWED_SORT.includes(sortBy)) {
//       return next(new ValidationError(
//         `Invalid sort option. Allowed: ${ALLOWED_SORT.join(', ')}`
//       ));
//     }

//     // sanitize limit and offset
//     const safeLimit = Math.min(parseInt(limit) || 20, 50);
//     const safeOffset = Math.max(parseInt(offset) || 0, 0);

//     // run search pipeline
//     const result = await runSearch(query, {
//       catalogue,
//       category,
//       subcategory,
//       minPrice,
//       maxPrice,
//       sortBy,
//       limit: safeLimit,
//       offset: safeOffset
//     });

//     // define once
//     const normalisedQuery = result.normalisedQuery || query;

//     // log every search — wrapped safely
//     try {
//       logQuery({
//         requestId: res.locals.requestId || null,
//         source: 'search',
//         query,
//         normalised: normalisedQuery,
//         correctedQuery: result.correctedQuery || null,
//         appliedCorrection: result.wasCorrected || false,
//         catalogue: catalogue || null,
//         category: category || null,
//         subcategory: subcategory || null,
//         results: result.totalHits || 0,
//         isFallback: result.isFallback || false,
//         processingTime: result.processingTime || 0
//       });
//     } catch (e) {
//       console.error('Log failed:', e.message);
//     }

//     return successResponse(res, buildSearchResponse({
//       originalQuery: query,
//       normalisedQuery,
//       totalHits: result.totalHits,
//       processingTime: result.processingTime,
//       isFallback: result.isFallback,
//       fallbackReason: result.fallbackReason,
//       limit: safeLimit,
//       offset: safeOffset,
//       results: result.results || []
//     }));

//   } catch (err) {
//     next(err);
//   }
// });

// module.exports = router;






// const express = require('express');
// const router = express.Router();
// const { runSearch } = require('../query/queryRunner');
// const { buildSearchResponse } = require('../schemas/searchSchema');
// const { successResponse, errorResponse } = require('../utils/response');

// // whitelist of allowed sort options
// const ALLOWED_SORT = [
//   'price:asc',
//   'price:desc',
//   'popularity:desc',
//   'popularity:asc',
//   'sales:desc',
//   'sales:asc'
// ];

// router.post('/', async (req, res, next) => {
//   const {
//     query,
//     catalogue,
//     category,
//     subcategory,
//     minPrice,
//     maxPrice,
//     sortBy,
//     limit,
//     offset
//   } = req.body;

//   try {
//     // validate — query exists
//     if (!query) {
//       return errorResponse(res, 'Query is required', 400);
//     }

//     // validate — query must be string
//     if (typeof query !== 'string') {
//       return errorResponse(res, 'Invalid query', 400);
//     }

//     // validate — query too long
//     if (query.length > 150) {
//       return errorResponse(res, 'Query too long', 400);
//     }

//     // validate — sort whitelist
//     if (sortBy && !ALLOWED_SORT.includes(sortBy)) {
//       return errorResponse(res, `Invalid sort option. Allowed: ${ALLOWED_SORT.join(', ')}`, 400);
//     }

//     // run search pipeline
//     const result = await runSearch(query, {
//       catalogue,
//       category,
//       subcategory,
//       minPrice,
//       maxPrice,
//       sortBy,
//       limit: limit || 20,
//       offset: offset || 0
//     });

//     return successResponse(res, buildSearchResponse({
//       originalQuery: query,
//       normalisedQuery: result.normalisedQuery || query,
//       totalHits: result.totalHits,
//       processingTime: result.processingTime,
//       isFallback: result.isFallback,
//       fallbackReason: result.fallbackReason,
//       limit: limit || 20,
//       offset: offset || 0,
//       results: result.results
//     }));

//   } catch (err) {
//     next(err);
//   }
// });

// module.exports = router;