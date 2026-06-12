# offlineLearner/

Nightly batch job that learns new corrections from traffic.

## Purpose

Finds zero-result queries from logs, generates corrections
using Groq AI, validates them against inventory, and saves
validated corrections to learnedMap.

## Files

| File                  | Purpose                               |
|----------------------|----------------------------------------|
| index.js              | Entry point — orchestrates the run    |
| config.js             | Thresholds, prompts, client scopes    |
| queryCollector.js     | Reads logs, finds zero-result queries |
| groqClient.js         | Calls Groq API for corrections        |
| validator.js          | Tests corrections against Meilisearch |
| learnedMapWriter.js   | Saves validated corrections           |
| reporter.js           | Prints run summary                    |

## How to run

```bash
# local
node offlineLearner/index.js

# Docker
docker compose exec smart-search node offlineLearner/index.js
```

## When to run

Run nightly (or manually after traffic accumulates).
Requires GROQ_API_KEY in .env ✅

## Pipeline
queryCollector → finds zero-result queries in logs
groqClient     → asks Groq AI to correct each query
validator      → searches Meilisearch with correction
→ accepts if results improve by 20%+ ✅
learnedMapWriter → saves as candidate status
reporter       → prints summary
