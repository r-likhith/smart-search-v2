// ─── SETUP SCRIPT ─────────────────────────────────────────
// Run once after cloning the repo ✅
// Copies seed files to runtime files ✅
// Safe to run multiple times ✅

const fs   = require('fs');
const path = require('path');

const LEARNED_DIR = path.join(__dirname, '../learned');

const seeds = [
  { seed: 'learnedMap.seed.json',   runtime: 'learnedMap.json'   },
  { seed: 'suggestMap.seed.json',   runtime: 'suggestMap.json'   },
  { seed: 'reverseIndex.seed.json', runtime: 'reverseIndex.json' }
];

const defaults = [
  { file: 'clicks.json',     content: '{}' },
  { file: 'buildState.json', content: '{"builds":[],"pendingClicks":[]}' }
];

const dirs = [
  '../learned',
  '../logs',
  '../multiTenantLogs',
  '../sync_state'
];

console.log('\n🌿 Smart Search v2 — Setup\n');

// ── create directories ─────────────────────────────────────
console.log('▸ Creating directories...');
for (const dir of dirs) {
  const full = path.join(__dirname, dir);
  if (!fs.existsSync(full)) {
    fs.mkdirSync(full, { recursive: true });
    console.log(`  ✅ Created: ${dir}`);
  } else {
    console.log(`  ✓  Exists:  ${dir}`);
  }
}

// ── copy seed files ────────────────────────────────────────
console.log('\n▸ Copying seed files...');
for (const { seed, runtime } of seeds) {
  const seedPath    = path.join(LEARNED_DIR, seed);
  const runtimePath = path.join(LEARNED_DIR, runtime);

  if (!fs.existsSync(seedPath)) {
    console.log(`  ❌ Seed missing: ${seed}`);
    continue;
  }

  if (fs.existsSync(runtimePath)) {
    console.log(`  ✓  Already exists — skipping: ${runtime}`);
    continue;
  }

  fs.copyFileSync(seedPath, runtimePath);
  console.log(`  ✅ Copied: ${seed} → ${runtime}`);
}

// ── create default files ───────────────────────────────────
console.log('\n▸ Creating default files...');
for (const { file, content } of defaults) {
  const filePath = path.join(LEARNED_DIR, file);
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, content);
    console.log(`  ✅ Created: ${file}`);
  } else {
    console.log(`  ✓  Exists:  ${file}`);
  }
}

// ── check .env ────────────────────────────────────────────
console.log('\n▸ Checking .env...');
const envPath     = path.join(__dirname, '../.env');
const envExample  = path.join(__dirname, '../.env.example');

if (!fs.existsSync(envPath)) {
  if (fs.existsSync(envExample)) {
    fs.copyFileSync(envExample, envPath);
    console.log('  ✅ Created .env from .env.example');
    console.log('  ⚠️  Remember to fill in your real values in .env');
  } else {
    console.log('  ❌ .env.example not found');
  }
} else {
  console.log('  ✓  .env exists');
}

// ── summary ───────────────────────────────────────────────
console.log('\n╔════════════════════════════════════════╗');
console.log('║           SETUP COMPLETE               ║');
console.log('╚════════════════════════════════════════╝');
console.log('\nNext steps:');
console.log('  1. Fill in .env with real values ✅');
console.log('  2. docker compose up ✅');
console.log('  3. open http://localhost:3000/demos ✅');
console.log('');
