import { config } from '../config.js';
import { getFestivalSlots2026, resolveDevotionalThemeForDate } from './devotional-calendar.js';

const SCHEDULE_PROFILES = {
  reel: {
    label: 'reel',
    slots: [
      { hour: 14, minute: 0, weight: 100, label: 'Primary reel slot' },
      { hour: 14, minute: 30, weight: 92, label: 'Secondary reel slot' },
      { hour: 15, minute: 0, weight: 84, label: 'Overflow reel slot' }
    ],
    fallback: { hour: 14, minute: 0, label: 'Fallback reel slot' },
    maxPerDay: null
  },
  carousel: {
    label: 'carousel',
    slots: [
      { hour: 23, minute: 0, weight: 100, label: 'Daily carousel slot' }
    ],
    fallback: { hour: 23, minute: 0, label: 'Fallback carousel slot' },
    maxPerDay: 1
  }
};

const RESEARCH_SOURCES = [
  {
    label: '2026 devotional calendar anchors',
    detail: 'Major Hindu festival placeholders were encoded for 2026 so the queue can reserve deity/story slots before assets arrive.'
  },
  {
    label: 'Operator preference',
    detail: 'Carousel posts use one daily 11:00 p.m. IST slot. Reels and Shorts use the 2:00 p.m. IST slot family.'
  }
];

function cloneDate(value) {
  return new Date(value.getTime());
}

function startOfDay(value) {
  const copy = cloneDate(value);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function toDayKey(value) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getScheduledAt(job) {
  const value = job?.runAt
    || job?.result?.published?.dueAt
    || job?.result?.scheduledFor
    || job?.payload?.dueAt
    || null;
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getJobScheduleProfile(job) {
  if (job?.kind === 'publish-carousel-intake') {
    return 'carousel';
  }
  return job?.result?.published?.profile
    || job?.result?.schedule?.profile
    || job?.payload?.scheduleProfile
    || 'reel';
}

function getFutureScheduledPosts(localJobs, now, profileName) {
  return (Array.isArray(localJobs) ? localJobs : [])
    .map((job) => ({
      kind: job.kind,
      status: job.status,
      profile: getJobScheduleProfile(job),
      date: getScheduledAt(job)
    }))
    .filter((item) => item.date && item.date > now && item.profile === profileName);
}

function countDayOccupancy(items) {
  const counts = new Map();
  for (const item of items) {
    const key = toDayKey(item.date);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function hasMinGap(candidate, scheduledItems) {
  const minGapMs = config.scheduler.minGapHours * 60 * 60 * 1000;
  return scheduledItems.every((item) => Math.abs(candidate.getTime() - item.date.getTime()) >= minGapMs);
}

function createCandidate(dayStart, slot) {
  const candidate = cloneDate(dayStart);
  candidate.setHours(slot.hour, slot.minute, 0, 0);
  return candidate;
}

function getBacklogSize(localJobs) {
  return (Array.isArray(localJobs) ? localJobs : []).filter((job) =>
    ['queued', 'running', 'scheduled'].includes(job.status)
  ).length;
}

function getDesiredPostsPerDay(backlogSize) {
  const max = Math.max(config.scheduler.minPostsPerDay, config.scheduler.maxPostsPerDay);
  if (backlogSize >= config.scheduler.thirdSlotThreshold) {
    return Math.min(3, max);
  }

  if (backlogSize >= config.scheduler.secondSlotThreshold) {
    return Math.min(2, max);
  }

  return Math.max(1, config.scheduler.minPostsPerDay);
}

function getScheduleProfile(profile) {
  return SCHEDULE_PROFILES[profile] || SCHEDULE_PROFILES.reel;
}

function getDesiredPostsPerDayForProfile(backlogSize, profile) {
  if (profile.maxPerDay) {
    return profile.maxPerDay;
  }

  return getDesiredPostsPerDay(backlogSize);
}

function buildReasoning({ slot, cadencePerDay, theme, profile }) {
  const cadenceLine = cadencePerDay >= 3
    ? 'Three reel placeholders are open because the queue is heavy and the backlog needs faster daily drainage.'
    : cadencePerDay === 2
      ? 'Two reel placeholders are open because more than one intake is waiting for publication.'
      : profile.label === 'carousel'
        ? 'Only one carousel placeholder is kept per day so carousel drops stay controlled and do not collide.'
        : 'At least one reel placeholder is kept open every day to satisfy the daily posting requirement.';

  const themeLine = theme.source === 'festival'
    ? `The selected date aligns with ${theme.label}, so this slot is reserved for ${theme.deity} / ${theme.storySeed}.`
    : `No major festival placeholder matched, so the slot falls back to the weekday devotional theme: ${theme.label}.`;
  const timingLine = profile.label === 'carousel'
    ? 'The scheduler prefers the daily 11:00 p.m. IST carousel slot.'
    : 'The scheduler prefers the 2:00 p.m. IST reel slot family.';

  return [
    themeLine,
    cadenceLine,
    timingLine
  ];
}

export function chooseScheduleSlot(localJobs = [], now = new Date(), options = {}) {
  const profile = getScheduleProfile(options.profile || 'reel');
  const futureScheduled = getFutureScheduledPosts(localJobs, now, profile.label);
  const dayOccupancy = countDayOccupancy(futureScheduled);
  const desiredPerDay = getDesiredPostsPerDayForProfile(getBacklogSize(localJobs), profile);
  const candidates = [];

  for (let offset = 0; offset < config.scheduler.lookAheadDays; offset += 1) {
    const dayStart = startOfDay(now);
    dayStart.setDate(dayStart.getDate() + offset);
    const dayKey = toDayKey(dayStart);
    const usedToday = dayOccupancy.get(dayKey) || 0;

    if (usedToday >= desiredPerDay) {
      continue;
    }

    const theme = resolveDevotionalThemeForDate(dayStart);

    for (const slot of profile.slots.slice(0, desiredPerDay)) {
      const candidate = createCandidate(dayStart, slot);
      if (candidate <= now) {
        continue;
      }

      if (!hasMinGap(candidate, futureScheduled)) {
        continue;
      }

      const festivalBoost = theme.source === 'festival' ? 12 : 0;
      candidates.push({
        dueAt: candidate.toISOString(),
        slotLabel: slot.label,
        weekday: candidate.getDay(),
        weight: slot.weight + festivalBoost,
        cadencePerDay: desiredPerDay,
        timezone: config.scheduler.timezone,
        profile: profile.label,
        reasoning: buildReasoning({ slot, cadencePerDay: desiredPerDay, theme, profile }),
        researchSources: RESEARCH_SOURCES,
        devotionalTheme: theme,
        candidate
      });
    }
  }

  candidates.sort((left, right) => {
    if (left.candidate.getTime() !== right.candidate.getTime()) {
      return left.candidate.getTime() - right.candidate.getTime();
    }
    return right.weight - left.weight;
  });

  const best = candidates[0];
  if (best) {
    const { candidate, ...result } = best;
    return result;
  }

  const fallback = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  fallback.setHours(profile.fallback.hour, profile.fallback.minute, 0, 0);
  return {
    dueAt: fallback.toISOString(),
    slotLabel: profile.fallback.label,
    weekday: fallback.getDay(),
    weight: 40,
    cadencePerDay: config.scheduler.minPostsPerDay,
    timezone: config.scheduler.timezone,
    profile: profile.label,
    reasoning: [
      `All preferred ${profile.label} placeholders inside the look-ahead window were already occupied or too close to another scheduled post.`,
      profile.label === 'carousel'
        ? 'The workflow fell back to the next 11:00 p.m. IST carousel slot.'
        : 'The workflow fell back to the next 2:00 p.m. IST reel slot.'
    ],
    researchSources: RESEARCH_SOURCES,
    devotionalTheme: resolveDevotionalThemeForDate(fallback)
  };
}

export function listDevotionalPlaceholders2026() {
  return getFestivalSlots2026();
}
