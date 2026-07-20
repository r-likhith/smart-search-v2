// ─── DEDUPLICATE CATEGORIES ───────────────────────────────
// Single source of truth for category deduplication ✅
// Used by: searcher.js + mastercheckup.js ✅
// Rule: catalogue (L1) preferred over category (L2) ✅
// because catalogue always appears first in input array ✅

/**
 * Removes duplicate category suggestions by display value.
 *
 * Assumes catalogue (L1) suggestions appear before category (L2)
 * in the input array, so the first occurrence (catalogue) is retained.
 * Normalization: trim + lowercase to handle whitespace/case differences.
 *
 * @param {Array} categorySuggestions - mixed catalogue/category/brand items
 * @returns {Array} deduplicated suggestions
 */
function deduplicateCategories(categorySuggestions) {
  const seen = new Set();
  return categorySuggestions.filter(item => {
    const key = String(item.value ?? '').trim().toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = { deduplicateCategories };
