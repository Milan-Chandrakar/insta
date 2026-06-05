import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import AdmZip from 'adm-zip';
import sharp from 'sharp';

process.env.WHATSAPP_ENABLED = 'false';
process.env.DISABLE_REMOTE_CAPTIONING = 'true';
process.env.QUEUE_STORE_PROVIDER = 'local_json';
process.env.PUBLIC_BASE_URL = 'https://example.com';
process.env.CLOUDINARY_CLOUD_NAME = '';
process.env.CLOUDINARY_UPLOAD_PRESET = '';
const runId = `${Date.now()}-${process.pid}`;
process.env.SHORT_LINKS_FILE = path.join(os.tmpdir(), 'insta-automation-tests', runId, 'short-links.json');
process.env.MEDIA_ROOT_DIR = path.join(os.tmpdir(), 'insta-automation-tests', runId, 'media');
process.env.INTAKE_DIR = path.join(process.env.MEDIA_ROOT_DIR, 'intake');
process.env.ENHANCED_DIR = path.join(process.env.MEDIA_ROOT_DIR, 'enhanced');
process.env.REELS_DIR = path.join(process.env.MEDIA_ROOT_DIR, 'reels');
process.env.INTAKES_FILE = path.join(os.tmpdir(), 'insta-automation-tests', runId, 'intakes.json');
process.env.MUSIC_DIRECTORY = path.join(os.tmpdir(), 'insta-automation-tests', runId, 'music');
process.env.MUSIC_LIBRARY_FILE = path.join(os.tmpdir(), 'insta-automation-tests', runId, 'music-library.json');
process.env.SCHEDULER_SETTINGS_FILE = path.join(os.tmpdir(), 'insta-automation-tests', runId, 'scheduler-settings.json');
process.env.REEL_WIDTH = '360';
process.env.REEL_HEIGHT = '640';
process.env.REEL_VIDEO_BITRATE = '1000k';
process.env.REEL_AUDIO_BITRATE = '96k';
process.env.REEL_FPS = '15';

const {
  saveWhatsAppIntake,
  saveWhatsAppZipCarouselIntake,
  loadIntakes,
  listIntakes
} = await import('../src/services/intake-store.js');
const { buildCaptionPlan, __test__: captionTestHelpers } = await import('../src/services/caption-engine.js');
const { buildDistributionPlan } = await import('../src/services/distribution-plan.js');
const { resolveIntakeRoute } = await import('../src/services/intake-router.js');
const { createShortLink, loadShortLinks, getShortLink } = await import('../src/services/short-links.js');
const { __test__: bufferTestHelpers } = await import('../src/services/buffer.js');
const {
  getMusicLibraryStatus,
  chooseMusicTrack
} = await import('../src/services/music-library.js');
const { hostRenderedReel } = await import('../src/services/reel-hosting.js');
const { chooseScheduleSlot } = await import('../src/services/schedule.js');
const { renderReelFromImage } = await import('../src/services/reel-renderer.js');
const { prepareEnhancedReelImage } = await import('../src/services/image-enhancer.js');
const { __test__: whatsappTestHelpers } = await import('../src/services/whatsapp.js');
const { isWithinPublishingWindow, getPublishingWindowStatus } = await import('../src/services/publishing-windows.js');
const { loadSchedulerState, getSchedulerState, setSchedulerExecutionMode } = await import('../src/services/scheduler-state.js');

const tempRoot = path.join(os.tmpdir(), 'insta-automation-tests', runId);
async function resetTempRoot() {
  await fs.rm(tempRoot, { recursive: true, force: true });
  await fs.mkdir(tempRoot, { recursive: true });
}

async function createSamplePng(filePath, width = 4, height = 4) {
  const channels = 3;
  const pixels = Buffer.alloc(width * height * channels);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * channels;
      const border = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      pixels[offset] = border ? 255 : 30;
      pixels[offset + 1] = border ? 215 : 60;
      pixels[offset + 2] = border ? 0 : 120;
    }
  }

  await sharp(pixels, {
    raw: {
      width,
      height,
      channels
    }
  })
    .png()
    .toFile(filePath);
}

async function createSilentWav(filePath, durationSeconds = 6, sampleRate = 44100) {
  const channelCount = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const totalSamples = durationSeconds * sampleRate;
  const dataSize = totalSamples * channelCount * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channelCount, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channelCount * bytesPerSample, 28);
  buffer.writeUInt16LE(channelCount * bytesPerSample, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  await fs.writeFile(filePath, buffer);
}

async function createNineBySixteenPngBuffer() {
  return sharp({
    create: {
      width: 90,
      height: 160,
      channels: 3,
      background: {
        r: 240,
        g: 200,
        b: 80
      }
    }
  }).png().toBuffer();
}

async function testSaveWhatsAppIntake() {
  await resetTempRoot();
  await loadIntakes();

  const intake = await saveWhatsAppIntake({
    messageId: 'abc123',
    chatId: 'me@c.us',
    chatName: 'You',
    fromMe: true,
    body: 'Cool Krishna sakhi wallpaper',
    filename: 'cool-krishna-sakhi.png',
    mimeType: 'image/png',
    imageBuffer: await sharp({
      create: {
        width: 4,
        height: 4,
        channels: 3,
        background: {
          r: 255,
          g: 215,
          b: 0
        }
      }
    }).png().toBuffer()
  });

  assert.equal(intake.source, 'whatsapp');
  assert.equal(intake.chatName, 'You');
  assert.ok(intake.imagePath.endsWith('.png'));
  assert.ok(intake.imageUrl.startsWith('https://example.com/media/intake/'));
  assert.equal(listIntakes().length, 1);
}

async function testSaveWhatsAppZipCarouselIntake() {
  await resetTempRoot();
  await loadIntakes();

  const zip = new AdmZip();
  zip.addFile('caption.txt', Buffer.from('Jai Shri Ram\n\n#sanatandharma #ramnavami', 'utf8'));
  zip.addFile('01.png', await createNineBySixteenPngBuffer());
  zip.addFile('02.png', await createNineBySixteenPngBuffer());

  const intake = await saveWhatsAppZipCarouselIntake({
    messageId: 'zip-123',
    chatId: 'group@g.us',
    chatName: 'Insta Automation',
    fromMe: false,
    body: 'Ram Navami carousel package',
    filename: 'ram-navami.zip',
    mimeType: 'application/zip',
    zipBuffer: zip.toBuffer()
  });

  assert.equal(intake.publishStrategy, 'graph_carousel');
  assert.equal(intake.sourceFormat, 'zip_carousel');
  assert.equal(intake.isCarousel, true);
  assert.equal(intake.carouselSize, 2);
  assert.equal(intake.captionOverride.includes('Jai Shri Ram'), true);
  assert.equal(intake.captionFileName, 'caption.txt');
  assert.equal(intake.imagePaths.length, 2);
}

async function testSaveWhatsAppZipCarouselIntakeAcceptsAnyTextCaption() {
  await resetTempRoot();
  await loadIntakes();

  const zip = new AdmZip();
  zip.addFile('ram-navami-caption.txt', Buffer.from('Maryada Purushottam Ram\n\n#sanatandharma', 'utf8'));
  zip.addFile('01.png', await createNineBySixteenPngBuffer());
  zip.addFile('02.png', await createNineBySixteenPngBuffer());

  const intake = await saveWhatsAppZipCarouselIntake({
    messageId: 'zip-any-txt-123',
    chatId: 'group@g.us',
    chatName: 'Insta Automation',
    fromMe: false,
    body: '',
    filename: 'ram-navami.zip',
    mimeType: 'application/zip',
    zipBuffer: zip.toBuffer()
  });

  assert.equal(intake.captionFileName, 'ram-navami-caption.txt');
  assert.equal(intake.captionOverride.includes('Maryada Purushottam Ram'), true);
  assert.equal(intake.carouselSize, 2);
}

async function testCaptionPlan() {
  await resetTempRoot();
  await loadIntakes();
  const intake = await saveWhatsAppIntake({
    messageId: 'caption-123',
    chatId: 'me@c.us',
    chatName: 'You',
    fromMe: true,
    body: 'Cool Krishna sakhi wallpaper',
    filename: 'cool-krishna-sakhi.png',
    mimeType: 'image/png',
    imageBuffer: await sharp({
      create: {
        width: 4,
        height: 4,
        channels: 3,
        background: {
          r: 255,
          g: 215,
          b: 0
        }
      }
    }).png().toBuffer()
  });
  const plan = await buildCaptionPlan(intake);

  assert.ok(plan.caption.length > 40);
  assert.ok(plan.caption.includes('follow'));
  assert.ok(plan.hashtags.some((tag) => tag.includes('krishna')));
  assert.equal(plan.context.deity, 'krishna');
  assert.equal(plan.hashtags.length, 5);
  assert.equal(plan.mode, 'image_reference');
  assert.equal(plan.captionStrategy, 'devotional_emotion + image_reference');
  assert.equal(plan.captionLines.length, 4);
  assert.ok(plan.provider);
  assert.equal(plan.provider.type, 'rule-template');
}

async function testIntakeRouter() {
  const reelRoute = resolveIntakeRoute({
    mimeType: 'video/mp4',
    filename: 'demo.mp4',
    body: 'post this reel today at 6 pm'
  });
  assert.equal(reelRoute.mediaKind, 'video');
  assert.equal(reelRoute.instagramFormat, 'reel');
  assert.equal(reelRoute.preserveSourceAudio, true);
  assert.equal(reelRoute.fanout.instagram, 'reel');
  assert.equal(reelRoute.fanout.youtube, 'video');
  assert.deepEqual(reelRoute.fanout.pinterest, ['video']);

  const imageRoute = resolveIntakeRoute({
    mimeType: 'image/png',
    filename: 'wallpaper.png',
    body: 'make this into a reel/video'
  });
  assert.equal(imageRoute.mediaKind, 'image');
  assert.equal(imageRoute.instagramFormat, 'reel');
  assert.deepEqual(imageRoute.fanout.pinterest, ['image']);

  const postRoute = resolveIntakeRoute({
    mimeType: 'image/jpeg',
    filename: 'post.jpg',
    body: 'post only, caption later'
  });
  assert.equal(postRoute.mediaKind, 'image');
  assert.equal(postRoute.instagramFormat, 'post');
  assert.equal(postRoute.instagramPublishingType, 'notification');
  assert.equal(postRoute.fanout.youtube, null);
}

async function testDistributionPlanAndShortLinks() {
  await loadShortLinks();
  const shortLink = await createShortLink('https://example.com/wallpaper-pack');
  assert.equal(shortLink.provider, 'internal');
  assert.ok(shortLink.shortUrl.startsWith('https://example.com/l/'));
  assert.equal(getShortLink(shortLink.code).targetUrl, 'https://example.com/wallpaper-pack');

  const plan = buildDistributionPlan({
    captionPlan: {
      caption: 'Line one\n\nLine two',
      captionLines: ['Line one', 'Line two'],
      hashtags: ['sanatandharma', 'krishnaji', 'toonart', 'bhakti', 'healing'],
      seoKeywords: ['krishna art', 'radha krishna reel'],
      titleHint: 'Krishna soft reel',
      hook: 'UNKI MUSKAAN MEIN BAS SUKOON HAI.'
    },
    route: {
      mediaKind: 'image',
      instagramFormat: 'post',
      preserveSourceAudio: false
    },
    wallpaperLink: shortLink.shortUrl,
    locationLabel: 'Kedarnath'
  });

  assert.equal(plan.instagram.location, 'Kedarnath');
  assert.equal(plan.instagram.callToAction, '✅ Link in bio for full 4K wallpaper pack');
  assert.equal(plan.youtube.type, 'video');
  assert.equal(plan.youtube.location, null);
  assert.equal(plan.pinterest.location, 'Kedarnath');
}

async function testMusicLibraryAndSelection() {
  const musicDir = process.env.MUSIC_DIRECTORY;
  await fs.mkdir(musicDir, { recursive: true });
  await fs.writeFile(path.join(musicDir, 'sachet-parampara-ram-siya-ram.mp3'), 'placeholder');
  await fs.writeFile(process.env.MUSIC_LIBRARY_FILE, JSON.stringify([
    {
      id: 'ram-siya-ram',
      title: 'Ram Siya Ram',
      artist: 'Sachet-Parampara',
      filename: 'sachet-parampara-ram-siya-ram.mp3',
      moods: ['devotional', 'divine'],
      deityTags: ['rama'],
      themeTags: ['surrender', 'peace'],
      clipStartSeconds: 15,
      reelDurationSeconds: 11
    }
  ], null, 2));

  const status = await getMusicLibraryStatus();
  assert.equal(status.configuredTracks, 1);
  assert.equal(status.availableTracks, 1);

  const chosen = await chooseMusicTrack({
    context: {
      deity: 'rama',
      theme: 'surrender'
    }
  });
  assert.equal(chosen.track.id, 'ram-siya-ram');
}

async function testScheduler() {
  const slot = chooseScheduleSlot([], new Date('2026-04-29T08:00:00+05:30'), { profile: 'carousel' });
  const reelSlot = chooseScheduleSlot([], new Date('2026-04-29T08:00:00+05:30'), { profile: 'reel' });

  assert.ok(slot.dueAt);
  assert.ok(Array.isArray(slot.reasoning));
  assert.ok(slot.reasoning.length >= 2);
  const hour = new Date(slot.dueAt).getHours();
  assert.equal(hour, 23);
  assert.equal(slot.profile, 'carousel');
  assert.ok(slot.devotionalTheme);
  assert.equal(new Date(reelSlot.dueAt).getHours(), 14);
  assert.equal(reelSlot.profile, 'reel');
}

async function testPublishingWindows() {
  assert.equal(isWithinPublishingWindow(new Date('2026-06-03T17:45:00Z')), true);
  assert.equal(isWithinPublishingWindow(new Date('2026-06-03T19:30:00Z')), false);
  assert.equal(isWithinPublishingWindow(new Date('2026-06-03T21:00:00Z')), true);
  const status = getPublishingWindowStatus(new Date('2026-06-03T21:00:00Z'));
  assert.equal(status.withinWindow, true);
  assert.ok(status.activeWindow);
}

async function testSchedulerState() {
  await loadSchedulerState();
  assert.equal(getSchedulerState().executionMode, 'local_worker');
  const next = await setSchedulerExecutionMode('github_actions_window');
  assert.equal(next.executionMode, 'github_actions_window');
  assert.ok(next.queueCutoffAt);
  assert.equal(getSchedulerState().executionMode, 'github_actions_window');
  assert.ok(getSchedulerState().queueCutoffAt);
  await setSchedulerExecutionMode('local_worker');
  assert.equal(getSchedulerState().queueCutoffAt, null);
}

async function testWhatsappZipScheduleCommands() {
  const nowCommand = whatsappTestHelpers.parseZipScheduleCommand('publish now');
  assert.equal(nowCommand.mode, 'now');
  assert.equal(nowCommand.publishNow, true);

  const autoCommand = whatsappTestHelpers.parseZipScheduleCommand('auto overnight');
  assert.equal(autoCommand.mode, 'auto');
  assert.equal(autoCommand.publishNow, false);
  assert.equal(autoCommand.dueAt, null);

  const customCommand = whatsappTestHelpers.parseZipScheduleCommand('post tomorrow at 2:30 am');
  assert.equal(customCommand.mode, 'custom');
  assert.ok(customCommand.dueAt);
}

async function testReelRenderer() {
  const inputImage = path.join(tempRoot, 'sample.png');
  const inputAudio = path.join(tempRoot, 'sample.wav');
  await createSamplePng(inputImage);
  await createSilentWav(inputAudio, 6);

  try {
    const result = await renderReelFromImage({
      imagePath: inputImage,
      audioPath: inputAudio,
      clipStartSeconds: 0,
      durationSeconds: 6
    });

    const stat = await fs.stat(result.outputPath);
    assert.ok(stat.size > 0);
    assert.equal(result.durationSeconds, 6);
    assert.ok(result.outputUrl.startsWith('https://example.com/media/reels/'));
    assert.ok(result.preparedImagePath);
  } catch (error) {
    if (error?.code === 'EPERM' || String(error?.message || '').includes('spawn EPERM')) {
      console.log('SKIP reelRenderer (ffmpeg spawn blocked in this environment)');
      return;
    }

    throw error;
  }
}

async function testImageEnhancer() {
  const inputImage = path.join(tempRoot, 'enhancer.png');
  await createSamplePng(inputImage);

  const result = await prepareEnhancedReelImage(inputImage);
  const stat = await fs.stat(result.outputPath);

  assert.ok(stat.size > 0);
  assert.equal(result.width, 1440);
  assert.equal(result.height, 2560);
}

async function testReelHostingFallback() {
  await fs.mkdir(process.env.REELS_DIR, { recursive: true });
  const localFile = path.join(process.env.REELS_DIR, 'host-me.mp4');
  await fs.writeFile(localFile, Buffer.from('fake-video'));
  const hosted = await hostRenderedReel(localFile);

  assert.equal(hosted.provider, 'local_public_url');
  assert.ok(hosted.publicUrl.startsWith('https://example.com/media/'));
}

async function testBufferAssetsSchemaUsesOrderedAssetArray() {
  const block = bufferTestHelpers.buildAssetsBlock({
    imageUrls: ['https://example.com/post.jpg'],
    videoUrls: ['https://example.com/reel.mp4']
  }).join('\n');

  assert.ok(block.includes('assets: ['));
  assert.ok(block.includes('{ image: { url: "https://example.com/post.jpg" } }'));
  assert.ok(block.includes('{ video: { url: "https://example.com/reel.mp4" } }'));
  assert.equal(block.includes('images: ['), false);
  assert.equal(block.includes('videos: ['), false);
}

async function testQuotedWhatsappTextIsForcedIntoCaption() {
  const caption = captionTestHelpers.ensureQuotedCaptionSegments(
    'Jai Hanuman\n\nfollow @sanatan.dharma.ai for more 🤍\n\n#sanatandharma #hanumanji',
    'Use this exact line in caption: “Sakal hans me rame viraje, Ram bina koi dhame nahi ..”'
  );

  assert.ok(caption.includes('“Sakal hans me rame viraje, Ram bina koi dhame nahi ..”'));
}

async function main() {
  const tests = [
    ['saveWhatsAppIntake', testSaveWhatsAppIntake],
    ['saveWhatsAppZipCarouselIntake', testSaveWhatsAppZipCarouselIntake],
    ['saveWhatsAppZipCarouselIntakeAcceptsAnyTextCaption', testSaveWhatsAppZipCarouselIntakeAcceptsAnyTextCaption],
    ['captionPlan', testCaptionPlan],
    ['intakeRouter', testIntakeRouter],
    ['distributionPlanAndShortLinks', testDistributionPlanAndShortLinks],
    ['musicLibraryAndSelection', testMusicLibraryAndSelection],
    ['scheduler', testScheduler],
    ['publishingWindows', testPublishingWindows],
    ['schedulerState', testSchedulerState],
    ['whatsappZipScheduleCommands', testWhatsappZipScheduleCommands],
    ['imageEnhancer', testImageEnhancer],
    ['reelRenderer', testReelRenderer],
    ['reelHostingFallback', testReelHostingFallback],
    ['bufferAssetsSchemaUsesOrderedAssetArray', testBufferAssetsSchemaUsesOrderedAssetArray],
    ['quotedWhatsappTextIsForcedIntoCaption', testQuotedWhatsappTextIsForcedIntoCaption]
  ];

  for (const [name, fn] of tests) {
    await fn();
    console.log(`PASS ${name}`);
  }

  console.log('All tests passed');
}

main().catch((error) => {
  console.error('Test failure:', error);
  process.exit(1);
});
