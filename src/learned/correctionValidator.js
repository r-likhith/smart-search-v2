// ─── CORRECTION VALIDATOR ─────────────────────────────────
// Centralized validation before ANY correction saves to learnedMap
//
// Three separate responsibilities:
//   validateCandidate() — is this correction plausible?
//   scoreEvidence()     — how much evidence supports it?
//   makeDecision()      — save / observe / reject?
//
// Every decision produces structured telemetry ✅
//
// Stage 1 (now):    trust + edit distance + search improvement
// Stage 2 (later):  pendingCorrections queue
// Stage 3 (future): evidence plugins, policy separation

const { getEditDistance, maxAllowedEditDistance } = require('../spellcheck/spellUtils');

// ─── SOURCE TRUST ─────────────────────────────────────────
// Starting points — tune after 30 days real traffic
const SOURCE_TRUST = {
  manual:   1.00,
  clicks:   0.98,
  symspell: 0.85,
  phonetic: 0.70,
  groq:     0.65,
};

// ─── SCORE WEIGHTS ────────────────────────────────────────
// Named constants — no magic numbers
// Tune these after real traffic data
const SCORE = {
  SEARCH_IMPROVEMENT:    +0.10,
  SEARCH_NO_IMPROVEMENT: -0.10,
  SEARCH_ZERO_RESULTS:   -0.30,
  PHONETIC_AGREEMENT:    +0.08,
  CLICK:                 +0.10,
  REPEATED:              +0.05,
};

// ─── DECISION THRESHOLDS ──────────────────────────────────
const THRESHOLD = {
  SAVE:    0.80,  // save immediately
  OBSERVE: 0.55,  // needs more evidence
                  // below OBSERVE → reject
};

// ─── STAGE 1: VALIDATE CANDIDATE ──────────────────────────
// Is this correction even plausible?
// Hard gates — if any fail, reject immediately
// Returns: { valid, reason }

function validateCandidate(candidate) {
  const { original, correction, source } = candidate;

  // manual always valid
  if (source === 'manual') {
    return { valid: true, reason: 'manual — always trusted' };
  }

  // must be different
  if (!correction || correction.trim() === original.trim()) {
    return { valid: false, reason: 'correction same as original' };
  }

  // edit distance gate (SymSpell only)
  // phonetic exempt — finds corrections edit distance misses
  if (source === 'symspell') {
    const dist    = getEditDistance(original, correction);
    const maxDist = maxAllowedEditDistance(original);
    if (dist > maxDist) {
      return {
        valid:  false,
        reason: `edit distance ${dist} > max ${maxDist} for "${original}"`
      };
    }
  }

  return { valid: true, reason: 'candidate plausible' };
}

// ─── STAGE 2: SCORE EVIDENCE ──────────────────────────────
// How much evidence supports this correction?
// Returns: { score, signals }
// Each signal contributes independently ✅

function scoreEvidence(source, evidence = {}) {
  const {
    resultsBefore     = null,
    resultsAfter      = null,
    clicked           = false,
    repeated          = 1,
    phoneticAgreement = false,
  } = evidence;

  const signals = [];
  let score = SOURCE_TRUST[source] || 0.50;

  signals.push({
    name:  'source_trust',
    value: score,
    note:  `${source} trust: ${score}`
  });

  // search improvement
  if (resultsAfter !== null && resultsBefore !== null) {
    if (resultsAfter > resultsBefore) {
      score += SCORE.SEARCH_IMPROVEMENT;
      signals.push({ name: 'search_improvement', value: SCORE.SEARCH_IMPROVEMENT,
        note: `${resultsBefore} → ${resultsAfter} hits` });
    } else if (resultsAfter === 0) {
      score += SCORE.SEARCH_ZERO_RESULTS;
      signals.push({ name: 'search_zero', value: SCORE.SEARCH_ZERO_RESULTS,
        note: 'zero results after correction' });
    } else {
      score += SCORE.SEARCH_NO_IMPROVEMENT;
      signals.push({ name: 'search_no_improvement', value: SCORE.SEARCH_NO_IMPROVEMENT,
        note: `${resultsAfter} <= ${resultsBefore}` });
    }
  }

  // phonetic agreement
  if (phoneticAgreement) {
    score += SCORE.PHONETIC_AGREEMENT;
    signals.push({ name: 'phonetic_agreement', value: SCORE.PHONETIC_AGREEMENT,
      note: 'phonetic agrees' });
  }

  // user click
  if (clicked) {
    score += SCORE.CLICK;
    signals.push({ name: 'click', value: SCORE.CLICK, note: 'user clicked' });
  }

  // repeated observations
  if (repeated >= 3) {
    score += SCORE.REPEATED;
    signals.push({ name: 'repeated', value: SCORE.REPEATED,
      note: `seen ${repeated} times` });
  }

  return {
    score:   Math.min(Math.round(score * 100) / 100, 1.0),
    signals
  };
}

// ─── STAGE 3: MAKE DECISION ───────────────────────────────
// Given a score, what do we do?
// Returns: 'save' | 'observe' | 'reject'

function makeDecision(score) {
  if (score >= THRESHOLD.SAVE)    return 'save';
  if (score >= THRESHOLD.OBSERVE) return 'observe';
  return 'reject';
}

// ─── MAIN ENTRY POINT ─────────────────────────────────────
// candidate: { original, correction, source }
// evidence:  { resultsBefore, resultsAfter, clicked, repeated, phoneticAgreement }
//
// returns structured telemetry:
// {
//   decision:  'save' | 'observe' | 'reject'
//   score:     0.0 - 1.0
//   signals:   [{ name, value, note }]
//   rejection: string | null
//   candidate: { original, correction, source }
//   timestamp: ISO string
// }

function validateCorrection(candidate, evidence = {}) {
  const { original, correction, source } = candidate;

  // stage 1: validate candidate
  const validation = validateCandidate(candidate);
  if (!validation.valid) {
    return {
      decision:  'reject',
      score:     0,
      signals:   [],
      rejection: validation.reason,
      candidate,
      timestamp: new Date().toISOString()
    };
  }

  // manual: skip scoring
  if (source === 'manual') {
    return {
      decision:  'save',
      score:     1.0,
      signals:   [{ name: 'manual', value: 1.0, note: 'always trusted' }],
      rejection: null,
      candidate,
      timestamp: new Date().toISOString()
    };
  }

  // stage 2: score evidence
  const { score, signals } = scoreEvidence(source, evidence);

  // stage 3: make decision
  const decision = makeDecision(score);

  return {
    decision,
    score,
    signals,
    rejection: decision === 'reject' ? `score ${score} below threshold` : null,
    candidate,
    timestamp: new Date().toISOString()
  };
}

// ─── CONVENIENCE ──────────────────────────────────────────
function shouldSave(candidate, evidence = {}) {
  return validateCorrection(candidate, evidence).decision === 'save';
}

module.exports = {
  validateCorrection,
  validateCandidate,
  scoreEvidence,
  makeDecision,
  shouldSave,
  SOURCE_TRUST,
  THRESHOLD,
  SCORE,
};
