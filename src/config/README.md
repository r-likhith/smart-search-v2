# src/config/

Application configuration.

## Files

| File       | Purpose                              |
|-----------|---------------------------------------|
| index.js   | Centralised config from env variables |

## Environment variables

All config is driven by .env file.
See .env.example for all available options.

Key configs:
- PORT          → server port (default 3000)
- MEILI_HOST    → Meilisearch URL
- MEILI_MASTER_KEY → Meilisearch auth key
- API_KEY       → Search API authentication
- GROQ_API_KEY  → Offline learner AI key
- ENABLE_DELTA_SYNC → Enable ES sync
