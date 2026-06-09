// offlineLearner/index.js
// orchestrates the full offline learning pipeline ✅
// run nightly: node offlineLearner/index.js ✅

const { validateConfig }   = require('./config');
const { collectQueries }   = require('./queryCollector');
const { batchCorrections } = require('./groqClient');
const { validateBatch }    = require('./validator');
const { writeCorrection }  = require('./learnedMapWriter');
const { saveReport }       = require('./reporter');

async function run() {
  console.log('');
  console.log('╔════════════════════════════════════════╗');
  console.log('║       Offline Learner                  ║');
  console.log('╚════════════════════════════════════════╝');
  console.log(`Started: ${new Date().toISOString()}\n`);

  // ── Step 0: validate config ───────────────────────────
  validateConfig();

  // ── Step 1: collect zero-result queries ───────────────
  console.log('\n── Step 1: Collect queries ──────────────');
  const queries = collectQueries();

  if (queries.length === 0) {
    console.log('\nNo queries to process — nothing to learn');
    saveReport({ queriesFound: 0 });
    return;
  }

  // ── Step 2: ask Groq for corrections ──────────────────
  console.log('\n── Step 2: Ask Groq ─────────────────────');
  const groqResults = await batchCorrections(queries);
  const groqFound   = groqResults.filter(r => r.correction).length;

  // ── Step 3: validate against Meilisearch ──────────────
  console.log('\n── Step 3: Validate ─────────────────────');
  const { validated, rejected } = await validateBatch(groqResults);

  // ── Step 4: save to learnedMap ────────────────────────
  console.log('\n── Step 4: Save ─────────────────────────');
  const { saved, skipped } = writeCorrection(validated);

  // ── Step 5: save report ───────────────────────────────
  console.log('\n── Step 5: Report ───────────────────────');
  saveReport({
    queriesFound:    queries.length,
    groqCalled:      groqResults.length,
    groqFound,
    validated:       validated.length,
    saved:           saved.length,
    skipped:         skipped.length,
    savedEntries:    saved,
    rejectedEntries: rejected,
    skippedEntries:  skipped
  });

  // ── Summary ───────────────────────────────────────────
  console.log('');
  console.log('╔════════════════════════════════════════╗');
  console.log('║           RUN SUMMARY                  ║');
  console.log('╚════════════════════════════════════════╝');
  console.log(`Queries found:    ${queries.length}`);
  console.log(`Groq corrections: ${groqFound}`);
  console.log(`Validated:        ${validated.length}`);
  console.log(`Saved:            ${saved.length}`);
  console.log(`Rejected:         ${rejected.length}`);
  console.log(`Skipped:          ${skipped.length}`);
  console.log(`Finished: ${new Date().toISOString()}`);
  console.log('');
}

run().catch(err => {
  console.error('Offline learner failed:', err.message);
  process.exit(1);
});