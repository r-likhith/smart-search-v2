const { MeiliSearch } = require('meilisearch');

const client = new MeiliSearch({ host: 'http://localhost:7700' });

async function setupSynonyms() {
  console.log('Setting up Meilisearch synonyms...\n');

  const synonyms = {
    // ── Ethnic wear ───────────────────────────────────────
    'kurta':          ['kurti', 'kurthi', 'kurtis', 'kurtas'],
    'kurti':          ['kurta', 'kurthi', 'kurtis'],
    'saree':          ['sari', 'sarees', 'saris'],
    'sari':           ['saree', 'sarees'],
    'dupatta':        ['chunni', 'stole', 'scarf', 'dupattas'],
    'lehenga':        ['lehnga', 'lahenga', 'skirt set'],
    'salwar':         ['churidar', 'salwar kameez', 'suit'],

    // ── Casual wear ───────────────────────────────────────
    'tshirt':         ['tee', 't-shirt', 't shirt', 'tees', 'top'],
    'tee':            ['tshirt', 't-shirt', 't shirt'],
    'hoodie':         ['sweatshirt', 'hooded sweatshirt', 'hoody'],
    'sweatshirt':     ['hoodie', 'hoody', 'pullover'],
    'joggers':        ['track pants', 'trackpants', 'sweatpants', 'tracksuit'],
    'leggings':       ['churidar', 'tights', 'jeggings', 'legging'],
    'jeans':          ['denim', 'denims', 'denim pants'],
    'shorts':         ['bermuda', 'half pants'],
    'jacket':         ['coat', 'blazer', 'windbreaker'],

    // ── Footwear ──────────────────────────────────────────
    'sneakers':       ['sports shoes', 'trainers', 'kicks', 'athletic shoes'],
    'sandals':        ['slippers', 'chappals', 'flip flops', 'floaters'],
    'heels':          ['high heels', 'stilettos', 'pumps', 'wedges'],

    // ── Kids wear ─────────────────────────────────────────
    'frock':          ['dress', 'gown', 'frock dress'],
    'dungaree':       ['overalls', 'dungarees', 'jumpsuit'],

    // ── Electronics ───────────────────────────────────────
    'earphones':      ['earbuds', 'headphones', 'earpiece', 'in ear'],
    'earbuds':        ['earphones', 'tws', 'wireless earphones'],
    'headphones':     ['earphones', 'headset', 'over ear'],
    'smartwatch':     ['smart watch', 'fitness band', 'fitness watch', 'wearable'],
    'speaker':        ['bluetooth speaker', 'soundbar', 'portable speaker'],
    'charger':        ['adapter', 'charging adapter', 'power adapter'],

    // ── Appliances ────────────────────────────────────────
    'refrigerator':   ['fridge', 'ref', 'freezer'],
    'fridge':         ['refrigerator', 'ref'],
    'geyser':         ['water heater', 'gyser', 'geyzer', 'geiser'],
    'water heater':   ['geyser', 'gyser', 'geyzer'],
    'mixer':          ['juicer mixer', 'blender', 'mixie', 'mixer grinder'],
    'kettle':         ['electric kettle', 'tea kettle', 'water kettle'],
    'fan':            ['ceiling fan', 'table fan', 'wall fan', 'pedestal fan'],
    'iron':           ['steam iron', 'clothes iron', 'dry iron'],
    'microwave':      ['microwave oven', 'oven', 'otg'],
    'washing machine':['washer', 'laundry machine', 'front load', 'top load'],

    // ── Kitchen ───────────────────────────────────────────
    'cooker':         ['pressure cooker', 'rice cooker'],
    'kadai':          ['wok', 'fry pan', 'deep pan', 'karahi'],
    'tiffin':         ['lunch box', 'lunchbox', 'food container'],
    'flask':          ['thermos', 'water bottle', 'insulated bottle'],

    // ── Beauty & Personal care ────────────────────────────
    'moisturiser':    ['moisturizer', 'lotion', 'body lotion', 'face cream'],
    'moisturizer':    ['moisturiser', 'lotion', 'body lotion'],
    'shampoo':        ['hair wash', 'hair cleanser', 'hair care'],
    'sunscreen':      ['sunblock', 'spf cream', 'sun protection'],
    'lipstick':       ['lip color', 'lip colour', 'lip gloss', 'lip tint'],
    'foundation':     ['bb cream', 'cc cream', 'base makeup'],
    'kajal':          ['kohl', 'eye liner', 'eyeliner'],

    // ── Home ─────────────────────────────────────────────
    'bedsheet':       ['bed sheet', 'bedcover', 'bed cover', 'bed linen'],
    'pillow':         ['cushion', 'pillow cover', 'pillowcase'],
    'curtain':        ['curtains', 'drapes', 'blinds', 'window curtain'],
    'mat':            ['rug', 'carpet', 'floor mat', 'doormat'],

    // ── Bags ─────────────────────────────────────────────
    'backpack':       ['bag', 'rucksack', 'school bag', 'laptop bag'],
    'handbag':        ['purse', 'tote', 'shoulder bag', 'clutch'],
    'wallet':         ['purse', 'card holder', 'money wallet'],

    // ── Innerwear & Nightwear ─────────────────────────────
    'innerwear':      ['underwear', 'vest', 'briefs', 'undergarments'],
    'nightwear':      ['pyjama', 'pajama', 'nightsuit', 'sleepwear', 'night dress'],
    'pyjama':         ['pajama', 'night pants', 'lounge pants', 'pyjamas'],
    'vest':           ['banyan', 'innerwear', 'sleeveless top', 'tank top'],

    // ── Ethnic/Occasion concepts ──────────────────────────
    'ethnic wear':    ['kurta', 'saree', 'lehenga', 'salwar', 'dupatta', 'traditional'],
    'western wear':   ['jeans', 'tshirt', 'top', 'dress', 'shorts', 'casual wear'],
    'raincoat':       ['rain jacket', 'waterproof jacket', 'rain coat', 'rain wear'],
    'tracksuit':      ['jogger set', 'sports set', 'track suit', 'gym wear'],
    'swimwear':       ['swimsuit', 'swimming costume', 'bikini', 'trunks'],

    // ── Kitchen tools ─────────────────────────────────────
    'casserole':      ['container', 'storage box', 'food container', 'hot case'],
    'spatula':        ['turner', 'ladle', 'cooking spoon', 'flipper'],
    'chopper':        ['cutter', 'vegetable cutter', 'dicer', 'slicer'],

    // ── Beauty & Skincare ─────────────────────────────────
    'face wash':      ['facewash', 'cleanser', 'face cleanser', 'foam wash'],
    'facewash':       ['face wash', 'cleanser', 'foam cleanser'],
    'serum':          ['face serum', 'skin serum', 'hair serum'],
    'toner':          ['face toner', 'skin toner', 'astringent'],
    'scrub':          ['exfoliator', 'face scrub', 'body scrub', 'exfoliant'],
    'conditioner':    ['hair conditioner', 'hair mask', 'deep conditioner'],

    // ── Bags & Accessories ────────────────────────────────
    'sling bag':      ['crossbody bag', 'side bag', 'messenger bag', 'sling'],
    'trolley':        ['luggage', 'suitcase', 'travel bag', 'cabin bag'],
    'watch':          ['wristwatch', 'timepiece', 'analog watch', 'digital watch'],
  };

  try {
    const task = await client.index('products').updateSynonyms(synonyms);
    console.log('Synonyms update task queued:', task.taskUid);

    // wait for task to complete
    await client.waitForTask(task.taskUid);
    console.log('✅ Synonyms configured successfully!\n');

    // verify
    const saved = await client.index('products').getSynonyms();
    console.log(`Total synonym groups: ${Object.keys(saved).length}`);

    // test a few
    const tests = ['tshirt', 'fridge', 'geyser', 'kurta', 'sneakers'];
    console.log('\nSample synonyms:');
    for (const word of tests) {
      if (saved[word]) {
        console.log(`  "${word}" → [${saved[word].join(', ')}]`);
      }
    }

  } catch (err) {
    console.error('Failed:', err.message);
  }
}

setupSynonyms();
