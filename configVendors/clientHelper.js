const clients = require('./clients');

// get client config by clientId
function getClient(clientId) {
  return clients[String(clientId)] || null;
}

// get Meilisearch index for a clientId
function getClientIndex(clientId) {
  const client = getClient(clientId);
  return client ? client.meiliIndex : null;
}

// get client scope (type) for a clientId ✅
// used for cross-client penalty detection ✅
// and future scope enforcement ✅
function getClientScope(clientId) {
  const client = getClient(clientId);
  return client ? client.type : null;
}

// validate clientId exists and is active
function isValidClient(clientId) {
  const client = getClient(clientId);
  return client !== null && client.active === true;
}

// get all active clients
function getAllActiveClients() {
  return Object.entries(clients)
    .filter(([, c]) => c.active)
    .map(([id, c]) => ({ id, ...c }));
}

// get all unsynced clients
function getUnsyncedClients() {
  return Object.entries(clients)
    .filter(([, c]) => c.active && !c.synced)
    .map(([id, c]) => ({ id, ...c }));
}

module.exports = {
  getClient,
  getClientIndex,
  getClientScope,
  isValidClient,
  getAllActiveClients,
  getUnsyncedClients
};