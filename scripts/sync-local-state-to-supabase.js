import fs from 'node:fs/promises';
import { config } from '../src/config.js';
import {
  hasSupabaseQueueStoreConfig,
  upsertSupabaseCollection
} from '../src/services/supabase-store.js';

async function readJsonArray(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function main() {
  if (!hasSupabaseQueueStoreConfig()) {
    throw new Error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before syncing local state.');
  }

  const jobs = await readJsonArray(config.jobsFile);
  const intakes = await readJsonArray(config.media.intakesFile);

  await upsertSupabaseCollection(config.queueStore.jobsTable, jobs);
  await upsertSupabaseCollection(config.queueStore.intakesTable, intakes);

  console.log(JSON.stringify({
    ok: true,
    synced: {
      jobs: jobs.length,
      intakes: intakes.length
    },
    tables: {
      jobs: config.queueStore.jobsTable,
      intakes: config.queueStore.intakesTable
    }
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  }));
  process.exit(1);
});
