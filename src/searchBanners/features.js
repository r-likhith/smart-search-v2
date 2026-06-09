// src/searchBanners/features.js
// Feature flags for search correction UX
// All flags driven by .env — no code changes needed ✅
//
// RETRIEVAL_CORRECTION (always true):
//   core pipeline — learnedMap + symspell + phonetic
//   NEVER disable — breaks search quality ✅
//
// COSMETIC_CORRECTION:
//   show correction banner even when
//   Meilisearch fuzzy handled results ✅
//   "nokea phone" → banner shows "nokia phone" ✅
//
// CORRECTION_BANNER:
//   "Showing results for nokia phone" ✅
//   transparent correction to user ✅
//
// SEARCH_INSTEAD_LINK:
//   "Search instead for nokea phone" ✅
//   lets user revert correction ✅
//
// SILENT_CORRECTION:
//   silently rewrites search bar text ✅
//   "nokea" becomes "nokia" in input bar ✅
//   proto/test mode only ⚠️
//   users may find unexpected ⚠️
//   test carefully before enabling ✅

module.exports = {

  // ── core pipeline ──────────────────────────────────
  // never disable ✅
  retrievalCorrection: process.env.RETRIEVAL_CORRECTION !== 'false',

  // ── display layer ──────────────────────────────────
  // safe to toggle ✅
  cosmeticCorrection:  process.env.COSMETIC_CORRECTION  !== 'false',
  correctionBanner:    process.env.CORRECTION_BANNER    !== 'false',
  searchInsteadLink:   process.env.SEARCH_INSTEAD_LINK  !== 'false',

  // ── proto/test only ────────────────────────────────
  // silently rewrites input bar ✅
  // disable until tested with real users ✅
  silentInputCorrection: process.env.SILENT_CORRECTION  === 'true',

};
