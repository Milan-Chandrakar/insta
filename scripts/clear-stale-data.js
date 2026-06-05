/**
 * clear-stale-data.js
 *
 * One-shot script to wipe all stale jobs and intakes from both local JSON
 * files and Supabase tables, giving the dashboard a clean slate.
 *
 * Usage:  node scripts/clear-stale-data.js
 */

import { config } from '../src/config.js';
import { performSystemReset } from '../src/services/system-reset.js';

const DRY_RUN = process.argv.includes('--dry-run');

async function main() {
  console.log(DRY_RUN ? '\n=== DRY RUN MODE ===' : '\n=== Clearing Stale Data ===');
  console.log(`Queue store provider: ${config.queueStore.provider}\n`);

  const results = await performSystemReset(DRY_RUN);
  
  results.forEach(result => {
    console.log(`  > ${result}`);
  });

  console.log('\n=== Done ===');
  console.log('Dashboard is now clean. New WhatsApp intakes will appear fresh.');
}

main().catch((error) => {
  console.error('Fatal error:', error.message);
  process.exit(1);
});
