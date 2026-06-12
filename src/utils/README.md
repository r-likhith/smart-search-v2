# src/utils/

Shared utility modules used across the codebase.

## Files

| File         | Purpose                                      |
|-------------|-----------------------------------------------|
| logger.js    | Per-client query logging to multiTenantLogs  |
| errors.js    | Centralised error handling + response format |
| response.js  | Standard API response builder                |

## logger.js

Logs every search query with:
- clientId, query, correction, results count ✅
- correctionMode, correctionSource ✅
- intentFilters if applied ✅
- Written to multiTenantLogs/client_X/queries.log ✅

## errors.js

Handles:
- Invalid API key → 401 ✅
- Missing required fields → 400 ✅
- Meilisearch errors → 503 ✅
- Unknown errors → 500 ✅

## response.js

Standard response wrapper:
```javascript
{
  success: true/false,
  requestId: "uuid",
  timestamp: "ISO date",
  data: { ... }
}
```
