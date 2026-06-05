import { loadIntakes } from '../src/services/intake-store.js';
import { loadJobs, listJobs, registerJobProcessor, runDueJobsOnce } from '../src/services/jobs.js';
import { registerDefaultJobProcessors } from '../src/services/job-processors.js';
import { loadShortLinks } from '../src/services/short-links.js';
import { isWithinPublishingWindow, getPublishingWindowStatus } from '../src/services/publishing-windows.js';

const args = new Set(process.argv.slice(2));
const force = args.has('--force');

function hasPublishNowJobs() {
  const allJobs = listJobs(200);
  return allJobs.some((job) =>
    job.status === 'queued' && job.payload?.publishNow === true
  );
}

async function main() {
  await loadJobs();
  await loadIntakes();
  await loadShortLinks();
  registerDefaultJobProcessors((kind, processor) => registerJobProcessor(kind, processor));

  const windowStatus = getPublishingWindowStatus();
  const hasUrgentJobs = hasPublishNowJobs();
  if (!force && !hasUrgentJobs && !isWithinPublishingWindow()) {
    console.log(JSON.stringify({
      ok: true,
      skipped: true,
      reason: 'Outside publishing window and no publishNow jobs',
      windowStatus
    }));
    return;
  }

  const result = await runDueJobsOnce({ maxJobs: 20 });
  console.log(JSON.stringify({
    ok: true,
    forced: force,
    hasUrgentJobs,
    windowStatus,
    result
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  }));
  process.exit(1);
});
