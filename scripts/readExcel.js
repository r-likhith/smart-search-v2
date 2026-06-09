const XLSX = require('xlsx');
const path = require('path');

const FILE = path.join(__dirname, '../products_latest_export.xlsx');

const workbook = XLSX.readFile(FILE);

console.log('\n📊 Excel File Analysis');
console.log('='.repeat(60));
console.log(`Total sheets: ${workbook.SheetNames.length}`);
console.log(`Sheet names: ${workbook.SheetNames.join(', ')}`);

for (const sheetName of workbook.SheetNames) {
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet);

  console.log('\n' + '─'.repeat(60));
  console.log(`📋 Sheet: "${sheetName}"`);
  console.log(`   Total rows: ${rows.length}`);

  if (rows.length === 0) {
    console.log('   (empty sheet)');
    continue;
  }

  const columns = Object.keys(rows[0]);
  console.log(`\n   Columns (${columns.length}):`);
  columns.forEach(col => console.log(`   → ${col}`));

  console.log('\n   First 3 rows:');
  rows.slice(0, 3).forEach((row, i) => {
    console.log(`\n   Row ${i + 1}:`);
    Object.entries(row).forEach(([key, val]) => {
      console.log(`   ${key}: ${String(val).substring(0, 100)}`);
    });
  });
}

console.log('\n' + '='.repeat(60));
console.log('Done!\n');
