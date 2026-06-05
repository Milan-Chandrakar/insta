import { config } from '../config.js';

const REEL_CUES = [
  'reel',
  'reels',
  'video',
  'videos',
  'short',
  'shorts',
  'youtube',
  'yt',
  'music video',
  'cinematic',
  'motion'
];

const POST_CUES = [
  'post',
  'feed',
  'wallpaper',
  'carousel',
  'pin',
  'static'
];

const WEEKDAY_LOOKUP = new Map([
  ['sunday', 0],
  ['monday', 1],
  ['tuesday', 2],
  ['wednesday', 3],
  ['thursday', 4],
  ['friday', 5],
  ['saturday', 6]
]);

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseTimeComponent(text) {
  const match = normalizeText(text).match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
  if (!match) {
    return null;
  }

  let hour = Number.parseInt(match[1], 10);
  const minute = match[2] ? Number.parseInt(match[2], 10) : 0;
  const suffix = match[3] || null;

  if (suffix === 'am' && hour === 12) {
    hour = 0;
  } else if (suffix === 'pm' && hour < 12) {
    hour += 12;
  }

  if (hour > 23 || minute > 59) {
    return null;
  }

  return { hour, minute };
}

function cloneDate(date) {
  return new Date(date.getTime());
}

function setLocalTime(date, time) {
  const copy = cloneDate(date);
  copy.setHours(time.hour, time.minute, 0, 0);
  return copy;
}

function nextWeekdayDate(now, weekday) {
  const candidate = cloneDate(now);
  const currentWeekday = candidate.getDay();
  let offset = (weekday - currentWeekday + 7) % 7;
  if (offset === 0) {
    offset = 7;
  }
  candidate.setDate(candidate.getDate() + offset);
  candidate.setHours(0, 0, 0, 0);
  return candidate;
}

function parseExplicitDate(text) {
  const normalized = normalizeText(text);
  const isoMatch = normalized.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoMatch) {
    const year = Number.parseInt(isoMatch[1], 10);
    const month = Number.parseInt(isoMatch[2], 10) - 1;
    const day = Number.parseInt(isoMatch[3], 10);
    const date = new Date(year, month, day);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const numericMatch = normalized.match(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/);
  if (numericMatch) {
    const first = Number.parseInt(numericMatch[1], 10);
    const second = Number.parseInt(numericMatch[2], 10);
    const yearPart = numericMatch[3] ? Number.parseInt(numericMatch[3], 10) : new Date().getFullYear();
    const year = yearPart < 100 ? 2000 + yearPart : yearPart;
    const date = new Date(year, second - 1, first);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const monthMatch = normalized.match(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)(?:[a-z]*)?(?:\s+(\d{4}))?\b/
  );
  if (monthMatch) {
    const monthMap = {
      jan: 0,
      feb: 1,
      mar: 2,
      apr: 3,
      may: 4,
      jun: 5,
      jul: 6,
      aug: 7,
      sep: 8,
      sept: 8,
      oct: 9,
      nov: 10,
      dec: 11
    };
    const day = Number.parseInt(monthMatch[1], 10);
    const month = monthMap[monthMatch[2]] ?? 0;
    const year = monthMatch[3] ? Number.parseInt(monthMatch[3], 10) : new Date().getFullYear();
    const date = new Date(year, month, day);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  return null;
}

function hasKeyword(text, keywords) {
  return keywords.some((keyword) => text.includes(keyword));
}

export function detectMediaKind(intake) {
  const mimeType = String(intake?.mimeType || '').toLowerCase();
  const filename = String(intake?.filename || '').toLowerCase();

  if (mimeType.startsWith('video/') || filename.endsWith('.mp4')) {
    return 'video';
  }

  if (mimeType.startsWith('image/') || /\.(png|jpe?g|webp|heic|heif)$/i.test(filename)) {
    return 'image';
  }

  return 'unknown';
}

export function detectScheduleOverride(text, now = new Date()) {
  const normalized = normalizeText(text);
  if (!normalized) {
    return null;
  }

  const time = parseTimeComponent(normalized);
  const explicitDate = parseExplicitDate(normalized);
  const hasToday = normalized.includes('today');
  const hasTomorrow = normalized.includes('tomorrow');

  if (!time && !explicitDate && !hasToday && !hasTomorrow && ![...WEEKDAY_LOOKUP.keys()].some((day) => normalized.includes(day))) {
    return null;
  }

  let date = explicitDate ? cloneDate(explicitDate) : null;

  if (!date) {
    if (hasTomorrow) {
      date = cloneDate(now);
      date.setDate(date.getDate() + 1);
      date.setHours(0, 0, 0, 0);
    } else if (hasToday) {
      date = cloneDate(now);
      date.setHours(0, 0, 0, 0);
    } else {
      const weekdayEntry = [...WEEKDAY_LOOKUP.entries()].find(([day]) => normalized.includes(day));
      if (weekdayEntry) {
        date = nextWeekdayDate(now, weekdayEntry[1]);
      }
    }
  }

  if (!date) {
    return null;
  }

  const effectiveTime = time || { hour: 12, minute: 0 };
  const scheduledAt = setLocalTime(date, effectiveTime);
  if (scheduledAt <= now && !explicitDate) {
    scheduledAt.setDate(scheduledAt.getDate() + 1);
  }

  return {
    dueAt: scheduledAt.toISOString(),
    sourceText: text,
    matched: {
      hasToday,
      hasTomorrow,
      day: [...WEEKDAY_LOOKUP.keys()].find((day) => normalized.includes(day)) || null,
      time: time ? `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}` : null,
      explicitDate: explicitDate ? explicitDate.toISOString() : null
    }
  };
}

export function resolveIntakeRoute(intake) {
  const mediaKind = detectMediaKind(intake);
  const body = normalizeText(intake?.body || '');
  const reelCue = hasKeyword(body, REEL_CUES);
  const postCue = hasKeyword(body, POST_CUES);
  const scheduleOverride = detectScheduleOverride(intake?.body || '');
  const forceReel = mediaKind === 'video' || reelCue;
  const instagramFormat = forceReel ? 'reel' : 'post';
  const isImage = mediaKind === 'image';
  const isCarousel = Boolean(intake?.isCarousel) || (isImage && body.includes('carousel'));
  const needsVideoDerivative = isImage && forceReel;
  const instagramPublishingType = isImage && !forceReel ? 'notification' : 'automatic';
  const allowYoutube = mediaKind === 'video' || needsVideoDerivative;
  const allowPinterestImage = isImage;

  return {
    mediaKind,
    isCarousel,
    instagramFormat,
    instagramPublishingType,
    needsVideoDerivative,
    scheduleOverride,
    preserveSourceAudio: mediaKind === 'video',
    captionSignal: forceReel ? 'reel' : 'post',
    reasoning: [
      mediaKind === 'video'
        ? 'Direct MP4 intake is routed as a reel without adding music.'
        : reelCue
          ? 'Image text mentions reel/video cues, so the Instagram route becomes a reel.'
          : postCue
            ? 'Image text points toward a post-first output.'
            : 'Image intake is treated as a post-first output when no reel cue is present.',
      isCarousel
        ? 'Carousel cue detected, so multiple images in the 5-minute intake window will be grouped into a single Instagram carousel.'
        : null,
      instagramPublishingType === 'notification'
        ? 'Instagram image posts are routed as notification publishing so music can be added manually in the Instagram app.'
        : 'Instagram video and reel outputs stay on automatic publishing.',
      isImage
        ? needsVideoDerivative
          ? 'Image uploads with reel cues fan out into a video derivative for Instagram reels and YouTube.'
          : 'Pure image uploads stay static for Instagram and Pinterest, with YouTube skipped.'
        : 'Video uploads stay source-preserving and do not add new music.',
      scheduleOverride
        ? `Explicit schedule override detected from chat text: ${scheduleOverride.dueAt}.`
        : 'Normal schedule engine will be used because no explicit day/date/time override was found.'
    ].filter(Boolean),
    fanout: isImage
      ? {
          instagram: instagramFormat,
          youtube: allowYoutube ? 'video' : null,
          pinterest: isCarousel ? ['image_collection'] : allowPinterestImage ? ['image'] : []
        }
      : {
          instagram: 'reel',
          youtube: 'video',
          pinterest: ['video']
        }
  };
}
