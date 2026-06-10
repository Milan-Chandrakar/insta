/**
 * inject-test-carousel-job.js
 *
 * TEST HELPER: Injects a publish-carousel-intake job scheduled 5 minutes from
 * now using the SAME services the real server uses (writes to Supabase when
 * QUEUE_STORE_PROVIDER=supabase, otherwise to data/jobs.json + data/intakes.json).
 *
 * Usage:
 *   $env:TEST_IMAGE_URLS="https://...img1.jpg,https://...img2.jpg"
 *   node scripts/inject-test-carousel-job.js
 *
 * After running:
 *   1. Stop all local servers.
 *   2. Wait 5 minutes.
 *   3. node scripts/run-scheduled-carousel.js
 *   4. Verify job status = "completed" in Supabase / data/jobs.json.
 *   5. Check Instagram for the carousel post.
 */

import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { loadIntakes } from '../src/services/intake-store.js';
import { loadJobs, enqueueJob } from '../src/services/jobs.js';
import { loadSchedulerState } from '../src/services/scheduler-state.js';
import { loadShortLinks } from '../src/services/short-links.js';
import {
  isSupabaseQueueStoreEnabled,
  upsertSupabaseRecord
} from '../src/services/supabase-store.js';
import { config } from '../src/config.js';

const rawUrls = process.env.TEST_IMAGE_URLS || '';
const imageUrls = rawUrls.split(',').map((u) => u.trim()).filter(Boolean);

if (imageUrls.length < 2) {
  console.error(
    'ERROR: Set TEST_IMAGE_URLS to a comma-separated list of at least 2 public image URLs.\n' +
    'Example:\n' +
    '  $env:TEST_IMAGE_URLS="https://res.cloudinary.com/.../img1.jpg,https://...img2.jpg"\n' +
    '  node scripts/inject-test-carousel-job.js'
  );
  process.exit(1);
}

// Bootstrap all services (mirrors what the server / run-due-jobs does)
await loadSchedulerState();
await loadJobs();
await loadIntakes();
await loadShortLinks();

const now = new Date();
const runAt = new Date(now.getTime() + 5 * 60 * 1000); // 5 minutes from now
const intakeId = `test-carousel-${crypto.randomUUID()}`;

// Build a minimal intake record that looks like a real zip carousel intake.
// It has hostedImages already set so publishScheduledCarouselIntake can skip
// the upload step and go straight to the Graph API publish.
const intake = {
  id: intakeId,
  source: 'test',
  sourceFormat: 'zip_carousel',
  publishStrategy: 'graph_carousel',
  messageId: `test:${intakeId}`,
  chatId: 'test',
  chatName: 'Test (inject-test-carousel-job)',
  fromMe: true,
  body: 'Test carousel — injected by inject-test-carousel-job.js',
  filename: 'test-carousel.zip',
  mimeType: 'application/zip',
  mediaKind: 'image',
  isCarousel: true,
  carouselSize: imageUrls.length,
  imagePaths: [],
  imageUrls,
  // Pre-set hostedImages so the publish job skips re-uploading to Cloudinary
  hostedImages: imageUrls.map((url, i) => ({ publicUrl: url, provider: 'cloudinary', index: i })),
  captionOverride: 'Test carousel — verifying serverless publish pipeline. 🙏',
  status: 'scheduled',
  currentStage: 'scheduled',
  currentStageLabel: 'Queued for carousel publish (test injection)',
  scheduledFor: runAt.toISOString(),
  createdAt: now.toISOString(),
  updatedAt: now.toISOString()
};

// Write intake to the correct store
if (isSupabaseQueueStoreEnabled()) {
  await upsertSupabaseRecord(config.queueStore.intakesTable, intake);
  console.error('Intake written to Supabase.');
} else {
  // Write directly to the local intakes.json
  let existing = [];
  try {
    const raw = await fs.readFile(config.media.intakesFile, 'utf8');
    const parsed = JSON.parse(raw);
    existing = Array.isArray(parsed) ? parsed : [];
  } catch { /* file may not exist yet */ }

  existing.push(intake);
  await fs.mkdir(path.dirname(config.media.intakesFile), { recursive: true }).catch(() => {});
  await fs.writeFile(config.media.intakesFile, JSON.stringify(existing, null, 2) + '\n', 'utf8');
  console.error('Intake written to local intakes.json.');
}

// Enqueue the publish job via the real enqueueJob
// (writes to Supabase or data/jobs.json depending on QUEUE_STORE_PROVIDER)
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
  message: `Test job enqueued. Due at ${runAt.toISOString()} (~5 min).`,
  intakeId,
  jobId: job.id,
  runAt: runAt.toISOString(),
  hostedImages: imageUrls,
  nextSteps: [
    '1. Stop all local servers (Ctrl+C the Express server if running).',
    '2. Wait 5 minutes.',
    '3. Run: node scripts/run-scheduled-carousel.js',
    '4. Job status should be "completed" in Supabase / data/jobs.json.',
    '5. Check your Instagram account for the carousel post.'
  ]
}, null, 2));
