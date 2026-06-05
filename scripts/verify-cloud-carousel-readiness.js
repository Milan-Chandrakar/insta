import { loadIntakes, getIntake } from '../src/services/intake-store.js';
import { loadJobs, listJobs } from '../src/services/jobs.js';
import {
  hasSupabaseQueueStoreConfig,
  isSupabaseQueueStoreEnabled
} from '../src/services/supabase-store.js';

function hasHostedCarouselImages(intake) {
  const hostedImages = Array.isArray(intake?.hostedImages) ? intake.hostedImages : [];
  return hostedImages.filter((item) => /^https?:\/\//i.test(item?.publicUrl || '')).length >= 2;
}

async function main() {
  await loadJobs();
  await loadIntakes();

  const carouselJobs = listJobs(200)
    .filter((job) => job.kind === 'publish-carousel-intake' && ['queued', 'failed'].includes(job.status))
    .map((job) => {
      const intake = getIntake(job.payload?.intakeId);
      return {
        jobId: job.id,
        status: job.status,
        runAt: job.runAt,
        intakeId: job.payload?.intakeId || null,
        filename: intake?.filename || null,
        intakeStatus: intake?.status || null,
        hostedImageCount: (intake?.hostedImages || []).filter((item) => item?.publicUrl).length,
        cloudReady: hasHostedCarouselImages(intake),
        lastError: job.error || intake?.lastError || null
      };
    });

  const notReady = carouselJobs.filter((job) => !job.cloudReady);
  console.log(JSON.stringify({
    ok: notReady.length === 0,
    queueStore: {
      provider: isSupabaseQueueStoreEnabled() ? 'supabase' : 'local_json',
      supabaseConfigured: hasSupabaseQueueStoreConfig()
    },
    checked: carouselJobs.length,
    notReady: notReady.length,
    carouselJobs
  }, null, 2));

  if (notReady.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error)
  }));
  process.exit(1);
});
