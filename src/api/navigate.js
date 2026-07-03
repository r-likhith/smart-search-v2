const express = require('express');
const router = express.Router();
const { runNavigate } = require('../query/queryRunner');
const { buildNavigateResponse } = require('../schemas/searchSchema');
const { successResponse, errorResponse } = require('../utils/response');
const { isValidClient, getClientIndex } = require('../../configVendors/clientHelper');

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
    clientId: bodyClientId,  // renamed — resolved below ✅
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
    // ── ClientId resolution ───────────────────────────────
    // per-client key:  clientId injected from API key ✅
    // legacy key:      clientId comes from request body ✅
    const clientId = req.resolvedClientId || bodyClientId;

    if (!clientId) {
      return errorResponse(res,
        'clientId is required — use a per-client API key or include clientId in the request body',
        400
      );
    }
    if (!isValidClient(clientId)) {
      return errorResponse(res, `Unknown or inactive clientId: ${clientId}`, 400);
    }

    // ── Category validation ───────────────────────────────
    if (!category) {
      return errorResponse(res, 'Category is required', 400);
    }
    if (typeof category !== 'string') {
      return errorResponse(res, 'Invalid category', 400);
    }
    if (subcategory && typeof subcategory !== 'string') {
      return errorResponse(res, 'Invalid subcategory', 400);
    }
    if (subCategory && typeof subCategory !== 'string') {
      return errorResponse(res, 'Invalid subCategory', 400);
    }

    // ── Filter validation ─────────────────────────────────
    if (brand && typeof brand !== 'string') {
      return errorResponse(res, 'Invalid brand', 400);
    }
    if (color && typeof color !== 'string') {
      return errorResponse(res, 'Invalid color', 400);
    }
    if (size && typeof size !== 'string') {
      return errorResponse(res, 'Invalid size', 400);
    }
    if (minPrice !== undefined && isNaN(Number(minPrice))) {
      return errorResponse(res, 'Invalid minPrice', 400);
    }
    if (maxPrice !== undefined && isNaN(Number(maxPrice))) {
      return errorResponse(res, 'Invalid maxPrice', 400);
    }
    if (minPrice && maxPrice && Number(minPrice) > Number(maxPrice)) {
      return errorResponse(res, 'minPrice cannot be greater than maxPrice', 400);
    }
    if (sortBy && !ALLOWED_SORT.includes(sortBy)) {
      return errorResponse(res, `Invalid sort option. Allowed: ${ALLOWED_SORT.join(', ')}`, 400);
    }

    // ── Safe limit + offset ───────────────────────────────
    const parsedLimit  = Number(limit);
    const parsedOffset = Number(offset);

    const safeLimit = Number.isInteger(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, 50)
      : 20;

    const safeOffset = Number.isInteger(parsedOffset) && parsedOffset >= 0
      ? parsedOffset
      : 0;

    // ── Resolve client index ──────────────────────────────
    const meiliIndex = getClientIndex(clientId);

    // ── Run navigation ────────────────────────────────────
    const result = await runNavigate(category, subcategory, {
      clientId,
      meiliIndex,
      subCategory,
      brand,
      color,
      size,
      minPrice: minPrice ? Number(minPrice) : undefined,
      maxPrice: maxPrice ? Number(maxPrice) : undefined,
      sortBy:   sortBy || 'popularity:desc',
      limit:    safeLimit,
      offset:   safeOffset
    });

    return successResponse(res, buildNavigateResponse({
      category,
      subcategory,
      subCategory,
      totalHits:      result.totalHits,
      processingTime: result.processingTime,
      isFallback:     result.isFallback,
      fallbackReason: result.fallbackReason,
      limit:          safeLimit,
      offset:         safeOffset,
      results:        result.results
    }));

  } catch (err) {
    next(err);
  }
});

module.exports = router;


























// *********************** ALL BEFORE THE MULTI TENANT PHASE **********************************







// const express = require('express');
// const router = express.Router();
// const { runNavigate } = require('../query/queryRunner');
// const { buildNavigateResponse } = require('../schemas/searchSchema');
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
//     // validate — category exists
//     if (!category) {
//       return errorResponse(res, 'Category is required', 400);
//     }

//     // validate — category must be string
//     if (typeof category !== 'string') {
//       return errorResponse(res, 'Invalid category', 400);
//     }

//     // validate — subcategory
//     if (subcategory && typeof subcategory !== 'string') {
//       return errorResponse(res, 'Invalid subcategory', 400);
//     }

//     // validate — subCategory (L4)
//     if (subCategory && typeof subCategory !== 'string') {
//       return errorResponse(res, 'Invalid subCategory', 400);
//     }

//     // validate — new filters
//     if (brand && typeof brand !== 'string') {
//       return errorResponse(res, 'Invalid brand', 400);
//     }
//     if (color && typeof color !== 'string') {
//       return errorResponse(res, 'Invalid color', 400);
//     }
//     if (size && typeof size !== 'string') {
//       return errorResponse(res, 'Invalid size', 400);
//     }

//     // validate — price
//     if (minPrice !== undefined && isNaN(Number(minPrice))) {
//       return errorResponse(res, 'Invalid minPrice', 400);
//     }
//     if (maxPrice !== undefined && isNaN(Number(maxPrice))) {
//       return errorResponse(res, 'Invalid maxPrice', 400);
//     }
//     if (minPrice && maxPrice && Number(minPrice) > Number(maxPrice)) {
//       return errorResponse(res, 'minPrice cannot be greater than maxPrice', 400);
//     }

//     // validate — sort whitelist
//     if (sortBy && !ALLOWED_SORT.includes(sortBy)) {
//       return errorResponse(res, `Invalid sort option. Allowed: ${ALLOWED_SORT.join(', ')}`, 400);
//     }

//     // safe limit + offset
//     const parsedLimit = Number(limit);
//     const parsedOffset = Number(offset);

//     const safeLimit = Number.isInteger(parsedLimit) && parsedLimit > 0
//       ? Math.min(parsedLimit, 50)
//       : 20;

//     const safeOffset = Number.isInteger(parsedOffset) && parsedOffset >= 0
//       ? parsedOffset
//       : 0;

//     // run navigation
//     const result = await runNavigate(category, subcategory, {
//       subCategory,
//       brand,
//       color,
//       size,
//       minPrice: minPrice ? Number(minPrice) : undefined,
//       maxPrice: maxPrice ? Number(maxPrice) : undefined,
//       sortBy: sortBy || 'popularity:desc',
//       limit: safeLimit,
//       offset: safeOffset
//     });

//     return successResponse(res, buildNavigateResponse({
//       category,
//       subcategory,
//       subCategory,
//       totalHits: result.totalHits,
//       processingTime: result.processingTime,
//       isFallback: result.isFallback,
//       fallbackReason: result.fallbackReason,
//       limit: safeLimit,
//       offset: safeOffset,
//       results: result.results
//     }));

//   } catch (err) {
//     next(err);
//   }
// });

// module.exports = router;




























// const express = require('express');
// const router = express.Router();
// const { runNavigate } = require('../query/queryRunner');
// const { buildNavigateResponse } = require('../schemas/searchSchema');
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
//   const { category, subcategory, sortBy, limit, offset } = req.body;

//   try {
//     // validate — category exists
//     if (!category) {
//       return errorResponse(res, 'Category is required', 400);
//     }

//     // validate — category must be string
//     if (typeof category !== 'string') {
//       return errorResponse(res, 'Invalid category', 400);
//     }

//     // validate — subcategory must be string if provided
//     if (subcategory && typeof subcategory !== 'string') {
//       return errorResponse(res, 'Invalid subcategory', 400);
//     }

//     // validate — sort whitelist
//     if (sortBy && !ALLOWED_SORT.includes(sortBy)) {
//       return errorResponse(res, `Invalid sort option. Allowed: ${ALLOWED_SORT.join(', ')}`, 400);
//     }

//     // run navigation
//     const result = await runNavigate(category, subcategory, {
//       sortBy: sortBy || 'popularity:desc',
//       limit: limit || 20,
//       offset: offset || 0
//     });

//     return successResponse(res, buildNavigateResponse({
//       category,
//       subcategory,
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