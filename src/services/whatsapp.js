import fs from 'node:fs/promises';
import path from 'node:path';
import QRCode from 'qrcode';
import whatsapp from 'whatsapp-web.js';
import { config } from '../config.js';
import { addApiLog, addAuditLog } from './api-logs.js';
import { detectScheduleOverride } from './intake-router.js';
import { saveWhatsAppCarouselIntake, saveWhatsAppIntake, saveWhatsAppZipCarouselIntake } from './intake-store.js';

const { Client, LocalAuth } = whatsapp;
const MAX_RECENT_MESSAGES = 30;
const MAX_RECENT_EVENTS = 40;
const HISTORY_SYNC_LIMIT = 80;
const CAROUSEL_CUES = ['carousel', 'slides', 'album', 'multiple images', 'multi image'];
const ZIP_MIME_TYPES = new Set([
  'application/zip',
  'application/x-zip',
  'application/x-zip-compressed',
  'application/octet-stream'
]);

let client = null;
let starting = null;
let intakeHandler = null;
const recentMessageIds = new Set();
const recentMessages = [];
const recentEvents = [];
const carouselDrafts = new Map();
const state = {
  enabled: config.whatsapp.enabled,
  status: config.whatsapp.enabled ? 'starting' : 'disabled',
  qrDataUrl: null,
  lastError: null,
  readyAt: null,
  info: null,
  processedCount: 0,
  lastAcceptedMessageId: null,
  lastAcceptedAt: null
};

async function getResetTimestampMs() {
  try {
    const data = await fs.readFile('data/reset-time.json', 'utf8');
    const parsed = JSON.parse(data);
    return parsed.resetAt || 0;
  } catch {
    return 0;
  }
}

async function clearChromiumSingletonLocks() {
  const sessionDir = path.join(config.whatsapp.authDir, `session-${config.whatsapp.clientId}`);
  const names = ['SingletonCookie', 'SingletonLock', 'SingletonSocket', 'lockfile'];

  await Promise.all(names.map(async (name) => {
    const target = path.join(sessionDir, name);
    await fs.rm(target, { force: true, recursive: true }).catch(() => {});
  }));
}

function upsertRecentMessage(entry) {
  const messageId = String(entry.messageId || '');
  const existingIndex = recentMessages.findIndex((item) => item.messageId === messageId);
  const normalized = {
    timestamp: new Date().toISOString(),
    body: '',
    mediaMimeType: null,
    filename: null,
    intakeId: null,
    ...entry
  };

  if (existingIndex >= 0) {
    recentMessages[existingIndex] = {
      ...recentMessages[existingIndex],
      ...normalized
    };
  } else {
    recentMessages.unshift(normalized);
    if (recentMessages.length > MAX_RECENT_MESSAGES) {
      recentMessages.length = MAX_RECENT_MESSAGES;
    }
  }
}

function addRecentEvent(entry) {
  recentEvents.unshift({
    timestamp: new Date().toISOString(),
    ...entry
  });

  if (recentEvents.length > MAX_RECENT_EVENTS) {
    recentEvents.length = MAX_RECENT_EVENTS;
  }
}

function logWhatsAppEvent(operation, status, summary, details = null) {
  const event = {
    service: 'whatsapp',
    operation,
    status,
    summary,
    details
  };
  addRecentEvent(event);
  addApiLog(event);
}

async function findAllowedChats() {
  if (!client) {
    return [];
  }

  const chats = await client.getChats();
  return chats.filter((chat) => {
    const chatName = String(chat?.name || chat?.formattedTitle || '').trim();
    const chatId = String(chat?.id?._serialized || '').trim();

    if (config.whatsapp.allowedChatId) {
      return chatId === config.whatsapp.allowedChatId;
    }

    if (config.whatsapp.allowedChatName) {
      return chatName.toLowerCase() === config.whatsapp.allowedChatName.toLowerCase();
    }

    return Boolean(chat?.isGroup) || chatName === 'You' || Boolean(chat?.isReadOnly === false);
  });
}

function rememberMessage(messageId) {
  recentMessageIds.add(messageId);
  if (recentMessageIds.size > 100) {
    const [first] = recentMessageIds;
    recentMessageIds.delete(first);
  }
}

function normalizeBody(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isCarouselCue(text) {
  const normalized = normalizeBody(text);
  return CAROUSEL_CUES.some((cue) => normalized.includes(cue));
}

function clearCarouselDraftTimer(draft) {
  if (draft?.timer) {
    clearTimeout(draft.timer);
  }
}

async function finalizeCarouselDraft(chatId, reason = 'window-expired') {
  const draft = carouselDrafts.get(chatId);
  if (!draft) {
    return null;
  }

  clearCarouselDraftTimer(draft);
  carouselDrafts.delete(chatId);

  if (!Array.isArray(draft.items) || draft.items.length === 0) {
    logWhatsAppEvent('carousel', 'running', 'Carousel window expired without any images.', {
      chatId,
      reason
    });
    return null;
  }

  if (draft.items.length === 1) {
    const single = draft.items[0];
    const saved = await saveWhatsAppIntake({
      messageId: single.messageId,
      chatId: draft.chatId,
      chatName: draft.chatName,
      fromMe: draft.fromMe,
      body: draft.body,
      filename: single.filename,
      mimeType: single.mimeType,
      imageBuffer: single.imageBuffer
    });

    upsertRecentMessage({
      messageId: single.messageId,
      chatId: draft.chatId,
      chatName: draft.chatName,
      fromMe: draft.fromMe,
      type: 'document',
      hasMedia: true,
      body: draft.body,
      filename: single.filename,
      mediaMimeType: single.mimeType,
      intakeId: saved.id,
      status: 'accepted',
      summary: 'Carousel window closed with one image, saved as a normal image post.'
    });

    if (typeof intakeHandler === 'function') {
      await intakeHandler({
        intakeId: saved.id,
        channelId: config.buffer.defaultChannelId || undefined
      });
    }

    return saved;
  }

  const saved = await saveWhatsAppCarouselIntake({
    messageIds: draft.items.map((item) => item.messageId),
    chatId: draft.chatId,
    chatName: draft.chatName,
    fromMe: draft.fromMe,
    body: draft.body,
    items: draft.items
  });

  for (const item of draft.items) {
    upsertRecentMessage({
      messageId: item.messageId,
      chatId: draft.chatId,
      chatName: draft.chatName,
      fromMe: draft.fromMe,
      type: 'document',
      hasMedia: true,
      body: draft.body,
      filename: item.filename,
      mediaMimeType: item.mimeType,
      intakeId: saved.id,
      status: 'accepted',
      summary: `Accepted into carousel draft (${saved.carouselSize} images total).`
    });
  }

  logWhatsAppEvent('carousel', 'success', 'Carousel intake finalized from WhatsApp window.', {
    chatId,
    intakeId: saved.id,
    imageCount: saved.carouselSize,
    reason
  });

  if (typeof intakeHandler === 'function') {
    await intakeHandler({
      intakeId: saved.id,
      channelId: config.buffer.defaultChannelId || undefined
    });
  }

  return saved;
}

function armCarouselDraftTimer(chatId) {
  const draft = carouselDrafts.get(chatId);
  if (!draft) {
    return;
  }

  clearCarouselDraftTimer(draft);
  draft.timer = setTimeout(() => {
    void finalizeCarouselDraft(chatId, 'window-expired').catch((error) => {
      state.lastError = error instanceof Error ? error.message : String(error);
    });
  }, config.whatsapp.carouselWindowMs);
}

function openCarouselDraft({ chatId, chatName, fromMe, body, messageId }) {
  const draft = {
    chatId,
    chatName,
    fromMe: Boolean(fromMe),
    body: body || '',
    openedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + config.whatsapp.carouselWindowMs).toISOString(),
    items: [],
    openerMessageId: messageId || null,
    timer: null
  };
  carouselDrafts.set(chatId, draft);
  armCarouselDraftTimer(chatId);
  return draft;
}

function getActiveCarouselDraft(chatId) {
  const draft = carouselDrafts.get(chatId);
  if (!draft) {
    return null;
  }

  if (new Date(draft.expiresAt).getTime() <= Date.now()) {
    return null;
  }

  return draft;
}

function getClientOptions() {
  const puppeteer = {
    headless: config.whatsapp.headless,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  };

  if (config.whatsapp.chromePath) {
    puppeteer.executablePath = config.whatsapp.chromePath;
  }

  return {
    authStrategy: new LocalAuth({
      clientId: config.whatsapp.clientId,
      dataPath: config.whatsapp.authDir
    }),
    puppeteer,
    webVersionCache: {
      type: config.whatsapp.webVersionCacheType || 'local'
    }
  };
}

async function resolveNotificationChat() {
  if (!client) {
    return null;
  }

  const targetChatId = config.whatsapp.notificationChatId || config.whatsapp.allowedChatId || null;
  const targetChatName = config.whatsapp.notificationChatName || config.whatsapp.allowedChatName || null;

  if (targetChatId) {
    try {
      return await client.getChatById(targetChatId);
    } catch {
      return null;
    }
  }

  const chats = await client.getChats();
  return chats.find((chat) => {
    const chatName = String(chat?.name || chat?.formattedTitle || '').trim().toLowerCase();
    return targetChatName && chatName === targetChatName.toLowerCase();
  }) || null;
}

async function isAllowedChat(message) {
  const chat = await message.getChat();
  const chatName = String(chat?.name || chat?.formattedTitle || '').trim();
  const chatId = String(chat?.id?._serialized || message.from || '').trim();

  if (config.whatsapp.allowedChatId) {
    return {
      allowed: config.whatsapp.allowedChatId === chatId,
      chatId,
      chatName
    };
  }

  if (config.whatsapp.allowedChatName) {
    return {
      allowed: chatName.toLowerCase() === config.whatsapp.allowedChatName.toLowerCase(),
      chatId,
      chatName
    };
  }

  return {
    allowed: Boolean(message.fromMe),
    chatId,
    chatName
  };
}

function isImageMedia(message, media) {
  const meta = getMediaMeta(message, media);
  const mimeType = meta.mimeType.toLowerCase();
  const fileName = meta.filename.toLowerCase();
  const isVideo = mimeType === 'video/mp4';
  const isImage = mimeType.startsWith('image/');
  const isZip = ZIP_MIME_TYPES.has(mimeType) || fileName.endsWith('.zip');

  if (!isVideo && !isImage && !isZip) {
    return false;
  }

  if (!config.whatsapp.acceptDocumentOnly) {
    return true;
  }

  const messageType = String(message.type || '').toLowerCase();
  return messageType === 'document' || messageType === 'video';
}

function getMediaMeta(message, media) {
  const data = message?._data || {};
  const filename = String(
    media?.filename ||
    data.filename ||
    data.fileName ||
    data.caption ||
    message?.body ||
    ''
  ).trim();
  const mimeType = String(
    media?.mimetype ||
    data.mimetype ||
    data.mimeType ||
    data.mediaData?.mimetype ||
    ''
  ).trim();

  return {
    filename,
    mimeType
  };
}

function isZipBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    return false;
  }

  return (
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    (
      (buffer[2] === 0x03 && buffer[3] === 0x04) ||
      (buffer[2] === 0x05 && buffer[3] === 0x06) ||
      (buffer[2] === 0x07 && buffer[3] === 0x08)
    )
  );
}

function isSupportedDownloadedMedia(message, media, mediaBuffer) {
  const meta = getMediaMeta(message, media);
  const mimeType = meta.mimeType.toLowerCase();
  const filename = meta.filename.toLowerCase();
  const messageType = String(message.type || '').toLowerCase();

  if (isZipBuffer(mediaBuffer)) {
    return !config.whatsapp.acceptDocumentOnly || messageType === 'document';
  }

  return isImageMedia(message, {
    ...media,
    mimetype: meta.mimeType,
    filename: meta.filename
  });
}

function getUnsupportedMediaSummary(message, media, mediaBuffer) {
  const meta = getMediaMeta(message, media);
  const parts = [
    `type=${message.type || 'unknown'}`,
    `mime=${meta.mimeType || 'missing'}`,
    `filename=${meta.filename || 'missing'}`,
    `bytes=${mediaBuffer?.length || 0}`
  ];
  return `Unsupported media document (${parts.join(', ')}).`;
}

function parseZipScheduleCommand(text) {
  const normalized = normalizeBody(text);
  if (!normalized) {
    return {
      mode: 'auto',
      publishNow: false,
      dueAt: null,
      label: 'Auto overnight'
    };
  }

  if (/\b(now|right now|immediate|immediately|publish now|post now|upload now)\b/.test(normalized)) {
    return {
      mode: 'now',
      publishNow: true,
      dueAt: null,
      label: 'Now'
    };
  }

  if (/\b(auto|overnight|default schedule|schedule auto|2am|2 am|3am|3 am)\b/.test(normalized)) {
    return {
      mode: 'auto',
      publishNow: false,
      dueAt: null,
      label: 'Auto overnight'
    };
  }

  const override = detectScheduleOverride(text);
  if (override?.dueAt) {
    return {
      mode: 'custom',
      publishNow: false,
      dueAt: override.dueAt,
      label: 'Custom time'
    };
  }

  return {
    mode: 'auto',
    publishNow: false,
    dueAt: null,
    label: 'Auto overnight'
  };
}

async function handleMediaMessage(message) {
  const messageId = String(message.id?._serialized || '');
  if (!messageId || recentMessageIds.has(messageId)) {
    if (messageId) {
      upsertRecentMessage({
        messageId,
        status: 'duplicate',
        summary: 'Already processed from an earlier WhatsApp event.'
      });
    }
    return;
  }

  const resetMs = await getResetTimestampMs();
  const messageMs = message.timestamp ? message.timestamp * 1000 : 0;
  if (resetMs > 0 && messageMs < resetMs) {
    upsertRecentMessage({
      messageId,
      status: 'ignored',
      summary: 'Message is from before the last factory reset.'
    });
    return;
  }

  const chatCheck = await isAllowedChat(message);
  const messageType = String(message.type || 'unknown').toLowerCase();
  const baseEntry = {
    messageId,
    chatId: chatCheck.chatId,
    chatName: chatCheck.chatName || null,
    fromMe: Boolean(message.fromMe),
    type: messageType,
    hasMedia: Boolean(message.hasMedia),
    body: message.body || ''
  };

  if (!chatCheck.allowed) {
    upsertRecentMessage({
      ...baseEntry,
      status: 'ignored',
      summary: 'Message ignored because it came from a different chat.'
    });
    logWhatsAppEvent('message', 'running', 'Ignored message from non-configured chat.', {
      messageId,
      chatId: chatCheck.chatId,
      chatName: chatCheck.chatName || null,
      type: messageType
    });
    return;
  }

  if (!message.hasMedia) {
    if (isCarouselCue(message.body || '')) {
      const existingDraft = getActiveCarouselDraft(chatCheck.chatId);
      if (existingDraft) {
        existingDraft.body = message.body || existingDraft.body;
        existingDraft.expiresAt = new Date(Date.now() + config.whatsapp.carouselWindowMs).toISOString();
        armCarouselDraftTimer(chatCheck.chatId);
      } else {
        openCarouselDraft({
          chatId: chatCheck.chatId,
          chatName: chatCheck.chatName,
          fromMe: message.fromMe,
          body: message.body || '',
          messageId
        });
      }

      rememberMessage(messageId);
      upsertRecentMessage({
        ...baseEntry,
        status: 'waiting',
        summary: 'Carousel mode opened. Send all images in the next 5 minutes.'
      });
      logWhatsAppEvent('carousel', 'running', 'Opened a 5-minute WhatsApp carousel intake window.', {
        messageId,
        chatId: chatCheck.chatId,
        chatName: chatCheck.chatName || null,
        expiresAt: new Date(Date.now() + config.whatsapp.carouselWindowMs).toISOString()
      });
      return;
    }

    upsertRecentMessage({
      ...baseEntry,
      status: 'waiting',
      summary: 'Text-only message received. Waiting for an image document.'
    });
    logWhatsAppEvent('message', 'running', 'Received text-only message in allowed chat.', {
      messageId,
      chatId: chatCheck.chatId,
      chatName: chatCheck.chatName || null,
      type: messageType,
      body: message.body || ''
    });
    return;
  }

  const media = await message.downloadMedia();
  const mediaBuffer = media?.data ? Buffer.from(media.data, 'base64') : null;
  const mediaMeta = getMediaMeta(message, media);
  if (!media || !mediaBuffer || !isSupportedDownloadedMedia(message, media, mediaBuffer)) {
    upsertRecentMessage({
      ...baseEntry,
      mediaMimeType: mediaMeta.mimeType || null,
      filename: mediaMeta.filename || null,
      status: 'ignored',
      summary: getUnsupportedMediaSummary(message, media, mediaBuffer)
    });
    logWhatsAppEvent('message', 'running', 'Received unsupported media in allowed chat.', {
      messageId,
      chatId: chatCheck.chatId,
      chatName: chatCheck.chatName || null,
      type: messageType,
      mimeType: mediaMeta.mimeType || null,
      filename: mediaMeta.filename || null,
      hasDownloadedData: Boolean(media?.data),
      byteLength: mediaBuffer?.length || 0,
      isZipSignature: isZipBuffer(mediaBuffer)
    });
    return;
  }

  const normalizedMimeType = String(mediaMeta.mimeType || '').toLowerCase();
  const isZipPackage = isZipBuffer(mediaBuffer)
    || ZIP_MIME_TYPES.has(normalizedMimeType)
    || String(mediaMeta.filename || '').toLowerCase().endsWith('.zip');
  const mediaKind = normalizedMimeType.startsWith('video/')
    ? 'video'
    : isZipPackage
      ? 'carousel_zip'
      : 'image';

  const activeCarouselDraft = mediaKind === 'image'
    ? getActiveCarouselDraft(chatCheck.chatId)
    : null;
  const zipSchedule = isZipPackage ? parseZipScheduleCommand(message.body || mediaMeta.filename || '') : null;

  if (activeCarouselDraft) {
    rememberMessage(messageId);
    activeCarouselDraft.items.push({
      messageId,
      filename: mediaMeta.filename || `${messageId}.jpg`,
      mimeType: mediaMeta.mimeType,
      imageBuffer: mediaBuffer
    });
    upsertRecentMessage({
      ...baseEntry,
      mediaMimeType: mediaMeta.mimeType,
      filename: mediaMeta.filename || `${messageId}.jpg`,
      mediaKind,
      status: 'waiting',
      summary: `Added to open carousel draft (${activeCarouselDraft.items.length} image${activeCarouselDraft.items.length === 1 ? '' : 's'}).`
    });
    logWhatsAppEvent('carousel', 'running', 'Added image to open carousel draft.', {
      messageId,
      chatId: chatCheck.chatId,
      chatName: chatCheck.chatName || null,
      imageCount: activeCarouselDraft.items.length,
      expiresAt: activeCarouselDraft.expiresAt
    });
    return;
  }

  let saved = null;
  try {
    saved = isZipPackage
      ? await saveWhatsAppZipCarouselIntake({
          messageId,
          chatId: chatCheck.chatId,
          chatName: chatCheck.chatName,
          fromMe: message.fromMe,
          body: message.body || '',
          filename: mediaMeta.filename || `${messageId}.zip`,
          mimeType: mediaMeta.mimeType || 'application/zip',
          zipBuffer: mediaBuffer
        })
      : await saveWhatsAppIntake({
          messageId,
          chatId: chatCheck.chatId,
          chatName: chatCheck.chatName,
          fromMe: message.fromMe,
          body: message.body || '',
          filename: mediaMeta.filename || `${messageId}.jpg`,
          mimeType: mediaMeta.mimeType,
          imageBuffer: mediaBuffer
        });
  } catch (error) {
    rememberMessage(messageId);
    const errorMessage = error instanceof Error ? error.message : String(error);
    upsertRecentMessage({
      ...baseEntry,
      mediaMimeType: mediaMeta.mimeType || null,
      filename: mediaMeta.filename || null,
      mediaKind,
      status: 'failed',
      summary: isZipPackage
        ? `Carousel zip rejected: ${errorMessage}`
        : `Media intake failed: ${errorMessage}`
    });
    logWhatsAppEvent('message', 'error', isZipPackage ? 'Carousel zip intake failed validation.' : 'WhatsApp media intake failed.', {
      messageId,
      chatId: chatCheck.chatId,
      chatName: chatCheck.chatName,
      filename: mediaMeta.filename || null,
      mimeType: mediaMeta.mimeType || null,
      mediaKind,
      error: errorMessage
    });
    return;
  }

  rememberMessage(messageId);
  state.processedCount += 1;
  state.lastAcceptedMessageId = messageId;
  state.lastAcceptedAt = new Date().toISOString();
  upsertRecentMessage({
    ...baseEntry,
    mediaMimeType: mediaMeta.mimeType,
    filename: mediaMeta.filename || `${messageId}.jpg`,
    mediaKind,
    intakeId: saved.id,
    status: 'accepted',
    summary: mediaKind === 'carousel_zip'
      ? `Carousel zip accepted and queued for Graph publishing (${zipSchedule.label}).`
      : mediaKind === 'video'
      ? 'MP4 document accepted and queued for reel generation.'
      : 'Image document accepted and queued for reel generation.'
  });

  addAuditLog({
    category: 'whatsapp',
    action: 'intake-received',
    messageId,
    intakeId: saved.id,
    chatId: chatCheck.chatId,
    chatName: chatCheck.chatName
  });
  logWhatsAppEvent('message', 'success', 'Accepted WhatsApp image document for processing.', {
    messageId,
    intakeId: saved.id,
    chatId: chatCheck.chatId,
    chatName: chatCheck.chatName,
    filename: mediaMeta.filename || null,
    mimeType: mediaMeta.mimeType || null,
    mediaKind,
    scheduleMode: zipSchedule?.mode || null,
    publishNow: zipSchedule?.publishNow || false,
    dueAt: zipSchedule?.dueAt || null
  });

  if (typeof intakeHandler === 'function') {
    await intakeHandler({
      intakeId: saved.id,
      channelId: config.buffer.defaultChannelId || undefined,
      publishNow: zipSchedule?.publishNow || false,
      dueAt: zipSchedule?.dueAt || null
    });
  }
}

async function syncRecentAllowedChatHistory() {
  if (!client || !config.whatsapp.enabled) {
    return;
  }

  const chats = await findAllowedChats();
  if (chats.length === 0) {
    logWhatsAppEvent('history-sync', 'running', 'No matching WhatsApp chat found for history sync.', {
      allowedChatId: config.whatsapp.allowedChatId || null,
      allowedChatName: config.whatsapp.allowedChatName || null
    });
    return;
  }

  let scannedCount = 0;

  for (const chat of chats) {
    const messages = await chat.fetchMessages({ limit: HISTORY_SYNC_LIMIT });
    const orderedMessages = [...messages].sort((left, right) => {
      const leftTs = Number(left.timestamp || 0);
      const rightTs = Number(right.timestamp || 0);
      return leftTs - rightTs;
    });

    for (const message of orderedMessages) {
      scannedCount += 1;
      await handleMediaMessage(message);
    }
  }

  logWhatsAppEvent('history-sync', 'success', 'WhatsApp history sync completed.', {
    chatsScanned: chats.length,
    messagesScanned: scannedCount,
    processedCount: state.processedCount
  });
}

async function bindClientEvents(instance) {
  instance.on('qr', async (qr) => {
    state.status = 'qr';
    state.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
    state.lastError = null;
    logWhatsAppEvent('session', 'running', 'WhatsApp QR generated. Scan required.', null);
  });

  instance.on('authenticated', () => {
    state.status = 'authenticated';
    state.qrDataUrl = null;
    state.lastError = null;
    logWhatsAppEvent('session', 'success', 'WhatsApp authenticated successfully.', null);
  });

  instance.on('ready', async () => {
    state.status = 'ready';
    state.qrDataUrl = null;
    state.readyAt = new Date().toISOString();
    try {
      state.info = instance.info
        ? {
            pushname: instance.info.pushname || null,
            wid: instance.info.wid?._serialized || null,
            platform: instance.info.platform || null
          }
        : null;
    } catch {
      state.info = null;
    }
    logWhatsAppEvent('session', 'success', 'WhatsApp client is ready.', state.info);
    try {
      await syncRecentAllowedChatHistory();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      state.lastError = message;
      logWhatsAppEvent('history-sync', 'error', 'WhatsApp history sync failed.', {
        error: message
      });
    }
  });

  instance.on('auth_failure', (error) => {
    state.status = 'error';
    state.lastError = String(error || 'Authentication failure');
    logWhatsAppEvent('session', 'error', 'WhatsApp authentication failed.', {
      error: state.lastError
    });
  });

  instance.on('disconnected', (reason) => {
    state.status = 'disconnected';
    state.lastError = String(reason || 'Disconnected');
    logWhatsAppEvent('session', 'error', 'WhatsApp disconnected.', {
      reason: state.lastError
    });
  });

  instance.on('message_create', (message) => {
    void handleMediaMessage(message).catch((error) => {
      state.lastError = error instanceof Error ? error.message : String(error);
    });
  });

  instance.on('message', (message) => {
    void handleMediaMessage(message).catch((error) => {
      state.lastError = error instanceof Error ? error.message : String(error);
    });
  });
}

export function registerWhatsAppIntakeHandler(handler) {
  intakeHandler = handler;
}

export function getWhatsAppStatus() {
  return {
    ...state,
    allowedChatId: config.whatsapp.allowedChatId || null,
    allowedChatName: config.whatsapp.allowedChatName || null,
    acceptDocumentOnly: config.whatsapp.acceptDocumentOnly,
    recentMessages: [...recentMessages],
    recentEvents: [...recentEvents]
  };
}

export async function startWhatsAppClient() {
  if (!config.whatsapp.enabled) {
    state.status = 'disabled';
    return null;
  }

  if (client) {
    return client;
  }

  if (starting) {
    return starting;
  }

  await fs.mkdir(path.dirname(config.whatsapp.authDir), { recursive: true });
  state.status = 'starting';
  state.lastError = null;
  logWhatsAppEvent('session', 'running', 'Starting WhatsApp client.', {
    clientId: config.whatsapp.clientId,
    allowedChatName: config.whatsapp.allowedChatName || null,
    allowedChatId: config.whatsapp.allowedChatId || null
  });

  starting = (async () => {
    let retriedAfterLockCleanup = false;

    while (true) {
      const instance = new Client(getClientOptions());
      await bindClientEvents(instance);
      client = instance;

      try {
        await instance.initialize();
        return instance;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (!retriedAfterLockCleanup && message.includes('The browser is already running for')) {
          retriedAfterLockCleanup = true;
          logWhatsAppEvent('session', 'running', 'Detected Chromium profile lock. Clearing stale lock files and retrying once.', {
            clientId: config.whatsapp.clientId
          });
          await clearChromiumSingletonLocks();
          try {
            await instance.destroy();
          } catch {
            // Ignore cleanup errors during stale-lock recovery.
          }
          client = null;
          continue;
        }

        throw error;
      }
    }
  })();

  try {
    return await starting;
  } catch (error) {
    state.status = 'error';
    state.lastError = error instanceof Error ? error.message : String(error);
    client = null;
    throw error;
  } finally {
    starting = null;
  }
}

export async function restartWhatsAppClient() {
  if (client) {
    try {
      await client.destroy();
    } catch {
      // Ignore shutdown errors during restart.
    }
    client = null;
  }

  state.status = 'starting';
  state.lastError = null;
  state.qrDataUrl = null;
  return startWhatsAppClient();
}

export async function stopWhatsAppClient() {
  if (starting) {
    try {
      await starting;
    } catch {
      // Ignore startup errors while shutting down.
    }
  }

  if (client) {
    try {
      await client.destroy();
    } catch {
      // Ignore shutdown errors during stop.
    }
    client = null;
  }

  state.status = config.whatsapp.enabled ? 'stopped' : 'disabled';
  state.lastError = null;
  state.qrDataUrl = null;
  state.readyAt = null;
  logWhatsAppEvent('session', 'stopped', 'WhatsApp client stopped by the operator.', {
    clientId: config.whatsapp.clientId
  });

  return getWhatsAppStatus();
}

export async function sendWhatsAppNotification(text) {
  if (!config.whatsapp.enabled || !client) {
    return {
      ok: false,
      skipped: true,
      reason: 'WhatsApp client is not running.'
    };
  }

  const chat = await resolveNotificationChat();
  if (!chat) {
    return {
      ok: false,
      skipped: true,
      reason: 'Notification chat could not be resolved.'
    };
  }

  await chat.sendMessage(String(text || '').trim());
  return {
    ok: true,
    chatId: String(chat?.id?._serialized || ''),
    chatName: String(chat?.name || chat?.formattedTitle || '')
  };
}

export const __test__ = {
  parseZipScheduleCommand,
  isZipBuffer
};
