import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { addAuditLog } from './api-logs.js';
import { getSchedulerState } from './scheduler-state.js';
import {
  isSupabaseQueueStoreEnabled,
  loadSupabaseCollection,
  upsertSupabaseCollection,
  upsertSupabaseRecord
} from './supabase-store.js';

const jobs = new Map();
const processors = new Map();
let workerTimer = null;
let activeJobId = null;
let persistQueue = Promise.resolve();
let workerPaused = false;
const workerEnabled = Boolean(config.jobs?.workerEnabled);
const transientRetryDelayMs = 10 * 60 * 1000;
const maxTransientAttempts = 3;

function getJobCutoffTime() {
  const schedulerState = getSchedulerState();
  if (schedulerState.executionMode !== 'github_actions_window' || !schedulerState.queueCutoffAt) {
    return null;
  }

  const cutoff = new Date(schedulerState.queueCutoffAt);
  return Number.isNaN(cutoff.getTime()) ? null : cutoff;
}

function isLegacyQueuedJob(job, cutoff = getJobCutoffTime()) {
  if (!cutoff || !job?.createdAt) {
    return false;
  }

  const createdAt = new Date(job.createdAt);
  return !Number.isNaN(createdAt.getTime()) && createdAt < cutoff;
}

async function writeJobsSnapshot() {
  if (isSupabaseQueueStoreEnabled()) {
    await upsertSupabaseCollection(config.queueStore.jobsTable, [...jobs.values()]);
    return;
  }

  await fs.mkdir(path.dirname(config.jobsFile), { recursive: true });
  const payload = JSON.stringify([...jobs.values()], null, 2);
  const tempFile = `${config.jobsFile}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempFile, `${payload}\n`, 'utf8');
  try {
    await fs.rename(tempFile, config.jobsFile);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      await fs.writeFile(config.jobsFile, `${payload}\n`, 'utf8');
      return;
    }

    throw error;
  } finally {
    await fs.rm(tempFile, { force: true }).catch(() => {});
  }
}

async function persistJobs() {
  const task = persistQueue.then(() => writeJobsSnapshot());
  persistQueue = task.catch(() => {});
  return task;
}

async function persistJob(job) {
  if (isSupabaseQueueStoreEnabled()) {
    await upsertSupabaseRecord(config.queueStore.jobsTable, job);
    return;
  }

  await persistJobs();
}

async function quarantineCorruptJobsFile() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = `${config.jobsFile}.corrupt-${stamp}.json`;
  await fs.rename(config.jobsFile, backupFile);
  console.warn(`Jobs store was corrupt and has been moved to ${backupFile}`);
}

export async function loadJobs() {
  if (isSupabaseQueueStoreEnabled()) {
    const items = await loadSupabaseCollection(config.queueStore.jobsTable);
    jobs.clear();
    for (const item of items) {
      if (item?.id === '__scheduler_state__' || item?.kind === 'scheduler-state') {
        continue;
      }
      jobs.set(item.id, item);
    }
    return;
  }

  try {
    const raw = await fs.readFile(config.jobsFile, 'utf8');
    const items = JSON.parse(raw);
    jobs.clear();
    for (const item of items) {
      jobs.set(item.id, item);
    }
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return;
    }

    if (error instanceof SyntaxError) {
      jobs.clear();
      await quarantineCorruptJobsFile();
      await persistJobs();
      return;
    }

    throw error;
  }
}

export function registerJobProcessor(kind, processor) {
  processors.set(kind, processor);
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isTransientNetworkFailure(message) {
  const normalized = String(message || '').toLowerCase();
  return (
    normalized.includes('fetch failed') ||
    normalized.includes('econnreset') ||
    normalized.includes('etimedout') ||
    normalized.includes('socket') ||
    normalized.includes('network') ||
    normalized.includes('temporarily unavailable') ||
    normalized.includes('request failed before a response')
  );
}

function canRetryJobFailure(job, message) {
  if (!isTransientNetworkFailure(message)) {
    return false;
  }

  if ((job.attempts || 0) >= maxTransientAttempts) {
    return false;
  }

  // Retrying after a media_publish transport failure can duplicate the Instagram post.
  if (job.kind === 'publish-carousel-intake' && /publishCarousel|media_publish/i.test(message)) {
    return false;
  }

  return true;
}

async function markJobFailedOrRequeued(job, error) {
  const message = getErrorMessage(error);
  const now = new Date();

  if (canRetryJobFailure(job, message)) {
    const nextRunAt = new Date(now.getTime() + transientRetryDelayMs).toISOString();
    job.status = 'queued';
    job.runAt = nextRunAt;
    job.completedAt = null;
    job.updatedAt = now.toISOString();
    job.error = `Transient failure, retry scheduled for ${nextRunAt}: ${message}`;
    addAuditLog({
      category: 'job',
      action: 'requeued',
      jobId: job.id,
      kind: job.kind,
      requestId: job.requestId || null,
      error: job.error
    });
    return;
  }

  job.status = 'failed';
  job.completedAt = now.toISOString();
  job.updatedAt = job.completedAt;
  job.error = message;
  addAuditLog({
    category: 'job',
    action: 'failed',
    jobId: job.id,
    kind: job.kind,
    requestId: job.requestId || null,
    error: job.error
  });
}

function getNextQueuedJob(now = new Date()) {
  return [...jobs.values()]
    .filter((job) => {
      if (job.status !== 'queued') {
        return false;
      }

      if (isLegacyQueuedJob(job)) {
        return false;
      }

      if (!job.runAt) {
        return true;
      }

      const runAt = new Date(job.runAt);
      return !Number.isNaN(runAt.getTime()) && runAt <= now;
    })
    .sort((left, right) => {
      const leftRunAt = left.runAt ? new Date(left.runAt).getTime() : 0;
      const rightRunAt = right.runAt ? new Date(right.runAt).getTime() : 0;

      if (leftRunAt !== rightRunAt) {
        return leftRunAt - rightRunAt;
      }

      return new Date(left.createdAt) - new Date(right.createdAt);
    })[0] || null;
}

async function processNextJob(now = new Date()) {
  if (workerPaused || activeJobId) {
    return;
  }

  const job = getNextQueuedJob(now);
  if (!job) {
    return;
  }

  const processor = processors.get(job.kind);
  if (!processor) {
    job.status = 'failed';
    job.updatedAt = new Date().toISOString();
    job.error = `No processor registered for job kind: ${job.kind}`;
    await persistJob(job);
    return;
  }

  activeJobId = job.id;
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  job.updatedAt = job.startedAt;
  job.attempts = (job.attempts || 0) + 1;
  await persistJobs();

  try {
    job.result = await processor(job.payload, {
      requestId: job.requestId,
      user: job.createdBy || null,
      jobId: job.id
    });
    job.status = 'completed';
    job.completedAt = new Date().toISOString();
    job.updatedAt = job.completedAt;
    job.error = null;
    addAuditLog({
      category: 'job',
      action: 'completed',
      jobId: job.id,
      kind: job.kind,
      requestId: job.requestId || null
    });
  } catch (error) {
    await markJobFailedOrRequeued(job, error);
  } finally {
    activeJobId = null;
    await persistJobs();
  }
}

export function startJobWorker() {
  workerPaused = false;
  if (!workerEnabled || getSchedulerState().executionMode === 'github_actions_window') {
    return;
  }
  if (workerTimer) {
    return;
  }

  workerTimer = setInterval(() => {
    void processNextJob();
  }, config.jobs?.workerIntervalMs || 750);
}

export function stopJobWorker({ pause = true } = {}) {
  workerPaused = Boolean(pause);
  if (workerTimer) {
    clearInterval(workerTimer);
    workerTimer = null;
  }
}

export function pauseJobWorker() {
  stopJobWorker();
}

export function resumeJobWorker() {
  workerPaused = false;
  startJobWorker();
}

export function getJobWorkerStatus() {
  return {
    enabled: workerEnabled,
    executionMode: getSchedulerState().executionMode,
    running: Boolean(workerTimer),
    paused: workerPaused,
    activeJobId
  };
}

export async function runDueJobsOnce({ now = new Date(), maxJobs = 20 } = {}) {
  const startedAt = Date.now();
  let processed = 0;
  let lastJobId = null;

  while (processed < maxJobs) {
    if (workerPaused || activeJobId) {
      break;
    }

    const job = getNextQueuedJob(now);
    if (!job) {
      break;
    }

    if (job.runAt) {
      const runAt = new Date(job.runAt);
      if (!Number.isNaN(runAt.getTime()) && runAt > now) {
        break;
      }
    }

    const processor = processors.get(job.kind);
    if (!processor) {
      job.status = 'failed';
      job.updatedAt = new Date().toISOString();
      job.error = `No processor registered for job kind: ${job.kind}`;
      await persistJob(job);
      processed += 1;
      lastJobId = job.id;
      continue;
    }

    activeJobId = job.id;
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.updatedAt = job.startedAt;
    job.attempts = (job.attempts || 0) + 1;
    await persistJobs();

    try {
      job.result = await processor(job.payload, {
        requestId: job.requestId,
        user: job.createdBy || null,
        jobId: job.id
      });
      job.status = 'completed';
      job.completedAt = new Date().toISOString();
      job.updatedAt = job.completedAt;
      job.error = null;
      addAuditLog({
        category: 'job',
        action: 'completed',
        jobId: job.id,
        kind: job.kind,
        requestId: job.requestId || null
      });
    } catch (error) {
      await markJobFailedOrRequeued(job, error);
    } finally {
      activeJobId = null;
      await persistJobs();
    }

    processed += 1;
    lastJobId = job.id;
  }

  return {
    ok: true,
    processed,
    lastJobId,
    durationMs: Date.now() - startedAt,
    worker: getJobWorkerStatus()
  };
}

export async function enqueueJob({
  kind,
  payload,
  idempotencyKey,
  requestId,
  createdBy,
  runAt = null
}) {
  if (idempotencyKey) {
    const existing = [...jobs.values()].find((job) =>
      job.kind === kind &&
      job.idempotencyKey === idempotencyKey &&
      ['queued', 'running', 'completed'].includes(job.status)
    );

    if (existing) {
      return existing;
    }
  }

  const now = new Date().toISOString();
  const job = {
    id: crypto.randomUUID(),
    kind,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    attempts: 0,
    idempotencyKey: idempotencyKey || null,
    requestId: requestId || null,
    createdBy: createdBy || null,
    runAt: runAt || null,
    payload,
    result: null,
    error: null
  };

  jobs.set(job.id, job);
  await persistJob(job);
  addAuditLog({
    category: 'job',
    action: 'queued',
    jobId: job.id,
    kind: job.kind,
    requestId: job.requestId || null
  });
  return job;
}

export function getJob(jobId) {
  return jobs.get(jobId) || null;
}

export function findQueuedJobByIntake({ intakeId, kinds = [] }) {
  const kindSet = new Set(kinds);
  return [...jobs.values()]
    .filter((job) =>
      job.status === 'queued' &&
      !isLegacyQueuedJob(job) &&
      (!kindSet.size || kindSet.has(job.kind)) &&
      job.payload?.intakeId === intakeId
    )
    .sort((left, right) => {
      const leftRunAt = left.runAt ? new Date(left.runAt).getTime() : 0;
      const rightRunAt = right.runAt ? new Date(right.runAt).getTime() : 0;

      if (leftRunAt !== rightRunAt) {
        return leftRunAt - rightRunAt;
      }

      return new Date(left.createdAt) - new Date(right.createdAt);
    })[0] || null;
}

export async function updateQueuedJob(jobId, patch) {
  const job = getJob(jobId);
  if (!job) {
    throw new Error('Job not found.');
  }

  if (job.status !== 'queued') {
    throw new Error('Only queued jobs can be updated.');
  }

  const updated = {
    ...job,
    ...patch,
    payload: patch.payload ? { ...job.payload, ...patch.payload } : job.payload,
    updatedAt: new Date().toISOString()
  };

  jobs.set(updated.id, updated);
  await persistJob(updated);
  addAuditLog({
    category: 'job',
    action: 'updated',
    jobId: updated.id,
    kind: updated.kind,
    requestId: updated.requestId || null
  });
  return updated;
}

export function listJobs(limit = 20) {
  return [...jobs.values()]
    .sort((left, right) => new Date(right.createdAt) - new Date(left.createdAt))
    .slice(0, limit);
}

export async function archiveQueuedJobsBefore(cutoffAt, reason = 'Skipped because the publishing mode was changed before this job was due.') {
  if (!cutoffAt) {
    return [];
  }

  const cutoff = new Date(cutoffAt);
  if (Number.isNaN(cutoff.getTime())) {
    return [];
  }

  const archived = [];
  for (const job of jobs.values()) {
    if (job.status !== 'queued') {
      continue;
    }

    const createdAt = new Date(job.createdAt);
    if (Number.isNaN(createdAt.getTime()) || createdAt >= cutoff) {
      continue;
    }

    const updated = {
      ...job,
      status: 'skipped',
      updatedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      error: reason
    };
    jobs.set(updated.id, updated);
    archived.push(updated);
  }

  if (archived.length > 0) {
    await persistJobs();
  }

  return archived;
}
