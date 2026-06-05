import { config } from '../config.js';

const buckets = new Map();

function getClientKey(req) {
  const forwardedFor = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwardedFor || req.socket.remoteAddress || 'unknown';
}

function getBucketKey(req, mode) {
  return `${mode}:${getClientKey(req)}`;
}

function takeToken(key, limit, windowMs) {
  const now = Date.now();
  const entry = buckets.get(key);

  if (!entry || entry.resetAt <= now) {
    const next = {
      count: 1,
      resetAt: now + windowMs
    };
    buckets.set(key, next);
    return next;
  }

  entry.count += 1;
  return entry;
}

function createLimiter(mode) {
  const limit = mode === 'write'
    ? config.security.rateLimit.maxWrite
    : config.security.rateLimit.maxRead;
  const windowMs = config.security.rateLimit.windowMs;

  return function rateLimitMiddleware(req, res, next) {
    const entry = takeToken(getBucketKey(req, mode), limit, windowMs);
    const remaining = Math.max(0, limit - entry.count);

    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.floor(entry.resetAt / 1000)));

    if (entry.count > limit) {
      res.status(429).json({ error: 'Too many requests. Please retry later.' });
      return;
    }

    next();
  };
}

export const rateLimitRead = createLimiter('read');
export const rateLimitWrite = createLimiter('write');
