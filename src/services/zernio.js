import { config, hasRealZernioConfig } from '../config.js';
import { addApiLog, extractInterestingHeaders } from './api-logs.js';
import { fetchWithPolicy } from './http-client.js';

function buildHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`
  };
}

async function parseZernioResponse(response, meta = {}) {
  const payload = await response.json().catch(() => ({}));
  const firstError = payload?.error?.message || payload?.errors?.[0]?.message || null;
  addApiLog({
    service: 'zernio',
    operation: meta.operation || 'request',
    status: response.ok && !firstError ? 'success' : 'error',
    model: null,
    durationMs: meta.startedAt ? Date.now() - meta.startedAt : null,
    usage: null,
    limits: {
      headers: extractInterestingHeaders(response.headers)
    },
    http: {
      status: response.status
    },
    details: {
      url: meta.url || null,
      method: meta.method || 'GET'
    },
    summary: response.ok && !firstError ? 'Zernio request completed.' : 'Zernio request failed.',
    error: firstError
  });

  if (!response.ok) {
    throw new Error(firstError || `Zernio request failed with status ${response.status}`);
  }

  if (firstError) {
    throw new Error(firstError);
  }

  return payload;
}

async function zernioRequest({ apiKey, method = 'GET', path, body = null, operation = 'request' }) {
  const startedAt = Date.now();
  const response = await fetchWithPolicy(`${config.zernio.apiBaseUrl}${path}`, {
    method,
    headers: buildHeaders(apiKey),
    body: body ? JSON.stringify(body) : undefined,
    logContext: {
      service: 'zernio',
      operation
    }
  });

  return parseZernioResponse(response, {
    startedAt,
    operation,
    url: `${config.zernio.apiBaseUrl}${path}`,
    method
  });
}

export function getZernioStatus() {
  return {
    configured: hasRealZernioConfig(),
    apiBaseUrl: config.zernio.apiBaseUrl,
    accountId: config.zernio.accountId || null,
    pinterestBoardId: config.zernio.pinterestBoardId || null,
    pinterestBoardName: config.zernio.pinterestBoardName || null
  };
}

async function resolvePinterestBoardId(apiKey, accountId) {
  if (config.zernio.pinterestBoardId) {
    return config.zernio.pinterestBoardId;
  }

  const data = await zernioRequest({
    apiKey,
    method: 'GET',
    path: `/accounts/${encodeURIComponent(accountId)}/pinterest-boards`,
    operation: 'pinterest_boards_list'
  });

  const boards = Array.isArray(data?.data) ? data.data : Array.isArray(data?.boards) ? data.boards : [];
  if (boards.length === 0) {
    return null;
  }

  const desiredName = String(config.zernio.pinterestBoardName || '').trim().toLowerCase();
  const matched = desiredName
    ? boards.find((board) => String(board?.name || '').trim().toLowerCase() === desiredName)
    : null;

  return matched?.id || matched?._id || boards[0]?.id || boards[0]?._id || null;
}

function normalizePinterestTitle(title, content) {
  const raw = String(title || content || 'Pinterest pin').trim();
  return raw.length > 100 ? raw.slice(0, 100) : raw;
}

export async function publishPinterestImageViaZernio({
  imageUrl,
  caption,
  accountId,
  boardId = null,
  title = null,
  link = null
}) {
  if (!hasRealZernioConfig()) {
    throw new Error('Missing Zernio configuration. Set ZERNIO_API_KEY and ZERNIO_ACCOUNT_ID.');
  }

  if (!imageUrl) {
    throw new Error('A public image URL is required before publishing through Zernio.');
  }

  const apiKey = config.zernio.apiKey;
  const resolvedAccountId = accountId || config.zernio.accountId;
  if (!resolvedAccountId) {
    throw new Error('Missing Zernio account ID. Set ZERNIO_ACCOUNT_ID.');
  }

  const resolvedBoardId = boardId || await resolvePinterestBoardId(apiKey, resolvedAccountId);
  if (!resolvedBoardId) {
    throw new Error('No Pinterest board was found for the selected Zernio account.');
  }

  const resolvedTitle = normalizePinterestTitle(title, caption);
  const payload = {
    content: caption || resolvedTitle,
    mediaItems: [
      {
        type: 'image',
        url: imageUrl
      }
    ],
    platforms: [
      {
        platform: 'pinterest',
        accountId: resolvedAccountId,
        platformSpecificData: {
          title: resolvedTitle,
          boardId: resolvedBoardId,
          ...(link ? { link } : {}),
          coverImageUrl: imageUrl
        }
      }
    ],
    publishNow: true
  };

  const data = await zernioRequest({
    apiKey,
    method: 'POST',
    path: '/posts',
    body: payload,
    operation: 'posts_create'
  });

  return {
    provider: 'zernio',
    post: data?.post || data?.data?.post || data?.data || null,
    raw: data
  };
}

export async function publishPinterestVideoViaZernio({
  videoUrl,
  caption,
  accountId,
  boardId = null,
  title = null,
  link = null
}) {
  if (!hasRealZernioConfig()) {
    throw new Error('Missing Zernio configuration. Set ZERNIO_API_KEY and ZERNIO_ACCOUNT_ID.');
  }

  if (!videoUrl) {
    throw new Error('A public video URL is required before publishing through Zernio.');
  }

  const apiKey = config.zernio.apiKey;
  const resolvedAccountId = accountId || config.zernio.accountId;
  if (!resolvedAccountId) {
    throw new Error('Missing Zernio account ID. Set ZERNIO_ACCOUNT_ID.');
  }

  const resolvedBoardId = boardId || await resolvePinterestBoardId(apiKey, resolvedAccountId);
  if (!resolvedBoardId) {
    throw new Error('No Pinterest board was found for the selected Zernio account.');
  }

  const resolvedTitle = normalizePinterestTitle(title, caption);
  const payload = {
    content: caption || resolvedTitle,
    mediaItems: [
      {
        type: 'video',
        url: videoUrl
      }
    ],
    platforms: [
      {
        platform: 'pinterest',
        accountId: resolvedAccountId,
        platformSpecificData: {
          title: resolvedTitle,
          boardId: resolvedBoardId,
          ...(link ? { link } : {})
        }
      }
    ],
    publishNow: true
  };

  const data = await zernioRequest({
    apiKey,
    method: 'POST',
    path: '/posts',
    body: payload,
    operation: 'posts_create_video'
  });

  return {
    provider: 'zernio',
    post: data?.post || data?.data?.post || data?.data || null,
    raw: data
  };
}
