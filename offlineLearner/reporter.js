// offlineLearner/reporter.js
// saves run report to logs/ ✅
// audit trail for every run ✅

const fs   = require('fs');
const path = require('path');
const { PATHS } = require('./config');

function saveReport(data) {
  try {
    fs.mkdirSync(PATHS.reportsDir, { recursive: true });

    const date     = new Date().toISOString().split('T')[0];
    const filename = `offline-learner-${date}.json`;
    const filepath = path.join(PATHS.reportsDir, filename);

    const report = {
      ts:             new Date().toISOString(),
      queriesFound:   data.queriesFound   || 0,
      groqCalled:     data.groqCalled     || 0,
      groqFound:      data.groqFound      || 0,
      validated:      data.validated      || 0,
      saved:          data.saved          || 0,
      skipped:        data.skipped        || 0,
      // detail ✅
      savedEntries:   data.savedEntries   || [],
      rejectedEntries: data.rejectedEntries || [],
      skippedEntries: data.skippedEntries || []
    };

    fs.writeFileSync(filepath, JSON.stringify(report, null, 2));
    console.log(`\n📄 Report saved: logs/${filename}`);
    return filepath;

  } catch (err) {
    console.error('[Reporter] Failed to save report:', err.message);
    return null;
  }
}

module.exports = { saveReport };