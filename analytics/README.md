# analytics/

Search event logging, aggregation, and dashboard.

## Files

| File               | Purpose                                    |
|-------------------|---------------------------------------------|
| logger.js          | Logs every search event to file            |
| productsLogger.js  | Logs product view events                   |
| aggregator.js      | Reads logs and computes analytics          |
| dashboard.html     | Analytics UI at /analytics                 |

## Log locations
logs/analytics.log          → global search events
logs/queries.log            → global query log
multiTenantLogs/
client_198/
analytics.log           → per-client search events
queries.log             → per-client query log
products.log            → per-client product views

## Dashboard

Open: http://localhost:3000/analytics

Shows:
- Zero result queries ✅
- Correction success rates ✅
- LearnedMap lifecycle ✅
- Source performance ✅
- Cross-client risks ✅
- Groq candidates ✅
