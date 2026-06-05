import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { config } from '../config.js';

async function ensureEnhancedDirectory() {
  await fs.mkdir(config.media.enhancedDir, { recursive: true });
}

function buildBackdrop(width, height) {
  return {
    create: {
      width,
      height,
      channels: 3,
      background: {
        r: 247,
        g: 241,
        b: 233
      }
    }
  };
}

export async function prepareEnhancedReelImage(sourceImagePath) {
  await ensureEnhancedDirectory();

  const outputName = `${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID()}.jpg`;
  const outputPath = path.join(config.media.enhancedDir, outputName);
  const canvasWidth = config.imageEnhancement.canvasWidth;
  const canvasHeight = config.imageEnhancement.canvasHeight;

  const baseImage = sharp(sourceImagePath, { failOn: 'none' }).rotate();
  const metadata = await baseImage.metadata();
  const sourceWidth = metadata.width || 0;
  const sourceHeight = metadata.height || 0;

  const blurredBackdropBuffer = await sharp(sourceImagePath, { failOn: 'none' })
    .rotate()
    .resize(canvasWidth, canvasHeight, {
      fit: 'cover',
      position: 'centre',
      kernel: sharp.kernel.lanczos3
    })
    .blur(config.imageEnhancement.backdropBlur)
    .modulate({
      brightness: config.imageEnhancement.backdropBrightness,
      saturation: config.imageEnhancement.backdropSaturation
    })
    .toBuffer();

  const subjectBuffer = await baseImage
    .resize(canvasWidth, canvasHeight, {
      fit: 'contain',
      position: 'centre',
      kernel: sharp.kernel.lanczos3,
      withoutEnlargement: !config.imageEnhancement.allowUpscale
    })
    .normalize()
    .modulate({
      brightness: config.imageEnhancement.subjectBrightness,
      saturation: config.imageEnhancement.subjectSaturation
    })
    .sharpen(
      config.imageEnhancement.sharpenSigma,
      config.imageEnhancement.sharpenFlat,
      config.imageEnhancement.sharpenJagged
    )
    .png()
    .toBuffer();

  await sharp(buildBackdrop(canvasWidth, canvasHeight))
    .composite([
      {
        input: blurredBackdropBuffer
      },
      {
        input: subjectBuffer,
        blend: 'over'
      }
    ])
    .jpeg({
      quality: 82,
      mozjpeg: true,
      progressive: true,
      chromaSubsampling: '4:2:0'
    })
    .toFile(outputPath);

  return {
    outputPath,
    width: canvasWidth,
    height: canvasHeight,
    sourceWidth,
    sourceHeight
  };
}
