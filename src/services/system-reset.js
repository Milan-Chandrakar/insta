import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import {
  hasSupabaseQueueStoreConfig,
  loadSupabaseCollection,
  deleteSupabaseRecordsBefore
} from './supabase-store.js';

export async function clearLocalFile(filePath, emptyValue = '[]', dryRun = false) {
  try {
    await fs.access(filePath);
    if (dryRun) {
      return `[DRY RUN] Would clear ${filePath}`;
    }
    await fs.writeFile(filePath, emptyValue + '\n', 'utf8');
    return `Cleared ${path.basename(filePath)}`;
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return `${path.basename(filePath)} does not exist, skipping.`;
    } else {
      throw new Error(`Error clearing ${path.basename(filePath)}: ${error.message}`);
    }
  }
}

export async function clearSupabaseTable(tableName, dryRun = false) {
  if (!hasSupabaseQueueStoreConfig()) {
    return `Supabase not configured, skipping ${tableName}.`;
  }

  try {
    const records = await loadSupabaseCollection(tableName);
    if (records.length === 0) {
      return `${tableName} is already empty.`;
    }

    if (dryRun) {
      return `[DRY RUN] Would delete ${records.length} records from ${tableName}`;
    }

    const ids = records.map((r) => r.id).filter(Boolean);
    if (ids.length > 0) {
      await deleteSupabaseRecordsBefore(tableName, {
        ids,
        beforeUpdatedAt: new Date(Date.now() + 86400000).toISOString()
      });
    }
    return `Deleted ${ids.length} records from Supabase ${tableName}`;
  } catch (error) {
    throw new Error(`Error clearing Supabase ${tableName}: ${error.message}`);
  }
}

export async function performSystemReset(dryRun = false) {
  const results = [];

  // 1. Clear Supabase tables
  results.push(await clearSupabaseTable(config.queueStore.jobsTable || 'automation_jobs', dryRun));
  results.push(await clearSupabaseTable(config.queueStore.intakesTable || 'automation_intakes', dryRun));

  // 2. Clear local JSON files
  results.push(await clearLocalFile(config.jobsFile || 'data/jobs.json', '[]', dryRun));
  results.push(await clearLocalFile(config.media?.intakesFile || 'data/intakes.json', '[]', dryRun));

  // 3. Clear log files
  results.push(await clearLocalFile(config.apiLogsFile || 'data/api-logs.jsonl', '', dryRun));
  results.push(await clearLocalFile(config.auditLogsFile || 'data/audit-log.jsonl', '', dryRun));

  // 4. Mark reset time to prevent old WhatsApp messages from syncing
  if (!dryRun) {
    try {
      await fs.writeFile('data/reset-time.json', JSON.stringify({ resetAt: Date.now() }), 'utf8');
      results.push('Set reset timestamp marker to ignore old WhatsApp history.');
    } catch (err) {
      results.push(`Warning: Could not set reset timestamp marker: ${err.message}`);
    }
  }

  return results;
}
