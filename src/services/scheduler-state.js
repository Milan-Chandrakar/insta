import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import {
  isSupabaseQueueStoreEnabled,
  loadSupabaseCollection,
  upsertSupabaseRecord
} from './supabase-store.js';

const SCHEDULER_STATE_ROW_ID = '__scheduler_state__';

const DEFAULT_STATE = {
  executionMode: config.scheduler.executionMode || 'local_worker',
  queueCutoffAt: null,
  updatedAt: null
};

let schedulerState = { ...DEFAULT_STATE };
let loadPromise = null;

function normalizeState(value) {
  const executionMode = value?.executionMode === 'github_actions_window'
    ? 'github_actions_window'
    : 'local_worker';
  const rawCutoff = typeof value?.queueCutoffAt === 'string' ? value.queueCutoffAt.trim() : '';
  const queueCutoffAt = executionMode === 'github_actions_window'
    ? (rawCutoff || value?.updatedAt || null)
    : null;

  return {
    executionMode,
    queueCutoffAt,
    updatedAt: value?.updatedAt || null
  };
}

async function writeStateFile(state) {
  await fs.mkdir(path.dirname(config.scheduler.settingsFile), { recursive: true });
  const payload = JSON.stringify(state, null, 2);
  const tempFile = `${config.scheduler.settingsFile}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(tempFile, `${payload}\n`, 'utf8');
  try {
    await fs.rename(tempFile, config.scheduler.settingsFile);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      await fs.writeFile(config.scheduler.settingsFile, `${payload}\n`, 'utf8');
      return;
    }
    throw error;
  } finally {
    await fs.rm(tempFile, { force: true }).catch(() => {});
  }
}

export async function loadSchedulerState() {
  if (loadPromise) {
    return loadPromise;
  }

  loadPromise = (async () => {
    if (isSupabaseQueueStoreEnabled()) {
      try {
        const items = await loadSupabaseCollection(config.queueStore.jobsTable);
        const schedulerItem = Array.isArray(items)
          ? items.find((item) => item?.id === SCHEDULER_STATE_ROW_ID || item?.kind === 'scheduler-state')
          : null;
        schedulerState = normalizeState(schedulerItem?.data || schedulerItem || DEFAULT_STATE);
        return schedulerState;
      } catch (error) {
        console.warn(`Scheduler state fallback to local file: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    try {
      const raw = await fs.readFile(config.scheduler.settingsFile, 'utf8');
      schedulerState = normalizeState(JSON.parse(raw));
    } catch (error) {
      if (error?.code === 'ENOENT') {
        schedulerState = normalizeState(DEFAULT_STATE);
        return schedulerState;
      }

      if (error instanceof SyntaxError) {
        schedulerState = normalizeState(DEFAULT_STATE);
        await writeStateFile(schedulerState);
        return schedulerState;
      }

      throw error;
    }

    return schedulerState;
  })();

  return loadPromise;
}

export function getSchedulerState() {
  return normalizeState(schedulerState);
}

export async function setSchedulerExecutionMode(executionMode) {
  const updatedAt = new Date().toISOString();
  schedulerState = normalizeState({
    executionMode,
    queueCutoffAt: executionMode === 'github_actions_window' ? updatedAt : null,
    updatedAt
  });

  if (isSupabaseQueueStoreEnabled()) {
    await upsertSupabaseRecord(config.queueStore.jobsTable, {
      id: SCHEDULER_STATE_ROW_ID,
      kind: 'scheduler-state',
      ...schedulerState
    });
  }

  await writeStateFile(schedulerState);
  return getSchedulerState();
}

export function isGitHubActionsOnlyMode() {
  return getSchedulerState().executionMode === 'github_actions_window';
}
