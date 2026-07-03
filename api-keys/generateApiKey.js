#!/usr/bin/env node
// scripts/generateApiKey.js
//
// Generate a new per-client API key and add it to config/apiKeys.json
//
// Usage:
//   node scripts/generateApiKey.js <clientId> <name>
//
// Example:
//   node scripts/generateApiKey.js 999 "Grocery Store"
//
// Output:
//   New key printed to console — copy it, you won't see it again ✅
//   Entry added to config/apiKeys.json ✅

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const KEYS_FILE = path.join(__dirname, '../config/apiKeys.json');

const clientId = process.argv[2];
const name     = process.argv[3] || `Client ${clientId}`;

if (!clientId) {
  console.error('Usage: node scripts/generateApiKey.js <clientId> <name>');
  console.error('Example: node scripts/generateApiKey.js 999 "Grocery Store"');
  process.exit(1);
}

// load existing keys
let keysData = { version: 1, keys: {} };
if (fs.existsSync(KEYS_FILE)) {
  keysData = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
}

// check clientId not already registered
const existingForClient = Object.values(keysData.keys)
  .find(e => String(e.clientId) === String(clientId) && e.status === 'active');
if (existingForClient) {
  console.warn(`⚠️  Client ${clientId} already has an active key`);
  console.warn('   Use scripts/rotateApiKey.js to replace it');
  process.exit(1);
}

// generate opaque key — clientId NOT encoded in key ✅
// 32 bytes = 64 hex chars — plenty of entropy ✅
const random = crypto.randomBytes(32).toString('hex');
const newKey = `sk_live_${random}`;

// add to keys file
keysData.keys[newKey] = {
  clientId:      String(clientId),
  name,
  status:        'active',
  permissions: {
    search:    true,
    suggest:   true,
    analytics: false,
    admin:     false
  },
  allowedOrigins: [],
  rateLimit:      100,
  createdAt:      new Date().toISOString(),
  lastUsed:       null,
  lastOrigin:     null
};

// atomic write ✅
const tmp = KEYS_FILE + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(keysData, null, 2));
fs.renameSync(tmp, KEYS_FILE);

console.log('');
console.log('✅ API key generated successfully');
console.log('');
console.log(`Client:  ${clientId} — ${name}`);
console.log(`Key:     ${newKey}`);
console.log('');
console.log('⚠️  Copy this key now — it will not be shown again');
console.log('   Share it with the client via a secure channel');
console.log('');
console.log('Next: restart the server or POST /api/admin/reload');
