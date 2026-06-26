// *********************** ollama removed below from code as direct use  **********************************

const { normalise } = require('./normalise');
const {
  searchProducts,
  getSuggestions,
  navigateCategory,
  getPopularProducts
} = require('../meilisearch/searcher');
const {
  applyCorrection,
  saveCorrection,
  penaliseCorrection
} = require('../learned/learnedMap');
const suggestMapModule = require('../learned/suggestMap');
const { correctQuery: symspellCorrectQuery, getStatus: getSymSpellStatus } = require('../spellcheck/symspell');
const { correctQuery: phoneticCorrectQuery, getStatus: getPhoneticStatus } = require('../spellcheck/phonetic');
const { logSearchEvent } = require('../../analytics/logger');
const { parseIntent, hasFilters } = require('./intentParser');
const features = require('../searchBanners/features');

// ─── CONFIG ───────────────────────────────────────────────
const MIN_RESULTS_TO_LEARN   = 5;
const MIN_IMPROVEMENT        = 5;
const WEAK_RESULTS_THRESHOLD = 20;
const MAX_RESULTS_LIMIT      = 1000;
const MIN_SUGGEST_RESULTS    = 3;   // threshold for suggest repair ✅

// ─── SAFE SAVE ────────────────────────────────────────────

function safeSaveCorrection(query, corrected, source, hitCount) {
  try {
    const chainCheck = applyCorrection(corrected);
    if (chainCheck.corrected) {
      console.log(`[SafeSave] Chain detected — skipped: "${corrected}" → "${chainCheck.query}"`);
      return;
    }
    saveCorrection(query, corrected, source, hitCount);
  } catch (e) {
    console.error('saveCorrection error:', e.message);
  }
}

// ─── RESULTS HELPER ───────────────────────────────────────

function buildResultsAnalytics(totalHits, isFallback = false, fallbackReason = null) {
  return {
    count: totalHits,
    isFallback,
    fallbackReason,
    isZeroResult: totalHits === 0,
    isWeakResult: totalHits > 0 && totalHits <= WEAK_RESULTS_THRESHOLD
  };
}

// ─── BUILD UI HINTS ───────────────────────────────────────

function buildUI(displayQuery, correctionMode) {
  return {
    showBanner:         features.correctionBanner     && displayQuery !== null,
    silentInputRewrite: features.silentInputCorrection && displayQuery !== null,
    allowSearchInstead: features.searchInsteadLink    && displayQuery !== null,
    correctionMode
  };
}

// ─── APPLY INTENT FILTERS ────────────────────────────────

async function applyIntentIfNeeded(intent, query, normalised, options, currentResults, startTime, analytics) {
  if (!hasFilters(intent)) return null;

  const filteredOptions = { ...options };
  if (intent.filters.category)  filteredOptions.category  = intent.filters.category;
  if (intent.filters.color)     filteredOptions.color     = intent.filters.color;
  if (intent.filters.brand)     filteredOptions.brand     = intent.filters.brand;
  if (intent.filters.minPrice)  filteredOptions.minPrice  = intent.filters.minPrice;
  if (intent.filters.maxPrice)  filteredOptions.maxPrice  = intent.filters.maxPrice;
  if (intent.sizeGroup)         filteredOptions.size      = intent.sizeGroup;

  const cleanQuery      = intent.cleanQuery || normalised;
  const filteredResults = await searchProducts(cleanQuery, filteredOptions);

  console.log(`[Intent] "${query}" → "${cleanQuery}" filters:${JSON.stringify(intent.filters)} sizeGroup:${intent.sizeGroup ? 'yes' : 'no'} results:${filteredResults.totalHits}`);

  analytics.intent = {
    parsed:          true,
    filtersApplied:  filteredResults.totalHits >= 1,
    filters:         intent.filters,
    cleanQuery,
    sizeGroup:       intent.sizeGroup || null,
    resultsBefore:   currentResults?.totalHits || 0,
    resultsAfter:    filteredResults.totalHits
  };

  if (filteredResults.totalHits >= 1) {
    const intentFiltersWithSize = {
      ...intent.filters,
      ...(intent.sizeGroup ? { sizeGroup: intent.sizeGroup } : {})
    };
    const normalisedOriginal      = normalise(query);
    const originalWords           = normalisedOriginal.split(/\s+/);
    const cleanWords              = (cleanQuery || '').split(/\s+/);
    const allCleanWordsInOriginal = cleanWords.every(w => originalWords.includes(w));
    const intentCorrected         = (
      cleanQuery &&
      cleanQuery !== normalisedOriginal &&
      !allCleanWordsInOriginal
    ) ? normalised : null;

    analytics.correctionMode = intentCorrected ? 'full' : analytics.correctionMode || 'none';

    return {
      originalQuery:        query,
      normalisedQuery:      normalised,
      retrievalQuery:       cleanQuery,
      displayQuery:         intentCorrected,
      correctedQuery:       intentCorrected,
      wasCorrected:         intentCorrected !== null,
      correctionConfidence: intentCorrected ? 1.0 : null,
      correctionSource:     intentCorrected ? 'intent' : null,
      correctionMode:       intentCorrected ? 'full' : 'none',
      intentFilters:        intentFiltersWithSize,
      intentCleanQuery:     cleanQuery,
      results:              filteredResults.hits,
      totalHits:            filteredResults.totalHits,
      processingTime:       Date.now() - startTime,
      isFallback:           false,
      ui:                   buildUI(intentCorrected, intentCorrected ? 'full' : 'none')
    };
  }

  // filtered returned 0 — try symspell ✅
  console.log(`[Intent] Filtered returned 0 — trying symspell on cleanQuery "${cleanQuery}"`);
  if (getSymSpellStatus().ready) {
    const symResult = symspellCorrectQuery(cleanQuery);
    if (symResult && symResult.corrected !== cleanQuery) {
      const symClean           = symResult.corrected;
      const symFilteredResults = await searchProducts(symClean, filteredOptions);
      if (symFilteredResults.totalHits >= 1) {
        const intentFiltersWithSize = {
          ...intent.filters,
          ...(intent.sizeGroup ? { sizeGroup: intent.sizeGroup } : {})
        };
        analytics.intent.filtersApplied = true;
        analytics.intent.resultsAfter   = symFilteredResults.totalHits;
        analytics.correctionMode        = 'full';
        return {
          originalQuery:        query,
          normalisedQuery:      normalised,
          retrievalQuery:       symClean,
          displayQuery:         symClean,
          correctedQuery:       symClean,
          wasCorrected:         true,
          correctionConfidence: 0.85,
          correctionSource:     'symspell+intent',
          correctionMode:       'full',
          intentFilters:        intentFiltersWithSize,
          intentCleanQuery:     symClean,
          results:              symFilteredResults.hits,
          totalHits:            symFilteredResults.totalHits,
          processingTime:       Date.now() - startTime,
          isFallback:           false,
          ui:                   buildUI(symClean, 'full')
        };
      }
    }
  }

  // symspell failed — try phonetic ✅
  if (getPhoneticStatus().ready) {
    const phonResult = phoneticCorrectQuery(cleanQuery);
    if (phonResult && phonResult.corrected !== cleanQuery) {
      const phonClean           = phonResult.corrected;
      const phonFilteredResults = await searchProducts(phonClean, filteredOptions);
      if (phonFilteredResults.totalHits >= 1) {
        const intentFiltersWithSize = {
          ...intent.filters,
          ...(intent.sizeGroup ? { sizeGroup: intent.sizeGroup } : {})
        };
        analytics.intent.filtersApplied = true;
        analytics.intent.resultsAfter   = phonFilteredResults.totalHits;
        analytics.correctionMode        = 'full';
        safeSaveCorrection(cleanQuery, phonClean, 'phonetic+intent', phonFilteredResults.hits.length);
        return {
          originalQuery:        query,
          normalisedQuery:      normalised,
          retrievalQuery:       phonClean,
          displayQuery:         phonClean,
          correctedQuery:       phonClean,
          wasCorrected:         true,
          correctionConfidence: 0.80,
          correctionSource:     'phonetic+intent',
          correctionMode:       'full',
          intentFilters:        intentFiltersWithSize,
          intentCleanQuery:     phonClean,
          results:              phonFilteredResults.hits,
          totalHits:            phonFilteredResults.totalHits,
          processingTime:       Date.now() - startTime,
          isFallback:           false,
          ui:                   buildUI(phonClean, 'full')
        };
      }
    }
  }

  console.log(`[Intent] Filtered returned 0 → using unfiltered`);
  return null;
}

// ─── SEARCH ───────────────────────────────────────────────

async function runSearch(query, options = {}) {
  const startTime = Date.now();

  const analytics = {
    requestId:            options.requestId || null,
    clientId:             options.clientId  || null,
    query,
    normalised:           null,
    searchStage:          'meilisearch',
    correctionDepth:      0,
    correctionAttempted:  false,
    correctionMode:       'none',
    learnedMap:  { hit: false },
    symspell:    { called: false },
    phonetic:    { called: false },
    correction:  { applied: false },
    intent:      { parsed: false, filtersApplied: false, filters: {}, cleanQuery: null },
    results:     { count: 0, isFallback: false },
    timing:      { total: 0, symspell: 0, phonetic: 0, meilisearch: 0, learnedmap: 0 }
  };

  // Step 1 — normalise
  const normalised = normalise(query);
  analytics.normalised = normalised;
  if (!normalised) return buildEmptyResponse(query);

  const intent = parseIntent(query);

  // Step 2 — learnedMap
  const learnedMapStart = Date.now();
  const correction = applyCorrection(query, null, {
    clientId:    options.clientId    || null,
    clientScope: options.clientScope || null
  });
  analytics.timing.learnedmap = Date.now() - learnedMapStart;

  const searchQuery  = correction.corrected ? correction.query : normalised;
  const wasCorrected = correction.corrected;

  if (wasCorrected) {
    analytics.correctionAttempted = true;
    analytics.learnedMap = {
      hit:        true,
      correction: correction.query,
      confidence: correction.confidence || null,
      source:     correction.source     || null,
      outcome:    'pending'
    };
  }

  // Step 3 — search Meilisearch
  const meilisearchStart = Date.now();
  const results          = await searchProducts(searchQuery, options);
  analytics.timing.meilisearch = Date.now() - meilisearchStart;

  // Step 4 — learnedMap validation
  if (wasCorrected) {
    if (results.hits.length === 0) {
      analytics.learnedMap.outcome      = 'zero_results';
      analytics.learnedMap.resultsBefore = 0;

      const symspellResult = await trySymSpellCorrection(
        query, normalised, options, startTime, null, analytics, intent
      );
      if (symspellResult && symspellResult !== 'SYMSPELL_NOT_BETTER') {
        analytics.results = buildResultsAnalytics(symspellResult.totalHits);
        fireAnalytics(analytics, symspellResult, startTime);
        return symspellResult;
      }

      const phoneticResult = await tryPhoneticCorrection(
        query, normalised, options, startTime, null, analytics, intent, symspellResult
      );
      if (phoneticResult) {
        analytics.results = buildResultsAnalytics(phoneticResult.totalHits);
        fireAnalytics(analytics, phoneticResult, startTime);
        return phoneticResult;
      }

      const popular = await getPopularProducts(10, options.meiliIndex);
      analytics.searchStage = 'fallback';
      analytics.results     = buildResultsAnalytics(popular.length, true, 'no results found');
      fireAnalytics(analytics, null, startTime);
      return {
        originalQuery:   query,       normalisedQuery:  normalised,
        retrievalQuery:  normalised,  displayQuery:     null,
        correctedQuery:  null,        wasCorrected:     false,
        correctionConfidence: null,   correctionSource: null,
        correctionMode:  'none',
        results:         popular,     totalHits:        popular.length,
        processingTime:  Date.now() - startTime,
        isFallback:      true,        fallbackReason:   'no results found',
        ui:              buildUI(null, 'none')
      };
    }

    const originalResults = await searchProducts(normalised, options);

    if (results.totalHits < originalResults.totalHits) {
      console.log(`[Layer1] "${query}" → "${searchQuery}" blocked`);
      analytics.learnedMap.outcome      = 'penalised';
      analytics.learnedMap.resultsBefore = originalResults.totalHits;
      analytics.learnedMap.resultsAfter  = results.totalHits;
      try {
        penaliseCorrection(query, {
          clientId:    options.clientId    || null,
          clientScope: options.clientScope || null
        });
      } catch (e) {}

      const response = {
        originalQuery:   query,       normalisedQuery:  normalised,
        retrievalQuery:  normalised,  displayQuery:     null,
        correctedQuery:  null,        wasCorrected:     false,
        correctionConfidence: null,   correctionSource: null,
        correctionMode:  'none',
        results:         originalResults.hits,
        totalHits:       originalResults.totalHits,
        processingTime:  Date.now() - startTime,
        isFallback:      false,
        ui:              buildUI(null, 'none')
      };
      analytics.searchStage = 'learnedmap';
      analytics.results     = buildResultsAnalytics(originalResults.totalHits);
      fireAnalytics(analytics, response, startTime);
      return response;
    }

    if (
      results.hits.length >= MIN_RESULTS_TO_LEARN &&
      results.totalHits >= originalResults.totalHits + MIN_IMPROVEMENT
    ) {
      safeSaveCorrection(query, searchQuery, correction.source || 'manual', results.hits.length);
    }

    analytics.learnedMap.outcome      = 'accepted';
    analytics.learnedMap.resultsBefore = originalResults.totalHits;
    analytics.learnedMap.resultsAfter  = results.totalHits;
    analytics.searchStage             = 'learnedmap';
    analytics.correctionDepth         = 1;
    analytics.correctionMode          = 'full';
    analytics.correction = {
      applied:     true,
      finalQuery:  searchQuery,
      source:      correction.source || 'manual',
      confidence:  correction.confidence || null,
      improvement: results.totalHits - originalResults.totalHits
    };

    const lmReparsed     = parseIntent(searchQuery);
    const lmActiveIntent = hasFilters(lmReparsed) ? lmReparsed : intent;
    const intentResult4  = await applyIntentIfNeeded(
      lmActiveIntent, query, searchQuery, options, results, startTime, analytics
    );
    if (intentResult4) {
      analytics.results = buildResultsAnalytics(intentResult4.totalHits);
      fireAnalytics(analytics, intentResult4, startTime);
      return intentResult4;
    }

    const response = {
      originalQuery:        query,
      normalisedQuery:      normalised,
      retrievalQuery:       searchQuery,
      displayQuery:         searchQuery,
      correctedQuery:       searchQuery,
      wasCorrected:         true,
      correctionConfidence: correction.confidence || null,
      correctionSource:     correction.source     || null,
      correctionMode:       'full',
      results:              results.hits,
      totalHits:            results.totalHits,
      processingTime:       Date.now() - startTime,
      isFallback:           false,
      ui:                   buildUI(searchQuery, 'full')
    };
    analytics.results = buildResultsAnalytics(results.totalHits);
    fireAnalytics(analytics, response, startTime);
    return response;
  }

  // Step 5 — zero results
  if (results.totalHits === 0) {
    const symspellResult = await trySymSpellCorrection(
      query, normalised, options, startTime, null, analytics, intent
    );
    if (symspellResult && symspellResult !== 'SYMSPELL_NOT_BETTER') {
      analytics.results = buildResultsAnalytics(symspellResult.totalHits);
      fireAnalytics(analytics, symspellResult, startTime);
      return symspellResult;
    }

    const phoneticResult = await tryPhoneticCorrection(
      query, normalised, options, startTime, null, analytics, intent, symspellResult
    );
    if (phoneticResult) {
      analytics.results = buildResultsAnalytics(phoneticResult.totalHits);
      fireAnalytics(analytics, phoneticResult, startTime);
      return phoneticResult;
    }

    const popular = await getPopularProducts(10, options.meiliIndex);
    analytics.searchStage = 'fallback';
    analytics.results     = buildResultsAnalytics(popular.length, true, 'no results found');
    fireAnalytics(analytics, null, startTime);
    return {
      originalQuery:   query,      normalisedQuery:  normalised,
      retrievalQuery:  normalised, displayQuery:     null,
      correctedQuery:  null,       wasCorrected:     false,
      correctionConfidence: null,  correctionSource: null,
      correctionMode:  'none',
      results:         popular,    totalHits:        popular.length,
      processingTime:  Date.now() - startTime,
      isFallback:      true,       fallbackReason:   'no results found',
      ui:              buildUI(null, 'none')
    };
  }

  // Step 6 — weak results
  if (results.totalHits < WEAK_RESULTS_THRESHOLD) {

    const abbCorrection = applyCorrection(query, 0, {
      clientId:    options.clientId    || null,
      clientScope: options.clientScope || null
    });
    if (abbCorrection.corrected) {
      const abbResults = await searchProducts(abbCorrection.query, options);
      if (
        abbResults.hits.length >= MIN_RESULTS_TO_LEARN &&
        abbResults.totalHits > results.totalHits
      ) {
        safeSaveCorrection(query, abbCorrection.query, abbCorrection.source || 'manual', abbResults.hits.length);
        analytics.searchStage     = 'learnedmap';
        analytics.correctionDepth = 1;
        analytics.correctionMode  = 'full';
        analytics.learnedMap = {
          hit:           true,
          correction:    abbCorrection.query,
          outcome:       'accepted',
          resultsBefore: results.totalHits,
          resultsAfter:  abbResults.totalHits
        };
        analytics.correction = {
          applied:     true,
          finalQuery:  abbCorrection.query,
          source:      abbCorrection.source || 'manual',
          confidence:  abbCorrection.confidence || null,
          improvement: abbResults.totalHits - results.totalHits
        };

        const abbReparsed      = parseIntent(abbCorrection.query);
        const abbActiveIntent  = hasFilters(abbReparsed) ? abbReparsed : intent;
        const intentResult6abb = await applyIntentIfNeeded(
          abbActiveIntent, query, abbCorrection.query, options, abbResults, startTime, analytics
        );
        if (intentResult6abb) {
          analytics.results = buildResultsAnalytics(intentResult6abb.totalHits);
          fireAnalytics(analytics, intentResult6abb, startTime);
          return intentResult6abb;
        }

        const response = {
          originalQuery:        query,
          normalisedQuery:      normalised,
          retrievalQuery:       abbCorrection.query,
          displayQuery:         abbCorrection.query,
          correctedQuery:       abbCorrection.query,
          wasCorrected:         true,
          correctionConfidence: abbCorrection.confidence || null,
          correctionSource:     abbCorrection.source     || null,
          correctionMode:       'full',
          results:              abbResults.hits,
          totalHits:            abbResults.totalHits,
          processingTime:       Date.now() - startTime,
          isFallback:           false,
          ui:                   buildUI(abbCorrection.query, 'full')
        };
        analytics.results = buildResultsAnalytics(abbResults.totalHits);
        fireAnalytics(analytics, response, startTime);
        return response;
      }
    }

    const symspellResult = await trySymSpellCorrection(
      query, normalised, options, startTime, results, analytics, intent
    );
    if (symspellResult && symspellResult !== 'SYMSPELL_NOT_BETTER') {
      analytics.results = buildResultsAnalytics(symspellResult.totalHits);
      fireAnalytics(analytics, symspellResult, startTime);
      return symspellResult;
    }

    const phoneticResult = await tryPhoneticCorrection(
      query, normalised, options, startTime, results, analytics, intent, symspellResult
    );
    if (phoneticResult) {
      analytics.results = buildResultsAnalytics(phoneticResult.totalHits);
      fireAnalytics(analytics, phoneticResult, startTime);
      return phoneticResult;
    }
  }

  // Step 7 — good results + cosmetic correction
  analytics.searchStage     = 'meilisearch';
  analytics.correctionDepth = 0;

  let activeIntent7 = intent;
  if (intent && hasFilters(intent) && getSymSpellStatus().ready) {
    const symOnFull = symspellCorrectQuery(query);
    if (symOnFull && symOnFull.corrected !== normalised && symOnFull.correctionsApplied > 0) {
      const reparsed = parseIntent(symOnFull.corrected);
      if (hasFilters(reparsed) && reparsed.cleanQuery !== intent.cleanQuery) {
        activeIntent7 = reparsed;
        console.log(`[Step7] Reparsed intent: "${query}" → "${symOnFull.corrected}"`);
      }
    }
  }
  const intentResult = await applyIntentIfNeeded(
    activeIntent7, query, normalised, options, results, startTime, analytics
  );
  if (intentResult) {
    analytics.results = buildResultsAnalytics(intentResult.totalHits);
    fireAnalytics(analytics, intentResult, startTime);
    return intentResult;
  }

  // ── cosmetic correction ────────────────────────────────
  let displayQuery      = null;
  let correctionMode    = 'none';
  let displaySource     = null;
  let displayConfidence = null;

  if (features.cosmeticCorrection) {
    if (!displayQuery && getSymSpellStatus().ready) {
      const symCheck = symspellCorrectQuery(normalised);
      if (symCheck) {
        displayQuery      = symCheck.corrected;
        displaySource     = 'symspell';
        displayConfidence = 0.85;
        correctionMode    = 'assisted';
        analytics.correctionMode = 'assisted';
        console.log(`[Cosmetic] "${normalised}" → "${displayQuery}" (symspell)`);
      }
    }
    if (!displayQuery && getPhoneticStatus().ready) {
      const phonCheck = phoneticCorrectQuery(normalised);
      if (phonCheck) {
        displayQuery      = phonCheck.corrected;
        displaySource     = 'phonetic';
        displayConfidence = 0.80;
        correctionMode    = 'assisted';
        analytics.correctionMode = 'assisted';
        console.log(`[Cosmetic] "${normalised}" → "${displayQuery}" (phonetic)`);
      }
    }
  }

  analytics.results = buildResultsAnalytics(results.totalHits);
  const response = {
    originalQuery:        query,
    normalisedQuery:      normalised,
    retrievalQuery:       normalised,
    displayQuery:         displayQuery,
    correctedQuery:       displayQuery,
    wasCorrected:         displayQuery !== null,
    correctionConfidence: displayConfidence,
    correctionSource:     displaySource,
    correctionMode,
    results:              results.hits,
    totalHits:            results.totalHits,
    processingTime:       Date.now() - startTime,
    isFallback:           false,
    ui:                   buildUI(displayQuery, correctionMode)
  };
  fireAnalytics(analytics, response, startTime);
  return response;
}

// ─── FIRE ANALYTICS ───────────────────────────────────────

function fireAnalytics(analytics, response, startTime) {
  try {
    analytics.timing.total = Date.now() - startTime;
    logSearchEvent(analytics);
  } catch (e) {}
}

// ─── SYMSPELL CORRECTION HELPER ───────────────────────────

async function trySymSpellCorrection(query, normalised, options, startTime, originalResults = null, analytics = {}, intent = null) {
  try {
    if (!getSymSpellStatus().ready) return null;

    const symStart       = Date.now();
    const symspellResult = symspellCorrectQuery(query);
    const symTime        = Date.now() - symStart;

    analytics.correctionAttempted = true;
    analytics.symspell = {
      called: true, timeTaken: symTime,
      candidate: null, outcome: 'skipped'
    };
    analytics.timing.symspell = symTime;

    if (!symspellResult) return null;

    const corrected = symspellResult.corrected;
    analytics.symspell.candidate        = corrected;
    analytics.symspell.changedWords     = symspellResult.changedWords || [];
    analytics.symspell.correctionsCount = symspellResult.correctionsApplied || 0;

    if (corrected === normalised) {
      analytics.symspell.outcome = 'same_as_original';
      return null;
    }

    const correctedResults = await searchProducts(corrected, options);
    analytics.symspell.resultsBefore = originalResults?.totalHits || 0;
    analytics.symspell.resultsAfter  = correctedResults.totalHits;

    const isImprovement = correctedResults.totalHits > (originalResults?.totalHits || 0);
    if (correctedResults.hits.length < MIN_RESULTS_TO_LEARN && !isImprovement) {
      analytics.symspell.outcome         = 'rejected_no_results';
      analytics.symspell.rejectionReason = `only ${correctedResults.hits.length} results`;
      return null;
    }

    const originalAtLimit = originalResults?.totalHits >= MAX_RESULTS_LIMIT;
    if (!originalAtLimit && originalResults && correctedResults.totalHits <= originalResults.totalHits) {
      analytics.symspell.outcome         = 'rejected_not_better';
      analytics.symspell.rejectionReason = `${correctedResults.totalHits} <= ${originalResults.totalHits}`;
      return 'SYMSPELL_NOT_BETTER';
    }

    analytics.symspell.outcome    = 'accepted';
    analytics.searchStage         = 'symspell';
    analytics.correctionDepth     = 2;
    analytics.correctionMode      = 'full';
    analytics.correction = {
      applied: true, finalQuery: corrected,
      source: 'symspell', confidence: 0.85,
      improvement: correctedResults.totalHits - (originalResults?.totalHits || 0)
    };

    safeSaveCorrection(query, corrected, 'symspell', correctedResults.hits.length);

    const correctedIntent = parseIntent(corrected);
    const activeIntent    = hasFilters(correctedIntent) ? correctedIntent : intent;
    if (activeIntent && hasFilters(activeIntent)) {
      const intentResult = await applyIntentIfNeeded(
        activeIntent, query, corrected, options, correctedResults, startTime, analytics
      );
      if (intentResult) return intentResult;
    }

    return {
      originalQuery:        query,
      normalisedQuery:      normalised,
      retrievalQuery:       corrected,
      displayQuery:         corrected,
      correctedQuery:       corrected,
      wasCorrected:         true,
      correctionConfidence: 0.85,
      correctionSource:     'symspell',
      correctionMode:       'full',
      results:              correctedResults.hits,
      totalHits:            correctedResults.totalHits,
      processingTime:       Date.now() - startTime,
      isFallback:           false,
      ui:                   buildUI(corrected, 'full')
    };

  } catch (err) {
    console.error('trySymSpellCorrection error:', err.message);
    return null;
  }
}

// ─── PHONETIC CORRECTION HELPER ───────────────────────────

async function tryPhoneticCorrection(query, normalised, options, startTime, originalResults = null, analytics = {}, intent = null, symspellResult = null) {
  try {
    if (!getPhoneticStatus().ready) return null;

    if (symspellResult && symspellResult !== null) return null;

    const phonStart  = Date.now();
    const phonResult = phoneticCorrectQuery(query);
    const phonTime   = Date.now() - phonStart;

    analytics.phonetic = {
      called:     true,
      timeTaken:  phonTime,
      candidate:  null,
      outcome:    'skipped',
      confidence: null,   // ← logged after correction ✅
      margin:     null    // ← logged after correction ✅
    };
    analytics.timing.phonetic = phonTime;

    if (!phonResult) {
      analytics.phonetic.outcome = 'no_candidate';
      return null;
    }

    // log confidence + margin for observability ✅
    // don't gate on margin yet — observe distributions first ✅
    analytics.phonetic.confidence = phonResult.confidence || null;
    analytics.phonetic.margin     = phonResult.margin     || null;
    analytics.phonetic.runnerUp   = phonResult.changes?.[0]?.runnerUp || null;

    // confidence gate ✅
    if (phonResult.confidence && phonResult.confidence < 0.60) {
      analytics.phonetic.outcome = 'low_confidence';
      console.log(`[Phonetic] Low confidence (${phonResult.confidence}) — skipped`);
      return null;
    }

    // ── multi-candidate validation ─────────────────────
    // get top 3 candidates + validate each against Meili ✅
    // pick candidate with most results ✅
    // same philosophy as Groq validator ✅
    const { getTopCandidates } = require('../spellcheck/phonetic');
    const queryWords = query.toLowerCase().trim().split(/\s+/);
    const firstWord  = queryWords[0];
    const topCands   = getTopCandidates(firstWord, 3);

    let bestCorrected   = phonResult.corrected;
    let bestHits        = 0;

    if (topCands.length > 1) {
      for (const cand of topCands) {
        const candQuery   = queryWords.length > 1
          ? [cand.word, ...queryWords.slice(1)].join(' ')
          : cand.word;
        const candResults = await searchProducts(candQuery, options);
        if (candResults.totalHits > bestHits) {
          bestHits      = candResults.totalHits;
          bestCorrected = candQuery;
        }
      }
    }

    const corrected = bestCorrected;
    analytics.phonetic.candidate = corrected;

    if (corrected === normalised) {
      analytics.phonetic.outcome = 'same_as_original';
      return null;
    }

    console.log(`[Phonetic] Candidate: "${query}" → "${corrected}"`);

    const correctedResults = await searchProducts(corrected, options);
    analytics.phonetic.resultsBefore = originalResults?.totalHits || 0;
    analytics.phonetic.resultsAfter  = correctedResults.totalHits;

    if (correctedResults.hits.length < MIN_RESULTS_TO_LEARN) {
      analytics.phonetic.outcome = 'rejected_no_results';
      return null;
    }

    const originalAtLimit = originalResults?.totalHits >= MAX_RESULTS_LIMIT;
    if (!originalAtLimit && originalResults && correctedResults.totalHits <= originalResults.totalHits) {
      analytics.phonetic.outcome = 'rejected_not_better';
      return null;
    }

    analytics.phonetic.outcome    = 'accepted';
    analytics.searchStage         = 'phonetic';
    analytics.correctionDepth     = 3;
    analytics.correctionMode      = 'full';
    analytics.correction = {
      applied: true, finalQuery: corrected,
      source: 'phonetic', confidence: 0.80,
      improvement: correctedResults.totalHits - (originalResults?.totalHits || 0)
    };

    console.log(`[Phonetic] Accepted: "${query}" → "${corrected}" (${correctedResults.totalHits} results)`);
    safeSaveCorrection(query, corrected, 'phonetic', correctedResults.hits.length);

    const correctedIntent = parseIntent(corrected);
    const activeIntent    = hasFilters(correctedIntent) ? correctedIntent : intent;
    if (activeIntent && hasFilters(activeIntent)) {
      const intentResult = await applyIntentIfNeeded(
        activeIntent, query, corrected, options, correctedResults, startTime, analytics
      );
      if (intentResult) return intentResult;
    }

    return {
      originalQuery:        query,
      normalisedQuery:      normalised,
      retrievalQuery:       corrected,
      displayQuery:         corrected,
      correctedQuery:       corrected,
      wasCorrected:         true,
      correctionConfidence: 0.80,
      correctionSource:     'phonetic',
      correctionMode:       'full',
      results:              correctedResults.hits,
      totalHits:            correctedResults.totalHits,
      processingTime:       Date.now() - startTime,
      isFallback:           false,
      ui:                   buildUI(corrected, 'full')
    };

  } catch (err) {
    console.error('tryPhoneticCorrection error:', err.message);
    return null;
  }
}

// ─── SUGGEST ──────────────────────────────────────────────
// S0 → Meilisearch direct (inventory authoritative) ✅
// S1 → learnedMap (validated corrections) ✅
// S2 → SymSpell (genuine spelling repair) ✅
// S3 → suggestMap (prefix repair only) ✅
// S4 → Phonetic (sound-alike recovery) ✅
// S5 → return best available ✅

async function runSuggest(query, options = {}) {
  const normalised = normalise(query);
  if (!normalised) return { products: [], categories: [] };

  // S0 — Meilisearch direct ✅
  // inventory always authoritative ✅
  // if good results → done, no repair needed ✅
  const directResults = await getSuggestions(normalised, options);
  if ((directResults.products?.length || 0) >= MIN_SUGGEST_RESULTS) {

    // ── check all correction layers for indicator ─────────
    // learnedMap first — highest confidence ✅
    const quickCheck = applyCorrection(query, null, {
      clientId:    options.clientId    || null,
      clientScope: options.clientScope || null
    });
    if (quickCheck.corrected) {
      return buildSuggestResponse(
        query, normalised, quickCheck.query,
        true, quickCheck.source, quickCheck.confidence,
        directResults
      );
    }

    // symspell check ✅
    if (getSymSpellStatus().ready) {
      const symCheck = symspellCorrectQuery(normalised);
      if (symCheck && symCheck.corrected !== normalised) {
        return buildSuggestResponse(
          query, normalised, symCheck.corrected,
          true, 'symspell', 0.85,
          directResults
        );
      }
    }

    // phonetic check ✅
    // catches sound-alike typos even on direct hits ✅
    // "earfone" → "earphone", "nikee" → "nokia" ✅
    if (getPhoneticStatus().ready) {
      const phonCheck = phoneticCorrectQuery(normalised);
      if (phonCheck && phonCheck.corrected !== normalised) {
        return buildSuggestResponse(
          query, normalised, phonCheck.corrected,
          true, 'phonetic', 0.80,
          directResults
        );
      }
    }

    // no correction found → return as-is ✅
    return buildSuggestResponse(
      query, normalised, normalised,
      false, null, null, directResults
    );
  }

  // S1 — learnedMap ✅
  // validated corrections, highest confidence ✅
  // "labtop" → "laptop" ✅
  const correction = applyCorrection(query, null, {
    clientId:    options.clientId    || null,
    clientScope: options.clientScope || null
  });
  if (correction.corrected) {
    const correctedResults = await getSuggestions(correction.query, options);
    if ((correctedResults.products?.length || 0) >= MIN_SUGGEST_RESULTS) {
      return buildSuggestResponse(
        query, normalised, correction.query,
        true, correction.source, correction.confidence,
        correctedResults
      );
    }
  }

  // S2 — SymSpell ✅
  // genuine spelling repair ✅
  // more trustworthy than suggestMap ✅
  if (getSymSpellStatus().ready) {
    const symResult = symspellCorrectQuery(normalised);
    if (symResult && symResult.corrected !== normalised) {
      const symResults = await getSuggestions(symResult.corrected, options);
      if ((symResults.products?.length || 0) >= MIN_SUGGEST_RESULTS) {
        return buildSuggestResponse(
          query, normalised, symResult.corrected,
          true, 'symspell', 0.85,
          symResults
        );
      }
    }
  }

  // S3 — suggestMap ✅
  // prefix repair only ✅
  // fires only when inventory + corrections weak ✅
  // "stee" → "steel" → Meilisearch ✅
  const completion = suggestMapModule.getCompletion(normalised);
  if (completion && completion !== normalised) {
    const repairedResults = await getSuggestions(completion, options);
    if ((repairedResults.products?.length || 0) >= MIN_SUGGEST_RESULTS) {
      return buildSuggestResponse(
        query, normalised, completion,
        true, 'suggestMap', null,
        repairedResults
      );
    }
  }

  // S4 — Phonetic ✅
  // sound-alike recovery ✅
  if (getPhoneticStatus().ready) {
    const phonResult = phoneticCorrectQuery(normalised);
    if (phonResult && phonResult.corrected !== normalised) {
      const phonResults = await getSuggestions(phonResult.corrected, options);
      if ((phonResults.products?.length || 0) >= MIN_SUGGEST_RESULTS) {
        return buildSuggestResponse(
          query, normalised, phonResult.corrected,
          true, 'phonetic', 0.80,
          phonResults
        );
      }
    }
  }

  // S5 — return best available ✅
  // even if < MIN_SUGGEST_RESULTS ✅
  return buildSuggestResponse(
    query, normalised, normalised,
    false, null, null, directResults
  );
}

// ─── BUILD SUGGEST RESPONSE ───────────────────────────────

function buildSuggestResponse(
  query, normalised, finalQuery,
  wasCorrected, correctionSource, correctionConfidence,
  suggestions
) {
  return {
    query,
    originalQuery:       query,
    normalisedQuery:     normalised,
    correctedQuery:      wasCorrected ? finalQuery : null,
    wasCorrected,
    correctionSource,
    correctionConfidence,
    correctionMode:      wasCorrected ? 'full' : 'none', // ← ✅
    suggestions:         suggestions.suggestions || [],
    products:            suggestions.products    || [],
    categories:          suggestions.categories  || []
  };
}

// ─── NAVIGATE ─────────────────────────────────────────────

async function runNavigate(category, subcategory, options = {}) {
  if (!category) return buildEmptyResponse('');
  const startTime = Date.now();
  const results   = await navigateCategory(category, subcategory, options);
  if (results.hits.length === 0) {
    const popular = await getPopularProducts(10, options.meiliIndex);
    return {
      category, subcategory,
      subCategory: options.subCategory || null,
      results: popular, totalHits: popular.length,
      processingTime: Date.now() - startTime,
      isFallback: true, fallbackReason: 'no products in category'
    };
  }
  return {
    category, subcategory,
    subCategory: options.subCategory || null,
    results:     results.hits,
    totalHits:   results.totalHits,
    processingTime: Date.now() - startTime,
    isFallback:  false
  };
}

// ─── EMPTY RESPONSE ───────────────────────────────────────

function buildEmptyResponse(query) {
  return {
    originalQuery:   query, normalisedQuery:  '',
    retrievalQuery:  null,  displayQuery:     null,
    correctedQuery:  null,  wasCorrected:     false,
    correctionConfidence: null, correctionSource: null,
    correctionMode:  'none',
    results:         [],    totalHits:        0,
    processingTime:  0,     isFallback:       false,
    isEmpty:         true,
    ui:              buildUI(null, 'none')
  };
}

module.exports = { runSearch, runSuggest, runNavigate };







// *********************** ollama removed above from code as direct use  **********************************




































// const { normalise } = require('./normalise');
// const {
//   searchProducts,
//   getSuggestions,
//   navigateCategory,
//   getPopularProducts
// } = require('../meilisearch/searcher');
// const {
//   applyCorrection,
//   saveCorrection,
//   penaliseCorrection
// } = require('../learned/learnedMap');
// const { correctQuery: ollamaCorrectQuery } = require('../ollama/corrector');
// const { correctQuery: symspellCorrectQuery, getStatus: getSymSpellStatus, shouldSkip: symspellShouldSkip } = require('../spellcheck/symspell');
// const { logSearchEvent } = require('../../analytics/logger');
// const { parseIntent, hasFilters } = require('./intentParser');

// // ─── CONFIG ───────────────────────────────────────────────
// const MIN_RESULTS_TO_LEARN = 5;
// const MIN_IMPROVEMENT = 5;
// const WEAK_RESULTS_THRESHOLD = 20;
// const OLLAMA_MIN_RESULTS = 15;
// const MAX_RESULTS_LIMIT = 1000;

// // ─── SAFE SAVE ────────────────────────────────────────────

// function safeSaveCorrection(query, corrected, source, hitCount) {
//   try {
//     const chainCheck = applyCorrection(corrected);
//     if (chainCheck.corrected) {
//       console.log(`[SafeSave] Chain detected — skipped: "${corrected}" → "${chainCheck.query}"`);
//       return;
//     }
//     saveCorrection(query, corrected, source, hitCount);
//   } catch (e) {
//     console.error('saveCorrection error:', e.message);
//   }
// }

// // ─── RESULTS HELPER ───────────────────────────────────────

// function buildResultsAnalytics(totalHits, isFallback = false, fallbackReason = null) {
//   return {
//     count: totalHits,
//     isFallback,
//     fallbackReason,
//     isZeroResult: totalHits === 0,
//     isWeakResult: totalHits > 0 && totalHits <= WEAK_RESULTS_THRESHOLD
//   };
// }

// // ─── SHOULD SKIP OLLAMA ───────────────────────────────────

// function shouldSkipOllama(query, totalHits) {
//   if (totalHits >= WEAK_RESULTS_THRESHOLD) return true;
//   if (totalHits >= MAX_RESULTS_LIMIT) return true;

//   const words = query.toLowerCase().trim().split(/\s+/);
//   if (words.length === 1 && symspellShouldSkip(words[0])) return true;

//   // skip if ALL words have digits (model numbers: iphone15, s24, 256gb)
//   // but NOT if only SOME words have digits (price: under 1000, age: 10 years)
//   const allWordsHaveDigits = words.every(w => /\d/.test(w));
//   if (allWordsHaveDigits) return true;

//   // skip only if word with digit looks like model number (mixed alphanum)
//   // NOT pure numbers like "1000", "500", "10"
//   const hasModelNumber = words.some(w => /\d/.test(w) && /[a-z]/i.test(w) && !/^(under|above|below|rs|inr)$/i.test(w));
//   if (hasModelNumber) return true;

//   // don't skip based on word length — "mens", "jaket" are short but need correction
//   const symResult = symspellCorrectQuery(query);
//   if (!symResult || symResult.correctionsApplied === 0) return true;

//   return false;
// }

// // ─── APPLY INTENT FILTERS ────────────────────────────────
// // applies parsed intent filters to any search result
// // returns filtered response or null if filtered returns 0

// async function applyIntentIfNeeded(intent, query, normalised, options, currentResults, startTime, analytics) {
//   if (!hasFilters(intent)) return null;

//   const filteredOptions = { ...options };
//   if (intent.filters.category)  filteredOptions.category  = intent.filters.category;
//   if (intent.filters.color)     filteredOptions.color     = intent.filters.color;
//   if (intent.filters.brand)     filteredOptions.brand     = intent.filters.brand;
//   if (intent.filters.minPrice)  filteredOptions.minPrice  = intent.filters.minPrice;
//   if (intent.filters.maxPrice)  filteredOptions.maxPrice  = intent.filters.maxPrice;
//   if (intent.sizeGroup)         filteredOptions.size      = intent.sizeGroup;

//   const cleanQuery = intent.cleanQuery || normalised;
//   const filteredResults = await searchProducts(cleanQuery, filteredOptions);

//   console.log(`[Intent] "${query}" → "${cleanQuery}" filters:${JSON.stringify(intent.filters)} sizeGroup:${intent.sizeGroup ? 'yes' : 'no'} results:${filteredResults.totalHits}`);

//   analytics.intent = {
//     parsed: true,
//     filtersApplied: filteredResults.totalHits >= 1,
//     filters: intent.filters,
//     cleanQuery,
//     sizeGroup: intent.sizeGroup || null,
//     resultsBefore: currentResults?.totalHits || 0,
//     resultsAfter: filteredResults.totalHits
//   };

//   if (filteredResults.totalHits >= 1) {
//     const intentFiltersWithSize = {
//       ...intent.filters,
//       ...(intent.sizeGroup ? { sizeGroup: intent.sizeGroup } : {})
//     };
//     // if cleanQuery differs from original query
//     // set correctedQuery so showingResultsFor
//     // and searchInsteadFor always populate ✅
//     // only set correctedQuery if cleanQuery has different WORDS
//     // not just stripped price/color/filter terms
//     // e.g. "samsng mobile" → "samsung mobile" ✅ show correction
//     // e.g. "samsung mobile under 20000" → "samsung mobile" ❌ don't show
//     // we detect this by checking if all cleanQuery words
//     // exist in the original query
//     // only set correctedQuery if actual word correction happened
//     // not just intent stripping price/color/filter terms
//     const normalisedOriginal = normalise(query);
//     const originalWords = normalisedOriginal.split(/\s+/);
//     const cleanWords = (cleanQuery || '').split(/\s+/);
//     const allCleanWordsInOriginal = cleanWords.every(w => originalWords.includes(w));

//     // if correction happened, show full normalised query
//     // so user sees "samsung mobile under 20000" not just "samsung mobile"
//     // this keeps price/filter context visible ✅
//     const intentCorrected = (
//       cleanQuery &&
//       cleanQuery !== normalisedOriginal &&
//       !allCleanWordsInOriginal
//     ) ? normalised : null;
//     return {
//       originalQuery:       query,
//       normalisedQuery:     normalised,
//       correctedQuery:      intentCorrected,
//       wasCorrected:        intentCorrected !== null,
//       correctionConfidence: intentCorrected ? 1.0 : null,
//       correctionSource:    intentCorrected ? 'intent' : null,
//       intentFilters:       intentFiltersWithSize,
//       intentCleanQuery:    cleanQuery,
//       results:             filteredResults.hits,
//       totalHits:           filteredResults.totalHits,
//       processingTime:      Date.now() - startTime,
//       isFallback:          false
//     };
//   }

//   // filtered returned 0 — cleanQuery may have a typo
//   // try symspell on cleanQuery first ✅
//   console.log(`[Intent] Filtered returned 0 — trying symspell on cleanQuery "${cleanQuery}"`);
//   if (getSymSpellStatus().ready) {
//     const symResult = symspellCorrectQuery(cleanQuery);
//     if (symResult && symResult.corrected !== cleanQuery) {
//       const symClean = symResult.corrected;
//       console.log(`[Intent] SymSpell fixed cleanQuery: "${cleanQuery}" → "${symClean}"`);
//       const symFilteredResults = await searchProducts(symClean, filteredOptions);
//       if (symFilteredResults.totalHits >= 1) {
//         const intentFiltersWithSize = {
//           ...intent.filters,
//           ...(intent.sizeGroup ? { sizeGroup: intent.sizeGroup } : {})
//         };
//         analytics.intent.filtersApplied = true;
//         analytics.intent.resultsAfter = symFilteredResults.totalHits;
//         return {
//           originalQuery: query,
//           normalisedQuery: normalised,
//           correctedQuery: symClean,
//           wasCorrected: true,
//           correctionConfidence: 0.85,
//           correctionSource: 'symspell+intent',
//           intentFilters: intentFiltersWithSize,
//           intentCleanQuery: symClean,
//           results: symFilteredResults.hits,
//           totalHits: symFilteredResults.totalHits,
//           processingTime: Date.now() - startTime,
//           isFallback: false
//         };
//       }
//     }
//   }

//   // symspell couldn't fix it — try Ollama on cleanQuery ✅
//   // handles typos symspell dictionary doesn't know:
//   // "jaket" → "jacket", "pnik" → "pink", "frok" → "frock"
//   // Ollama fires here ONLY — not on full query (avoids 30s delays)
//   // after fix: learnedMap stores correction → instant next time ✅
//   const cleanWords = cleanQuery.split(/\s+/);
//   // only fire Ollama if there's a real word that looks like a typo
//   // exclude: pure numbers, short words (≤4), stopwords
//   // min length 5 prevents Ollama firing on "frok", "pnik" etc
//   // which cause 30s timeouts — add short typos to learnedMap manually
//   const typoWords = cleanWords.filter(w =>
//     w.length >= 6 &&            // min 5 chars — avoids short typos causing 30s Ollama
//     !/^\d+$/.test(w) &&        // not pure number like "10", "500"
//     !/\d/.test(w) &&            // not mixed like "10yrs"
//     !['under', 'above', 'below', 'for', 'with', 'and', 'years', 'year'].includes(w)
//   );
//   const looksLikeTypo = typoWords.length > 0;

//   if (looksLikeTypo) {
//     try {
//       // check if cleanQuery is a real word before firing Ollama
//       // real word = has unfiltered results → skip Ollama (saves 30s)
//       // typo = no unfiltered results → fire Ollama to fix it ✅
//       const wordCheck = await searchProducts(cleanQuery, { limit: 1, meiliIndex: options.meiliIndex });
//       if (wordCheck.totalHits >= 20) {
//         console.log(`[Intent] "${cleanQuery}" is valid word (${wordCheck.totalHits} hits) — skipping Ollama`);
//       } else {
//         console.log(`[Intent] Trying Ollama on cleanQuery "${cleanQuery}"`);
//         const { correctQuery: ollamaCorrect } = require('../ollama/corrector');
//         const ollamaClean = await ollamaCorrect(cleanQuery);
//         if (
//           ollamaClean &&
//           ollamaClean !== cleanQuery &&
//           !ollamaClean.toLowerCase().includes('input unchanged') &&
//           !ollamaClean.toLowerCase().includes('no correction')
//         ) {
//           console.log(`[Intent] Ollama fixed cleanQuery: "${cleanQuery}" → "${ollamaClean}"`);
//           const ollamaFilteredResults = await searchProducts(ollamaClean, filteredOptions);
//           if (ollamaFilteredResults.totalHits >= 1) {
//             const intentFiltersWithSize = {
//               ...intent.filters,
//               ...(intent.sizeGroup ? { sizeGroup: intent.sizeGroup } : {})
//             };
//             analytics.intent.filtersApplied = true;
//             analytics.intent.resultsAfter = ollamaFilteredResults.totalHits;
//             safeSaveCorrection(cleanQuery, ollamaClean, 'ollama+intent', ollamaFilteredResults.hits.length);
//             return {
//               originalQuery: query,
//               normalisedQuery: normalised,
//               correctedQuery: ollamaClean,
//               wasCorrected: true,
//               correctionConfidence: 0.75,
//               correctionSource: 'ollama+intent',
//               intentFilters: intentFiltersWithSize,
//               intentCleanQuery: ollamaClean,
//               results: ollamaFilteredResults.hits,
//               totalHits: ollamaFilteredResults.totalHits,
//               processingTime: Date.now() - startTime,
//               isFallback: false
//             };
//           }
//         }
//       }
//     } catch (e) {
//       console.error('[Intent] Ollama cleanQuery correction failed:', e.message);
//     }
//   }

//   console.log(`[Intent] Filtered returned 0 → using unfiltered`);
//   return null;
// }

// // ─── SEARCH ───────────────────────────────────────────────

// async function runSearch(query, options = {}) {
//   const startTime = Date.now();

//   const analytics = {
//     requestId:  options.requestId || null,
//     clientId:   options.clientId  || null,
//     query,
//     normalised: null,
//     searchStage: 'meilisearch',
//     correctionDepth: 0,
//     correctionAttempted: false,
//     learnedMap: { hit: false },
//     symspell: { called: false },
//     ollama: { called: false },
//     correction: { applied: false },
//     intent: { parsed: false, filtersApplied: false, filters: {}, cleanQuery: null },
//     results: { count: 0, isFallback: false },
//     timing: { total: 0, symspell: 0, ollama: 0, meilisearch: 0, learnedmap: 0 }
//   };

//   // Step 1 — normalise
//   const normalised = normalise(query);
//   analytics.normalised = normalised;
//   if (!normalised) return buildEmptyResponse(query);

//   // Parse intent early — available to all steps
//   const intent = parseIntent(query);

//   // Step 2 — learnedMap check
//   const learnedMapStart = Date.now();
//   const correction = applyCorrection(query);
//   analytics.timing.learnedmap = Date.now() - learnedMapStart;

//   const searchQuery = correction.corrected ? correction.query : normalised;
//   const wasCorrected = correction.corrected;

//   if (wasCorrected) {
//     analytics.correctionAttempted = true;
//     analytics.learnedMap = {
//       hit: true,
//       correction: correction.query,
//       confidence: correction.confidence || null,
//       source: correction.source || null,
//       outcome: 'pending'
//     };
//   }

//   // Step 3 — search Meilisearch
//   const meilisearchStart = Date.now();
//   const results = await searchProducts(searchQuery, options);
//   analytics.timing.meilisearch = Date.now() - meilisearchStart;

//   // Step 4 — learnedMap correction validation
//   if (wasCorrected) {

//     if (results.hits.length === 0) {
//       analytics.learnedMap.outcome = 'zero_results';
//       analytics.learnedMap.resultsBefore = 0;

//       const symspellResult = await trySymSpellCorrection(
//         query, normalised, options, startTime, null, analytics, intent
//       );
//       if (symspellResult && symspellResult !== 'SYMSPELL_NOT_BETTER') {
//         analytics.results = buildResultsAnalytics(symspellResult.totalHits);
//         fireAnalytics(analytics, symspellResult, startTime);
//         return symspellResult;
//       }

//       if (!shouldSkipOllama(query, 0) && symspellResult !== 'SYMSPELL_NOT_BETTER') {
//         const ollamaResult = await tryOllamaCorrection(
//           query, normalised, options, startTime, null, analytics, intent
//         );
//         if (ollamaResult) {
//           analytics.results = buildResultsAnalytics(ollamaResult.totalHits);
//           fireAnalytics(analytics, ollamaResult, startTime);
//           return ollamaResult;
//         }
//       }

//       const popular = await getPopularProducts(10, options.meiliIndex);
//       analytics.searchStage = 'fallback';
//       analytics.results = buildResultsAnalytics(popular.length, true, 'no results found');
//       fireAnalytics(analytics, null, startTime);
//       return {
//         originalQuery: query,
//         normalisedQuery: normalised,
//         correctedQuery: null,
//         wasCorrected: false,
//         correctionConfidence: null,
//         correctionSource: null,
//         results: popular,
//         totalHits: popular.length,
//         processingTime: Date.now() - startTime,
//         isFallback: true,
//         fallbackReason: 'no results found'
//       };
//     }

//     const originalResults = await searchProducts(normalised, options);

//     if (results.totalHits < originalResults.totalHits) {
//       console.log(`[Layer1] "${query}" → "${searchQuery}" blocked`);
//       analytics.learnedMap.outcome = 'penalised';
//       analytics.learnedMap.resultsBefore = originalResults.totalHits;
//       analytics.learnedMap.resultsAfter = results.totalHits;

//       try { penaliseCorrection(query); } catch (e) {}

//       const response = {
//         originalQuery: query,
//         normalisedQuery: normalised,
//         correctedQuery: null,
//         wasCorrected: false,
//         correctionConfidence: null,
//         correctionSource: null,
//         results: originalResults.hits,
//         totalHits: originalResults.totalHits,
//         processingTime: Date.now() - startTime,
//         isFallback: false
//       };
//       analytics.searchStage = 'learnedmap';
//       analytics.results = buildResultsAnalytics(originalResults.totalHits);
//       fireAnalytics(analytics, response, startTime);
//       return response;
//     }

//     if (
//       results.hits.length >= MIN_RESULTS_TO_LEARN &&
//       results.totalHits >= originalResults.totalHits + MIN_IMPROVEMENT
//     ) {
//       console.log(`[Learn] Correction: "${query}" → "${searchQuery}"`);
//       safeSaveCorrection(query, searchQuery, correction.source || 'manual', results.hits.length);
//     }

//     analytics.learnedMap.outcome = 'accepted';
//     analytics.learnedMap.resultsBefore = originalResults.totalHits;
//     analytics.learnedMap.resultsAfter = results.totalHits;
//     analytics.searchStage = 'learnedmap';
//     analytics.correctionDepth = 1;
//     analytics.correction = {
//       applied: true,
//       finalQuery: searchQuery,
//       source: correction.source || 'manual',
//       confidence: correction.confidence || null,
//       improvement: results.totalHits - originalResults.totalHits
//     };

//     // apply intent on top of learnedMap corrected results ✅
//     // re-parse intent from learnedMap corrected query ✅
//     const lmReparsed = parseIntent(searchQuery);
//     const lmActiveIntent = hasFilters(lmReparsed) ? lmReparsed : intent;
//     const intentResult4 = await applyIntentIfNeeded(
//       lmActiveIntent, query, searchQuery, options, results, startTime, analytics
//     );
//     if (intentResult4) {
//       analytics.results = buildResultsAnalytics(intentResult4.totalHits);
//       fireAnalytics(analytics, intentResult4, startTime);
//       return intentResult4;
//     }

//     const response = {
//       originalQuery: query,
//       normalisedQuery: normalised,
//       correctedQuery: searchQuery,
//       wasCorrected: true,
//       correctionConfidence: correction.confidence || null,
//       correctionSource: correction.source || null,
//       results: results.hits,
//       totalHits: results.totalHits,
//       processingTime: Date.now() - startTime,
//       isFallback: false
//     };
//     analytics.results = buildResultsAnalytics(results.totalHits);
//     fireAnalytics(analytics, response, startTime);
//     return response;
//   }

//   // Step 5 — zero results → try corrections
//   if (results.totalHits === 0) {
//     const symspellResult = await trySymSpellCorrection(
//       query, normalised, options, startTime, null, analytics, intent
//     );
//     if (symspellResult && symspellResult !== 'SYMSPELL_NOT_BETTER') {
//       analytics.results = buildResultsAnalytics(symspellResult.totalHits);
//       fireAnalytics(analytics, symspellResult, startTime);
//       return symspellResult;
//     }

//     if (!shouldSkipOllama(query, 0) && symspellResult !== 'SYMSPELL_NOT_BETTER') {
//       const ollamaResult = await tryOllamaCorrection(
//         query, normalised, options, startTime, null, analytics, intent
//       );
//       if (ollamaResult) {
//         analytics.results = buildResultsAnalytics(ollamaResult.totalHits);
//         fireAnalytics(analytics, ollamaResult, startTime);
//         return ollamaResult;
//       }
//     }

//     const popular = await getPopularProducts(10, options.meiliIndex);
//     analytics.searchStage = 'fallback';
//     analytics.results = buildResultsAnalytics(popular.length, true, 'no results found');
//     fireAnalytics(analytics, null, startTime);
//     return {
//       originalQuery: query,
//       normalisedQuery: normalised,
//       correctedQuery: null,
//       wasCorrected: false,
//       correctionConfidence: null,
//         correctionSource: null,
//       results: popular,
//       totalHits: popular.length,
//       processingTime: Date.now() - startTime,
//       isFallback: true,
//       fallbackReason: 'no results found'
//     };
//   }

  

//   // Step 6 — weak results → try corrections
//   if (results.totalHits < WEAK_RESULTS_THRESHOLD) {

//     const abbCorrection = applyCorrection(query, 0);
//     if (abbCorrection.corrected) {
//       const abbResults = await searchProducts(abbCorrection.query, options);

//       if (
//         abbResults.hits.length >= MIN_RESULTS_TO_LEARN &&
//         abbResults.totalHits > results.totalHits
//       ) {
//         console.log(`[Learn] Abbreviation: "${query}" → "${abbCorrection.query}"`);
//         safeSaveCorrection(query, abbCorrection.query, abbCorrection.source || 'manual', abbResults.hits.length);

//         analytics.searchStage = 'learnedmap';
//         analytics.correctionDepth = 1;
//         analytics.learnedMap = {
//           hit: true,
//           correction: abbCorrection.query,
//           outcome: 'accepted',
//           resultsBefore: results.totalHits,
//           resultsAfter: abbResults.totalHits
//         };
//         analytics.correction = {
//           applied: true,
//           finalQuery: abbCorrection.query,
//           source: abbCorrection.source || 'manual',
//           confidence: abbCorrection.confidence || null,
//           improvement: abbResults.totalHits - results.totalHits
//         };

//         // re-parse intent from abbreviation corrected query ✅
//         const abbReparsed = parseIntent(abbCorrection.query);
//         const abbActiveIntent = hasFilters(abbReparsed) ? abbReparsed : intent;
//         const intentResult6abb = await applyIntentIfNeeded(
//           abbActiveIntent, query, abbCorrection.query, options, abbResults, startTime, analytics
//         );
//         if (intentResult6abb) {
//           analytics.results = buildResultsAnalytics(intentResult6abb.totalHits);
//           fireAnalytics(analytics, intentResult6abb, startTime);
//           return intentResult6abb;
//         }

//         const response = {
//           originalQuery: query,
//           normalisedQuery: normalised,
//           correctedQuery: abbCorrection.query,
//           wasCorrected: true,
//           correctionConfidence: abbCorrection.confidence || null,
//           correctionSource: abbCorrection.source || null,
//           results: abbResults.hits,
//           totalHits: abbResults.totalHits,
//           processingTime: Date.now() - startTime,
//           isFallback: false
//         };
//         analytics.results = buildResultsAnalytics(abbResults.totalHits);
//         fireAnalytics(analytics, response, startTime);
//         return response;
//       }
//     }

//     const symspellResult = await trySymSpellCorrection(
//       query, normalised, options, startTime, results, analytics, intent
//     );
//     if (symspellResult && symspellResult !== 'SYMSPELL_NOT_BETTER') {
//       analytics.results = buildResultsAnalytics(symspellResult.totalHits);
//       fireAnalytics(analytics, symspellResult, startTime);
//       return symspellResult;
//     }

//     if (!shouldSkipOllama(query, results.totalHits) && symspellResult !== 'SYMSPELL_NOT_BETTER') {
//       const ollamaResult = await tryOllamaCorrection(
//         query, normalised, options, startTime, results, analytics, intent
//       );
//       if (ollamaResult) {
//         analytics.results = buildResultsAnalytics(ollamaResult.totalHits);
//         fireAnalytics(analytics, ollamaResult, startTime);
//         return ollamaResult;
//       }
//     }
//   }

//   // Step 7 — good results → apply intent filters ✅
//   analytics.searchStage = 'meilisearch';
//   analytics.correctionDepth = 0;

//   // try symspell on full query — may fix typo in product word ✅
//   let activeIntent7 = intent;
//   if (intent && hasFilters(intent) && getSymSpellStatus().ready) {
//     const symOnFull = symspellCorrectQuery(query);
//     if (symOnFull && symOnFull.corrected !== normalised && symOnFull.correctionsApplied > 0) {
//       const reparsed = parseIntent(symOnFull.corrected);
//       if (hasFilters(reparsed) && reparsed.cleanQuery !== intent.cleanQuery) {
//         activeIntent7 = reparsed;
//         console.log(`[Step7] Reparsed intent: "${query}" → "${symOnFull.corrected}"`);
//       }
//     }
//   }
//   const intentResult = await applyIntentIfNeeded(
//     activeIntent7, query, normalised, options, results, startTime, analytics
//   );
//   if (intentResult) {
//     analytics.results = buildResultsAnalytics(intentResult.totalHits);
//     fireAnalytics(analytics, intentResult, startTime);
//     return intentResult;
//   }

//   analytics.results = buildResultsAnalytics(results.totalHits);
//   const response = {
//     originalQuery: query,
//     normalisedQuery: normalised,
//     correctedQuery: null,
//     wasCorrected: false,
//     correctionConfidence: null,
//     correctionSource: null,
//     results: results.hits,
//     totalHits: results.totalHits,
//     processingTime: Date.now() - startTime,
//     isFallback: false
//   };
//   fireAnalytics(analytics, response, startTime);
//   return response;
// }

// // ─── FIRE ANALYTICS ───────────────────────────────────────

// function fireAnalytics(analytics, response, startTime) {
//   try {
//     analytics.timing.total = Date.now() - startTime;
//     logSearchEvent(analytics);
//   } catch (e) {
//     // silent — analytics never breaks search
//   }
// }

// // ─── SYMSPELL CORRECTION HELPER ───────────────────────────

// async function trySymSpellCorrection(query, normalised, options, startTime, originalResults = null, analytics = {}, intent = null) {
//   try {
//     if (!getSymSpellStatus().ready) return null;

//     const symStart = Date.now();
//     const symspellResult = symspellCorrectQuery(query);
//     const symTime = Date.now() - symStart;

//     analytics.correctionAttempted = true;
//     analytics.symspell = {
//       called: true,
//       timeTaken: symTime,
//       candidate: null,
//       outcome: 'skipped'
//     };
//     analytics.timing.symspell = symTime;

//     if (!symspellResult) return null;

//     const corrected = symspellResult.corrected;
//     analytics.symspell.candidate = corrected;
//     analytics.symspell.changedWords = symspellResult.changedWords || [];
//     analytics.symspell.correctionsCount = symspellResult.correctionsApplied || 0;

//     if (corrected === normalised) {
//       analytics.symspell.outcome = 'same_as_original';
//       return null;
//     }

//     console.log(`[SymSpell] Candidate: "${query}" → "${corrected}"`);

//     const correctedResults = await searchProducts(corrected, options);
//     analytics.symspell.resultsBefore = originalResults?.totalHits || 0;
//     analytics.symspell.resultsAfter = correctedResults.totalHits;

//         // for small catalogues: accept if corrected > original
//     // even if below MIN_RESULTS_TO_LEARN threshold ✅
//     const isImprovement = correctedResults.totalHits > (originalResults?.totalHits || 0);
//     if (correctedResults.hits.length < MIN_RESULTS_TO_LEARN && !isImprovement) {
//       analytics.symspell.outcome = 'rejected_no_results';
//       analytics.symspell.rejectionReason = `only ${correctedResults.hits.length} results`;
//       return null;
//     }

//     const originalAtLimit = originalResults?.totalHits >= MAX_RESULTS_LIMIT;
//     if (!originalAtLimit && originalResults && correctedResults.totalHits <= originalResults.totalHits) {
//       analytics.symspell.outcome = 'rejected_not_better';
//       analytics.symspell.rejectionReason = `${correctedResults.totalHits} <= ${originalResults.totalHits}`;
//       // Fix 2: symspell found a candidate but results didn't improve
//       // signal to caller to skip Ollama — it cannot do better ✅
//       return 'SYMSPELL_NOT_BETTER';
//     }

//     analytics.symspell.outcome = 'accepted';
//     analytics.searchStage = 'symspell';
//     analytics.correctionDepth = 2;
//     analytics.correction = {
//       applied: true,
//       finalQuery: corrected,
//       source: 'symspell',
//       confidence: 0.85,
//       improvement: correctedResults.totalHits - (originalResults?.totalHits || 0)
//     };

//     console.log(`[SymSpell] Accepted: "${query}" → "${corrected}" (${correctedResults.totalHits} results)`);
//     safeSaveCorrection(query, corrected, 'symspell', correctedResults.hits.length);

//     // apply intent on top of symspell correction ✅
//     // re-parse intent from corrected query ✅
//     // original intent had typo in cleanQuery e.g. "kurtaa"
//     // corrected query has correct word e.g. "kurta"
//     const correctedIntent = parseIntent(corrected);
//     const activeIntent = hasFilters(correctedIntent) ? correctedIntent : intent;
//     if (activeIntent && hasFilters(activeIntent)) {
//       const intentResult = await applyIntentIfNeeded(
//         activeIntent, query, corrected, options, correctedResults, startTime, analytics
//       );
//       if (intentResult) return intentResult;
//     }

//     return {
//       originalQuery: query,
//       normalisedQuery: normalised,
//       correctedQuery: corrected,
//       wasCorrected: true,
//       correctionConfidence: 0.85,
//       correctionSource: 'symspell',
//       results: correctedResults.hits,
//       totalHits: correctedResults.totalHits,
//       processingTime: Date.now() - startTime,
//       isFallback: false
//     };

//   } catch (err) {
//     console.error('trySymSpellCorrection error:', err.message);
//     return null;
//   }
// }

// // ─── OLLAMA CORRECTION HELPER ─────────────────────────────

// async function tryOllamaCorrection(query, normalised, options, startTime, originalResults = null, analytics = {}, intent = null) {
//   try {
//     const ollamaStart = Date.now();
//     const ollamaCorrection = await ollamaCorrectQuery(query);
//     const ollamaTime = Date.now() - ollamaStart;

//     analytics.correctionAttempted = true;
//     analytics.ollama = {
//       called: true,
//       timeTaken: ollamaTime,
//       candidate: ollamaCorrection || null,
//       outcome: 'skipped'
//     };
//     analytics.timing.ollama = ollamaTime;

//     if (!ollamaCorrection) return null;

//     if (ollamaCorrection === normalised || ollamaCorrection === query) {
//       analytics.ollama.outcome = 'same_as_original';
//       return null;
//     }
//     if (
//       ollamaCorrection.toLowerCase().includes('input unchanged') ||
//       ollamaCorrection.toLowerCase().includes('no correction')
//     ) {
//       console.log(`[Ollama] Hallucination detected — "${ollamaCorrection}"`);
//       analytics.ollama.outcome = 'hallucination';
//       return null;
//     }

//     console.log(`[Ollama] Candidate: "${query}" → "${ollamaCorrection}"`);

//     const ollamaResults = await searchProducts(ollamaCorrection, options);
//     analytics.ollama.resultsBefore = originalResults?.totalHits || 0;
//     analytics.ollama.resultsAfter = ollamaResults.totalHits;

//     if (ollamaResults.hits.length < OLLAMA_MIN_RESULTS) {
//       analytics.ollama.outcome = 'rejected_no_results';
//       analytics.ollama.rejectionReason = `only ${ollamaResults.hits.length} results`;
//       return null;
//     }

//     const originalAtLimit = originalResults?.totalHits >= MAX_RESULTS_LIMIT;
//     if (!originalAtLimit && originalResults && ollamaResults.totalHits <= originalResults.totalHits) {
//       analytics.ollama.outcome = 'rejected_not_better';
//       analytics.ollama.rejectionReason = `${ollamaResults.totalHits} <= ${originalResults.totalHits}`;
//       return null;
//     }

//     analytics.ollama.outcome = 'accepted';
//     analytics.searchStage = 'ollama';
//     analytics.correctionDepth = 3;
//     analytics.correction = {
//       applied: true,
//       finalQuery: ollamaCorrection,
//       source: 'ollama',
//       confidence: 0.75,
//       improvement: ollamaResults.totalHits - (originalResults?.totalHits || 0)
//     };

//     console.log(`[Ollama] Accepted: "${query}" → "${ollamaCorrection}" (${ollamaResults.totalHits} results)`);
//     safeSaveCorrection(query, ollamaCorrection, 'ollama', ollamaResults.hits.length);

//     // apply intent on top of ollama correction ✅
//     // re-parse intent from ollama corrected query ✅
//     const correctedIntent = parseIntent(ollamaCorrection);
//     const activeIntent = hasFilters(correctedIntent) ? correctedIntent : intent;
//     if (activeIntent && hasFilters(activeIntent)) {
//       const intentResult = await applyIntentIfNeeded(
//         activeIntent, query, ollamaCorrection, options, ollamaResults, startTime, analytics
//       );
//       if (intentResult) return intentResult;
//     }

//     return {
//       originalQuery: query,
//       normalisedQuery: normalised,
//       correctedQuery: ollamaCorrection,
//       wasCorrected: true,
//       correctionConfidence: 0.75,
//       correctionSource: 'ollama',
//       results: ollamaResults.hits,
//       totalHits: ollamaResults.totalHits,
//       processingTime: Date.now() - startTime,
//       isFallback: false
//     };

//   } catch (err) {
//     console.error('tryOllamaCorrection error:', err.message);
//     return null;
//   }
// }

// // ─── SUGGEST ──────────────────────────────────────────────

// async function runSuggest(query, options = {}) {
//   const normalised = normalise(query);
//   if (!normalised) return { products: [], categories: [] };

//   const correction = applyCorrection(query);
//   const searchQuery = correction.corrected ? correction.query : normalised;

//   let finalQuery = searchQuery;
//   let wasCorrected = correction.corrected;
//   let correctionSource = correction.corrected ? correction.source : null;
//   let correctionConfidence = correction.corrected ? (correction.confidence || null) : null;

//   if (!wasCorrected && getSymSpellStatus().ready) {
//     const symspellResult = symspellCorrectQuery(normalised);
//     if (symspellResult) {
//       finalQuery = symspellResult.corrected;
//       wasCorrected = true;
//       correctionSource = 'symspell';
//       correctionConfidence = 0.85;
//     }
//   }

//   const suggestions = await getSuggestions(finalQuery, options);

//   return {
//     query: normalised,
//     originalQuery: query,
//     correctedQuery: wasCorrected ? finalQuery : null,
//     wasCorrected,
//     correctionConfidence,
//     correctionSource,
//     products: suggestions.products,
//     categories: suggestions.categories
//   };
// }

// // ─── NAVIGATE ─────────────────────────────────────────────

// async function runNavigate(category, subcategory, options = {}) {
//   if (!category) return buildEmptyResponse('');

//   const startTime = Date.now();
//   const results = await navigateCategory(category, subcategory, options);

//   if (results.hits.length === 0) {
//     const popular = await getPopularProducts(10, options.meiliIndex);
//     return {
//       category,
//       subcategory,
//       subCategory: options.subCategory || null,
//       results: popular,
//       totalHits: popular.length,
//       processingTime: Date.now() - startTime,
//       isFallback: true,
//       fallbackReason: 'no products in category'
//     };
//   }

//   return {
//     category,
//     subcategory,
//     subCategory: options.subCategory || null,
//     results: results.hits,
//     totalHits: results.totalHits,
//     processingTime: Date.now() - startTime,
//     isFallback: false
//   };
// }

// // ─── EMPTY RESPONSE ───────────────────────────────────────

// function buildEmptyResponse(query) {
//   return {
//     originalQuery: query,
//     normalisedQuery: '',
//     correctedQuery: null,
//     wasCorrected: false,
//     correctionConfidence: null,
//     correctionSource: null,
//     results: [],
//     totalHits: 0,
//     processingTime: 0,
//     isFallback: false,
//     isEmpty: true
//   };
// }

// module.exports = { runSearch, runSuggest, runNavigate };











































// *********************** ALL BEFORE THE MULTI TENANT PHASE **********************************







// const { normalise } = require('./normalise');
// const {
//   searchProducts,
//   getSuggestions,
//   navigateCategory,
//   getPopularProducts
// } = require('../meilisearch/searcher');
// const {
//   applyCorrection,
//   saveCorrection,
//   penaliseCorrection
// } = require('../learned/learnedMap');
// const { correctQuery: ollamaCorrectQuery } = require('../ollama/corrector');
// const { correctQuery: symspellCorrectQuery, getStatus: getSymSpellStatus, shouldSkip: symspellShouldSkip } = require('../spellcheck/symspell');
// const { logSearchEvent } = require('../../analytics/logger');
// const { parseIntent, hasFilters } = require('./intentParser');

// // ─── CONFIG ───────────────────────────────────────────────
// const MIN_RESULTS_TO_LEARN = 5;
// const MIN_IMPROVEMENT = 5;
// const WEAK_RESULTS_THRESHOLD = 20;
// const OLLAMA_MIN_RESULTS = 15;
// const MAX_RESULTS_LIMIT = 1000;

// // ─── SAFE SAVE ────────────────────────────────────────────

// function safeSaveCorrection(query, corrected, source, hitCount) {
//   try {
//     const chainCheck = applyCorrection(corrected);
//     if (chainCheck.corrected) {
//       console.log(`[SafeSave] Chain detected — skipped: "${corrected}" → "${chainCheck.query}"`);
//       return;
//     }
//     saveCorrection(query, corrected, source, hitCount);
//   } catch (e) {
//     console.error('saveCorrection error:', e.message);
//   }
// }

// // ─── RESULTS HELPER ───────────────────────────────────────

// function buildResultsAnalytics(totalHits, isFallback = false, fallbackReason = null) {
//   return {
//     count: totalHits,
//     isFallback,
//     fallbackReason,
//     isZeroResult: totalHits === 0,
//     isWeakResult: totalHits > 0 && totalHits <= WEAK_RESULTS_THRESHOLD
//   };
// }

// // ─── SHOULD SKIP OLLAMA ───────────────────────────────────

// function shouldSkipOllama(query, totalHits) {
//   if (totalHits >= WEAK_RESULTS_THRESHOLD) return true;
//   if (totalHits >= MAX_RESULTS_LIMIT) return true;

//   const words = query.toLowerCase().trim().split(/\s+/);
//   if (words.length === 1 && symspellShouldSkip(words[0])) return true;

//   // skip if ALL words have digits (model numbers: iphone15, s24, 256gb)
//   // but NOT if only SOME words have digits (price: under 1000, age: 10 years)
//   const allWordsHaveDigits = words.every(w => /\d/.test(w));
//   if (allWordsHaveDigits) return true;

//   // skip only if word with digit looks like model number (mixed alphanum)
//   // NOT pure numbers like "1000", "500", "10"
//   const hasModelNumber = words.some(w => /\d/.test(w) && /[a-z]/i.test(w) && !/^(under|above|below|rs|inr)$/i.test(w));
//   if (hasModelNumber) return true;

//   // don't skip based on word length — "mens", "jaket" are short but need correction
//   const symResult = symspellCorrectQuery(query);
//   if (!symResult || symResult.correctionsApplied === 0) return true;

//   return false;
// }

// // ─── APPLY INTENT FILTERS ────────────────────────────────
// // applies parsed intent filters to any search result
// // returns filtered response or null if filtered returns 0

// async function applyIntentIfNeeded(intent, query, normalised, options, currentResults, startTime, analytics) {
//   if (!hasFilters(intent)) return null;

//   const filteredOptions = { ...options };
//   if (intent.filters.category)  filteredOptions.category  = intent.filters.category;
//   if (intent.filters.color)     filteredOptions.color     = intent.filters.color;
//   if (intent.filters.brand)     filteredOptions.brand     = intent.filters.brand;
//   if (intent.filters.minPrice)  filteredOptions.minPrice  = intent.filters.minPrice;
//   if (intent.filters.maxPrice)  filteredOptions.maxPrice  = intent.filters.maxPrice;
//   if (intent.sizeGroup)         filteredOptions.size      = intent.sizeGroup;

//   const cleanQuery = intent.cleanQuery || normalised;
//   const filteredResults = await searchProducts(cleanQuery, filteredOptions);

//   console.log(`[Intent] "${query}" → "${cleanQuery}" filters:${JSON.stringify(intent.filters)} sizeGroup:${intent.sizeGroup ? 'yes' : 'no'} results:${filteredResults.totalHits}`);

//   analytics.intent = {
//     parsed: true,
//     filtersApplied: filteredResults.totalHits >= 1,
//     filters: intent.filters,
//     cleanQuery,
//     sizeGroup: intent.sizeGroup || null,
//     resultsBefore: currentResults?.totalHits || 0,
//     resultsAfter: filteredResults.totalHits
//   };

//   if (filteredResults.totalHits >= 1) {
//     const intentFiltersWithSize = {
//       ...intent.filters,
//       ...(intent.sizeGroup ? { sizeGroup: intent.sizeGroup } : {})
//     };
//     return {
//       originalQuery: query,
//       normalisedQuery: normalised,
//       correctedQuery: null,
//       wasCorrected: false,
//       correctionConfidence: null,
//       correctionSource: null,
//       intentFilters: intentFiltersWithSize,
//       intentCleanQuery: cleanQuery,
//       results: filteredResults.hits,
//       totalHits: filteredResults.totalHits,
//       processingTime: Date.now() - startTime,
//       isFallback: false
//     };
//   }

//   // filtered returned 0 — cleanQuery may have a typo
//   // try symspell on cleanQuery first ✅
//   console.log(`[Intent] Filtered returned 0 — trying symspell on cleanQuery "${cleanQuery}"`);
//   if (getSymSpellStatus().ready) {
//     const symResult = symspellCorrectQuery(cleanQuery);
//     if (symResult && symResult.corrected !== cleanQuery) {
//       const symClean = symResult.corrected;
//       console.log(`[Intent] SymSpell fixed cleanQuery: "${cleanQuery}" → "${symClean}"`);
//       const symFilteredResults = await searchProducts(symClean, filteredOptions);
//       if (symFilteredResults.totalHits >= 1) {
//         const intentFiltersWithSize = {
//           ...intent.filters,
//           ...(intent.sizeGroup ? { sizeGroup: intent.sizeGroup } : {})
//         };
//         analytics.intent.filtersApplied = true;
//         analytics.intent.resultsAfter = symFilteredResults.totalHits;
//         return {
//           originalQuery: query,
//           normalisedQuery: normalised,
//           correctedQuery: symClean,
//           wasCorrected: true,
//           correctionConfidence: 0.85,
//           correctionSource: 'symspell+intent',
//           intentFilters: intentFiltersWithSize,
//           intentCleanQuery: symClean,
//           results: symFilteredResults.hits,
//           totalHits: symFilteredResults.totalHits,
//           processingTime: Date.now() - startTime,
//           isFallback: false
//         };
//       }
//     }
//   }

//   // symspell couldn't fix it — try Ollama on cleanQuery ✅
//   // handles typos symspell dictionary doesn't know:
//   // "jaket" → "jacket", "pnik" → "pink", "frok" → "frock"
//   // Ollama fires here ONLY — not on full query (avoids 30s delays)
//   // after fix: learnedMap stores correction → instant next time ✅
//   const cleanWords = cleanQuery.split(/\s+/);
//   // only fire Ollama if there's a real word that looks like a typo
//   // exclude: pure numbers, short words (≤4), stopwords
//   // min length 5 prevents Ollama firing on "frok", "pnik" etc
//   // which cause 30s timeouts — add short typos to learnedMap manually
//   const typoWords = cleanWords.filter(w =>
//     w.length >= 5 &&            // min 5 chars — avoids short typos causing 30s Ollama
//     !/^\d+$/.test(w) &&        // not pure number like "10", "500"
//     !/\d/.test(w) &&            // not mixed like "10yrs"
//     !['under', 'above', 'below', 'for', 'with', 'and', 'years', 'year'].includes(w)
//   );
//   const looksLikeTypo = typoWords.length > 0;

//   if (looksLikeTypo) {
//     try {
//       // check if cleanQuery is a real word before firing Ollama
//       // real word = has unfiltered results → skip Ollama (saves 30s)
//       // typo = no unfiltered results → fire Ollama to fix it ✅
//       const wordCheck = await searchProducts(cleanQuery, { limit: 1 });
//       if (wordCheck.totalHits >= 20) {
//         console.log(`[Intent] "${cleanQuery}" is valid word (${wordCheck.totalHits} hits) — skipping Ollama`);
//       } else {
//         console.log(`[Intent] Trying Ollama on cleanQuery "${cleanQuery}"`);
//         const { correctQuery: ollamaCorrect } = require('../ollama/corrector');
//         const ollamaClean = await ollamaCorrect(cleanQuery);
//         if (
//           ollamaClean &&
//           ollamaClean !== cleanQuery &&
//           !ollamaClean.toLowerCase().includes('input unchanged') &&
//           !ollamaClean.toLowerCase().includes('no correction')
//         ) {
//           console.log(`[Intent] Ollama fixed cleanQuery: "${cleanQuery}" → "${ollamaClean}"`);
//           const ollamaFilteredResults = await searchProducts(ollamaClean, filteredOptions);
//           if (ollamaFilteredResults.totalHits >= 1) {
//             const intentFiltersWithSize = {
//               ...intent.filters,
//               ...(intent.sizeGroup ? { sizeGroup: intent.sizeGroup } : {})
//             };
//             analytics.intent.filtersApplied = true;
//             analytics.intent.resultsAfter = ollamaFilteredResults.totalHits;
//             safeSaveCorrection(cleanQuery, ollamaClean, 'ollama+intent', ollamaFilteredResults.hits.length);
//             return {
//               originalQuery: query,
//               normalisedQuery: normalised,
//               correctedQuery: ollamaClean,
//               wasCorrected: true,
//               correctionConfidence: 0.75,
//               correctionSource: 'ollama+intent',
//               intentFilters: intentFiltersWithSize,
//               intentCleanQuery: ollamaClean,
//               results: ollamaFilteredResults.hits,
//               totalHits: ollamaFilteredResults.totalHits,
//               processingTime: Date.now() - startTime,
//               isFallback: false
//             };
//           }
//         }
//       }
//     } catch (e) {
//       console.error('[Intent] Ollama cleanQuery correction failed:', e.message);
//     }
//   }

//   console.log(`[Intent] Filtered returned 0 → using unfiltered`);
//   return null;
// }

// // ─── SEARCH ───────────────────────────────────────────────

// async function runSearch(query, options = {}) {
//   const startTime = Date.now();

//   const analytics = {
//     requestId: options.requestId || null,
//     query,
//     normalised: null,
//     searchStage: 'meilisearch',
//     correctionDepth: 0,
//     correctionAttempted: false,
//     learnedMap: { hit: false },
//     symspell: { called: false },
//     ollama: { called: false },
//     correction: { applied: false },
//     intent: { parsed: false, filtersApplied: false, filters: {}, cleanQuery: null },
//     results: { count: 0, isFallback: false },
//     timing: { total: 0, symspell: 0, ollama: 0, meilisearch: 0, learnedmap: 0 }
//   };

//   // Step 1 — normalise
//   const normalised = normalise(query);
//   analytics.normalised = normalised;
//   if (!normalised) return buildEmptyResponse(query);

//   // Parse intent early — available to all steps
//   const intent = parseIntent(query);

//   // Step 2 — learnedMap check
//   const learnedMapStart = Date.now();
//   const correction = applyCorrection(query);
//   analytics.timing.learnedmap = Date.now() - learnedMapStart;

//   const searchQuery = correction.corrected ? correction.query : normalised;
//   const wasCorrected = correction.corrected;

//   if (wasCorrected) {
//     analytics.correctionAttempted = true;
//     analytics.learnedMap = {
//       hit: true,
//       correction: correction.query,
//       confidence: correction.confidence || null,
//       source: correction.source || null,
//       outcome: 'pending'
//     };
//   }

//   // Step 3 — search Meilisearch
//   const meilisearchStart = Date.now();
//   const results = await searchProducts(searchQuery, options);
//   analytics.timing.meilisearch = Date.now() - meilisearchStart;

//   // Step 4 — learnedMap correction validation
//   if (wasCorrected) {

//     if (results.hits.length === 0) {
//       analytics.learnedMap.outcome = 'zero_results';
//       analytics.learnedMap.resultsBefore = 0;

//       const symspellResult = await trySymSpellCorrection(
//         query, normalised, options, startTime, null, analytics, intent
//       );
//       if (symspellResult && symspellResult !== 'SYMSPELL_NOT_BETTER') {
//         analytics.results = buildResultsAnalytics(symspellResult.totalHits);
//         fireAnalytics(analytics, symspellResult, startTime);
//         return symspellResult;
//       }

//       if (!shouldSkipOllama(query, 0) && symspellResult !== 'SYMSPELL_NOT_BETTER') {
//         const ollamaResult = await tryOllamaCorrection(
//           query, normalised, options, startTime, null, analytics, intent
//         );
//         if (ollamaResult) {
//           analytics.results = buildResultsAnalytics(ollamaResult.totalHits);
//           fireAnalytics(analytics, ollamaResult, startTime);
//           return ollamaResult;
//         }
//       }

//       const popular = await getPopularProducts(10);
//       analytics.searchStage = 'fallback';
//       analytics.results = buildResultsAnalytics(popular.length, true, 'no results found');
//       fireAnalytics(analytics, null, startTime);
//       return {
//         originalQuery: query,
//         normalisedQuery: normalised,
//         correctedQuery: null,
//         wasCorrected: false,
//         correctionConfidence: null,
//         correctionSource: null,
//         results: popular,
//         totalHits: popular.length,
//         processingTime: Date.now() - startTime,
//         isFallback: true,
//         fallbackReason: 'no results found'
//       };
//     }

//     const originalResults = await searchProducts(normalised, options);

//     if (results.totalHits < originalResults.totalHits) {
//       console.log(`[Layer1] "${query}" → "${searchQuery}" blocked`);
//       analytics.learnedMap.outcome = 'penalised';
//       analytics.learnedMap.resultsBefore = originalResults.totalHits;
//       analytics.learnedMap.resultsAfter = results.totalHits;

//       try { penaliseCorrection(query); } catch (e) {}

//       const response = {
//         originalQuery: query,
//         normalisedQuery: normalised,
//         correctedQuery: null,
//         wasCorrected: false,
//         correctionConfidence: null,
//         correctionSource: null,
//         results: originalResults.hits,
//         totalHits: originalResults.totalHits,
//         processingTime: Date.now() - startTime,
//         isFallback: false
//       };
//       analytics.searchStage = 'learnedmap';
//       analytics.results = buildResultsAnalytics(originalResults.totalHits);
//       fireAnalytics(analytics, response, startTime);
//       return response;
//     }

//     if (
//       results.hits.length >= MIN_RESULTS_TO_LEARN &&
//       results.totalHits >= originalResults.totalHits + MIN_IMPROVEMENT
//     ) {
//       console.log(`[Learn] Correction: "${query}" → "${searchQuery}"`);
//       safeSaveCorrection(query, searchQuery, correction.source || 'manual', results.hits.length);
//     }

//     analytics.learnedMap.outcome = 'accepted';
//     analytics.learnedMap.resultsBefore = originalResults.totalHits;
//     analytics.learnedMap.resultsAfter = results.totalHits;
//     analytics.searchStage = 'learnedmap';
//     analytics.correctionDepth = 1;
//     analytics.correction = {
//       applied: true,
//       finalQuery: searchQuery,
//       source: correction.source || 'manual',
//       confidence: correction.confidence || null,
//       improvement: results.totalHits - originalResults.totalHits
//     };

//     // apply intent on top of learnedMap corrected results ✅
//     // re-parse intent from learnedMap corrected query ✅
//     const lmReparsed = parseIntent(searchQuery);
//     const lmActiveIntent = hasFilters(lmReparsed) ? lmReparsed : intent;
//     const intentResult4 = await applyIntentIfNeeded(
//       lmActiveIntent, query, searchQuery, options, results, startTime, analytics
//     );
//     if (intentResult4) {
//       analytics.results = buildResultsAnalytics(intentResult4.totalHits);
//       fireAnalytics(analytics, intentResult4, startTime);
//       return intentResult4;
//     }

//     const response = {
//       originalQuery: query,
//       normalisedQuery: normalised,
//       correctedQuery: searchQuery,
//       wasCorrected: true,
//       correctionConfidence: correction.confidence || null,
//       correctionSource: correction.source || null,
//       results: results.hits,
//       totalHits: results.totalHits,
//       processingTime: Date.now() - startTime,
//       isFallback: false
//     };
//     analytics.results = buildResultsAnalytics(results.totalHits);
//     fireAnalytics(analytics, response, startTime);
//     return response;
//   }

//   // Step 5 — zero results → try corrections
//   if (results.totalHits === 0) {
//     const symspellResult = await trySymSpellCorrection(
//       query, normalised, options, startTime, null, analytics, intent
//     );
//     if (symspellResult && symspellResult !== 'SYMSPELL_NOT_BETTER') {
//       analytics.results = buildResultsAnalytics(symspellResult.totalHits);
//       fireAnalytics(analytics, symspellResult, startTime);
//       return symspellResult;
//     }

//     if (!shouldSkipOllama(query, 0) && symspellResult !== 'SYMSPELL_NOT_BETTER') {
//       const ollamaResult = await tryOllamaCorrection(
//         query, normalised, options, startTime, null, analytics, intent
//       );
//       if (ollamaResult) {
//         analytics.results = buildResultsAnalytics(ollamaResult.totalHits);
//         fireAnalytics(analytics, ollamaResult, startTime);
//         return ollamaResult;
//       }
//     }

//     const popular = await getPopularProducts(10);
//     analytics.searchStage = 'fallback';
//     analytics.results = buildResultsAnalytics(popular.length, true, 'no results found');
//     fireAnalytics(analytics, null, startTime);
//     return {
//       originalQuery: query,
//       normalisedQuery: normalised,
//       correctedQuery: null,
//       wasCorrected: false,
//       correctionConfidence: null,
//       correctionSource: null,
//       results: popular,
//       totalHits: popular.length,
//       processingTime: Date.now() - startTime,
//       isFallback: true,
//       fallbackReason: 'no results found'
//     };
//   }

//   // Step 6 — weak results → try corrections
//   if (results.totalHits < WEAK_RESULTS_THRESHOLD) {

//     const abbCorrection = applyCorrection(query, 0);
//     if (abbCorrection.corrected) {
//       const abbResults = await searchProducts(abbCorrection.query, options);

//       if (
//         abbResults.hits.length >= MIN_RESULTS_TO_LEARN &&
//         abbResults.totalHits > results.totalHits
//       ) {
//         console.log(`[Learn] Abbreviation: "${query}" → "${abbCorrection.query}"`);
//         safeSaveCorrection(query, abbCorrection.query, abbCorrection.source || 'manual', abbResults.hits.length);

//         analytics.searchStage = 'learnedmap';
//         analytics.correctionDepth = 1;
//         analytics.learnedMap = {
//           hit: true,
//           correction: abbCorrection.query,
//           outcome: 'accepted',
//           resultsBefore: results.totalHits,
//           resultsAfter: abbResults.totalHits
//         };
//         analytics.correction = {
//           applied: true,
//           finalQuery: abbCorrection.query,
//           source: abbCorrection.source || 'manual',
//           confidence: abbCorrection.confidence || null,
//           improvement: abbResults.totalHits - results.totalHits
//         };

//         // re-parse intent from abbreviation corrected query ✅
//         const abbReparsed = parseIntent(abbCorrection.query);
//         const abbActiveIntent = hasFilters(abbReparsed) ? abbReparsed : intent;
//         const intentResult6abb = await applyIntentIfNeeded(
//           abbActiveIntent, query, abbCorrection.query, options, abbResults, startTime, analytics
//         );
//         if (intentResult6abb) {
//           analytics.results = buildResultsAnalytics(intentResult6abb.totalHits);
//           fireAnalytics(analytics, intentResult6abb, startTime);
//           return intentResult6abb;
//         }

//         const response = {
//           originalQuery: query,
//           normalisedQuery: normalised,
//           correctedQuery: abbCorrection.query,
//           wasCorrected: true,
//           correctionConfidence: abbCorrection.confidence || null,
//           correctionSource: abbCorrection.source || null,
//           results: abbResults.hits,
//           totalHits: abbResults.totalHits,
//           processingTime: Date.now() - startTime,
//           isFallback: false
//         };
//         analytics.results = buildResultsAnalytics(abbResults.totalHits);
//         fireAnalytics(analytics, response, startTime);
//         return response;
//       }
//     }

//     const symspellResult = await trySymSpellCorrection(
//       query, normalised, options, startTime, results, analytics, intent
//     );
//     if (symspellResult && symspellResult !== 'SYMSPELL_NOT_BETTER') {
//       analytics.results = buildResultsAnalytics(symspellResult.totalHits);
//       fireAnalytics(analytics, symspellResult, startTime);
//       return symspellResult;
//     }

//     if (!shouldSkipOllama(query, results.totalHits) && symspellResult !== 'SYMSPELL_NOT_BETTER') {
//       const ollamaResult = await tryOllamaCorrection(
//         query, normalised, options, startTime, results, analytics, intent
//       );
//       if (ollamaResult) {
//         analytics.results = buildResultsAnalytics(ollamaResult.totalHits);
//         fireAnalytics(analytics, ollamaResult, startTime);
//         return ollamaResult;
//       }
//     }
//   }

//   // Step 7 — good results → apply intent filters ✅
//   analytics.searchStage = 'meilisearch';
//   analytics.correctionDepth = 0;

//   // try symspell on full query — may fix typo in product word ✅
//   let activeIntent7 = intent;
//   if (intent && hasFilters(intent) && getSymSpellStatus().ready) {
//     const symOnFull = symspellCorrectQuery(query);
//     if (symOnFull && symOnFull.corrected !== normalised && symOnFull.correctionsApplied > 0) {
//       const reparsed = parseIntent(symOnFull.corrected);
//       if (hasFilters(reparsed) && reparsed.cleanQuery !== intent.cleanQuery) {
//         activeIntent7 = reparsed;
//         console.log(`[Step7] Reparsed intent: "${query}" → "${symOnFull.corrected}"`);
//       }
//     }
//   }
//   const intentResult = await applyIntentIfNeeded(
//     activeIntent7, query, normalised, options, results, startTime, analytics
//   );
//   if (intentResult) {
//     analytics.results = buildResultsAnalytics(intentResult.totalHits);
//     fireAnalytics(analytics, intentResult, startTime);
//     return intentResult;
//   }

//   analytics.results = buildResultsAnalytics(results.totalHits);
//   const response = {
//     originalQuery: query,
//     normalisedQuery: normalised,
//     correctedQuery: null,
//     wasCorrected: false,
//     correctionConfidence: null,
//     correctionSource: null,
//     results: results.hits,
//     totalHits: results.totalHits,
//     processingTime: Date.now() - startTime,
//     isFallback: false
//   };
//   fireAnalytics(analytics, response, startTime);
//   return response;
// }

// // ─── FIRE ANALYTICS ───────────────────────────────────────

// function fireAnalytics(analytics, response, startTime) {
//   try {
//     analytics.timing.total = Date.now() - startTime;
//     logSearchEvent(analytics);
//   } catch (e) {
//     // silent — analytics never breaks search
//   }
// }

// // ─── SYMSPELL CORRECTION HELPER ───────────────────────────

// async function trySymSpellCorrection(query, normalised, options, startTime, originalResults = null, analytics = {}, intent = null) {
//   try {
//     if (!getSymSpellStatus().ready) return null;

//     const symStart = Date.now();
//     const symspellResult = symspellCorrectQuery(query);
//     const symTime = Date.now() - symStart;

//     analytics.correctionAttempted = true;
//     analytics.symspell = {
//       called: true,
//       timeTaken: symTime,
//       candidate: null,
//       outcome: 'skipped'
//     };
//     analytics.timing.symspell = symTime;

//     if (!symspellResult) return null;

//     const corrected = symspellResult.corrected;
//     analytics.symspell.candidate = corrected;
//     analytics.symspell.changedWords = symspellResult.changedWords || [];
//     analytics.symspell.correctionsCount = symspellResult.correctionsApplied || 0;

//     if (corrected === normalised) {
//       analytics.symspell.outcome = 'same_as_original';
//       return null;
//     }

//     console.log(`[SymSpell] Candidate: "${query}" → "${corrected}"`);

//     const correctedResults = await searchProducts(corrected, options);
//     analytics.symspell.resultsBefore = originalResults?.totalHits || 0;
//     analytics.symspell.resultsAfter = correctedResults.totalHits;

//     if (correctedResults.hits.length < MIN_RESULTS_TO_LEARN) {
//       analytics.symspell.outcome = 'rejected_no_results';
//       analytics.symspell.rejectionReason = `only ${correctedResults.hits.length} results`;
//       return null;
//     }

//     const originalAtLimit = originalResults?.totalHits >= MAX_RESULTS_LIMIT;
//     if (!originalAtLimit && originalResults && correctedResults.totalHits <= originalResults.totalHits) {
//       analytics.symspell.outcome = 'rejected_not_better';
//       analytics.symspell.rejectionReason = `${correctedResults.totalHits} <= ${originalResults.totalHits}`;
//       // Fix 2: symspell found a candidate but results didn't improve
//       // signal to caller to skip Ollama — it cannot do better ✅
//       return 'SYMSPELL_NOT_BETTER';
//     }

//     analytics.symspell.outcome = 'accepted';
//     analytics.searchStage = 'symspell';
//     analytics.correctionDepth = 2;
//     analytics.correction = {
//       applied: true,
//       finalQuery: corrected,
//       source: 'symspell',
//       confidence: 0.85,
//       improvement: correctedResults.totalHits - (originalResults?.totalHits || 0)
//     };

//     console.log(`[SymSpell] Accepted: "${query}" → "${corrected}" (${correctedResults.totalHits} results)`);
//     safeSaveCorrection(query, corrected, 'symspell', correctedResults.hits.length);

//     // apply intent on top of symspell correction ✅
//     // re-parse intent from corrected query ✅
//     // original intent had typo in cleanQuery e.g. "kurtaa"
//     // corrected query has correct word e.g. "kurta"
//     const correctedIntent = parseIntent(corrected);
//     const activeIntent = hasFilters(correctedIntent) ? correctedIntent : intent;
//     if (activeIntent && hasFilters(activeIntent)) {
//       const intentResult = await applyIntentIfNeeded(
//         activeIntent, query, corrected, options, correctedResults, startTime, analytics
//       );
//       if (intentResult) return intentResult;
//     }

//     return {
//       originalQuery: query,
//       normalisedQuery: normalised,
//       correctedQuery: corrected,
//       wasCorrected: true,
//       correctionConfidence: 0.85,
//       correctionSource: 'symspell',
//       results: correctedResults.hits,
//       totalHits: correctedResults.totalHits,
//       processingTime: Date.now() - startTime,
//       isFallback: false
//     };

//   } catch (err) {
//     console.error('trySymSpellCorrection error:', err.message);
//     return null;
//   }
// }

// // ─── OLLAMA CORRECTION HELPER ─────────────────────────────

// async function tryOllamaCorrection(query, normalised, options, startTime, originalResults = null, analytics = {}, intent = null) {
//   try {
//     const ollamaStart = Date.now();
//     const ollamaCorrection = await ollamaCorrectQuery(query);
//     const ollamaTime = Date.now() - ollamaStart;

//     analytics.correctionAttempted = true;
//     analytics.ollama = {
//       called: true,
//       timeTaken: ollamaTime,
//       candidate: ollamaCorrection || null,
//       outcome: 'skipped'
//     };
//     analytics.timing.ollama = ollamaTime;

//     if (!ollamaCorrection) return null;

//     if (ollamaCorrection === normalised || ollamaCorrection === query) {
//       analytics.ollama.outcome = 'same_as_original';
//       return null;
//     }
//     if (
//       ollamaCorrection.toLowerCase().includes('input unchanged') ||
//       ollamaCorrection.toLowerCase().includes('no correction')
//     ) {
//       console.log(`[Ollama] Hallucination detected — "${ollamaCorrection}"`);
//       analytics.ollama.outcome = 'hallucination';
//       return null;
//     }

//     console.log(`[Ollama] Candidate: "${query}" → "${ollamaCorrection}"`);

//     const ollamaResults = await searchProducts(ollamaCorrection, options);
//     analytics.ollama.resultsBefore = originalResults?.totalHits || 0;
//     analytics.ollama.resultsAfter = ollamaResults.totalHits;

//     if (ollamaResults.hits.length < OLLAMA_MIN_RESULTS) {
//       analytics.ollama.outcome = 'rejected_no_results';
//       analytics.ollama.rejectionReason = `only ${ollamaResults.hits.length} results`;
//       return null;
//     }

//     const originalAtLimit = originalResults?.totalHits >= MAX_RESULTS_LIMIT;
//     if (!originalAtLimit && originalResults && ollamaResults.totalHits <= originalResults.totalHits) {
//       analytics.ollama.outcome = 'rejected_not_better';
//       analytics.ollama.rejectionReason = `${ollamaResults.totalHits} <= ${originalResults.totalHits}`;
//       return null;
//     }

//     analytics.ollama.outcome = 'accepted';
//     analytics.searchStage = 'ollama';
//     analytics.correctionDepth = 3;
//     analytics.correction = {
//       applied: true,
//       finalQuery: ollamaCorrection,
//       source: 'ollama',
//       confidence: 0.75,
//       improvement: ollamaResults.totalHits - (originalResults?.totalHits || 0)
//     };

//     console.log(`[Ollama] Accepted: "${query}" → "${ollamaCorrection}" (${ollamaResults.totalHits} results)`);
//     safeSaveCorrection(query, ollamaCorrection, 'ollama', ollamaResults.hits.length);

//     // apply intent on top of ollama correction ✅
//     // re-parse intent from ollama corrected query ✅
//     const correctedIntent = parseIntent(ollamaCorrection);
//     const activeIntent = hasFilters(correctedIntent) ? correctedIntent : intent;
//     if (activeIntent && hasFilters(activeIntent)) {
//       const intentResult = await applyIntentIfNeeded(
//         activeIntent, query, ollamaCorrection, options, ollamaResults, startTime, analytics
//       );
//       if (intentResult) return intentResult;
//     }

//     return {
//       originalQuery: query,
//       normalisedQuery: normalised,
//       correctedQuery: ollamaCorrection,
//       wasCorrected: true,
//       correctionConfidence: 0.75,
//       correctionSource: 'ollama',
//       results: ollamaResults.hits,
//       totalHits: ollamaResults.totalHits,
//       processingTime: Date.now() - startTime,
//       isFallback: false
//     };

//   } catch (err) {
//     console.error('tryOllamaCorrection error:', err.message);
//     return null;
//   }
// }

// // ─── SUGGEST ──────────────────────────────────────────────

// async function runSuggest(query, options = {}) {
//   const normalised = normalise(query);
//   if (!normalised) return { products: [], categories: [] };

//   const correction = applyCorrection(query);
//   const searchQuery = correction.corrected ? correction.query : normalised;

//   let finalQuery = searchQuery;
//   let wasCorrected = correction.corrected;
//   let correctionSource = correction.corrected ? correction.source : null;
//   let correctionConfidence = correction.corrected ? (correction.confidence || null) : null;

//   if (!wasCorrected && getSymSpellStatus().ready) {
//     const symspellResult = symspellCorrectQuery(normalised);
//     if (symspellResult) {
//       finalQuery = symspellResult.corrected;
//       wasCorrected = true;
//       correctionSource = 'symspell';
//       correctionConfidence = 0.85;
//     }
//   }

//   const suggestions = await getSuggestions(finalQuery, options);

//   return {
//     query: normalised,
//     originalQuery: query,
//     correctedQuery: wasCorrected ? finalQuery : null,
//     wasCorrected,
//     correctionConfidence,
//     correctionSource,
//     products: suggestions.products,
//     categories: suggestions.categories
//   };
// }

// // ─── NAVIGATE ─────────────────────────────────────────────

// async function runNavigate(category, subcategory, options = {}) {
//   if (!category) return buildEmptyResponse('');

//   const startTime = Date.now();
//   const results = await navigateCategory(category, subcategory, options);

//   if (results.hits.length === 0) {
//     const popular = await getPopularProducts(10);
//     return {
//       category,
//       subcategory,
//       subCategory: options.subCategory || null,
//       results: popular,
//       totalHits: popular.length,
//       processingTime: Date.now() - startTime,
//       isFallback: true,
//       fallbackReason: 'no products in category'
//     };
//   }

//   return {
//     category,
//     subcategory,
//     subCategory: options.subCategory || null,
//     results: results.hits,
//     totalHits: results.totalHits,
//     processingTime: Date.now() - startTime,
//     isFallback: false
//   };
// }

// // ─── EMPTY RESPONSE ───────────────────────────────────────

// function buildEmptyResponse(query) {
//   return {
//     originalQuery: query,
//     normalisedQuery: '',
//     correctedQuery: null,
//     wasCorrected: false,
//     correctionConfidence: null,
//     correctionSource: null,
//     results: [],
//     totalHits: 0,
//     processingTime: 0,
//     isFallback: false,
//     isEmpty: true
//   };
// }

// module.exports = { runSearch, runSuggest, runNavigate };



















































// const { normalise } = require('./normalise');
// const {
//   searchProducts,
//   getSuggestions,
//   navigateCategory,
//   getPopularProducts
// } = require('../meilisearch/searcher');
// const {
//   applyCorrection,
//   saveCorrection,
//   penaliseCorrection
// } = require('../learned/learnedMap');
// const { correctQuery: ollamaCorrectQuery } = require('../ollama/corrector');
// const { correctQuery: symspellCorrectQuery, getStatus: getSymSpellStatus, shouldSkip: symspellShouldSkip } = require('../spellcheck/symspell');
// const { logSearchEvent } = require('../../analytics/logger');
// const { parseIntent, hasFilters } = require('./intentParser');

// // ─── CONFIG ───────────────────────────────────────────────
// const MIN_RESULTS_TO_LEARN = 5;
// const MIN_IMPROVEMENT = 5;
// const WEAK_RESULTS_THRESHOLD = 20;
// const OLLAMA_MIN_RESULTS = 15;
// const MAX_RESULTS_LIMIT = 1000;

// // ─── SAFE SAVE ────────────────────────────────────────────

// function safeSaveCorrection(query, corrected, source, hitCount) {
//   try {
//     const chainCheck = applyCorrection(corrected);
//     if (chainCheck.corrected) {
//       console.log(`[SafeSave] Chain detected — skipped: "${corrected}" → "${chainCheck.query}"`);
//       return;
//     }
//     saveCorrection(query, corrected, source, hitCount);
//   } catch (e) {
//     console.error('saveCorrection error:', e.message);
//   }
// }

// // ─── RESULTS HELPER ───────────────────────────────────────

// function buildResultsAnalytics(totalHits, isFallback = false, fallbackReason = null) {
//   return {
//     count: totalHits,
//     isFallback,
//     fallbackReason,
//     isZeroResult: totalHits === 0,
//     isWeakResult: totalHits > 0 && totalHits <= WEAK_RESULTS_THRESHOLD
//   };
// }

// // ─── SHOULD SKIP OLLAMA ───────────────────────────────────
// // Ollama is expensive — skip when query doesn't need it

// function shouldSkipOllama(query, totalHits) {
//   // enough results → no correction needed
//   if (totalHits >= WEAK_RESULTS_THRESHOLD) return true;

//   // at max results → correction cannot improve
//   if (totalHits >= MAX_RESULTS_LIMIT) return true;

//   const words = query.toLowerCase().trim().split(/\s+/);

//   // single word model number → skip
//   if (words.length === 1 && symspellShouldSkip(words[0])) return true;

//   // any word contains a digit → model number / spec / version
//   // catches ps5, 4k, 256gb, iphone15, redmi12 etc
//   if (words.some(w => /\d/.test(w))) return true;

//   // any word too short → skip
//   // catches xbox(4), ps5(3), tv(2), ac(2) etc
//   if (words.some(w => w.length < 5)) return true;

//   // symspell made zero corrections → all words already correct
//   // Ollama cannot improve correct spelling
//   // catches: paneer fresh, basmati chawal, masscara waterproof etc
//   const symResult = symspellCorrectQuery(query);
//   if (!symResult || symResult.correctionsApplied === 0) return true;

//   return false;
// }

// // ─── SEARCH ───────────────────────────────────────────────

// async function runSearch(query, options = {}) {
//   const startTime = Date.now();

//   const analytics = {
//     requestId: options.requestId || null,
//     query,
//     normalised: null,
//     searchStage: 'meilisearch',
//     correctionDepth: 0,
//     correctionAttempted: false,
//     learnedMap: { hit: false },
//     symspell: { called: false },
//     ollama: { called: false },
//     correction: { applied: false },
//     results: { count: 0, isFallback: false },
//     timing: { total: 0, symspell: 0, ollama: 0, meilisearch: 0, learnedmap: 0 }
//   };

//   // Step 1 — normalise
//   const normalised = normalise(query);
//   analytics.normalised = normalised;
//   if (!normalised) return buildEmptyResponse(query);

//   // Step 2 — learnedMap check
//   // timed separately from Meilisearch
//   const learnedMapStart = Date.now();
//   const correction = applyCorrection(query);
//   analytics.timing.learnedmap = Date.now() - learnedMapStart;

//   const searchQuery = correction.corrected ? correction.query : normalised;
//   const wasCorrected = correction.corrected;

//   if (wasCorrected) {
//     analytics.correctionAttempted = true;
//     analytics.learnedMap = {
//       hit: true,
//       correction: correction.query,
//       confidence: correction.confidence || null,
//       source: correction.source || null,
//       outcome: 'pending'
//     };
//   }

//   // Step 3 — search Meilisearch
//   const meilisearchStart = Date.now();
//   const results = await searchProducts(searchQuery, options);
//   analytics.timing.meilisearch = Date.now() - meilisearchStart;

//   // Step 4 — learnedMap correction validation
//   if (wasCorrected) {

//     // zero results → try SymSpell then Ollama
//     if (results.hits.length === 0) {
//       analytics.learnedMap.outcome = 'zero_results';
//       analytics.learnedMap.resultsBefore = 0;

//       const symspellResult = await trySymSpellCorrection(
//         query, normalised, options, startTime, null, analytics
//       );
//       if (symspellResult) {
//         analytics.results = buildResultsAnalytics(symspellResult.totalHits);
//         fireAnalytics(analytics, symspellResult, startTime);
//         return symspellResult;
//       }

//       // Ollama gated by shouldSkipOllama ✅
//       if (!shouldSkipOllama(query, 0)) {
//         const ollamaResult = await tryOllamaCorrection(
//           query, normalised, options, startTime, null, analytics
//         );
//         if (ollamaResult) {
//           analytics.results = buildResultsAnalytics(ollamaResult.totalHits);
//           fireAnalytics(analytics, ollamaResult, startTime);
//           return ollamaResult;
//         }
//       }

//       const popular = await getPopularProducts(10);
//       analytics.searchStage = 'fallback';
//       analytics.results = buildResultsAnalytics(popular.length, true, 'no results found');
//       fireAnalytics(analytics, null, startTime);
//       return {
//         originalQuery: query,
//         normalisedQuery: normalised,
//         correctedQuery: null,
//         wasCorrected: false,
//         correctionConfidence: null,
//         correctionSource: null,
//         results: popular,
//         totalHits: popular.length,
//         processingTime: Date.now() - startTime,
//         isFallback: true,
//         fallbackReason: 'no results found'
//       };
//     }

//     // compare corrected vs original
//     const originalResults = await searchProducts(normalised, options);

//     // corrected is worse → penalise
//     if (results.totalHits < originalResults.totalHits) {
//       console.log(`[Layer1] "${query}" → "${searchQuery}" blocked`);
//       analytics.learnedMap.outcome = 'penalised';
//       analytics.learnedMap.resultsBefore = originalResults.totalHits;
//       analytics.learnedMap.resultsAfter = results.totalHits;

//       try { penaliseCorrection(query); } catch (e) {}

//       const response = {
//         originalQuery: query,
//         normalisedQuery: normalised,
//         correctedQuery: null,
//         wasCorrected: false,
//         correctionConfidence: null,
//         correctionSource: null,
//         results: originalResults.hits,
//         totalHits: originalResults.totalHits,
//         processingTime: Date.now() - startTime,
//         isFallback: false
//       };
//       analytics.searchStage = 'learnedmap';
//       analytics.results = buildResultsAnalytics(originalResults.totalHits);
//       fireAnalytics(analytics, response, startTime);
//       return response;
//     }

//     // corrected is better → strengthen
//     if (
//       results.hits.length >= MIN_RESULTS_TO_LEARN &&
//       results.totalHits >= originalResults.totalHits + MIN_IMPROVEMENT
//     ) {
//       console.log(`[Learn] Correction: "${query}" → "${searchQuery}"`);
//       safeSaveCorrection(query, searchQuery, correction.source || 'manual', results.hits.length);
//     }

//     analytics.learnedMap.outcome = 'accepted';
//     analytics.learnedMap.resultsBefore = originalResults.totalHits;
//     analytics.learnedMap.resultsAfter = results.totalHits;
//     analytics.searchStage = 'learnedmap';
//     analytics.correctionDepth = 1;
//     analytics.correction = {
//       applied: true,
//       finalQuery: searchQuery,
//       source: correction.source || 'manual',
//       confidence: correction.confidence || null,
//       improvement: results.totalHits - originalResults.totalHits
//     };

//     const response = {
//       originalQuery: query,
//       normalisedQuery: normalised,
//       correctedQuery: searchQuery,
//       wasCorrected: true,
//       correctionConfidence: correction.confidence || null,
//       correctionSource: correction.source || null,
//       results: results.hits,
//       totalHits: results.totalHits,
//       processingTime: Date.now() - startTime,
//       isFallback: false
//     };
//     analytics.results = buildResultsAnalytics(results.totalHits);
//     fireAnalytics(analytics, response, startTime);
//     return response;
//   }

//   // Step 5 — zero results → try corrections
//   if (results.totalHits === 0) {
//     const symspellResult = await trySymSpellCorrection(
//       query, normalised, options, startTime, null, analytics
//     );
//     if (symspellResult) {
//       analytics.results = buildResultsAnalytics(symspellResult.totalHits);
//       fireAnalytics(analytics, symspellResult, startTime);
//       return symspellResult;
//     }

//     if (!shouldSkipOllama(query, 0)) {
//       const ollamaResult = await tryOllamaCorrection(
//         query, normalised, options, startTime, null, analytics
//       );
//       if (ollamaResult) {
//         analytics.results = buildResultsAnalytics(ollamaResult.totalHits);
//         fireAnalytics(analytics, ollamaResult, startTime);
//         return ollamaResult;
//       }
//     }

//     const popular = await getPopularProducts(10);
//     analytics.searchStage = 'fallback';
//     analytics.results = buildResultsAnalytics(popular.length, true, 'no results found');
//     fireAnalytics(analytics, null, startTime);
//     return {
//       originalQuery: query,
//       normalisedQuery: normalised,
//       correctedQuery: null,
//       wasCorrected: false,
//       correctionConfidence: null,
//       correctionSource: null,
//       results: popular,
//       totalHits: popular.length,
//       processingTime: Date.now() - startTime,
//       isFallback: true,
//       fallbackReason: 'no results found'
//     };
//   }

//   // Step 6 — weak results → try corrections
//   if (results.totalHits < WEAK_RESULTS_THRESHOLD) {

//     // try learnedMap abbreviation first
//     const abbCorrection = applyCorrection(query, 0);
//     if (abbCorrection.corrected) {
//       const abbResults = await searchProducts(abbCorrection.query, options);

//       if (
//         abbResults.hits.length >= MIN_RESULTS_TO_LEARN &&
//         abbResults.totalHits > results.totalHits
//       ) {
//         console.log(`[Learn] Abbreviation: "${query}" → "${abbCorrection.query}"`);
//         safeSaveCorrection(query, abbCorrection.query, abbCorrection.source || 'manual', abbResults.hits.length);

//         analytics.searchStage = 'learnedmap';
//         analytics.correctionDepth = 1;
//         analytics.learnedMap = {
//           hit: true,
//           correction: abbCorrection.query,
//           outcome: 'accepted',
//           resultsBefore: results.totalHits,
//           resultsAfter: abbResults.totalHits
//         };
//         analytics.correction = {
//           applied: true,
//           finalQuery: abbCorrection.query,
//           source: abbCorrection.source || 'manual',
//           confidence: abbCorrection.confidence || null,
//           improvement: abbResults.totalHits - results.totalHits
//         };

//         const response = {
//           originalQuery: query,
//           normalisedQuery: normalised,
//           correctedQuery: abbCorrection.query,
//           wasCorrected: true,
//           correctionConfidence: abbCorrection.confidence || null,
//           correctionSource: abbCorrection.source || null,
//           results: abbResults.hits,
//           totalHits: abbResults.totalHits,
//           processingTime: Date.now() - startTime,
//           isFallback: false
//         };
//         analytics.results = buildResultsAnalytics(abbResults.totalHits);
//         fireAnalytics(analytics, response, startTime);
//         return response;
//       }
//     }

//     // try SymSpell
//     const symspellResult = await trySymSpellCorrection(
//       query, normalised, options, startTime, results, analytics
//     );
//     if (symspellResult) {
//       analytics.results = buildResultsAnalytics(symspellResult.totalHits);
//       fireAnalytics(analytics, symspellResult, startTime);
//       return symspellResult;
//     }

//     // Ollama only if not skippable
//     if (!shouldSkipOllama(query, results.totalHits)) {
//       const ollamaResult = await tryOllamaCorrection(
//         query, normalised, options, startTime, results, analytics
//       );
//       if (ollamaResult) {
//         analytics.results = buildResultsAnalytics(ollamaResult.totalHits);
//         fireAnalytics(analytics, ollamaResult, startTime);
//         return ollamaResult;
//       }
//     }
//   }

//   // Step 7 — good results → apply intent filters if any
//   analytics.searchStage = 'meilisearch';
//   analytics.correctionDepth = 0;

//   // parse intent from original query
//   const intent = parseIntent(query);

//   if (hasFilters(intent)) {
//     // build filtered options
//     const filteredOptions = { ...options };
//     if (intent.filters.category)  filteredOptions.category  = intent.filters.category;
//     if (intent.filters.color)     filteredOptions.color     = intent.filters.color;
//     if (intent.filters.brand)     filteredOptions.brand     = intent.filters.brand;
//     if (intent.filters.minPrice)  filteredOptions.minPrice  = intent.filters.minPrice;
//     if (intent.filters.maxPrice)  filteredOptions.maxPrice  = intent.filters.maxPrice;
//     if (intent.sizeGroup)         filteredOptions.size      = intent.sizeGroup;

//     // search with filters using clean query
//     const filteredResults = await searchProducts(intent.cleanQuery || normalised, filteredOptions);

//     console.log(`[Intent] "${query}" → "${intent.cleanQuery}" filters:${JSON.stringify(intent.filters)} results:${filteredResults.totalHits}`);

//     // use filtered results if they return something meaningful
//     if (filteredResults.totalHits >= 1) {
//       analytics.results = buildResultsAnalytics(filteredResults.totalHits);
//       return {
//         originalQuery: query,
//         normalisedQuery: normalised,
//         correctedQuery: null,
//         wasCorrected: false,
//         correctionConfidence: null,
//         correctionSource: null,
//         intentFilters: intent.filters,
//         intentCleanQuery: intent.cleanQuery,
//         results: filteredResults.hits,
//         totalHits: filteredResults.totalHits,
//         processingTime: Date.now() - startTime,
//         isFallback: false
//       };
//     }
//     // filtered returned 0 → fall through to unfiltered
//     console.log(`[Intent] Filtered returned 0 → using unfiltered results`);
//   }

//   analytics.results = buildResultsAnalytics(results.totalHits);
//   const response = {
//     originalQuery: query,
//     normalisedQuery: normalised,
//     correctedQuery: null,
//     wasCorrected: false,
//     correctionConfidence: null,
//     correctionSource: null,
//     results: results.hits,
//     totalHits: results.totalHits,
//     processingTime: Date.now() - startTime,
//     isFallback: false
//   };
//   fireAnalytics(analytics, response, startTime);
//   return response;
// }

// // ─── FIRE ANALYTICS ───────────────────────────────────────

// function fireAnalytics(analytics, response, startTime) {
//   try {
//     analytics.timing.total = Date.now() - startTime;
//     logSearchEvent(analytics);
//   } catch (e) {
//     // silent — analytics never breaks search
//   }
// }

// // ─── SYMSPELL CORRECTION HELPER ───────────────────────────

// async function trySymSpellCorrection(query, normalised, options, startTime, originalResults = null, analytics = {}) {
//   try {
//     if (!getSymSpellStatus().ready) return null;

//     const symStart = Date.now();
//     const symspellResult = symspellCorrectQuery(query);
//     const symTime = Date.now() - symStart;

//     analytics.correctionAttempted = true;
//     analytics.symspell = {
//       called: true,
//       timeTaken: symTime,
//       candidate: null,
//       outcome: 'skipped'
//     };
//     analytics.timing.symspell = symTime;

//     if (!symspellResult) return null;

//     const corrected = symspellResult.corrected;
//     analytics.symspell.candidate = corrected;
//     analytics.symspell.changedWords = symspellResult.changedWords || [];
//     analytics.symspell.correctionsCount = symspellResult.correctionsApplied || 0;

//     if (corrected === normalised) {
//       analytics.symspell.outcome = 'same_as_original';
//       return null;
//     }

//     console.log(`[SymSpell] Candidate: "${query}" → "${corrected}"`);

//     const correctedResults = await searchProducts(corrected, options);
//     analytics.symspell.resultsBefore = originalResults?.totalHits || 0;
//     analytics.symspell.resultsAfter = correctedResults.totalHits;

//     if (correctedResults.hits.length < MIN_RESULTS_TO_LEARN) {
//       analytics.symspell.outcome = 'rejected_no_results';
//       analytics.symspell.rejectionReason = `only ${correctedResults.hits.length} results`;
//       return null;
//     }

//     // skip improvement check if original was at limit
//     const originalAtLimit = originalResults?.totalHits >= MAX_RESULTS_LIMIT;
//     if (!originalAtLimit && originalResults && correctedResults.totalHits <= originalResults.totalHits) {
//       analytics.symspell.outcome = 'rejected_not_better';
//       analytics.symspell.rejectionReason = `${correctedResults.totalHits} <= ${originalResults.totalHits}`;
//       return null;
//     }

//     analytics.symspell.outcome = 'accepted';
//     analytics.searchStage = 'symspell';
//     analytics.correctionDepth = 2;
//     analytics.correction = {
//       applied: true,
//       finalQuery: corrected,
//       source: 'symspell',
//       confidence: 0.85,
//       improvement: correctedResults.totalHits - (originalResults?.totalHits || 0)
//     };

//     console.log(`[SymSpell] Accepted: "${query}" → "${corrected}" (${correctedResults.totalHits} results)`);
//     safeSaveCorrection(query, corrected, 'symspell', correctedResults.hits.length);

//     return {
//       originalQuery: query,
//       normalisedQuery: normalised,
//       correctedQuery: corrected,
//       wasCorrected: true,
//       correctionConfidence: 0.85,
//       correctionSource: 'symspell',
//       results: correctedResults.hits,
//       totalHits: correctedResults.totalHits,
//       processingTime: Date.now() - startTime,
//       isFallback: false
//     };

//   } catch (err) {
//     console.error('trySymSpellCorrection error:', err.message);
//     return null;
//   }
// }

// // ─── OLLAMA CORRECTION HELPER ─────────────────────────────

// async function tryOllamaCorrection(query, normalised, options, startTime, originalResults = null, analytics = {}) {
//   try {
//     const ollamaStart = Date.now();
//     const ollamaCorrection = await ollamaCorrectQuery(query);
//     const ollamaTime = Date.now() - ollamaStart;

//     analytics.correctionAttempted = true;
//     analytics.ollama = {
//       called: true,
//       timeTaken: ollamaTime,
//       candidate: ollamaCorrection || null,
//       outcome: 'skipped'
//     };
//     analytics.timing.ollama = ollamaTime;

//     if (!ollamaCorrection) return null;

//     // filter hallucinations
//     if (ollamaCorrection === normalised || ollamaCorrection === query) {
//       analytics.ollama.outcome = 'same_as_original';
//       return null;
//     }
//     if (
//       ollamaCorrection.toLowerCase().includes('input unchanged') ||
//       ollamaCorrection.toLowerCase().includes('no correction')
//     ) {
//       console.log(`[Ollama] Hallucination detected — "${ollamaCorrection}"`);
//       analytics.ollama.outcome = 'hallucination';
//       return null;
//     }

//     console.log(`[Ollama] Candidate: "${query}" → "${ollamaCorrection}"`);

//     const ollamaResults = await searchProducts(ollamaCorrection, options);
//     analytics.ollama.resultsBefore = originalResults?.totalHits || 0;
//     analytics.ollama.resultsAfter = ollamaResults.totalHits;

//     if (ollamaResults.hits.length < OLLAMA_MIN_RESULTS) {
//       analytics.ollama.outcome = 'rejected_no_results';
//       analytics.ollama.rejectionReason = `only ${ollamaResults.hits.length} results`;
//       return null;
//     }

//     // skip improvement check if original was at limit
//     const originalAtLimit = originalResults?.totalHits >= MAX_RESULTS_LIMIT;
//     if (!originalAtLimit && originalResults && ollamaResults.totalHits <= originalResults.totalHits) {
//       analytics.ollama.outcome = 'rejected_not_better';
//       analytics.ollama.rejectionReason = `${ollamaResults.totalHits} <= ${originalResults.totalHits}`;
//       return null;
//     }

//     analytics.ollama.outcome = 'accepted';
//     analytics.searchStage = 'ollama';
//     analytics.correctionDepth = 3;
//     analytics.correction = {
//       applied: true,
//       finalQuery: ollamaCorrection,
//       source: 'ollama',
//       confidence: 0.75,
//       improvement: ollamaResults.totalHits - (originalResults?.totalHits || 0)
//     };

//     console.log(`[Ollama] Accepted: "${query}" → "${ollamaCorrection}" (${ollamaResults.totalHits} results)`);
//     safeSaveCorrection(query, ollamaCorrection, 'ollama', ollamaResults.hits.length);

//     return {
//       originalQuery: query,
//       normalisedQuery: normalised,
//       correctedQuery: ollamaCorrection,
//       wasCorrected: true,
//       correctionConfidence: 0.75,
//       correctionSource: 'ollama',
//       results: ollamaResults.hits,
//       totalHits: ollamaResults.totalHits,
//       processingTime: Date.now() - startTime,
//       isFallback: false
//     };

//   } catch (err) {
//     console.error('tryOllamaCorrection error:', err.message);
//     return null;
//   }
// }

// // ─── SUGGEST ──────────────────────────────────────────────

// async function runSuggest(query, options = {}) {
//   const normalised = normalise(query);
//   if (!normalised) return { products: [], categories: [] };

//   const correction = applyCorrection(query);
//   const searchQuery = correction.corrected ? correction.query : normalised;

//   let finalQuery = searchQuery;
//   let wasCorrected = correction.corrected;
//   let correctionSource = correction.corrected ? correction.source : null;
//   let correctionConfidence = correction.corrected ? (correction.confidence || null) : null;

//   if (!wasCorrected && getSymSpellStatus().ready) {
//     const symspellResult = symspellCorrectQuery(normalised);
//     if (symspellResult) {
//       finalQuery = symspellResult.corrected;
//       wasCorrected = true;
//       correctionSource = 'symspell';
//       correctionConfidence = 0.85;
//     }
//   }

//   const suggestions = await getSuggestions(finalQuery, options);

//   return {
//     query: normalised,
//     originalQuery: query,
//     correctedQuery: wasCorrected ? finalQuery : null,
//     wasCorrected,
//     correctionConfidence,
//     correctionSource,
//     products: suggestions.products,
//     categories: suggestions.categories
//   };
// }

// // ─── NAVIGATE ─────────────────────────────────────────────

// async function runNavigate(category, subcategory, options = {}) {
//   if (!category) return buildEmptyResponse('');

//   const startTime = Date.now();
//   const results = await navigateCategory(category, subcategory, options);

//   if (results.hits.length === 0) {
//     const popular = await getPopularProducts(10);
//     return {
//       category,
//       subcategory,
//       subCategory: options.subCategory || null,
//       results: popular,
//       totalHits: popular.length,
//       processingTime: Date.now() - startTime,
//       isFallback: true,
//       fallbackReason: 'no products in category'
//     };
//   }

//   return {
//     category,
//     subcategory,
//     subCategory: options.subCategory || null,
//     results: results.hits,
//     totalHits: results.totalHits,
//     processingTime: Date.now() - startTime,
//     isFallback: false
//   };
// }

// // ─── EMPTY RESPONSE ───────────────────────────────────────

// function buildEmptyResponse(query) {
//   return {
//     originalQuery: query,
//     normalisedQuery: '',
//     correctedQuery: null,
//     wasCorrected: false,
//     correctionConfidence: null,
//     correctionSource: null,
//     results: [],
//     totalHits: 0,
//     processingTime: 0,
//     isFallback: false,
//     isEmpty: true
//   };
// }

// module.exports = { runSearch, runSuggest, runNavigate };
















































// const { normalise } = require('./normalise');
// const {
//   searchProducts,
//   getSuggestions,
//   navigateCategory,
//   getPopularProducts
// } = require('../meilisearch/searcher');
// const {
//   applyCorrection,
//   saveCorrection,
//   penaliseCorrection
// } = require('../learned/learnedMap');
// const { correctQuery: ollamaCorrectQuery } = require('../ollama/corrector');
// const { correctQuery: symspellCorrectQuery, getStatus: getSymSpellStatus, shouldSkip: symspellShouldSkip } = require('../spellcheck/symspell');
// const { logSearchEvent } = require('../../analytics/logger');

// // ─── CONFIG ───────────────────────────────────────────────
// const MIN_RESULTS_TO_LEARN = 5;
// const MIN_IMPROVEMENT = 5;
// const WEAK_RESULTS_THRESHOLD = 20;  // totalHits threshold
// const OLLAMA_MIN_RESULTS = 15;
// const MAX_RESULTS_LIMIT = 1000;     // Meilisearch cap

// // ─── SAFE SAVE ────────────────────────────────────────────

// function safeSaveCorrection(query, corrected, source, hitCount) {
//   try {
//     const chainCheck = applyCorrection(corrected);
//     if (chainCheck.corrected) {
//       console.log(`[SafeSave] Chain detected — skipped: "${corrected}" → "${chainCheck.query}"`);
//       return;
//     }
//     saveCorrection(query, corrected, source, hitCount);
//   } catch (e) {
//     console.error('saveCorrection error:', e.message);
//   }
// }

// // ─── RESULTS HELPER ───────────────────────────────────────

// function buildResultsAnalytics(totalHits, isFallback = false, fallbackReason = null) {
//   return {
//     count: totalHits,
//     isFallback,
//     fallbackReason,
//     isZeroResult: totalHits === 0,
//     isWeakResult: totalHits > 0 && totalHits <= WEAK_RESULTS_THRESHOLD
//   };
// }

// // ─── SHOULD SKIP OLLAMA ───────────────────────────────────
// // Ollama is expensive — skip it for queries that don't need it

// function shouldSkipOllama(query, totalHits) {
//   // already has good results → no correction needed
//   if (totalHits > WEAK_RESULTS_THRESHOLD) return true;

//   // at max results → correction cannot improve
//   if (totalHits >= MAX_RESULTS_LIMIT) return true;

//   // model numbers / mixed alphanumeric → Ollama can't help
//   // reuse symspell skip logic
//   const words = query.toLowerCase().trim().split(/\s+/);
//   const allSkippable = words.every(w => symspellShouldSkip(w));
//   if (allSkippable && words.length === 1) {
//     console.log(`[Ollama] Skipped — model number or mixed: "${query}"`);
//     return true;
//   }

//   return false;
// }

// // ─── SEARCH ───────────────────────────────────────────────

// async function runSearch(query, options = {}) {
//   const startTime = Date.now();

//   const analytics = {
//     requestId: options.requestId || null,
//     query,
//     normalised: null,
//     searchStage: 'meilisearch',
//     correctionDepth: 0,
//     correctionAttempted: false,
//     learnedMap: { hit: false },
//     symspell: { called: false },
//     ollama: { called: false },
//     correction: { applied: false },
//     results: { count: 0, isFallback: false },
//     timing: { total: 0, symspell: 0, ollama: 0, meilisearch: 0 }
//   };

//   // Step 1 — normalise
//   const normalised = normalise(query);
//   analytics.normalised = normalised;
//   if (!normalised) return buildEmptyResponse(query);

//   // Step 2 — learnedMap check
//   const meilisearchStart = Date.now();
//   const correction = applyCorrection(query);
//   const searchQuery = correction.corrected ? correction.query : normalised;
//   const wasCorrected = correction.corrected;

//   if (wasCorrected) {
//     analytics.correctionAttempted = true;
//     analytics.learnedMap = {
//       hit: true,
//       correction: correction.query,
//       confidence: correction.confidence || null,
//       source: correction.source || null,
//       outcome: 'pending'
//     };
//   }

//   // Step 3 — search Meilisearch
//   const results = await searchProducts(searchQuery, options);
//   analytics.timing.meilisearch = Date.now() - meilisearchStart;

//   // Step 4 — learnedMap correction validation
//   if (wasCorrected) {

//     if (results.hits.length === 0) {
//       analytics.learnedMap.outcome = 'zero_results';
//       analytics.learnedMap.resultsBefore = 0;

//       const symspellResult = await trySymSpellCorrection(
//         query, normalised, options, startTime, null, analytics
//       );
//       if (symspellResult) {
//         analytics.results = buildResultsAnalytics(symspellResult.totalHits);
//         fireAnalytics(analytics, symspellResult, startTime);
//         return symspellResult;
//       }

//       const ollamaResult = await tryOllamaCorrection(
//         query, normalised, options, startTime, null, analytics
//       );
//       if (ollamaResult) {
//         analytics.results = buildResultsAnalytics(ollamaResult.totalHits);
//         fireAnalytics(analytics, ollamaResult, startTime);
//         return ollamaResult;
//       }

//       const popular = await getPopularProducts(10);
//       analytics.searchStage = 'fallback';
//       analytics.results = buildResultsAnalytics(popular.length, true, 'no results found');
//       fireAnalytics(analytics, null, startTime);
//       return {
//         originalQuery: query,
//         normalisedQuery: normalised,
//         correctedQuery: null,
//         wasCorrected: false,
//         correctionConfidence: null,
//         correctionSource: null,
//         results: popular,
//         totalHits: popular.length,
//         processingTime: Date.now() - startTime,
//         isFallback: true,
//         fallbackReason: 'no results found'
//       };
//     }

//     const originalResults = await searchProducts(normalised, options);

//     if (results.totalHits < originalResults.totalHits) {
//       console.log(`[Layer1] "${query}" → "${searchQuery}" blocked`);
//       analytics.learnedMap.outcome = 'penalised';
//       analytics.learnedMap.resultsBefore = originalResults.totalHits;
//       analytics.learnedMap.resultsAfter = results.totalHits;

//       try { penaliseCorrection(query); } catch (e) {}

//       const response = {
//         originalQuery: query,
//         normalisedQuery: normalised,
//         correctedQuery: null,
//         wasCorrected: false,
//         correctionConfidence: null,
//         correctionSource: null,
//         results: originalResults.hits,
//         totalHits: originalResults.totalHits,
//         processingTime: Date.now() - startTime,
//         isFallback: false
//       };
//       analytics.searchStage = 'learnedmap';
//       analytics.results = buildResultsAnalytics(originalResults.totalHits);
//       fireAnalytics(analytics, response, startTime);
//       return response;
//     }

//     if (
//       results.hits.length >= MIN_RESULTS_TO_LEARN &&
//       results.totalHits >= originalResults.totalHits + MIN_IMPROVEMENT
//     ) {
//       console.log(`[Learn] Correction: "${query}" → "${searchQuery}"`);
//       safeSaveCorrection(query, searchQuery, correction.source || 'manual', results.hits.length);
//     }

//     analytics.learnedMap.outcome = 'accepted';
//     analytics.learnedMap.resultsBefore = originalResults.totalHits;
//     analytics.learnedMap.resultsAfter = results.totalHits;
//     analytics.searchStage = 'learnedmap';
//     analytics.correctionDepth = 1;
//     analytics.correction = {
//       applied: true,
//       finalQuery: searchQuery,
//       source: correction.source || 'manual',
//       confidence: correction.confidence || null,
//       improvement: results.totalHits - originalResults.totalHits
//     };

//     const response = {
//       originalQuery: query,
//       normalisedQuery: normalised,
//       correctedQuery: searchQuery,
//       wasCorrected: true,
//       correctionConfidence: correction.confidence || null,
//       correctionSource: correction.source || null,
//       results: results.hits,
//       totalHits: results.totalHits,
//       processingTime: Date.now() - startTime,
//       isFallback: false
//     };
//     analytics.results = buildResultsAnalytics(results.totalHits);
//     fireAnalytics(analytics, response, startTime);
//     return response;
//   }

//   // Step 5 — zero results → try corrections
//   if (results.totalHits === 0) {
//     const symspellResult = await trySymSpellCorrection(
//       query, normalised, options, startTime, null, analytics
//     );
//     if (symspellResult) {
//       analytics.results = buildResultsAnalytics(symspellResult.totalHits);
//       fireAnalytics(analytics, symspellResult, startTime);
//       return symspellResult;
//     }

//     if (!shouldSkipOllama(query, 0)) {
//       const ollamaResult = await tryOllamaCorrection(
//         query, normalised, options, startTime, null, analytics
//       );
//       if (ollamaResult) {
//         analytics.results = buildResultsAnalytics(ollamaResult.totalHits);
//         fireAnalytics(analytics, ollamaResult, startTime);
//         return ollamaResult;
//       }
//     }

//     const popular = await getPopularProducts(10);
//     analytics.searchStage = 'fallback';
//     analytics.results = buildResultsAnalytics(popular.length, true, 'no results found');
//     fireAnalytics(analytics, null, startTime);
//     return {
//       originalQuery: query,
//       normalisedQuery: normalised,
//       correctedQuery: null,
//       wasCorrected: false,
//       correctionConfidence: null,
//       correctionSource: null,
//       results: popular,
//       totalHits: popular.length,
//       processingTime: Date.now() - startTime,
//       isFallback: true,
//       fallbackReason: 'no results found'
//     };
//   }

//   // Step 6 — weak results (use totalHits not hits.length)
//   if (results.totalHits <= WEAK_RESULTS_THRESHOLD) {

//     const abbCorrection = applyCorrection(query, 0);
//     if (abbCorrection.corrected) {
//       const abbResults = await searchProducts(abbCorrection.query, options);

//       if (
//         abbResults.hits.length >= MIN_RESULTS_TO_LEARN &&
//         abbResults.totalHits > results.totalHits
//       ) {
//         console.log(`[Learn] Abbreviation: "${query}" → "${abbCorrection.query}"`);
//         safeSaveCorrection(query, abbCorrection.query, abbCorrection.source || 'manual', abbResults.hits.length);

//         analytics.searchStage = 'learnedmap';
//         analytics.correctionDepth = 1;
//         analytics.learnedMap = {
//           hit: true,
//           correction: abbCorrection.query,
//           outcome: 'accepted',
//           resultsBefore: results.totalHits,
//           resultsAfter: abbResults.totalHits
//         };
//         analytics.correction = {
//           applied: true,
//           finalQuery: abbCorrection.query,
//           source: abbCorrection.source || 'manual',
//           confidence: abbCorrection.confidence || null,
//           improvement: abbResults.totalHits - results.totalHits
//         };

//         const response = {
//           originalQuery: query,
//           normalisedQuery: normalised,
//           correctedQuery: abbCorrection.query,
//           wasCorrected: true,
//           correctionConfidence: abbCorrection.confidence || null,
//           correctionSource: abbCorrection.source || null,
//           results: abbResults.hits,
//           totalHits: abbResults.totalHits,
//           processingTime: Date.now() - startTime,
//           isFallback: false
//         };
//         analytics.results = buildResultsAnalytics(abbResults.totalHits);
//         fireAnalytics(analytics, response, startTime);
//         return response;
//       }
//     }

//     const symspellResult = await trySymSpellCorrection(
//       query, normalised, options, startTime, results, analytics
//     );
//     if (symspellResult) {
//       analytics.results = buildResultsAnalytics(symspellResult.totalHits);
//       fireAnalytics(analytics, symspellResult, startTime);
//       return symspellResult;
//     }

//     // Ollama only if not skippable
//     if (!shouldSkipOllama(query, results.totalHits)) {
//       const ollamaResult = await tryOllamaCorrection(
//         query, normalised, options, startTime, results, analytics
//       );
//       if (ollamaResult) {
//         analytics.results = buildResultsAnalytics(ollamaResult.totalHits);
//         fireAnalytics(analytics, ollamaResult, startTime);
//         return ollamaResult;
//       }
//     }
//   }

//   // Step 7 — good results → return directly
//   analytics.searchStage = 'meilisearch';
//   analytics.correctionDepth = 0;
//   analytics.results = buildResultsAnalytics(results.totalHits);

//   const response = {
//     originalQuery: query,
//     normalisedQuery: normalised,
//     correctedQuery: null,
//     wasCorrected: false,
//     correctionConfidence: null,
//     correctionSource: null,
//     results: results.hits,
//     totalHits: results.totalHits,
//     processingTime: Date.now() - startTime,
//     isFallback: false
//   };
//   fireAnalytics(analytics, response, startTime);
//   return response;
// }

// // ─── FIRE ANALYTICS ───────────────────────────────────────

// function fireAnalytics(analytics, response, startTime) {
//   try {
//     analytics.timing.total = Date.now() - startTime;
//     logSearchEvent(analytics);
//   } catch (e) {
//     // silent — analytics never breaks search
//   }
// }

// // ─── SYMSPELL CORRECTION HELPER ───────────────────────────

// async function trySymSpellCorrection(query, normalised, options, startTime, originalResults = null, analytics = {}) {
//   try {
//     if (!getSymSpellStatus().ready) return null;

//     const symStart = Date.now();
//     const symspellResult = symspellCorrectQuery(query);
//     const symTime = Date.now() - symStart;

//     analytics.correctionAttempted = true;
//     analytics.symspell = {
//       called: true,
//       timeTaken: symTime,
//       candidate: null,
//       outcome: 'skipped'
//     };
//     analytics.timing.symspell = symTime;

//     if (!symspellResult) return null;

//     const corrected = symspellResult.corrected;
//     analytics.symspell.candidate = corrected;
//     analytics.symspell.changedWords = symspellResult.changedWords || [];
//     analytics.symspell.correctionsCount = symspellResult.correctionsApplied || 0;

//     if (corrected === normalised) {
//       analytics.symspell.outcome = 'same_as_original';
//       return null;
//     }

//     console.log(`[SymSpell] Candidate: "${query}" → "${corrected}"`);

//     const correctedResults = await searchProducts(corrected, options);
//     analytics.symspell.resultsBefore = originalResults?.totalHits || 0;
//     analytics.symspell.resultsAfter = correctedResults.totalHits;

//     if (correctedResults.hits.length < MIN_RESULTS_TO_LEARN) {
//       analytics.symspell.outcome = 'rejected_no_results';
//       analytics.symspell.rejectionReason = `only ${correctedResults.hits.length} results`;
//       return null;
//     }

//     // skip improvement check if original was at limit
//     const originalAtLimit = originalResults?.totalHits >= MAX_RESULTS_LIMIT;
//     if (!originalAtLimit && originalResults && correctedResults.totalHits <= originalResults.totalHits) {
//       analytics.symspell.outcome = 'rejected_not_better';
//       analytics.symspell.rejectionReason = `${correctedResults.totalHits} <= ${originalResults.totalHits}`;
//       return null;
//     }

//     analytics.symspell.outcome = 'accepted';
//     analytics.searchStage = 'symspell';
//     analytics.correctionDepth = 2;
//     analytics.correction = {
//       applied: true,
//       finalQuery: corrected,
//       source: 'symspell',
//       confidence: 0.85,
//       improvement: correctedResults.totalHits - (originalResults?.totalHits || 0)
//     };

//     console.log(`[SymSpell] Accepted: "${query}" → "${corrected}" (${correctedResults.totalHits} results)`);
//     safeSaveCorrection(query, corrected, 'symspell', correctedResults.hits.length);

//     return {
//       originalQuery: query,
//       normalisedQuery: normalised,
//       correctedQuery: corrected,
//       wasCorrected: true,
//       correctionConfidence: 0.85,
//       correctionSource: 'symspell',
//       results: correctedResults.hits,
//       totalHits: correctedResults.totalHits,
//       processingTime: Date.now() - startTime,
//       isFallback: false
//     };

//   } catch (err) {
//     console.error('trySymSpellCorrection error:', err.message);
//     return null;
//   }
// }

// // ─── OLLAMA CORRECTION HELPER ─────────────────────────────

// async function tryOllamaCorrection(query, normalised, options, startTime, originalResults = null, analytics = {}) {
//   try {
//     const ollamaStart = Date.now();
//     const ollamaCorrection = await ollamaCorrectQuery(query);
//     const ollamaTime = Date.now() - ollamaStart;

//     analytics.correctionAttempted = true;
//     analytics.ollama = {
//       called: true,
//       timeTaken: ollamaTime,
//       candidate: ollamaCorrection || null,
//       outcome: 'skipped'
//     };
//     analytics.timing.ollama = ollamaTime;

//     if (!ollamaCorrection) return null;

//     // filter hallucinations
//     if (ollamaCorrection === normalised) {
//       analytics.ollama.outcome = 'same_as_original';
//       return null;
//     }
//     if (ollamaCorrection === query) {
//       analytics.ollama.outcome = 'same_as_original';
//       return null;
//     }
//     if (ollamaCorrection.toLowerCase().includes('input unchanged')) {
//       console.log(`[Ollama] Hallucination detected — "${ollamaCorrection}"`);
//       analytics.ollama.outcome = 'hallucination';
//       return null;
//     }
//     if (ollamaCorrection.toLowerCase().includes('no correction')) {
//       console.log(`[Ollama] Hallucination detected — "${ollamaCorrection}"`);
//       analytics.ollama.outcome = 'hallucination';
//       return null;
//     }

//     console.log(`[Ollama] Candidate: "${query}" → "${ollamaCorrection}"`);

//     const ollamaResults = await searchProducts(ollamaCorrection, options);
//     analytics.ollama.resultsBefore = originalResults?.totalHits || 0;
//     analytics.ollama.resultsAfter = ollamaResults.totalHits;

//     if (ollamaResults.hits.length < OLLAMA_MIN_RESULTS) {
//       analytics.ollama.outcome = 'rejected_no_results';
//       analytics.ollama.rejectionReason = `only ${ollamaResults.hits.length} results`;
//       return null;
//     }

//     // skip improvement check if original was at limit
//     const originalAtLimit = originalResults?.totalHits >= MAX_RESULTS_LIMIT;
//     if (!originalAtLimit && originalResults && ollamaResults.totalHits <= originalResults.totalHits) {
//       analytics.ollama.outcome = 'rejected_not_better';
//       analytics.ollama.rejectionReason = `${ollamaResults.totalHits} <= ${originalResults.totalHits}`;
//       return null;
//     }

//     analytics.ollama.outcome = 'accepted';
//     analytics.searchStage = 'ollama';
//     analytics.correctionDepth = 3;
//     analytics.correction = {
//       applied: true,
//       finalQuery: ollamaCorrection,
//       source: 'ollama',
//       confidence: 0.75,
//       improvement: ollamaResults.totalHits - (originalResults?.totalHits || 0)
//     };

//     console.log(`[Ollama] Accepted: "${query}" → "${ollamaCorrection}" (${ollamaResults.totalHits} results)`);
//     safeSaveCorrection(query, ollamaCorrection, 'ollama', ollamaResults.hits.length);

//     return {
//       originalQuery: query,
//       normalisedQuery: normalised,
//       correctedQuery: ollamaCorrection,
//       wasCorrected: true,
//       correctionConfidence: 0.75,
//       correctionSource: 'ollama',
//       results: ollamaResults.hits,
//       totalHits: ollamaResults.totalHits,
//       processingTime: Date.now() - startTime,
//       isFallback: false
//     };

//   } catch (err) {
//     console.error('tryOllamaCorrection error:', err.message);
//     return null;
//   }
// }

// // ─── SUGGEST ──────────────────────────────────────────────

// async function runSuggest(query, options = {}) {
//   const normalised = normalise(query);
//   if (!normalised) return { products: [], categories: [] };

//   const correction = applyCorrection(query);
//   const searchQuery = correction.corrected ? correction.query : normalised;

//   let finalQuery = searchQuery;
//   let wasCorrected = correction.corrected;
//   let correctionSource = correction.corrected ? correction.source : null;
//   let correctionConfidence = correction.corrected ? (correction.confidence || null) : null;

//   if (!wasCorrected && getSymSpellStatus().ready) {
//     const symspellResult = symspellCorrectQuery(normalised);
//     if (symspellResult) {
//       finalQuery = symspellResult.corrected;
//       wasCorrected = true;
//       correctionSource = 'symspell';
//       correctionConfidence = 0.85;
//     }
//   }

//   const suggestions = await getSuggestions(finalQuery, options);

//   return {
//     query: normalised,
//     originalQuery: query,
//     correctedQuery: wasCorrected ? finalQuery : null,
//     wasCorrected,
//     correctionConfidence,
//     correctionSource,
//     products: suggestions.products,
//     categories: suggestions.categories
//   };
// }

// // ─── NAVIGATE ─────────────────────────────────────────────

// async function runNavigate(category, subcategory, options = {}) {
//   if (!category) return buildEmptyResponse('');

//   const startTime = Date.now();
//   const results = await navigateCategory(category, subcategory, options);

//   if (results.hits.length === 0) {
//     const popular = await getPopularProducts(10);
//     return {
//       category,
//       subcategory,
//       subCategory: options.subCategory || null,
//       results: popular,
//       totalHits: popular.length,
//       processingTime: Date.now() - startTime,
//       isFallback: true,
//       fallbackReason: 'no products in category'
//     };
//   }

//   return {
//     category,
//     subcategory,
//     subCategory: options.subCategory || null,
//     results: results.hits,
//     totalHits: results.totalHits,
//     processingTime: Date.now() - startTime,
//     isFallback: false
//   };
// }

// // ─── EMPTY RESPONSE ───────────────────────────────────────

// function buildEmptyResponse(query) {
//   return {
//     originalQuery: query,
//     normalisedQuery: '',
//     correctedQuery: null,
//     wasCorrected: false,
//     correctionConfidence: null,
//     correctionSource: null,
//     results: [],
//     totalHits: 0,
//     processingTime: 0,
//     isFallback: false,
//     isEmpty: true
//   };
// }

// module.exports = { runSearch, runSuggest, runNavigate };













































// const { normalise } = require('./normalise');
// const {
//   searchProducts,
//   getSuggestions,
//   navigateCategory,
//   getPopularProducts
// } = require('../meilisearch/searcher');
// const {
//   applyCorrection,
//   saveCorrection,
//   penaliseCorrection
// } = require('../learned/learnedMap');
// const { correctQuery: ollamaCorrectQuery } = require('../ollama/corrector');
// const { correctQuery: symspellCorrectQuery, getStatus: getSymSpellStatus } = require('../spellcheck/symspell');
// const { logSearchEvent } = require('../../analytics/logger');

// // ─── CONFIG ───────────────────────────────────────────────
// const MIN_RESULTS_TO_LEARN = 5;
// const MIN_IMPROVEMENT = 5;
// const WEAK_RESULTS_THRESHOLD = 20;
// const OLLAMA_MIN_RESULTS = 15;

// // ─── SAFE SAVE ────────────────────────────────────────────

// function safeSaveCorrection(query, corrected, source, hitCount) {
//   try {
//     const chainCheck = applyCorrection(corrected);
//     if (chainCheck.corrected) {
//       console.log(`[SafeSave] Chain detected — skipped: "${corrected}" → "${chainCheck.query}"`);
//       return;
//     }
//     saveCorrection(query, corrected, source, hitCount);
//   } catch (e) {
//     console.error('saveCorrection error:', e.message);
//   }
// }

// // ─── RESULTS HELPER ───────────────────────────────────────

// function buildResultsAnalytics(totalHits, isFallback = false, fallbackReason = null) {
//   return {
//     count: totalHits,
//     isFallback,
//     fallbackReason,
//     isZeroResult: totalHits === 0,
//     isWeakResult: totalHits > 0 && totalHits <= 20
//   };
// }

// // ─── SEARCH ───────────────────────────────────────────────

// async function runSearch(query, options = {}) {
//   const startTime = Date.now();

//   const analytics = {
//     requestId: options.requestId || null,
//     query,
//     normalised: null,
//     searchStage: 'meilisearch',
//     correctionDepth: 0,
//     correctionAttempted: false,  // true when any layer tries correction
//     learnedMap: { hit: false },
//     symspell: { called: false },
//     ollama: { called: false },
//     correction: { applied: false },
//     results: { count: 0, isFallback: false },
//     timing: { total: 0, symspell: 0, ollama: 0, meilisearch: 0 }
//   };

//   // Step 1 — normalise
//   const normalised = normalise(query);
//   analytics.normalised = normalised;
//   if (!normalised) return buildEmptyResponse(query);

//   // Step 2 — learnedMap check
//   const meilisearchStart = Date.now();
//   const correction = applyCorrection(query);
//   const searchQuery = correction.corrected ? correction.query : normalised;
//   const wasCorrected = correction.corrected;

//   if (wasCorrected) {
//     analytics.correctionAttempted = true;
//     analytics.learnedMap = {
//       hit: true,
//       correction: correction.query,
//       confidence: correction.confidence || null,
//       source: correction.source || null,
//       outcome: 'pending'
//     };
//   }

//   // Step 3 — search Meilisearch
//   const results = await searchProducts(searchQuery, options);
//   analytics.timing.meilisearch = Date.now() - meilisearchStart;

//   // Step 4 — learnedMap correction validation
//   if (wasCorrected) {

//     if (results.hits.length === 0) {
//       analytics.learnedMap.outcome = 'zero_results';
//       analytics.learnedMap.resultsBefore = 0;

//       const symspellResult = await trySymSpellCorrection(
//         query, normalised, options, startTime, null, analytics
//       );
//       if (symspellResult) {
//         analytics.results = buildResultsAnalytics(symspellResult.totalHits);
//         fireAnalytics(analytics, symspellResult, startTime);
//         return symspellResult;
//       }

//       const ollamaResult = await tryOllamaCorrection(
//         query, normalised, options, startTime, null, analytics
//       );
//       if (ollamaResult) {
//         analytics.results = buildResultsAnalytics(ollamaResult.totalHits);
//         fireAnalytics(analytics, ollamaResult, startTime);
//         return ollamaResult;
//       }

//       const popular = await getPopularProducts(10);
//       analytics.searchStage = 'fallback';
//       analytics.results = buildResultsAnalytics(popular.length, true, 'no results found');
//       fireAnalytics(analytics, null, startTime);
//       return {
//         originalQuery: query,
//         normalisedQuery: normalised,
//         correctedQuery: null,
//         wasCorrected: false,
//         correctionConfidence: null,
//         correctionSource: null,
//         results: popular,
//         totalHits: popular.length,
//         processingTime: Date.now() - startTime,
//         isFallback: true,
//         fallbackReason: 'no results found'
//       };
//     }

//     const originalResults = await searchProducts(normalised, options);

//     if (results.totalHits < originalResults.totalHits) {
//       console.log(`[Layer1] "${query}" → "${searchQuery}" blocked`);
//       analytics.learnedMap.outcome = 'penalised';
//       analytics.learnedMap.resultsBefore = originalResults.totalHits;
//       analytics.learnedMap.resultsAfter = results.totalHits;

//       try { penaliseCorrection(query); } catch (e) {}

//       const response = {
//         originalQuery: query,
//         normalisedQuery: normalised,
//         correctedQuery: null,
//         wasCorrected: false,
//         correctionConfidence: null,
//         correctionSource: null,
//         results: originalResults.hits,
//         totalHits: originalResults.totalHits,
//         processingTime: Date.now() - startTime,
//         isFallback: false
//       };
//       analytics.searchStage = 'learnedmap';
//       analytics.results = buildResultsAnalytics(originalResults.totalHits);
//       fireAnalytics(analytics, response, startTime);
//       return response;
//     }

//     if (
//       results.hits.length >= MIN_RESULTS_TO_LEARN &&
//       results.totalHits >= originalResults.totalHits + MIN_IMPROVEMENT
//     ) {
//       console.log(`[Learn] Correction: "${query}" → "${searchQuery}"`);
//       safeSaveCorrection(query, searchQuery, correction.source || 'manual', results.hits.length);
//     }

//     analytics.learnedMap.outcome = 'accepted';
//     analytics.learnedMap.resultsBefore = originalResults.totalHits;
//     analytics.learnedMap.resultsAfter = results.totalHits;
//     analytics.searchStage = 'learnedmap';
//     analytics.correctionDepth = 1;
//     analytics.correction = {
//       applied: true,
//       finalQuery: searchQuery,
//       source: correction.source || 'manual',
//       confidence: correction.confidence || null,
//       improvement: results.totalHits - originalResults.totalHits
//     };

//     const response = {
//       originalQuery: query,
//       normalisedQuery: normalised,
//       correctedQuery: searchQuery,
//       wasCorrected: true,
//       correctionConfidence: correction.confidence || null,
//       correctionSource: correction.source || null,
//       results: results.hits,
//       totalHits: results.totalHits,
//       processingTime: Date.now() - startTime,
//       isFallback: false
//     };
//     analytics.results = buildResultsAnalytics(results.totalHits);
//     fireAnalytics(analytics, response, startTime);
//     return response;
//   }

//   // Step 5 — zero results
//   if (results.hits.length === 0) {
//     const symspellResult = await trySymSpellCorrection(
//       query, normalised, options, startTime, null, analytics
//     );
//     if (symspellResult) {
//       analytics.results = buildResultsAnalytics(symspellResult.totalHits);
//       fireAnalytics(analytics, symspellResult, startTime);
//       return symspellResult;
//     }

//     const ollamaResult = await tryOllamaCorrection(
//       query, normalised, options, startTime, null, analytics
//     );
//     if (ollamaResult) {
//       analytics.results = buildResultsAnalytics(ollamaResult.totalHits);
//       fireAnalytics(analytics, ollamaResult, startTime);
//       return ollamaResult;
//     }

//     const popular = await getPopularProducts(10);
//     analytics.searchStage = 'fallback';
//     analytics.results = buildResultsAnalytics(popular.length, true, 'no results found');
//     fireAnalytics(analytics, null, startTime);
//     return {
//       originalQuery: query,
//       normalisedQuery: normalised,
//       correctedQuery: null,
//       wasCorrected: false,
//       correctionConfidence: null,
//       correctionSource: null,
//       results: popular,
//       totalHits: popular.length,
//       processingTime: Date.now() - startTime,
//       isFallback: true,
//       fallbackReason: 'no results found'
//     };
//   }

//   // Step 6 — weak results
//   if (results.hits.length <= WEAK_RESULTS_THRESHOLD) {

//     const abbCorrection = applyCorrection(query, 0);
//     if (abbCorrection.corrected) {
//       const abbResults = await searchProducts(abbCorrection.query, options);

//       if (
//         abbResults.hits.length >= MIN_RESULTS_TO_LEARN &&
//         abbResults.hits.length > results.hits.length
//       ) {
//         console.log(`[Learn] Abbreviation: "${query}" → "${abbCorrection.query}"`);
//         safeSaveCorrection(query, abbCorrection.query, abbCorrection.source || 'manual', abbResults.hits.length);

//         analytics.searchStage = 'learnedmap';
//         analytics.correctionDepth = 1;
//         analytics.learnedMap = {
//           hit: true,
//           correction: abbCorrection.query,
//           outcome: 'accepted',
//           resultsBefore: results.hits.length,
//           resultsAfter: abbResults.hits.length
//         };
//         analytics.correction = {
//           applied: true,
//           finalQuery: abbCorrection.query,
//           source: abbCorrection.source || 'manual',
//           confidence: abbCorrection.confidence || null,
//           improvement: abbResults.hits.length - results.hits.length
//         };

//         const response = {
//           originalQuery: query,
//           normalisedQuery: normalised,
//           correctedQuery: abbCorrection.query,
//           wasCorrected: true,
//           correctionConfidence: abbCorrection.confidence || null,
//           correctionSource: abbCorrection.source || null,
//           results: abbResults.hits,
//           totalHits: abbResults.totalHits,
//           processingTime: Date.now() - startTime,
//           isFallback: false
//         };
//         analytics.results = buildResultsAnalytics(abbResults.totalHits);
//         fireAnalytics(analytics, response, startTime);
//         return response;
//       }
//     }

//     const symspellResult = await trySymSpellCorrection(
//       query, normalised, options, startTime, results, analytics
//     );
//     if (symspellResult) {
//       analytics.results = buildResultsAnalytics(symspellResult.totalHits);
//       fireAnalytics(analytics, symspellResult, startTime);
//       return symspellResult;
//     }

//     const ollamaResult = await tryOllamaCorrection(
//       query, normalised, options, startTime, results, analytics
//     );
//     if (ollamaResult) {
//       analytics.results = buildResultsAnalytics(ollamaResult.totalHits);
//       fireAnalytics(analytics, ollamaResult, startTime);
//       return ollamaResult;
//     }
//   }

//   // Step 7 — normal results
//   analytics.searchStage = 'meilisearch';
//   analytics.correctionDepth = 0;
//   analytics.results = buildResultsAnalytics(results.totalHits);

//   const response = {
//     originalQuery: query,
//     normalisedQuery: normalised,
//     correctedQuery: null,
//     wasCorrected: false,
//     correctionConfidence: null,
//     correctionSource: null,
//     results: results.hits,
//     totalHits: results.totalHits,
//     processingTime: Date.now() - startTime,
//     isFallback: false
//   };
//   fireAnalytics(analytics, response, startTime);
//   return response;
// }

// // ─── FIRE ANALYTICS ───────────────────────────────────────

// function fireAnalytics(analytics, response, startTime) {
//   try {
//     analytics.timing.total = Date.now() - startTime;
//     logSearchEvent(analytics);
//   } catch (e) {
//     // silent — analytics never breaks search
//   }
// }

// // ─── SYMSPELL CORRECTION HELPER ───────────────────────────

// async function trySymSpellCorrection(query, normalised, options, startTime, originalResults = null, analytics = {}) {
//   try {
//     if (!getSymSpellStatus().ready) return null;

//     const symStart = Date.now();
//     const symspellResult = symspellCorrectQuery(query);
//     const symTime = Date.now() - symStart;

//     analytics.correctionAttempted = true;
//     analytics.symspell = {
//       called: true,
//       timeTaken: symTime,
//       candidate: null,
//       outcome: 'skipped'
//     };
//     analytics.timing.symspell = symTime;

//     if (!symspellResult) return null;

//     const corrected = symspellResult.corrected;
//     analytics.symspell.candidate = corrected;
//     analytics.symspell.changedWords = symspellResult.changedWords || [];
//     analytics.symspell.correctionsCount = symspellResult.correctionsApplied || 0;

//     if (corrected === normalised) {
//       analytics.symspell.outcome = 'same_as_original';
//       return null;
//     }

//     console.log(`[SymSpell] Candidate: "${query}" → "${corrected}"`);

//     const correctedResults = await searchProducts(corrected, options);
//     analytics.symspell.resultsBefore = originalResults?.hits?.length || 0;
//     analytics.symspell.resultsAfter = correctedResults.hits.length;

//     if (correctedResults.hits.length < MIN_RESULTS_TO_LEARN) {
//       analytics.symspell.outcome = 'rejected_no_results';
//       analytics.symspell.rejectionReason = `only ${correctedResults.hits.length} results`;
//       return null;
//     }

//     if (originalResults && correctedResults.totalHits <= originalResults.totalHits) {
//       analytics.symspell.outcome = 'rejected_not_better';
//       analytics.symspell.rejectionReason = `${correctedResults.totalHits} <= ${originalResults.totalHits}`;
//       return null;
//     }

//     analytics.symspell.outcome = 'accepted';
//     analytics.searchStage = 'symspell';
//     analytics.correctionDepth = 2;
//     analytics.correction = {
//       applied: true,
//       finalQuery: corrected,
//       source: 'symspell',
//       confidence: 0.85,
//       improvement: correctedResults.totalHits - (originalResults?.totalHits || 0)
//     };

//     console.log(`[SymSpell] Accepted: "${query}" → "${corrected}" (${correctedResults.totalHits} results)`);
//     safeSaveCorrection(query, corrected, 'symspell', correctedResults.hits.length);

//     return {
//       originalQuery: query,
//       normalisedQuery: normalised,
//       correctedQuery: corrected,
//       wasCorrected: true,
//       correctionConfidence: 0.85,
//       correctionSource: 'symspell',
//       results: correctedResults.hits,
//       totalHits: correctedResults.totalHits,
//       processingTime: Date.now() - startTime,
//       isFallback: false
//     };

//   } catch (err) {
//     console.error('trySymSpellCorrection error:', err.message);
//     return null;
//   }
// }

// // ─── OLLAMA CORRECTION HELPER ─────────────────────────────

// async function tryOllamaCorrection(query, normalised, options, startTime, originalResults = null, analytics = {}) {
//   try {
//     const ollamaStart = Date.now();
//     const ollamaCorrection = await ollamaCorrectQuery(query);
//     const ollamaTime = Date.now() - ollamaStart;

//     analytics.correctionAttempted = true;
//     analytics.ollama = {
//       called: true,
//       timeTaken: ollamaTime,
//       candidate: ollamaCorrection || null,
//       outcome: 'skipped'
//     };
//     analytics.timing.ollama = ollamaTime;

//     if (!ollamaCorrection) return null;
//     if (ollamaCorrection === normalised) {
//       analytics.ollama.outcome = 'same_as_original';
//       return null;
//     }

//     console.log(`[Ollama] Candidate: "${query}" → "${ollamaCorrection}"`);

//     const ollamaResults = await searchProducts(ollamaCorrection, options);
//     analytics.ollama.resultsBefore = originalResults?.hits?.length || 0;
//     analytics.ollama.resultsAfter = ollamaResults.hits.length;

//     if (ollamaResults.hits.length < OLLAMA_MIN_RESULTS) {
//       analytics.ollama.outcome = 'rejected_no_results';
//       analytics.ollama.rejectionReason = `only ${ollamaResults.hits.length} results`;
//       return null;
//     }

//     if (originalResults && ollamaResults.totalHits <= originalResults.totalHits) {
//       analytics.ollama.outcome = 'rejected_not_better';
//       analytics.ollama.rejectionReason = `${ollamaResults.totalHits} <= ${originalResults.totalHits}`;
//       return null;
//     }

//     analytics.ollama.outcome = 'accepted';
//     analytics.searchStage = 'ollama';
//     analytics.correctionDepth = 3;
//     analytics.correction = {
//       applied: true,
//       finalQuery: ollamaCorrection,
//       source: 'ollama',
//       confidence: 0.75,
//       improvement: ollamaResults.totalHits - (originalResults?.totalHits || 0)
//     };

//     console.log(`[Ollama] Accepted: "${query}" → "${ollamaCorrection}" (${ollamaResults.totalHits} results)`);
//     safeSaveCorrection(query, ollamaCorrection, 'ollama', ollamaResults.hits.length);

//     return {
//       originalQuery: query,
//       normalisedQuery: normalised,
//       correctedQuery: ollamaCorrection,
//       wasCorrected: true,
//       correctionConfidence: 0.75,
//       correctionSource: 'ollama',
//       results: ollamaResults.hits,
//       totalHits: ollamaResults.totalHits,
//       processingTime: Date.now() - startTime,
//       isFallback: false
//     };

//   } catch (err) {
//     console.error('tryOllamaCorrection error:', err.message);
//     return null;
//   }
// }

// // ─── SUGGEST ──────────────────────────────────────────────

// async function runSuggest(query, options = {}) {
//   const normalised = normalise(query);
//   if (!normalised) return { products: [], categories: [] };

//   const correction = applyCorrection(query);
//   const searchQuery = correction.corrected ? correction.query : normalised;

//   let finalQuery = searchQuery;
//   let wasCorrected = correction.corrected;
//   let correctionSource = correction.corrected ? correction.source : null;
//   let correctionConfidence = correction.corrected ? (correction.confidence || null) : null;

//   if (!wasCorrected && getSymSpellStatus().ready) {
//     const symspellResult = symspellCorrectQuery(normalised);
//     if (symspellResult) {
//       finalQuery = symspellResult.corrected;
//       wasCorrected = true;
//       correctionSource = 'symspell';
//       correctionConfidence = 0.85;
//     }
//   }

//   const suggestions = await getSuggestions(finalQuery, options);

//   return {
//     query: normalised,
//     originalQuery: query,
//     correctedQuery: wasCorrected ? finalQuery : null,
//     wasCorrected,
//     correctionConfidence,
//     correctionSource,
//     products: suggestions.products,
//     categories: suggestions.categories
//   };
// }

// // ─── NAVIGATE ─────────────────────────────────────────────

// async function runNavigate(category, subcategory, options = {}) {
//   if (!category) return buildEmptyResponse('');

//   const startTime = Date.now();
//   const results = await navigateCategory(category, subcategory, options);

//   if (results.hits.length === 0) {
//     const popular = await getPopularProducts(10);
//     return {
//       category,
//       subcategory,
//       subCategory: options.subCategory || null,
//       results: popular,
//       totalHits: popular.length,
//       processingTime: Date.now() - startTime,
//       isFallback: true,
//       fallbackReason: 'no products in category'
//     };
//   }

//   return {
//     category,
//     subcategory,
//     subCategory: options.subCategory || null,
//     results: results.hits,
//     totalHits: results.totalHits,
//     processingTime: Date.now() - startTime,
//     isFallback: false
//   };
// }

// // ─── EMPTY RESPONSE ───────────────────────────────────────

// function buildEmptyResponse(query) {
//   return {
//     originalQuery: query,
//     normalisedQuery: '',
//     correctedQuery: null,
//     wasCorrected: false,
//     correctionConfidence: null,
//     correctionSource: null,
//     results: [],
//     totalHits: 0,
//     processingTime: 0,
//     isFallback: false,
//     isEmpty: true
//   };
// }

// module.exports = { runSearch, runSuggest, runNavigate };




















































// const { normalise } = require('./normalise');
// const {
//   searchProducts,
//   getSuggestions,
//   navigateCategory,
//   getPopularProducts
// } = require('../meilisearch/searcher');
// const {
//   applyCorrection,
//   saveCorrection,
//   penaliseCorrection
// } = require('../learned/learnedMap');
// const { correctQuery: ollamaCorrectQuery } = require('../ollama/corrector');
// const { correctQuery: symspellCorrectQuery, getStatus: getSymSpellStatus } = require('../spellcheck/symspell');
// const { logSearchEvent } = require('../../analytics/logger');

// // ─── CONFIG ───────────────────────────────────────────────
// const MIN_RESULTS_TO_LEARN = 5;
// const MIN_IMPROVEMENT = 5;
// const WEAK_RESULTS_THRESHOLD = 20;
// const OLLAMA_MIN_RESULTS = 15;

// // ─── SAFE SAVE ────────────────────────────────────────────

// function safeSaveCorrection(query, corrected, source, hitCount) {
//   try {
//     const chainCheck = applyCorrection(corrected);
//     if (chainCheck.corrected) {
//       console.log(`[SafeSave] Chain detected — skipped: "${corrected}" → "${chainCheck.query}"`);
//       return;
//     }
//     saveCorrection(query, corrected, source, hitCount);
//   } catch (e) {
//     console.error('saveCorrection error:', e.message);
//   }
// }

// // ─── SEARCH ───────────────────────────────────────────────

// async function runSearch(query, options = {}) {
//   const startTime = Date.now();

//   // analytics context — built up as pipeline runs
//   const analytics = {
//     requestId: options.requestId || null,
//     query,
//     normalised: null,
//     searchStage: 'meilisearch',  // default
//     correctionDepth: 0,
//     learnedMap: { hit: false },
//     symspell: { called: false },
//     ollama: { called: false },
//     correction: { applied: false },
//     results: { count: 0, isFallback: false },
//     timing: { total: 0, symspell: 0, ollama: 0, meilisearch: 0 }
//   };

//   // Step 1 — normalise
//   const normalised = normalise(query);
//   analytics.normalised = normalised;
//   if (!normalised) return buildEmptyResponse(query);

//   // Step 2 — Layer 1: check learned map
//   const meilisearchStart = Date.now();
//   const correction = applyCorrection(query);
//   const searchQuery = correction.corrected ? correction.query : normalised;
//   const wasCorrected = correction.corrected;

//   // track learnedMap hit
//   if (wasCorrected) {
//     analytics.learnedMap = {
//       hit: true,
//       correction: correction.query,
//       confidence: correction.confidence || null,
//       source: correction.source || null,
//       outcome: 'pending'
//     };
//   }

//   // Step 3 — search Meilisearch
//   const results = await searchProducts(searchQuery, options);
//   analytics.timing.meilisearch = Date.now() - meilisearchStart;

//   // Step 4 — learnedMap correction validation
//   if (wasCorrected) {

//     // zero results → try SymSpell then Ollama
//     if (results.hits.length === 0) {
//       analytics.learnedMap.outcome = 'zero_results';
//       analytics.learnedMap.resultsBefore = 0;

//       const symspellResult = await trySymSpellCorrection(
//         query, normalised, options, startTime, null, analytics
//       );
//       if (symspellResult) {
//         analytics.results = {
//           count: symspellResult.totalHits,
//           isFallback: false,
//           fallbackReason: null,
//           isZeroResult: symspellResult.totalHits === 0,
//           isWeakResult: symspellResult.totalHits > 0 && symspellResult.totalHits <= 20
//         };
//         fireAnalytics(analytics, symspellResult, startTime);
//         return symspellResult;
//       }

//       const ollamaResult = await tryOllamaCorrection(
//         query, normalised, options, startTime, null, analytics
//       );
//       if (ollamaResult) {
//         analytics.results = {
//           count: ollamaResult.totalHits,
//           isFallback: false,
//           fallbackReason: null,
//           isZeroResult: ollamaResult.totalHits === 0,
//           isWeakResult: ollamaResult.totalHits > 0 && ollamaResult.totalHits <= 20
//         };
//         fireAnalytics(analytics, ollamaResult, startTime);
//         return ollamaResult;
//       }

//       const popular = await getPopularProducts(10);
//       analytics.searchStage = 'fallback';
//       analytics.results = { count: popular.length, isFallback: true, fallbackReason: 'no results found' };
//       fireAnalytics(analytics, null, startTime);
//       return {
//         originalQuery: query,
//         normalisedQuery: normalised,
//         correctedQuery: null,
//         wasCorrected: false,
//         correctionConfidence: null,
//         correctionSource: null,
//         results: popular,
//         totalHits: popular.length,
//         processingTime: Date.now() - startTime,
//         isFallback: true,
//         fallbackReason: 'no results found'
//       };
//     }

//     // compare corrected vs original
//     const originalResults = await searchProducts(normalised, options);

//     // corrected is worse → penalise
//     if (results.totalHits < originalResults.totalHits) {
//       console.log(`[Layer1] "${query}" → "${searchQuery}" blocked`);
//       analytics.learnedMap.outcome = 'penalised';
//       analytics.learnedMap.resultsBefore = originalResults.totalHits;
//       analytics.learnedMap.resultsAfter = results.totalHits;

//       try { penaliseCorrection(query); } catch (e) {}

//       const response = {
//         originalQuery: query,
//         normalisedQuery: normalised,
//         correctedQuery: null,
//         wasCorrected: false,
//         correctionConfidence: null,
//         correctionSource: null,
//         results: originalResults.hits,
//         totalHits: originalResults.totalHits,
//         processingTime: Date.now() - startTime,
//         isFallback: false
//       };
//       analytics.searchStage = 'learnedmap';
//       analytics.results = { count: originalResults.totalHits, isFallback: false };
//       fireAnalytics(analytics, response, startTime);
//       return response;
//     }

//     // corrected is better → strengthen
//     if (
//       results.hits.length >= MIN_RESULTS_TO_LEARN &&
//       results.totalHits >= originalResults.totalHits + MIN_IMPROVEMENT
//     ) {
//       console.log(`[Learn] Correction: "${query}" → "${searchQuery}"`);
//       safeSaveCorrection(query, searchQuery, correction.source || 'manual', results.hits.length);
//     }

//     analytics.learnedMap.outcome = 'accepted';
//     analytics.learnedMap.resultsBefore = originalResults.totalHits;
//     analytics.learnedMap.resultsAfter = results.totalHits;
//     analytics.searchStage = 'learnedmap';
//     analytics.correctionDepth = 1;
//     analytics.correction = {
//       applied: true,
//       finalQuery: searchQuery,
//       source: correction.source || 'manual',
//       confidence: correction.confidence || null,
//       improvement: results.totalHits - originalResults.totalHits
//     };

//     const response = {
//       originalQuery: query,
//       normalisedQuery: normalised,
//       correctedQuery: searchQuery,
//       wasCorrected: true,
//       correctionConfidence: correction.confidence || null,
//       correctionSource: correction.source || null,
//       results: results.hits,
//       totalHits: results.totalHits,
//       processingTime: Date.now() - startTime,
//       isFallback: false
//     };
//     analytics.results = { count: results.totalHits, isFallback: false };
//     fireAnalytics(analytics, response, startTime);
//     return response;
//   }

//   // Step 5 — no learnedMap correction
//   // zero results → try SymSpell then Ollama
//   if (results.hits.length === 0) {
//     const symspellResult = await trySymSpellCorrection(
//       query, normalised, options, startTime, null, analytics
//     );
//     if (symspellResult) {
//       fireAnalytics(analytics, symspellResult, startTime);
//       return symspellResult;
//     }

//     const ollamaResult = await tryOllamaCorrection(
//       query, normalised, options, startTime, null, analytics
//     );
//     if (ollamaResult) {
//       fireAnalytics(analytics, ollamaResult, startTime);
//       return ollamaResult;
//     }

//     const popular = await getPopularProducts(10);
//     analytics.searchStage = 'fallback';
//     analytics.results = { count: popular.length, isFallback: true, fallbackReason: 'no results found' };
//     fireAnalytics(analytics, null, startTime);
//     return {
//       originalQuery: query,
//       normalisedQuery: normalised,
//       correctedQuery: null,
//       wasCorrected: false,
//       correctionConfidence: null,
//       correctionSource: null,
//       results: popular,
//       totalHits: popular.length,
//       processingTime: Date.now() - startTime,
//       isFallback: true,
//       fallbackReason: 'no results found'
//     };
//   }

//   // Step 6 — weak results
//   if (results.hits.length <= WEAK_RESULTS_THRESHOLD) {

//     // try learnedMap abbreviation first
//     const abbCorrection = applyCorrection(query, 0);
//     if (abbCorrection.corrected) {
//       const abbResults = await searchProducts(abbCorrection.query, options);

//       if (
//         abbResults.hits.length >= MIN_RESULTS_TO_LEARN &&
//         abbResults.hits.length > results.hits.length
//       ) {
//         console.log(`[Learn] Abbreviation: "${query}" → "${abbCorrection.query}"`);
//         safeSaveCorrection(query, abbCorrection.query, abbCorrection.source || 'manual', abbResults.hits.length);

//         analytics.searchStage = 'learnedmap';
//         analytics.correctionDepth = 1;
//         analytics.learnedMap = {
//           hit: true,
//           correction: abbCorrection.query,
//           outcome: 'accepted',
//           resultsBefore: results.hits.length,
//           resultsAfter: abbResults.hits.length
//         };
//         analytics.correction = {
//           applied: true,
//           finalQuery: abbCorrection.query,
//           source: abbCorrection.source || 'manual',
//           confidence: abbCorrection.confidence || null,
//           improvement: abbResults.hits.length - results.hits.length
//         };

//         const response = {
//           originalQuery: query,
//           normalisedQuery: normalised,
//           correctedQuery: abbCorrection.query,
//           wasCorrected: true,
//           correctionConfidence: abbCorrection.confidence || null,
//           correctionSource: abbCorrection.source || null,
//           results: abbResults.hits,
//           totalHits: abbResults.totalHits,
//           processingTime: Date.now() - startTime,
//           isFallback: false
//         };
//         analytics.results = { count: abbResults.totalHits, isFallback: false };
//         fireAnalytics(analytics, response, startTime);
//         return response;
//       }
//     }

//     // try SymSpell
//     const symspellResult = await trySymSpellCorrection(
//       query, normalised, options, startTime, results, analytics
//     );
//     if (symspellResult) {
//       fireAnalytics(analytics, symspellResult, startTime);
//       return symspellResult;
//     }

//     // Ollama last resort
//     const ollamaResult = await tryOllamaCorrection(
//       query, normalised, options, startTime, results, analytics
//     );
//     if (ollamaResult) {
//       fireAnalytics(analytics, ollamaResult, startTime);
//       return ollamaResult;
//     }
//   }

//   // Step 7 — return normal results
//   analytics.searchStage = 'meilisearch';
//   analytics.correctionDepth = 0;
//   analytics.results = { count: results.totalHits, isFallback: false };

//   const response = {
//     originalQuery: query,
//     normalisedQuery: normalised,
//     correctedQuery: null,
//     wasCorrected: false,
//     correctionConfidence: null,
//     correctionSource: null,
//     results: results.hits,
//     totalHits: results.totalHits,
//     processingTime: Date.now() - startTime,
//     isFallback: false
//   };
//   fireAnalytics(analytics, response, startTime);
//   return response;
// }

// // ─── FIRE ANALYTICS ───────────────────────────────────────
// // non-blocking — never breaks search

// function fireAnalytics(analytics, response, startTime) {
//   try {
//     analytics.timing.total = Date.now() - startTime;
//     logSearchEvent(analytics);
//   } catch (e) {
//     // silent — analytics never breaks search
//   }
// }

// // ─── SYMSPELL CORRECTION HELPER ───────────────────────────

// async function trySymSpellCorrection(query, normalised, options, startTime, originalResults = null, analytics = {}) {
//   try {
//     if (!getSymSpellStatus().ready) return null;

//     const symStart = Date.now();
//     const symspellResult = symspellCorrectQuery(query);
//     const symTime = Date.now() - symStart;

//     // track symspell call
//     analytics.symspell = {
//       called: true,
//       timeTaken: symTime,
//       candidate: null,
//       outcome: 'skipped'
//     };
//     analytics.timing.symspell = symTime;

//     if (!symspellResult) return null;

//     const corrected = symspellResult.corrected;
//     analytics.symspell.candidate = corrected;
//     analytics.symspell.changedWords = symspellResult.changedWords || [];
//     analytics.symspell.correctionsCount = symspellResult.correctionsApplied || 0;

//     if (corrected === normalised) {
//       analytics.symspell.outcome = 'same_as_original';
//       return null;
//     }

//     console.log(`[SymSpell] Candidate: "${query}" → "${corrected}"`);

//     const correctedResults = await searchProducts(corrected, options);
//     analytics.symspell.resultsBefore = originalResults?.hits?.length || 0;
//     analytics.symspell.resultsAfter = correctedResults.hits.length;

//     if (correctedResults.hits.length < MIN_RESULTS_TO_LEARN) {
//       analytics.symspell.outcome = 'rejected_no_results';
//       analytics.symspell.rejectionReason = `only ${correctedResults.hits.length} results`;
//       console.log(`[SymSpell] Rejected — only ${correctedResults.hits.length} results`);
//       return null;
//     }

//     if (originalResults && correctedResults.totalHits <= originalResults.totalHits) {
//       analytics.symspell.outcome = 'rejected_not_better';
//       analytics.symspell.rejectionReason = `${correctedResults.totalHits} <= ${originalResults.totalHits}`;
//       console.log(`[SymSpell] Rejected — not better`);
//       return null;
//     }

//     analytics.symspell.outcome = 'accepted';
//     analytics.searchStage = 'symspell';
//     analytics.correctionDepth = 2;
//     analytics.correction = {
//       applied: true,
//       finalQuery: corrected,
//       source: 'symspell',
//       confidence: 0.85,
//       improvement: correctedResults.totalHits - (originalResults?.totalHits || 0)
//     };

//     console.log(`[SymSpell] Accepted: "${query}" → "${corrected}" (${correctedResults.totalHits} results)`);
//     safeSaveCorrection(query, corrected, 'symspell', correctedResults.hits.length);

//     return {
//       originalQuery: query,
//       normalisedQuery: normalised,
//       correctedQuery: corrected,
//       wasCorrected: true,
//       correctionConfidence: 0.85,
//       correctionSource: 'symspell',
//       results: correctedResults.hits,
//       totalHits: correctedResults.totalHits,
//       processingTime: Date.now() - startTime,
//       isFallback: false
//     };

//   } catch (err) {
//     console.error('trySymSpellCorrection error:', err.message);
//     return null;
//   }
// }

// // ─── OLLAMA CORRECTION HELPER ─────────────────────────────

// async function tryOllamaCorrection(query, normalised, options, startTime, originalResults = null, analytics = {}) {
//   try {
//     const ollamaStart = Date.now();
//     const ollamaCorrection = await ollamaCorrectQuery(query);
//     const ollamaTime = Date.now() - ollamaStart;

//     // track ollama call
//     analytics.ollama = {
//       called: true,
//       timeTaken: ollamaTime,
//       candidate: ollamaCorrection || null,
//       outcome: 'skipped'
//     };
//     analytics.timing.ollama = ollamaTime;

//     if (!ollamaCorrection) return null;
//     if (ollamaCorrection === normalised) {
//       analytics.ollama.outcome = 'same_as_original';
//       return null;
//     }

//     console.log(`[Ollama] Candidate: "${query}" → "${ollamaCorrection}"`);

//     const ollamaResults = await searchProducts(ollamaCorrection, options);
//     analytics.ollama.resultsBefore = originalResults?.hits?.length || 0;
//     analytics.ollama.resultsAfter = ollamaResults.hits.length;

//     if (ollamaResults.hits.length < OLLAMA_MIN_RESULTS) {
//       analytics.ollama.outcome = 'rejected_no_results';
//       analytics.ollama.rejectionReason = `only ${ollamaResults.hits.length} results`;
//       console.log(`[Ollama] Rejected — only ${ollamaResults.hits.length} results`);
//       return null;
//     }

//     if (originalResults && ollamaResults.totalHits <= originalResults.totalHits) {
//       analytics.ollama.outcome = 'rejected_not_better';
//       analytics.ollama.rejectionReason = `${ollamaResults.totalHits} <= ${originalResults.totalHits}`;
//       console.log(`[Ollama] Rejected — not better`);
//       return null;
//     }

//     analytics.ollama.outcome = 'accepted';
//     analytics.searchStage = 'ollama';
//     analytics.correctionDepth = 3;
//     analytics.correction = {
//       applied: true,
//       finalQuery: ollamaCorrection,
//       source: 'ollama',
//       confidence: 0.75,
//       improvement: ollamaResults.totalHits - (originalResults?.totalHits || 0)
//     };

//     console.log(`[Ollama] Accepted: "${query}" → "${ollamaCorrection}" (${ollamaResults.totalHits} results)`);
//     safeSaveCorrection(query, ollamaCorrection, 'ollama', ollamaResults.hits.length);

//     return {
//       originalQuery: query,
//       normalisedQuery: normalised,
//       correctedQuery: ollamaCorrection,
//       wasCorrected: true,
//       correctionConfidence: 0.75,
//       correctionSource: 'ollama',
//       results: ollamaResults.hits,
//       totalHits: ollamaResults.totalHits,
//       processingTime: Date.now() - startTime,
//       isFallback: false
//     };

//   } catch (err) {
//     console.error('tryOllamaCorrection error:', err.message);
//     return null;
//   }
// }

// // ─── SUGGEST ──────────────────────────────────────────────

// async function runSuggest(query, options = {}) {
//   const normalised = normalise(query);
//   if (!normalised) return { products: [], categories: [] };

//   const correction = applyCorrection(query);
//   const searchQuery = correction.corrected ? correction.query : normalised;

//   let finalQuery = searchQuery;
//   let wasCorrected = correction.corrected;
//   let correctionSource = correction.corrected ? correction.source : null;
//   let correctionConfidence = correction.corrected ? (correction.confidence || null) : null;

//   if (!wasCorrected && getSymSpellStatus().ready) {
//     const symspellResult = symspellCorrectQuery(normalised);
//     if (symspellResult) {
//       finalQuery = symspellResult.corrected;
//       wasCorrected = true;
//       correctionSource = 'symspell';
//       correctionConfidence = 0.85;
//     }
//   }

//   const suggestions = await getSuggestions(finalQuery, options);

//   return {
//     query: normalised,
//     originalQuery: query,
//     correctedQuery: wasCorrected ? finalQuery : null,
//     wasCorrected,
//     correctionConfidence,
//     correctionSource,
//     products: suggestions.products,
//     categories: suggestions.categories
//   };
// }

// // ─── NAVIGATE ─────────────────────────────────────────────

// async function runNavigate(category, subcategory, options = {}) {
//   if (!category) return buildEmptyResponse('');

//   const startTime = Date.now();
//   const results = await navigateCategory(category, subcategory, options);

//   if (results.hits.length === 0) {
//     const popular = await getPopularProducts(10);
//     return {
//       category,
//       subcategory,
//       subCategory: options.subCategory || null,
//       results: popular,
//       totalHits: popular.length,
//       processingTime: Date.now() - startTime,
//       isFallback: true,
//       fallbackReason: 'no products in category'
//     };
//   }

//   return {
//     category,
//     subcategory,
//     subCategory: options.subCategory || null,
//     results: results.hits,
//     totalHits: results.totalHits,
//     processingTime: Date.now() - startTime,
//     isFallback: false
//   };
// }

// // ─── EMPTY RESPONSE ───────────────────────────────────────

// function buildEmptyResponse(query) {
//   return {
//     originalQuery: query,
//     normalisedQuery: '',
//     correctedQuery: null,
//     wasCorrected: false,
//     correctionConfidence: null,
//     correctionSource: null,
//     results: [],
//     totalHits: 0,
//     processingTime: 0,
//     isFallback: false,
//     isEmpty: true
//   };
// }

// module.exports = { runSearch, runSuggest, runNavigate };













































// const { normalise } = require('./normalise');
// const {
//   searchProducts,
//   getSuggestions,
//   navigateCategory,
//   getPopularProducts
// } = require('../meilisearch/searcher');
// const {
//   applyCorrection,
//   saveCorrection,
//   penaliseCorrection
// } = require('../learned/learnedMap');
// const { correctQuery: ollamaCorrectQuery } = require('../ollama/corrector');
// const { correctQuery: symspellCorrectQuery, getStatus: getSymSpellStatus } = require('../spellcheck/symspell');

// // ─── CONFIG ───────────────────────────────────────────────
// const MIN_RESULTS_TO_LEARN = 5;
// const MIN_IMPROVEMENT = 5;
// const WEAK_RESULTS_THRESHOLD = 20;
// const OLLAMA_MIN_RESULTS = 15;    // higher bar for Ollama corrections

// // ─── SAFE SAVE ────────────────────────────────────────────
// // prevents correction chains: a → b → c
// // never save if target itself corrects again

// function safeSaveCorrection(query, corrected, source, hitCount) {
//   try {
//     const chainCheck = applyCorrection(corrected);
//     if (chainCheck.corrected) {
//       console.log(`[SafeSave] Chain detected — skipped: "${corrected}" → "${chainCheck.query}"`);
//       return;
//     }
//     saveCorrection(query, corrected, source, hitCount);
//   } catch (e) {
//     console.error('saveCorrection error:', e.message);
//   }
// }

// // ─── SEARCH ───────────────────────────────────────────────

// async function runSearch(query, options = {}) {
//   const startTime = Date.now();

//   // Step 1 — normalise
//   const normalised = normalise(query);
//   if (!normalised) return buildEmptyResponse(query);

//   // Step 2 — Layer 1: check learned map
//   const correction = applyCorrection(query);
//   const searchQuery = correction.corrected ? correction.query : normalised;
//   const wasCorrected = correction.corrected;

//   // Step 3 — search Meilisearch with corrected query
//   const results = await searchProducts(searchQuery, options);

//   // Step 4 — learnedMap correction validation
//   if (wasCorrected) {

//     // zero results → try SymSpell then Ollama
//     if (results.hits.length === 0) {
//       const symspellResult = await trySymSpellCorrection(
//         query, normalised, options, startTime
//       );
//       if (symspellResult) return symspellResult;

//       const ollamaResult = await tryOllamaCorrection(
//         query, normalised, options, startTime
//       );
//       if (ollamaResult) return ollamaResult;

//       const popular = await getPopularProducts(10);
//       return {
//         originalQuery: query,
//         normalisedQuery: normalised,
//         correctedQuery: null,
//         wasCorrected: false,
//         correctionConfidence: null,
//         correctionSource: null,
//         results: popular,
//         totalHits: popular.length,
//         processingTime: Date.now() - startTime,
//         isFallback: true,
//         fallbackReason: 'no results found'
//       };
//     }

//     // compare corrected vs original
//     const originalResults = await searchProducts(normalised, options);

//     // corrected is worse → penalise + return original
//     if (results.totalHits < originalResults.totalHits) {
//       console.log(`[Layer1] "${query}" → "${searchQuery}" blocked — corrected(${results.totalHits}) < original(${originalResults.totalHits})`);

//       try {
//         penaliseCorrection(query);
//       } catch (e) {
//         console.error('penaliseCorrection error:', e.message);
//       }

//       return {
//         originalQuery: query,
//         normalisedQuery: normalised,
//         correctedQuery: null,
//         wasCorrected: false,
//         correctionConfidence: null,
//         correctionSource: null,
//         results: originalResults.hits,
//         totalHits: originalResults.totalHits,
//         processingTime: Date.now() - startTime,
//         isFallback: false
//       };
//     }

//     // corrected is meaningfully better → strengthen
//     if (
//       results.hits.length >= MIN_RESULTS_TO_LEARN &&
//       results.totalHits >= originalResults.totalHits + MIN_IMPROVEMENT
//     ) {
//       console.log(`[Learn] Correction: "${query}" → "${searchQuery}" (${results.totalHits} vs ${originalResults.totalHits})`);
//       safeSaveCorrection(query, searchQuery, correction.source || 'manual', results.hits.length);
//     }

//     return {
//       originalQuery: query,
//       normalisedQuery: normalised,
//       correctedQuery: searchQuery,
//       wasCorrected: true,
//       correctionConfidence: correction.confidence || null,
//       correctionSource: correction.source || null,
//       results: results.hits,
//       totalHits: results.totalHits,
//       processingTime: Date.now() - startTime,
//       isFallback: false
//     };
//   }

//   // Step 5 — no learnedMap correction
//   // zero results → try SymSpell then Ollama
//   if (results.hits.length === 0) {
//     const symspellResult = await trySymSpellCorrection(
//       query, normalised, options, startTime
//     );
//     if (symspellResult) return symspellResult;

//     const ollamaResult = await tryOllamaCorrection(
//       query, normalised, options, startTime
//     );
//     if (ollamaResult) return ollamaResult;

//     const popular = await getPopularProducts(10);
//     return {
//       originalQuery: query,
//       normalisedQuery: normalised,
//       correctedQuery: null,
//       wasCorrected: false,
//       correctionConfidence: null,
//       correctionSource: null,
//       results: popular,
//       totalHits: popular.length,
//       processingTime: Date.now() - startTime,
//       isFallback: true,
//       fallbackReason: 'no results found'
//     };
//   }

//   // Step 6 — weak results
//   if (results.hits.length <= WEAK_RESULTS_THRESHOLD) {

//     // try learnedMap abbreviation first
//     const abbCorrection = applyCorrection(query, 0);
//     if (abbCorrection.corrected) {
//       const abbResults = await searchProducts(abbCorrection.query, options);

//       if (
//         abbResults.hits.length >= MIN_RESULTS_TO_LEARN &&
//         abbResults.hits.length > results.hits.length
//       ) {
//         console.log(`[Learn] Abbreviation: "${query}" → "${abbCorrection.query}" (${abbResults.hits.length} results)`);
//         safeSaveCorrection(query, abbCorrection.query, abbCorrection.source || 'manual', abbResults.hits.length);

//         return {
//           originalQuery: query,
//           normalisedQuery: normalised,
//           correctedQuery: abbCorrection.query,
//           wasCorrected: true,
//           correctionConfidence: abbCorrection.confidence || null,
//           correctionSource: abbCorrection.source || null,
//           results: abbResults.hits,
//           totalHits: abbResults.totalHits,
//           processingTime: Date.now() - startTime,
//           isFallback: false
//         };
//       }
//     }

//     // try SymSpell before Ollama
//     const symspellResult = await trySymSpellCorrection(
//       query, normalised, options, startTime, results
//     );
//     if (symspellResult) return symspellResult;

//     // Ollama as last resort
//     const ollamaResult = await tryOllamaCorrection(
//       query, normalised, options, startTime, results
//     );
//     if (ollamaResult) return ollamaResult;
//   }

//   // Step 7 — return normal results
//   return {
//     originalQuery: query,
//     normalisedQuery: normalised,
//     correctedQuery: null,
//     wasCorrected: false,
//     correctionConfidence: null,
//     correctionSource: null,
//     results: results.hits,
//     totalHits: results.totalHits,
//     processingTime: Date.now() - startTime,
//     isFallback: false
//   };
// }

// // ─── SYMSPELL CORRECTION HELPER ───────────────────────────

// async function trySymSpellCorrection(query, normalised, options, startTime, originalResults = null) {
//   try {
//     if (!getSymSpellStatus().ready) return null;

//     const symspellResult = symspellCorrectQuery(query);
//     if (!symspellResult) return null;

//     const corrected = symspellResult.corrected;

//     if (corrected === normalised) return null;

//     console.log(`[SymSpell] Candidate: "${query}" → "${corrected}"`);

//     // validate with Meilisearch
//     const correctedResults = await searchProducts(corrected, options);

//     if (correctedResults.hits.length < MIN_RESULTS_TO_LEARN) {
//       console.log(`[SymSpell] Rejected — only ${correctedResults.hits.length} results for "${corrected}"`);
//       return null;
//     }

//     if (originalResults && correctedResults.totalHits <= originalResults.totalHits) {
//       console.log(`[SymSpell] Rejected — not better than original (${correctedResults.totalHits} vs ${originalResults.totalHits})`);
//       return null;
//     }

//     console.log(`[SymSpell] Accepted: "${query}" → "${corrected}" (${correctedResults.totalHits} results)`);

//     // safe save — prevents correction chains
//     safeSaveCorrection(query, corrected, 'symspell', correctedResults.hits.length);

//     return {
//       originalQuery: query,
//       normalisedQuery: normalised,
//       correctedQuery: corrected,
//       wasCorrected: true,
//       correctionConfidence: 0.85,
//       correctionSource: 'symspell',
//       results: correctedResults.hits,
//       totalHits: correctedResults.totalHits,
//       processingTime: Date.now() - startTime,
//       isFallback: false
//     };

//   } catch (err) {
//     console.error('trySymSpellCorrection error:', err.message);
//     return null;
//   }
// }

// // ─── OLLAMA CORRECTION HELPER ─────────────────────────────

// async function tryOllamaCorrection(query, normalised, options, startTime, originalResults = null) {
//   try {
//     const ollamaCorrection = await ollamaCorrectQuery(query);
//     if (!ollamaCorrection) return null;

//     if (ollamaCorrection === normalised) return null;

//     console.log(`[Ollama] Candidate: "${query}" → "${ollamaCorrection}"`);

//     const ollamaResults = await searchProducts(ollamaCorrection, options);

//     if (ollamaResults.hits.length < OLLAMA_MIN_RESULTS) {
//       console.log(`[Ollama] Rejected — only ${ollamaResults.hits.length} results for "${ollamaCorrection}"`);
//       return null;
//     }

//     if (originalResults && ollamaResults.totalHits <= originalResults.totalHits) {
//       console.log(`[Ollama] Rejected — not better than original (${ollamaResults.totalHits} vs ${originalResults.totalHits})`);
//       return null;
//     }

//     console.log(`[Ollama] Accepted: "${query}" → "${ollamaCorrection}" (${ollamaResults.totalHits} results)`);

//     // safe save — prevents correction chains
//     safeSaveCorrection(query, ollamaCorrection, 'ollama', ollamaResults.hits.length);

//     return {
//       originalQuery: query,
//       normalisedQuery: normalised,
//       correctedQuery: ollamaCorrection,
//       wasCorrected: true,
//       correctionConfidence: 0.75,
//       correctionSource: 'ollama',
//       results: ollamaResults.hits,
//       totalHits: ollamaResults.totalHits,
//       processingTime: Date.now() - startTime,
//       isFallback: false
//     };

//   } catch (err) {
//     console.error('tryOllamaCorrection error:', err.message);
//     return null;
//   }
// }

// // ─── SUGGEST ──────────────────────────────────────────────

// async function runSuggest(query, options = {}) {
//   const normalised = normalise(query);
//   if (!normalised) return { products: [], categories: [] };

//   const correction = applyCorrection(query);
//   const searchQuery = correction.corrected ? correction.query : normalised;

//   // try SymSpell for suggest if no learnedMap correction
//   let finalQuery = searchQuery;
//   let wasCorrected = correction.corrected;
//   let correctionSource = correction.corrected ? correction.source : null;
//   let correctionConfidence = correction.corrected ? (correction.confidence || null) : null;

//   if (!wasCorrected && getSymSpellStatus().ready) {
//     const symspellResult = symspellCorrectQuery(normalised);
//     if (symspellResult) {
//       finalQuery = symspellResult.corrected;
//       wasCorrected = true;
//       correctionSource = 'symspell';
//       correctionConfidence = 0.85;
//     }
//   }

//   const suggestions = await getSuggestions(finalQuery, options);

//   return {
//     query: normalised,
//     originalQuery: query,
//     correctedQuery: wasCorrected ? finalQuery : null,
//     wasCorrected,
//     correctionConfidence,
//     correctionSource,
//     products: suggestions.products,
//     categories: suggestions.categories
//   };
// }

// // ─── NAVIGATE ─────────────────────────────────────────────

// async function runNavigate(category, subcategory, options = {}) {
//   if (!category) return buildEmptyResponse('');

//   const startTime = Date.now();
//   const results = await navigateCategory(category, subcategory, options);

//   if (results.hits.length === 0) {
//     const popular = await getPopularProducts(10);
//     return {
//       category,
//       subcategory,
//       subCategory: options.subCategory || null,
//       results: popular,
//       totalHits: popular.length,
//       processingTime: Date.now() - startTime,
//       isFallback: true,
//       fallbackReason: 'no products in category'
//     };
//   }

//   return {
//     category,
//     subcategory,
//     subCategory: options.subCategory || null,
//     results: results.hits,
//     totalHits: results.totalHits,
//     processingTime: Date.now() - startTime,
//     isFallback: false
//   };
// }

// // ─── EMPTY RESPONSE ───────────────────────────────────────

// function buildEmptyResponse(query) {
//   return {
//     originalQuery: query,
//     normalisedQuery: '',
//     correctedQuery: null,
//     wasCorrected: false,
//     correctionConfidence: null,
//     correctionSource: null,
//     results: [],
//     totalHits: 0,
//     processingTime: 0,
//     isFallback: false,
//     isEmpty: true
//   };
// }

// module.exports = { runSearch, runSuggest, runNavigate };










































// const { normalise } = require('./normalise');
// const {
//   searchProducts,
//   getSuggestions,
//   navigateCategory,
//   getPopularProducts
// } = require('../meilisearch/searcher');
// const {
//   applyCorrection,
//   saveCorrection,
//   penaliseCorrection
// } = require('../learned/learnedMap');
// const { correctQuery } = require('../ollama/corrector');

// // ─── CONFIG ───────────────────────────────────────────────
// const MIN_RESULTS_TO_LEARN = 5;
// const MIN_IMPROVEMENT = 5;
// const WEAK_RESULTS_THRESHOLD = 20; // try Ollama if results <= this

// // ─── SEARCH ───────────────────────────────────────────────

// async function runSearch(query, options = {}) {
//   const startTime = Date.now();

//   // Step 1 — normalise
//   const normalised = normalise(query);
//   if (!normalised) return buildEmptyResponse(query);

//   // Step 2 — Layer 0: check learned map
//   const correction = applyCorrection(query);
//   const searchQuery = correction.corrected ? correction.query : normalised;
//   const wasCorrected = correction.corrected;

//   // Step 3 — search Meilisearch with corrected query
//   const results = await searchProducts(searchQuery, options);

//   // Step 4 — Layer 1: compare corrected vs original
//   if (wasCorrected) {

//     // check zero results first — skip unnecessary comparison
//     if (results.hits.length === 0) {
//       // try Ollama before fallback
//       const ollamaResult = await tryOllamaCorrection(
//         query, normalised, options, startTime
//       );
//       if (ollamaResult) return ollamaResult;

//       const popular = await getPopularProducts(10);
//       return {
//         originalQuery: query,
//         normalisedQuery: normalised,
//         correctedQuery: null,
//         wasCorrected: false,
//         correctionConfidence: null,
//         correctionSource: null,
//         results: popular,
//         totalHits: popular.length,
//         processingTime: Date.now() - startTime,
//         isFallback: true,
//         fallbackReason: 'no results found'
//       };
//     }

//     // compare corrected vs original
//     const originalResults = await searchProducts(normalised, options);

//     // corrected is worse → penalise + return original
//     if (results.totalHits < originalResults.totalHits) {
//       console.log(`[Layer1] "${query}" → "${searchQuery}" blocked — corrected(${results.totalHits}) < original(${originalResults.totalHits})`);

//       try {
//         penaliseCorrection(query);
//       } catch (e) {
//         console.error('penaliseCorrection error:', e.message);
//       }

//       return {
//         originalQuery: query,
//         normalisedQuery: normalised,
//         correctedQuery: null,
//         wasCorrected: false,
//         correctionConfidence: null,
//         correctionSource: null,
//         results: originalResults.hits,
//         totalHits: originalResults.totalHits,
//         processingTime: Date.now() - startTime,
//         isFallback: false
//       };
//     }

//     // corrected is meaningfully better → strengthen
//     if (
//       results.hits.length >= MIN_RESULTS_TO_LEARN &&
//       results.totalHits >= originalResults.totalHits + MIN_IMPROVEMENT
//     ) {
//       console.log(`[Learn] Correction: "${query}" → "${searchQuery}" (${results.totalHits} vs ${originalResults.totalHits})`);

//       try {
//         saveCorrection(
//           query,
//           searchQuery,
//           correction.source || 'manual',
//           results.hits.length
//         );
//       } catch (e) {
//         console.error('saveCorrection error:', e.message);
//       }
//     }

//     return {
//       originalQuery: query,
//       normalisedQuery: normalised,
//       correctedQuery: searchQuery,
//       wasCorrected: true,
//       correctionConfidence: correction.confidence || null,
//       correctionSource: correction.source || null,
//       results: results.hits,
//       totalHits: results.totalHits,
//       processingTime: Date.now() - startTime,
//       isFallback: false
//     };
//   }

//   // Step 5 — no correction — zero results → try Ollama
//   if (results.hits.length === 0) {
//     const ollamaResult = await tryOllamaCorrection(
//       query, normalised, options, startTime
//     );
//     if (ollamaResult) return ollamaResult;

//     const popular = await getPopularProducts(10);
//     return {
//       originalQuery: query,
//       normalisedQuery: normalised,
//       correctedQuery: null,
//       wasCorrected: false,
//       correctionConfidence: null,
//       correctionSource: null,
//       results: popular,
//       totalHits: popular.length,
//       processingTime: Date.now() - startTime,
//       isFallback: true,
//       fallbackReason: 'no results found'
//     };
//   }

//   // Step 6 — weak results → try abbreviation corrections
//   if (results.hits.length <= WEAK_RESULTS_THRESHOLD) {

//     // try learnedMap abbreviation first
//     const abbCorrection = applyCorrection(query, 0);
//     if (abbCorrection.corrected) {
//       const abbResults = await searchProducts(abbCorrection.query, options);

//       if (
//         abbResults.hits.length >= MIN_RESULTS_TO_LEARN &&
//         abbResults.hits.length > results.hits.length
//       ) {
//         console.log(`[Learn] Abbreviation: "${query}" → "${abbCorrection.query}" (${abbResults.hits.length} results)`);

//         try {
//           saveCorrection(
//             query,
//             abbCorrection.query,
//             abbCorrection.source || 'manual',
//             abbResults.hits.length
//           );
//         } catch (e) {
//           console.error('saveCorrection error:', e.message);
//         }

//         return {
//           originalQuery: query,
//           normalisedQuery: normalised,
//           correctedQuery: abbCorrection.query,
//           wasCorrected: true,
//           correctionConfidence: abbCorrection.confidence || null,
//           correctionSource: abbCorrection.source || null,
//           results: abbResults.hits,
//           totalHits: abbResults.totalHits,
//           processingTime: Date.now() - startTime,
//           isFallback: false
//         };
//       }
//     }

//     // abbreviation failed → try Ollama for weak results
//     const ollamaResult = await tryOllamaCorrection(
//       query, normalised, options, startTime, results
//     );
//     if (ollamaResult) return ollamaResult;
//   }

//   // Step 7 — return normal results
//   return {
//     originalQuery: query,
//     normalisedQuery: normalised,
//     correctedQuery: null,
//     wasCorrected: false,
//     correctionConfidence: null,
//     correctionSource: null,
//     results: results.hits,
//     totalHits: results.totalHits,
//     processingTime: Date.now() - startTime,
//     isFallback: false
//   };
// }

// // ─── OLLAMA CORRECTION HELPER ─────────────────────────────

// async function tryOllamaCorrection(query, normalised, options, startTime, originalResults = null) {
//   try {
//     const ollamaCorrection = await correctQuery(query);
//     if (!ollamaCorrection) return null;

//     // don't search if same as original
//     if (ollamaCorrection === normalised) return null;

//     console.log(`[Ollama] Candidate: "${query}" → "${ollamaCorrection}"`);

//     // validate with Meilisearch
//     const ollamaResults = await searchProducts(ollamaCorrection, options);

//     // must have meaningful results
//     if (ollamaResults.hits.length < MIN_RESULTS_TO_LEARN) {
//       console.log(`[Ollama] Rejected — only ${ollamaResults.hits.length} results for "${ollamaCorrection}"`);
//       return null;
//     }

//     // must be better than original if original had results
//     if (originalResults && ollamaResults.totalHits <= originalResults.totalHits) {
//       console.log(`[Ollama] Rejected — not better than original (${ollamaResults.totalHits} vs ${originalResults.totalHits})`);
//       return null;
//     }

//     // valid correction — save to learnedMap
//     console.log(`[Ollama] Accepted: "${query}" → "${ollamaCorrection}" (${ollamaResults.totalHits} results)`);

//     try {
//       saveCorrection(
//         query,
//         ollamaCorrection,
//         'ollama',
//         ollamaResults.hits.length
//       );
//     } catch (e) {
//       console.error('saveCorrection error:', e.message);
//     }

//     return {
//       originalQuery: query,
//       normalisedQuery: normalised,
//       correctedQuery: ollamaCorrection,
//       wasCorrected: true,
//       correctionConfidence: 0.75,
//       correctionSource: 'ollama',
//       results: ollamaResults.hits,
//       totalHits: ollamaResults.totalHits,
//       processingTime: Date.now() - startTime,
//       isFallback: false
//     };

//   } catch (err) {
//     console.error('tryOllamaCorrection error:', err.message);
//     return null;
//   }
// }

// // ─── SUGGEST ──────────────────────────────────────────────

// async function runSuggest(query, options = {}) {
//   const normalised = normalise(query);
//   if (!normalised) return { products: [], categories: [] };

//   const correction = applyCorrection(query);
//   const searchQuery = correction.corrected ? correction.query : normalised;

//   const suggestions = await getSuggestions(searchQuery, options);

//   return {
//     query: normalised,
//     originalQuery: query,
//     correctedQuery: correction.corrected ? searchQuery : null,
//     wasCorrected: correction.corrected,
//     correctionConfidence: correction.corrected ? (correction.confidence || null) : null,
//     correctionSource: correction.corrected ? (correction.source || null) : null,
//     products: suggestions.products,
//     categories: suggestions.categories
//   };
// }

// // ─── NAVIGATE ─────────────────────────────────────────────

// async function runNavigate(category, subcategory, options = {}) {
//   if (!category) return buildEmptyResponse('');

//   const startTime = Date.now();
//   const results = await navigateCategory(category, subcategory, options);

//   if (results.hits.length === 0) {
//     const popular = await getPopularProducts(10);
//     return {
//       category,
//       subcategory,
//       subCategory: options.subCategory || null,
//       results: popular,
//       totalHits: popular.length,
//       processingTime: Date.now() - startTime,
//       isFallback: true,
//       fallbackReason: 'no products in category'
//     };
//   }

//   return {
//     category,
//     subcategory,
//     subCategory: options.subCategory || null,
//     results: results.hits,
//     totalHits: results.totalHits,
//     processingTime: Date.now() - startTime,
//     isFallback: false
//   };
// }

// // ─── EMPTY RESPONSE ───────────────────────────────────────

// function buildEmptyResponse(query) {
//   return {
//     originalQuery: query,
//     normalisedQuery: '',
//     correctedQuery: null,
//     wasCorrected: false,
//     correctionConfidence: null,
//     correctionSource: null,
//     results: [],
//     totalHits: 0,
//     processingTime: 0,
//     isFallback: false,
//     isEmpty: true
//   };
// }

// module.exports = { runSearch, runSuggest, runNavigate };
































// const { normalise } = require('./normalise');
// const {
//   searchProducts,
//   getSuggestions,
//   navigateCategory,
//   getPopularProducts
// } = require('../meilisearch/searcher');
// const {
//   applyCorrection,
//   saveCorrection,
//   penaliseCorrection
// } = require('../learned/learnedMap');

// // ─── CONFIG ───────────────────────────────────────────────
// const MIN_RESULTS_TO_LEARN = 5;
// const MIN_IMPROVEMENT = 5;

// // ─── SEARCH ───────────────────────────────────────────────

// async function runSearch(query, options = {}) {
//   const startTime = Date.now();

//   // Step 1 — normalise
//   const normalised = normalise(query);
//   if (!normalised) return buildEmptyResponse(query);

//   // Step 2 — Layer 0: check learned map
//   const correction = applyCorrection(query);
//   const searchQuery = correction.corrected ? correction.query : normalised;
//   const wasCorrected = correction.corrected;

//   // Step 3 — search Meilisearch with corrected query
//   const results = await searchProducts(searchQuery, options);

//   // Step 4 — Layer 1: compare corrected vs original
//   if (wasCorrected) {

//     // check zero results first — skip unnecessary comparison
//     if (results.hits.length === 0) {
//       const popular = await getPopularProducts(10);
//       return {
//         originalQuery: query,
//         normalisedQuery: normalised,
//         correctedQuery: null,
//         wasCorrected: false,
//         correctionConfidence: null,
//         correctionSource: null,
//         results: popular,
//         totalHits: popular.length,
//         processingTime: Date.now() - startTime,
//         isFallback: true,
//         fallbackReason: 'no results found'
//       };
//     }

//     // compare corrected vs original
//     const originalResults = await searchProducts(normalised, options);

//     // corrected is worse → penalise + return original
//     if (results.totalHits < originalResults.totalHits) {
//       console.log(`[Layer1] "${query}" → "${searchQuery}" blocked — corrected(${results.totalHits}) < original(${originalResults.totalHits})`);

//       try {
//         penaliseCorrection(query);
//       } catch (e) {
//         console.error('penaliseCorrection error:', e.message);
//       }

//       return {
//         originalQuery: query,
//         normalisedQuery: normalised,
//         correctedQuery: null,
//         wasCorrected: false,
//         correctionConfidence: null,
//         correctionSource: null,
//         results: originalResults.hits,
//         totalHits: originalResults.totalHits,
//         processingTime: Date.now() - startTime,
//         isFallback: false
//       };
//     }

//     // corrected is meaningfully better → strengthen
//     if (
//       results.hits.length >= MIN_RESULTS_TO_LEARN &&
//       results.totalHits >= originalResults.totalHits + MIN_IMPROVEMENT
//     ) {
//       console.log(`[Learn] Correction: "${query}" → "${searchQuery}" (${results.totalHits} vs ${originalResults.totalHits})`);

//       try {
//         saveCorrection(
//           query,
//           searchQuery,
//           correction.source || 'manual',
//           results.hits.length
//         );
//       } catch (e) {
//         console.error('saveCorrection error:', e.message);
//       }
//     }

//     // Fix 3 — return correction metadata for frontend
//     return {
//       originalQuery: query,
//       normalisedQuery: normalised,
//       correctedQuery: searchQuery,
//       wasCorrected: true,
//       correctionConfidence: correction.confidence || null,
//       correctionSource: correction.source || null,
//       results: results.hits,
//       totalHits: results.totalHits,
//       processingTime: Date.now() - startTime,
//       isFallback: false
//     };
//   }

//   // Step 5 — no correction — fallback if no results
//   if (results.hits.length === 0) {
//     const popular = await getPopularProducts(10);
//     return {
//       originalQuery: query,
//       normalisedQuery: normalised,
//       correctedQuery: null,
//       wasCorrected: false,
//       correctionConfidence: null,
//       correctionSource: null,
//       results: popular,
//       totalHits: popular.length,
//       processingTime: Date.now() - startTime,
//       isFallback: true,
//       fallbackReason: 'no results found'
//     };
//   }

//   // Step 6 — try abbreviation corrections
//   if (results.hits.length <= 3) {
//     const abbCorrection = applyCorrection(query, 0);
//     if (abbCorrection.corrected) {
//       const abbResults = await searchProducts(abbCorrection.query, options);

//       if (
//         abbResults.hits.length >= MIN_RESULTS_TO_LEARN &&
//         abbResults.hits.length > results.hits.length
//       ) {
//         console.log(`[Learn] Abbreviation: "${query}" → "${abbCorrection.query}" (${abbResults.hits.length} results)`);

//         try {
//           saveCorrection(
//             query,
//             abbCorrection.query,
//             abbCorrection.source || 'manual',
//             abbResults.hits.length
//           );
//         } catch (e) {
//           console.error('saveCorrection error:', e.message);
//         }

//         // Fix 3 — return correction metadata
//         return {
//           originalQuery: query,
//           normalisedQuery: normalised,
//           correctedQuery: abbCorrection.query,
//           wasCorrected: true,
//           correctionConfidence: abbCorrection.confidence || null,
//           correctionSource: abbCorrection.source || null,
//           results: abbResults.hits,
//           totalHits: abbResults.totalHits,
//           processingTime: Date.now() - startTime,
//           isFallback: false
//         };
//       }
//     }
//   }

//   // Step 7 — return normal results
//   return {
//     originalQuery: query,
//     normalisedQuery: normalised,
//     correctedQuery: null,
//     wasCorrected: false,
//     correctionConfidence: null,
//     correctionSource: null,
//     results: results.hits,
//     totalHits: results.totalHits,
//     processingTime: Date.now() - startTime,
//     isFallback: false
//   };
// }

// // ─── SUGGEST ──────────────────────────────────────────────

// async function runSuggest(query, options = {}) {
//   const normalised = normalise(query);
//   if (!normalised) return { products: [], categories: [] };

//   const correction = applyCorrection(query);
//   const searchQuery = correction.corrected ? correction.query : normalised;

//   const suggestions = await getSuggestions(searchQuery, options);

//   return {
//     query: normalised,
//     originalQuery: query,
//     correctedQuery: correction.corrected ? searchQuery : null,
//     wasCorrected: correction.corrected,
//     // Fix 3 — expose for suggest too
//     correctionConfidence: correction.corrected ? (correction.confidence || null) : null,
//     correctionSource: correction.corrected ? (correction.source || null) : null,
//     products: suggestions.products,
//     categories: suggestions.categories
//   };
// }

// // ─── NAVIGATE ─────────────────────────────────────────────

// async function runNavigate(category, subcategory, options = {}) {
//   if (!category) return buildEmptyResponse('');

//   const startTime = Date.now();
//   const results = await navigateCategory(category, subcategory, options);

//   if (results.hits.length === 0) {
//     const popular = await getPopularProducts(10);
//     return {
//       category,
//       subcategory,
//       results: popular,
//       totalHits: popular.length,
//       processingTime: Date.now() - startTime,
//       isFallback: true,
//       fallbackReason: 'no products in category'
//     };
//   }

//   return {
//     category,
//     subcategory,
//     results: results.hits,
//     totalHits: results.totalHits,
//     processingTime: Date.now() - startTime,
//     isFallback: false
//   };
// }

// // ─── EMPTY RESPONSE ───────────────────────────────────────

// function buildEmptyResponse(query) {
//   return {
//     originalQuery: query,
//     normalisedQuery: '',
//     correctedQuery: null,
//     wasCorrected: false,
//     correctionConfidence: null,
//     correctionSource: null,
//     results: [],
//     totalHits: 0,
//     processingTime: 0,
//     isFallback: false,
//     isEmpty: true
//   };
// }

// module.exports = { runSearch, runSuggest, runNavigate };


























// const { normalise } = require('./normalise');
// const {
//   searchProducts,
//   getSuggestions,
//   navigateCategory,
//   getPopularProducts
// } = require('../meilisearch/searcher');
// const {
//   applyCorrection,
//   saveCorrection
// } = require('../learned/learnedMap');

// // ─── CONFIG ───────────────────────────────────────────────
// // minimum results needed to consider a correction valid
// const MIN_RESULTS_TO_LEARN = 5;

// // ─── SEARCH ───────────────────────────────────────────────

// async function runSearch(query, options = {}) {
//   const startTime = Date.now();

//   // Step 1 — normalise
//   const normalised = normalise(query);
//   if (!normalised) return buildEmptyResponse(query);

//   // Step 2 — Layer 0: check learned map
//   const correction = applyCorrection(query);
//   const searchQuery = correction.corrected ? correction.query : normalised;
//   const wasCorrected = correction.corrected;

//   // Step 3 — search Meilisearch with corrected query
//   const results = await searchProducts(searchQuery, options);

//   // Step 4 — correction applied but still no results
//   // retry with original normalised query
//   if (wasCorrected && results.hits.length === 0) {
//     const retryResults = await searchProducts(normalised, options);

//     if (retryResults.hits.length > 0) {
//       return {
//         originalQuery: query,
//         normalisedQuery: normalised,
//         correctedQuery: null,
//         wasCorrected: false,
//         results: retryResults.hits,
//         totalHits: retryResults.totalHits,
//         processingTime: Date.now() - startTime,
//         isFallback: false
//       };
//     }
//   }

//   // Step 5 — fallback if still no results
//   if (results.hits.length === 0) {
//     const popular = await getPopularProducts(10);
//     return {
//       originalQuery: query,
//       normalisedQuery: normalised,
//       correctedQuery: wasCorrected ? searchQuery : null,
//       wasCorrected,
//       results: popular,
//       totalHits: popular.length,
//       processingTime: Date.now() - startTime,
//       isFallback: true,
//       fallbackReason: 'no results found'
//     };
//   }

//   // Step 6 — try abbreviation corrections
//   // Fix 2 — only when results are weak AND abbreviation gives 5+
//   if (!wasCorrected && results.hits.length <= 3) {
//     const abbCorrection = applyCorrection(query, 0);
//     if (abbCorrection.corrected) {
//       const abbResults = await searchProducts(abbCorrection.query, options);

//       // Fix 2 — must have 5+ results AND be better than current
//       if (
//         abbResults.hits.length >= MIN_RESULTS_TO_LEARN &&
//         abbResults.hits.length > results.hits.length
//       ) {
//         // Fix 6 — log learning event
//         console.log(`[Learn] Abbreviation: "${query}" → "${abbCorrection.query}" (${abbResults.hits.length} results)`);

//         // auto strengthen abbreviation correction
//         try {
//           saveCorrection(
//             query,
//             abbCorrection.query,
//             abbCorrection.source || 'manual',
//             abbResults.hits.length
//           );
//         } catch (e) {
//           console.error('saveCorrection error:', e.message);
//         }

//         return {
//           originalQuery: query,
//           normalisedQuery: normalised,
//           correctedQuery: abbCorrection.query,
//           wasCorrected: true,
//           results: abbResults.hits,
//           totalHits: abbResults.totalHits,
//           processingTime: Date.now() - startTime,
//           isFallback: false
//         };
//       }
//     }
//   }

//   // Step 7 — auto strengthen correction that worked
//   // Fix 1 + 4 — only learn if 5+ good results
//   if (wasCorrected && results.hits.length >= MIN_RESULTS_TO_LEARN) {
//     // Fix 6 — log learning event
//     console.log(`[Learn] Correction: "${query}" → "${searchQuery}" (${results.hits.length} results)`);

//     try {
//       saveCorrection(
//         query,
//         searchQuery,
//         correction.source || 'manual',
//         results.hits.length
//       );
//     } catch (e) {
//       console.error('saveCorrection error:', e.message);
//     }
//   }

//   return {
//     originalQuery: query,
//     normalisedQuery: normalised,
//     correctedQuery: wasCorrected ? searchQuery : null,
//     wasCorrected,
//     results: results.hits,
//     totalHits: results.totalHits,
//     processingTime: Date.now() - startTime,
//     isFallback: false
//   };
// }

// // ─── SUGGEST ──────────────────────────────────────────────

// async function runSuggest(query, options = {}) {
//   const normalised = normalise(query);
//   if (!normalised) return { products: [], categories: [] };

//   const correction = applyCorrection(query);
//   const searchQuery = correction.corrected ? correction.query : normalised;

//   const suggestions = await getSuggestions(searchQuery, options);

//   return {
//     query: normalised,
//     originalQuery: query,
//     correctedQuery: correction.corrected ? searchQuery : null,
//     wasCorrected: correction.corrected,
//     products: suggestions.products,
//     categories: suggestions.categories
//   };
// }

// // ─── NAVIGATE ─────────────────────────────────────────────

// async function runNavigate(category, subcategory, options = {}) {
//   if (!category) return buildEmptyResponse('');

//   const startTime = Date.now();
//   const results = await navigateCategory(category, subcategory, options);

//   if (results.hits.length === 0) {
//     const popular = await getPopularProducts(10);
//     return {
//       category,
//       subcategory,
//       results: popular,
//       totalHits: popular.length,
//       processingTime: Date.now() - startTime,
//       isFallback: true,
//       fallbackReason: 'no products in category'
//     };
//   }

//   return {
//     category,
//     subcategory,
//     results: results.hits,
//     totalHits: results.totalHits,
//     processingTime: Date.now() - startTime,
//     isFallback: false
//   };
// }

// // ─── EMPTY RESPONSE ───────────────────────────────────────

// function buildEmptyResponse(query) {
//   return {
//     originalQuery: query,
//     normalisedQuery: '',
//     correctedQuery: null,
//     wasCorrected: false,
//     results: [],
//     totalHits: 0,
//     processingTime: 0,
//     isFallback: false,
//     isEmpty: true
//   };
// }

// module.exports = { runSearch, runSuggest, runNavigate };












































