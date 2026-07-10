const { validateCorrection, validateCandidate, scoreEvidence, makeDecision } = require('./correctionValidator');

let passed = 0, failed = 0;
function test(label, got, expected) {
  const ok = got === expected;
  console.log(`${ok?'✅':'❌'} ${label}${ok?'':` (got:${got} expected:${expected})`}`);
  ok ? passed++ : failed++;
}

// ── validateCandidate ─────────────────────────────────────
console.log('\n▸ validateCandidate');
test('manual always valid',
  validateCandidate({original:'bluetoth',correction:'bluetooth',source:'manual'}).valid, true);
test('same as original invalid',
  validateCandidate({original:'laptop',correction:'laptop',source:'symspell'}).valid, false);
test('symspell: bluetoth→bluetooth valid',
  validateCandidate({original:'bluetoth',correction:'bluetooth',source:'symspell'}).valid, true);
test('symspell: smrte→saree invalid (edit distance too high)',
  validateCandidate({original:'smrte',correction:'saree',source:'symspell'}).valid, false);
test('phonetic: exempt from edit distance gate',
  validateCandidate({original:'sugr',correction:'sugar',source:'phonetic'}).valid, true);

// ── scoreEvidence signals ─────────────────────────────────
console.log('\n▸ scoreEvidence signals');
const improvedScore          = scoreEvidence('phonetic', {resultsBefore:0, resultsAfter:30}).score;
const improvedWithAgreement  = scoreEvidence('phonetic', {resultsBefore:0, resultsAfter:30, phoneticAgreement:true}).score;
const improvedWithClick      = scoreEvidence('phonetic', {resultsBefore:0, resultsAfter:30, clicked:true}).score;
const zeroResultsScore       = scoreEvidence('phonetic', {resultsBefore:0, resultsAfter:0}).score;

test('click increases score',              improvedWithClick > improvedScore, true);
test('phonetic agreement increases score', improvedWithAgreement > improvedScore, true);
test('zero results decreases score',       zeroResultsScore < improvedScore, true);

// score monotonicity ✅
test('score monotonicity: search improvement < search + phonetic agreement', improvedScore < improvedWithAgreement, true);
test('score monotonicity: search + agreement <= search + click', improvedWithAgreement <= improvedWithClick, true);

// ── makeDecision thresholds ───────────────────────────────
console.log('\n▸ makeDecision thresholds');
test('high score → save',    makeDecision(0.90), 'save');
test('mid score → observe',  makeDecision(0.70), 'observe');
test('low score → reject',   makeDecision(0.30), 'reject');
test('exact save threshold → save',    makeDecision(0.80), 'save');
test('exact observe threshold → observe', makeDecision(0.55), 'observe');
test('just below observe → reject',    makeDecision(0.54), 'reject');

// ── Behavioral progression ────────────────────────────────
console.log('\n▸ Behavioral progression (same candidate, different evidence)');
test('phonetic + zero results → reject',
  validateCorrection(
    {original:'bluetoth', correction:'plated', source:'phonetic'},
    {resultsBefore:0, resultsAfter:0}
  ).decision, 'reject');

test('groq + search improvement, no click → observe',
  validateCorrection(
    {original:'bred', correction:'bread', source:'groq'},
    {resultsBefore:0, resultsAfter:30}
  ).decision, 'observe');

test('phonetic + search improvement reaches save threshold',
  validateCorrection(
    {original:'sugr', correction:'sugar', source:'phonetic'},
    {resultsBefore:0, resultsAfter:30}
  ).decision, 'save');

test('phonetic + search improvement + click exceeds save threshold',
  validateCorrection(
    {original:'sugr', correction:'sugar', source:'phonetic'},
    {resultsBefore:0, resultsAfter:30, clicked:true}
  ).decision, 'save');

test('manual always saves regardless of evidence',
  validateCorrection(
    {original:'bluetoth', correction:'bluetooth', source:'manual'},
    {resultsBefore:0, resultsAfter:0}
  ).decision, 'save');

// ── Reason assertions (telemetry verification) ────────────
console.log('\n▸ Reason assertions');
const clickResult = validateCorrection(
  {original:'labtop', correction:'laptop', source:'symspell'},
  {resultsBefore:0, resultsAfter:244, clicked:true}
);
test('click signal present in telemetry',
  clickResult.signals.some(s => s.name === 'click'), true);
test('search_improvement signal present in telemetry',
  clickResult.signals.some(s => s.name === 'search_improvement'), true);
test('source_trust signal present in telemetry',
  clickResult.signals.some(s => s.name === 'source_trust'), true);

// ── Impossible candidates ─────────────────────────────────
console.log('\n▸ Impossible candidates');
test('iphone→banana symspell rejected (edit distance too high)',
  validateCandidate({original:'iphone', correction:'banana', source:'symspell'}).valid, false);
test('apple→television symspell rejected (edit distance too high)',
  validateCandidate({original:'apple', correction:'television', source:'symspell'}).valid, false);
// phonetic candidate generation intentionally permissive ✅
// behavior tested via full pipeline, not candidate alone ✅
test('iphone→banana phonetic: rejected via zero results',
  validateCorrection(
    {original:'iphone', correction:'banana', source:'phonetic'},
    {resultsBefore:0, resultsAfter:0}
  ).decision, 'reject');

// ── Telemetry structure ───────────────────────────────────
console.log('\n▸ Telemetry structure');
const result = validateCorrection(
  {original:'samsng', correction:'samsung', source:'symspell'},
  {resultsBefore:0, resultsAfter:121, clicked:true}
);
test('has decision',  typeof result.decision  === 'string', true);
test('has score',     typeof result.score     === 'number', true);
test('has signals',   Array.isArray(result.signals),        true);
test('has timestamp', typeof result.timestamp === 'string', true);
test('has candidate', typeof result.candidate === 'object', true);

console.log(`\n─────────────────────────────────────`);
console.log(`${passed}/${passed+failed} tests passed`);
