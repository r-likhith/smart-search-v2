const { normalise } = require('../query/normalise');
const { saveCorrection, applyCorrection } = require('../learned/learnedMap');
const { getLearnableCorrections, getClickStats } = require('./tracker');
const { onBuildComplete, getBuildState } = require('./buildState');

// ─── CONFIG ───────────────────────────────────────────────
const MIN_CLICKS_TO_LEARN = 5;
const DOMINANCE_THRESHOLD = 0.6;

// ── SAFETY RULES ──────────────────────────────────────────
// Rule 1+2: only learn from failed/weak queries ✅
// clicks on successful queries = preference, not correction ✅
// "watch" 104 results → preference signal ❌ don't learn
// "ear ringzz" 0 results → correction signal ✅ learn
const MAX_RESULTS_TO_LEARN = 5;

// Rule 4: clean single words are preferences not typos ✅
// "watch", "phone", "ac" → preference signals ❌
// "ear ringzz", "labtop", "iphonne" → typo corrections ✅
// regex: 2-10 lowercase letters only, no spaces, no digits
const CLEAN_SINGLE_WORD = /^[a-z]{2,10}$/;

// global build lock
let isBuilding = false;

// ─── SAFE BUILD TRIGGER ───────────────────────────────────

async function triggerBuildSafe() {
  if (isBuilding) {
    console.log('[Builder] Already running — skipped');
    return { built: 0, skipped: 0, reason: 'already running' };
  }

  isBuilding = true;

  try {
    const result = await buildCorrections();
    return result;
  } finally {
    isBuilding = false;
  }
}

// ─── BUILD CORRECTIONS ────────────────────────────────────

async function buildCorrections() {
  try {
    console.log('\n--- Builder Started ---\n');

    const corrections = getLearnableCorrections();

    if (corrections.length === 0) {
      console.log('No learnable corrections found yet.');
      console.log(`Need ${MIN_CLICKS_TO_LEARN} clicks with ${DOMINANCE_THRESHOLD * 100}% dominance\n`);

      // don't reset state — preserve click signal for next attempt
      return { built: 0, skipped: 0 };
    }

    console.log(`Found ${corrections.length} candidates:\n`);

    let built = 0;
    let skipped = 0;

    for (const item of corrections) {
      const {
        query,
        correction,
        count,
        dominance,
        category,
        subcategory,
        originalResultCount,
        uniqueCategories
      } = item;

      // ── double enforce min clicks ──────────────────────
      if (count < MIN_CLICKS_TO_LEARN) {
        console.log(`[Skip] "${query}" — not enough clicks (${count})`);
        skipped++;
        continue;
      }

      // ── dominance filter ──────────────────────────────
      if (dominance < DOMINANCE_THRESHOLD) {
        console.log(`[Skip] "${query}" → "${correction}" low dominance (${dominance})`);
        skipped++;
        continue;
      }

      if (!query || !correction) {
        skipped++;
        continue;
      }

      // ── Rule 1+2: skip successful queries ─────────────
      // if query already returned good results → it's a
      // preference signal, not a correction ✅
      // only learn from failed/weak queries ✅
      if (originalResultCount !== undefined && originalResultCount > MAX_RESULTS_TO_LEARN) {
        console.log(`[Skip] "${query}" — had ${originalResultCount} results (preference not correction)`);
        skipped++;
        continue;
      }

      // ── Rule 3: skip ambiguous multi-category clicks ──
      // user clicked across multiple categories → ambiguous
      // intent → unsafe to learn ✅
      if (uniqueCategories !== undefined && uniqueCategories > 1) {
        console.log(`[Skip] "${query}" — clicks across ${uniqueCategories} categories (ambiguous intent)`);
        skipped++;
        continue;
      }

      // ── Rule 4: skip clean single words ───────────────
      // "watch", "phone", "ac" → these are preferences ✅
      // "ear ringzz", "labtop" → these are typos ✅
      // clean single words with no special chars =
      // likely preference not correction ✅
      if (CLEAN_SINGLE_WORD.test(query.trim())) {
        console.log(`[Skip] "${query}" — clean single word (preference not typo)`);
        skipped++;
        continue;
      }

      if (normalise(query) === normalise(correction)) {
        console.log(`[Skip] "${query}" → "${correction}" same word`);
        skipped++;
        continue;
      }

      if (correction.length < 3) {
        console.log(`[Skip] "${query}" → "${correction}" too short`);
        skipped++;
        continue;
      }

      // ── use subcategory → category → correction keyword
      const finalCorrection = normalise(
        subcategory || category || correction
      );

      if (!finalCorrection) {
        console.log(`[Skip] "${query}" — no valid correction keyword`);
        skipped++;
        continue;
      }

      // ── prevent circular loops ────────────────────────
      if (
        normalise(finalCorrection).includes(normalise(query)) ||
        normalise(query).includes(normalise(finalCorrection))
      ) {
        console.log(`[Skip] "${query}" → "${finalCorrection}" circular loop risk`);
        skipped++;
        continue;
      }

      // ── skip if already learned correctly ─────────────
      const existing = applyCorrection(query);
      if (existing.corrected && existing.query === finalCorrection) {
        console.log(`[Skip] "${query}" → "${finalCorrection}" already learned`);
        skipped++;
        continue;
      }

      console.log(`[Build] "${query}" → "${finalCorrection}"`);
      console.log(`        clicks: ${count}, dominance: ${dominance}`);
      console.log(`        category: ${category || 'unknown'}`);
      console.log(`        originalResults: ${originalResultCount ?? 'unknown'}`);

      // weight confidence by dominance ✅
      // strong patterns (dominance 1.0) learn faster ✅
      const dominanceWeight = Math.min(0.25, dominance * 0.15);

      try {
        saveCorrection(
          query,
          finalCorrection,
          'click',
          count,
          dominanceWeight
        );
        built++;
        console.log(`        ✅ saved (weight: ${dominanceWeight.toFixed(3)})\n`);
      } catch (err) {
        console.error(`        ❌ failed: ${err.message}\n`);
        skipped++;
      }
    }

    // only reset state when something was actually built ✅
    // preserves click signal when everything was skipped ✅
    if (built > 0) {
      onBuildComplete();
    }

    const stats = getClickStats();
    console.log('--- Builder Complete ---');
    console.log(`✅ Built:          ${built}`);
    console.log(`⏭️  Skipped:        ${skipped}`);
    console.log(`📊 Total clicks:   ${stats.totalRawClicks}`);
    console.log(`🔍 Unique queries: ${stats.uniqueQueries}`);
    console.log('------------------------\n');

    return { built, skipped };

  } catch (err) {
    console.error('Builder failed:', err.message);
    // never update state on failure ✅
    return { built: 0, skipped: 0, error: err.message };
  }
}

// ─── SHOW PENDING ─────────────────────────────────────────

function showPending() {
  const corrections = getLearnableCorrections();
  const buildState = getBuildState();

  if (corrections.length === 0) {
    console.log(`\nNo pending corrections yet.`);
    console.log(`Need ${MIN_CLICKS_TO_LEARN} clicks with ${DOMINANCE_THRESHOLD * 100}% dominance\n`);
    return [];
  }

  console.log(`\n--- Pending Corrections (${corrections.length}) ---`);
  console.log(`Build state: ${buildState.nextBuildAt}\n`);

  corrections.forEach(item => {
    const finalCorrection = item.subcategory || item.category || item.correction;
    console.log(`"${item.query}" → "${finalCorrection}"`);
    console.log(`  clicks: ${item.count}, dominance: ${item.dominance}`);
    console.log(`  originalResults: ${item.originalResultCount ?? 'unknown'}`);
    console.log(`  uniqueCategories: ${item.uniqueCategories ?? 'unknown'}`);
    console.log('');
  });

  return corrections;
}

module.exports = {
  triggerBuildSafe,
  buildCorrections,
  showPending
};














// const { normalise } = require('../query/normalise');
// const { saveCorrection, applyCorrection } = require('../learned/learnedMap');
// const { getLearnableCorrections, getClickStats } = require('./tracker');

// // ─── CONFIG ───────────────────────────────────────────────
// const MIN_CLICKS_TO_LEARN = 5;
// const DOMINANCE_THRESHOLD = 0.6;

// // ─── BUILD CORRECTIONS ────────────────────────────────────

// async function buildCorrections() {
//   try {
//     console.log('\n--- Builder Started ---\n');

//     const corrections = getLearnableCorrections();

//     if (corrections.length === 0) {
//       console.log('No learnable corrections found yet.');
//       console.log(`Need ${MIN_CLICKS_TO_LEARN} clicks with ${DOMINANCE_THRESHOLD * 100}% dominance\n`);
//       return { built: 0, skipped: 0 };
//     }

//     console.log(`Found ${corrections.length} candidates:\n`);

//     let built = 0;
//     let skipped = 0;

//     for (const item of corrections) {
//       const {
//         query,
//         correction,
//         count,
//         dominance,
//         category,
//         subcategory
//       } = item;

//       // Fix 7 — double enforce min clicks
//       if (count < MIN_CLICKS_TO_LEARN) {
//         console.log(`[Skip] "${query}" — not enough clicks (${count})`);
//         skipped++;
//         continue;
//       }

//       // Fix 1 — dominance filter
//       if (dominance < DOMINANCE_THRESHOLD) {
//         console.log(`[Skip] "${query}" → "${correction}" low dominance (${dominance})`);
//         skipped++;
//         continue;
//       }

//       // basic safety checks
//       if (!query || !correction) {
//         skipped++;
//         continue;
//       }

//       if (normalise(query) === normalise(correction)) {
//         console.log(`[Skip] "${query}" → "${correction}" same word`);
//         skipped++;
//         continue;
//       }

//       if (correction.length < 3) {
//         console.log(`[Skip] "${query}" → "${correction}" too short`);
//         skipped++;
//         continue;
//       }

//       // Fix 3 — use subcategory → category → correction keyword
//       const finalCorrection = normalise(
//         subcategory || category || correction
//       );

//       if (!finalCorrection) {
//         console.log(`[Skip] "${query}" — no valid correction keyword`);
//         skipped++;
//         continue;
//       }

//       // Fix 4 — skip if already learned
//       const existing = applyCorrection(query);
//       if (existing.corrected && existing.query === finalCorrection) {
//         console.log(`[Skip] "${query}" → "${finalCorrection}" already learned`);
//         skipped++;
//         continue;
//       }

//       console.log(`[Build] "${query}" → "${finalCorrection}"`);
//       console.log(`        clicks: ${count}, dominance: ${dominance}`);
//       console.log(`        category: ${category || 'unknown'}, subcategory: ${subcategory || 'unknown'}`);

//       // Fix 2 — use 'click' source, not fake result count
//       try {
//         saveCorrection(
//           query,
//           finalCorrection,
//           'click',
//           count // pass real click count
//         );
//         built++;
//         console.log(`        ✅ saved\n`);
//       } catch (err) {
//         console.error(`        ❌ failed: ${err.message}\n`);
//         skipped++;
//       }
//     }

//     const stats = getClickStats();
//     console.log('--- Builder Complete ---');
//     console.log(`✅ Built:          ${built}`);
//     console.log(`⏭️  Skipped:        ${skipped}`);
//     console.log(`📊 Total clicks:   ${stats.totalRawClicks}`);
//     console.log(`🔍 Unique queries: ${stats.uniqueQueries}`);
//     console.log('------------------------\n');

//     return { built, skipped };

//   } catch (err) {
//     console.error('Builder failed:', err.message);
//     return { built: 0, skipped: 0 };
//   }
// }

// // ─── SHOW PENDING ─────────────────────────────────────────

// function showPending() {
//   const corrections = getLearnableCorrections();

//   if (corrections.length === 0) {
//     console.log(`\nNo pending corrections yet.`);
//     console.log(`Need ${MIN_CLICKS_TO_LEARN} clicks with ${DOMINANCE_THRESHOLD * 100}% dominance\n`);
//     return [];
//   }

//   console.log(`\n--- Pending Corrections (${corrections.length}) ---\n`);
//   corrections.forEach(item => {
//     const finalCorrection = item.subcategory || item.category || item.correction;
//     console.log(`"${item.query}" → "${finalCorrection}"`);
//     console.log(`  clicks: ${item.count}, dominance: ${item.dominance}`);
//     console.log(`  category: ${item.category || 'unknown'}`);
//     console.log('');
//   });

//   return corrections;
// }

// module.exports = {
//   buildCorrections,
//   showPending
// };