import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import { config, isPublicHttpUrl } from '../config.js';

const links = new Map();

async function persistLinks() {
  await fs.mkdir(path.dirname(config.shortLinksFile), { recursive: true });
  const payload = JSON.stringify([...links.values()], null, 2);
  const tempFile = `${config.shortLinksFile}.tmp`;
  await fs.writeFile(tempFile, `${payload}\n`, 'utf8');
  await fs.rename(tempFile, config.shortLinksFile);
}

export async function loadShortLinks() {
  try {
    const raw = await fs.readFile(config.shortLinksFile, 'utf8');
    const items = JSON.parse(raw);
    links.clear();
    for (const item of items) {
      links.set(item.code, item);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
}

export function getShortLink(code) {
  return links.get(code) || null;
}

export async function createShortLink(targetUrl, options = {}) {
  const url = String(targetUrl || '').trim();
  if (!url) {
    throw new Error('A target URL is required to create a short link.');
  }

  if (!isPublicHttpUrl(config.publicBaseUrl)) {
    return {
      code: null,
      shortUrl: url,
      targetUrl: url,
      provider: 'direct'
    };
  }

  const code = String(options.code || '').trim() || crypto.randomBytes(5).toString('hex');
  const record = {
    code,
    targetUrl: url,
    createdAt: new Date().toISOString()
  };

  links.set(code, record);
  await persistLinks();

  return {
    code,
    shortUrl: `${config.publicBaseUrl}/l/${code}`,
    targetUrl: url,
    provider: 'internal'
  };
}
