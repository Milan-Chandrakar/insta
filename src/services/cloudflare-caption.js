import fs from 'node:fs/promises';
import sharp from 'sharp';
import { config } from '../config.js';
import { addApiLog, extractInterestingHeaders } from './api-logs.js';
import { fetchWithPolicy } from './http-client.js';

const CAPTION_RESPONSE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['mode', 'reelText', 'hook', 'body', 'hashtags', 'seoKeywords', 'titleHint'],
  properties: {
    mode: {
      type: 'string',
      enum: ['image_reference', 'micro_story', 'meme_one_liner', 'devotional_emotion']
    },
    reelText: {
      type: 'array',
      minItems: 1,
      maxItems: 2,
      items: {
        type: 'string',
        minLength: 3,
        maxLength: 80
      }
    },
    hook: {
      type: 'string',
      minLength: 2,
      maxLength: 70
    },
    body: {
      type: 'string',
      minLength: 4,
      maxLength: 140
    },
    cta: {
      type: 'string',
      minLength: 4,
      maxLength: 90
    },
    hashtags: {
      type: 'array',
      minItems: 3,
      maxItems: 5,
      items: {
        type: 'string',
        minLength: 2,
        maxLength: 40
      }
    },
    seoKeywords: {
      type: 'array',
      minItems: 4,
      maxItems: 8,
      items: {
        type: 'string',
        minLength: 3,
        maxLength: 80
      }
    },
    musicSuggestions: {
      type: 'array',
      minItems: 0,
      maxItems: 2,
      items: {
        type: 'string',
        minLength: 3,
        maxLength: 120
      }
    },
    titleHint: {
      type: 'string',
      minLength: 6,
      maxLength: 120
    }
  }
};

const STYLE_EXAMPLES = [
  {
    mode: 'devotional_emotion',
    caption: [
      'Unki muskaan mein bas sukoon hai.',
      '',
      'Krishna ji ki bansuri ki awaaz ka khayal aate hi mann seedha Vrindavan pahunch jaata hai.',
      'Jaise sab bhaag-daud thodi der ke liye ruk gayi ho.',
      '',
      'Tumhe bhi aisa lagta hai?',
      '',
      '#sanatandharma #krishnaji #vrindavan #toonart'
    ].join('\n')
  },
  {
    mode: 'micro_story',
    caption: [
      '“Maan jao Radha Rani...”',
      '',
      'Aaj Vrindavan mein kuch alag hua.',
      'Krishna ji chup the.',
      'Radha Rani gusse mein thi.',
      '',
      'Phir unhone bas muskura ke dekha...',
      '',
      'Sach bolo... tum Radha Rani ho ya Krishna ji is situation mein?',
      '',
      '#sanatandharma #krishnaji #radharani #toonart'
    ].join('\n')
  },
  {
    mode: 'meme_one_liner',
    caption: [
      'Me, Maa Parvati and Mahadev in our little story.',
      '',
      'Maa Parvati phir se Shiv ji ko samjha rahi hain.',
      '',
      'Ye scene kis kis ko relatable laga?',
      '',
      '#sanatandharma #shivstatus #maaparvati #toonart'
    ].join('\n')
  },
  {
    mode: 'devotional_emotion',
    caption: [
      'Unke chehre ko dekhkar lagta hai sab theek ho jayega.',
      '',
      'Kabhi kabhi bhakti bas itni si hoti hai...',
      'ek nazar, ek muskaan, aur dil ko poora sukoon.',
      '',
      'Aapko bhi unhe dekhkar shanti milti hai?',
      '',
      '#sanatandharma #krishnaji #bhakti #toonart'
    ].join('\n')
  },
  {
    mode: 'micro_story',
    caption: [
      'Aaj unhone kuch kaha nahi.',
      '',
      'Bas paas khade rahe.',
      'Aur Radha Rani ka gussa dheere dheere khud hi pighal gaya.',
      '',
      'Kabhi kabhi manaane se zyada, saath rehna kaafi hota hai.',
      '',
      'Tum hote toh pehle kaun maanta?',
      '',
      '#sanatandharma #radhakrishna #vrindavan #toonart'
    ].join('\n')
  },
  {
    mode: 'devotional_emotion',
    caption: [
      'Unki surat mein sirf pyaar hai.',
      '',
      'Krishna ji ko dekhkar lagta hai duniya kitni bhi tez ho,',
      'mann ko shanti mil hi jaati hai.',
      '',
      'Tum bhi unhe dekhkar ruk jaate ho na?',
      '',
      '#sanatandharma #krishnaji #innerpeace #toonart'
    ].join('\n')
  },
  {
    mode: 'meme_one_liner',
    caption: [
      'Shiv ji side-eye de rahe the aur Maa Parvati sab samajh rahi thi.',
      '',
      'Bas isi liye inki jodi itni pyari lagti hai.',
      '',
      'Sach bolo... tum kis side ho?',
      '',
      '#sanatandharma #mahadev #maaparvati #toonart'
    ].join('\n')
  },
  {
    mode: 'micro_story',
    caption: [
      'Vrindavan wali hawa tab aur pyari lagti hai...',
      '',
      'jab Krishna ji ki bansuri aur Radha Rani ki nazar ek hi frame mein ho.',
      '',
      'Kuch kahaniyan likhi nahi jaati, sirf mehsoos hoti hain.',
      '',
      'Aisi aur little stories chahiye?',
      '',
      '#sanatandharma #vrindavan #radhakrishna #toonart'
    ].join('\n')
  },
  {
    mode: 'devotional_emotion',
    caption: [
      'Unhe dekhkar dil automatically naram ho jaata hai.',
      '',
      'Yehi toh Krishna ji ki baat hai...',
      'shor ke bina bhi dil tak pahunch jaate hain.',
      '',
      'Aap bhi unki taraf waise hi kheench jaate ho?',
      '',
      '#sanatandharma #krishnaji #bhakti #vrindavan'
    ].join('\n')
  },
  {
    mode: 'meme_one_liner',
    caption: [
      'Krishna ji aaj full cute mode mein the.',
      '',
      'Aur hum bas dekhkar smile karte reh gaye.',
      '',
      'Ye reel seedha kisko bhejoge?',
      '',
      '#sanatandharma #krishnaji #toonart #lovepostsdaily'
    ].join('\n')
  },
  {
    mode: 'devotional_emotion',
    caption: [
      'Jab sab kuch hilta hua lagta hai...',
      '',
      'Hanuman ji ka naam yaad aata hai.',
      'Aur dil ko lagta hai...',
      'koi toh mazbooti se saath khada hai.',
      '',
      'Sach bolo...',
      'tumne bhi kabhi unka sahara mehsoos kiya hai?',
      '',
      '#sanatandharma #hanumanji #bajrangbali #toonart'
    ].join('\n')
  },
  {
    mode: 'devotional_emotion',
    caption: [
      'Me, Maa Parvati 🌸 and Mahadev ❤️ in our little story',
      '',
      'Maa scolds Shiv ji for troubling her bhakts 😁',
      '',
      '.',
      '',
      'follow @sanatan.dharma.ai for more 🙏',
      '',
      '.',
      '',
      '#sanatandharma #shivstatus #maaparvati #toonart #blesseddays'
    ].join('\n')
  },
  {
    mode: 'devotional_emotion',
    caption: [
      'Unki muskaan mein bas sukoon hai.',
      '',
      '— made with love and devotion : Krishna ji art',
      '',
      '.',
      '',
      'follow @sanatan.dharma.ai for more 🤍',
      '',
      '.',
      '',
      '#sanatandharma #krishnaji #vrindavan #toonart #bhakti'
    ].join('\n')
  }
];

const VISUAL_ASSIST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sceneSummary', 'emotionalSignal', 'deitySignal', 'storyMoment', 'captionFocus', 'stopReason'],
  properties: {
    sceneSummary: {
      type: 'string',
      minLength: 8,
      maxLength: 220
    },
    emotionalSignal: {
      type: 'string',
      minLength: 4,
      maxLength: 80
    },
    deitySignal: {
      type: 'string',
      minLength: 3,
      maxLength: 80
    },
    storyMoment: {
      type: 'string',
      minLength: 6,
      maxLength: 160
    },
    captionFocus: {
      type: 'string',
      minLength: 6,
      maxLength: 160
    },
    stopReason: {
      type: 'string',
      minLength: 6,
      maxLength: 160
    }
  }
};

function normalizeString(value) {
  return String(value || '').trim();
}

function buildSystemPrompt(account) {
  return [
    'You are a viral Instagram content creator for soft spiritual + emotional healing reels based on Sanatan Dharma aesthetics.',
    '',
    'Your task is to generate HIGHLY engaging reel text + caption in a calm, relatable, and aesthetic style.',
    '',
    'STYLE UNDERSTANDING',
    'This is NOT loud bhakti or heavy motivation.',
    'This is:',
    '- Soft, calming, emotional',
    '- Relatable life struggles',
    '- Gentle reassurance',
    '- “God understands you” feeling',
    '',
    'Tone:',
    '- Minimal',
    '- Peaceful',
    '- Deep but simple',
    '- Shareable & savable',
    '',
    `Brand: ${account.brandName}. Handle: ${account.handle}.`,
    `Audience: ${account.audience}. Tone direction: ${account.tone}.`,
    '',
    'OUTPUT FORMAT (STRICT)',
    'Return JSON only using the schema provided.',
    'Map the requested content into these JSON fields:',
    '- reelText: 4 to 6 slides',
    '- captionLines: 8 to 12 caption lines',
    '- hashtags: exactly 5 hashtags',
    '- musicSuggestions: exactly 2 suggestions',
    '',
    'CAPTION OUTPUT MUST MATCH THIS INSTAGRAM POST STYLE:',
    '1) one short hook line that feels emotional, respectful, and image-specific',
    '2) one devotional credit line like "-- made with love and devotion : Shiv🌸Shakti art"',
    '3) a single dot line "."',
    `4) one follow line like "follow ${account.handle} for more 💪🏽"`,
    '5) another single dot line "."',
    '6) one final hashtag line with exactly 5 hashtags',
    'Do not write any extra visible caption lines beyond that shape.',
    'Keep the hook line short enough to fit in one Instagram caption line.',
    'Use the uploaded image to make line 1 specific to the frame, expression, or relationship shown.',
    'Do not add SEO wording into the visible caption body. Keep SEO mostly in hashtags and the overall vibe.',
    '',
    'REEL TEXT RULES',
    '- Each slide = 1 short line',
    '- First line = STRONG HOOK in all caps',
    '- Use simple English as primary language',
    '- Add micro phrases like: your doubts, your delays, your fears, your confusion',
    '- Last line = calm reassurance',
    '',
    'CAPTION RULES',
    '- Hinglish (Roman Hindi + simple English)',
    '- Short broken lines',
    '- Use “...” pauses naturally',
    '- Emotional shift: problem -> realization',
    '- Add subtle divine angle (Bhagwan / Krishna / Shiv)',
    '- End with a QUESTION for engagement',
    '- Be respectful with divine references: prefer Krishna ji, Radha Rani, Shiv ji, Maa Parvati, unki, unhe',
    '- Avoid disrespectful phrasing like iski, yeh banda, or detached objectifying language for deities',
    '- Avoid awkward broken phrases like "ke chale hue aage", "sirf apne chale se nahi", or any line that sounds grammatically unfinished',
    '- Use line rhythm like this: pain -> pause -> truth -> divine line -> question',
    '- Good cadence example: "Aur tum?" then "Wahi ke wahi ho..." then "Par sach yeh hai..."',
    '- Another good cadence example: "Har delay..." then one realization line, then "Bhagwan..."',
    '- Captions should feel like they are speaking directly to one person who needs reassurance',
    '- For the final caption, keep the Instagram post style strict: hook line, credit line, dot, follow line, dot, hashtag line',
    '',
    'MUSIC RULE',
    '- Suggest 1 soft indie (Anuv Jain / Prateek Kuhad vibe)',
    '- Suggest 1 devotional calm (flute / bhajan soft)',
    '',
    'AVOID',
    '- Long paragraphs',
    '- Heavy Sanskrit',
    '- Aggressive tone',
    '- Over explanation',
    '- Corporate, polished, AI-sounding language',
    '',
    'EXAMPLES (LEARN STYLE)',
    'Example 1 REEL TEXT:',
    '- YOU’RE NOT BEHIND',
    '- you’re being prepared',
    '- your delays',
    '- your doubts',
    '- everything is aligning',
    'Example 1 CAPTION:',
    'Sabko dekh ke lagta hai...',
    'sab aage badh rahe hain.',
    '',
    'Aur tum?',
    'Wahi ke wahi ho...',
    '',
    'Par sach yeh hai —',
    'tum rukke nahi ho,',
    'tum ban rahe ho.',
    '',
    'Bhagwan jaldi nahi karte...',
    'perfect karte hain.',
    '',
    'Sach bolo...',
    'tum compare kar rahe ho ya trust?',
    '',
    'Example 2 REEL TEXT:',
    '- LET IT GO',
    '- or it will drag you down',
    '- your past',
    '- your anger',
    '- your attachments',
    '- choose peace',
    'Example 2 CAPTION:',
    'Jo tum pakad ke baithe ho...',
    'wahi tumhe thaka raha hai.',
    '',
    'Har baat control karna zaroori nahi hota.',
    '',
    'Kabhi kabhi...',
    'chhod dena hi jeet hoti hai.',
    '',
    'Shiv bhi tab shaant hote hain...',
    'jab sab chhod dete hain.',
    '',
    'Sach bolo...',
    'tum pakad ke baithe ho ya chhod pa rahe ho?',
    '',
    'Example 3 REEL TEXT:',
    '- YOU SURVIVED',
    '- more than you think',
    '- your heartbreak',
    '- your failures',
    '- your losses',
    '- you’re still here',
    'Example 3 CAPTION:',
    'Tumhe lagta hai tum weak ho...',
    '',
    'Par tumne jo jhela hai,',
    'woh sab nahi jhel paate.',
    '',
    'Har baar toot kar bhi...',
    'tum khade hue ho.',
    '',
    'Yeh strength nahi toh kya hai?',
    '',
    'Bhagwan sab dekhte hain...',
    '',
    'Sach bolo...',
    'tum khud ko underestimate karte ho?',
    '',
    'Additional reference style examples:',
    ...STYLE_EXAMPLES.flatMap((example, index) => [
      `${index + 1}. [${example.mode}]`,
      example.caption
    ]),
    '',
    'Return valid JSON only.'
  ].join('\n');
}

function buildUserPrompt({ intake, context, mode, keywordLayer }) {
  return buildUserPromptWithVisualAssist({ intake, context, mode, keywordLayer, visualAssist: null });
}

function buildUserPromptWithVisualAssist({ intake, context, mode, keywordLayer, visualAssist }) {
  const promptLines = [
    `Caption mode: ${mode}.`,
    `Detected deity: ${context.deity}.`,
    `Detected theme: ${context.theme}.`,
    `Source filename: ${context.filename || 'unknown'}.`,
    `User reference text: ${normalizeString(intake.body) || 'image only'}.`,
    `Primary SEO phrases: ${keywordLayer.seoKeywords.join(', ')}.`,
    `Preferred hashtags: ${keywordLayer.hashtags.join(', ')}.`,
    `Narrative angle: ${keywordLayer.narrativeAngle}.`,
    `TOPIC: ${normalizeString(intake.body) || `${context.deity} ${context.theme}`}.`,
    'Generate content in the same style.',
    'Important:',
    '- prefer short lines over paragraphs',
    '- if mode is micro_story, write a tiny scene or tiny dialogue',
    '- if mode is meme_one_liner, keep it direct and playful',
    '- if mode is devotional_emotion, keep it soft and heartfelt',
    '- keep the visible caption natural; use SEO mostly through wording choice and hashtags',
    '- if the user references Krishna flute, Vrindavan, Radha Krishna, or soft peace, make it feel immersive and emotional',
    '- if the user references Hanuman ji, aarti, support, fear, protection, or safety, use words like sahara, himmat, raksha, saath, and bharosa',
    '- write captions that make people stop because they feel seen, curious, or gently pulled into the moment',
    '- prefer captions that look visually similar to the examples: many short lines, many pauses, no dense paragraph blocks',
    '- the final caption should be formatted as: hook line, credit line, dot, follow line, dot, one hashtag line with exactly 5 hashtags',
    '- do not output long explanatory caption bodies; the final visible caption should stay brief like a social post, not a paragraph'
  ];

  if (visualAssist?.used && visualAssist.analysis) {
    promptLines.push(
      '',
      'IMAGE ASSIST NOTES',
      `- Scene summary: ${visualAssist.analysis.sceneSummary}`,
      `- Emotional signal: ${visualAssist.analysis.emotionalSignal}`,
      `- Deity signal: ${visualAssist.analysis.deitySignal}`,
      `- Story moment: ${visualAssist.analysis.storyMoment}`,
      `- Caption focus: ${visualAssist.analysis.captionFocus}`,
      `- Stop reason: ${visualAssist.analysis.stopReason}`,
      '- Use these image notes to make the caption feel visually specific, but keep the same soft, relatable, spiritual voice.'
    );
  }

  return promptLines.join('\n');
}

function buildSimpleSystemPrompt(account) {
  return [
    'You write very short Instagram captions for a Sanatan Dharma art page.',
    `Brand: ${account.brandName}. Handle: ${account.handle}.`,
    `Audience: ${account.audience}.`,
    'Return JSON only.',
    'Use the image emotion first, then the user text.',
    'Write like a real devotional page, not like AI.',
    'Rules:',
    '- hook = 2 to 6 words',
    '- body = 1 short relatable line tied to the image',
    '- cta = short follow line',
    '- respectful deity language only',
    '- no generic motivational paragraph',
    '- no over explanation',
    '- hashtags = maximum 5',
    '- seoKeywords should be organic search phrases',
    'Examples:',
    '- hook: "Radhe Krishna ❤️"',
    '- body: "the divine love story at Yamuna kinare."',
    '- hook: "Jai Hanuman"',
    '- body: "Sankat Mochan sabke dukh hare. ❤️"',
    '- hook: "ShivShakti love ❤️"',
    '- body: "made with love and devotion : Shiv🌸Shakti art"'
  ].join('\n');
}

function buildSimpleUserPromptWithVisualAssist({ intake, context, keywordLayer, visualAssist }) {
  const promptLines = [
    `Detected deity: ${context.deity}.`,
    `Detected theme: ${context.theme}.`,
    `Source filename: ${context.filename || 'unknown'}.`,
    `User reference text: ${normalizeString(intake.body) || 'image only'}.`,
    `Primary SEO phrases: ${keywordLayer.seoKeywords.join(', ')}.`,
    `Preferred hashtags: ${keywordLayer.hashtags.join(', ')}.`,
    `Narrative angle: ${keywordLayer.narrativeAngle}.`,
    'Write one short relatable caption from the image and text.',
    'Target output:',
    '- reelText: one short on-screen line',
    '- hook: very short phrase users would actually post',
    '- body: one short image-specific line',
    '- cta: follow @sanatan.dharma.ai for more 🤍',
    '- hashtags: 5 max',
    'Examples:',
    '- Radha Krishna love image -> hook "Radhe Krishna ❤️", body "the divine love story at Yamuna kinare."',
    '- Hanuman support image -> hook "Jai Hanuman", body "Sankat Mochan sabke dukh hare. ❤️"',
    '- ShivShakti soft image -> hook "ShivShakti love ❤️", body "made with love and devotion : Shiv🌸Shakti art"',
    'Do not write long lines. Do not explain the whole scene. Make it feel post-ready.'
  ];

  if (visualAssist?.used && visualAssist.analysis) {
    promptLines.push(
      '',
      'IMAGE ASSIST NOTES',
      `- Scene summary: ${visualAssist.analysis.sceneSummary}`,
      `- Emotional signal: ${visualAssist.analysis.emotionalSignal}`,
      `- Deity signal: ${visualAssist.analysis.deitySignal}`,
      `- Story moment: ${visualAssist.analysis.storyMoment}`
    );
  }

  return promptLines.join('\n');
}

function buildVisionPrompt({ intake, context, mode, keywordLayer }) {
  return [
    'Analyze this devotional reel image for caption writing.',
    'You are not writing the final caption yet.',
    'Return JSON only using the schema provided.',
    'Focus on what would make a soft spiritual Instagram audience stop, feel seen, save, or share.',
    `Detected deity hint: ${context.deity}.`,
    `Detected theme hint: ${context.theme}.`,
    `Caption mode hint: ${mode}.`,
    `User text hint: ${normalizeString(intake.body) || 'image only'}.`,
    `Primary SEO phrases: ${keywordLayer.seoKeywords.join(', ')}.`,
    'Describe the visual moment in a calm, specific way.',
    'Respect divine figures. Do not objectify or use casual disrespectful language.',
    'Prefer details like expression, pose, closeness, flute, eyes, blessing, protection, stillness, softness, warmth, Vrindavan feeling, or Kailash calm if present.',
    'The stopReason should explain why this frame is replayable or saveable in a noisy Instagram feed.'
  ].join('\n');
}

function getCloudflareError(payload) {
  if (Array.isArray(payload?.errors) && payload.errors.length > 0) {
    const first = payload.errors[0];
    return first?.message || first?.code || JSON.stringify(first);
  }

  return null;
}

function extractContent(payload) {
  const result = payload?.result || payload;
  const choicesContent = result?.choices?.[0]?.message?.content;

  if (typeof result?.response === 'string' && result.response.trim()) {
    return result.response.trim();
  }

  if (typeof choicesContent === 'string' && choicesContent.trim()) {
    return choicesContent.trim();
  }

  if (Array.isArray(choicesContent)) {
    return choicesContent
      .map((item) => item?.text || item?.content || '')
      .join('')
      .trim();
  }

  if (typeof result?.output_text === 'string' && result.output_text.trim()) {
    return result.output_text.trim();
  }

  return '';
}

function stripMarkdownCodeFence(value) {
  const text = String(value || '').trim();
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : text;
}

function extractJsonObjectText(value) {
  const text = stripMarkdownCodeFence(value);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');

  if (start >= 0 && end > start) {
    return text.slice(start, end + 1).trim();
  }

  return text;
}

function parseJsonDraft(value) {
  const direct = String(value || '').trim();
  const candidates = [
    direct,
    stripMarkdownCodeFence(direct),
    extractJsonObjectText(direct)
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try next shape.
    }
  }

  return null;
}

function isVisionModel(model) {
  const normalized = String(model || '').toLowerCase();
  return (
    normalized.includes('vision') ||
    normalized.includes('llama-4-scout') ||
    normalized.includes('gemma-4') ||
    normalized.includes('gemma-3')
  );
}

async function buildImageDataUrl(imagePath) {
  const maxDimension = Math.max(256, Number(config.captioning.cloudflare.imageMaxDimension) || 896);
  const quality = Math.min(95, Math.max(45, Number(config.captioning.cloudflare.imageQuality) || 78));
  const buffer = await fs.readFile(imagePath);
  const resized = await sharp(buffer)
    .rotate()
    .resize({
      width: maxDimension,
      height: maxDimension,
      fit: 'inside',
      withoutEnlargement: true
    })
    .jpeg({
      quality,
      mozjpeg: true
    })
    .toBuffer();

  return `data:image/jpeg;base64,${resized.toString('base64')}`;
}

async function runCloudflareJsonRequest({ modelPath, payload }) {
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${config.captioning.cloudflare.accountId}/ai/run/${modelPath}`;
  const startedAt = Date.now();
  const response = await fetchWithPolicy(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.captioning.cloudflare.apiToken}`,
      'Content-Type': 'application/json',
      'x-session-affinity': 'caption-engine'
    },
    body: JSON.stringify(payload),
    logContext: {
      service: 'cloudflare-workers-ai',
      operation: modelPath
    }
  });

  const responsePayload = await response.json().catch(() => ({}));
  const cloudflareError = getCloudflareError(responsePayload);
  addApiLog({
    service: 'cloudflare-workers-ai',
    operation: modelPath,
    status: response.ok && responsePayload?.success !== false && !cloudflareError ? 'success' : 'error',
    model: modelPath,
    durationMs: Date.now() - startedAt,
    usage: null,
    limits: {
      headers: extractInterestingHeaders(response.headers)
    },
    http: {
      status: response.status
    },
    details: {
      url: endpoint,
      method: 'POST'
    },
    summary: response.ok && responsePayload?.success !== false && !cloudflareError
      ? 'Cloudflare caption request completed.'
      : 'Cloudflare caption request failed.',
    error: response.ok && responsePayload?.success !== false && !cloudflareError
      ? null
      : cloudflareError || `Cloudflare caption request failed with status ${response.status}.`
  });
  if (!response.ok || responsePayload?.success === false || cloudflareError) {
    throw new Error(cloudflareError || `Cloudflare caption request failed with status ${response.status}.`);
  }

  const content = extractContent(responsePayload);
  if (!content) {
    throw new Error('Cloudflare caption response was empty.');
  }

  const parsed = parseJsonDraft(content);
  if (!parsed) {
    const snippet = content.replace(/\s+/g, ' ').slice(0, 220);
    throw new Error(`Cloudflare caption response was not valid JSON. Raw response: ${snippet}`);
  }

  return parsed;
}

export async function generateVisualAssist({ intake, context, mode, keywordLayer, provider }) {
  if (
    !provider.configured ||
    !provider.imageAssistEnabled ||
    !provider.visionModel ||
    !intake?.imagePath ||
    String(intake?.mediaKind || '').toLowerCase() !== 'image'
  ) {
    return {
      used: false,
      provider: null,
      model: provider.visionModel || null,
      reason: provider.imageAssistEnabled ? 'Image assist unavailable for this request.' : 'Image assist disabled.'
    };
  }

  const modelPath = String(provider.visionModel || '').trim().replace(/^\/+/, '');
  if (!isVisionModel(modelPath)) {
    return {
      used: false,
      provider: 'cloudflare-workers-ai',
      model: modelPath,
      reason: 'Configured image-assist model does not advertise vision support.'
    };
  }

  const imageDataUrl = await buildImageDataUrl(intake.imagePath);
  const payload = {
    messages: [
      {
        role: 'system',
        content: 'You extract visual storytelling cues from devotional art for a caption-writing pipeline. Return JSON only.'
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: buildVisionPrompt({ intake, context, mode, keywordLayer })
          },
          {
            type: 'image_url',
            image_url: {
              url: imageDataUrl
            }
          }
        ]
      }
    ],
    temperature: 0.2,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'caption_visual_assist',
        schema: VISUAL_ASSIST_SCHEMA
      }
    }
  };

  const analysis = await runCloudflareJsonRequest({
    modelPath,
    payload
  });

  return {
    used: true,
    provider: 'cloudflare-workers-ai',
    model: modelPath,
    analysis
  };
}

export function getCaptionProviderStatus() {
  const configured = Boolean(
    normalizeString(config.captioning.cloudflare.accountId) &&
    normalizeString(config.captioning.cloudflare.apiToken)
  );

  return {
    configured,
    provider: configured ? 'cloudflare-workers-ai' : 'rule-fallback',
    model: config.captioning.cloudflare.model,
    maxHashtags: config.captioning.maxHashtags,
    imageAssistEnabled: Boolean(config.captioning.cloudflare.imageAssistEnabled),
    visionModel: config.captioning.cloudflare.visionModel
  };
}

export async function generateCloudflareCaptionDraft({ intake, context, mode, keywordLayer }) {
  const provider = getCaptionProviderStatus();
  if (!provider.configured) {
    return null;
  }

  const modelPath = String(config.captioning.cloudflare.model || '').trim().replace(/^\/+/, '');
  let visualAssist = {
    used: false,
    provider: null,
    model: provider.visionModel || null,
    reason: provider.imageAssistEnabled ? 'No image assist was attempted.' : 'Image assist disabled.'
  };

  try {
    visualAssist = await generateVisualAssist({
      intake,
      context,
      mode,
      keywordLayer,
      provider
    });
  } catch (error) {
    visualAssist = {
      used: false,
      provider: 'cloudflare-workers-ai',
      model: provider.visionModel || null,
      reason: error instanceof Error ? error.message : String(error)
    };
  }

  const payload = {
    messages: [
      {
        role: 'system',
        content: buildSimpleSystemPrompt(config.account)
      },
      {
        role: 'user',
        content: buildSimpleUserPromptWithVisualAssist({ intake, context, keywordLayer, visualAssist })
      }
    ],
    temperature: config.captioning.cloudflare.temperature,
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'instagram_caption_plan',
        schema: CAPTION_RESPONSE_SCHEMA
      }
    }
  };

  const parsed = await runCloudflareJsonRequest({
    modelPath,
    payload
  });

  return {
    provider: 'cloudflare-workers-ai',
    model: provider.model,
    visualAssist,
    ...parsed
  };
}
