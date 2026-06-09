// offlineLearner/groqClient.js
// calls Groq API for correction candidates ✅
// primary model for offline learner ✅
// not latency sensitive — nightly job ✅

const Groq = require('groq-sdk');
const { normalise } = require('../src/query/normalise');
const { GROQ, SYSTEM_PROMPT } = require('./config');

// ─── HALLUCINATION PATTERNS ───────────────────────────────
// same patterns as src/ollama/corrector.js ✅
// reject bad model output ✅

const HALLUCINATION_PATTERNS = [
  'input unchanged',
  'no correction',
  'no change',
  'unchanged',
  'same as input',
  'already correct',
  'cannot correct',
  'i cannot',
  'sorry',
  'n/a',
  'none',
  'null',
  'undefined',
  'fix typos',
  'spell check',
  'the correct',
  'corrected version',
  'correction is'
];

// ─── INIT CLIENT ──────────────────────────────────────────

let groqClient = null;

function getClient() {
  if (!groqClient) {
    groqClient = new Groq({ apiKey: GROQ.apiKey });
  }
  return groqClient;
}

// ─── VALIDATE OUTPUT ──────────────────────────────────────

function isValidCorrection(input, output) {
  if (!output)                          return false;
  if (output.length < 2)                return false;
  if (output.length > 100)              return false;
  if (output.includes('\n'))            return false;
  if (output === input)                 return false;
  if (/^\d+$/.test(output))            return false;

  // reject invalid characters ✅
  if (!/^[a-z0-9\s\-]+$/.test(output)) return false;

  // reject hallucinations ✅
  for (const pattern of HALLUCINATION_PATTERNS) {
    if (output.includes(pattern)) {
      console.log(`[GroqClient] Hallucination filtered: "${output}"`);
      return false;
    }
  }

  // single word: ratio check ✅
  // prevents "penceel" → "pen"
  const inputWords  = input.split(/\s+/).filter(Boolean);
  const outputWords = output.split(/\s+/).filter(Boolean);

  if (inputWords.length === 1 && outputWords.length === 1) {
    const ratio = output.length / input.length;
    if (ratio < 0.6) {
      console.log(`[GroqClient] Too short ratio (${ratio.toFixed(2)}) — skipped: "${input}" → "${output}"`);
      return false;
    }
  }

  // word count drop check ✅
  // prevents "mik bowl" → "microwave"
  if (inputWords.length > 1 && outputWords.length < inputWords.length - 1) {
    console.log(`[GroqClient] Word count dropped — skipped: "${input}" → "${output}"`);
    return false;
  }

  // word expansion check ✅
  // prevents "s23" → "samsung galaxy s23 ultra"
  const expansionRatio = outputWords.length / inputWords.length;
  if (expansionRatio > 2.5) {
    console.log(`[GroqClient] Too much expansion — skipped: "${input}" → "${output}"`);
    return false;
  }

  return true;
}

// ─── CALL GROQ ────────────────────────────────────────────

async function getCorrection(query) {
  try {
    const normalised = normalise(query);
    if (!normalised) return null;

    // reject gibberish ✅
    if (/^(.)\1+$/.test(normalised)) {
      console.log(`[GroqClient] Gibberish — skipped: "${normalised}"`);
      return null;
    }

    console.log(`[GroqClient] Asking Groq: "${normalised}"`);

    const client = getClient();

    const response = await client.chat.completions.create({
      model:       GROQ.model,
      max_tokens:  GROQ.maxTokens,
      temperature: GROQ.temperature,
      messages: [
        {
          role:    'system',
          content: SYSTEM_PROMPT
        },
        {
          role:    'user',
          content: `Fix typos: ${normalised}`
        }
      ]
    });

    const raw = response.choices?.[0]?.message?.content;
    if (!raw) return null;

    const correction = normalise(raw.trim().toLowerCase());
    if (!correction) return null;

    if (!isValidCorrection(normalised, correction)) {
      console.log(`[GroqClient] Invalid correction — skipped: "${normalised}" → "${correction}"`);
      return null;
    }

    console.log(`[GroqClient] ✅ "${normalised}" → "${correction}"`);
    return correction;

  } catch (err) {
    console.error(`[GroqClient] Error for "${query}": ${err.message}`);
    return null;
  }
}

// ─── BATCH CORRECTIONS ────────────────────────────────────
// processes queries one at a time ✅
// nightly job — no rush ✅
// avoids rate limits ✅
// delay between calls ✅

async function batchCorrections(queries, delayMs = 500) {
  const results = [];

  for (let i = 0; i < queries.length; i++) {
    const { query, count, clients, scopeHint } = queries[i];

    console.log(`\n[GroqClient] Processing ${i + 1}/${queries.length}: "${query}"`);

    const correction = await getCorrection(query);

    results.push({
      query,
      count,
      clients,
      scopeHint,
      correction,       // null if no valid correction ✅
      groqCalled: true
    });

    // delay between calls ✅
    // avoids rate limits ✅
    if (i < queries.length - 1) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  const found    = results.filter(r => r.correction !== null).length;
  const skipped  = results.filter(r => r.correction === null).length;

  console.log(`\n[GroqClient] Done: ${found} corrections found, ${skipped} skipped`);

  return results;
}

module.exports = { getCorrection, batchCorrections };