# Search Quality — Design Decisions & Known Tradeoffs

This document records architectural decisions, accepted tradeoffs,
and their rationale. Test results belong in benchmark scripts,
not here. Cross-client isolation is verified by the benchmark suite.

---

## Decision: Keep `description` searchable

**Date:** 2026-07-09

**Decision:** Keep `description` in searchable attributes
for all client indexes.

**Reason:**
Electronics customers frequently search for feature-based terms
that appear only in product descriptions, not product names:
- "wireless charging", "fast charging"
- "HDR", "AMOLED"
- "USB-C", "Bluetooth 5.3"
- "Dolby Atmos"

Removing description would break all feature-oriented searches.
The recall loss outweighs the precision gain.

**Known limitation:**
Certain unrelated terms may match electronics products through
description tokenization (e.g. a term similar to "Screen" in
product descriptions). This is description-based semantic noise,
not cross-client contamination.

**Decision:** Accepted tradeoff.

**Revisit when:**
Real production logs demonstrate that specific queries produce
frequent zero-engagement results (searched but nothing clicked).
At that point, consider field-level weight separation or
post-search re-ranking rather than removing description entirely.

**Long-term direction:**
Description matches should rank lower than name/category matches.
This is a ranking problem. Meilisearch does not support field-level
boosting today. Revisit when it does, or when re-ranking is added.

---

## Decision: Remove popular products fallback

**Date:** 2026-07-09

**Decision:** Return empty results (totalHits:0, results:[])
when no products match. isFallback is always false.

**Reason:**
Izoleap's frontend handles "no results" in their own UI.
Our fallback was interfering with their expected behavior.
Client handles the no-results experience, not the search API.

---

## Decision: Edit distance gate for SymSpell suggest (S2)

**Date:** 2026-07-09

**Decision:** Gate SymSpell corrections in the suggest pipeline
by maximum allowed edit distance per query word length:
- length ≤ 4 → 0 edits (no correction allowed)
- length 5-7 → 1 edit max
- length 8+  → 2 edits max

Applied to the maximum edit distance across ALL changed words
in a multi-word correction.

**Reason:**
Short words corrected aggressively cause cross-category noise
in suggest results. The gate ensures only plausible corrections
reach Meilisearch.

**Known limitation:**
Ambiguous 4-character words (e.g. "bred" → "bread") are not
auto-corrected. This is intentional. Short words are high-risk
for false corrections (milk→silk, rice→nice, soap→sofa).

**Revisit when:**
Production logs show specific short-word queries appearing
frequently with zero results. At that point, add known
corrections to learnedMap rather than relaxing the gate globally.

---

## Cross-client isolation

Cross-client isolation is verified by the benchmark suite.
Each client index is fully isolated — products from one client
never appear in another client's search results.

The distinction between contamination and noise:
- **Contamination** = wrong catalog returned (architecture bug)
- **Noise** = weak description match within correct catalog (ranking)

Cross-client contamination: none observed ✅
Description-based noise: minor, documented, accepted ✅

---

## Benchmark suite
scripts/searchQualityBenchmark.js  — full pipeline quality
benchmarks/client_198.json         — electronics catalog tests
benchmarks/client_137.json         — grocery catalog tests
benchmarks/SEARCH_QUALITY_README.md — how to run benchmarks

Run before and after any search settings change:
```bash
node scripts/searchQualityBenchmark.js 198 --save before
# make change
node scripts/searchQualityBenchmark.js 198 --save after
```
