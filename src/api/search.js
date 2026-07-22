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
    clientId: bodyClientId,  // renamed — resolved below ✅
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

    // ── ClientId resolution ───────────────────────────────
    // per-client key:  clientId injected from API key (req.resolvedClientId) ✅
    // legacy key:      clientId comes from request body (backward compat) ✅
    // per-client key + mismatched body clientId: already rejected by checkApiKey ✅
    const clientId = req.resolvedClientId || bodyClientId;

    if (!clientId) {
      return next(new ValidationError(
        'clientId is required — use a per-client API key or include clientId in the request body'
      ));
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
    const clientScope = getClientScope(clientId);

    const result = await runSearch(query, {
      clientId,
      clientScope,
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
        smartSearchEnabled:   true, // always true when this log fires ✅
        query,
        normalised:           normalisedQuery,
        correctedQuery:       result.correctedQuery       || null,
        appliedCorrection:    result.wasCorrected         || false,
        correctionSource:     result.correctionSource     || null,
        correctionMode:       result.correctionMode       || 'none',
        correctionConfidence: result.correctionConfidence || null,
        catalogue:            catalogue    || null,
        category:             category     || null,
        subcategory:          subcategory  || null,
        subCategory:          subCategory  || null,
        brand:                brand        || null,
        color:                color        || null,
        size:                 size         || null,
        results:              result.totalHits    || 0,
        isFallback:           result.isFallback   || false,
        fallbackReason:       result.fallbackReason || null,
        processingTime:       result.processingTime || 0,
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
      correctedQuery:       result.correctedQuery       || null,
      wasCorrected:         result.wasCorrected         || false,
      correctionConfidence: result.correctionConfidence || null,
      correctionSource:     result.correctionSource     || null,
      displayQuery:         result.displayQuery         || null,
      retrievalQuery:       result.retrievalQuery       || null,
      correctionMode:       result.correctionMode       || 'none',
      ui:                   result.ui                   || null,
      intentFilters:        result.intentFilters        || null,
      intentCleanQuery:     result.intentCleanQuery     || null,
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

