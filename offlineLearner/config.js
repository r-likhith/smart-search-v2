require('dotenv').config();
const path = require('path');

// ─── GROQ CONFIG ──────────────────────────────────────────

const GROQ = {
  apiKey: process.env.GROQ_API_KEY,
  model:  'llama-3.3-70b-versatile',
  // nightly job — not latency sensitive ✅
  // higher timeout than live search ✅
  timeoutMs:  30000,
  maxTokens:  50,      // correction = short ✅
  temperature: 0.1     // low = more deterministic ✅
};

// ─── THRESHOLDS ───────────────────────────────────────────

const THRESHOLDS = {
  // minimum times a query must fail
  // before we try to learn it ✅
  minFailCount:        2,

  // minimum products correction
  // must return to be accepted ✅
  minResultsToAccept:  5,

  // minimum improvement over original ✅
  minImprovement:      3,

  // confidence assigned to groq corrections ✅
  // lower than manual (0.95) ✅
  // lower than symspell (0.85) ✅
  // starts as candidate ✅
  groqConfidence:      0.75,

  // max queries to process per run ✅
  // prevents runaway costs ✅
  maxQueriesPerRun:    100
};

// ─── CORRECTION LIFECYCLE ─────────────────────────────────
// candidate → trusted → proven ✅
// disabled → deleted ✅

const STATUS = {
  CANDIDATE: 'candidate',  // groq suggested + validated ✅
  TRUSTED:   'trusted',    // hitCount >= 5 ✅
  PROVEN:    'proven',     // hitCount >= 50 ✅
  DISABLED:  'disabled',   // failures >= 3 ✅
  DELETED:   'deleted'     // removed from map ✅
};

const PROMOTION = {
  toTrusted: 5,    // hitCount needed ✅
  toProven:  50    // hitCount needed ✅
};

// ─── CLIENT SCOPE MAPPING ─────────────────────────────────
// maps clientId → domain ✅
// used to derive correction scope ✅
// domain persists even if clients change ✅

const CLIENT_SCOPE = {
  '135': 'sports',
  '137': 'grocery',
  '198': 'electronics',
  '210': 'electronics',
  '226': 'fashion',
  '237': 'fashion',
  '246': 'fashion',
  '247': 'general'
};

// ─── PATHS ────────────────────────────────────────────────

const PATHS = {
  // multi-tenant logs — read zero-result queries ✅
  multiTenantLogs: path.join(__dirname, '../multiTenantLogs'),

  // global analytics log ✅
  analyticsLog:    path.join(__dirname, '../logs/analytics.log'),

  // learnedMap files ✅
  learnedMap:      path.join(__dirname, '../learned/learnedMap.json'),
  reverseIndex:    path.join(__dirname, '../learned/reverseIndex.json'),

  // reports saved here ✅
  reportsDir:      path.join(__dirname, '../logs')
};

// ─── MEILISEARCH ──────────────────────────────────────────

const MEILISEARCH = {
  host:   process.env.MEILI_HOST        || 'http://localhost:7700',
  apiKey: process.env.MEILI_MASTER_KEY  || 'searchapikey123',
  // index pattern per client ✅
  // client_198_products etc ✅
  indexPattern: (clientId) => `client_${clientId}_products`
};

// ─── SYSTEM PROMPT ────────────────────────────────────────
// same context as Ollama client ✅
// Indian ecommerce aware ✅
// strict output rules ✅

const SYSTEM_PROMPT = `You are a spell checker for an Indian ecommerce search engine.
The store sells: clothing, footwear, electronics, mobiles, laptops, appliances,
furniture, home decor, kitchen, groceries, beauty, health, sports, toys, books,
stationery, accessories, bags and jewellery.

Rules:
1. Output ONLY the corrected search term — nothing else
2. Lowercase only, no punctuation, no explanations
3. Fix spelling typos only — do not change the meaning
4. Corrected word must be similar in length to the original
5. Do not shorten words drastically (pencil not pen)
6. If the input has multiple words, keep a similar word count
7. If you cannot correct it, output nothing at all
8. Indian product terms are valid — kurta, kurti, dupatta,
   saree, achaar, dal, chawal are correct spellings`;

// ─── VALIDATE CONFIG ──────────────────────────────────────

function validateConfig() {
  const errors = [];

  if (!GROQ.apiKey) {
    errors.push('GROQ_API_KEY missing from .env ❌');
  }
  if (!process.env.MEILI_HOST) {
    console.warn('⚠️  MEILI_HOST not set — using default localhost:7700');
  }

  if (errors.length > 0) {
    console.error('Config errors:');
    errors.forEach(e => console.error(' ', e));
    process.exit(1);
  }

  console.log('✅ Config loaded');
  console.log(`   Model:     ${GROQ.model}`);
  console.log(`   MaxTokens: ${GROQ.maxTokens}`);
  console.log(`   Temp:      ${GROQ.temperature}`);
  console.log(`   MaxQueries:${THRESHOLDS.maxQueriesPerRun}`);
}

module.exports = {
  GROQ,
  THRESHOLDS,
  STATUS,
  PROMOTION,
  CLIENT_SCOPE,
  PATHS,
  MEILISEARCH,
  SYSTEM_PROMPT,
  validateConfig
};