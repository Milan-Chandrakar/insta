const PUBLISHING_WINDOWS = [
  { startHour: 23, endHour: 24, label: '11:00 PM - 12:00 AM IST' },
  { startHour: 2, endHour: 3, label: '2:00 AM - 3:00 AM IST' }
];

const PUBLISHING_TIMEZONE = 'Asia/Kolkata';

function getIstParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: PUBLISHING_TIMEZONE,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });

  const parts = formatter.formatToParts(date);
  const resolved = {};

  for (const part of parts) {
    if (part.type !== 'literal') {
      resolved[part.type] = part.value;
    }
  }

  return {
    year: Number.parseInt(resolved.year || '0', 10),
    month: Number.parseInt(resolved.month || '0', 10),
    day: Number.parseInt(resolved.day || '0', 10),
    hour: Number.parseInt(resolved.hour || '0', 10),
    minute: Number.parseInt(resolved.minute || '0', 10),
    second: Number.parseInt(resolved.second || '0', 10),
    timezone: PUBLISHING_TIMEZONE
  };
}

function isWithinWindowHour(hour, startHour, endHour) {
  if (startHour === 23 && endHour === 24) {
    return hour === 23;
  }

  return hour >= startHour && hour < endHour;
}

function getActivePublishingWindow(date = new Date()) {
  const ist = getIstParts(date);
  return PUBLISHING_WINDOWS.find((window) => isWithinWindowHour(ist.hour, window.startHour, window.endHour)) || null;
}

export function isWithinPublishingWindow(date = new Date()) {
  return Boolean(getActivePublishingWindow(date));
}

export function describePublishingWindows() {
  return PUBLISHING_WINDOWS.map((window) => window.label);
}

export function getPublishingWindowStatus(date = new Date()) {
  const ist = getIstParts(date);
  const window = getActivePublishingWindow(date);

  return {
    ok: true,
    timezone: PUBLISHING_TIMEZONE,
    ist,
    allowedWindows: PUBLISHING_WINDOWS,
    activeWindow: window ? window.label : null,
    withinWindow: Boolean(window)
  };
}
