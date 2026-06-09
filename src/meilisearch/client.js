const { MeiliSearch } = require('meilisearch');
const config = require('../config');

const client = new MeiliSearch({
  host: config.meilisearch.host,
  apiKey: config.meilisearch.apiKey
});

module.exports = client;