# src/behaviour/

Click tracking and correction building from user behaviour.

## Files

| File           | Purpose                                        |
|---------------|--------------------------------------------------|
| tracker.js     | Records product clicks to clicks.json           |
| builder.js     | Builds corrections from click patterns          |
| buildState.js  | Tracks build state (pending clicks, history)    |

## How it works
User searches "labtop" → clicks laptop product ✅

tracker.js records click ✅

builder.js detects pattern:

query "labtop" → clicked product named "laptop" ✅

→ saves correction to learnedMap ✅

## Endpoints

- POST /api/behaviour/click   → record a click
- GET  /api/behaviour/stats   → click statistics
- POST /api/behaviour/build   → trigger build
- GET  /api/behaviour/pending → pending clicks
- GET  /api/behaviour/buildstate → build history
