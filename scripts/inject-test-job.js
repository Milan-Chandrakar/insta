import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { loadIntakes, markIntakeProcessed } from '../src/services/intake-store.js';
import { loadJobs, enqueueJob } from '../src/services/jobs.js';
import { loadSchedulerState } from '../src/services/scheduler-state.js';
import { loadShortLinks } from '../src/services/short-links.js';
import { isSupabaseQueueStoreEnabled, upsertSupabaseRecord } from '../src/services/supabase-store.js';
import { config } from '../src/config.js';

const rawUrls = process.env.TEST_IMAGE_URLS || '';
const imageUrls = rawUrls.split(',').map((u) => u.trim()).filter(Boolean);

if (imageUrls.length < 2) {
  console.error(
    'ERROR: Set TEST_IMAGE_URLS to a comma-separated list of at least 2 public image URLs.\n' +
    'Example:\n' +
    '  $env:TEST_IMAGE_URLS="https://res.cloudinary.com/.../img1.jpg,https://...img2.jpg"\n' +
    '  node scripts/inject-test-job.js'
  );
  process.exit(1);
}

await loadSchedulerState();
await loadJobs();
await loadIntakes();
await loadShortLinks();

const now = new Date();
const runAt = new Date(now.getTime() - 5 * 60 * 1000); // 5 minutes IN THE PAST so it's due IMMEDIATELY
const intakeId = `test-carousel-${crypto.randomUUID()}`;

const intake = {
  id: intakeId,
  source: 'test',
  sourceFormat: 'zip_carousel',
  publishStrategy: 'graph_carousel',
  messageId: `test:${intakeId}`,
  chatId: 'test',
  chatName: 'Test (inject-test-job)',
  fromMe: true,
  body: 'Test carousel — GitHub Actions offline test',
  filename: 'test-carousel.zip',
  mimeType: 'application/zip',
  mediaKind: 'image',
  isCarousel: true,
  carouselSize: imageUrls.length,
  imagePaths: [],
  imageUrls,
  hostedImages: imageUrls.map((url, i) => ({ publicUrl: url, provider: 'cloudinary', index: i })),
  captionOverride: 'Test carousel — verifying GitHub Actions offline publish pipeline. 🙏',
  status: 'scheduled',
  currentStage: 'scheduled',
  currentStageLabel: 'Queued for carousel publish (test injection)',
  scheduledFor: runAt.toISOString(),
  createdAt: now.toISOString(),
  updatedAt: now.toISOString()
};

if (isSupabaseQueueStoreEnabled()) {
  await upsertSupabaseRecord(config.queueStore.intakesTable, intake);
} else {
  let existing = [];
  try {
    const raw = await fs.readFile(config.media.intakesFile, 'utf8');
    const parsed = JSON.parse(raw);
    existing = Array.isArray(parsed) ? parsed : [];
  } catch {}
  existing.push(intake);
  await fs.mkdir(require('node:path').dirname(config.media.intakesFile), { recursive: true }).catch(() => {});
  await fs.writeFile(config.media.intakesFile, JSON.stringify(existing, null, 2) + '\n', 'utf8');
}

const job = await enqueueJob({
  kind: 'publish-carousel-intake',
  payload: { intakeId },
  idempotencyKey: `publish-carousel:${intakeId}`,
  requestId: `test:${intakeId}`,
  createdBy: 'test-script',
  runAt: runAt.toISOString()
});

console.log(JSON.stringify({
  ok: true,
  store: process.env.QUEUE_STORE_PROVIDER || 'local_json',
  message: `Test job enqueued. Due at ${runAt.toISOString()} (already due).`,
  intakeId,
  jobId: job.id
}, null, 2));
