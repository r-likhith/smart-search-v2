# Search Quality Benchmarks

Historical benchmark results for tracking search quality over time.

---

## What is this?

Every time a significant change is made to search settings
(typo tolerance, searchable attributes, ranking rules etc.),
a before/after benchmark is run and saved here.

This allows us to:
- Prove improvements with evidence ✅
- Catch regressions before they reach production ✅
- Track search quality trends over time ✅

---

## How to run

```bash
# run benchmark for a specific client
node scripts/searchQualityBenchmark.js 198

# run and save as baseline (before a change)
node scripts/searchQualityBenchmark.js 198 --save before

# run after a change and compare with before
node scripts/searchQualityBenchmark.js 198 --save after

# run for a different client
node scripts/searchQualityBenchmark.js 210
node scripts/searchQualityBenchmark.js 137
```

---

## What it measures

### Recall (legitimate typos)
Tests that common typos are correctly fixed:
laptpo    → laptop ✅
samsng    → samsung ✅
iphnoe    → iphone ✅
smratwatch → smartwatch ✅

### Precision (false positives)
Tests that unrelated terms return no real results:
saree  → fallback only (no real matches) ✅
kurti  → fallback only ✅
dupatta → fallback only ✅

### Edge cases
Tests short words and spec searches:
s9    → results (model number) ✅
256gb → results (spec search) ✅

---

## Understanding results
✅ [recall] "laptpo" → "laptop" (symspell) | 244 hits | 76ms
✅ [precision] "saree" (no correction) | 10 hits | 83ms

For precision tests:
- 10 hits with isFallback:true = PASS ✅
  (system correctly shows popular products instead)
- 10 hits with isFallback:false = FAIL ❌
  (system found real matches — wrong)

---

## Adding catalog tests

Create a client-specific test file:

```json
// benchmarks/client_198.json
[
  { "query": "apple watch", "expectedName": "apple watch", "shouldHaveResults": true },
  { "query": "samsung s24", "expectedName": "samsung", "shouldHaveResults": true },
  { "query": "iphone 15",   "expectedName": "iphone",  "shouldHaveResults": true }
]
```

These run automatically when you benchmark that client ✅

---

## File naming convention
YYYY-MM-DD-client_ID-before.json  ← baseline before change
YYYY-MM-DD-client_ID-after.json   ← result after change

---

## Change history

### 2026-07-08 — Typo tolerance fix

**Change:** Increased minWordSizeForTypos from 4/8 to 6/10

**Problem:** Fashion terms (saree, kurti, dupatta) were matching
electronics products via typo tolerance on description field.
"saree" was matching "Screen" in Samsung Tab descriptions.

**Result:**
Recall:    10/10 → 10/10 (unchanged) ✅
Precision: 0/3   → 3/3  (improved) ✅
Latency:   54ms  → 56ms (acceptable) ✅

**Applied to:** All 8 client indexes ✅

---

## Other benchmark files in this folder

### phonetic-TIMESTAMP.txt
Output from `node phoneticBenchmark.js` ✅
Tests phonetic correction quality:
- Top-1 accuracy (does the right word rank first?)
- False positive rate (does it correct correct words?)

Current baseline:
  Top-1 accuracy: 84.1% ✅
  False positive rate: 0% ✅

Run:
```bash
node phoneticBenchmark.js
```

### client_ID.json (future)
Client-specific catalog test cases ✅
Loaded automatically by searchQualityBenchmark.js ✅
