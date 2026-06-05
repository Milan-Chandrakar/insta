import crypto from 'node:crypto';
import { config, isAuthConfigured } from '../config.js';

function base64urlEncode(value) {
  return Buffer.from(value).toString('base64url');
}

function base64urlDecode(value) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function sign(value) {
  return crypto
    .createHmac('sha256', config.auth.sessionSecret)
    .update(value)
    .digest('base64url');
}

function safeCompare(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) {
    return false;
  }

  return crypto.timingSafeEqual(a, b);
}

function buildCookieValue(payload) {
  const encoded = base64urlEncode(JSON.stringify(payload));
  const signature = sign(encoded);
  return `${encoded}.${signature}`;
}

function parseCookieHeader(header) {
  const cookies = {};
  for (const segment of String(header || '').split(';')) {
    const [rawName, ...rest] = segment.split('=');
    const name = rawName?.trim();
    if (!name) {
      continue;
    }

    cookies[name] = rest.join('=').trim();
  }

  return cookies;
}

function decodeSession(value) {
  if (!value) {
    return null;
  }

  const [encoded, signature] = value.split('.');
  if (!encoded || !signature) {
    return null;
  }

  if (!safeCompare(sign(encoded), signature)) {
    return null;
  }

  const payload = JSON.parse(base64urlDecode(encoded));
  if (!payload?.exp || payload.exp <= Date.now()) {
    return null;
  }

  return payload;
}

function buildCookieHeader(value, maxAgeMs) {
  const parts = [
    `${config.auth.cookieName}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`
  ];

  if (config.appBaseUrl.startsWith('https://')) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

export function getRequestSession(req) {
  const cookies = parseCookieHeader(req.headers.cookie);
  return decodeSession(cookies[config.auth.cookieName]);
}

export function attachAuthState(req, _res, next) {
  req.auth = {
    enabled: config.auth.enabled,
    configured: isAuthConfigured(),
    session: getRequestSession(req)
  };
  next();
}

export function requireTrustedOrigin(req, res, next) {
  if (!config.security.trustedOrigins.length) {
    next();
    return;
  }

  const origin = req.headers.origin;
  if (!origin || config.security.trustedOrigins.includes(origin)) {
    next();
    return;
  }

  res.status(403).json({ error: 'Origin is not allowed.' });
}

export function requireAuth(req, res, next) {
  if (!config.auth.enabled) {
    next();
    return;
  }

  if (!isAuthConfigured()) {
    res.status(503).json({ error: 'Authentication is enabled but not fully configured.' });
    return;
  }

  if (req.auth?.session) {
    next();
    return;
  }

  res.status(401).json({ error: 'Authentication required.' });
}

export function issueSession(res) {
  const session = {
    sub: 'local-admin',
    exp: Date.now() + config.auth.sessionTtlMs
  };
  res.setHeader('Set-Cookie', buildCookieHeader(buildCookieValue(session), config.auth.sessionTtlMs));
  return session;
}

export function clearSession(res) {
  res.setHeader('Set-Cookie', buildCookieHeader('', 0));
}

export function validateLoginPassword(password) {
  return safeCompare(password || '', config.auth.password || '');
}

export function getAuthStatus(req) {
  return {
    enabled: config.auth.enabled,
    configured: isAuthConfigured(),
    authenticated: Boolean(req.auth?.session),
    subject: req.auth?.session?.sub || null,
    expiresAt: req.auth?.session?.exp || null
  };
}
