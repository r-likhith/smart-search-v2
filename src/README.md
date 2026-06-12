# src/

Core source code for Smart Search v2.

## Structure
src/
api/          → Express route handlers
query/        → Search pipeline (main logic)
learned/      → LearnedMap + SuggestMap modules
spellcheck/   → SymSpell + Phonetic correction
meilisearch/  → Meilisearch client + searcher
schemas/      → Response formatters
searchBanners/→ Feature flags
behaviour/    → Click tracking + build state
ollama/       → Ollama AI client (legacy)
config/       → App configuration
utils/        → Shared utilities

## Key flow
API request
→ src/api/search.js
→ src/query/queryRunner.js   ← main pipeline
→ src/learned/learnedMap.js  ← correction lookup
→ src/spellcheck/symspell.js ← spelling fix
→ src/spellcheck/phonetic.js ← sound-alike fix
→ src/meilisearch/searcher.js← search execution
→ src/schemas/searchSchema.js← response format
