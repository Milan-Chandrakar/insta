import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import sharp from 'sharp';

const ACCEPTED_IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const TARGET_RATIO = 9 / 16;
const RATIO_TOLERANCE = 0.0025;
const MAX_INSTAGRAM_API_CAROUSEL_ITEMS = 10;

function parseArgs(argv) {
  const args = {
    zip: '',
    caption: '',
    out: path.resolve(process.cwd(), 'standalone-carousel-pipeline', 'runs'),
    location: 'Kedarnath',
    requireMusicAutomation: true
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const next = argv[index + 1];
    if (token === '--zip' && next) {
      args.zip = path.resolve(next);
      index += 1;
    } else if (token === '--caption' && next) {
      args.caption = path.resolve(next);
      index += 1;
    } else if (token === '--out' && next) {
      args.out = path.resolve(next);
      index += 1;
    } else if (token === '--location' && next) {
      args.location = next;
      index += 1;
    } else if (token === '--allow-without-music-automation') {
      args.requireMusicAutomation = false;
    }
  }

  if (!args.zip || !args.caption) {
    throw new Error('Usage: node run-carousel-pipeline.mjs --zip <images.zip> --caption <caption.txt> [--out <dir>] [--location <name>] [--allow-without-music-automation]');
  }

  return args;
}

async function ensureFileExists(filePath, label) {
  try {
    await fs.access(filePath);
  } catch {
    throw new Error(`${label} was not found: ${filePath}`);
  }
}

async function readCaption(captionPath) {
  const caption = (await fs.readFile(captionPath, 'utf8')).trim();
  if (!caption) {
    throw new Error('Caption text file is empty.');
  }
  return caption;
}

async function extractZip(zipPath, destinationDir) {
  await fs.mkdir(destinationDir, { recursive: true });
  const escapedZip = zipPath.replace(/'/g, "''");
  const escapedDestination = destinationDir.replace(/'/g, "''");
  const result = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `Expand-Archive -LiteralPath '${escapedZip}' -DestinationPath '${escapedDestination}' -Force`
    ],
    {
      encoding: 'utf8'
    }
  );

  if (result.status !== 0) {
    throw new Error(result.stderr?.trim() || result.stdout?.trim() || 'Failed to extract zip archive.');
  }
}

async function collectFiles(rootDir) {
  const files = [];
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectFiles(fullPath));
    } else {
      files.push(fullPath);
    }
  }
  return files;
}

async function inspectImages(extractedDir) {
  const allFiles = await collectFiles(extractedDir);
  const images = allFiles
    .filter((filePath) => ACCEPTED_IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase()))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }));

  if (images.length < 2) {
    throw new Error('Carousel pipeline requires at least 2 images in the zip.');
  }

  const inspected = [];
  for (const imagePath of images) {
    const metadata = await sharp(imagePath).metadata();
    const width = metadata.width || 0;
    const height = metadata.height || 0;
    if (!width || !height) {
      throw new Error(`Could not read image dimensions for ${imagePath}`);
    }

    inspected.push({
      fileName: path.basename(imagePath),
      filePath: imagePath,
      width,
      height,
      ratio: width / height,
      sizeBytes: (await fs.stat(imagePath)).size
    });
  }

  return inspected;
}

function validateImages(images) {
  const issues = [];

  if (images.length > MAX_INSTAGRAM_API_CAROUSEL_ITEMS) {
    issues.push(`Instagram API carousel publishing supports up to ${MAX_INSTAGRAM_API_CAROUSEL_ITEMS} items; found ${images.length}.`);
  }

  const referenceWidth = images[0]?.width || 0;
  const referenceHeight = images[0]?.height || 0;

  for (const image of images) {
    const ratioDelta = Math.abs(image.ratio - TARGET_RATIO);
    if (ratioDelta > RATIO_TOLERANCE) {
      issues.push(`${image.fileName} is ${image.width}x${image.height}, not exact 9:16.`);
    }

    if (image.width !== referenceWidth || image.height !== referenceHeight) {
      issues.push(`${image.fileName} does not match the first image dimensions (${referenceWidth}x${referenceHeight}).`);
    }
  }

  return issues;
}

function buildResearchSummary() {
  return {
    instagramCarouselPublishing: 'Official Instagram Graph API supports carousel publishing, but only up to 10 items through third-party/API flows.',
    instagramCarouselMusic: 'Music for Instagram feed/carousel posts is handled in the in-app creation flow or Buffer notification publishing, not through automatic third-party publishing APIs.',
    instagramLocation: 'Location can be carried in automation payloads for automatic publishing, but notification publishing requires manual completion inside Instagram.',
    pinterestCarousel: 'Pinterest/Buffer does not expose a true carousel pin type; publishing is one image or one video per pin.'
  };
}

function buildBlockedResult({ zipPath, captionPath, location, caption, images, validationIssues, extractedDir, requireMusicAutomation }) {
  return {
    ok: false,
    status: 'blocked',
    blockedReason: requireMusicAutomation
      ? 'Instagram carousel music automation is not reliably supported by Buffer or the official Instagram publishing APIs.'
      : 'Validation failed for the submitted carousel package.',
    requirements: {
      requireMusicAutomation,
      location,
      exactNineBySixteen: true,
      uploadOriginalsWithoutCropping: true
    },
    inputs: {
      zipPath,
      captionPath
    },
    caption,
    imageCount: images.length,
    images,
    validationIssues,
    extractedDir,
    researchSummary: buildResearchSummary(),
    nextAction: requireMusicAutomation
      ? 'Do not post. Use manual Instagram mobile posting if native music on the carousel is mandatory.'
      : 'Fix validation issues and retry.'
  };
}

function buildPreparedResult({ zipPath, captionPath, location, caption, images, extractedDir }) {
  return {
    ok: true,
    status: 'prepared',
    publishMode: {
      instagram: 'notification_or_manual_required_for_music',
      pinterest: 'separate_image_pins_only',
      youtube: 'not_applicable_for_pure_image_carousel'
    },
    requirements: {
      location,
      exactNineBySixteen: true,
      uploadOriginalsWithoutCropping: true
    },
    inputs: {
      zipPath,
      captionPath
    },
    caption,
    imageCount: images.length,
    images,
    extractedDir,
    researchSummary: buildResearchSummary()
  };
}

async function writeResult(outDir, payload) {
  await fs.mkdir(outDir, { recursive: true });
  const resultPath = path.join(outDir, 'result.json');
  await fs.writeFile(resultPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return resultPath;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await ensureFileExists(args.zip, 'Zip file');
  await ensureFileExists(args.caption, 'Caption file');

  const caption = await readCaption(args.caption);
  const runId = `${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID()}`;
  const runDir = path.join(args.out, runId);
  const extractedDir = path.join(runDir, 'extracted');

  await extractZip(args.zip, extractedDir);
  const images = await inspectImages(extractedDir);
  const validationIssues = validateImages(images);

  const payload = args.requireMusicAutomation
    ? buildBlockedResult({
        zipPath: args.zip,
        captionPath: args.caption,
        location: args.location,
        caption,
        images,
        validationIssues,
        extractedDir,
        requireMusicAutomation: true
      })
    : validationIssues.length > 0
      ? buildBlockedResult({
          zipPath: args.zip,
          captionPath: args.caption,
          location: args.location,
          caption,
          images,
          validationIssues,
          extractedDir,
          requireMusicAutomation: false
        })
      : buildPreparedResult({
          zipPath: args.zip,
          captionPath: args.caption,
          location: args.location,
          caption,
          images,
          extractedDir
        });

  const resultPath = await writeResult(runDir, payload);
  console.log(JSON.stringify({
    status: payload.status,
    ok: payload.ok,
    resultPath
  }, null, 2));

  process.exit(payload.ok ? 0 : 2);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
