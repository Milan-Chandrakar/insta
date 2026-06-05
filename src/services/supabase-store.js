import { config } from '../config.js';
import { fetchWithPolicy } from './http-client.js';

function normalizeProvider(value) {
  return String(value || '').trim().toLowerCase();
}

export function isSupabaseQueueStoreEnabled() {
  return normalizeProvider(config.queueStore?.provider) === 'supabase';
}

export function hasSupabaseQueueStoreConfig() {
  return Boolean(
    config.queueStore?.supabaseUrl &&
    config.queueStore?.supabaseServiceRoleKey &&
    config.queueStore?.jobsTable &&
    config.queueStore?.intakesTable
  );
}

function assertSupabaseConfigured() {
  if (!hasSupabaseQueueStoreConfig()) {
    throw new Error('Supabase queue store is enabled, but SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, or table names are missing.');
  }
}

function getTableUrl(tableName, query = '') {
  assertSupabaseConfigured();
  const base = `${config.queueStore.supabaseUrl}/rest/v1/${encodeURIComponent(tableName)}`;
  return query ? `${base}?${query}` : base;
}

function getHeaders(extra = {}) {
  return {
    apikey: config.queueStore.supabaseServiceRoleKey,
    Authorization: `Bearer ${config.queueStore.supabaseServiceRoleKey}`,
    'Content-Type': 'application/json',
    ...extra
  };
}

async function parseSupabaseResponse(response, operation) {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload?.message || payload?.hint || payload?.details || `HTTP ${response.status}`;
    throw new Error(`Supabase ${operation} failed: ${detail}`);
  }
  return payload;
}

export async function loadSupabaseCollection(tableName) {
  const response = await fetchWithPolicy(
    getTableUrl(tableName, 'select=data&order=updated_at.desc.nullslast'),
    {
      method: 'GET',
      headers: getHeaders(),
      logContext: {
        service: 'supabase',
        operation: `load:${tableName}`
      }
    }
  );
  const rows = await parseSupabaseResponse(response, `load ${tableName}`);
  return (Array.isArray(rows) ? rows : [])
    .map((row) => row?.data)
    .filter((record) => record?.id);
}

export async function upsertSupabaseRecord(tableName, record) {
  if (!record?.id) {
    throw new Error(`Cannot persist ${tableName} record without an id.`);
  }

  const response = await fetchWithPolicy(
    getTableUrl(tableName, 'on_conflict=id'),
    {
      method: 'POST',
      headers: getHeaders({
        Prefer: 'resolution=merge-duplicates,return=minimal'
      }),
      body: JSON.stringify({
        id: record.id,
        data: record,
        updated_at: record.updatedAt || new Date().toISOString()
      }),
      logContext: {
        service: 'supabase',
        operation: `upsert:${tableName}`
      }
    }
  );
  await parseSupabaseResponse(response, `upsert ${tableName}`);
}

export async function upsertSupabaseCollection(tableName, records) {
  const validRecords = (Array.isArray(records) ? records : []).filter((record) => record?.id);
  if (validRecords.length === 0) {
    return;
  }

  const response = await fetchWithPolicy(
    getTableUrl(tableName, 'on_conflict=id'),
    {
      method: 'POST',
      headers: getHeaders({
        Prefer: 'resolution=merge-duplicates,return=minimal'
      }),
      body: JSON.stringify(validRecords.map((record) => ({
        id: record.id,
        data: record,
        updated_at: record.updatedAt || new Date().toISOString()
      }))),
      logContext: {
        service: 'supabase',
        operation: `upsertMany:${tableName}`
      }
    }
  );
  await parseSupabaseResponse(response, `upsert ${tableName}`);
}

export async function deleteSupabaseRecordsBefore(tableName, { beforeUpdatedAt, ids = [] }) {
  assertSupabaseConfigured();

  const filters = [];
  if (beforeUpdatedAt) {
    filters.push(`updated_at=lt.${encodeURIComponent(beforeUpdatedAt)}`);
  }
  if (Array.isArray(ids) && ids.length > 0) {
    filters.push(`id=in.(${ids.map((id) => encodeURIComponent(id)).join(',')})`);
  }

  if (filters.length === 0) {
    return;
  }

  const response = await fetchWithPolicy(
    getTableUrl(tableName, filters.join('&')),
    {
      method: 'DELETE',
      headers: getHeaders({
        Prefer: 'return=minimal'
      }),
      logContext: {
        service: 'supabase',
        operation: `deleteMany:${tableName}`
      }
    }
  );
  await parseSupabaseResponse(response, `delete ${tableName}`);
}
