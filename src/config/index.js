require('dotenv').config();

module.exports = {
  meilisearch: {
    host: process.env.MEILI_HOST,
    apiKey: process.env.MEILI_MASTER_KEY
  },
  port: process.env.PORT || 6000,
  apiKey: process.env.SMART_SEARCH_API_KEY
};