import fs from 'node:fs/promises';
import path from 'node:path';
import { Blob } from 'node:buffer';
import { config, hasRealCloudinaryConfig } from '../config.js';
import { addApiLog, extractInterestingHeaders } from './api-logs.js';
import { fetchWithPolicy } from './http-client.js';

function getUploadUrlForResource(resourceType) {
  return `https://api.cloudinary.com/v1_1/${config.cloudinary.cloudName}/${resourceType}/upload`;
}

export function getCloudinaryStatus() {
  return {
    configured: hasRealCloudinaryConfig(),
    cloudName: config.cloudinary.cloudName || null,
    folder: config.cloudinary.folder || null
  };
}

async function uploadMediaToCloudinary(filePath, resourceType) {
  if (!hasRealCloudinaryConfig()) {
    throw new Error('Cloudinary reel hosting is not configured.');
  }

  const startedAt = Date.now();
  const fileBuffer = await fs.readFile(filePath);
  const form = new FormData();
  form.set('upload_preset', config.cloudinary.uploadPreset);
  form.set('folder', config.cloudinary.folder);
  form.set('resource_type', resourceType);
  const parentName = path.basename(path.dirname(filePath));
  const fileName = path.basename(filePath, path.extname(filePath));
  const publicId = `${parentName}-${fileName}`.replace(/[^a-zA-Z0-9/_-]/g, '-');
  form.set('public_id', publicId);
  const mimeType = resourceType === 'image' ? 'image/jpeg' : 'video/mp4';
  form.set('file', new Blob([fileBuffer], { type: mimeType }), path.basename(filePath));

  const response = await fetchWithPolicy(getUploadUrlForResource(resourceType), {
    method: 'POST',
    body: form,
    timeoutMs: config.cloudinary.uploadTimeoutMs || 600_000,
    retries: Number.isInteger(config.cloudinary.uploadRetries) ? config.cloudinary.uploadRetries : 0,
    logContext: {
      service: 'cloudinary',
      operation: `${resourceType}-upload`
    }
  });

  const payload = await response.json().catch(() => ({}));
  addApiLog({
    service: 'cloudinary',
    operation: 'video-upload',
    status: response.ok ? 'success' : 'error',
    model: null,
    durationMs: Date.now() - startedAt,
    usage: null,
    limits: {
      headers: extractInterestingHeaders(response.headers)
    },
    http: {
      status: response.status
    },
    details: {
      url: getUploadUrlForResource(resourceType),
      method: 'POST',
      resourceType
    },
    summary: response.ok
      ? `Cloudinary ${resourceType} upload completed.`
      : `Cloudinary ${resourceType} upload failed.`,
    error: response.ok ? null : payload?.error?.message || `Upload failed with status ${response.status}`
  });

  if (!response.ok) {
    throw new Error(payload?.error?.message || `Cloudinary upload failed with status ${response.status}`);
  }

  return {
    provider: 'cloudinary',
    publicUrl: payload.secure_url || payload.url || null,
    playbackUrl: payload.playback_url || null,
    assetId: payload.asset_id || null,
    publicId: payload.public_id || null,
    version: payload.version || null,
    bytes: payload.bytes || null,
    duration: payload.duration || null,
    width: payload.width || null,
    height: payload.height || null,
    raw: payload
  };
}

export async function uploadVideoToCloudinary(filePath) {
  return uploadMediaToCloudinary(filePath, 'video');
}

export async function uploadImageToCloudinary(filePath) {
  return uploadMediaToCloudinary(filePath, 'image');
}
