import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

const DEFAULT_PORT = 3000;

function normalizeString(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim();
}

function env(name, fallback = '') {
  const value = normalizeString(process.env[name]);
  return value || fallback;
}

function parsePort(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : DEFAULT_PORT;
}

function parseInteger(name, fallback) {
  const parsed = Number.parseInt(env(name, String(fallback)), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseNumber(name, fallback) {
  const parsed = Number.parseFloat(env(name, String(fallback)));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(name, fallback = false) {
  const value = env(name, fallback ? 'true' : 'false').toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(value);
}

function normalizeBaseUrl(name, fallback) {
  const value = env(name, fallback).replace(/\/+$/, '');
  return value || fallback.replace(/\/+$/, '');
}

function normalizeRoute(name, fallback) {
  const route = env(name, fallback).trim();
  if (!route) {
    return fallback;
  }

  return route.startsWith('/') ? route : `/${route}`;
}

function isPlaceholderSecret(value) {
  const normalized = normalizeString(value).toLowerCase();
  return (
    !normalized ||
    normalized === 'replace-me' ||
    normalized === 'your-api-key' ||
    normalized === 'your_buffer_api_key' ||
    normalized === 'your_app_password' ||
    normalized === 'your_32_char_or_longer_secret_here'
  );
}

const port = parsePort(env('PORT', String(DEFAULT_PORT)));
const appBaseUrl = normalizeBaseUrl('APP_BASE_URL', `http://localhost:${port}`);

export const config = {
  port,
  appBaseUrl,
  publicBaseUrl: normalizeBaseUrl('PUBLIC_BASE_URL', appBaseUrl),
  environment: env('NODE_ENV', 'development'),
  auth: {
    enabled: parseBoolean('APP_AUTH_ENABLED', false),
    password: env('APP_AUTH_PASSWORD'),
    sessionSecret: env('APP_SESSION_SECRET'),
    cookieName: env('APP_AUTH_COOKIE', 'insta_automation_session'),
    sessionTtlMs: parseInteger('APP_SESSION_TTL_MS', 1000 * 60 * 60 * 12)
  },
  security: {
    encryptionKey: env('APP_ENCRYPTION_KEY'),
    trustedOrigins: env('APP_TRUSTED_ORIGINS')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    rateLimit: {
      windowMs: parseInteger('APP_RATE_LIMIT_WINDOW_MS', 60_000),
      maxRead: parseInteger('APP_RATE_LIMIT_READ_MAX', 180),
      maxWrite: parseInteger('APP_RATE_LIMIT_WRITE_MAX', 40)
    }
  },
  http: {
    timeoutMs: parseInteger('OUTBOUND_HTTP_TIMEOUT_MS', 20_000),
    retries: parseInteger('OUTBOUND_HTTP_RETRIES', 2),
    retryDelayMs: parseInteger('OUTBOUND_HTTP_RETRY_DELAY_MS', 800)
  },
  runtimeLogFile: env('RUNTIME_LOG_FILE', path.resolve(process.cwd(), 'data', 'runtime.log.txt')),
  bufferSessionFile: env('BUFFER_SESSION_FILE', path.resolve(process.cwd(), 'data', 'buffer-session.json')),
  shortLinksFile: env('SHORT_LINKS_FILE', path.resolve(process.cwd(), 'data', 'short-links.json')),
  jobsFile: env('JOB_STORE_FILE', path.resolve(process.cwd(), 'data', 'jobs.json')),
  apiLogsFile: env('API_LOG_FILE', path.resolve(process.cwd(), 'data', 'api-logs.jsonl')),
  auditLogsFile: env('AUDIT_LOG_FILE', path.resolve(process.cwd(), 'data', 'audit-log.jsonl')),
  queueStore: {
    provider: env('QUEUE_STORE_PROVIDER', 'local_json'),
    supabaseUrl: normalizeBaseUrl('SUPABASE_URL', ''),
    supabaseServiceRoleKey: env('SUPABASE_SERVICE_ROLE_KEY'),
    jobsTable: env('SUPABASE_JOBS_TABLE', 'automation_jobs'),
    intakesTable: env('SUPABASE_INTAKES_TABLE', 'automation_intakes'),
    settingsTable: env('SUPABASE_SETTINGS_TABLE', 'automation_settings')
  },
  jobs: {
    workerEnabled: parseBoolean('JOB_WORKER_ENABLED', true),
    workerIntervalMs: parseInteger('JOB_WORKER_INTERVAL_MS', 750)
  },
  media: {
    dir: env('MEDIA_ROOT_DIR', path.resolve(process.cwd(), 'data', 'media')),
    publicRoute: normalizeRoute('MEDIA_PUBLIC_ROUTE', '/media'),
    intakeDir: env('INTAKE_DIR', path.resolve(process.cwd(), 'data', 'media', 'intake')),
    enhancedDir: env('ENHANCED_DIR', path.resolve(process.cwd(), 'data', 'media', 'enhanced')),
    reelsDir: env('REELS_DIR', path.resolve(process.cwd(), 'data', 'media', 'reels')),
    intakesFile: env('INTAKES_FILE', path.resolve(process.cwd(), 'data', 'intakes.json'))
  },
  buffer: {
    apiKey: env('BUFFER_API_KEY'),
    defaultChannelId: env('BUFFER_DEFAULT_CHANNEL_ID'),
    pinterestBoardName: env('BUFFER_PINTEREST_BOARD_NAME', 'social'),
    apiBaseUrl: 'https://api.buffer.com'
  },
  zernio: {
    apiKey: env('ZERNIO_API_KEY'),
    accountId: env('ZERNIO_ACCOUNT_ID'),
    pinterestBoardId: env('ZERNIO_PINTEREST_BOARD_ID'),
    pinterestBoardName: env('ZERNIO_PINTEREST_BOARD_NAME', 'social'),
    apiBaseUrl: normalizeBaseUrl('ZERNIO_API_URL', 'https://zernio.com/api/v1')
  },
  cloudinary: {
    cloudName: env('CLOUDINARY_CLOUD_NAME'),
    uploadPreset: env('CLOUDINARY_UPLOAD_PRESET'),
    folder: env('CLOUDINARY_UPLOAD_FOLDER', 'sanatan-dharma-ai/reels'),
    uploadTimeoutMs: parseInteger('CLOUDINARY_UPLOAD_TIMEOUT_MS', 600_000),
    uploadRetries: parseInteger('CLOUDINARY_UPLOAD_RETRIES', 0)
  },
  instagramGraph: {
    igUserId: env('GRAPH_IG_USER_ID'),
    accessToken: env('GRAPH_ACCESS_TOKEN'),
    apiVersion: env('GRAPH_API_VERSION', 'v25.0')
  },
  whatsapp: {
    enabled: parseBoolean('WHATSAPP_ENABLED', true),
    clientId: env('WHATSAPP_CLIENT_ID', 'sanatan-dharma-ai'),
    authDir: env('WHATSAPP_AUTH_DIR', path.resolve(process.cwd(), 'data', '.wwebjs_auth')),
    headless: parseBoolean('WHATSAPP_HEADLESS', true),
    webVersionCacheType: env('WHATSAPP_WEB_CACHE_TYPE', 'local'),
    chromePath: env('WHATSAPP_CHROME_PATH'),
    allowedChatId: env('WHATSAPP_ALLOWED_CHAT_ID'),
    allowedChatName: env('WHATSAPP_ALLOWED_CHAT_NAME', 'You'),
    notificationChatId: env('WHATSAPP_NOTIFICATION_CHAT_ID'),
    notificationChatName: env('WHATSAPP_NOTIFICATION_CHAT_NAME'),
    acceptDocumentOnly: parseBoolean('WHATSAPP_ACCEPT_DOCUMENT_ONLY', true),
    carouselWindowMs: parseInteger('WHATSAPP_CAROUSEL_WINDOW_MS', 5 * 60 * 1000)
  },
  music: {
    libraryFile: env('MUSIC_LIBRARY_FILE', path.resolve(process.cwd(), 'data', 'music-library.json')),
    directory: env('MUSIC_DIRECTORY', path.resolve(process.cwd(), 'data', 'music')),
    defaultDurationSeconds: parseInteger('REEL_DURATION_SECONDS', 11),
    audioFadeOutSeconds: parseNumber('REEL_AUDIO_FADE_OUT_SECONDS', 1.5)
  },
  captioning: {
    maxHashtags: parseInteger('CAPTION_MAX_HASHTAGS', 5),
    maxCaptionLength: parseInteger('CAPTION_MAX_LENGTH', 520),
    cloudflare: {
      accountId: env('CLOUDFLARE_ACCOUNT_ID'),
      apiToken: env('CLOUDFLARE_API_TOKEN'),
      model: env('CLOUDFLARE_CAPTION_MODEL', '@cf/zai-org/glm-4.7-flash'),
      temperature: parseNumber('CLOUDFLARE_CAPTION_TEMPERATURE', 0.8),
      imageAssistEnabled: parseBoolean('CLOUDFLARE_CAPTION_USE_IMAGE', true),
      visionModel: env('CLOUDFLARE_CAPTION_VISION_MODEL', '@cf/meta/llama-4-scout-17b-16e-instruct'),
      imageMaxDimension: parseInteger('CLOUDFLARE_CAPTION_IMAGE_MAX_DIMENSION', 896),
      imageQuality: parseInteger('CLOUDFLARE_CAPTION_IMAGE_QUALITY', 78)
    }
  },
  reels: {
    width: parseInteger('REEL_WIDTH', 1080),
    height: parseInteger('REEL_HEIGHT', 1920),
    fps: parseInteger('REEL_FPS', 30),
    videoBitrate: env('REEL_VIDEO_BITRATE', '6000k'),
    audioBitrate: env('REEL_AUDIO_BITRATE', '128k'),
    zoomAmount: parseNumber('REEL_ZOOM_AMOUNT', 0.05)
  },
  imageEnhancement: {
    enabled: parseBoolean('IMAGE_ENHANCEMENT_ENABLED', true),
    allowUpscale: parseBoolean('IMAGE_ALLOW_UPSCALE', true),
    canvasWidth: parseInteger('ENHANCED_IMAGE_WIDTH', 1440),
    canvasHeight: parseInteger('ENHANCED_IMAGE_HEIGHT', 2560),
    sharpenSigma: parseNumber('IMAGE_SHARPEN_SIGMA', 1.1),
    sharpenFlat: parseNumber('IMAGE_SHARPEN_FLAT', 1.2),
    sharpenJagged: parseNumber('IMAGE_SHARPEN_JAGGED', 2.5),
    subjectBrightness: parseNumber('IMAGE_SUBJECT_BRIGHTNESS', 1.02),
    subjectSaturation: parseNumber('IMAGE_SUBJECT_SATURATION', 1.05),
    backdropBlur: parseNumber('IMAGE_BACKDROP_BLUR', 28),
    backdropBrightness: parseNumber('IMAGE_BACKDROP_BRIGHTNESS', 0.7),
    backdropSaturation: parseNumber('IMAGE_BACKDROP_SATURATION', 0.95)
  },
  scheduler: {
    timezone: env('INSTAGRAM_TIMEZONE', 'Asia/Kolkata'),
    minPostsPerDay: parseInteger('POSTS_MIN_PER_DAY', 1),
    maxPostsPerDay: parseInteger('POSTS_MAX_PER_DAY', 3),
    minGapHours: parseInteger('POSTS_MIN_GAP_HOURS', 4),
    lookAheadDays: parseInteger('POSTS_LOOK_AHEAD_DAYS', 10),
    secondSlotThreshold: parseInteger('POSTS_SECOND_SLOT_THRESHOLD', 3),
    thirdSlotThreshold: parseInteger('POSTS_THIRD_SLOT_THRESHOLD', 8),
    overnightStartHour: parseInteger('POSTS_OVERNIGHT_START_HOUR', 2),
    overnightEndHour: parseInteger('POSTS_OVERNIGHT_END_HOUR', 3),
    executionMode: env('SCHEDULER_EXECUTION_MODE', 'local_worker'),
    settingsFile: env('SCHEDULER_SETTINGS_FILE', path.resolve(process.cwd(), 'data', 'scheduler-settings.json'))
  },
  account: {
    handle: env('INSTAGRAM_HANDLE', '@sanatan.dharma.ai'),
    brandName: env('BRAND_NAME', 'SANATAN DHARMA'),
    niche: env('ACCOUNT_NICHE', 'Bhakti myth toon art for a Sanatani audience'),
    audience: env('ACCOUNT_AUDIENCE', 'Indian youth and middle-aged Hindu audience'),
    tone: env('ACCOUNT_TONE', 'Aspirational, devotional, emotionally touching, Gen Z-friendly'),
    captionLanguage: env('CAPTION_LANGUAGE', 'English'),
    musicLanguage: env('MUSIC_LANGUAGE', 'Hindi')
  }
};

export function hasRealEncryptionKey() {
  return normalizeString(config.security.encryptionKey).length >= 32;
}

export function hasRealBufferConfig() {
  return !isPlaceholderSecret(config.buffer.apiKey);
}

export function hasRealZernioConfig() {
  return !isPlaceholderSecret(config.zernio.apiKey) && Boolean(normalizeString(config.zernio.accountId));
}

export function hasRealCloudinaryConfig() {
  return Boolean(normalizeString(config.cloudinary.cloudName) && normalizeString(config.cloudinary.uploadPreset));
}

export function hasRealInstagramGraphConfig() {
  return Boolean(normalizeString(config.instagramGraph.igUserId) && normalizeString(config.instagramGraph.accessToken));
}

export function hasRealCaptionProviderConfig() {
  return Boolean(
    normalizeString(config.captioning.cloudflare.accountId) &&
    normalizeString(config.captioning.cloudflare.apiToken)
  );
}

export function isAuthConfigured() {
  if (!config.auth.enabled) {
    return false;
  }

  return Boolean(normalizeString(config.auth.password) && normalizeString(config.auth.sessionSecret));
}

export function isPublicHttpUrl(value) {
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();

    if (!['http:', 'https:'].includes(url.protocol)) {
      return false;
    }

    if (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '0.0.0.0' ||
      hostname === '::1' ||
      hostname.endsWith('.local')
    ) {
      return false;
    }

    if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname)) {
      const [first, second] = hostname.split('.').map((part) => Number.parseInt(part, 10));
      if (
        first === 10 ||
        first === 127 ||
        (first === 192 && second === 168) ||
        (first === 172 && second >= 16 && second <= 31)
      ) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}

export function getConfigWarnings() {
  const warnings = [];

  if (config.auth.enabled && !isAuthConfigured()) {
    warnings.push('APP_AUTH_ENABLED is on, but APP_AUTH_PASSWORD or APP_SESSION_SECRET is missing.');
  }

  if (!hasRealEncryptionKey()) {
    warnings.push('APP_ENCRYPTION_KEY is missing or too short; persisted secrets will stay unencrypted.');
  }

  if (!hasRealBufferConfig()) {
    warnings.push('BUFFER_API_KEY is missing.');
  }

  if (!hasRealCloudinaryConfig() && !isPublicHttpUrl(config.publicBaseUrl)) {
    warnings.push('Set Cloudinary upload settings or a public PUBLIC_BASE_URL so Buffer can fetch rendered reel videos.');
  }

  if (!hasRealInstagramGraphConfig()) {
    warnings.push('GRAPH_IG_USER_ID or GRAPH_ACCESS_TOKEN is missing; official Graph carousel publishing will be unavailable.');
  }

  if (config.queueStore.provider === 'supabase' && !(
    config.queueStore.supabaseUrl &&
    config.queueStore.supabaseServiceRoleKey &&
    config.queueStore.jobsTable &&
    config.queueStore.intakesTable
  )) {
    warnings.push('QUEUE_STORE_PROVIDER=supabase requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_JOBS_TABLE, and SUPABASE_INTAKES_TABLE.');
  }

  if (!hasRealCaptionProviderConfig()) {
    warnings.push('Cloudflare caption AI is not configured; the app will use the local fallback caption writer.');
  }

  if (!config.whatsapp.allowedChatId && !config.whatsapp.allowedChatName) {
    warnings.push('Set WHATSAPP_ALLOWED_CHAT_ID or WHATSAPP_ALLOWED_CHAT_NAME so the automation only processes your intended chat.');
  }

  return warnings;
}
