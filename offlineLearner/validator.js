// offlineLearner/validator.js
// validates Groq corrections against Meilisearch ✅
// per-client validation ✅
// relative improvement logic ✅
// derives scope from results ✅

const { MeiliSearch } = require('meilisearch');
const { MEILISEARCH, THRESHOLDS, CLIENT_SCOPE } = require('./config');

// ─── INIT CLIENT ──────────────────────────────────────────

const meili = new MeiliSearch({
  host:   MEILISEARCH.host,
  apiKey: MEILISEARCH.apiKey
});

// ─── SEARCH CLIENT INDEX ─────────────────────────────────

async function searchClientIndex(clientId, query) {
  try {
    const indexName = MEILISEARCH.indexPattern(clientId);
    const result    = await meili.index(indexName).search(query, { limit: 20 });
    return result.estimatedTotalHits || 0;
  } catch (err) {
    console.warn(`[Validator] Search failed for client_${clientId}: ${err.message}`);
    return 0;
  }
}

// ─── IS IMPROVEMENT ───────────────────────────────────────
// relative improvement logic ✅
// original=0: any results above threshold = improvement ✅
// original>0: need 20% improvement ✅
// prevents: original=5, correction=6 → accept (wrong) ✅

function isImprovement(originalHits, correctionHits) {
  // correction must always meet minimum ✅
  if (correctionHits < THRESHOLDS.minResultsToAccept) return false;

  if (originalHits === 0) {
    // zero → anything above threshold ✅
    return true;
  }

  // original has results → need meaningful improvement ✅
  // 20% improvement required ✅
  return correctionHits >= Math.ceil(originalHits * 1.2);
}

// ─── VALIDATE CORRECTION ─────────────────────────────────
// checks correction against ALL client indexes ✅
// derives scope from which clients benefit ✅

async function validateCorrection(originalQuery, correction) {
  try {
    const clients    = Object.keys(CLIENT_SCOPE);
    const benefiting = [];
    let   bestHits   = 0;

    console.log(`[Validator] Validating: "${originalQuery}" → "${correction}"`);

    for (const clientId of clients) {
      const originalHits   = await searchClientIndex(clientId, originalQuery);
      const correctionHits = await searchClientIndex(clientId, correction);
      const improvement    = correctionHits - originalHits;

      console.log(`[Validator] client_${clientId}: original=${originalHits} correction=${correctionHits} improvement=${improvement}`);

      if (isImprovement(originalHits, correctionHits)) {
        benefiting.push({
          clientId,
          scope:          CLIENT_SCOPE[clientId],
          originalHits,
          correctionHits,
          improvement
        });
        bestHits = Math.max(bestHits, correctionHits);
      }
    }

    // no clients benefit → reject ✅
    if (benefiting.length === 0) {
      console.log(`[Validator] ❌ Rejected — no clients benefit`);
      return null;
    }

    const scope = deriveScope(benefiting);
    console.log(`[Validator] ✅ Accepted — ${benefiting.length} clients benefit, scope: ${scope}`);

    return {
      correction,
      benefiting,
      scope,
      bestHits,
      clientCount: benefiting.length
    };

  } catch (err) {
    console.error(`[Validator] Error: ${err.message}`);
    return null;
  }
}

// ─── DERIVE SCOPE ─────────────────────────────────────────
// global: multiple scopes benefit ✅
// specific: only one scope benefits ✅

function deriveScope(benefiting) {
  const scopes       = benefiting.map(b => b.scope);
  const uniqueScopes = [...new Set(scopes)];
  if (uniqueScopes.length === 1) return uniqueScopes[0];
  return 'global';
}

// ─── VALIDATE BATCH ───────────────────────────────────────

async function validateBatch(groqResults) {
  const validated = [];
  const rejected  = [];

  for (const result of groqResults) {
    if (!result.correction) {
      rejected.push({
        query:  result.query,
        reason: 'no_groq_correction'
      });
      continue;
    }

    const validation = await validateCorrection(
      result.query,
      result.correction
    );

    if (validation) {
      validated.push({ ...result, ...validation });
    } else {
      rejected.push({
        query:      result.query,
        correction: result.correction,
        reason:     'no_meilisearch_improvement'
      });
    }
  }

  console.log(`\n[Validator] Results: ${validated.length} validated, ${rejected.length} rejected`);
  return { validated, rejected };
}

module.exports = { validateCorrection, validateBatch };