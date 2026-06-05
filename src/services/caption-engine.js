import path from 'node:path';
import { config } from '../config.js';
import { generateCloudflareCaptionDraft, generateVisualAssist, getCaptionProviderStatus } from './cloudflare-caption.js';

const DEITY_KEYWORDS = {
  krishna: ['krishna', 'kanha', 'govinda', 'gopal', 'radha', 'sakhi', 'vrindavan', 'flute', 'murli'],
  shiva: ['shiva', 'shiv', 'mahadev', 'bholenath', 'rudra', 'trishul', 'kailash', 'parvati'],
  rama: ['ram', 'rama', 'siya', 'sita', 'siyaram', 'ayodhya'],
  hanuman: ['hanuman', 'hanuman ji', 'bajrangbali', 'pavanputra', 'sankatmochan', 'chalisa'],
  durga: ['durga', 'maa', 'devi', 'shakti', 'navratri', 'parvati'],
  ganesha: ['ganesh', 'ganesha', 'vinayak', 'bappa']
};

const THEME_KEYWORDS = {
  surrender: ['surrender', 'let go', 'trust', 'timing', 'wait', 'faith'],
  healing: ['heal', 'healing', 'heart', 'break', 'pain', 'loss'],
  confidence: ['enough', 'worthy', 'strength', 'strong', 'courage'],
  peace: ['peace', 'calm', 'soft', 'still', 'silence'],
  love: ['love', 'sakhi', 'radha', 'ore', 'belong', 'divine love'],
  playful: ['cool', 'fun', 'gen z', 'modern', 'cute', 'toon', 'goggles', 'meme']
};

const MODE_HINTS = {
  meme_one_liner: ['fun', 'funny', 'meme', 'gen z', 'cool', 'cute', 'sass', 'modern', 'goggles'],
  devotional_emotion: ['soft', 'healing', 'surrender', 'love', 'longing', 'peace', 'divine'],
  micro_story: ['story', 'dialogue', 'scene', 'sakhi', 'moment', 'conversation']
};

const HOOKS = {
  krishna: [
    'Unki muskaan mein bas sukoon hai.',
    'Krishna ji ko dekhkar mann turant halka ho jaata hai.',
    'Radha Krishna ki ek jhalak kabhi kabhi poora din badal deti hai.'
  ],
  shiva: [
    'Shiv ji ki shanti seedha dil tak pahunchti hai.',
    'Maa Parvati aur Shiv ji ko dekhkar sab kuch thoda komal lagne lagta hai.',
    'Unki jodi mein pyaar bhi hai, sukoon bhi.'
  ],
  hanuman: [
    'Hanuman ji ka naam aate hi dil sambhal jaata hai.',
    'Bajrangbali ka sahara ho, toh darr utna bhaari nahi lagta.',
    'Hanuman ji ki yaad mein himmat bhi hai, sukoon bhi.'
  ],
  rama: [
    'SiyaRam ka naam aate hi mann sambhal jaata hai.',
    'Ram ji ki saadgi hi sabse gehri lagti hai.',
    'Unka smaran ho, toh mann khud shaant ho jaata hai.'
  ],
  default: [
    'Is nazar mein bas pyaar aur sukoon tha.',
    'Kabhi kabhi ek chhota sa drishya bhi dil rok deta hai.',
    'Sanatan warmth ho, toh chhoti si cheez bhi yaad reh jaati hai.'
  ]
};

const CTA_LINES = {
  devotional_emotion: [
    'Sach bolo... yeh feel hui na?',
    'Kisko bhejoge jo yeh dekh ke smile karega?',
    `follow ${config.account.handle}_ for more`
  ],
  meme_one_liner: [
    'Sach bolo... tum is situation me kaun ho?',
    'Tag that one friend jo bilkul aisa hi hai.',
    'Ye line kis kis par fit baithti hai?'
  ]
};

const DISCOVERY_TERMS = {
  krishna: ['krishna art', 'radha krishna reel', 'vrindavan aesthetic'],
  shiva: ['mahadev reel', 'shiv bhakti art', 'shiva devotional edit'],
  rama: ['ram bhakti reel', 'jai shri ram art', 'siyaram devotional'],
  hanuman: ['hanuman bhakti reel', 'bajrangbali art', 'hanuman chalisa edit'],
  durga: ['maa durga art', 'shakti devotional reel', 'devi bhakti post'],
  ganesha: ['ganpati art', 'ganesh bhakti reel', 'bappa devotional post'],
  default: ['sanatan art reel', 'devotional aesthetic', 'bhakti content']
};

const THEME_DISCOVERY_TERMS = {
  surrender: ['divine timing', 'faith over fear'],
  healing: ['spiritual healing', 'heart healing'],
  confidence: ['divine strength', 'worthy energy'],
  peace: ['inner peace', 'calm spiritual reel'],
  love: ['divine love', 'soft bhakti'],
  playful: ['modern bhakti', 'gen z sanatani']
};

const HASHTAG_SETS = {
  krishna: ['sanatandharma', 'krishnaji', 'radharani'],
  shiva: ['sanatandharma', 'shivstatus', 'maaparvati'],
  rama: ['sanatandharma', 'jaishreeram', 'siyaram'],
  hanuman: ['sanatandharma', 'hanumanji', 'bajrangbali'],
  durga: ['sanatandharma', 'jaimatadi', 'shaktibhakti'],
  ganesha: ['sanatandharma', 'ganpatibappa', 'ganeshbhakti'],
  default: ['sanatandharma', 'bhakti', 'toonart']
};

const THEME_HASHTAGS = {
  surrender: ['divinetiming'],
  healing: ['spiritualhealing'],
  confidence: ['divinestrength'],
  peace: ['toonart'],
  love: ['lovepostsdaily'],
  playful: ['toonart']
};

const FALLBACK_HASHTAGS = ['sanatandharma', 'toonart', 'bhakti', 'viralreels', 'devotional'];

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\.[^.]+$/, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractQuotedCaptionSegments(value) {
  const matches = String(value || '').match(/[“"][^“”"\n]{1,400}[”"]/g) || [];
  return [...new Set(matches.map((item) => String(item || '').trim()).filter(Boolean))];
}

function ensureQuotedCaptionSegments(caption, sourceText) {
  const mandatorySegments = extractQuotedCaptionSegments(sourceText);
  if (mandatorySegments.length === 0) {
    return String(caption || '').trim();
  }

  const normalizedCaption = String(caption || '').trim();
  const missingSegments = mandatorySegments.filter((segment) => !normalizedCaption.includes(segment));
  if (missingSegments.length === 0) {
    return normalizedCaption;
  }

  return [missingSegments.join('\n\n'), normalizedCaption].filter(Boolean).join('\n\n').trim();
}

function titleCase(value) {
  return String(value || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ');
}

function slugifyHashtag(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^#+/, '')
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function collectKeywordHits(text, dictionary) {
  return Object.entries(dictionary)
    .map(([key, keywords]) => ({
      key,
      score: keywords.reduce((total, keyword) => total + (text.includes(keyword) ? 1 : 0), 0)
    }))
    .sort((left, right) => right.score - left.score);
}

function pickDeterministic(items, seedSource) {
  if (!Array.isArray(items) || items.length === 0) {
    return '';
  }

  const seed = [...String(seedSource || 'seed')].reduce((total, char) => total + char.charCodeAt(0), 0);
  return items[seed % items.length];
}

function extractContext(intake) {
  const filename = path.basename(intake.filename || intake.imagePath || '');
  const combined = normalizeText(`${intake.body || ''} ${filename}`);
  const deityHits = collectKeywordHits(combined, DEITY_KEYWORDS);
  const themeHits = collectKeywordHits(combined, THEME_KEYWORDS);
  const deity = deityHits[0]?.score > 0 ? deityHits[0].key : 'default';
  const theme = themeHits[0]?.score > 0 ? themeHits[0].key : 'peace';

  return {
    deity,
    theme,
    combined,
    filename
  };
}

function pickCaptionMode(context, intake) {
  const source = normalizeText(`${intake.body || ''} ${context.filename || ''}`);
  const scoredModes = Object.entries(MODE_HINTS).map(([mode, hints]) => ({
    mode,
    score: hints.reduce((total, hint) => total + (source.includes(hint) ? 1 : 0), 0)
  }));
  scoredModes.sort((left, right) => right.score - left.score);

  if (scoredModes[0]?.score > 0) {
    return scoredModes[0].mode;
  }

  if (['love', 'healing', 'surrender', 'peace'].includes(context.theme)) {
    return 'devotional_emotion';
  }

  if (context.theme === 'playful') {
    return 'meme_one_liner';
  }

  return 'micro_story';
}

function buildKeywordLayer(context) {
  const baseSeoKeywords = [
    ...(DISCOVERY_TERMS[context.deity] || DISCOVERY_TERMS.default),
    ...(THEME_DISCOVERY_TERMS[context.theme] || THEME_DISCOVERY_TERMS.peace)
  ];
  const seoKeywords = [...new Set(baseSeoKeywords)].slice(0, 5);

  const hashtagSeeds = [
    ...(HASHTAG_SETS[context.deity] || HASHTAG_SETS.default),
    ...(THEME_HASHTAGS[context.theme] || []),
    'toonart'
  ];
  const hashtags = [...new Set(hashtagSeeds.map(slugifyHashtag).filter(Boolean))].slice(0, config.captioning.maxHashtags);

  return {
    seoKeywords,
    hashtags,
    narrativeAngle: `${titleCase(context.deity === 'default' ? 'sanatan' : context.deity)} x ${titleCase(context.theme)}`
  };
}

function sanitizeHashtags(input, fallback, maxCount = config.captioning.maxHashtags) {
  const values = Array.isArray(input) ? input : fallback;
  const cleaned = [...new Set(values.map(slugifyHashtag).filter(Boolean))];

  for (const tag of FALLBACK_HASHTAGS) {
    if (cleaned.length >= maxCount) {
      break;
    }

    if (!cleaned.includes(tag)) {
      cleaned.push(tag);
    }
  }

  return cleaned.slice(0, maxCount);
}

function sanitizeSeoKeywords(input, fallback, maxCount = 6) {
  const values = Array.isArray(input) ? input : fallback;
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))].slice(0, maxCount);
}

function normalizeCaptionVoice(lines) {
  return (Array.isArray(lines) ? lines : [])
    .map((line) => String(line || '').trim())
    .filter(Boolean)
    .map((line) => line
      .replace(/\baapko\b/gi, 'tumhe')
      .replace(/\baap bhi\b/gi, 'tum bhi')
      .replace(/\baap\b/gi, 'tum')
      .replace(/ke chale hue aage/gi, 'ke sahare')
      .replace(/sirf apne chale se nahi/gi, 'sirf naam se nahi')
      .replace(/tumhare saath hain/gi, 'tumhare saath rehte hain'));
}

function getDeitySeoLine(context) {
  const lines = {
    krishna: 'Krishna ji ka naam aate hi mann thoda aur shaant ho jaata hai.',
    shiva: 'Shiv ji ko yaad karke andar ka shor dheere dheere kam lagta hai.',
    rama: 'Ram bhakti kabhi sirf naam nahi hoti... woh sahara bhi deti hai.',
    hanuman: 'Hanuman ji ki yaad dil ko bas itna samjhaati hai... tum akela nahi ho.',
    durga: 'Maa ka ashirwad mehsoos ho, toh himmat khud aa jaati hai.',
    ganesha: 'Ganpati Bappa ka naam ho, toh rasta halka lagne lagta hai.',
    default: 'Bhagwan ka sahara ho, toh dil itna akela nahi lagta.'
  };

  return lines[context.deity] || lines.default;
}

function getContextualQuestion(context, mode) {
  if (mode === 'micro_story') {
    const questions = {
      krishna: 'Sach bolo... tum Radha Rani ho ya Krishna ji is situation me?',
      shiva: 'Sach bolo... tum Shiv ji side ho ya Maa Parvati side?',
      rama: 'Sach bolo... tum trust karte ho ya sab khud sambhalna chahte ho?',
      hanuman: 'Sach bolo... tumne bhi kabhi aisa sahara mehsoos kiya hai?',
      default: 'Sach bolo... tumhe bhi aisa lagta hai?'
    };

    return questions[context.deity] || questions.default;
  }

  const questions = {
    krishna: 'Tumhe bhi unhe dekhkar sab kuch thoda halka lagta hai?',
    shiva: 'Tum bhi Shiv ji ko yaad karke shaant ho jaate ho?',
    rama: 'Tum bhi Ram bhakti me waise hi sahara mehsoos karte ho?',
    hanuman: 'Sach bolo... Hanuman ji ka naam lete hi tumhe bhi himmat milti hai?',
    default: 'Sach bolo... tumhe bhi aisa lagta hai?'
  };

  return questions[context.deity] || questions.default;
}

function normalizeHandle(handle) {
  const value = String(handle || '').trim();
  if (!value) {
    return '@sanatan.dharma.ai';
  }

  return value.startsWith('@') ? value : `@${value}`;
}

function shortenPhrase(value, maxWords = 12) {
  const words = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);

  if (words.length <= maxWords) {
    return words.join(' ');
  }

  return `${words.slice(0, maxWords).join(' ')}...`;
}

function getInstagramEmoji(context) {
  const emojis = {
    krishna: '🤍',
    shiva: '💫',
    rama: '🙏',
    hanuman: '💪🏽',
    durga: '❤️',
    ganesha: '✨',
    default: '💛'
  };

  return emojis[context.deity] || emojis.default;
}

function getCaptionCreditLine(context, visualAssist) {
  const visualText = normalizeText([
    visualAssist?.analysis?.sceneSummary,
    visualAssist?.analysis?.storyMoment,
    visualAssist?.analysis?.captionFocus
  ].filter(Boolean).join(' '));

  if (context.deity === 'shiva') {
    if (visualText.includes('parvati') || visualText.includes('shakti')) {
      return 'Shiv🌸Shakti art';
    }
    return 'Shiv🌸Shakti art';
  }

  if (context.deity === 'krishna') {
    if (visualText.includes('radha')) {
      return 'Radha Krishna art';
    }
    return 'Krishna ji art';
  }

  if (context.deity === 'rama') {
    return 'Ram bhakti art';
  }

  if (context.deity === 'hanuman') {
    return 'Hanuman ji art';
  }

  if (context.deity === 'durga') {
    return 'Maa Shakti art';
  }

  if (context.deity === 'ganesha') {
    return 'Ganpati Bappa art';
  }

  return 'Sanatan art';
}

function buildLeadCaptionLine({ draft, context, visualAssist }) {
  const visual = visualAssist?.analysis || {};
  const hint = normalizeText([
    visual.sceneSummary,
    visual.storyMoment,
    visual.captionFocus,
    draft.hook,
    draft.body
  ].filter(Boolean).join(' '));

  const firstLine = String(draft.hook || draft.captionLines?.[0] || '').trim();
  if (firstLine) {
    return shortenPhrase(firstLine, 14);
  }

  if (context.deity === 'shiva') {
    if (hint.includes('parvati') || hint.includes('shakti')) {
      return 'Me, Maa Parvati 🌸 and Mahadev ❤️ in our little story';
    }
    return 'Love beyond imagination ❤️ Sacrifices without fear 🤍';
  }

  if (context.deity === 'krishna') {
    if (hint.includes('radha')) {
      return 'Radha Rani aur Krishna ji 🤍 in our little story';
    }
    return 'Unki muskaan mein bas sukoon hai.';
  }

  if (context.deity === 'hanuman') {
    return 'Hanuman ji ka naam aate hi dil sambhal jaata hai.';
  }

  if (context.deity === 'rama') {
    return 'Ram bhakti bas naam nahi... sahara bhi hai.';
  }

  if (context.theme === 'playful') {
    return 'Me, Maa Parvati 🌸 and Mahadev ❤️ in our little story';
  }

  return shortenPhrase(hint || 'Unki surat mein bas sukoon hai.', 14);
}

function buildExactInstagramCaption({ draft, context, visualAssist }) {
  const handle = normalizeHandle(config.account.handle);
  const leadLine = shortenPhrase(buildLeadCaptionLine({ draft, context, visualAssist }), 12);
  const creditLine = getCaptionCreditLine(context, visualAssist);
  const followEmoji = getInstagramEmoji(context);
  const hashtags = sanitizeHashtags(draft.hashtags, []);
  const hashtagLine = hashtags.map((tag) => `#${tag}`).join(' ');

  return enforceCaptionLength([
    `${handle} ${leadLine}`,
    '',
    `— made with love and devotion : ${creditLine}`,
    '',
    '.',
    '',
    `follow ${handle} for more ${followEmoji}`,
    '',
    '.',
    '',
    hashtagLine
  ].join('\n'));
}

function enhanceCaptionLines(lines, context, mode) {
  const normalized = normalizeCaptionVoice(lines);
  if (normalized.length === 0) {
    return normalized;
  }

  const joined = normalized.join(' ').toLowerCase();
  const deityTerms = {
    krishna: ['krishna ji', 'radha rani', 'vrindavan'],
    shiva: ['shiv ji', 'mahadev', 'maa parvati'],
    rama: ['ram bhakti', 'ram ji', 'siyaram'],
    hanuman: ['hanuman ji', 'bajrangbali', 'ram bhakti'],
    durga: ['maa', 'devi'],
    ganesha: ['ganpati', 'bappa'],
    default: ['bhagwan']
  };
  const hasDeityTerm = (deityTerms[context.deity] || deityTerms.default).some((term) => joined.includes(term));

  const output = [...normalized];
  if (!hasDeityTerm) {
    const insertIndex = Math.max(1, output.length - 1);
    output.splice(insertIndex, 0, getDeitySeoLine(context));
  }

  const lastLine = output[output.length - 1] || '';
  if (!lastLine.includes('?')) {
    output[output.length - 1] = getContextualQuestion(context, mode);
  }

  return output.slice(0, 12);
}

function splitForRhythm(lines) {
  const output = [];

  for (const line of Array.isArray(lines) ? lines : []) {
    const value = String(line || '').trim();
    if (!value) {
      continue;
    }

    if (value.includes(',') && value.length > 36) {
      const parts = value.split(',').map((item) => item.trim()).filter(Boolean);
      if (parts.length > 1) {
        output.push(...parts);
        continue;
      }
    }

    output.push(value);
  }

  return output.slice(0, 12);
}

function buildStyledCaptionFromLines(lines) {
  const compactLines = splitForRhythm(lines);
  const output = [];

  for (let index = 0; index < compactLines.length; index += 1) {
    const line = compactLines[index];
    output.push(line);

    const next = compactLines[index + 1] || '';
    const shouldBreak =
      /\.\.\.|[?]$/.test(line) ||
      /^Aur tum/i.test(line) ||
      /^Par sach/i.test(line) ||
      /^Har /i.test(line) ||
      /^Bhagwan/i.test(line) ||
      /^Krishna ji/i.test(line) ||
      /^Shiv ji/i.test(line) ||
      /^Hanuman ji/i.test(line) ||
      /^Ram bhakti/i.test(line) ||
      (index % 2 === 1 && next);

    if (shouldBreak && next) {
      output.push('');
    }
  }

  return enforceCaptionLength(output.join('\n'));
}

function enforceCaptionLength(text) {
  const compact = String(text || '').replace(/\n{3,}/g, '\n\n').trim();
  if (compact.length <= config.captioning.maxCaptionLength) {
    return compact;
  }

  return `${compact.slice(0, config.captioning.maxCaptionLength - 3).trim()}...`;
}

const SIMPLE_LEAD_BANK = {
  krishna: [
    'Krishna ji ka sukoon',
    'Radha Krishna love',
    'Unki muskaan mein bas sukoon',
    'Vrindavan wali softness',
    'Krishna ji ki bansuri'
  ],
  shiva: [
    'ShivShakti love',
    'Jai Mahadev',
    'Shiv ji ka sukoon',
    'Maa Parvati aur Shiv ji',
    'Har Har Mahadev'
  ],
  rama: [
    'Jai Shri Ram',
    'Ram bhakti',
    'SiyaRam ka sukoon',
    'Ram ji ka sahara',
    'Jai Shri Ram, bas'
  ],
  hanuman: [
    'Jai Hanuman',
    'Sankat Mochan',
    'Hanuman ji ka naam',
    'Bajrangbali ka sahara',
    'Hanuman ji ka sukoon'
  ],
  durga: [
    'Maa ka ashirwad',
    'Shakti ka sukoon',
    'Maa Durga love',
    'Maa ka sahara',
    'Jai Mata Di'
  ],
  ganesha: [
    'Ganpati Bappa',
    'Bappa ka sukoon',
    'Ganesh ji ka naam',
    'Bappa ka ashirwad',
    'Ganpati vibes'
  ],
  default: [
    'Sukoon wali energy',
    'Sanatan love',
    'Bhagwan ka sahara',
    'Bas thoda sukoon',
    'Dil ko shaanti'
  ]
};

const SIMPLE_SUPPORT_BANK = {
  krishna: [
    'Unki bansuri ka khayal hi mann halka kar deta hai.',
    'Krishna ji ka naam ho toh sab thoda soft lagta hai.',
    'Vrindavan wali hawa bas mehsoos hoti hai.'
  ],
  shiva: [
    'Maa Parvati aur Shiv ji ka pyaar bas sukoon deta hai.',
    'Unki jodi mein pyaar bhi hai, shaanti bhi.',
    'Shiv ji ka naam aate hi dil halka ho jaata hai.'
  ],
  rama: [
    'Ram bhakti bas andar ka shor halka kar deti hai.',
    'SiyaRam ka naam ho toh mann seedha sambhal jaata hai.',
    'Unka sahara ho toh sab thoda easy lagta hai.'
  ],
  hanuman: [
    'Sankat Mochan sabke dukh hare.',
    'Hanuman ji ka naam lete hi himmat aa jaati hai.',
    'Unka sahara ho toh darr halka lagta hai.'
  ],
  durga: [
    'Maa ka ashirwad ho toh himmat khud aa jaati hai.',
    'Shakti ka saath dil ko seedha khada kar deta hai.',
    'Maa Durga ka naam hi kaafi hai.'
  ],
  ganesha: [
    'Ganpati Bappa aate hi raasta halka lagta hai.',
    'Bappa ka naam ho toh dil sambhal jaata hai.',
    'Shuruat hi me ashirwad mil gaya.'
  ],
  default: [
    'Kabhi kabhi bas ek nazar hi kaafi hoti hai.',
    'Bhagwan ka naam ho toh dil halka ho jaata hai.',
    'Sukoon wahi se aata hai jahan dil ruk jaata hai.'
  ]
};

const SIMPLE_QUESTION_BANK = {
  krishna: [
    'Sach bolo... tumhe bhi unka sukoon feel hota hai?',
    'Tum bhi Radha Krishna wali softness feel karte ho?'
  ],
  shiva: [
    'Sach bolo... tum bhi is shanti ko feel karte ho?',
    'Tum bhi Shiv ji ka sukoon mehsoos karte ho?'
  ],
  rama: [
    'Sach bolo... tum bhi is bhakti mein sahara paate ho?',
    'Tumhe bhi Ram bhakti shaanti deti hai?'
  ],
  hanuman: [
    'Sach bolo... Hanuman ji ka naam lete hi tumhe bhi himmat milti hai?',
    'Tumhe bhi Hanuman ji ka sahara feel hota hai?'
  ],
  durga: [
    'Sach bolo... Maa ka naam lete hi tumhe bhi himmat milti hai?',
    'Tum bhi is shakti ko feel karte ho?'
  ],
  ganesha: [
    'Sach bolo... Bappa ka naam lete hi tumhe bhi sukoon milta hai?',
    'Tum bhi Ganpati ka ashirwad feel karte ho?'
  ],
  default: [
    'Sach bolo... tumhe bhi aisa lagta hai?',
    'Tum bhi is energy ko feel karte ho?'
  ]
};

const SIMPLE_CTA_BANK = [
  'follow {handle} for more {emoji}',
  'save this if it felt soft',
  'share this with someone who needs this'
];

const IMAGE_REFERENCE_BANK = {
  hanuman: {
    lead: [
      'Where Hanuman sits, fear ends.',
      'Silent strength, divine protection.',
      'In his silence, fear forgets its name.'
    ],
    support: [
      'Sankat Mochan sabke dukh hare ❤️',
      'Bajrangbali ka naam lete hi dil sambhal jaata hai.',
      'This kind of peace feels like protection.'
    ],
    reel: [
      'SILENT STRENGTH, DIVINE PROTECTION',
      'FEAR ENDS WHERE HANUMAN SITS',
      'PEACE THAT PROTECTS'
    ],
    hashtags: [
      'hanumanji',
      'bajrangbali',
      'hanumanbhakti',
      'devotionalart',
      'spiritualreels',
      'sankatmochan',
      'jaishriram',
      'ramdoot',
      'toonart',
      'templevibes',
      'innerpeace',
      'faithoverfear',
      'sanatandharma'
    ],
    seo: [
      'hanuman peace reel',
      'bajrangbali art',
      'hanuman protection reel',
      'sankat mochan caption',
      'hanuman bhakti reel',
      'devotional art reel',
      'silent protection art',
      'temple doorway reel'
    ],
    music: [
      'Soft devotional flute',
      'Calm Hanuman bhajan instrumental',
      'Temple bells ambience',
      'Slow cinematic devotional score'
    ]
  },
  shiva: {
    lead: [
      'Where Shiv ji rests, the noise goes quiet.',
      'Silent strength, soft protection.',
      'Shiv ji ki shanti dil ko rok leti hai.'
    ],
    support: [
      'Maa Parvati aur Shiv ji ka pyaar bas sukoon deta hai.',
      'Unki presence mein bas stillness mehsoos hoti hai.',
      'This kind of calm feels sacred.'
    ],
    reel: [
      'SILENCE THAT PROTECTS',
      'SHIVSHAKTI, SOFT AND STRONG',
      'PEACE THAT STAYS'
    ],
    hashtags: [
      'shivji',
      'shivshakti',
      'maaparvati',
      'devotionalart',
      'toonart',
      'spiritualreels',
      'bhaktiart',
      'mahadev',
      'peacefulart',
      'stillness',
      'dharma',
      'templevibes',
      'innerpeace',
      'sanatandharma'
    ],
    seo: [
      'shiv shakti reel',
      'mahadev art',
      'shiva peace reel',
      'maa parvati caption',
      'devotional shiva art',
      'calm spiritual reel',
      'silent shiva edit',
      'divine protection art'
    ],
    music: [
      'Soft bhajan instrumental',
      'Temple flute ambience',
      'Cinematic devotional pad',
      'Slow spiritual lo-fi'
    ]
  },
  krishna: {
    lead: [
      'Where Krishna smiles, the heart softens.',
      'Unki muskaan mein bas sukoon hai.',
      'Vrindavan ki hawa yahi se mehsoos hoti hai.'
    ],
    support: [
      'Krishna ji ka naam aate hi mann halka ho jaata hai.',
      'Unki bansuri ka khayal bhi enough hai.',
      'This softness feels like home.'
    ],
    reel: [
      'SOFTNESS THAT STAYS',
      'KRISHNA JI, PURE CALM',
      'PEACE IN A SMILE'
    ],
    hashtags: [
      'krishnaji',
      'radhakrishna',
      'vrindavan',
      'devotionalart',
      'spiritualreels',
      'bhaktiart',
      'toonart',
      'flutevibes',
      'innerpeace',
      'divinelove',
      'krishnabhakti',
      'sanatandharma'
    ],
    seo: [
      'krishna peace reel',
      'radha krishna art',
      'vrindavan reel',
      'krishna devotional caption',
      'soft bhakti art',
      'calm spiritual reel',
      'bansuri vibe',
      'divine love art'
    ],
    music: [
      'Soft flute devotional',
      'Krishna bhajan instrumental',
      'Warm indie calm vibe',
      'Cinematic soft devotional score'
    ]
  },
  rama: {
    lead: [
      'Jahan Ram ka naam ho, wahan dil sambhal jaata hai.',
      'Faith feels lighter with Ram ji nearby.',
      'Jai Shri Ram, bas itna kaafi hai.'
    ],
    support: [
      'Ram bhakti dil ko seedha shaant kar deti hai.',
      'SiyaRam ka sahara ho toh sab halka lagta hai.',
      'This steadiness feels blessed.'
    ],
    reel: [
      'FAITH THAT CALMS',
      'JAI SHRI RAM, ALWAYS',
      'STEADY, SOFT, SACRED'
    ],
    hashtags: [
      'jaishreeram',
      'siyaram',
      'ramji',
      'devotionalart',
      'toonart',
      'spiritualreels',
      'bhaktiart',
      'ramdoot',
      'faith',
      'innerpeace',
      'dharma',
      'templevibes',
      'sanatandharma'
    ],
    seo: [
      'jai shri ram reel',
      'ram bhakti art',
      'siyaram caption',
      'devotional ram reel',
      'faith reel',
      'calm spiritual art',
      'ram ji caption',
      'peaceful bhakti edit'
    ],
    music: [
      'Soft bhajan instrumental',
      'Calm devotional flute',
      'Cinematic temple ambience',
      'Gentle indie-soft vibe'
    ]
  },
  default: {
    lead: [
      'Silent devotion always lands softly.',
      'This frame feels like a blessing.',
      'Peace shows up quietly here.'
    ],
    support: [
      'Sometimes the stillest frame says the most.',
      'This kind of calm stays with you.',
      'This feels sacred.'
    ],
    reel: [
      'SILENT DEVOTION',
      'SOFT PEACE',
      'STILL SACRED'
    ],
    hashtags: [
      'devotionalart',
      'spiritualreels',
      'bhaktiart',
      'innerpeace',
      'toonart',
      'faith',
      'blessing',
      'meditation',
      'sacredart',
      'calm',
      'dharma',
      'sanatandharma'
    ],
    seo: [
      'devotional art reel',
      'spiritual reel',
      'calm devotional caption',
      'peaceful art reel',
      'toon art devotion',
      'sacred frame caption',
      'faith and peace',
      'blessing reel'
    ],
    music: [
      'Soft devotional flute',
      'Ambient temple bells',
      'Slow cinematic calm',
      'Gentle indie-soft vibe'
    ]
  }
};

const DIRECT_LEAD_OVERRIDES = [
  {
    matches: ['shiv shakti love', 'shivshakti love', 'shiv shakti', 'shivshakti'],
    value: 'ShivShakti love'
  },
  {
    matches: ['jai hanuman', 'jai hanumaan', 'hanuman ji', 'bajrangbali'],
    value: 'Jai Hanuman'
  },
  {
    matches: ['sankat mochan'],
    value: 'Sankat Mochan'
  },
  {
    matches: ['jai shri ram', 'jai shree ram', 'siyaram', 'siya ram'],
    value: 'Jai Shri Ram'
  },
  {
    matches: ['radha krishna', 'krishna ji', 'vrindavan', 'kanha'],
    value: 'Krishna ji ka sukoon'
  },
  {
    matches: ['maa parvati', 'mahadev', 'shiv ji'],
    value: 'Shiv ji ka sukoon'
  }
];

function buildVisualCueText(intake, context, visualAssist) {
  return normalizeText([
    intake?.body,
    context?.filename,
    visualAssist?.analysis?.sceneSummary,
    visualAssist?.analysis?.emotionalSignal,
    visualAssist?.analysis?.deitySignal,
    visualAssist?.analysis?.storyMoment,
    visualAssist?.analysis?.captionFocus
  ].filter(Boolean).join(' '));
}

function pickSimpleBankEntry(bank, seed) {
  return pickDeterministic(bank, seed);
}

function pickDirectLeadLine(intakeBody, cueText) {
  const directBody = normalizeText(intakeBody);
  const directCue = normalizeText(cueText);
  const combined = `${directBody} ${directCue}`.trim();

  for (const candidate of DIRECT_LEAD_OVERRIDES) {
    if (candidate.matches.some((match) => combined.includes(match))) {
      return candidate.value;
    }
  }

  const shortText = directBody.split(' ').filter(Boolean).length <= 4 && directBody.length <= 34;
  if (shortText) {
    return titleCase(directBody);
  }

  return '';
}

function buildSimpleLeadLine({ intake, context, visualAssist }) {
  const cueText = buildVisualCueText(intake, context, visualAssist);
  const directLead = pickDirectLeadLine(intake.body, cueText);
  if (directLead) {
    return directLead;
  }

  const bank = SIMPLE_LEAD_BANK[context.deity] || SIMPLE_LEAD_BANK.default;
  return pickSimpleBankEntry(bank, `${intake?.id || ''}-${cueText || context.deity || 'seed'}`);
}

function buildSimpleSupportLine({ intake, context, visualAssist }) {
  const cueText = buildVisualCueText(intake, context, visualAssist);
  const bank = SIMPLE_SUPPORT_BANK[context.deity] || SIMPLE_SUPPORT_BANK.default;

  if (context.deity === 'hanuman' && cueText.includes('sankat')) {
    return 'Sankat Mochan sabke dukh hare.';
  }

  if (context.deity === 'shiva' && (cueText.includes('parvati') || cueText.includes('shakti'))) {
    return 'Maa Parvati aur Shiv ji ka pyaar bas sukoon deta hai.';
  }

  return pickSimpleBankEntry(bank, `${context.deity}-${context.theme}-${cueText}`);
}

function buildSimpleQuestionLine({ intake, context, visualAssist }) {
  const cueText = buildVisualCueText(intake, context, visualAssist);
  const bank = SIMPLE_QUESTION_BANK[context.deity] || SIMPLE_QUESTION_BANK.default;
  return pickSimpleBankEntry(bank, `${intake?.messageId || intake?.id || ''}-${cueText}`);
}

function buildSimpleHashtagLine(hashtags, maxCount = 5) {
  return sanitizeHashtags(hashtags, [], maxCount).map((tag) => `#${tag}`).join(' ');
}

function pickImageReferenceBank(context) {
  return IMAGE_REFERENCE_BANK[context.deity] || IMAGE_REFERENCE_BANK.default;
}

function pickImageReferenceLine(lines, seed) {
  return pickSimpleBankEntry(lines, seed);
}

function buildImageReferenceLeadLine({ intake, context, visualAssist }) {
  const bank = pickImageReferenceBank(context);
  const cue = buildVisualCueText(intake, context, visualAssist);
  const normalizedBody = normalizeText(intake?.body);

  if (context.deity === 'krishna' && normalizedBody.includes('radha') && normalizedBody.includes('krishna')) {
    return 'Radhe Krishna ❤️';
  }

  if (context.deity === 'shiva' && (normalizedBody.includes('shivshakti') || normalizedBody.includes('shiv shakti'))) {
    return 'ShivShakti love ❤️';
  }

  if (context.deity === 'hanuman' && normalizedBody.includes('hanuman')) {
    return 'Jai Hanuman';
  }

  return pickImageReferenceLine(bank.lead, `${context.deity}-lead-${cue}`);
}

function buildImageReferenceSupportLine({ intake, context, visualAssist }) {
  const bank = pickImageReferenceBank(context);
  const cue = buildVisualCueText(intake, context, visualAssist);
  const normalizedBody = normalizeText(intake?.body);

  if (context.deity === 'hanuman' && (normalizedBody.includes('jai hanuman') || normalizedBody.includes('hanuman'))) {
    return 'Jai Hanuman. Sankat Mochan sabke dukh hare ❤️';
  }

  if (context.deity === 'shiva' && (normalizedBody.includes('shivshakti') || normalizedBody.includes('maaparvati'))) {
    return 'ShivShakti love. Maa Parvati aur Shiv ji ka pyaar bas sukoon deta hai.';
  }

  if (context.deity === 'krishna' && normalizedBody.includes('yamuna')) {
    return 'the divine love story at Yamuna kinare. ❤️';
  }

  if (context.deity === 'krishna' && (normalizedBody.includes('krishna') || normalizedBody.includes('radha'))) {
    return 'Krishna ji ka naam aate hi mann halka ho jaata hai.';
  }

  return pickImageReferenceLine(bank.support, `${context.deity}-support-${cue}-${normalizedBody}`);
}

function buildImageReferenceReelText({ intake, context, visualAssist }) {
  const bank = pickImageReferenceBank(context);
  const cue = buildVisualCueText(intake, context, visualAssist);
  return pickImageReferenceLine(bank.reel, `${context.deity}-reel-${cue}`);
}

function buildImageReferenceSeoKeywords({ context, visualAssist }) {
  const bank = pickImageReferenceBank(context);
  const cue = buildVisualCueText(null, context, visualAssist);
  return sanitizeSeoKeywords(bank.seo, bank.seo, 8).concat(
    cue.includes('peace') ? ['peace reel', 'calm devotional reel'] : []
  ).slice(0, 10);
}

function buildImageReferenceMusicSuggestions({ context }) {
  const bank = pickImageReferenceBank(context);
  return bank.music.slice(0, 4);
}

function buildSimpleCaptionLines({ intake, context, visualAssist, keywordLayer, leadLine, supportLine, questionLine }) {
  const handle = normalizeHandle(config.account.handle);
  const followEmoji = getInstagramEmoji(context);
  const hashtagLine = buildSimpleHashtagLine(keywordLayer.hashtags, 5);
  const followLine = SIMPLE_CTA_BANK[0]
    .replace('{handle}', handle)
    .replace('{emoji}', followEmoji);

  return [
    `${handle} ${leadLine}`.trim(),
    supportLine,
    questionLine,
    followLine,
    hashtagLine
  ].filter(Boolean);
}

function buildSimpleReelText({ intake, context, visualAssist }) {
  const bank = pickImageReferenceBank(context);
  return [pickImageReferenceLine(bank.reel, `${context.deity}-reel-${buildVisualCueText(intake, context, visualAssist)}`)];
}

function buildLocalVisualAssist({ intake, context, mode }) {
  const cueText = buildVisualCueText(intake, context, null);
  const emotionalSignal = cueText.includes('peace') || cueText.includes('sukoon') || cueText.includes('calm')
    ? 'calm'
    : cueText.includes('fear') || cueText.includes('sankat') || cueText.includes('dukh')
      ? 'support'
      : cueText.includes('love') || cueText.includes('pyaar')
        ? 'love'
        : 'soft';

  const storyMoment = context.deity === 'hanuman'
    ? 'protective support and strength'
    : context.deity === 'shiva'
      ? 'quiet devotion and balance'
      : context.deity === 'krishna'
        ? 'gentle love and calm'
        : context.deity === 'rama'
          ? 'faith and reassurance'
          : 'soft devotional moment';

  return {
    used: false,
    provider: 'rule-template',
    model: null,
    analysis: {
      sceneSummary: cueText || `${context.deity} ${context.theme}`.trim(),
      emotionalSignal,
      deitySignal: titleCase(context.deity || 'default'),
      storyMoment,
      captionFocus: mode,
      stopReason: 'Local image and text cues were sufficient for captioning.'
    },
    reason: 'Local image and text cues were sufficient for captioning.'
  };
}

function buildSimpleCaptionDraft({ intake, context, mode, keywordLayer, visualAssist }) {
  const leadLine = buildImageReferenceLeadLine({ intake, context, visualAssist });
  const supportLine = buildImageReferenceSupportLine({ intake, context, visualAssist });
  const reelText = buildSimpleReelText({ intake, context, visualAssist });
  const followLine = `follow ${normalizeHandle(config.account.handle)} for more ${getInstagramEmoji(context)}`;
  const captionLines = [
    leadLine,
    supportLine,
    followLine
  ];

  return {
    provider: 'rule-template',
    model: visualAssist?.model || null,
    visualAssist,
    mode: 'image_reference',
    captionStrategy: 'devotional_emotion + image_reference',
    hook: leadLine,
    body: supportLine,
    cta: followLine,
    reelText,
    captionLines,
    hashtags: sanitizeHashtags(pickImageReferenceBank(context).hashtags, [], 5),
    seoKeywords: buildImageReferenceSeoKeywords({ context, visualAssist }),
    musicSuggestions: buildImageReferenceMusicSuggestions({ context }),
    titleHint: `${titleCase(context.deity === 'default' ? 'Sanatan' : context.deity)} Peace reel`
  };
}

function buildDevotionalBody(context) {
  if (context.deity === 'hanuman') {
    return [
      'Jab sab kuch bhaari lagta hai...',
      'Hanuman ji ka naam yaad aata hai.',
      'Aur dil ko lagta hai...',
      'koi mazbooti se saath khada hai.'
    ].join('\n');
  }

  const byTheme = {
    surrender: [
      `${titleCase(context.deity === 'default' ? 'sanatan' : context.deity)} ko yaad karke lagta hai sab unke hawale kar dena chahiye.`,
      'Kabhi kabhi bas itna bharosa hi kaafi hota hai.'
    ],
    healing: [
      'Thoda sa bhakti ka ehsaas aur dil ka bojh halka lagne lagta hai.',
      'Jaise unhone chupchaap sambhal liya ho.'
    ],
    confidence: [
      'Jab unka naam saath ho, toh himmat waise hi aa jaati hai.',
      'Bina shor ke bhi.'
    ],
    peace: [
      'Krishna ji ki bansuri ka khayal aate hi Vrindavan ki hawa mehsoos hone lagti hai.',
      'Duniya ka saara bojh thodi der ke liye halka lagta hai.'
    ],
    love: [
      'Unke beech ka pyaar dekho, toh lagta hai sneh bhi bhakti ka roop hota hai.',
      `${context.deity === 'krishna' ? 'Radha Krishna' : titleCase(context.deity)} ki komalta alag hi mehsoos hoti hai.`
    ],
    playful: [
      'Thoda sa pyaara pal, thodi si muskaan, aur poora sa bhakti wala pyaar.',
      'Isi liye aise drishya seedha dil mein ruk jaate hain.'
    ]
  };

  return (byTheme[context.theme] || byTheme.peace).join('\n');
}

function buildMemeBody(context) {
  const byDeity = {
    shiva: [
      'Me, Maa Parvati and Mahadev in our little story.',
      '',
      'Maa Parvati fir se Shiv ji ko pyaar se samjha rahi hain.'
    ],
    krishna: [
      'Aaj Krishna ji bade hi pyare lag rahe the.',
      '',
      'Aur hum bas unhe dekhkar muskura diye.'
    ],
    default: [
      'Yeh chhota sa pal seedha share karne layak tha.',
      '',
      'Pyaara bhi. Sanatani bhi.'
    ]
  };

  return (byDeity[context.deity] || byDeity.default).join('\n');
}

function buildStoryBody(context) {
  const byDeity = {
    krishna: [
      'Aaj Vrindavan me kuch alag hua.',
      '',
      'Krishna ji chup the.',
      'Radha Rani bas unhe dekh rahi thi.',
      '',
      'Phir unhone bas halki si muskaan di.'
    ],
    shiva: [
      'Aaj Kailash par thoda alag sa drishya tha.',
      '',
      'Shiv ji chup the.',
      'Maa Parvati bas dekh rahi thi.',
      '',
      'Kabhi kabhi bina bole bhi sab samajh aa jaata hai.'
    ],
    hanuman: [
      'Aaj bas Hanuman ji ki aarti yaad aa gayi.',
      '',
      'Mann pehle bahut bhaari tha.',
      'Phir dheere dheere halka lagne laga.',
      '',
      'Jaise unhone bas kandhe par haath rakh diya ho.'
    ],
    default: [
      'Aaj is chhoti si kahani mein bas ehsaas zyada tha.',
      '',
      'Shabd kam the.',
      'Par baat dil tak pahunch gayi.'
    ]
  };

  return (byDeity[context.deity] || byDeity.default).join('\n');
}

function buildContextualCta(mode, context, intake) {
  if (mode === 'micro_story') {
    const byDeity = {
      krishna: [
        'Sach bolo... tum Radha rani ho ya Krishnaji is situation me?',
        'Tum hote toh pehle kaun maanta?',
        'Aage ka part chahiye toh batao.'
      ],
      shiva: [
        'Sach bolo... tum Shiv ji side ho ya Maa Parvati side?',
        'Tum hote toh pehle kaun manata?',
        'Aise aur little stories chahiye?'
      ],
      rama: [
        'Sach bolo... tum Ram ji jaisa reaction dete ya nahi?',
        'Tum hote toh kya bolte?',
        'Aage ka part chahiye toh batao.'
      ],
      default: [
        'Tum hote toh kya bolte?',
        'Aage ka part chahiye toh batao.',
        'Sach bolo... yeh scene samajh gaye na?'
      ]
    };

    return pickDeterministic(byDeity[context.deity] || byDeity.default, `${intake.id}-${mode}-${context.deity}`);
  }

  return pickDeterministic(CTA_LINES[mode] || CTA_LINES.devotional_emotion, `${intake.id}-${mode}`);
}

function buildFallbackDraft({ intake, context, mode, keywordLayer }) {
  const hook = pickDeterministic(HOOKS[context.deity] || HOOKS.default, intake.messageId || intake.filename);
  const cta = buildContextualCta(mode, context, intake);
  const body = mode === 'meme_one_liner'
    ? buildMemeBody(context)
    : mode === 'micro_story'
      ? buildStoryBody(context)
      : buildDevotionalBody(context);
  const reelTextByTheme = {
    surrender: ['LET IT GO', 'your delays', 'your doubts', 'your confusion', 'Bhagwan is still working'],
    healing: ['YOU’RE STILL HERE', 'your heartbreak', 'your losses', 'your fears', 'that matters'],
    confidence: ['YOU ARE ENOUGH', 'your failures', 'your comparison', 'your doubts', 'Bhagwan still chose you'],
    peace: ['BREATHE FIRST', 'your confusion', 'your noise', 'your fears', 'peace is still possible'],
    love: ['SOME LOVE HEALS', 'your waiting', 'your silence', 'your doubts', 'softness is strength'],
    playful: ['THIS FELT DIFFERENT', 'your mood', 'your smile', 'your little moment', 'keep this peace']
  };
  const captionLines = formatCaption({
    hook,
    body,
    cta,
    hashtags: keywordLayer.hashtags
  }).split('\n');

  return {
    mode,
    hook,
    body,
    cta,
    reelText: reelTextByTheme[context.theme] || reelTextByTheme.peace,
    captionLines,
    hashtags: keywordLayer.hashtags,
    seoKeywords: keywordLayer.seoKeywords,
    musicSuggestions: [
      'Soft indie: Anuv Jain / Prateek Kuhad vibe',
      'Devotional calm: Krishna flute / soft bhajan'
    ],
    titleHint: `${titleCase(context.deity === 'default' ? 'Sanatan' : context.deity)} ${titleCase(context.theme)} reel`
  };
}

function formatCaption(draft) {
  const caption = [
    String(draft.hook || '').trim(),
    String(draft.body || '').trim(),
    String(draft.cta || '').trim(),
    sanitizeHashtags(draft.hashtags, []).map((tag) => `#${tag}`).join(' ')
  ]
    .filter(Boolean)
    .join('\n\n');

  return enforceCaptionLength(caption);
}

function buildReasoning({ draft, provider, keywordLayer, visualAssist }) {
  const lines = [
    visualAssist?.used
      ? 'Image assist summarized the frame and biased the caption toward the visible scene.'
      : 'Local image and text cues were enough to shape the caption without a long model draft.',
    `Rule layer compressed the caption into a short hook, a single support line, a CTA, and ${draft.hashtags?.length || config.captioning.maxHashtags} hashtags.`,
    `Keyword layer kept discovery terms around ${keywordLayer.narrativeAngle.toLowerCase()} without turning the visible caption into SEO copy.`
  ];

  if (visualAssist?.used && visualAssist.analysis?.sceneSummary) {
    lines.push(`Image cue: ${visualAssist.analysis.sceneSummary}.`);
  }

  if (draft.provider && draft.provider !== 'rule-template') {
    lines.push(`Provider mode: ${draft.provider}.`);
  }

  if (draft.model) {
    lines.push(`Model used: ${draft.model}.`);
  }

  return lines;
}

export async function buildCaptionPlan(intake) {
  const context = extractContext(intake);
  const mode = pickCaptionMode(context, intake);
  const keywordLayer = buildKeywordLayer(context);
  const providerStatus = getCaptionProviderStatus();
  const remoteCaptioningDisabled = String(process.env.DISABLE_REMOTE_CAPTIONING || '').toLowerCase() === 'true';
  let visualAssist = null;
  let fallbackReason = null;
  let draft = null;

  if (!remoteCaptioningDisabled && providerStatus.configured) {
    try {
      draft = await generateCloudflareCaptionDraft({
        intake,
        context,
        mode,
        keywordLayer
      });
      visualAssist = draft?.visualAssist || null;
    } catch (error) {
      fallbackReason = error instanceof Error ? error.message : String(error);
    }
  }

  if (!draft && providerStatus.configured && String(intake?.mediaKind || '').toLowerCase() === 'image' && intake?.imagePath) {
    try {
      visualAssist = await generateVisualAssist({
        intake,
        context,
        mode,
        keywordLayer,
        provider: providerStatus
      });
    } catch (error) {
      fallbackReason = error instanceof Error ? error.message : String(error);
    }
  }

  if (!visualAssist) {
    visualAssist = buildLocalVisualAssist({ intake, context, mode });
  }

  if (!draft) {
    draft = buildSimpleCaptionDraft({
      intake,
      context,
      mode,
      keywordLayer,
      visualAssist
    });
  }

  if (fallbackReason && visualAssist?.reason) {
    fallbackReason = `${fallbackReason}; ${visualAssist.reason}`;
  } else if (!fallbackReason && visualAssist?.reason) {
    fallbackReason = visualAssist.reason;
  }

  const hashtagLimit = 5;
  const seoKeywordLimit = draft.mode === 'image_reference' ? 8 : 6;
  const hashtags = sanitizeHashtags(draft.hashtags, keywordLayer.hashtags, hashtagLimit);
  const seoKeywords = sanitizeSeoKeywords(draft.seoKeywords, keywordLayer.seoKeywords, seoKeywordLimit);
  const normalizedDraft = {
    ...draft,
    mode: draft.mode || mode,
    reelText: Array.isArray(draft.reelText) ? draft.reelText.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 2) : [],
    captionLines: Array.isArray(draft.captionLines)
      ? draft.captionLines.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 3)
      : [],
    hook: String(draft.hook || '').trim(),
    body: String(draft.body || '').trim(),
    cta: String(draft.cta || `follow ${normalizeHandle(config.account.handle)} for more ${getInstagramEmoji(context)}`).trim(),
    titleHint: String(draft.titleHint || `${titleCase(context.deity)} ${titleCase(context.theme)} reel`).trim(),
    hashtags,
    seoKeywords,
    musicSuggestions: Array.isArray(draft.musicSuggestions)
      ? draft.musicSuggestions.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 2)
      : [],
    visualAssist: draft.visualAssist || visualAssist || null
  };
  const captionLines = [
    normalizedDraft.hook,
    normalizedDraft.body,
    normalizedDraft.cta,
    normalizedDraft.hashtags.map((tag) => `#${tag}`).join(' ')
  ]
    .filter(Boolean)
    .map((line) => String(line || '').trim());

  const caption = ensureQuotedCaptionSegments(captionLines.join('\n\n').trim(), intake.body || '');

  return {
    caption,
    reelText: normalizedDraft.reelText,
    captionLines,
    hashtags,
    seoKeywords,
    musicSuggestions: normalizedDraft.musicSuggestions,
    hook: normalizedDraft.hook,
    mode: normalizedDraft.mode,
    captionStrategy: normalizedDraft.captionStrategy || null,
    titleHint: normalizedDraft.titleHint,
    context,
    sourceText: intake.body || '',
    keywordLayer,
    provider: {
      type: normalizedDraft.provider,
      model: normalizedDraft.model,
      configured: providerStatus.configured,
      fallbackReason
    },
    reasoning: buildReasoning({
      draft: normalizedDraft,
      provider: normalizedDraft.provider,
      keywordLayer,
      visualAssist: normalizedDraft.visualAssist
    }),
    visualAssist: normalizedDraft.visualAssist || null
  };
}

export const __test__ = {
  extractQuotedCaptionSegments,
  ensureQuotedCaptionSegments
};
