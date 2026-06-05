import { config, hasRealInstagramGraphConfig } from '../config.js';
import { addApiLog, extractInterestingHeaders } from './api-logs.js';
import { fetchWithPolicy } from './http-client.js';

function getGraphBaseUrl() {
  return `https://graph.facebook.com/${config.instagramGraph.apiVersion}`;
}

function buildBody(params) {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    body.set(key, String(value));
  }
  return body;
}

async function parseJsonSafe(response) {
  return response.json().catch(() => ({}));
}

async function graphPost(endpoint, params, operation) {
  const startedAt = Date.now();
  const response = await fetchWithPolicy(`${getGraphBaseUrl()}${endpoint}`, {
    method: 'POST',
    body: buildBody(params),
    logContext: {
      service: 'instagram-graph',
      operation
    }
  });
  const payload = await parseJsonSafe(response);

  addApiLog({
    service: 'instagram-graph',
    operation,
    status: response.ok ? 'success' : 'error',
    durationMs: Date.now() - startedAt,
    limits: {
      headers: extractInterestingHeaders(response.headers)
    },
    http: {
      status: response.status
    },
    details: {
      url: `${getGraphBaseUrl()}${endpoint}`,
      method: 'POST'
    },
    summary: response.ok ? 'Instagram Graph request completed.' : 'Instagram Graph request failed.',
    error: response.ok ? null : payload?.error?.message || `Instagram Graph request failed with status ${response.status}`
  });

  if (!response.ok) {
    throw new Error(payload?.error?.message || `Instagram Graph request failed with status ${response.status}`);
  }

  return payload;
}

async function graphGet(endpoint, params, operation) {
  const startedAt = Date.now();
  const url = new URL(`${getGraphBaseUrl()}${endpoint}`);
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });
  const response = await fetchWithPolicy(url.toString(), {
    method: 'GET',
    logContext: {
      service: 'instagram-graph',
      operation
    }
  });
  const payload = await parseJsonSafe(response);

  addApiLog({
    service: 'instagram-graph',
    operation,
    status: response.ok ? 'success' : 'error',
    durationMs: Date.now() - startedAt,
    limits: {
      headers: extractInterestingHeaders(response.headers)
    },
    http: {
      status: response.status
    },
    details: {
      url: url.toString(),
      method: 'GET'
    },
    summary: response.ok ? 'Instagram Graph request completed.' : 'Instagram Graph request failed.',
    error: response.ok ? null : payload?.error?.message || `Instagram Graph request failed with status ${response.status}`
  });

  if (!response.ok) {
    throw new Error(payload?.error?.message || `Instagram Graph request failed with status ${response.status}`);
  }

  return payload;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForContainerReady(containerId, operation) {
  const maxAttempts = 12;
  const delayMs = 5000;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const status = await graphGet(
      `/${containerId}`,
      {
        fields: 'id,status_code,status',
        access_token: config.instagramGraph.accessToken
      },
      operation
    );

    if (status.status_code === 'FINISHED') {
      return status;
    }

    if (['ERROR', 'EXPIRED'].includes(status.status_code)) {
      throw new Error(`Instagram Graph container ${containerId} is ${status.status_code}: ${status.status || 'no status detail'}`);
    }

    await sleep(delayMs);
  }

  throw new Error(`Instagram Graph container ${containerId} was not ready after ${maxAttempts} checks.`);
}

export async function publishInstagramCarouselViaGraph({
  imageUrls,
  caption
}) {
  if (!hasRealInstagramGraphConfig()) {
    throw new Error('GRAPH_IG_USER_ID and GRAPH_ACCESS_TOKEN are required for official Graph carousel publishing.');
  }

  const normalizedUrls = (Array.isArray(imageUrls) ? imageUrls : []).filter(Boolean);
  if (normalizedUrls.length < 2) {
    throw new Error('Instagram Graph carousel publishing requires at least 2 public image URLs.');
  }

  const childIds = [];
  for (const imageUrl of normalizedUrls) {
    const container = await graphPost(
      `/${config.instagramGraph.igUserId}/media`,
      {
        image_url: imageUrl,
        is_carousel_item: 'true',
        access_token: config.instagramGraph.accessToken
      },
      'createCarouselChildContainer'
    );
    childIds.push(container.id);
  }

  const parent = await graphPost(
    `/${config.instagramGraph.igUserId}/media`,
    {
      media_type: 'CAROUSEL',
      children: childIds.join(','),
      caption,
      access_token: config.instagramGraph.accessToken
    },
    'createCarouselParentContainer'
  );

  await waitForContainerReady(parent.id, 'waitCarouselParentContainer');

  const published = await graphPost(
    `/${config.instagramGraph.igUserId}/media_publish`,
    {
      creation_id: parent.id,
      access_token: config.instagramGraph.accessToken
    },
    'publishCarousel'
  );

  const media = await graphGet(
    `/${published.id}`,
    {
      fields: 'id,permalink,media_product_type',
      access_token: config.instagramGraph.accessToken
    },
    'readPublishedCarousel'
  );

  return {
    provider: 'instagram-graph',
    postId: media.id || published.id || null,
    containerId: parent.id || null,
    childIds,
    permalink: media.permalink || null,
    mediaProductType: media.media_product_type || null
  };
}
