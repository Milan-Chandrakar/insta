import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import convertHeic from 'heic-convert';
import sharp from 'sharp';
import { config, hasRealCloudinaryConfig } from '../config.js';
import { resolvePublicMediaUrl } from './public-url.js';
import { hostImageAsset, hostVideoAsset } from './media-hosting.js';
import {
  isSupabaseQueueStoreEnabled,
  loadSupabaseCollection,
  upsertSupabaseCollection,
  upsertSupabaseRecord
} from './supabase-store.js';

const intakes = new Map();

async function persistIntakes() {
  if (isSupabaseQueueStoreEnabled()) {
    await upsertSupabaseCollection(config.queueStore.intakesTable, [...intakes.values()]);
    return;
  }

  await fs.mkdir(path.dirname(config.media.intakesFile), { recursive: true });
  const payload = JSON.stringify([...intakes.values()], null, 2);
  await fs.writeFile(config.media.intakesFile, `${payload}\n`, 'utf8');
}

async function persistIntake(record) {
  if (isSupabaseQueueStoreEnabled()) {
    await upsertSupabaseRecord(config.queueStore.intakesTable, record);
    return;
  }

  await persistIntakes();
}

function guessExtension(filename, mimeType) {
  const normalizedName = String(filename || '').toLowerCase();
  if (normalizedName.endsWith('.heic') || normalizedName.endsWith('.heif')) {
    return '.jpg';
  }

  if (normalizedName.endsWith('.mp4') || String(mimeType || '').toLowerCase() === 'video/mp4') {
    return '.mp4';
  }

  if (normalizedName.endsWith('.png')) {
    return '.png';
  }

  if (normalizedName.endsWith('.webp')) {
    return '.webp';
  }

  if (normalizedName.endsWith('.jpeg') || normalizedName.endsWith('.jpg')) {
    return '.jpg';
  }

  if (String(mimeType || '').toLowerCase() === 'image/png') {
    return '.png';
  }

  if (String(mimeType || '').toLowerCase() === 'image/webp') {
    return '.webp';
  }

  return '.jpg';
}

function isHeicLike(filename, mimeType) {
  const normalizedName = String(filename || '').toLowerCase();
  const normalizedMimeType = String(mimeType || '').toLowerCase();
  return (
    normalizedName.endsWith('.heic') ||
    normalizedName.endsWith('.heif') ||
    normalizedMimeType === 'image/heic' ||
    normalizedMimeType === 'image/heif'
  );
}

function getMediaKind(filename, mimeType) {
  const normalizedMimeType = String(mimeType || '').toLowerCase();
  const normalizedName = String(filename || '').toLowerCase();

  if (normalizedMimeType.startsWith('video/') || normalizedName.endsWith('.mp4')) {
    return 'video';
  }

  if (normalizedMimeType.startsWith('image/') || /\.(png|jpe?g|webp|heic|heif)$/i.test(normalizedName)) {
    return 'image';
  }

  return 'unknown';
}

function isZipLike(filename, mimeType) {
  const normalizedName = String(filename || '').toLowerCase();
  const normalizedMimeType = String(mimeType || '').toLowerCase();
  return (
    normalizedName.endsWith('.zip') ||
    normalizedMimeType === 'application/zip' ||
    normalizedMimeType === 'application/x-zip-compressed'
  );
}

function isHeicMimeType(mimeType) {
  const normalizedMimeType = String(mimeType || '').toLowerCase();
  return normalizedMimeType === 'image/heic' || normalizedMimeType === 'image/heif';
}

async function normalizeImagePayload({ filename, mimeType, imageBuffer }) {
  if (!isHeicLike(filename, mimeType)) {
    return {
      imageBuffer,
      mimeType
    };
  }

  const outputBuffer = await convertHeic({
    buffer: imageBuffer,
    format: 'JPEG',
    quality: 0.92
  });

  return {
    imageBuffer: Buffer.from(outputBuffer),
    mimeType: 'image/jpeg'
  };
}

async function inspectImageBuffer(imageBuffer) {
  const metadata = await sharp(imageBuffer).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error('Image dimensions could not be determined from the uploaded carousel package.');
  }

  return {
    width: metadata.width,
    height: metadata.height
  };
}

function assertNineBySixteen(image, index, baseline = null) {
  const ratio = image.width / image.height;
  if (Math.abs(ratio - (9 / 16)) > 0.0025) {
    throw new Error(`Carousel image ${index + 1} must already be 9:16. Received ${image.width}x${image.height}.`);
  }

  if (baseline && (baseline.width !== image.width || baseline.height !== image.height)) {
    throw new Error(
      `Carousel image ${index + 1} does not match the first image size ${baseline.width}x${baseline.height}.`
    );
  }
}

async function extractZipCarouselPackage({ zipBuffer, captionFileName = 'caption.txt' }) {
  const archive = new AdmZip(zipBuffer);
  const entries = archive.getEntries()
    .filter((entry) => !entry.isDirectory)
    .sort((left, right) => left.entryName.localeCompare(right.entryName, undefined, { sensitivity: 'base' }));

  const textEntries = entries.filter((entry) => path.basename(entry.entryName).toLowerCase().endsWith('.txt'));
  const captionEntry = textEntries.find((entry) =>
    path.basename(entry.entryName).toLowerCase() === captionFileName.toLowerCase()
  ) || textEntries[0] || null;
  if (!captionEntry) {
    throw new Error('Carousel zip must include a .txt caption file.');
  }

  const caption = archive.readAsText(captionEntry, 'utf8').trim();
  if (!caption) {
    throw new Error(`Carousel zip caption file is empty: ${path.basename(captionEntry.entryName)}.`);
  }

  const imageEntries = entries.filter((entry) =>
    /\.(png|jpe?g|webp|heic|heif)$/i.test(path.basename(entry.entryName))
  );

  if (imageEntries.length < 2) {
    throw new Error('Carousel zip must include at least 2 images.');
  }

  if (imageEntries.length > 10) {
    throw new Error('Carousel zip cannot include more than 10 images.');
  }

  const files = [];
  let baseline = null;
  for (let index = 0; index < imageEntries.length; index += 1) {
    const entry = imageEntries[index];
    const rawBuffer = entry.getData();
    const normalized = await normalizeImagePayload({
      filename: path.basename(entry.entryName),
      mimeType: '',
      imageBuffer: rawBuffer
    });
    const dimensions = await inspectImageBuffer(normalized.imageBuffer);
    assertNineBySixteen(dimensions, index, baseline);
    baseline = baseline || dimensions;
    files.push({
      filename: path.basename(entry.entryName),
      mimeType: normalized.mimeType,
      imageBuffer: normalized.imageBuffer,
      width: dimensions.width,
      height: dimensions.height
    });
  }

  return {
    caption,
    captionFileName: path.basename(captionEntry.entryName),
    files
  };
}

export async function ensureIntakeImageRenderable(intakeId) {
  const record = getIntake(intakeId);
  if (!record) {
    return null;
  }

  if (!isHeicMimeType(record.mimeType)) {
    return record;
  }

  const existingBuffer = await fs.readFile(record.imagePath);
  const normalizedImage = await normalizeImagePayload({
    filename: record.filename,
    mimeType: record.mimeType,
    imageBuffer: existingBuffer
  });

  await fs.writeFile(record.imagePath, normalizedImage.imageBuffer);
  return markIntakeProcessed(intakeId, {
    mimeType: normalizedImage.mimeType,
    mediaKind: 'image'
  });
}

export async function loadIntakes() {
  if (isSupabaseQueueStoreEnabled()) {
    const items = await loadSupabaseCollection(config.queueStore.intakesTable);
    intakes.clear();
    for (const item of items) {
      intakes.set(item.id, item);
    }
    return;
  }

  try {
    const raw = await fs.readFile(config.media.intakesFile, 'utf8');
    const items = JSON.parse(raw);
    intakes.clear();
    for (const item of items) {
      intakes.set(item.id, item);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }

    intakes.clear();
  }
}

export function listIntakes(limit = 20) {
  return [...intakes.values()]
    .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))
    .slice(0, limit);
}

export function getIntake(intakeId) {
  return intakes.get(intakeId) || null;
}

export async function markIntakeProcessed(intakeId, patch) {
  const record = getIntake(intakeId);
  if (!record) {
    return null;
  }

  const updated = {
    ...record,
    ...patch,
    updatedAt: new Date().toISOString()
  };
  intakes.set(updated.id, updated);
  await persistIntake(updated);
  return updated;
}

export async function saveWhatsAppIntake({
  messageId,
  chatId,
  chatName,
  fromMe,
  body,
  filename,
  mimeType,
  imageBuffer
}) {
  const existing = [...intakes.values()].find((item) => item.messageId === messageId);
  if (existing) {
    return existing;
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const normalizedImage = await normalizeImagePayload({
    filename,
    mimeType,
    imageBuffer
  });
  const extension = guessExtension(filename, normalizedImage.mimeType);
  const outputName = `${createdAt.slice(0, 10)}-${id}${extension}`;
  const outputPath = path.join(config.media.intakeDir, outputName);

  await fs.mkdir(config.media.intakeDir, { recursive: true });
  await fs.writeFile(outputPath, normalizedImage.imageBuffer);

  const record = {
    id,
    source: 'whatsapp',
    messageId,
    chatId,
    chatName: chatName || null,
    fromMe: Boolean(fromMe),
    body: body || '',
    filename: filename || outputName,
    mimeType: normalizedImage.mimeType,
    mediaKind: getMediaKind(filename || outputName, normalizedImage.mimeType),
    imagePath: outputPath,
    imageUrl: resolvePublicMediaUrl(outputPath),
    status: 'received',
    createdAt,
    updatedAt: createdAt
  };

  if (hasRealCloudinaryConfig()) {
    try {
      console.log(`Pre-hosting raw media ${record.filename} to Cloudinary...`);
      const hosted = record.mediaKind === 'video'
        ? await hostVideoAsset(record.imagePath)
        : await hostImageAsset(record.imagePath);
      if (hosted?.publicUrl) {
        record.imageUrl = hosted.publicUrl;
        record.hostedImage = hosted;
      }
    } catch (error) {
      console.error('Failed to pre-host raw media to Cloudinary:', error);
    }
  }

  intakes.set(id, record);
  await persistIntake(record);
  return record;
}

export async function saveWhatsAppZipCarouselIntake({
  messageId,
  chatId,
  chatName,
  fromMe,
  body,
  filename,
  mimeType,
  zipBuffer
}) {
  if (!isZipLike(filename, mimeType)) {
    throw new Error('Expected a zip document for carousel intake.');
  }

  const existing = [...intakes.values()].find((item) => item.messageId === messageId);
  if (existing) {
    return existing;
  }

  const parsed = await extractZipCarouselPackage({
    zipBuffer
  });

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const intakeDir = path.join(config.media.intakeDir, `${createdAt.slice(0, 10)}-${id}-carousel`);
  await fs.mkdir(intakeDir, { recursive: true });

  const zipPath = path.join(intakeDir, filename || `${id}.zip`);
  await fs.writeFile(zipPath, zipBuffer);

  const savedItems = [];
  for (let index = 0; index < parsed.files.length; index += 1) {
    const item = parsed.files[index];
    const extension = guessExtension(item.filename, item.mimeType);
    const outputName = `${String(index + 1).padStart(2, '0')}${extension}`;
    const outputPath = path.join(intakeDir, outputName);
    await fs.writeFile(outputPath, item.imageBuffer);

    let publicUrl = resolvePublicMediaUrl(outputPath);
    let hostedImage = null;
    if (hasRealCloudinaryConfig()) {
      try {
        console.log(`Pre-hosting carousel slide ${item.filename} to Cloudinary...`);
        const hosted = await hostImageAsset(outputPath);
        if (hosted?.publicUrl) {
          publicUrl = hosted.publicUrl;
          hostedImage = hosted;
        }
      } catch (err) {
        console.error('Failed to pre-host carousel slide to Cloudinary:', err);
      }
    }

    savedItems.push({
      filename: item.filename || outputName,
      mimeType: item.mimeType,
      imagePath: outputPath,
      imageUrl: publicUrl,
      hostedImage,
      width: item.width,
      height: item.height
    });
  }

  const record = {
    id,
    source: 'whatsapp',
    sourceFormat: 'zip_carousel',
    publishStrategy: 'graph_carousel',
    messageId,
    messageIds: [messageId],
    chatId,
    chatName: chatName || null,
    fromMe: Boolean(fromMe),
    body: body || '',
    filename: filename || `${id}.zip`,
    mimeType: mimeType || 'application/zip',
    mediaKind: 'image',
    isCarousel: true,
    carouselSize: savedItems.length,
    imagePath: savedItems[0]?.imagePath || null,
    imageUrl: savedItems[0]?.imageUrl || null,
    imagePaths: savedItems.map((item) => item.imagePath),
    imageUrls: savedItems.map((item) => item.imageUrl),
    hostedImages: savedItems.map((item) => item.hostedImage).filter(Boolean),
    files: savedItems,
    captionOverride: parsed.caption,
    captionFileName: parsed.captionFileName,
    zipPath,
    status: 'received',
    createdAt,
    updatedAt: createdAt
  };

  intakes.set(id, record);
  await persistIntake(record);
  return record;
}

export async function saveWhatsAppCarouselIntake({
  messageIds,
  chatId,
  chatName,
  fromMe,
  body,
  items
}) {
  const normalizedMessageIds = Array.isArray(messageIds)
    ? messageIds.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const existing = [...intakes.values()].find((item) =>
    item.isCarousel && normalizedMessageIds.some((messageId) => (item.messageIds || []).includes(messageId))
  );
  if (existing) {
    return existing;
  }

  const validItems = Array.isArray(items) ? items.filter(Boolean) : [];
  if (validItems.length === 0) {
    throw new Error('Carousel intake requires at least one image.');
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  await fs.mkdir(config.media.intakeDir, { recursive: true });

  const savedItems = [];
  for (const item of validItems) {
    const normalizedImage = await normalizeImagePayload({
      filename: item.filename,
      mimeType: item.mimeType,
      imageBuffer: item.imageBuffer
    });
    const extension = guessExtension(item.filename, normalizedImage.mimeType);
    const outputName = `${createdAt.slice(0, 10)}-${id}-${savedItems.length + 1}${extension}`;
    const outputPath = path.join(config.media.intakeDir, outputName);
    await fs.writeFile(outputPath, normalizedImage.imageBuffer);

    let publicUrl = resolvePublicMediaUrl(outputPath);
    let hostedImage = null;
    if (hasRealCloudinaryConfig()) {
      try {
        console.log(`Pre-hosting carousel slide ${item.filename} to Cloudinary...`);
        const hosted = await hostImageAsset(outputPath);
        if (hosted?.publicUrl) {
          publicUrl = hosted.publicUrl;
          hostedImage = hosted;
        }
      } catch (err) {
        console.error('Failed to pre-host carousel slide to Cloudinary:', err);
      }
    }

    savedItems.push({
      filename: item.filename || outputName,
      mimeType: normalizedImage.mimeType,
      imagePath: outputPath,
      imageUrl: publicUrl,
      hostedImage
    });
  }

  const record = {
    id,
    source: 'whatsapp',
    messageId: normalizedMessageIds[0] || null,
    messageIds: normalizedMessageIds,
    chatId,
    chatName: chatName || null,
    fromMe: Boolean(fromMe),
    body: body || '',
    filename: savedItems[0]?.filename || `${id}.jpg`,
    mimeType: savedItems[0]?.mimeType || 'image/jpeg',
    mediaKind: 'image',
    isCarousel: true,
    carouselSize: savedItems.length,
    imagePath: savedItems[0]?.imagePath || null,
    imageUrl: savedItems[0]?.imageUrl || null,
    imagePaths: savedItems.map((item) => item.imagePath),
    imageUrls: savedItems.map((item) => item.imageUrl),
    hostedImages: savedItems.map((item) => item.hostedImage).filter(Boolean),
    files: savedItems,
    status: 'received',
    createdAt,
    updatedAt: createdAt
  };

  intakes.set(id, record);
  await persistIntake(record);
  return record;
}
