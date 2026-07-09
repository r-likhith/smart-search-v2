# Search Quality — Design Decisions

## Decision: Keep `description` searchable

**Date:** 2026-07-09
**Client:** 198 (Poojara Telecom — Electronics)

**Decision:** Keep `description` in searchable attributes.

**Reason:**
Electronics customers frequently search for feature-based terms
that appear only in product descriptions, not in product names:
- wireless charging → 65 hits (description only)
- HDR → 42 hits (description only)
- USB-C → 228 hits (description only)
- fast charging → 458 hits (description only)
- Bluetooth 5.3 → 446 hits (description only)

Removing description would break all of these searches.

**Known limitation:**
Certain unrelated terms (e.g. "saree") may produce a small
number of description-based false positives (currently 2 hits).
These are not fashion products — they are electronics with
"Screen" in their description matching "saree" via tokenization.

**Accepted tradeoff:**
2 false positives < breaking 5+ legitimate search types.

**Revisit when:**
Real production search logs show "saree" or similar terms
appearing frequently enough to justify a more targeted solution
such as description field weight reduction or post-search
re-ranking.

**Long-term direction:**
Description matches should rank LOWER than name/category matches.
This is a ranking problem, not a searchable-fields problem.
Meilisearch doesn't support field-level boosting today.
When it does — or when we add re-ranking — revisit this.

---

## Decision: Remove popular products fallback

**Date:** 2026-07-09

**Decision:** Return empty results instead of popular products
when no results found.

**Reason:**
Izoleap's frontend handles "no results" in their own UI.
Our fallback was interfering with their expected behavior.
Returning empty results lets their frontend show their
own "no products found" experience.

**Impact:**
All 8 clients now return [] and totalHits:0 on zero results.
isFallback: false always.

---

## Decision: Edit distance gate for SymSpell suggest (S2)

**Date:** 2026-07-09

**Decision:** Gate SymSpell corrections in suggest pipeline
by maximum edit distance per word length:
- length ≤ 4 → 0 edits (no correction)
- length 5-7 → 1 edit max
- length 8+  → 2 edits max

**Reason:**
"smrte" (5 chars) was being corrected to "saree" (edit dist 2)
which caused grocery client 137 to show fashion categories.
Gate rejects "saree" (dist 2 > max 1) and phonetic correctly
finds "smart" instead.

**Known limitation:**
Short 4-char typos like "bred" → "bread" are not corrected.
Accepted because relaxing the gate creates more false positives
(milk→silk, rice→nice, soap→sofa).
Add "bred"→"bread" to learnedMap if logs justify it.

**Revisit when:**
30 days of real traffic logs show specific short-word typos
that appear frequently with zero results.
