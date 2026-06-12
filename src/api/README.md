# src/api/

Express route handlers — one file per endpoint group.

## Files

| File           | Endpoints                          |
|---------------|-------------------------------------|
| search.js      | POST /api/search                   |
| suggest.js     | GET  /api/suggest                  |
| navigate.js    | POST /api/navigate                 |
| behaviour.js   | POST /api/behaviour/click          |
|                | GET  /api/behaviour/stats          |
|                | POST /api/behaviour/build          |
| health.js      | GET  /api/health                   |

## Notes
- All routes validate x-api-key header ✅
- All routes pass clientId + clientScope to pipeline ✅
- Error handling is centralised in src/utils/errors.js ✅
