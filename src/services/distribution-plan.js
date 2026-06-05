import { config } from '../config.js';

function titleCase(value) {
  return String(value || '')
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ');
}

function uniqueTags(values, limit = 12) {
  return [...new Set((Array.isArray(values) ? values : []).map((item) => String(item || '').trim()).filter(Boolean))].slice(0, limit);
}

function splitCaptionLines(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => String(line || '').trim())
    .filter(Boolean);
}

function isHashtagLine(line) {
  return /^#/.test(String(line || '').trim());
}

function buildInstagramCaption(captionPlan, locationLabel, callToAction = null) {
  const generatedLines = splitCaptionLines(captionPlan.caption);
  const hashtagLine = generatedLines.find(isHashtagLine)
    || (captionPlan.hashtags || []).map((tag) => `#${tag}`).join(' ');
  const bodyLines = generatedLines.filter((line) => !isHashtagLine(line));

  if (locationLabel && !bodyLines.some((line) => line.includes(locationLabel))) {
    bodyLines.push(`📍 ${locationLabel}`);
  }

  if (callToAction && !bodyLines.some((line) => line.includes(callToAction))) {
    bodyLines.push(callToAction);
  }

  if (hashtagLine) {
    bodyLines.push(hashtagLine);
  }

  return bodyLines.filter(Boolean).join('\n');
}

function buildYouTubePlan({ captionPlan }) {
  const titleCore = captionPlan.titleHint || 'Rendered devotional video';
  const title = titleCore.length > 90
    ? `${titleCore.slice(0, 87).trim()}...`
    : titleCore;
  const tags = uniqueTags([
    ...(captionPlan.seoKeywords || []),
    'shorts',
    'youtubeshorts',
    'sanatandharma',
    'bhakti',
    'devotional',
    'spiritual',
    'reels'
  ], 12);

  const description = [
    captionPlan.caption,
    '',
    '✅ Link in bio for full 4K wallpaper pack',
    '',
    '#Shorts #YouTubeShorts',
    '',
    `Tags: ${tags.map((tag) => `#${tag}`).join(' ')}`
  ].filter(Boolean).join('\n');

  return {
    type: 'video',
    title,
    description,
    tags,
    thumbnailText: captionPlan.hook || titleCore,
    location: null,
    mediaKind: 'video'
  };
}

function buildPinterestPlan({ captionPlan, route, wallpaperLink, locationLabel }) {
  const titleCore = captionPlan.titleHint || `${titleCase(route.mediaKind)} wallpaper`;
  const title = titleCore.length > 100
    ? `${titleCore.slice(0, 97).trim()}...`
    : titleCore;
  const tags = uniqueTags([
    ...(captionPlan.seoKeywords || []),
    'wallpaper',
    'sanatandharma',
    'devotional',
    'aesthetic',
    'vrindavan'
  ], 12);

  const description = [
    captionPlan.caption,
    '',
    '✅ Link in bio for full 4K wallpaper pack',
    wallpaperLink ? `Wallpaper pack: ${wallpaperLink}` : null,
    locationLabel ? `📍 ${locationLabel}` : null
  ].filter(Boolean).join('\n');

  return {
    title,
    description,
    altText: `${captionPlan.hook || titleCore} devotional wallpaper`,
    tags,
    wallpaperLink,
    location: locationLabel || null
  };
}

function buildPinterestCaptionText(caption, wallpaperLink, locationLabel = 'Kedarnath') {
  const lines = [
    String(caption || '').trim(),
    '',
    '✅ Link in bio for full 4K wallpaper pack',
    wallpaperLink ? `Wallpaper pack: ${wallpaperLink}` : null,
    locationLabel ? `📍 ${locationLabel}` : null
  ];

  return lines.filter(Boolean).join('\n');
}

function buildInstagramPlan({ captionPlan, route, wallpaperLink, locationLabel }) {
  return {
    type: route.instagramFormat,
    caption: buildInstagramCaption(captionPlan, locationLabel, '✅ Link in bio for full 4K wallpaper pack'),
    hashtags: captionPlan.hashtags || [],
    location: locationLabel || null,
    callToAction: '✅ Link in bio for full 4K wallpaper pack',
    wallpaperLink,
    preserveSourceAudio: Boolean(route.preserveSourceAudio)
  };
}

export function buildDistributionPlan({ captionPlan, route, wallpaperLink = null, locationLabel = 'Kedarnath' }) {
  const instagram = buildInstagramPlan({
    captionPlan,
    route,
    wallpaperLink,
    locationLabel
  });

  const youtube = buildYouTubePlan({
    captionPlan,
    route,
    locationLabel: null
  });

  const pinterest = buildPinterestPlan({
    captionPlan,
    route,
    wallpaperLink,
    locationLabel
  });

  return {
    instagram,
    youtube,
    pinterest,
    brand: config.account.brandName,
    handle: config.account.handle
  };
}

export function buildPinterestCaption({ captionPlan, wallpaperLink = null, locationLabel = 'Kedarnath' }) {
  return buildPinterestCaptionText(captionPlan.caption, wallpaperLink, locationLabel);
}
