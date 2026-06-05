import { config, hasRealCloudinaryConfig, isPublicHttpUrl } from '../config.js';
import { uploadImageToCloudinary, uploadVideoToCloudinary } from './cloudinary.js';
import { resolvePublicMediaUrl } from './public-url.js';

export function getMediaHostingStatus() {
  return {
    configured: hasRealCloudinaryConfig() || isPublicHttpUrl(config.publicBaseUrl),
    provider: hasRealCloudinaryConfig() ? 'cloudinary' : 'local_public_url'
  };
}

export async function hostImageAsset(filePath) {
  if (hasRealCloudinaryConfig()) {
    const uploaded = await uploadImageToCloudinary(filePath);
    return {
      provider: 'cloudinary',
      publicUrl: uploaded.publicUrl,
      uploaded
    };
  }

  return {
    provider: 'local_public_url',
    publicUrl: resolvePublicMediaUrl(filePath),
    uploaded: null
  };
}

export async function hostVideoAsset(filePath) {
  if (hasRealCloudinaryConfig()) {
    const uploaded = await uploadVideoToCloudinary(filePath);
    return {
      provider: 'cloudinary',
      publicUrl: uploaded.publicUrl,
      uploaded
    };
  }

  return {
    provider: 'local_public_url',
    publicUrl: resolvePublicMediaUrl(filePath),
    uploaded: null
  };
}
