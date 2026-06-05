import { config } from '../config.js';
import { addApiLog, extractInterestingHeaders } from './api-logs.js';
import { fetchWithPolicy } from './http-client.js';
import { readTokenStore, writeTokenStore } from './token-store.js';
import { hasRealZernioConfig } from '../config.js';
import { publishPinterestImageViaZernio } from './zernio.js';

function buildHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`
  };
}

function getSessionFile() {
  return config.bufferSessionFile;
}

async function parseGraphqlResponse(response, meta = {}) {
  const payload = await response.json().catch(() => ({}));
  const firstError = payload?.errors?.[0]?.message || null;
  addApiLog({
    service: 'buffer',
    operation: meta.operation || 'graphql',
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
      method: meta.method || 'POST'
    },
    summary: response.ok && !firstError ? 'Buffer request completed.' : 'Buffer request failed.',
    error: firstError
  });

  if (!response.ok) {
    throw new Error(payload?.errors?.[0]?.message || `Buffer request failed with status ${response.status}`);
  }

  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new Error(payload.errors[0]?.message || 'Buffer GraphQL request failed');
  }

  return payload.data ?? {};
}

async function bufferRequest({ apiKey, query, variables }) {
  const startedAt = Date.now();
  const operationMatch = String(query).match(/\b(query|mutation)\s+([A-Za-z0-9_]+)/);
  const response = await fetchWithPolicy(config.buffer.apiBaseUrl, {
    method: 'POST',
    headers: buildHeaders(apiKey),
    body: JSON.stringify({ query, variables }),
    logContext: {
      service: 'buffer',
      operation: operationMatch?.[2] || 'graphql'
    }
  });

  return parseGraphqlResponse(response, {
    startedAt,
    operation: operationMatch?.[2] || 'graphql',
    url: config.buffer.apiBaseUrl,
    method: 'POST'
  });
}

export async function loadBufferSession() {
  return readTokenStore(getSessionFile());
}

export async function saveBufferSession(session) {
  const normalized = {
    provider: 'buffer',
    apiKey: session.apiKey,
    defaultChannelId: session.defaultChannelId ?? null,
    accountName: session.accountName ?? null,
    channelIdsByService: session.channelIdsByService ?? {},
    pinterestBoardsByChannelId: session.pinterestBoardsByChannelId ?? {},
    updatedAt: new Date().toISOString()
  };

  await writeTokenStore(getSessionFile(), normalized);
  return normalized;
}

export function redactBufferSession(session) {
  if (!session) {
    return null;
  }

  return {
    provider: 'buffer',
    defaultChannelId: session.defaultChannelId ?? null,
    accountName: session.accountName ?? null,
    channelIdsByService: session.channelIdsByService ?? {},
    pinterestBoardsByChannelId: session.pinterestBoardsByChannelId ?? {},
    updatedAt: session.updatedAt ?? null
  };
}

async function resolveBufferApiKey(providedApiKey) {
  if (providedApiKey) {
    return providedApiKey;
  }

  const session = await loadBufferSession();
  return config.buffer.apiKey || session?.apiKey || '';
}

export async function getBufferConnectionOverview(providedApiKey) {
  const apiKey = await resolveBufferApiKey(providedApiKey);
  if (!apiKey) {
    throw new Error('Missing Buffer API key');
  }

  const query = `
    query GetBufferAccount {
      account {
        id
        name
        email
        organizations {
          id
          name
          channels {
            id
            name
            displayName
            service
            avatar
            isQueuePaused
          }
        }
      }
    }
  `;

  const data = await bufferRequest({ apiKey, query });
  const account = data.account;
  if (!account) {
    throw new Error('Buffer did not return account details');
  }

  return {
    apiKey,
    account: {
      id: account.id,
      name: account.name ?? null,
      email: account.email ?? null
    },
    organizations: (account.organizations ?? []).map((organization) => ({
      id: organization.id,
      name: organization.name ?? null,
      channels: (organization.channels ?? []).map((channel) => ({
        id: channel.id,
        name: channel.name ?? null,
        displayName: channel.displayName ?? channel.name ?? null,
        service: channel.service ?? null,
        avatar: channel.avatar ?? null,
        isQueuePaused: Boolean(channel.isQueuePaused)
      }))
    }))
  };
}

export async function connectBuffer({ apiKey, defaultChannelId }) {
  const overview = await getBufferConnectionOverview(apiKey);
  const allChannels = overview.organizations.flatMap((organization) => organization.channels);
  const selectedChannelId = defaultChannelId || config.buffer.defaultChannelId || allChannels[0]?.id || null;

  if (!selectedChannelId) {
    throw new Error('No Buffer channels found. Connect your Instagram account to Buffer first.');
  }

  const selectedChannel = allChannels.find((channel) => channel.id === selectedChannelId);
  if (!selectedChannel) {
    throw new Error(`Buffer channel ${selectedChannelId} was not found for this account`);
  }

  const channelIdsByService = allChannels.reduce((acc, channel) => {
    const service = String(channel.service || '').trim().toLowerCase();
    if (!service) {
      return acc;
    }

    if (!acc[service]) {
      acc[service] = [];
    }

    acc[service].push(channel.id);
    return acc;
  }, {});

  const pinterestChannels = allChannels.filter((channel) => String(channel.service || '').toLowerCase() === 'pinterest');
  const pinterestBoardsByChannelId = {};
  for (const channel of pinterestChannels) {
    try {
      const details = await getBufferChannelDetails(apiKey, channel.id);
      pinterestBoardsByChannelId[channel.id] = details.boards;
    } catch {
      pinterestBoardsByChannelId[channel.id] = [];
    }
  }

  const session = await saveBufferSession({
    apiKey: overview.apiKey,
    defaultChannelId: selectedChannelId,
    accountName: overview.account.name || overview.account.email || 'Buffer account',
    channelIdsByService,
    pinterestBoardsByChannelId
  });

  return {
    session,
    account: overview.account,
    organizations: overview.organizations,
    selectedChannel
  };
}

async function getBufferChannelDetails(apiKey, channelId) {
  const query = `
    query GetBufferChannelDetails {
      channel(input: { id: ${quoteGraphqlString(channelId)} }) {
        id
        service
        name
        displayName
        metadata {
          ... on PinterestMetadata {
            boards {
              name
              serviceId
            }
          }
        }
      }
    }
  `;

  const data = await bufferRequest({ apiKey, query });
  const channel = data.channel;
  return {
    id: channel?.id || channelId,
    service: channel?.service || null,
    boards: (channel?.metadata?.boards || []).map((board) => ({
      name: board.name || null,
      serviceId: board.serviceId || null
    }))
  };
}

function findOrganizationIdForChannel(overview, channelId) {
  for (const organization of overview.organizations || []) {
    if ((organization.channels || []).some((channel) => channel.id === channelId)) {
      return organization.id || null;
    }
  }

  return null;
}

function quoteGraphqlString(value) {
  return JSON.stringify(value ?? '');
}

function buildAssetsBlock({ imageUrls = [], videoUrls = [], thumbnailUrl = null }) {
  const normalizedImageUrls = (Array.isArray(imageUrls) ? imageUrls : [imageUrls]).filter(Boolean);
  const normalizedVideoUrls = (Array.isArray(videoUrls) ? videoUrls : [videoUrls]).filter(Boolean);
  const assets = [
    ...normalizedImageUrls
      .map((url) => `{ image: { url: ${quoteGraphqlString(url)} } }`),
    ...normalizedVideoUrls
      .map((url) => {
        const fields = [`url: ${quoteGraphqlString(url)}`];
        if (thumbnailUrl) {
          fields.push(`thumbnailUrl: ${quoteGraphqlString(thumbnailUrl)}`);
        }
        return `{ video: { ${fields.join(', ')} } }`;
      })
  ];

  if (assets.length === 0) {
    return [];
  }

  return [
    `    assets: [${assets.join(', ')}]`
  ];
}

function buildInstagramMetadataBlock({
  type = 'reel',
  shouldShareToFeed = true,
  geolocation = null,
  stickerFields = null
}) {
  const lines = [
    '    metadata: {',
    '      instagram: {',
    `        type: ${type},`,
    `        shouldShareToFeed: ${shouldShareToFeed ? 'true' : 'false'}`
  ];

  if (geolocation) {
    lines[lines.length - 1] += ',';
    lines.push('        geolocation: {');
    lines.push(`          text: ${quoteGraphqlString(geolocation)}`);
    lines.push('        }');
  }

  if (stickerFields && Object.keys(stickerFields).length > 0) {
    lines[lines.length - 1] += ',';
    lines.push('        stickerFields: {');
    const entries = Object.entries(stickerFields).filter(([, value]) => Boolean(String(value || '').trim()));
    entries.forEach(([key, value], index) => {
      lines.push(`          ${key}: ${quoteGraphqlString(value)}${index === entries.length - 1 ? '' : ','}`);
    });
    lines.push('        }');
  }

  lines.push('      }');
  lines.push('    }');
  return lines;
}

function buildYoutubeMetadataBlock({
  title,
  categoryId = '22',
  privacy = 'public'
}) {
  const normalizedPrivacy = String(privacy || 'public').trim().toLowerCase() || 'public';
  return [
    '    metadata: {',
    '      youtube: {',
    `        title: ${quoteGraphqlString(title)},`,
    `        categoryId: ${quoteGraphqlString(categoryId)},`,
    `        privacy: ${normalizedPrivacy},`,
    '        madeForKids: false,',
    '        embeddable: true,',
    '        notifySubscribers: true',
    '      }',
    '    }'
  ];
}

function buildPinterestMetadataBlock({
  title,
  boardServiceId,
  link = null
}) {
  const lines = [
    '    metadata: {',
    '      pinterest: {',
    `        title: ${quoteGraphqlString(title)},`,
    `        boardServiceId: ${quoteGraphqlString(boardServiceId)}${link ? ',' : ''}`
  ];

  if (link) {
    lines.push(`        url: ${quoteGraphqlString(link)}`);
  }

  lines.push('      }');
  lines.push('    }');
  return lines;
}

function buildCreatePostMutation({
  channelId,
  text,
  mode,
  schedulingType = 'automatic',
  dueAt = null,
  assetBlockLines,
  metadataBlockLines
}) {
  const lines = [
    'mutation CreatePost {',
    '  createPost(input: {',
    `    text: ${quoteGraphqlString(text)},`,
    `    channelId: ${quoteGraphqlString(channelId)},`,
    `    schedulingType: ${schedulingType},`,
    `    mode: ${mode}`
  ];

  if (dueAt) {
    lines[lines.length - 1] += ',';
    lines.push(`    dueAt: ${quoteGraphqlString(dueAt)}`);
  }

  lines[lines.length - 1] += ',';
  lines.push(...metadataBlockLines);
  lines[lines.length - 1] += ',';
  lines.push(...assetBlockLines);

  lines.push('  }) {');
  lines.push('    ... on PostActionSuccess {');
  lines.push('      post {');
  lines.push('        id');
  lines.push('        text');
  lines.push('        status');
  lines.push('        shareMode');
  lines.push('        sharedNow');
  lines.push('        dueAt');
  lines.push('        channel {');
  lines.push('          id');
  lines.push('          name');
  lines.push('          displayName');
  lines.push('          service');
  lines.push('        }');
  lines.push('        assets {');
  lines.push('          id');
  lines.push('          mimeType');
  lines.push('          source');
  lines.push('        }');
  lines.push('      }');
  lines.push('    }');
  lines.push('    ... on MutationError {');
  lines.push('      message');
  lines.push('    }');
  lines.push('  }');
  lines.push('}');

  return lines.join('\n');
}

function normalizeBoardName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickPinterestBoard(boards) {
  const preferredName = normalizeBoardName(config.buffer.pinterestBoardName || 'social');
  const normalizedBoards = Array.isArray(boards) ? boards : [];

  const preferred = normalizedBoards.find((board) =>
    normalizeBoardName(board.name).includes(preferredName)
  );
  return preferred || normalizedBoards[0] || null;
}

async function getPinterestBoardServiceId(session, apiKey, channelId) {
  const cachedBoards = session?.pinterestBoardsByChannelId?.[channelId] || [];
  const cached = pickPinterestBoard(cachedBoards)?.serviceId || null;
  if (cached) {
    return cached;
  }

  const details = await getBufferChannelDetails(apiKey, channelId);
  const chosenBoard = pickPinterestBoard(details.boards);
  const boardServiceId = chosenBoard?.serviceId || null;
  if (boardServiceId && session) {
    session.pinterestBoardsByChannelId = {
      ...(session.pinterestBoardsByChannelId || {}),
      [channelId]: details.boards
    };
    await saveBufferSession(session);
  }

  return boardServiceId;
}

function getChannelIdForService(session, service) {
  const normalizedService = String(service || '').toLowerCase();
  const serviceChannel = session?.channelIdsByService?.[normalizedService]?.[0];
  if (serviceChannel) {
    return serviceChannel;
  }

  if (normalizedService === 'instagram') {
    return config.buffer.defaultChannelId || session?.defaultChannelId || null;
  }

  return null;
}

export async function listBufferScheduledPostsForChannel(channelId, { limit = 100 } = {}) {
  const apiKey = await resolveBufferApiKey();
  if (!apiKey) {
    throw new Error('Buffer is not connected. Add a Buffer API key first.');
  }

  if (!channelId) {
    throw new Error('Missing Buffer channel id.');
  }

  const overview = await getBufferConnectionOverview(apiKey);
  const organizationId = findOrganizationIdForChannel(overview, channelId);
  if (!organizationId) {
    throw new Error(`Could not resolve Buffer organization for channel ${channelId}.`);
  }

  const query = `
    query GetScheduledPostsForChannel {
      posts(
        first: ${Math.max(1, Math.min(limit, 250))}
        input: {
          organizationId: ${quoteGraphqlString(organizationId)}
          sort: [
            { field: dueAt, direction: asc }
            { field: createdAt, direction: desc }
          ]
          filter: {
            status: [scheduled]
            channelIds: [${quoteGraphqlString(channelId)}]
          }
        }
      ) {
        edges {
          node {
            id
            text
            dueAt
            createdAt
            channelId
            status
          }
        }
      }
    }
  `;

  const data = await bufferRequest({ apiKey, query });
  return (data.posts?.edges || [])
    .map((edge) => edge?.node)
    .filter(Boolean)
    .map((post) => ({
      id: post.id,
      text: post.text || '',
      dueAt: post.dueAt || null,
      createdAt: post.createdAt || null,
      channelId: post.channelId || channelId,
      status: post.status || 'scheduled',
      source: 'buffer'
    }));
}

async function publishBufferContent({
  channelId,
  text,
  mode,
  schedulingType = 'automatic',
  dueAt = null,
  assetBlockLines,
  metadataBlockLines
}) {
  const apiKey = await resolveBufferApiKey();

  if (!apiKey) {
    throw new Error('Buffer is not connected. Add a Buffer API key first.');
  }

  if (!channelId) {
    throw new Error('Missing Buffer channel id. Connect the relevant social channel first.');
  }

  const query = buildCreatePostMutation({
    channelId,
    text,
    mode,
    schedulingType,
    dueAt,
    assetBlockLines,
    metadataBlockLines
  });

  const data = await bufferRequest({ apiKey, query });
  const result = data.createPost;
  if (result?.message) {
    addApiLog({
      service: 'buffer',
      operation: 'CreatePostMutation',
      status: 'error',
      model: null,
      durationMs: null,
      usage: null,
      limits: null,
      http: null,
      summary: 'Buffer mutation rejected the post.',
      error: result.message
    });
    throw new Error(result.message);
  }

  if (!result?.post) {
    throw new Error('Buffer did not return the created post');
  }

  return {
    provider: 'buffer',
    postId: result.post.id,
    status: result.post.status ?? null,
    shareMode: result.post.shareMode ?? null,
    sharedNow: result.post.sharedNow ?? null,
    dueAt: result.post.dueAt ?? null,
    channel: result.post.channel ?? null,
    text
  };
}

export async function publishInstagramReelViaBuffer({
  videoUrl,
  caption,
  channelId,
  shareNow = false,
  dueAt = null,
  location = null
}) {
  const session = await loadBufferSession();
  const resolvedChannelId = channelId || getChannelIdForService(session, 'instagram');

  if (!videoUrl) {
    throw new Error('A public video URL is required before publishing through Buffer.');
  }

  const mode = dueAt ? 'customScheduled' : shareNow ? 'shareNow' : 'addToQueue';
  return publishBufferContent({
    channelId: resolvedChannelId,
    text: caption,
    mode,
    schedulingType: 'automatic',
    dueAt,
    assetBlockLines: buildAssetsBlock({ videoUrls: [videoUrl] }),
    metadataBlockLines: buildInstagramMetadataBlock({
      type: 'reel',
      shouldShareToFeed: true,
      geolocation: location
    })
  });
}

export async function publishInstagramImageViaBuffer({
  imageUrl,
  imageUrls,
  caption,
  channelId,
  shareNow = false,
  dueAt = null,
  location = null,
  publishingType = 'automatic',
  musicReminder = null
}) {
  const session = await loadBufferSession();
  const resolvedChannelId = channelId || getChannelIdForService(session, 'instagram');
  const normalizedImageUrls = (Array.isArray(imageUrls) ? imageUrls : [imageUrl]).filter(Boolean);

  if (normalizedImageUrls.length === 0) {
    throw new Error('A public image URL is required before publishing through Buffer.');
  }

  const mode = dueAt ? 'customScheduled' : shareNow ? 'shareNow' : 'addToQueue';
  const schedulingType = publishingType === 'notification' ? 'notification' : 'automatic';
  return publishBufferContent({
    channelId: resolvedChannelId,
    text: caption,
    mode,
    schedulingType,
    dueAt,
    assetBlockLines: buildAssetsBlock({ imageUrls: normalizedImageUrls }),
    metadataBlockLines: buildInstagramMetadataBlock({
      type: 'post',
      shouldShareToFeed: true,
      geolocation: location,
      stickerFields: schedulingType === 'notification'
        ? {
            music: musicReminder || 'Add music manually in Instagram before publishing.'
          }
        : null
    })
  });
}

export async function publishYoutubeVideoViaBuffer({
  videoUrl,
  caption,
  channelId,
  shareNow = false,
  dueAt = null,
  title
}) {
  const session = await loadBufferSession();
  const resolvedChannelId = channelId || getChannelIdForService(session, 'youtube');

  if (!videoUrl) {
    throw new Error('A public video URL is required before publishing through Buffer.');
  }

  const mode = dueAt ? 'customScheduled' : shareNow ? 'shareNow' : 'addToQueue';
  return publishBufferContent({
    channelId: resolvedChannelId,
    text: caption || title || '',
    mode,
    schedulingType: 'automatic',
    dueAt,
    assetBlockLines: buildAssetsBlock({ videoUrls: [videoUrl] }),
    metadataBlockLines: buildYoutubeMetadataBlock({
      title
    })
  });
}

export async function publishPinterestImageViaBuffer({
  imageUrl,
  caption,
  channelId,
  shareNow = false,
  dueAt = null,
  title,
  link = null
}) {
  if (hasRealZernioConfig()) {
    return publishPinterestImageViaZernio({
      imageUrl,
      caption,
      accountId: config.zernio.accountId,
      boardId: config.zernio.pinterestBoardId || null,
      title,
      link
    });
  }

  const session = await loadBufferSession();
  const apiKey = await resolveBufferApiKey();
  const resolvedChannelId = channelId || getChannelIdForService(session, 'pinterest');

  if (!imageUrl) {
    throw new Error('A public image URL is required before publishing through Buffer.');
  }

  if (!resolvedChannelId) {
    throw new Error('Missing Buffer Pinterest channel id. Connect Pinterest in Buffer first.');
  }

  const boardServiceId = await getPinterestBoardServiceId(session, apiKey, resolvedChannelId);
  if (!boardServiceId) {
    throw new Error('No Pinterest board is connected for the selected Buffer Pinterest channel.');
  }

  const mode = dueAt ? 'customScheduled' : shareNow ? 'shareNow' : 'addToQueue';
  return publishBufferContent({
    channelId: resolvedChannelId,
    text: caption || title || '',
    mode,
    schedulingType: 'automatic',
    dueAt,
    assetBlockLines: buildAssetsBlock({ imageUrls: [imageUrl] }),
    metadataBlockLines: buildPinterestMetadataBlock({
      title,
      boardServiceId,
      link
    })
  });
}

export async function publishPinterestVideoViaBuffer({
  videoUrl,
  caption,
  channelId,
  shareNow = false,
  dueAt = null,
  title,
  link = null
}) {
  const session = await loadBufferSession();
  const apiKey = await resolveBufferApiKey();
  const resolvedChannelId = channelId || getChannelIdForService(session, 'pinterest');

  if (!videoUrl) {
    throw new Error('A public video URL is required before publishing through Buffer.');
  }

  if (!resolvedChannelId) {
    throw new Error('Missing Buffer Pinterest channel id. Connect Pinterest in Buffer first.');
  }

  const boardServiceId = await getPinterestBoardServiceId(session, apiKey, resolvedChannelId);
  if (!boardServiceId) {
    throw new Error('No Pinterest board is connected for the selected Buffer Pinterest channel.');
  }

  const mode = dueAt ? 'customScheduled' : shareNow ? 'shareNow' : 'addToQueue';
  return publishBufferContent({
    channelId: resolvedChannelId,
    text: caption || title || '',
    mode,
    schedulingType: 'automatic',
    dueAt,
    assetBlockLines: buildAssetsBlock({ videoUrls: [videoUrl] }),
    metadataBlockLines: buildPinterestMetadataBlock({
      title,
      boardServiceId,
      link
    })
  });
}

export async function publishViaBuffer({
  videoUrl,
  caption,
  channelId,
  shareNow = false,
  dueAt = null
}) {
  return publishInstagramReelViaBuffer({
    videoUrl,
    caption,
    channelId,
    shareNow,
    dueAt
  });
}

export const __test__ = {
  buildAssetsBlock
};
