# src/spellcheck/

Two independent spell correction engines.

## Files

| File         | Purpose                                    |
|-------------|---------------------------------------------|
| symspell.js  | Dictionary-based spelling correction        |
| phonetic.js  | Sound-alike correction (double metaphone)   |

## SymSpell (symspell.js)

- Uses edit distance to find closest dictionary word ✅
- Dictionary: data/dictionary.txt (25K words) ✅
- Phrases:    data/dictionary_phrases.txt ✅
- Products:   data/productDict.txt ✅
- Min word length: 5 chars (avoids short word confusion) ✅
- Max corrections: 2 per query ✅

Example: "labtop" → "laptop"

## Phonetic (phonetic.js)

- Uses Double Metaphone algorithm ✅
- Finds words that SOUND similar ✅
- Built from product catalog (not dictionary) ✅
- Higher confidence needed to accept ✅

Example: "eyefone" → "iphone"

## Pipeline order
queryRunner always tries SymSpell first ✅
Only tries Phonetic if SymSpell finds nothing ✅
Both must improve results to be accepted ✅
