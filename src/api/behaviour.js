const express = require('express');
const router = express.Router();
const { recordClick, getClickStats, getLearnableCorrections } = require('../behaviour/tracker');
const { triggerBuildSafe, showPending } = require('../behaviour/builder');
const { getBuildState } = require('../behaviour/buildState');
const { successResponse } = require('../utils/response');
const { ValidationError } = require('../utils/errors');
const { isValidClient, getClientScope } = require('../../configVendors/clientHelper');

// ─── POST /api/behaviour/click ────────────────────────────

router.post('/click', async (req, res, next) => {
  try {
    const {
      query,
      productId,
      productName,
      category,
      subcategory,
      clientId,
      originalResultCount  // ← how many results the search returned ✅
    } = req.body;

    // full payload validation
    if (!query) return next(new ValidationError('query is required'));
    if (typeof query !== 'string') return next(new ValidationError('query must be a string'));
    if (query.length > 150) return next(new ValidationError('query too long'));

    if (!productId) return next(new ValidationError('productId is required'));
    if (typeof productId !== 'string') return next(new ValidationError('productId must be a string'));

    if (productName && typeof productName !== 'string') {
      return next(new ValidationError('productName must be a string'));
    }
    if (productName && productName.length > 200) {
      return next(new ValidationError('productName too long'));
    }

    if (category && typeof category !== 'string') {
      return next(new ValidationError('invalid category'));
    }
    if (subcategory && typeof subcategory !== 'string') {
      return next(new ValidationError('invalid subcategory'));
    }

    // clientId optional but recommended ✅
    // enables per-client click tracking ✅
    // enables scope context for promotions ✅
    const clientScope = clientId ? getClientScope(clientId) : null;

    const result = recordClick({
      query,
      productId,
      productName,
      category,
      subcategory,
      clientId:    clientId    || null,
      clientScope:         clientScope         || null,
      requestId:           res.locals.requestId || null,
      originalResultCount: typeof originalResultCount === 'number'
        ? originalResultCount : null  // ← passed to tracker ✅
    });

    return successResponse(res, {
      recorded: result.recorded,
      isFirst:  result.isFirst  || false,
      reason:   result.reason   || null
    });

  } catch (err) {
    next(err);
  }
});

// ─── GET /api/behaviour/stats ─────────────────────────────

router.get('/stats', async (req, res, next) => {
  try {
    const stats = getClickStats();
    return successResponse(res, stats);
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/behaviour/build ────────────────────────────
// updated to use triggerBuildSafe — prevents concurrent builds

router.post('/build', async (req, res, next) => {
  try {
    const result = await triggerBuildSafe();
    return successResponse(res, {
      built:   result.built,
      skipped: result.skipped,
      message: result.reason === 'already running'
        ? 'Builder already running — try again shortly'
        : `Built ${result.built} corrections from click data`
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/behaviour/pending ───────────────────────────

router.get('/pending', async (req, res, next) => {
  try {
    const corrections = getLearnableCorrections();
    return successResponse(res, {
      count:       corrections.length,
      corrections
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/behaviour/buildstate ───────────────────────

router.get('/buildstate', async (req, res, next) => {
  try {
    const buildState = getBuildState();
    return successResponse(res, buildState);
  } catch (err) {
    next(err);
  }
});

module.exports = router;