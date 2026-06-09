const { normalise } = require('./normalise');

// ─── SIZE GROUPS ──────────────────────────────────────
const SIZE_GROUPS = {
  // months
  'newborn':      ['0-3M','0 - 3 M','0-3 Months','0-1M','1-3M','1-3 Months','0-6M','0-12M'],
  '0-3 months':   ['0-3M','0 - 3 M','0-3 Months','0-1M','1-3M'],
  '0-6 months':   ['0-6M','0-3M','0 - 3 M','1-3M','0-12M'],
  '6-12 months':  ['0-12M','0-6M','10-12 Months','12M'],
  '12-18 months': ['12-18M','12 - 18 M','12-15 Months','15-18 Months','18-24M','18 - 24 M'],
  '18-24 months': ['18-24M','18 - 24 M','12-18M','12 - 18 M'],
  // years
  '1-2 years':    ['1 - 2 Yrs','1-2 Yrs','1-2Y','1 yrs','0 - 1 Yrs','0-3 Yrs','2 yrs'],
  '2-3 years':    ['2 - 3 yrs','2 - 3 Years','2-3 Yrs','2-3Y','2 -3 Yrs','2-3YRS','1-1.6 yrs'],
  '3-4 years':    ['2 - 3 yrs','2 - 3 Years','2-3 Yrs'],
  '10 years':     ['10 - 11 Yrs','10 - 11 Years','10-11 Yrs','10 yrs','10 - 12 Yrs'],
  '11 years':     ['11 - 12 Yrs','11-12 Yrs','11 yrs'],
  '12 years':     ['12 - 13 Yrs','12 - 13 Years','12-13 Yrs','12 yrs'],
  '13 years':     ['13 - 14 Yrs','13-14 Yrs','13 -14 Yrs'],
  '14 years':     ['14 - 15 Yrs','14 - 15 Years','14-15 Yrs'],
  '15 years':     ['15 - 16 Yrs','15 - 16 Years','15-16 Yrs','15 -16 Yrs'],
  '16 years':     ['16 - 17 Yrs','16 - 17 Years','16-17 Yrs'],
  '17 years':     ['17 - 18 Yrs','17-18 Yrs'],
  // metres
  '1.9 mtr':      ['1.90 MTR','2 MTR'],
  '2 mtr':        ['2 MTR','1.90 MTR','2.10 MTR'],
  '2.1 mtr':      ['2.10 MTR','2 MTR','2.20 MTR'],
  '2.2 mtr':      ['2.20 MTR','2.10 MTR','2.5 MTR'],
  '2.5 mtr':      ['2.5 MTR','2.20 MTR'],
};

// ─── COLOR MAPS ───────────────────────────────────────

const COLOR_BASE_MAP = {
  'black':      'Black',
  'blue':       'Blue',
  'red':        'Red',
  'white':      'White',
  'green':      'Green',
  'yellow':     'Yellow',
  'pink':       'Pink',
  'purple':     'Purple',
  'orange':     'Orange',
  'brown':      'Brown',
  'grey':       'Grey',
  'gray':       'Grey',
  'beige':      'Beige',
  'cream':      'Cream',
  'maroon':     'Maroon',
  'navy':       'Navy Blue',
  'golden':     'Golden',
  'gold':       'Golden',
  'silver':     'Silver',
  'rose':       'Rose',
  'peach':      'Peach',
  'lavender':   'Lavender',
  'coral':      'Coral',
  'turquoise':  'Turquoise',
  'aqua':       'Aqua',
  'teal':       'Teal',
  'indigo':     'Indigo',
  'violet':     'Violet',
  'magenta':    'Magenta',
  'multicolor': 'Multicolor',
  'assorted':   'Assorted',
  'printed':    null,
};

// compound colors — checked before single word colors
const COLOR_COMPOUND_MAP = {
  'navy blue':  'Navy Blue',
  'off white':  'Off White',
  'dark green': 'Dark Green',
  'dark blue':  'Dark Blue',
  'light blue': 'Light Blue',
  'light pink': 'Light Pink',
  'baby pink':  'Baby Pink',
  'baby blue':  'Baby Blue',
  'hot pink':   'Hot Pink',
  'dark grey':  'Dark Grey',
  'ash grey':   'Ash Grey',
  'sky blue':   'Sky Blue',
  'royal blue': 'Royal Blue',
  'dark red':   'Dark Red',
  'dark brown': 'Dark Brown',
};

// ─── GENDER MAP ───────────────────────────────────────
// null = known gender word but no category filter
// e.g. kids/children → products split across Girl+Boy
// letting text search handle naturally is better

const GENDER_MAP = {
  'mens':     'Men',
  'men':      'Men',
  'gents':    'Men',
  'male':     'Men',
  'man':      'Men',
  'womens':   'Women',
  'women':    'Women',
  'ladies':   'Women',
  'female':   'Women',
  'woman':    'Women',
  'girls':    'Girl',
  'girl':     'Girl',
  'boys':     'Boy',
  'boy':      'Boy',
  'kids':     null,      // Girl: 13684 + Boy: 6768, not Kids: 272
  'kid':      null,
  'children': null,
  'child':    null,
  'junior':   null,
  'baby':     'Just born',
  'infant':   'Just born',
  'newborn':  'Just born',
  'toddler':  'Just born',
  'pnik':     'Pink',
  'bleu':     'Blue',
  'gree':     'Green',
  'whit':     'White',
  'blak':     'Black',
  'gren':     'Green',
  'orng':     'Orange',
  'purpl':    'Purple',
};

// ─── PRICE PATTERNS ──────────────────────────────────

const PRICE_PATTERNS = [
  { regex: /\bunder\s+(?:rs\.?|inr|₹)?\s*(\d+)\b/i,       type: 'max' },
  { regex: /\bbelow\s+(?:rs\.?|inr|₹)?\s*(\d+)\b/i,       type: 'max' },
  { regex: /\bless\s+than\s+(?:rs\.?|inr|₹)?\s*(\d+)\b/i, type: 'max' },
  { regex: /\bupto\s+(?:rs\.?|inr|₹)?\s*(\d+)\b/i,        type: 'max' },
  { regex: /\bwithin\s+(?:rs\.?|inr|₹)?\s*(\d+)\b/i,      type: 'max' },
  { regex: /\babove\s+(?:rs\.?|inr|₹)?\s*(\d+)\b/i,       type: 'min' },
  { regex: /\bover\s+(?:rs\.?|inr|₹)?\s*(\d+)\b/i,        type: 'min' },
  { regex: /\bmore\s+than\s+(?:rs\.?|inr|₹)?\s*(\d+)\b/i, type: 'min' },
  { regex: /\batleast\s+(?:rs\.?|inr|₹)?\s*(\d+)\b/i,     type: 'min' },
  { regex: /(?:rs\.?|inr|₹)\s*(\d+)\s*(?:to|-)\s*(?:rs\.?|inr|₹)?\s*(\d+)/i, type: 'range' },
  { regex: /\b(\d+)\s*(?:to|-)\s*(\d+)\b/,                 type: 'range' },
  { regex: /(?:rs\.?|inr|₹)\s*(\d+)/i,                     type: 'max' },
];

// ─── SIZE PATTERNS ────────────────────────────────────

const SIZE_PATTERNS = [
  { regex: /\b(\d+)\s*(?:-|to)\s*(\d+)\s*(?:years?|yrs?)\b/i, type: 'age_range'      },
  { regex: /\b([1-9]|1[0-7])\s+([1-9]|1[0-8])\s*(?:years?|yrs?)\b/i, type: 'age_range' },
  { regex: /\bage\s+(\d+)\b/i,                                  type: 'age_single'     },
  { regex: /\b(\d+)\s*(?:years?|yrs?)\b/i,                     type: 'age_single'     },
  { regex: /\b(\d+)\s*(?:-|to)\s*(\d+)\s*(?:months?|m)\b/i,   type: 'month_range'    },
  { regex: /\b(\d+)\s+(\d+)\s*(?:months?)\b/i,                 type: 'month_range'    },
  { regex: /\b(\d+)\s*(?:months?)\b/i,                          type: 'month_single'   },
  { regex: /\b(\d+)\s+(\d+)\s*(?:mtr|metre|meter|mtrs)\b/i,   type: 'metres_decimal' },
  { regex: /\b(\d+)\s*(?:mtr|metre|meter|mtrs)\b/i,            type: 'metres'         },
];

// ─── STOP WORDS ───────────────────────────────────────

const STOP_WORDS = new Set([
  'for', 'with', 'and', 'the', 'a', 'an', 'in', 'of',
  'to', 'at', 'by', 'on', 'is', 'are', 'was', 'new',
  'best', 'good', 'nice', 'buy', 'get', 'shop', 'online',
  'latest', 'top', 'quality', 'original', 'india', 'pure',
  'years', 'year', 'yrs', 'yr', 'months', 'month',
  'mtr', 'metre', 'meter', 'size', 'litre', 'liter',
  'old', 'age', 'color', 'colour',
]);

// ─── PRECOMPILED REGEXES ──────────────────────────────

const COLOR_COMPOUND_REGEXES = Object.fromEntries(
  Object.entries(COLOR_COMPOUND_MAP).map(([k, v]) => [
    k,
    new RegExp('\\b' + k.replace(/ /g, '\\s+') + '\\b', 'i')
  ])
);

const COLOR_BASE_REGEXES = Object.fromEntries(
  Object.keys(COLOR_BASE_MAP).map(k => [
    k,
    new RegExp('\\b' + k + '\\b', 'g')
  ])
);

const GENDER_REGEXES = Object.fromEntries(
  Object.keys(GENDER_MAP).map(k => [
    k,
    new RegExp('\\b' + k + '\\b', 'g')
  ])
);

const BRAND_REGEXES = new Map();

// ─── DYNAMIC BRAND MATCHING ───────────────────────────

let brandList = [];

async function loadBrands(meiliClient) {
  try {
    const results = await meiliClient.index('products').search('', {
      limit: 0,
      facets: ['brand']
    });
    brandList = Object.keys(results.facetDistribution.brand || {})
      .map(b => {
        const lower = b.toLowerCase().replace(/[^a-z0-9]/g, '');
        BRAND_REGEXES.set(lower, new RegExp('\\b' + lower + '\\b', 'i'));
        return { original: b, lower };
      });
    console.log(`[IntentParser] Loaded ${brandList.length} brands`);
  } catch (err) {
    console.error('[IntentParser] Failed to load brands:', err.message);
  }
}

function matchBrand(word) {
  if (!word || word.length < 2) return null;
  const normalised = word.toLowerCase().replace(/[^a-z0-9]/g, '');
  const match = brandList.find(b => b.lower === normalised);
  return match ? match.original : null;
}

// ─── SIZE RESOLVER ────────────────────────────────────

function resolveSize(type, val1, val2) {
  if (type === 'age_range' || type === 'age_single') {
    const age = parseInt(val1);
    const key = val2 ? `${val1}-${val2} years` : `${age} years`;
    if (SIZE_GROUPS[key]) return SIZE_GROUPS[key];
    return findNearestAgeGroup(age);
  }
  if (type === 'month_range' || type === 'month_single') {
    const months = parseInt(val1);
    if (months <= 3)  return SIZE_GROUPS['0-3 months'];
    if (months <= 6)  return SIZE_GROUPS['0-6 months'];
    if (months <= 12) return SIZE_GROUPS['6-12 months'];
    if (months <= 18) return SIZE_GROUPS['12-18 months'];
    return SIZE_GROUPS['18-24 months'];
  }
  if (type === 'metres' || type === 'metres_decimal') {
    const mtr = type === 'metres_decimal'
      ? parseFloat(val1 + '.' + val2)
      : parseFloat(val1);
    if (mtr <= 1.95) return SIZE_GROUPS['1.9 mtr'];
    if (mtr <= 2.05) return SIZE_GROUPS['2 mtr'];
    if (mtr <= 2.15) return SIZE_GROUPS['2.1 mtr'];
    if (mtr <= 2.25) return SIZE_GROUPS['2.2 mtr'];
    return SIZE_GROUPS['2.5 mtr'];
  }
  return null;
}

function findNearestAgeGroup(age) {
  const groups = {
    1:  SIZE_GROUPS['1-2 years'],
    2:  SIZE_GROUPS['2-3 years'],
    3:  SIZE_GROUPS['3-4 years'],
    4:  null,
    5:  null,
    6:  null,
    7:  null,
    8:  null,
    9:  SIZE_GROUPS['10 years'],
    10: SIZE_GROUPS['10 years'],
    11: SIZE_GROUPS['11 years'],
    12: SIZE_GROUPS['12 years'],
    13: SIZE_GROUPS['13 years'],
    14: SIZE_GROUPS['14 years'],
    15: SIZE_GROUPS['15 years'],
    16: SIZE_GROUPS['16 years'],
    17: SIZE_GROUPS['17 years'],
  };
  return groups[age] || null;
}

// ─── MAIN PARSER ─────────────────────────────────────

function parseIntent(query) {
  const result = {
    originalQuery: query,
    cleanQuery: null,
    filters: {},
    extractedTerms: [],
    sizeGroup: null
  };

  let working = normalise(query);
  if (!working) return result;

  // ── 1. Size FIRST — protects age ranges from price ────
  for (const pattern of SIZE_PATTERNS) {
    const match = working.match(pattern.regex);
    if (match) {
      const sizeGroup = resolveSize(pattern.type, match[1], match[2]);
      if (sizeGroup && sizeGroup.length > 0) {
        result.sizeGroup = sizeGroup;
        result.extractedTerms.push(match[0]);
        working = working.replace(match[0], ' ').trim();
      }
      break;
    }
  }

  // ── 2. Price — run twice for min AND max ──────────────
  let priceRoundsLeft = 2;
  while (priceRoundsLeft > 0) {
    let matched = false;
    for (const pattern of PRICE_PATTERNS) {
      const match = working.match(pattern.regex);
      if (match) {
        if (pattern.type === 'max' && !result.filters.maxPrice) {
          result.filters.maxPrice = parseInt(match[1]);
          result.extractedTerms.push(match[0]);
          working = working.replace(match[0], ' ').trim();
          matched = true;
          break;
        } else if (pattern.type === 'min' && !result.filters.minPrice) {
          result.filters.minPrice = parseInt(match[1]);
          result.extractedTerms.push(match[0]);
          working = working.replace(match[0], ' ').trim();
          matched = true;
          break;
        } else if (pattern.type === 'range' && !result.filters.maxPrice) {
          const a = parseInt(match[1]);
          const b = parseInt(match[2]);
          if (a > 100 && b > 100) {
            result.filters.minPrice = Math.min(a, b);
            result.filters.maxPrice = Math.max(a, b);
            result.extractedTerms.push(match[0]);
            working = working.replace(match[0], ' ').trim();
            matched = true;
          }
          break;
        }
      }
    }
    if (!matched) break;
    priceRoundsLeft--;
  }

  // ── 3. Color — compound first (word boundaries) ───────
  let colorFound = false;
  for (const [key, val] of Object.entries(COLOR_COMPOUND_MAP)) {
    if (COLOR_COMPOUND_REGEXES[key].test(working)) {
      result.filters.color = val;
      result.extractedTerms.push(key);
      working = working.replace(COLOR_COMPOUND_REGEXES[key], ' ').trim();
      colorFound = true;
      break;
    }
  }
  if (!colorFound) {
    const words = working.split(/\s+/);
    for (const word of words) {
      if (COLOR_BASE_MAP[word] !== undefined) {
        if (COLOR_BASE_MAP[word] !== null) {
          result.filters.color = COLOR_BASE_MAP[word];
        }
        result.extractedTerms.push(word);
        COLOR_BASE_REGEXES[word].lastIndex = 0;
        working = working.replace(COLOR_BASE_REGEXES[word], ' ').trim();
        break;
      }
    }
  }

  // ── 4. Gender/Audience ────────────────────────────────
  // null value = known gender word, extract it but don't filter
  // e.g. kids → Girl+Boy both, text search handles naturally
  const wordsAfterColor = working.split(/\s+/);
  for (const word of wordsAfterColor) {
    if (GENDER_MAP[word] !== undefined) {
      if (GENDER_MAP[word] !== null) {
        // known gender with category → filter + remove from query
        result.filters.category = GENDER_MAP[word];
        result.extractedTerms.push(word);
        GENDER_REGEXES[word].lastIndex = 0;
        working = working.replace(GENDER_REGEXES[word], ' ').trim();
      }
      // null gender (kids/children/junior) → keep in query
      // so "kids shoes" stays as cleanQuery not just "shoes"
      // Meilisearch text search finds kids context naturally
      break;
    }
  }

  // ── 5. Brand — dynamic, 2+ char minimum ───────────────
  const wordsAfterGender = working.split(/\s+/);
  for (const word of wordsAfterGender) {
    const brand = matchBrand(word);
    if (brand) {
      result.filters.brand = brand;
      result.extractedTerms.push(word);
      const brandNorm = word.toLowerCase().replace(/[^a-z0-9]/g, '');
      const brandRe = BRAND_REGEXES.get(brandNorm);
      if (brandRe) {
        brandRe.lastIndex = 0;
        working = working.replace(brandRe, ' ').trim();
      } else {
        working = working.replace(new RegExp(`\\b${word}\\b`, 'i'), ' ').trim();
      }
      break;
    }
  }

  // ── 6. Clean remaining query ──────────────────────────
  working = working
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w))
    .join(' ')
    .trim();

  result.cleanQuery = working || normalise(query);

  return result;
}

// ─── HAS FILTERS ─────────────────────────────────────

function hasFilters(parsed) {
  return Object.keys(parsed.filters).length > 0 || parsed.sizeGroup !== null;
}

module.exports = { parseIntent, hasFilters, loadBrands };