import { config, hasRealCloudinaryConfig, isPublicHttpUrl } from '../config.js';
import { uploadVideoToCloudinary } from './cloudinary.js';
import { resolvePublicMediaUrl } from './public-url.js';

export function getReelHostingStatus() {
  return {
    configured: hasRealCloudinaryConfig() || isPublicHttpUrl(config.publicBaseUrl),
    provider: hasRealCloudinaryConfig() ? 'cloudinary' : 'local_public_url'
  };
}

export async function hostRenderedReel(filePath) {
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
