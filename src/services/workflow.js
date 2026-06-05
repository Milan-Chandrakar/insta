import fs from 'node:fs/promises';
import path from 'node:path';
import { config, isPublicHttpUrl } from '../config.js';
import { fetchWithPolicy } from './http-client.js';
import { addAuditLog, addWorkflowLog, getApiLogs } from './api-logs.js';
import {
  publishInstagramImageViaBuffer,
  publishInstagramReelViaBuffer,
  publishPinterestImageViaBuffer,
  publishYoutubeVideoViaBuffer,
  listBufferScheduledPostsForChannel
} from './buffer.js';
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

  // Pinterest pins should never be scheduled/queued. Publish them immediately once the zip is ingested,
  // but keep Instagram carousel publishing on the normal schedule.
  const hostedImages = await ensureHostedCarouselImages(intake, meta);
  const existingPinterestTargets = Array.isArray(intake.publishedTargets)
    ? intake.publishedTargets.filter((target) => target?.platform === 'pinterest')
    : [];
  const shouldPublishPinterestNow = existingPinterestTargets.length === 0 && !intake.pinterestImmediatePublishedAt;
  if (shouldPublishPinterestNow) {
    const pinterestTargets = [];
    const pinterestWarnings = [];

    if (hostedImages.length >= 1) {
      try {
        logWorkflow(meta, 'pinterest_publish', 'Publishing Pinterest pins immediately for the carousel zip (shareNow).', {
          details: { imageCount: hostedImages.length }
        });

        const pinterestLink = hostedImages[0]?.publicUrl
          ? (await createShortLink(hostedImages[0].publicUrl).catch(() => null))?.shortUrl || hostedImages[0].publicUrl
          : null;
        const pinterestCaption = buildPinterestCaption({
          captionPlan: {
            caption: intake.captionOverride || intake.body || ''
          },
          wallpaperLink: pinterestLink,
          locationLabel: 'Kedarnath'
        });
        const pinterestTitleBase = String(intake.filename || intake.body || 'Sanatan Dharma carousel')
          .replace(/\.[a-z0-9]+$/i, '')
          .replace(/[_-]+/g, ' ')
          .trim()
          .slice(0, 90) || 'Sanatan Dharma carousel';

        for (let index = 0; index < hostedImages.length; index += 1) {
          try {
            const publishedPinterestImage = await publishPinterestImageViaBuffer({
              imageUrl: hostedImages[index].publicUrl,
              caption: pinterestCaption,
              shareNow: true,
              dueAt: null,
              title: `${pinterestTitleBase} ${index + 1}/${hostedImages.length}`,
              link: pinterestLink
            });
            pinterestTargets.push({ platform: 'pinterest', variant: 'image', published: publishedPinterestImage });
          } catch (error) {
            pinterestWarnings.push(
              `Pinterest image ${index + 1} skipped: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }

        await markIntakeProcessed(intake.id, {
          pinterestImmediatePublishedAt: new Date().toISOString(),
          pinterestImmediatePostIds: pinterestTargets.map((target) => target?.published?.postId).filter(Boolean),
          publishedTargets: [...(intake.publishedTargets || []), ...pinterestTargets],
          publishWarnings: [...(intake.publishWarnings || []), ...pinterestWarnings],
          hostedImages
        });
      } catch (error) {
        await markIntakeProcessed(intake.id, {
          publishWarnings: [
            ...(intake.publishWarnings || []),
            `Pinterest immediate publish skipped: ${error instanceof Error ? error.message : String(error)}`
          ]
        });
      }
    }
  }

  const publishJob = await enqueueJob({
    kind: 'publish-carousel-intake',
    payload: {
      intakeId: intake.id
    },
    idempotencyKey: `publish-carousel:${intake.id}`,
    requestId: meta.requestId ? `${meta.requestId}:publish` : `publish:${intake.id}`,
    createdBy: meta.user || 'whatsapp',
    runAt: scheduledSlot.dueAt || null
  });

  const updated = await markIntakeProcessed(intake.id, {
    status: 'scheduled',
    currentStage: 'scheduled',
    currentStageLabel: scheduledSlot.dueAt ? 'Queued for carousel publish' : 'Queued for immediate carousel publish',
    scheduledFor: scheduledSlot.dueAt || null,
    schedule: scheduledSlot,
    captionPlan: {
      caption: intake.captionOverride || intake.body || '',
      source: 'zip_caption'
    },
    lastJobId: publishJob.id
  });

  return {
    ok: true,
    intake: updated,
    schedule: scheduledSlot,
    publishJob
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
    const publishWarnings = [];
    const pinterestLink = hostedImages[0]?.publicUrl
      ? (await createShortLink(hostedImages[0].publicUrl).catch(() => null))?.shortUrl || hostedImages[0].publicUrl
      : null;
    const pinterestCaption = buildPinterestCaption({
      captionPlan: {
        caption: intake.captionOverride || intake.body || ''
      },
      wallpaperLink: pinterestLink,
      locationLabel: 'Kedarnath'
    });
    const pinterestTitleBase = String(intake.filename || intake.body || 'Sanatan Dharma carousel')
      .replace(/\.[a-z0-9]+$/i, '')
      .replace(/[_-]+/g, ' ')
      .trim()
      .slice(0, 90) || 'Sanatan Dharma carousel';

    for (let index = 0; index < hostedImages.length; index += 1) {
      try {
        assertProcessingActive();
        const publishedPinterestImage = await publishPinterestImageViaBuffer({
          imageUrl: hostedImages[index].publicUrl,
          caption: pinterestCaption,
          shareNow: true,
          title: `${pinterestTitleBase} ${index + 1}/${hostedImages.length}`,
          link: pinterestLink
        });
        publishedTargets.push({ platform: 'pinterest', variant: 'image', published: publishedPinterestImage });
      } catch (error) {
        publishWarnings.push(`Pinterest image ${index + 1} skipped: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

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

    if (route.mediaKind === 'video') {
      logWorkflow(meta, 'buffer_publish', 'Publishing the source MP4 as an Instagram reel and cross-posting the same video to YouTube Shorts and Pinterest.');
      const publishedInstagram = await publishInstagramReelViaBuffer({
        videoUrl: hostedVideo.publicUrl,
        caption: distributionPlan.instagram.caption,
        channelId: resolvedInstagramChannelId,
        dueAt,
        location: distributionPlan.instagram.location
      });
      publishedTargets.push({ platform: 'instagram', variant: 'reel', published: publishedInstagram });

      try {
        assertProcessingActive();
        const publishedYoutube = await publishYoutubeVideoViaBuffer({
          videoUrl: hostedVideo.publicUrl,
          caption: distributionPlan.youtube.description,
          dueAt,
          title: distributionPlan.youtube.title
        });
        publishedTargets.push({ platform: 'youtube', variant: 'short', published: publishedYoutube });
      } catch (error) {
        publishWarnings.push(`YouTube publish skipped: ${error instanceof Error ? error.message : String(error)}`);
      }

      publishWarnings.push('Pinterest video publish skipped: Buffer GraphQL is rejecting Pinterest video pins in this integration path and requires an image asset.');
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

      logWorkflow(meta, 'buffer_publish', route.needsVideoDerivative
        ? `Publishing the Instagram ${route.instagramFormat} and the rendered video derivative to YouTube and Pinterest.`
        : route.isCarousel
          ? 'Publishing the Instagram carousel as a notification post and creating Pinterest image pins from the same images.'
          : 'Publishing the Instagram image post as a notification post and creating a matching Pinterest image pin.');
      assertProcessingActive();
      const publishedInstagram = await igPublisher();
      publishedTargets.push({ platform: 'instagram', variant: route.instagramFormat, published: publishedInstagram });
      assertProcessingActive();

      if (route.needsVideoDerivative && hostedVideo) {
        try {
          assertProcessingActive();
          const publishedYoutube = await publishYoutubeVideoViaBuffer({
            videoUrl: hostedVideo.publicUrl,
            caption: distributionPlan.youtube.description,
            dueAt,
            title: distributionPlan.youtube.title
          });
          publishedTargets.push({ platform: 'youtube', variant: 'short', published: publishedYoutube });
        } catch (error) {
          publishWarnings.push(`YouTube publish skipped: ${error instanceof Error ? error.message : String(error)}`);
        }

        publishWarnings.push('Pinterest video publish skipped: Buffer GraphQL is rejecting Pinterest video pins in this integration path and requires an image asset.');
      } else if (!route.isCarousel) {
        publishWarnings.push('Pure image post: YouTube was skipped because this intake was not routed as a reel/video.');
      }

      if (route.isCarousel) {
        for (let index = 0; index < hostedImages.length; index += 1) {
          try {
            assertProcessingActive();
            if (alreadyPublishedPinterest) {
              continue;
            }
            const publishedPinterestImage = await publishPinterestImageViaBuffer({
              imageUrl: hostedImages[index].publicUrl,
              caption: distributionPlan.pinterest.description,
              shareNow: true,
              dueAt: null,
              title: `${distributionPlan.pinterest.title} ${index + 1}/${hostedImages.length}`,
              link: distributionPlan.pinterest.wallpaperLink
            });
            publishedTargets.push({ platform: 'pinterest', variant: 'image', published: publishedPinterestImage });
          } catch (error) {
            publishWarnings.push(`Pinterest image ${index + 1} skipped: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      } else {
        try {
          assertProcessingActive();
          if (alreadyPublishedPinterest) {
            throw new Error('Pinterest dedupe: intake already has a Pinterest publish target.');
          }
          const publishedPinterestImage = await publishPinterestImageViaBuffer({
            imageUrl: staticImage.publicUrl,
            caption: distributionPlan.pinterest.description,
            shareNow: true,
            dueAt: null,
            title: distributionPlan.pinterest.title,
            link: distributionPlan.pinterest.wallpaperLink
          });
          publishedTargets.push({ platform: 'pinterest', variant: 'image', published: publishedPinterestImage });
        } catch (error) {
          publishWarnings.push(`Pinterest image publish skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    if (publishedTargets.length === 0) {
      throw new Error('No publishing targets were successfully processed.');
    }

    const completedIntake = await markIntakeProcessed(intake.id, {
      status: 'scheduled',
      currentStage: 'completed',
      currentStageLabel: 'Queued in Buffer',
      scheduledFor: dueAt,
      bufferPostId: publishedTargets[0]?.published?.postId || null,
      reelUrl: hostedVideo?.publicUrl || null,
      reelHostingProvider: hostedVideo?.provider || null,
      publishedTargets,
      publishWarnings,
      published: publishedTargets[0]?.published || null
    });

    logWorkflow(meta, 'completed', 'WhatsApp intake was rendered and scheduled successfully.', {
      status: 'success',
      details: {
        postId: publishedTargets[0]?.published?.postId || null,
        dueAt,
        publishedTargets: publishedTargets.map((target) => target.platform)
      }
    });

    addAuditLog({
      category: 'job',
      action: 'process-whatsapp-intake',
      requestId: meta.requestId || null,
      user: meta.user || 'whatsapp',
      outcome: 'success',
      intakeId: intake.id,
      postId: publishedTargets[0]?.published?.postId || null
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
      publishedTargets,
      publishWarnings,
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
