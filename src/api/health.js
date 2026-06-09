const express = require('express');
const router = express.Router();
const client = require('../meilisearch/client');
const { successResponse, errorResponse } = require('../utils/response');

router.get('/', async (req, res, next) => {
  const start = Date.now();

  try {
    // cleaner try/catch instead of .then().catch()
    let meiliHealth = 'disconnected';
    try {
      await client.health();
      meiliHealth = 'connected';
    } catch {}

    const allHealthy = meiliHealth === 'connected';

    return successResponse(res, {
      status: allHealthy ? 'healthy' : 'degraded',
      services: {
        meilisearch: meiliHealth
      },
      processingTime: Date.now() - start,
      uptime: Math.floor(process.uptime())
    });

  } catch (err) {
    next(err);
  }
});

module.exports = router;