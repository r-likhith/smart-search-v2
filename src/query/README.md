# src/query/

The search pipeline — the brain of Smart Search v2.

## Files

| File            | Purpose                                    |
|----------------|---------------------------------------------|
| queryRunner.js  | Main search + suggest + navigate pipeline   |
| intentParser.js | Extracts filters from natural language      |
| normalise.js    | Text normalisation (lowercase, dedupe etc)  |

## Search pipeline (queryRunner.js)
Step 1: Normalise query
Step 2: learnedMap lookup
Step 3: Meilisearch search
Step 4: Validate correction (penalise if worse)
Step 5: Zero results → SymSpell → Phonetic → Fallback
Step 6: Weak results → learnedMap → SymSpell → Phonetic
Step 7: Good results → Intent filters → Cosmetic correction

## Suggest pipeline (runSuggest)
S0: Meilisearch direct
S1: learnedMap correction
S2: SymSpell correction
S3: suggestMap prefix completion
S4: Phonetic correction
S5: Return best available

## Intent parser (intentParser.js)

Extracts structured filters from free text:
- "red kurta under 500" → { color: Red, maxPrice: 500 }
- "mens jacket"         → { category: Men }
- "dress 11 years"      → { sizeGroup: 11-12 Yrs }
