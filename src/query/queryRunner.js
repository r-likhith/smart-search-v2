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
const { validateCorrection } = require('../learned/correctionValidator');
const { correctQuery: phoneticCorrectQuery, getStatus: getPhoneticStatus } = require('../spellcheck/phonetic');
const { logSearchEvent } = require('../../analytics/logger');
const { parseIntent, hasFilters } = require('./intentParser');
const features = require('../searchBanners/features');

// ─── EDIT DISTANCE GATE ───────────────────────────────────
// Centralized edit distance policy ✅
// length ≤ 4 → 0 (no typo — too short, too risky)
// length 5-7 → 1 (one edit allowed)
// length 8+  → 2 (two edits allowed)
// Applied to MAX edit distance across ALL changed words ✅
function maxAllowedEditDistance(word) {
  if (!word) return 0;
  if (word.length <= 4) return 0;
  if (word.length <= 7) return 1;
  return 2;
}

// ─── CONFIG ───────────────────────────────────────────────
const MIN_RESULTS_TO_LEARN   = 5;
const MIN_IMPROVEMENT        = 5;
const WEAK_RESULTS_THRESHOLD = 20;
const MAX_RESULTS_LIMIT = 1000;
const MIN_SUGGEST_RESULTS    = 3;   // threshold for suggest repair ✅

// ─── SAFE SAVE ────────────────────────────────────────────

// ─── LEGACY ADAPTER ──────────────────────────────────────
// Existing callers use (query, corrected, source, hitCount) ✅
// Routes through safeSaveCorrection (validator gate) ✅
// TODO: migrate callers to safeSaveCorrection directly ✅
function safeSaveCorrectionLegacy(query, corrected, source, hitCount = 0) {
  return safeSaveCorrection(
    { original: query, correction: corrected, source },
    { hitCount, resultsAfter: hitCount }
  );
}


// ─── PERSIST CORRECTION ──────────────────────────────────
// Single write gate for learnedMap ✅
// All correction saves pass through here ✅
// candidate: { original, correction, source }
// evidence:  { resultsBefore, resultsAfter, hitCount, clicked, repeated, phoneticAgreement }
// returns:   { decision, score, signals, persisted, ... }
function safeSaveCorrection(candidate, evidence = {}) {
  try {
    // chain check ✅
    const chainCheck = applyCorrection(candidate.correction);
    if (chainCheck.corrected) {
      console.log(`[SafeSave] Chain detected — skipped: "${candidate.correction}" → "${chainCheck.query}"`);
      return { decision: 'reject', score: 0, persisted: false,
               signals: [{ name: 'chain_detection', value: true }],
               candidate };
    }

    // validator gate ✅
    const validation = validateCorrection(candidate, evidence);

    if (validation.decision !== 'save') {
      console.log(`[SafeSave] ${validation.decision} "${candidate.original}"→"${candidate.correction}" score:${validation.score}`);
      return { ...validation, persisted: false };
    }

    // persist ✅
    console.log(`[SafeSave] Saving "${candidate.original}"→"${candidate.correction}" score:${validation.score} source:${candidate.source}`);
    saveCorrection(
      candidate.original,
      candidate.correction,
      candidate.source,
      evidence.hitCount ?? 0
    );
    return { ...validation, persisted: true };

  } catch (e) {
    console.error('[SafeSave] Error:', e.message);
    return { decision: 'reject', score: 0, persisted: false, reason: e.message, candidate };
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
        safeSaveCorrectionLegacy(cleanQuery, phonClean, 'phonetic+intent', phonFilteredResults.hits.length);
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

      // no fallback — return empty results ✅
      // client handles "no results" in their own UI ✅
      analytics.searchStage = 'no_results';
      analytics.results     = buildResultsAnalytics(0, false, 'no results found');
      fireAnalytics(analytics, null, startTime);
      return {
        originalQuery:   query,       normalisedQuery:  normalised,
        retrievalQuery:  normalised,  displayQuery:     null,
        correctedQuery:  null,        wasCorrected:     false,
        correctionConfidence: null,   correctionSource: null,
        correctionMode:  'none',
        results:         [],          totalHits:        0,
        processingTime:  Date.now() - startTime,
        isFallback:      false,       fallbackReason:   null,
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
      safeSaveCorrectionLegacy(query, searchQuery, correction.source || 'manual', results.hits.length);
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

    // no fallback — return empty results ✅
    // client handles "no results" in their own UI ✅
    analytics.searchStage = 'no_results';
    analytics.results     = buildResultsAnalytics(0, false, 'no results found');
    fireAnalytics(analytics, null, startTime);
    return {
      originalQuery:   query,      normalisedQuery:  normalised,
      retrievalQuery:  normalised, displayQuery:     null,
      correctedQuery:  null,       wasCorrected:     false,
      correctionConfidence: null,  correctionSource: null,
      correctionMode:  'none',
      results:         [],         totalHits:        0,
      processingTime:  Date.now() - startTime,
      isFallback:      false,      fallbackReason:   null,
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
        safeSaveCorrectionLegacy(query, abbCorrection.query, abbCorrection.source || 'manual', abbResults.hits.length);
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

    safeSaveCorrectionLegacy(query, corrected, 'symspell', correctedResults.hits.length);

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
    safeSaveCorrectionLegacy(query, corrected, 'phonetic', correctedResults.hits.length);

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

      // gate 1: edit distance plausibility ✅
      // use MAX distance across ALL changed words ✅
      // avoids accepting corrections too far from original ✅
      // "smrte"(5) → max 1 edit, "saree" is 2 edits → rejected ✅
      const worstEdit = Math.max(
        ...(symResult.changedWords || []).map(w => w.distance || 0)
      );
      const maxEdit = maxAllowedEditDistance(normalised);

      if (worstEdit > maxEdit) {
        console.log(`[S2-SymSpell] rejected "${symResult.corrected}" — edit distance ${worstEdit} > max ${maxEdit} for "${normalised}"`);
      } else {
        // gate 2: phonetic cross-check (observability only) ✅
        // not a hard gate yet — log for future confidence tuning ✅
        const phonResult     = phoneticCorrectQuery(normalised);
        const phoneticAgrees = phonResult?.corrected === symResult.corrected;
        if (!phoneticAgrees) {
          console.log(`[S2-SymSpell] phonetic disagrees: "${normalised}" → symspell:"${symResult.corrected}" phonetic:"${phonResult?.corrected}"`);
        }

        const symResults  = await getSuggestions(symResult.corrected, options);
        const symCount    = symResults.products?.length || 0;
        const directCount = directResults.products?.length || 0;

        // gate 3: must improve AND meet minimum ✅
        if (symCount >= MIN_SUGGEST_RESULTS && symCount > directCount) {
          return buildSuggestResponse(
            query, normalised, symResult.corrected,
            true, 'symspell', 0.85,
            symResults
          );
        } else {
          console.log(`[S2-SymSpell] rejected "${symResult.corrected}" — no improvement (${symCount} vs ${directCount} direct)`);
        }
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
    return {
      category, subcategory,
      subCategory: options.subCategory || null,
      results: [], totalHits: 0,
      processingTime: Date.now() - startTime,
      isFallback: false, fallbackReason: null
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

