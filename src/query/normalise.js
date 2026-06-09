function normalise(query) {
  if (!query || typeof query !== 'string') return '';

  return query
    .toLowerCase()                       // UPPERCASE → lowercase
    .replace(/'/g, '')                   // "men's" → "mens" (strip apostrophe)
    .replace(/([a-z])\1{2,}/g, '$1$1') // coooool → cool, keeps saree ✅
                                     // digits protected: 1000 stays 1000 ✅
    .replace(/[^a-z0-9\s\-]/g, ' ')    // remove special chars, keep hyphen
    .replace(/\s+/g, ' ')               // extra spaces → single space
    .trim()                              // trim edges
    .slice(0, 150);                      // max 150 chars
}

module.exports = { normalise };












// function normalise(query) {
//   if (!query || typeof query !== 'string') return '';

//   return query
//     .toLowerCase()                      // UPPERCASE → lowercase
//     .replace(/(.)\1{2,}/g, '$1$1')     // coooool → cool, keeps saree ✅
//     .replace(/[^a-z0-9\s\-]/g, ' ')   // remove special chars, keep hyphen
//     .replace(/\s+/g, ' ')              // extra spaces → single space
//     .trim()                             // trim edges
//     .slice(0, 150);                     // max 150 chars
// }

// module.exports = { normalise };























// function normalise(query) {
//   if (!query || typeof query !== 'string') return '';

//   return query
//     .toLowerCase()
//     .replace(/(.)\1{2,}/g, '$1$1')      // limit repeats to 2
//     .replace(/(.)\1+$/g, '$1')          // clean trailing noise
//     .replace(/([a-z])([0-9])/g, '$1 $2') // split letters-numbers
//     .replace(/([0-9])([a-z])/g, '$1 $2')
//     .replace(/[^a-z0-9\s+-]/g, ' ')
//     .replace(/\s+/g, ' ')
//     .trim()
//     .slice(0, 150);
// }
















// function normalise(query) {
//   if (!query || typeof query !== 'string') return '';

//   return query
//     .toLowerCase()                        // UPPERCASE → lowercase
//     .replace(/(.)\1{2,}/g, '$1$1')       // coooool → cool (3+ repeated → 2)
//     .replace(/(.)\1+$/g, '$1')           // shoeszz → shoes (repeated at end → 1)
//     .replace(/(.)\1+(\s)/g, '$1$2')      // watchhh word → watch word (repeated before space → 1)
//     .replace(/[^a-z0-9\s+-]/g, ' ')      // keep + and -
//     .replace(/\s+/g, ' ')                // extra spaces → single space
//     .trim()                              // remove leading/trailing spaces
//     .slice(0, 150);                      // max 150 characters
// }

//  module.exports = { normalise };








// function normalise(query) {
//   if (!query || typeof query !== 'string') return '';

//   return query
//     .toLowerCase()                          // UPPERCASE → lowercase
//     .replace(/(.)\1{2,}/g, '$1$1')        // coooool → cool
//     .replace(/[^a-z0-9\s+-]/g, ' ')       // keep + and -
//     .replace(/\s+/g, ' ')                   // extra spaces → single space
//     .trim()                                 // remove leading/trailing spaces
//     .slice(0, 150);                          // max 150 characters
// }

// module.exports = { normalise };