import { config } from '../src/config.js';
import { loadIntakes, listIntakes, markIntakeProcessed } from '../src/services/intake-store.js';
import { loadJobs } from '../src/services/jobs.js';
import { loadShortLinks, createShortLink } from '../src/services/short-links.js';
import { hostImageAsset } from '../src/services/media-hosting.js';
import { publishPinterestImageViaBuffer } from '../src/services/buffer.js';
import { hasRealZernioConfig } from '../src/config.js';
import { buildPinterestCaption as buildSharedPinterestCaption } from '../src/services/distribution-plan.js';

function toTimestamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function isCarouselIntake(intake) {
  return intake?.publishStrategy === 'graph_carousel' || intake?.sourceFormat === 'zip_carousel';
}

function hasPinterestTargets(intake) {
  return Array.isArray(intake?.publishedTargets)
    ? intake.publishedTargets.some((target) => target?.platform === 'pinterest')
    : false;
}

function normalizeTitleBase(intake) {
  return String(intake?.filename || intake?.body || 'Sanatan Dharma carousel')
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim()
    .slice(0, 90) || 'Sanatan Dharma carousel';
}

function buildPinterestCaption(intake, link) {
  const caption = buildSharedPinterestCaption({
    captionPlan: {
      caption: String(intake?.captionOverride || intake?.body || '').trim()
    },
    wallpaperLink: link,
    locationLabel: 'Kedarnath'
  });

  // Buffer/Zernio Pinterest captions error out above 500 characters; keep margin.
  return caption.length > 480 ? `${caption.slice(0, 477)}...` : caption;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function publishPinterestWithRetry(fn, { maxAttempts = 5, baseDelayMs = 1500 } = {}) {
  let attempt = 0;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      return await fn();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isRateLimited = /too many requests/i.test(message) || /rate limit/i.test(message) || /429/.test(message);
      if (!isRateLimited || attempt >= maxAttempts) {
        throw error;
      }
      const delay = baseDelayMs * attempt * attempt;
      await sleep(delay);
    }
  }
  throw new Error('publishPinterestWithRetry: exhausted attempts');
}

async function main() {
  const days = Number.parseInt(process.env.BACKFILL_DAYS || '7', 10);
  const force = ['1', 'true', 'yes'].includes(String(process.env.BACKFILL_FORCE || '').toLowerCase());
  const onlyIntakeId = String(process.env.BACKFILL_ONLY_INTAKE_ID || '').trim() || null;
  const onlyFilename = String(process.env.BACKFILL_ONLY_FILENAME || '').trim() || null;
  const maxImages = Number.parseInt(process.env.BACKFILL_MAX_IMAGES || '', 10);
  const startDelayMs = Number.parseInt(process.env.BACKFILL_START_DELAY_MS || '', 10);
  const rateLimitDelayMs = Number.parseInt(process.env.BACKFILL_RATE_LIMIT_DELAY_MS || '30000', 10);
  const sinceMs = Date.now() - (Number.isFinite(days) ? days : 7) * 24 * 60 * 60 * 1000;

  await loadJobs();
  await loadIntakes();
  await loadShortLinks().catch(() => {});

  const pinterestChannelId = null;
  if (!hasRealZernioConfig()) {
    throw new Error('Missing Zernio configuration. Set ZERNIO_API_KEY and ZERNIO_ACCOUNT_ID for Pinterest uploads.');
  }

  const candidates = listIntakes(500)
    .filter(isCarouselIntake)
    .filter((intake) => {
      const createdAt = toTimestamp(intake.createdAt);
      return createdAt && createdAt >= sinceMs;
    })
    .filter((intake) => {
      if (onlyIntakeId && String(intake.id) !== onlyIntakeId) return false;
      if (onlyFilename && String(intake.filename || '') !== onlyFilename) return false;
      return true;
    })
    .sort((a, b) => toTimestamp(a.createdAt) - toTimestamp(b.createdAt));

  console.log(JSON.stringify({
    ok: true,
    days,
    found: candidates.length
  }));

  if (Number.isFinite(startDelayMs) && startDelayMs > 0) {
    console.log(JSON.stringify({ ok: true, status: 'delaying_start', startDelayMs }));
    await sleep(startDelayMs);
  }

  let processed = 0;
  let skipped = 0;
  let failed = 0;

  for (const intake of candidates) {
    const alreadyPinned = hasPinterestTargets(intake);
    const attemptedButEmpty = Boolean(intake?.pinterestImmediatePublishedAt) && !alreadyPinned;
    if (alreadyPinned || (!force && attemptedButEmpty)) {
      skipped += 1;
      console.log(JSON.stringify({
        intakeId: intake.id,
        status: 'skipped',
        filename: intake.filename,
        reason: alreadyPinned ? 'already_pinned' : 'already_attempted'
      }));
      continue;
    }

    const imagePaths = Array.isArray(intake.imagePaths) ? intake.imagePaths.filter(Boolean) : [];
    if (!imagePaths.length) {
      failed += 1;
      console.log(JSON.stringify({ intakeId: intake.id, status: 'failed', error: 'Missing imagePaths.' }));
      continue;
    }

    const titleBase = normalizeTitleBase(intake);
    const hostedImages = [];
    const publishedTargets = [];
    const publishWarnings = [];

    try {
      console.log(JSON.stringify({
        intakeId: intake.id,
        status: 'starting',
        filename: intake.filename,
        images: imagePaths.length
      }));

      for (const imagePath of imagePaths) {
        console.log(JSON.stringify({
          intakeId: intake.id,
          status: 'hosting_image',
          imagePath
        }));
        hostedImages.push(await hostImageAsset(imagePath));
      }

      const link = hostedImages[0]?.publicUrl
        ? (await createShortLink(hostedImages[0].publicUrl).catch(() => null))?.shortUrl || hostedImages[0].publicUrl
        : null;
      const caption = buildPinterestCaption(intake, link);
      console.log(JSON.stringify({
        intakeId: intake.id,
        status: 'caption_ready',
        link,
        captionPreview: caption.slice(0, 140)
      }));

      const limit = Number.isFinite(maxImages) && maxImages > 0 ? Math.min(hostedImages.length, maxImages) : hostedImages.length;
      for (let index = 0; index < limit; index += 1) {
        try {
          console.log(JSON.stringify({
            intakeId: intake.id,
            status: 'publishing_pin',
            index: index + 1,
            total: limit,
            title: `${titleBase} ${index + 1}/${hostedImages.length}`
          }));
          const published = await publishPinterestWithRetry(() => publishPinterestImageViaBuffer({
            imageUrl: hostedImages[index].publicUrl,
            caption,
            channelId: pinterestChannelId,
            shareNow: true,
            dueAt: null,
            title: `${titleBase} ${index + 1}/${hostedImages.length}`,
            link
          }, {
            maxAttempts: 4,
            baseDelayMs: Number.isFinite(rateLimitDelayMs) && rateLimitDelayMs > 0 ? rateLimitDelayMs : 30000
          }));
          publishedTargets.push({ platform: 'pinterest', variant: 'image', published });
          console.log(JSON.stringify({
            intakeId: intake.id,
            status: 'published_pin',
            index: index + 1,
            postId: published?.post?.platformPostId || published?.postId || null,
            url: published?.post?.platformPostUrl || published?.permalink || null
          }));
          await sleep(1200);
        } catch (error) {
          const message = `Pinterest image ${index + 1} skipped: ${error instanceof Error ? error.message : String(error)}`;
          publishWarnings.push(message);
          console.log(JSON.stringify({
            intakeId: intake.id,
            status: 'pinterest_skipped',
            index: index + 1,
            error: error instanceof Error ? error.message : String(error)
          }));
          if (/429|too many requests|rate limit/i.test(message)) {
            console.log(JSON.stringify({
              intakeId: intake.id,
              status: 'intake_deferred',
              reason: 'rate_limited',
              resumeAfterMs: Number.isFinite(rateLimitDelayMs) && rateLimitDelayMs > 0 ? rateLimitDelayMs : 30000
            }));
            break;
          }
        }
      }

      // Only record a "published at" timestamp if at least 1 pin succeeded.
      const updatePatch = {
        pinterestImmediatePostIds: publishedTargets.map((t) => t?.published?.postId).filter(Boolean),
        publishedTargets: [...(intake.publishedTargets || []), ...publishedTargets],
        publishWarnings: [...(intake.publishWarnings || []), ...publishWarnings],
        hostedImages
      };
      if (publishedTargets.length > 0) {
        updatePatch.pinterestImmediatePublishedAt = new Date().toISOString();
      }

      await markIntakeProcessed(intake.id, updatePatch);

      processed += 1;
      console.log(JSON.stringify({
        intakeId: intake.id,
        createdAt: intake.createdAt,
        filename: intake.filename,
        images: hostedImages.length,
        pinterestPosts: publishedTargets.length,
        warnings: publishWarnings.length
      }));
    } catch (error) {
      failed += 1;
      console.log(JSON.stringify({
        intakeId: intake.id,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error)
      }));
    }
  }

  console.log(JSON.stringify({ ok: true, processed, skipped, failed }));
}

await main();
