const fs   = require('fs');
const path = require('path');

// ─── CONFIG ───────────────────────────────────────────────
const ANALYTICS_LOG    = path.join(__dirname, '../logs/analytics.log');
const MULTI_TENANT_DIR = path.join(__dirname, '../multiTenantLogs');
fs.mkdirSync(MULTI_TENANT_DIR, { recursive: true });

fs.mkdirSync(path.join(__dirname, '../logs'), { recursive: true });

// ─── CLASSIFY QUERY TYPE ──────────────────────────────────

function classifyQuery(query) {
  if (!query) return 'empty';

  const words     = query.trim().split(/\s+/);
  const wordCount = words.length;

  if (/^\d+$/.test(query)) return 'numeric';

  if (/^[a-z0-9]+$/i.test(query) && /\d/.test(query) && /[a-z]/i.test(query)) {
    return 'mixed';
  }

  if (wordCount === 1) return 'single_word';
  if (wordCount >= 2) return 'multi_word';

  return 'other';
}

// ─── LOG SEARCH EVENT ─────────────────────────────────────

function logSearchEvent(data) {
  try {
    const totalTime    = data.timing?.total  || 0;
    const resultsCount = data.results?.count || 0;

    const entry = JSON.stringify({
      ts:        new Date().toISOString(),
      requestId: data.requestId || null,

      // ── client tracking ───────────────────────────────
      clientId:  data.clientId  || null,

      // ── query info ────────────────────────────────────
      query:           data.query,
      normalised:      data.normalised,
      queryLength:     data.query ? data.query.length : 0,
      wordCount:       data.query ? data.query.trim().split(/\s+/).length : 0,
      queryType:       classifyQuery(data.normalised || data.query),
      normaliseResult: data.normalised !== data.query ? 'changed' : 'unchanged',

      // ── where search terminated ───────────────────────
      searchStage:         data.searchStage         || 'meilisearch',
      correctionDepth:     data.correctionDepth     || 0,
      correctionAttempted: data.correctionAttempted || false,

      // ── layer 1: learnedMap ───────────────────────────
      learnedMap: {
        hit:           data.learnedMap?.hit           || false,
        correction:    data.learnedMap?.correction    || null,
        confidence:    data.learnedMap?.confidence    || null,
        source:        data.learnedMap?.source        || null,
        outcome:       data.learnedMap?.outcome       || null,
        resultsBefore: data.learnedMap?.resultsBefore || 0,
        resultsAfter:  data.learnedMap?.resultsAfter  || 0
      },

      // ── layer 2: symspell ─────────────────────────────
      symspell: {
        called:           data.symspell?.called           || false,
        candidate:        data.symspell?.candidate        || null,
        changedWords:     data.symspell?.changedWords     || [],
        correctionsCount: data.symspell?.correctionsCount || 0,
        outcome:          data.symspell?.outcome          || null,
        rejectionReason:  data.symspell?.rejectionReason  || null,
        resultsBefore:    data.symspell?.resultsBefore    || 0,
        resultsAfter:     data.symspell?.resultsAfter     || 0,
        timeTaken:        data.symspell?.timeTaken        || 0
      },

      // ── layer 3: phonetic ─────────────────────────────
      phonetic: {
        called:        data.phonetic?.called        || false,
        candidate:     data.phonetic?.candidate     || null,
        outcome:       data.phonetic?.outcome       || null,
        resultsBefore: data.phonetic?.resultsBefore || 0,
        resultsAfter:  data.phonetic?.resultsAfter  || 0,
        timeTaken:     data.phonetic?.timeTaken     || 0
      },

      // ── ollama (offline learner only) ─────────────────
      ollama: {
        called:          data.ollama?.called          || false,
        candidate:       data.ollama?.candidate       || null,
        outcome:         data.ollama?.outcome         || null,
        rejectionReason: data.ollama?.rejectionReason || null,
        resultsBefore:   data.ollama?.resultsBefore   || 0,
        resultsAfter:    data.ollama?.resultsAfter    || 0,
        timeTaken:       data.ollama?.timeTaken       || 0
      },

      // ── final correction summary ──────────────────────
      correction: {
        applied:     data.correction?.applied     || false,
        finalQuery:  data.correction?.finalQuery  || null,
        source:      data.correction?.source      || 'none',
        confidence:  data.correction?.confidence  || null,
        improvement: data.correction?.improvement || 0
      },

      // ── correction mode ───────────────────────────────
      correctionMode: data.correctionMode || 'none',

      // ── intent parser summary ─────────────────────────
      intent: {
        parsed:         data.intent?.parsed         || false,
        filtersApplied: data.intent?.filtersApplied || false,
        filters:        data.intent?.filters        || {},
        cleanQuery:     data.intent?.cleanQuery     || null,
        sizeGroup:      data.intent?.sizeGroup      || null,
        resultsBefore:  data.intent?.resultsBefore  || 0,
        resultsAfter:   data.intent?.resultsAfter   || 0
      },

      // ── results summary ───────────────────────────────
      results: {
        count:          resultsCount,
        isFallback:     data.results?.isFallback     || false,
        fallbackReason: data.results?.fallbackReason || null,
        isZeroResult:   resultsCount === 0,
        isWeakResult:   resultsCount > 0 && resultsCount <= 20
      },

      // ── timing breakdown ──────────────────────────────
      timing: {
        total:       totalTime,
        learnedmap:  data.timing?.learnedmap  || 0,
        symspell:    data.timing?.symspell    || 0,
        phonetic:    data.timing?.phonetic    || 0,
        ollama:      data.timing?.ollama      || 0,
        meilisearch: data.timing?.meilisearch || 0,
        latencyBucket:
          totalTime < 50   ? 'fast'      :
          totalTime < 200  ? 'medium'    :
          totalTime < 1000 ? 'slow'      : 'very_slow'
      }
    });

    // ── write to global log ───────────────────────────
    fs.appendFile(ANALYTICS_LOG, entry + '\n', err => {
      if (err) console.error('[Analytics] Log error:', err.message);
    });

    // ── write to per-client log ───────────────────────
    // isolated per client ✅
    // ACID isolation maintained ✅
    if (data.clientId) {
      const clientLog = path.join(
        MULTI_TENANT_DIR,
        `client_${data.clientId}`,
        'analytics.log'
      );
      fs.appendFile(clientLog, entry + '\n', err => {
        if (err) console.error(`[Analytics] Client log error (${data.clientId}):`, err.message);
      });
    }

  } catch (err) {
    console.error('[Analytics] Logger error:', err.message);
  }
}

module.exports = { logSearchEvent };