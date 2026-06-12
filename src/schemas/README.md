# src/schemas/

Response formatters — shape the API output.

## Files

| File              | Purpose                                  |
|------------------|-------------------------------------------|
| searchSchema.js   | Formats search API response              |
| suggestSchema.js  | Formats suggest API response             |

## searchSchema.js

Transforms queryRunner output into API response:

```javascript
{
  success: true,
  query: { original, normalised, corrected },
  correction: { applied, mode, source, confidence },
  meta: { totalHits, processingTime, isFallback },
  pagination: { page, limit, totalPages },
  results: [...products],
  ui: { showBanner, correctionMode, allowSearchInstead }
}
```

## suggestSchema.js

Transforms suggest output into API response:

```javascript
{
  query, correctedQuery, wasCorrected,
  suggestions: [...],
  products: [...],
  categories: [...]
}
```
