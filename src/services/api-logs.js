import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

const MAX_LOG_ENTRIES = 200;
const logEntries = [];

async function appendJsonLine(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

function pickHeaders(headers, names) {
  const selected = {};

  for (const name of names) {
    const value = headers.get(name);
    if (value) {
      selected[name] = value;
    }
  }

  return selected;
}

export function extractInterestingHeaders(headers) {
  if (!headers) {
    return {};
  }

  return pickHeaders(headers, [
    'retry-after',
    'ratelimit-limit',
    'ratelimit-remaining',
    'ratelimit-reset',
    'x-ratelimit-limit',
    'x-ratelimit-remaining',
    'x-ratelimit-reset',
    'x-request-id',
    'request-id',
    'cf-ray',
    'content-type'
  ]);
}

export function addApiLog(entry) {
  const normalized = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    ...entry
  };

  logEntries.unshift(normalized);
  if (logEntries.length > MAX_LOG_ENTRIES) {
    logEntries.length = MAX_LOG_ENTRIES;
  }

  void appendJsonLine(config.apiLogsFile, normalized);

  return normalized;
}

export function addWorkflowLog(entry) {
  return addApiLog({
    service: 'workflow',
    operation: entry.operation || 'stage',
    status: entry.status || 'running',
    model: entry.model || null,
    usage: entry.usage || null,
    limits: entry.limits || null,
    http: entry.http || null,
    summary: entry.summary || '',
    error: entry.error || null,
    stage: entry.stage || null,
    requestId: entry.requestId || null,
    jobKind: entry.jobKind || null,
    details: entry.details || null,
    durationMs: entry.durationMs ?? null
  });
}

export function getApiLogs(limit = 60) {
  return logEntries.slice(0, limit);
}

export function clearApiLogs() {
  logEntries.length = 0;
}

export function addAuditLog(entry) {
  const normalized = {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    ...entry
  };

  void appendJsonLine(config.auditLogsFile, normalized);
  return normalized;
}
