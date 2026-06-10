import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadIntakes, markIntakeProcessed, getIntake } from '../src/services/intake-store.js';
import { loadJobs, enqueueJob, runDueJobsOnce, listJobs } from '../src/services/jobs.js';
import { config } from '../src/config.js';
import { loadSchedulerState } from '../src/services/scheduler-state.js';
import { registerDefaultJobProcessors } from '../src/services/job-processors.js';
import { registerJobProcessor } from '../src/services/jobs.js';

async function main() {
  await loadSchedulerState();
  await loadIntakes();
  await loadJobs();
  registerDefaultJobProcessors(registerJobProcessor);

  const raw = await fs.readFile(config.media.intakesFile, 'utf8');
  const intakes = JSON.parse(raw);

  const recentCarousel = [...intakes].reverse().find(i => i.isCarousel || i.publishStrategy === 'graph_carousel');
  const recentVideo = [...intakes].reverse().find(i => i.mediaKind === 'video' || (i.route && i.route.mediaKind === 'video') || i.hostedVideo) || {
    id: "dummy-video",
    mediaKind: "video",
    route: { mediaKind: "video", instagramFormat: "reel" },
    publishStrategy: "video",
    hostedVideo: { publicUrl: "https://example.com/video.mp4" },
    distributionPlan: {
      instagram: { caption: "Test video", location: "Test" },
      youtube: { description: "Test video", title: "Test" },
      pinterest: { description: "Test video", title: "Test" }
    }
  };

  if (!recentCarousel) throw new Error("No recent carousel found");

  const runAtTime = new Date(Date.now() + 20 * 60 * 1000).toISOString();
  console.log(`Setting custom test target time to ${runAtTime}`);

  const testCarouselId = `test-carousel-${crypto.randomUUID()}`;
  const testCarousel = { 
    ...recentCarousel, 
    id: testCarouselId,
    status: 'holding',
    currentStage: 'holding',
    currentStageLabel: 'Waiting for operator review (10m hold)',
    scheduledFor: runAtTime,
    schedule: { slotLabel: "Custom carousel slot" },
    createdAt: new Date().toISOString()
  };

  const testVideoId = `test-video-${crypto.randomUUID()}`;
  const testVideo = {
    ...recentVideo,
    id: testVideoId,
    status: 'holding',
    currentStage: 'holding',
    currentStageLabel: 'Waiting for operator review (10m hold)',
    scheduledFor: runAtTime,
    createdAt: new Date().toISOString()
  };
  if (testVideo.schedule) testVideo.schedule.slotLabel = "Custom test video slot";

  intakes.push(testCarousel, testVideo);
  
  if (process.env.QUEUE_STORE_PROVIDER === 'supabase') {
    const { upsertSupabaseRecord } = await import('../src/services/supabase-store.js');
    await upsertSupabaseRecord(config.queueStore.intakesTable, testCarousel);
    await upsertSupabaseRecord(config.queueStore.intakesTable, testVideo);
  } else {
    await fs.writeFile(config.media.intakesFile, JSON.stringify(intakes, null, 2), 'utf8');
  }
  
  await loadIntakes();

  console.log('Enqueuing finalize-intake jobs for immediate execution (simulating end of 10 min hold)...');

  
  await enqueueJob({
    kind: 'finalize-intake',
    payload: { intakeId: testCarousel.id, channelId: null, alreadyPublishedPinterest: false },
    runAt: new Date().toISOString(),
    idempotencyKey: `finalize-intake:${testCarousel.id}`
  });

  await enqueueJob({
    kind: 'finalize-intake',
    payload: { intakeId: testVideo.id, channelId: null, alreadyPublishedPinterest: false },
    runAt: new Date().toISOString(),
    idempotencyKey: `finalize-intake:${testVideo.id}`
  });

  console.log('Running worker loop to process the finalize-intake jobs...');
  await runDueJobsOnce({ maxJobs: 10 });
  
  console.log('Checking status...');
  const updatedCarousel = getIntake(testCarousel.id);
  const updatedVideo = getIntake(testVideo.id);

  console.log('Carousel status:', updatedCarousel.status, '| LastJobId:', updatedCarousel.lastJobId);
  console.log('Video status:', updatedVideo.status, '| Buffer ID:', updatedVideo.bufferPostId);

  const yml = await fs.readFile(path.resolve(process.cwd(), '.github/workflows/run-due-jobs.yml'), 'utf8');
  const d = new Date(runAtTime);
  const expectedCron = `${d.getUTCMinutes()} ${d.getUTCHours()} * * *`;
  if (yml.includes(expectedCron)) {
    console.log(`✅ Success: run-due-jobs.yml was updated with ${expectedCron}`);
  } else {
    console.log(`❌ Failed: run-due-jobs.yml does not contain ${expectedCron}`);
  }
}

main().catch(console.error);
