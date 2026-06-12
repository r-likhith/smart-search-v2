# src/searchBanners/

Feature flags for search correction UI behaviour.

## Files

| File         | Purpose                                    |
|-------------|---------------------------------------------|
| features.js  | Toggle search correction display features  |

## Feature flags

| Flag                  | Default | Effect                              |
|----------------------|---------|--------------------------------------|
| retrievalCorrection   | true    | Apply corrections to search query   |
| cosmeticCorrection    | true    | Show correction in UI only          |
| correctionBanner      | true    | Show "Showing results for X" banner |
| searchInsteadLink     | true    | Show "Search instead for Y" link    |
| silentInputCorrection | false   | Silently rewrite input field        |

## Correction modes
full      → correction applied to retrieval ✅

shows banner + search instead link ✅
assisted  → good results found with original ✅

shows cosmetic suggestion only ✅
none      → no correction ✅

## Toggling flags

Edit src/searchBanners/features.js or set via .env:
RETRIEVAL_CORRECTION=true

COSMETIC_CORRECTION=true

CORRECTION_BANNER=true

SEARCH_INSTEAD_LINK=true

SILENT_CORRECTION=false
