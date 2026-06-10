import crypto from 'node:crypto';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z, ZodError } from 'zod';
import {
  config,
  getConfigWarnings,
  hasRealBufferConfig,
  isAuthConfigured,
  isPublicHttpUrl
} from './config.js';
import {
  attachAuthState,
  clearSession,
  getAuthStatus,
  issueSession,
  requireAuth,
  requireTrustedOrigin,
  validateLoginPassword
} from './services/auth.js';
import {
  connectBuffer,
  getBufferConnectionOverview,
  loadBufferSession,
  redactBufferSession
} from './services/buffer.js';
import { addAuditLog, getApiLogs } from './services/api-logs.js';
import { getCloudinaryStatus } from './services/cloudinary.js';
import { getCaptionProviderStatus } from './services/cloudflare-caption.js';
import {
  getIntake,
  listIntakes,
  loadIntakes,
  markIntakeProcessed,
  saveWhatsAppZipCarouselIntake
} from './services/intake-store.js';
import {
  cancelJob,
  enqueueJob,
  findQueuedJobByIntake,
  getJob,
  getJobWorkerStatus,
  listJobs,
  loadJobs,
  registerJobProcessor,
  startJobWorker,
  stopJobWorker,
  updateQueuedJob
} from './services/jobs.js';
import { registerDefaultJobProcessors } from './services/job-processors.js';
import { getMusicLibraryStatus } from './services/music-library.js';
import { getSchedulerState, loadSchedulerState } from './services/scheduler-state.js';
import { getShortLink, loadShortLinks } from './services/short-links.js';
import { rateLimitRead, rateLimitWrite } from './services/rate-limit.js';
import { getReelHostingStatus } from './services/reel-hosting.js';
import { initRuntimeLogger } from './services/runtime-logger.js';
import { chooseScheduleSlot, listDevotionalPlaceholders2026 } from './services/schedule.js';
import {
  getWhatsAppStatus,
  registerWhatsAppIntakeHandler,
  restartWhatsAppClient,
  startWhatsAppClient,
  stopWhatsAppClient
} from './services/whatsapp.js';
import { performSystemReset } from './services/system-reset.js';

initRuntimeLogger();
const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, '..', 'public');

app.use(express.json({ limit: '5mb' }));
app.use(express.static(publicDir));
app.use(config.media.publicRoute, express.static(config.media.dir));
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 80 * 1024 * 1024,
    files: 1
  }
});

const bufferConnectSchema = z.object({
  apiKey: z.string().trim().min(10),
  defaultChannelId: z.string().trim().min(1).optional()
});

const loginSchema = z.object({
  password: z.string().min(1)
});

const requeueIntakeSchema = z.object({
  channelId: z.string().trim().min(1).optional(),
  scheduleMode: z.enum(['auto', 'now', 'custom']).default('auto'),
  scheduledFor: z.string().trim().optional()
});

const carouselUploadSchema = z.object({
  scheduleMode: z.enum(['auto', 'now', 'custom']).default('auto'),
  scheduledFor: z.string().trim().optional(),
  captionHint: z.string().trim().optional()
});

const carouselScheduleSchema = z.object({
  scheduleMode: z.enum(['auto', 'now', 'custom']).default('auto'),
  scheduledFor: z.string().trim().optional()
});

function classifyErrorStatus(error) {
  if (error instanceof ZodError) {
    return 400;
  }

  if (typeof error?.status === 'number') {
    return error.status;
  }

  const message = error instanceof Error ? error.message : String(error);
  if (
    message.startsWith('Missing ') ||
    message.includes('not found') ||
    message.includes('required') ||
    message.includes('public URL')
  ) {
    return 400;
  }

  if (message.includes('Authentication required')) {
    return 401;
  }

  if (message.includes('quota') || message.includes('rate limit') || message.includes('Too many requests')) {
    return 429;
  }

  if (message.includes('request failed') || message.includes('temporarily unavailable')) {
    return 502;
  }

  return 500;
}

function handleError(res, error) {
  const status = classifyErrorStatus(error);
  const message = error instanceof ZodError
    ? JSON.stringify(error.issues, null, 2)
    : error instanceof Error
      ? error.message
      : 'Unknown error';

  console.error(`HTTP ${status}: ${message}`);
  res.status(status).json({ error: message });
}

function summarizeJob(job) {
  if (!job) {
    return null;
  }

  return {
    id: job.id,
    kind: job.kind,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt ?? null,
    completedAt: job.completedAt ?? null,
    attempts: job.attempts ?? 0,
    idempotencyKey: job.idempotencyKey ?? null,
    requestId: job.requestId ?? null,
    runAt: job.runAt ?? null,
    error: job.error ?? null,
    result: job.result ?? null,
    payload: job.payload ?? null
  };
}

function getCurrentUser(req) {
  return req.auth?.session?.sub || null;
}

function getRequestId(req) {
  return req.id || null;
}

function getIdempotencyKey(req) {
  const headerKey = typeof req.headers['idempotency-key'] === 'string'
    ? req.headers['idempotency-key'].trim()
    : '';
  return headerKey || null;
}

function jobResponse(job) {
  return {
    ok: true,
    job: summarizeJob(job),
    apiLogs: getApiLogs()
  };
}

function getSchedulingPoolExcludingIntake(intakeId) {
  return listJobs(250).filter((job) => job?.payload?.intakeId !== intakeId);
}

async function buildSessionPayload(req) {
  const bufferSession = await loadBufferSession();
  const musicLibrary = await getMusicLibraryStatus();
  const cloudinary = getCloudinaryStatus();
  const reelHosting = getReelHostingStatus();
  const captionProvider = getCaptionProviderStatus();
  const schedulerState = getSchedulerState();

  return {
    ok: true,
    requestId: getRequestId(req),
    auth: getAuthStatus(req),
    warnings: getConfigWarnings(),
    publicMediaReady: reelHosting.configured,
    publicMediaBaseUrl: config.publicBaseUrl,
    reelHosting,
    cloudinary,
    captionProvider,
    bufferConfigured: hasRealBufferConfig() || Boolean(bufferSession?.apiKey),
    bufferSession: redactBufferSession(bufferSession),
    whatsapp: getWhatsAppStatus(),
  process: getJobWorkerStatus(),
    musicLibrary: {
      configuredTracks: musicLibrary.configuredTracks,
      availableTracks: musicLibrary.availableTracks
    },
    shortLinks: {
      configured: Boolean(config.shortLinksFile)
    },
    account: config.account,
    scheduler: {
      ...config.scheduler,
      executionMode: schedulerState.executionMode,
      queueCutoffAt: schedulerState.queueCutoffAt || null
    }
  };
}

app.use('/api', (req, res, next) => {
  req.id = crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  addAuditLog({
    category: 'request',
    action: 'started',
    requestId: req.id,
    method: req.method,
    path: req.path
  });
  res.on('finish', () => {
    addAuditLog({
      category: 'request',
      action: 'finished',
      requestId: req.id,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode
    });
  });
  next();
});

app.use('/api', attachAuthState);

app.get('/health', async (req, res) => {
  const payload = await buildSessionPayload(req);
  res.json(payload);
});

app.get('/ready', (_req, res) => {
  const warnings = getConfigWarnings();
  res.status(warnings.length ? 503 : 200).json({
    ok: warnings.length === 0,
    warnings
  });
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.get('/l/:code', async (req, res) => {
  try {
    const link = getShortLink(req.params.code);
    if (!link) {
      await loadShortLinks();
    }

    const refreshed = getShortLink(req.params.code);
    if (!refreshed) {
      res.status(404).send('Short link not found.');
      return;
    }

    res.redirect(302, refreshed.targetUrl);
  } catch (error) {
    handleError(res, error);
  }
});

app.get('/api/auth/session', rateLimitRead, (req, res) => {
  res.json({
    ok: true,
    auth: getAuthStatus(req)
  });
});

app.post('/api/auth/login', requireTrustedOrigin, rateLimitWrite, (req, res) => {
  try {
    const input = loginSchema.parse(req.body);

    if (!config.auth.enabled) {
      res.json({
        ok: true,
        auth: getAuthStatus(req)
      });
      return;
    }

    if (!isAuthConfigured()) {
      res.status(503).json({ error: 'Authentication is enabled but not fully configured.' });
      return;
    }

    if (!validateLoginPassword(input.password)) {
      res.status(401).json({ error: 'Invalid password.' });
      return;
    }

    issueSession(res);
    res.json({
      ok: true,
      auth: {
        enabled: true,
        configured: true,
        authenticated: true,
        subject: 'local-admin'
      }
    });
  } catch (error) {
    handleError(res, error);
  }
});

app.post('/api/auth/logout', requireTrustedOrigin, rateLimitWrite, (_req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

const readGuards = [rateLimitRead, requireAuth];
const writeGuards = [requireTrustedOrigin, rateLimitWrite, requireAuth];

app.get('/api/session', ...readGuards, async (req, res) => {
  try {
    res.json(await buildSessionPayload(req));
  } catch (error) {
    handleError(res, error);
  }
});

app.get('/api/logs', ...readGuards, (_req, res) => {
  res.json({
    ok: true,
    logs: getApiLogs()
  });
});

app.get('/api/jobs', ...readGuards, (req, res) => {
  const limit = Number.parseInt(String(req.query.limit || '20'), 10);
  res.json({
    ok: true,
    jobs: listJobs(Number.isFinite(limit) ? limit : 20).map(summarizeJob)
  });
});

app.get('/api/jobs/:jobId', ...readGuards, (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    res.status(404).json({ error: 'Job not found.' });
    return;
  }

  res.json(jobResponse(job));
});

app.delete('/api/jobs/:jobId', ...writeGuards, async (req, res) => {
  try {
    const job = getJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Job not found.' });
      return;
    }

    const cancelled = await cancelJob(req.params.jobId);
    res.json({ ok: true, job: summarizeJob(cancelled) });
  } catch (error) {
    handleError(res, error);
  }
});


app.get('/api/intakes', ...readGuards, (_req, res) => {
  res.json({
    ok: true,
    intakes: listIntakes(25)
  });
});

app.get('/api/intakes/:intakeId', ...readGuards, (req, res) => {
  const intake = getIntake(req.params.intakeId);
  if (!intake) {
    res.status(404).json({ error: 'Intake not found.' });
    return;
  }

  res.json({
    ok: true,
    intake
  });
});
app.post('/api/whatsapp/restart', ...writeGuards, async (req, res) => {
  try {
    const { restartWhatsAppClient } = await import('./services/whatsapp.js');
    restartWhatsAppClient();
    res.json({ ok: true, message: 'Restarting WhatsApp...' });
  } catch (error) {
    handleError(res, error);
  }
});

app.post('/api/intakes/upload', ...writeGuards, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file uploaded.' });
      return;
    }

    const { registerWhatsAppIntakeHandler } = await import('./services/whatsapp.js');
    const { processWhatsAppIntakeOperation } = await import('./services/workflow.js');
    let intakeHandler = null;
    registerWhatsAppIntakeHandler((handler) => { intakeHandler = handler; });

    const filename = String(req.file.originalname || 'upload').trim();
    const mimeType = String(req.file.mimetype || 'application/octet-stream').trim().toLowerCase();
    const buffer = req.file.buffer;
    
    // Check if zip
    const isZip = mimeType.includes('zip') || filename.toLowerCase().endsWith('.zip');
    const isVideo = mimeType.startsWith('video/');
    const isImage = mimeType.startsWith('image/');
    
    if (!isZip && !isVideo && !isImage) {
       res.status(400).json({ error: 'Unsupported file type. Please upload a ZIP, Image, or Video.' });
       return;
    }

    const messageId = `upload-${crypto.randomUUID()}`;
    let saved = null;

    if (isZip) {
      saved = await saveWhatsAppZipCarouselIntake({
        messageId,
        chatId: 'dashboard',
        chatName: 'Dashboard Upload',
        fromMe: true,
        body: 'Uploaded via Dashboard',
        filename,
        mimeType,
        zipBuffer: buffer
      });
    } else {
      saved = await saveWhatsAppIntake({
        messageId,
        chatId: 'dashboard',
        chatName: 'Dashboard Upload',
        fromMe: true,
        body: 'Uploaded via Dashboard',
        filename,
        mimeType,
        imageBuffer: buffer
      });
    }

    if (intakeHandler) {
      await intakeHandler({
        intakeId: saved.id,
        channelId: config.buffer.defaultChannelId || undefined,
        publishNow: false,
        dueAt: null
      });
    } else {
      await processWhatsAppIntakeOperation({
        intakeId: saved.id,
        channelId: config.buffer.defaultChannelId || undefined,
        publishNow: false,
        dueAt: null
      });
    }

    res.json({ ok: true, intake: saved });
  } catch (error) {
    handleError(res, error);
  }
});
app.post('/api/intakes/:intakeId/requeue', ...writeGuards, async (req, res) => {
  try {
    const intake = getIntake(req.params.intakeId);
    if (!intake) {
      res.status(404).json({ error: 'Intake not found.' });
      return;
    }

    const input = requeueIntakeSchema.parse(req.body || {});
    if (input.scheduleMode === 'custom' && !input.scheduledFor) {
      res.status(400).json({ error: 'scheduledFor is required when scheduleMode is custom.' });
      return;
    }

    const requestedDate = input.scheduleMode === 'custom'
      ? new Date(input.scheduledFor)
      : null;
    if (requestedDate && Number.isNaN(requestedDate.getTime())) {
      res.status(400).json({ error: 'scheduledFor must be a valid date/time.' });
      return;
    }

    const autoSlot = input.scheduleMode === 'auto'
      ? chooseScheduleSlot(getSchedulingPoolExcludingIntake(intake.id), new Date(), { profile: 'reel' })
      : null;
    const dueAt = input.scheduleMode === 'custom'
      ? requestedDate.toISOString()
      : input.scheduleMode === 'auto'
        ? autoSlot?.dueAt || null
        : null;
    const queuedProcessJob = findQueuedJobByIntake({
      intakeId: intake.id,
      kinds: ['process-whatsapp-intake']
    });

    let job = null;
    const finalizeJob = findQueuedJobByIntake({
      intakeId: intake.id,
      kinds: ['finalize-intake']
    });

    if (finalizeJob) {
      await markIntakeProcessed(intake.id, { scheduledFor: dueAt });
      job = await updateQueuedJob(finalizeJob.id, {
        runAt: input.scheduleMode === 'now' ? null : finalizeJob.runAt,
        createdBy: getCurrentUser(req) || finalizeJob.createdBy || 'dashboard'
      });
    } else if (queuedProcessJob) {
      job = await updateQueuedJob(queuedProcessJob.id, {
        runAt: dueAt,
        createdBy: getCurrentUser(req) || queuedProcessJob.createdBy || 'dashboard',
        payload: {
          ...(queuedProcessJob.payload || {}),
          intakeId: intake.id,
          channelId: input.channelId || queuedProcessJob.payload?.channelId || null,
          publishNow: input.scheduleMode === 'now',
          dueAt
        }
      });
    } else {
      job = await enqueueJob({
        kind: 'process-whatsapp-intake',
        payload: {
          intakeId: intake.id,
          channelId: input.channelId,
          publishNow: input.scheduleMode === 'now',
          dueAt
        },
        idempotencyKey: getIdempotencyKey(req),
        requestId: getRequestId(req),
        createdBy: getCurrentUser(req)
      });
    }

    const schedulePayload = input.scheduleMode === 'auto' && autoSlot
      ? {
          ...autoSlot,
          reasoning: [
            ...(autoSlot.reasoning || []),
            'Operator re-slotted this intake from the dashboard schedule panel.'
          ]
        }
      : {
          ...(intake.schedule || {}),
          dueAt,
          slotLabel: input.scheduleMode === 'now'
            ? 'Immediate publish'
            : dueAt
              ? 'Custom slot'
              : 'Auto slot',
          timezone: config.scheduler.timezone,
          reasoning: [
            input.scheduleMode === 'now'
              ? 'Operator forced immediate publishing from dashboard.'
              : dueAt
                ? 'Operator set a custom publish date/time from dashboard.'
                : 'Operator re-queued intake with automatic scheduler control.'
          ]
        };

    const updatedIntake = await markIntakeProcessed(intake.id, {
      status: 'scheduled',
      currentStage: 'scheduled',
      currentStageLabel: input.scheduleMode === 'now'
        ? 'Queued for immediate publish'
        : dueAt
          ? 'Queued for custom publish time'
          : 'Queued for auto schedule',
      scheduledFor: dueAt,
      schedule: schedulePayload,
      lastJobId: job.id
    });

    res.status(202).json(jobResponse(job));
  } catch (error) {
    handleError(res, error);
  }
});

app.post('/api/carousel/test-upload', ...writeGuards, upload.single('zip'), async (req, res) => {
  try {
    if (!req.file?.buffer) {
      res.status(400).json({ error: 'Upload a zip file in the zip field.' });
      return;
    }

    const input = carouselUploadSchema.parse(req.body || {});
    if (input.scheduleMode === 'custom' && !input.scheduledFor) {
      res.status(400).json({ error: 'scheduledFor is required when scheduleMode is custom.' });
      return;
    }

    const scheduledFor = input.scheduleMode === 'custom'
      ? new Date(input.scheduledFor)
      : null;
    if (scheduledFor && Number.isNaN(scheduledFor.getTime())) {
      res.status(400).json({ error: 'scheduledFor must be a valid date/time.' });
      return;
    }

    const intake = await saveWhatsAppZipCarouselIntake({
      messageId: `dashboard-upload:${crypto.randomUUID()}`,
      chatId: 'dashboard',
      chatName: 'Dashboard test upload',
      fromMe: true,
      body: input.captionHint || '',
      filename: req.file.originalname || 'carousel.zip',
      mimeType: req.file.mimetype || 'application/zip',
      zipBuffer: req.file.buffer
    });

    const job = await enqueueJob({
      kind: 'process-whatsapp-intake',
      payload: {
        intakeId: intake.id,
        publishNow: input.scheduleMode === 'now',
        dueAt: scheduledFor ? scheduledFor.toISOString() : null
      },
      idempotencyKey: getIdempotencyKey(req) || `dashboard-carousel:${intake.id}`,
      requestId: getRequestId(req),
      createdBy: getCurrentUser(req) || 'dashboard'
    });

    res.status(202).json({
      ok: true,
      intake,
      job: summarizeJob(job),
      scheduleMode: input.scheduleMode,
      scheduledFor: scheduledFor ? scheduledFor.toISOString() : null
    });
  } catch (error) {
    handleError(res, error);
  }
});

app.post('/api/carousel/:intakeId/schedule', ...writeGuards, async (req, res) => {
  try {
    const intake = getIntake(req.params.intakeId);
    if (!intake) {
      res.status(404).json({ error: 'Intake not found.' });
      return;
    }

    if (intake.publishStrategy !== 'graph_carousel' && intake.sourceFormat !== 'zip_carousel') {
      res.status(400).json({ error: 'Only carousel zip intakes can be scheduled here.' });
      return;
    }

    if (['published', 'publishing', 'processing'].includes(String(intake.status || '').toLowerCase())) {
      res.status(400).json({ error: 'This carousel is already publishing or published.' });
      return;
    }

    const input = carouselScheduleSchema.parse(req.body || {});
    if (input.scheduleMode === 'custom' && !input.scheduledFor) {
      res.status(400).json({ error: 'scheduledFor is required when scheduleMode is custom.' });
      return;
    }

    const requestedDate = input.scheduleMode === 'custom'
      ? new Date(input.scheduledFor)
      : null;
    if (requestedDate && Number.isNaN(requestedDate.getTime())) {
      res.status(400).json({ error: 'scheduledFor must be a valid date/time.' });
      return;
    }

    const autoSlot = input.scheduleMode === 'auto'
      ? chooseScheduleSlot(getSchedulingPoolExcludingIntake(intake.id), new Date(), { profile: 'carousel' })
      : null;
    const dueAt = input.scheduleMode === 'custom'
      ? requestedDate.toISOString()
      : input.scheduleMode === 'auto'
        ? autoSlot?.dueAt || null
        : null;
    const queuedProcessJob = findQueuedJobByIntake({
      intakeId: intake.id,
      kinds: ['process-whatsapp-intake']
    });
    const queuedPublishJob = findQueuedJobByIntake({
      intakeId: intake.id,
      kinds: ['publish-carousel-intake']
    });

    let job = null;
    const finalizeJob = findQueuedJobByIntake({
      intakeId: intake.id,
      kinds: ['finalize-intake']
    });

    if (finalizeJob) {
      await markIntakeProcessed(intake.id, { scheduledFor: dueAt });
      job = await updateQueuedJob(finalizeJob.id, {
        runAt: input.scheduleMode === 'now' ? null : finalizeJob.runAt,
        createdBy: getCurrentUser(req) || finalizeJob.createdBy || 'dashboard'
      });
    } else if (queuedPublishJob) {
      job = await updateQueuedJob(queuedPublishJob.id, {
        runAt: dueAt,
        createdBy: getCurrentUser(req) || queuedPublishJob.createdBy || 'dashboard',
        payload: {
          publishNow: input.scheduleMode === 'now',
          dueAt
        }
      });
    } else if (queuedProcessJob) {
      job = await updateQueuedJob(queuedProcessJob.id, {
        runAt: null,
        createdBy: getCurrentUser(req) || queuedProcessJob.createdBy || 'dashboard',
        payload: {
          publishNow: input.scheduleMode === 'now',
          dueAt
        }
      });
    } else {
      job = await enqueueJob({
        kind: 'publish-carousel-intake',
        payload: {
          intakeId: intake.id
        },
        idempotencyKey: `publish-carousel:${intake.id}`,
        requestId: getRequestId(req),
        createdBy: getCurrentUser(req) || 'dashboard',
        runAt: dueAt
      });
    }

    const schedulePayload = input.scheduleMode === 'auto' && autoSlot
      ? {
          ...autoSlot,
          reasoning: [
            ...(autoSlot.reasoning || []),
            'Operator re-slotted this carousel from the dashboard schedule panel.'
          ]
        }
      : {
          ...(intake.schedule || {}),
          dueAt,
          slotLabel: dueAt ? 'Custom carousel slot' : 'Immediate publish',
          timezone: config.scheduler.timezone,
          reasoning: [
            dueAt
              ? 'The operator moved this queued carousel to a custom publish time.'
              : 'The operator moved this queued carousel to immediate publishing.'
          ]
        };

    const updatedIntake = await markIntakeProcessed(intake.id, {
      status: 'scheduled',
      currentStage: 'scheduled',
      currentStageLabel: dueAt ? 'Queued for carousel publish' : 'Queued for immediate carousel publish',
      scheduledFor: dueAt,
      schedule: schedulePayload,
      lastJobId: job.id
    });

    res.status(202).json({
      ok: true,
      intake: updatedIntake,
      job: summarizeJob(job),
      scheduleMode: input.scheduleMode,
      scheduledFor: dueAt
    });
  } catch (error) {
    handleError(res, error);
  }
});

app.get('/api/buffer/channels', ...readGuards, async (req, res) => {
  try {
    const apiKey = typeof req.query.apiKey === 'string' ? req.query.apiKey : undefined;
    const overview = await getBufferConnectionOverview(apiKey);
    const session = await loadBufferSession();

    res.json({
      ok: true,
      account: overview.account,
      session: redactBufferSession(session),
      organizations: overview.organizations
    });
  } catch (error) {
    handleError(res, error);
  }
});

app.post('/api/buffer/connect', ...writeGuards, async (req, res) => {
  try {
    const input = bufferConnectSchema.parse(req.body);
    const result = await connectBuffer(input);

    res.json({
      ok: true,
      session: redactBufferSession(result.session),
      account: result.account,
      selectedChannel: result.selectedChannel,
      organizations: result.organizations
    });
  } catch (error) {
    handleError(res, error);
  }
});

app.get('/api/whatsapp/status', ...readGuards, (_req, res) => {
  res.json({
    ok: true,
    whatsapp: getWhatsAppStatus()
  });
});

app.post('/api/whatsapp/restart', ...writeGuards, async (_req, res) => {
  try {
    await restartWhatsAppClient();
    res.json({
      ok: true,
      whatsapp: getWhatsAppStatus()
    });
  } catch (error) {
    handleError(res, error);
  }
});

app.post('/api/system/stop', ...writeGuards, async (_req, res) => {
  try {
    stopJobWorker();
    const whatsapp = await stopWhatsAppClient();
    res.json({
      ok: true,
      process: getJobWorkerStatus(),
      whatsapp
    });
  } catch (error) {
    handleError(res, error);
  }
});

app.post('/api/system/resume', ...writeGuards, async (_req, res) => {
  try {
    startJobWorker();
    await startWhatsAppClient();
    res.json({
      ok: true,
      process: getJobWorkerStatus(),
      whatsapp: getWhatsAppStatus()
    });
  } catch (error) {
    handleError(res, error);
  }
});

app.post('/api/system/reset', ...writeGuards, async (_req, res) => {
  try {
    const results = await performSystemReset();
    res.json({
      ok: true,
      message: 'System reset successful.',
      details: results
    });
  } catch (error) {
    handleError(res, error);
  }
});

app.get('/api/music', ...readGuards, async (_req, res) => {
  try {
    res.json({
      ok: true,
      music: await getMusicLibraryStatus()
    });
  } catch (error) {
    handleError(res, error);
  }
});

app.get('/api/scheduler/placeholders', ...readGuards, (_req, res) => {
  res.json({
    ok: true,
    timezone: config.scheduler.timezone,
    placeholders: listDevotionalPlaceholders2026()
  });
});

app.get('/api/scheduler/mode', ...readGuards, (_req, res) => {
  res.json({
    ok: true,
    scheduler: getSchedulerState()
  });
});

app.post('/api/scheduler/mode', ...writeGuards, async (_req, res) => {
  // Mode is now automatic: videos → local worker, carousels → GitHub Actions.
  // This endpoint is kept for backward compatibility but is a no-op.
  res.json({
    ok: true,
    scheduler: getSchedulerState(),
    process: getJobWorkerStatus(),
    message: 'Scheduler mode is now automatic and cannot be changed manually.'
  });
});

registerDefaultJobProcessors((kind, processor) => registerJobProcessor(kind, processor));
await loadJobs();
await loadIntakes();
await loadShortLinks();
await loadSchedulerState();
registerWhatsAppIntakeHandler(async (payload) => {
  if (getJobWorkerStatus().paused) {
    return;
  }

  await enqueueJob({
    kind: 'process-whatsapp-intake',
    payload,
    idempotencyKey: payload.intakeId,
    requestId: `whatsapp:${payload.intakeId}`,
    createdBy: 'whatsapp'
  });
});
startJobWorker();
void startWhatsAppClient().catch((error) => {
  console.error('WhatsApp startup failed:', error instanceof Error ? error.message : String(error));
});

process.on('SIGINT', () => {
  stopJobWorker();
  process.exit(0);
});

process.on('SIGTERM', () => {
  stopJobWorker();
  process.exit(0);
});

app.listen(config.port, () => {
  console.log(`Instagram automation server listening on ${config.appBaseUrl}`);
});
