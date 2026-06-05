import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import ffprobe from 'ffprobe-static';
import { config } from '../config.js';
import { prepareEnhancedReelImage } from './image-enhancer.js';
import { resolvePublicMediaUrl } from './public-url.js';

const execFileAsync = promisify(execFile);

async function ensureReelsDirectory() {
  await fs.mkdir(config.media.reelsDir, { recursive: true });
}

async function getAudioDurationSeconds(audioPath) {
  const { stdout } = await execFileAsync(ffprobe.path, [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    audioPath
  ]);

  const parsed = Number.parseFloat(String(stdout).trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Could not read audio duration for ${audioPath}`);
  }

  return parsed;
}

export async function renderReelFromImage({
  imagePath,
  audioPath,
  clipStartSeconds = 0,
  durationSeconds = config.music.defaultDurationSeconds,
  preserveAudio = false,
  preparedImagePath = null
}) {
  if (!ffmpegPath) {
    throw new Error('ffmpeg-static did not provide a binary path.');
  }

  const audioDuration = await getAudioDurationSeconds(audioPath);
  const requestedDuration = Math.max(1, Math.floor(durationSeconds || config.music.defaultDurationSeconds));
  if (audioDuration < requestedDuration) {
    throw new Error(
      `Selected audio is only ${audioDuration.toFixed(2)}s long. Every reel must be ${requestedDuration}s exactly, so choose a longer track.`
    );
  }

  const effectiveDuration = requestedDuration;
  const maxStart = Math.max(0, Math.floor(audioDuration - effectiveDuration));
  const safeStart = preserveAudio
    ? 0
    : Math.max(0, Math.min(Math.floor(clipStartSeconds), maxStart));
  const outputName = `${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID()}.mp4`;
  const outputPath = path.join(config.media.reelsDir, outputName);
  const fadeStart = Math.max(0, effectiveDuration - config.music.audioFadeOutSeconds);
  const enhancedImage = config.imageEnhancement.enabled
    ? preparedImagePath
      ? { outputPath: preparedImagePath }
      : await prepareEnhancedReelImage(imagePath)
    : null;
  const renderInputPath = enhancedImage?.outputPath || imagePath;
  const videoFilter = [
    `scale=${config.reels.width}:${config.reels.height}:force_original_aspect_ratio=decrease`,
    `pad=${config.reels.width}:${config.reels.height}:(ow-iw)/2:(oh-ih)/2`,
    `fps=${config.reels.fps}`,
    'format=yuv420p'
  ].join(',');

  const audioFilter = !preserveAudio && fadeStart > 0
    ? `afade=t=out:st=${fadeStart}:d=${config.music.audioFadeOutSeconds}`
    : 'anull';

  await ensureReelsDirectory();
  const args = [
    '-loglevel',
    'error',
    '-y',
    '-loop',
    '1',
    '-i',
    renderInputPath,
    '-ss',
    String(safeStart),
    '-i',
    audioPath,
    '-t',
    String(effectiveDuration),
    '-vf',
    videoFilter,
    ...(!preserveAudio ? ['-af', audioFilter] : []),
    '-r',
    String(config.reels.fps),
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-tune',
    'stillimage',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:v',
    config.reels.videoBitrate,
    '-b:a',
    config.reels.audioBitrate,
    '-movflags',
    '+faststart',
    '-shortest',
    outputPath
  ];

  try {
    await execFileAsync(ffmpegPath, args);
  } catch (error) {
    const stderr = String(error?.stderr || '').trim();
    const stdout = String(error?.stdout || '').trim();
    const details = stderr || stdout || (error instanceof Error ? error.message : String(error));
    throw new Error(`Reel render failed: ${details}`);
  }

  const stat = await fs.stat(outputPath);

  return {
    outputPath,
    outputUrl: resolvePublicMediaUrl(outputPath),
    preparedImagePath: enhancedImage?.outputPath || null,
    preserveAudio,
    durationSeconds: effectiveDuration,
    clipStartSeconds: safeStart,
    width: config.reels.width,
    height: config.reels.height,
    fps: config.reels.fps,
    sizeBytes: stat.size
  };
}
