import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, hasRealEncryptionKey } from '../config.js';

const ENCRYPTION_PREFIX = 'enc:';

function deriveEncryptionKey() {
  return crypto.createHash('sha256').update(config.security.encryptionKey).digest();
}

function encryptPayload(payload) {
  const key = deriveEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return `${ENCRYPTION_PREFIX}${Buffer.concat([iv, tag, ciphertext]).toString('base64')}`;
}

function decryptPayload(payload) {
  if (!payload.startsWith(ENCRYPTION_PREFIX)) {
    return JSON.parse(payload);
  }

  if (!hasRealEncryptionKey()) {
    throw new Error('Encrypted token store exists but APP_ENCRYPTION_KEY is not configured.');
  }

  const buffer = Buffer.from(payload.slice(ENCRYPTION_PREFIX.length), 'base64');
  const iv = buffer.subarray(0, 12);
  const tag = buffer.subarray(12, 28);
  const ciphertext = buffer.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveEncryptionKey(), iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  return JSON.parse(plaintext);
}

export async function readTokenStore(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    return decryptPayload(raw.trim());
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

export async function writeTokenStore(filePath, session) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const body = hasRealEncryptionKey()
    ? encryptPayload(session)
    : JSON.stringify(session, null, 2);
  await fs.writeFile(filePath, `${body}\n`, 'utf8');
}

export function redactSession(session) {
  if (!session) {
    return null;
  }

  return {
    authMode: session.authMode,
    igUserId: session.igUserId,
    pageId: session.pageId ?? null,
    pageName: session.pageName ?? null,
    accountName: session.accountName ?? null,
    updatedAt: session.updatedAt ?? null
  };
}
