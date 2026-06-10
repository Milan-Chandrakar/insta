import fs from 'node:fs/promises';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
import { config, hasRealZernioConfig, isPublicHttpUrl } from '../config.js';
import { fetchWithPolicy } from './http-client.js';
import { addAuditLog, addWorkflowLog, getApiLogs } from './api-logs.js';
import {
  publishInstagramImageViaBuffer,
  publishInstagramReelViaBuffer,
  publishYoutubeVideoViaBuffer,
  listBufferScheduledPostsForChannel
} from './buffer.js';
import { publishPinterestVideoViaZernio } from './zernio.js';
import { buildCaptionPlan } from './caption-engine.js';
import { ensureIntakeImageRenderable, getIntake, markIntakeProcessed } from './intake-store.js';
import { buildDistributionPlan, buildPinterestCaption } from './distribution-plan.js';
import { resolveIntakeRoute } from './intake-router.js';
import { publishInstagramCarouselViaGraph } from './instagram-graph.js';
import { chooseMusicTrack } from './music-library.js';
import { createShortLink } from './short-links.js';
import { renderReelFromImage } from './reel-renderer.js';
import { hostImageAsset, hostVideoAsset } from './media-hosting.js';
import { chooseScheduleSlot } from './schedule.js';
import { enqueueJob, getJobWorkerStatus, listJobs } from './jobs.js';
import { prepareEnhancedReelImage } from './image-enhancer.js';
import { sendWhatsAppNotification } from './whatsapp.js';

async function ensureLocalFile(filePath, remoteUrl) {
  if (!filePath) return;
  try {
    await fs.access(filePath);
  } catch {
    if (!remoteUrl || !isPublicHttpUrl(remoteUrl)) {
      throw new Error(`Local file at ${filePath} is missing, and no valid remote URL was provided.`);
    }

    console.log(`Downloading missing asset from ${remoteUrl} to ${filePath}...`);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const response = await fetchWithPolicy(remoteUrl);
    if (!response.ok) {
      throw new Error(`Failed to download missing asset from ${remoteUrl}: ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    await fs.writeFile(filePath, Buffer.from(arrayBuffer));
  }
}

function logWorkflow(meta, stage, summary, options = {}) {
  return addWorkflowLog({
    requestId: meta.requestId || null,
    jobKind: options.jobKind || meta.jobKind || 'process-whatsapp-intake',
    stage,
    status: options.status || 'running',
    summary,
    error: options.error || null,
    details: options.details || null
  });
}

function assertProcessingActive() {
  if (getJobWorkerStatus().paused) {
    throw new Error('Processing stopped by operator.');
  }
}

async function buildSchedulingJobPool(channelId) {
  const localJobs = listJobs(250);
  const merged = [...localJobs];

  if (!channelId) {
    return merged;
  }

  try {
    const bufferScheduled = await listBufferScheduledPostsForChannel(channelId);
    for (const post of bufferScheduled) {
      merged.push({
        kind: 'process-whatsapp-intake',
        status: 'scheduled',
        payload: {
          dueAt: post.dueAt
        },
        result: {
          published: {
            dueAt: post.dueAt
          }
        }
      });
    }
  } catch (error) {
    addWorkflowLog({
      requestId: null,
      jobKind: 'process-whatsapp-intake',
      stage: 'schedule_lookup',
      status: 'error',
      summary: 'Buffer schedule lookup failed; falling back to local queue data.',
      error: error instanceof Error ? error.message : String(error),
      details: {
        channelId
      }
    });
  }

  return merged;
}

async function prepareHostedImageSet(intake, meta, route) {
  const sourcePaths = Array.isArray(intake.imagePaths) && intake.imagePaths.length > 0
    ? intake.imagePaths
    : [intake.imagePath].filter(Boolean);
  const hostedImages = [];
  const enhancedImages = [];

  for (let index = 0; index < sourcePaths.length; index += 1) {
    const sourcePath = sourcePaths[index];
    logWorkflow(meta, 'image_enhancement', `Enhancing image ${index + 1} of ${sourcePaths.length} for publishing.`);
    const enhancedImage = await prepareEnhancedReelImage(sourcePath);
    enhancedImages.push(enhancedImage);
    const hostedImage = await hostImageAsset(enhancedImage.outputPath);
    hostedImages.push(hostedImage);
  }

  return {
    enhancedImages,
    hostedImages
  };
}

function resolveRequestedSchedule(input, schedulingPool) {
  if (input.publishNow) {
    return {
      dueAt: null,
      slotLabel: 'Immediate test publish',
      weekday: new Date().getDay(),
      weight: 120,
      cadencePerDay: 1,
      timezone: config.scheduler.timezone,
      reasoning: [
        'The operator selected immediate carousel publishing from the dashboard test upload.'
      ],
      researchSources: [],
      devotionalTheme: null
    };
  }

  if (input.dueAt) {
    const customDate = new Date(input.dueAt);
    if (Number.isNaN(customDate.getTime())) {
      throw new Error(`Invalid custom carousel schedule time: ${input.dueAt}`);
    }

    return {
      dueAt: customDate.toISOString(),
      slotLabel: 'Custom carousel test slot',
      weekday: customDate.getDay(),
      weight: 110,
      cadencePerDay: 1,
      timezone: config.scheduler.timezone,
      reasoning: [
        'The operator selected a custom carousel publish time from the dashboard test upload.'
      ],
      researchSources: [],
      devotionalTheme: null
    };
  }

  return chooseScheduleSlot(schedulingPool, new Date(), { profile: 'carousel' });
}

function getReusableHostedImages(intake) {
  return (Array.isArray(intake.hostedImages) ? intake.hostedImages : [])
    .filter((item) => item?.publicUrl)
    .map((item) => ({
      ...item,
      reused: true
    }));
}

async function ensureHostedCarouselImages(intake, meta) {
  const reusableHostedImages = getReusableHostedImages(intake);
  if (reusableHostedImages.length >= 2) {
    return reusableHostedImages;
  }

  const imagePaths = Array.isArray(intake.imagePaths) ? intake.imagePaths.filter(Boolean) : [];
  if (imagePaths.length < 2) {
    throw new Error('Carousel publishing requires at least two local image paths or hosted image URLs.');
  }

  logWorkflow(meta, 'image_hosting', 'Uploading carousel images to public hosting before the scheduled Graph publish.', {
    details: {
      imageCount: imagePaths.length
    }
  });

  const hostedImages = [];
  for (const imagePath of imagePaths) {
    hostedImages.push(await hostImageAsset(imagePath));
  }

  await markIntakeProcessed(intake.id, {
    hostedImages
  });
  return hostedImages;
}

async function scheduleCarouselGraphPublish(intake, input, meta) {
  const schedulingPool = await buildSchedulingJobPool(null);
  const scheduledSlot = resolveRequestedSchedule(input, schedulingPool);

  logWorkflow(meta, 'schedule_selection', 'Reserving the next 11 PM devotional carousel placeholder for the WhatsApp carousel zip.', {
    details: {
      dueAt: scheduledSlot.dueAt,
      devotionalTheme: scheduledSlot.devotionalTheme || null
    }
  });

  const hostedImages = await ensureHostedCarouselImages(intake, meta);
  logWorkflow(meta, 'pinterest_publish', 'Pinterest image posting is halted. Skipping Pinterest pins for carousel zip.', {
    details: { imageCount: hostedImages.length }
  });

  const holdUntil = input.publishNow ? null : new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const finalizeJob = await enqueueJob({
    kind: 'finalize-intake',
    payload: {
      intakeId: intake.id,
      channelId: null,
      alreadyPublishedPinterest: false
    },
    idempotencyKey: `finalize-intake:${intake.id}`,
    requestId: meta.requestId,
    createdBy: meta.user || 'whatsapp',
    runAt: holdUntil
  });

  const updated = await markIntakeProcessed(intake.id, {
    publishWarnings: [
      ...(intake.publishWarnings || []),
      'Pinterest image posting is halted. No Pinterest pins were created for this carousel.'
    ],
    hostedImages,
    status: 'holding',
    currentStage: 'holding',
    currentStageLabel: 'Waiting for operator review (10m hold)',
    scheduledFor: scheduledSlot.dueAt || null,
    schedule: scheduledSlot,
    captionPlan: {
      caption: intake.captionOverride || intake.body || '',
      source: 'zip_caption'
    },
    lastJobId: finalizeJob.id
  });

  return {
    ok: true,
    intake: updated,
    schedule: scheduledSlot,
    publishJob: finalizeJob
  };
}

function buildCarouselPublishNotification({ intake, published, schedule }) {
  const lines = [
    'Instagram carousel uploaded successfully.',
    `Intake: ${intake.id}`,
    `Slides: ${intake.carouselSize || (intake.imagePaths || []).length || 0}`,
    schedule?.devotionalTheme?.label ? `Theme slot: ${schedule.devotionalTheme.label}` : null,
    published?.permalink ? `Link: ${published.permalink}` : null,
    published?.mediaProductType ? `Type: ${published.mediaProductType}` : null
  ];

  return lines.filter(Boolean).join('\n');
}

export async function publishScheduledCarouselIntake(input, meta = {}) {
  const intake = getIntake(input.intakeId);
  if (!intake) {
    throw new Error(`Intake ${input.intakeId} was not found.`);
  }

  if (String(intake.status || '').toLowerCase() === 'published') {
    return {
      ok: true,
      skipped: true,
      reason: 'Carousel intake is already published.',
      intake,
      published: intake.published || null
    };
  }

  try {
    assertProcessingActive();
    const imagePaths = Array.isArray(intake.imagePaths) ? intake.imagePaths.filter(Boolean) : [];
    const reusableHostedImages = getReusableHostedImages(intake);
    if (imagePaths.length < 2 && reusableHostedImages.length < 2) {
      throw new Error('Scheduled carousel publish requires at least two extracted image paths or hosted image URLs.');
    }

    await markIntakeProcessed(intake.id, {
      status: 'publishing',
      currentStage: 'image_hosting',
      currentStageLabel: reusableHostedImages.length >= 2
        ? 'Reusing hosted carousel images for Graph publishing'
        : 'Uploading carousel images for Graph publishing',
      lastJobId: meta.jobId || null
    });

    const hostedImages = reusableHostedImages.length >= 2 ? reusableHostedImages : [];
    if (hostedImages.length < 2) {
      for (const imagePath of imagePaths) {
        hostedImages.push(await hostImageAsset(imagePath));
      }
    }

    assertProcessingActive();
    logWorkflow(meta, 'graph_publish', 'Publishing the scheduled carousel through the official Instagram Graph API.', {
      jobKind: 'publish-carousel-intake',
      details: {
        imageCount: hostedImages.length
      }
    });

    const published = await publishInstagramCarouselViaGraph({
      imageUrls: hostedImages.map((item) => item.publicUrl),
      caption: intake.captionOverride || intake.body || ''
    });

    const publishedTargets = [
      {
        platform: 'instagram',
        variant: 'carousel',
        published
      }
    ];
    // Pinterest image posting is halted.
    const publishWarnings = [
      'Pinterest image posting is halted. No Pinterest pins were created for this carousel.'
    ];

    const updated = await markIntakeProcessed(intake.id, {
      status: 'published',
      currentStage: 'completed',
      currentStageLabel: 'Carousel published',
      publishedAt: new Date().toISOString(),
      lastError: null,
      published: {
        ...published,
        dueAt: intake.scheduledFor || intake.schedule?.dueAt || null
      },
      publishedTargets,
      publishWarnings,
      hostedImages
    });

    const notification = buildCarouselPublishNotification({
      intake: updated || intake,
      published,
      schedule: intake.schedule || null
    });
    await sendWhatsAppNotification(notification).catch(() => null);

    logWorkflow(meta, 'completed', 'Scheduled carousel was published successfully.', {
      jobKind: 'publish-carousel-intake',
      status: 'success',
      details: {
        permalink: published.permalink || null
      }
    });

    return {
      ok: true,
      intake: updated,
      published
    };
  } catch (error) {
    await markIntakeProcessed(input.intakeId, {
      status: 'failed',
      currentStage: 'failed',
      currentStageLabel: 'Carousel publish failed',
      lastError: error instanceof Error ? error.message : String(error),
      lastJobId: meta.jobId || null
    });
    await sendWhatsAppNotification(
      `Instagram carousel upload failed.\nIntake: ${input.intakeId}\nError: ${error instanceof Error ? error.message : String(error)}`
    ).catch(() => null);
    throw error;
  }
}

export async function runWhatsAppIntakeOperation(input, meta = {}) {
  let intake = getIntake(input.intakeId);
  if (!intake) {
    throw new Error(`Intake ${input.intakeId} was not found.`);
  }

  if (intake.imagePath) {
    await ensureLocalFile(intake.imagePath, intake.imageUrl);
  }
  if (Array.isArray(intake.imagePaths)) {
    for (let i = 0; i < intake.imagePaths.length; i++) {
      const p = intake.imagePaths[i];
      const u = intake.imageUrls?.[i] || intake.files?.[i]?.imageUrl;
      if (p && u) {
        await ensureLocalFile(p, u);
      }
    }
  }

  const alreadyPublishedPinterest = Array.isArray(intake.publishedTargets)
    ? intake.publishedTargets.some((target) => target?.platform === 'pinterest')
    : false;

  try {
    if (intake.publishStrategy === 'graph_carousel') {
      assertProcessingActive();
      return scheduleCarouselGraphPublish(intake, input, meta);
    }

    assertProcessingActive();
    intake = await ensureIntakeImageRenderable(intake.id) || intake;
    assertProcessingActive();
    const route = resolveIntakeRoute(intake);

    intake = await markIntakeProcessed(intake.id, {
      status: 'processing',
      currentStage: 'processing',
      currentStageLabel: 'Preparing intake',
      lastJobId: meta.jobId || null,
      routingPlan: route
    }) || intake;

    logWorkflow(meta, 'routing', 'Resolving deterministic media route from the WhatsApp intake.', {
      details: {
        mediaKind: route.mediaKind,
        instagramFormat: route.instagramFormat,
        preserveSourceAudio: route.preserveSourceAudio,
        scheduleOverride: route.scheduleOverride?.dueAt || null
      }
    });

    logWorkflow(meta, 'caption_planning', 'Building caption, hashtag, and keyword plan from the WhatsApp intake.');
    const captionPlan = await buildCaptionPlan(intake);
    assertProcessingActive();
    intake = await markIntakeProcessed(intake.id, {
      currentStage: 'caption_planning',
      currentStageLabel: 'Caption generated',
      captionPlan,
      routingPlan: route
    }) || intake;

    let musicChoice = null;
    let reel = null;
    let hostedVideo = null;
    let hostedImage = null;
    let staticImage = null;
    let enhancedImage = null;
    let hostedImages = [];
    let enhancedImages = [];
    const publishedTargets = [];
    const publishWarnings = [];

    if (route.mediaKind === 'image') {
      logWorkflow(meta, 'image_enhancement', route.isCarousel
        ? 'Enhancing all carousel images for Instagram and Pinterest publishing.'
        : route.needsVideoDerivative
          ? 'Enhancing and upscaling the source image for post and reel outputs.'
          : 'Enhancing the source image for Instagram and Pinterest post publishing.');
      assertProcessingActive();
      intake = await markIntakeProcessed(intake.id, {
        currentStage: 'image_enhancement',
        currentStageLabel: 'Image prepared for upload',
        route
      }) || intake;
      intake = await markIntakeProcessed(intake.id, {
        currentStage: 'image_hosting',
        currentStageLabel: route.isCarousel ? 'Uploading carousel images to Cloudinary' : 'Uploading image to Cloudinary',
        route
      }) || intake;
      ({ enhancedImages, hostedImages } = await prepareHostedImageSet(intake, meta, route));
      enhancedImage = enhancedImages[0] || null;
      hostedImage = hostedImages[0] || null;
      staticImage = hostedImages[0] || null;
      assertProcessingActive();
      intake = await markIntakeProcessed(intake.id, {
        currentStage: 'image_hosting',
        currentStageLabel: route.isCarousel ? 'Carousel images uploaded to Cloudinary' : 'Image uploaded to Cloudinary',
        hostedImages,
        hostedImage: staticImage,
        route
      }) || intake;

      if (route.needsVideoDerivative) {
        logWorkflow(meta, 'music_selection', 'Choosing the best fixed-library Hindi track for the reel derivative.');
        musicChoice = await chooseMusicTrack({
          context: captionPlan.context,
          requestedText: intake.body || ''
        });
        assertProcessingActive();

        logWorkflow(meta, 'reel_render', 'Rendering the video derivative from the uploaded image and chosen music.', {
          details: {
            track: `${musicChoice.track.artist} - ${musicChoice.track.title}`
          }
        });
        reel = await renderReelFromImage({
          imagePath: intake.imagePath,
          preparedImagePath: enhancedImage.outputPath,
          audioPath: musicChoice.track.filePath,
          clipStartSeconds: musicChoice.preserveAudio ? 0 : musicChoice.track.clipStartSeconds,
          durationSeconds: config.music.defaultDurationSeconds,
          preserveAudio: Boolean(musicChoice.preserveAudio)
        });
        assertProcessingActive();
        intake = await markIntakeProcessed(intake.id, {
          currentStage: 'reel_render',
          currentStageLabel: 'Reel rendered locally',
          route,
          reel
        }) || intake;
        intake = await markIntakeProcessed(intake.id, {
          currentStage: 'reel_hosting',
          currentStageLabel: 'Uploading reel video to Cloudinary',
          route
        }) || intake;
        hostedVideo = await hostVideoAsset(reel.outputPath);
        assertProcessingActive();
        intake = await markIntakeProcessed(intake.id, {
          currentStage: 'reel_hosting',
          currentStageLabel: 'Reel uploaded to Cloudinary',
          hostedVideo,
          route
        }) || intake;
      }
    } else if (route.mediaKind === 'video') {
      logWorkflow(meta, 'video_hosting', 'Uploading the source MP4 without adding music or re-rendering it.');
      assertProcessingActive();
      intake = await markIntakeProcessed(intake.id, {
        currentStage: 'video_hosting',
        currentStageLabel: 'Uploading source MP4 to Cloudinary',
        route
      }) || intake;
      hostedVideo = await hostVideoAsset(intake.imagePath);
      assertProcessingActive();
      intake = await markIntakeProcessed(intake.id, {
        currentStage: 'video_hosting',
        currentStageLabel: 'Source MP4 uploaded to Cloudinary',
        hostedVideo,
        route
      }) || intake;
    } else {
      throw new Error(`Unsupported media kind: ${route.mediaKind || 'unknown'}`);
    }

    const resolvedInstagramChannelId = input.channelId || config.buffer.defaultChannelId || undefined;
    const distributionPlan = buildDistributionPlan({
      captionPlan,
      route,
      wallpaperLink: staticImage?.publicUrl || hostedVideo?.publicUrl || null,
      locationLabel: 'Kedarnath'
    });
    assertProcessingActive();

    const wallpaperShortLink = staticImage?.publicUrl
      ? await createShortLink(staticImage.publicUrl)
      : null;
    const wallpaperLink = wallpaperShortLink?.shortUrl || staticImage?.publicUrl || null;
    const schedulingPool = await buildSchedulingJobPool(resolvedInstagramChannelId);
    const scheduledSlot = route.scheduleOverride || chooseScheduleSlot(schedulingPool, new Date(), { profile: 'reel' });
    assertProcessingActive();

    intake = await markIntakeProcessed(intake.id, {
      currentStage: 'distribution_planning',
      currentStageLabel: 'SEO plan built',
      route,
      distributionPlan,
      musicChoice,
      reel,
      hostedVideo,
      hostedImages,
      hostedImage: staticImage,
      wallpaperLink,
      schedule: scheduledSlot
    }) || intake;

    const dueAt = scheduledSlot.dueAt;
    assertProcessingActive();

    const holdUntil = input.publishNow ? null : new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const finalizeJob = await enqueueJob({
      kind: 'finalize-intake',
      payload: {
        intakeId: intake.id,
        channelId: resolvedInstagramChannelId,
        alreadyPublishedPinterest
      },
      idempotencyKey: `finalize-intake:${intake.id}`,
      requestId: meta.requestId,
      createdBy: meta.user || 'whatsapp',
      runAt: holdUntil
    });

    const completedIntake = await markIntakeProcessed(intake.id, {
      status: 'holding',
      currentStage: 'holding',
      currentStageLabel: 'Waiting for operator review (10m hold)',
      scheduledFor: dueAt,
      lastJobId: finalizeJob.id
    });

    logWorkflow(meta, 'holding', 'WhatsApp intake is processed and holding for 10 minutes before publishing.', {
      status: 'success',
      details: { dueAt }
    });

    addAuditLog({
      category: 'job',
      action: 'process-whatsapp-intake',
      requestId: meta.requestId || null,
      user: meta.user || 'whatsapp',
      outcome: 'success',
      intakeId: intake.id
    });

    return {
      ok: true,
      intake: completedIntake,
      route,
      captionPlan,
      distributionPlan,
      musicChoice,
      reel,
      hostedVideo,
      hostedImage: staticImage,
      schedule: scheduledSlot,
      apiLogs: getApiLogs()
    };
  } catch (error) {
    await markIntakeProcessed(input.intakeId, {
      status: 'failed',
      currentStage: 'failed',
      currentStageLabel: 'Failed',
      lastError: error instanceof Error ? error.message : String(error),
      lastJobId: meta.jobId || null
    });
    throw error;
  }
}

export async function finalizeIntakeOperation(input, meta = {}) {
  const intake = getIntake(input.intakeId);
  if (!intake) throw new Error(`Intake ${input.intakeId} not found.`);
  
  const dueAt = intake.scheduledFor || intake.schedule?.dueAt;
  const route = intake.routingPlan || intake.route;
  
  if (intake.publishStrategy === 'graph_carousel') {
    const publishJob = await enqueueJob({
      kind: 'publish-carousel-intake',
      payload: { intakeId: intake.id },
      idempotencyKey: `publish-carousel:${intake.id}`,
      requestId: meta.requestId ? `${meta.requestId}:publish` : `publish:${intake.id}`,
      createdBy: meta.user || 'whatsapp',
      runAt: dueAt || null
    });
    
    await markIntakeProcessed(intake.id, {
      status: 'scheduled',
      currentStage: 'scheduled',
      currentStageLabel: dueAt ? 'Queued for carousel publish' : 'Queued for immediate carousel publish',
      lastJobId: publishJob.id
    });
    return { ok: true, intake: getIntake(intake.id) };
  }
  
  const distributionPlan = intake.distributionPlan;
  const hostedVideo = intake.hostedVideo;
  const staticImage = intake.hostedImage;
  const hostedImages = intake.hostedImages || [];
  const resolvedInstagramChannelId = input.channelId;
  const alreadyPublishedPinterest = input.alreadyPublishedPinterest;
  const publishedTargets = [];
  const publishWarnings = [];
  
  if (route.mediaKind === 'video') {
    const publishedInstagram = await publishInstagramReelViaBuffer({
      videoUrl: hostedVideo.publicUrl,
      caption: distributionPlan.instagram.caption,
      channelId: resolvedInstagramChannelId,
      dueAt,
      location: distributionPlan.instagram.location
    });
    publishedTargets.push({ platform: 'instagram', variant: 'reel', published: publishedInstagram });

    try {
      const publishedYoutube = await publishYoutubeVideoViaBuffer({
        videoUrl: hostedVideo.publicUrl,
        caption: distributionPlan.youtube.description,
        dueAt,
        title: distributionPlan.youtube.title
      });
      publishedTargets.push({ platform: 'youtube', variant: 'short', published: publishedYoutube });
    } catch (error) {
      publishWarnings.push(`YouTube publish skipped: ${error.message}`);
    }

    if (!alreadyPublishedPinterest && hasRealZernioConfig()) {
      try {
        const publishedPinterestVideo = await publishPinterestVideoViaZernio({
          videoUrl: hostedVideo.publicUrl,
          caption: distributionPlan.pinterest.description,
          accountId: config.zernio.accountId,
          boardId: config.zernio.pinterestBoardId || null,
          title: distributionPlan.pinterest.title,
          link: distributionPlan.pinterest.wallpaperLink || null
        });
        publishedTargets.push({ platform: 'pinterest', variant: 'video', published: publishedPinterestVideo });
      } catch (error) {
        publishWarnings.push(`Pinterest video publish skipped: ${error.message}`);
      }
    }
  } else {
    const igPublisher = route.instagramFormat === 'reel'
      ? () => publishInstagramReelViaBuffer({
          videoUrl: hostedVideo.publicUrl,
          caption: distributionPlan.instagram.caption,
          channelId: resolvedInstagramChannelId,
          dueAt,
          location: distributionPlan.instagram.location
        })
      : () => publishInstagramImageViaBuffer({
          imageUrl: staticImage.publicUrl,
          imageUrls: hostedImages.map((item) => item.publicUrl),
          caption: distributionPlan.instagram.caption,
          channelId: resolvedInstagramChannelId,
          dueAt,
          location: distributionPlan.instagram.location,
          publishingType: route.instagramPublishingType,
          musicReminder: 'Add music manually in Instagram before publishing.'
        });

    const publishedInstagram = await igPublisher();
    publishedTargets.push({ platform: 'instagram', variant: route.instagramFormat, published: publishedInstagram });

    if (route.needsVideoDerivative && hostedVideo) {
      try {
        const publishedYoutube = await publishYoutubeVideoViaBuffer({
          videoUrl: hostedVideo.publicUrl,
          caption: distributionPlan.youtube.description,
          dueAt,
          title: distributionPlan.youtube.title
        });
        publishedTargets.push({ platform: 'youtube', variant: 'short', published: publishedYoutube });
      } catch (error) {
        publishWarnings.push(`YouTube publish skipped: ${error.message}`);
      }
    }
  }

  const completedIntake = await markIntakeProcessed(intake.id, {
    status: 'scheduled',
    currentStage: 'completed',
    currentStageLabel: 'Queued in Buffer',
    bufferPostId: publishedTargets[0]?.published?.postId || null,
    publishedTargets,
    publishWarnings,
    published: publishedTargets[0]?.published || null
  });

  return { ok: true, intake: completedIntake };
}
