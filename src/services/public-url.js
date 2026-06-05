import path from 'node:path';
import { config, hasRealCloudinaryConfig, isPublicHttpUrl } from '../config.js';

function toPosixPath(value) {
  return value.split(path.sep).join('/');
}

export function resolvePublicMediaUrl(filePath) {
  const relativePath = path.relative(config.media.dir, filePath);
  if (relativePath.startsWith('..')) {
    throw new Error('Media file is outside the configured media directory.');
  }

  return `${config.publicBaseUrl}${config.media.publicRoute}/${toPosixPath(relativePath)}`;
}

export function assertPublicMediaHosting() {
  if (!hasRealCloudinaryConfig() && !isPublicHttpUrl(config.publicBaseUrl)) {
    throw new Error(
      'Configure Cloudinary video uploads or set PUBLIC_BASE_URL to a real public URL before Buffer can fetch scheduled reel videos.'
    );
  }
}
