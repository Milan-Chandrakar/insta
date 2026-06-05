import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modelsRoot = join(root, 'comfyui-local', 'models');
const customNodesRoot = join(root, 'comfyui-local', 'custom_nodes');
const skipLargeCheckpoints = process.argv.includes('--skip-large-checkpoints');

function ensureDirectory(path) {
  mkdirSync(path, { recursive: true });
}

function sizeOf(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

async function fetchWithRetry(url, attempts = 4) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const headers = {
        'User-Agent': 'codex-comfy-asset-downloader/1.0'
      };
      if (process.env.CIVITAI_TOKEN && url.includes('civitai.com')) {
        headers.Authorization = `Bearer ${process.env.CIVITAI_TOKEN}`;
      }
      const response = await fetch(url, {
        redirect: 'follow',
        headers
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      if (!response.body) {
        throw new Error('Response did not include a stream body.');
      }
      return response;
    } catch (error) {
      lastError = error;
      console.log(`  attempt ${attempt}/${attempts} failed: ${error.message}`);
      if (attempt < attempts) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, attempt * 5000));
      }
    }
  }
  throw lastError;
}

async function downloadFile({ url, path, minBytes }) {
  const destination = join(modelsRoot, path);
  ensureDirectory(dirname(destination));

  const existingSize = sizeOf(destination);
  if (existingSize >= minBytes) {
    console.log(`SKIP existing ${destination} (${existingSize} bytes)`);
    return;
  }
  if (existingSize > 0) {
    console.log(`REMOVE undersized ${destination} (${existingSize} bytes)`);
    rmSync(destination, { force: true });
  }

  const partial = `${destination}.part`;
  rmSync(partial, { force: true });

  console.log(`DOWNLOAD ${url}`);
  console.log(`  -> ${destination}`);
  const response = await fetchWithRetry(url);
  const total = Number(response.headers.get('content-length') || 0);
  let downloaded = 0;
  let lastReport = 0;

  const progress = new TransformStream({
    transform(chunk, controller) {
      downloaded += chunk.byteLength;
      if (downloaded - lastReport > 50 * 1024 * 1024) {
        lastReport = downloaded;
        const totalText = total ? ` / ${Math.round(total / 1024 / 1024)} MB` : '';
        console.log(`  ${Math.round(downloaded / 1024 / 1024)} MB${totalText}`);
      }
      controller.enqueue(chunk);
    }
  });

  await pipeline(
    Readable.fromWeb(response.body.pipeThrough(progress)),
    createWriteStream(partial)
  );

  const downloadedSize = sizeOf(partial);
  if (downloadedSize < minBytes) {
    rmSync(partial, { force: true });
    throw new Error(`Downloaded file is too small: ${destination} (${downloadedSize} bytes, expected >= ${minBytes})`);
  }

  renameSync(partial, destination);
}

async function downloadRaw(url, destination, minBytes = 1024) {
  ensureDirectory(dirname(destination));
  const existingSize = sizeOf(destination);
  if (existingSize >= minBytes) {
    console.log(`SKIP existing ${destination}`);
    return;
  }

  rmSync(destination, { force: true });
  const partial = `${destination}.part`;
  rmSync(partial, { force: true });
  console.log(`DOWNLOAD ${url}`);
  console.log(`  -> ${destination}`);
  const response = await fetchWithRetry(url);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(partial));
  const downloadedSize = sizeOf(partial);
  if (downloadedSize < minBytes) {
    rmSync(partial, { force: true });
    throw new Error(`Downloaded file is too small: ${destination}`);
  }
  renameSync(partial, destination);
}

function expandZip(zipPath, destination) {
  const extractPath = join(customNodesRoot, `_extract_${Date.now()}`);
  rmSync(extractPath, { recursive: true, force: true });
  ensureDirectory(extractPath);
  execFileSync('powershell', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `Expand-Archive -LiteralPath ${JSON.stringify(zipPath)} -DestinationPath ${JSON.stringify(extractPath)} -Force`
  ], { stdio: 'inherit' });
  const top = readdirSync(extractPath, { withFileTypes: true }).find((entry) => entry.isDirectory());
  if (!top) {
    throw new Error(`Could not find extracted folder for ${zipPath}`);
  }
  rmSync(destination, { recursive: true, force: true });
  renameSync(join(extractPath, top.name), destination);
  rmSync(extractPath, { recursive: true, force: true });
}

async function downloadZipNode({ url, folder }) {
  ensureDirectory(customNodesRoot);
  const destination = join(customNodesRoot, folder);
  if (existsSync(destination)) {
    console.log(`SKIP existing custom node ${destination}`);
    return;
  }
  const zipPath = join(customNodesRoot, `${folder}.zip`);
  await downloadRaw(url, zipPath, 20_000);
  expandZip(zipPath, destination);
  console.log(`INSTALLED custom node ${destination}`);
}

const assets = [
  { url: 'https://civitai.com/api/download/models/67980', path: 'loras/COOLKIDS_MERGE_V2.5.safetensors', minBytes: 100 * 1024 * 1024 },
  { url: 'https://civitai.com/api/download/models/161676', path: 'loras/Pencil_Sketch.safetensors', minBytes: 10 * 1024 * 1024 },
  { url: 'https://civitai.com/api/download/models/46621', path: 'loras/Minute_Sketch_v2_R-16.safetensors', minBytes: 10 * 1024 * 1024 },
  { url: 'https://civitai.com/api/download/models/16005', path: 'loras/quickdraw_v1.2.safetensors', minBytes: 100 * 1024 * 1024 },
  { url: 'https://civitai.com/api/download/models/129286', path: 'loras/leonardo_style.safetensors', minBytes: 20 * 1024 * 1024 },

  { url: 'https://civitai.com/api/download/models/9208', path: 'embeddings/easynegative.safetensors', minBytes: 10 * 1024 },
  { url: 'https://civitai.com/api/download/models/60938', path: 'embeddings/negative_hand-neg.pt', minBytes: 10 * 1024 },
  { url: 'https://civitai.com/api/download/models/25820', path: 'embeddings/verybadimagenegative_v1.3.pt', minBytes: 10 * 1024 },

  { url: 'https://huggingface.co/lllyasviel/control_v11p_sd15_canny/resolve/main/diffusion_pytorch_model.fp16.safetensors', path: 'controlnet/control_v11p_sd15_canny_fp16.safetensors', minBytes: 600 * 1024 * 1024 },
  { url: 'https://huggingface.co/lllyasviel/control_v11f1p_sd15_depth/resolve/main/diffusion_pytorch_model.fp16.safetensors', path: 'controlnet/control_v11f1p_sd15_depth_fp16.safetensors', minBytes: 600 * 1024 * 1024 },
  { url: 'https://huggingface.co/lllyasviel/control_v11p_sd15_lineart/resolve/main/diffusion_pytorch_model.fp16.safetensors', path: 'controlnet/control_v11p_sd15_lineart_fp16.safetensors', minBytes: 600 * 1024 * 1024 },
  { url: 'https://huggingface.co/lllyasviel/control_v11p_sd15_openpose/resolve/main/diffusion_pytorch_model.fp16.safetensors', path: 'controlnet/control_v11p_sd15_openpose_fp16.safetensors', minBytes: 600 * 1024 * 1024 },
  { url: 'https://huggingface.co/lllyasviel/control_v11p_sd15_softedge/resolve/main/diffusion_pytorch_model.fp16.safetensors', path: 'controlnet/control_v11p_sd15_softedge_fp16.safetensors', minBytes: 600 * 1024 * 1024 },
  { url: 'https://huggingface.co/lllyasviel/control_v11p_sd15_scribble/resolve/main/diffusion_pytorch_model.fp16.safetensors', path: 'controlnet/control_v11p_sd15_scribble_fp16.safetensors', minBytes: 600 * 1024 * 1024 },

  { url: 'https://huggingface.co/h94/IP-Adapter/resolve/main/models/ip-adapter_sd15.safetensors', path: 'ipadapter/ip-adapter_sd15.safetensors', minBytes: 40 * 1024 * 1024 },
  { url: 'https://huggingface.co/h94/IP-Adapter/resolve/main/models/ip-adapter-plus_sd15.safetensors', path: 'ipadapter/ip-adapter-plus_sd15.safetensors', minBytes: 40 * 1024 * 1024 },
  { url: 'https://huggingface.co/h94/IP-Adapter/resolve/main/models/image_encoder/model.safetensors', path: 'clip_vision/CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors', minBytes: 1024 * 1024 * 1024 },

  { url: 'https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.4/RealESRGAN_x2plus.pth', path: 'upscale_models/RealESRGAN_x2plus.pth', minBytes: 50 * 1024 * 1024 },
  { url: 'https://huggingface.co/lokCX/4x-Ultrasharp/resolve/main/4x-UltraSharp.pth', path: 'upscale_models/4x-UltraSharp.pth', minBytes: 40 * 1024 * 1024 }
];

if (!skipLargeCheckpoints) {
  assets.push(
    { url: 'https://civitai.com/api/download/models/128713', path: 'checkpoints/dreamshaper_8.safetensors', minBytes: 1800 * 1024 * 1024 },
    { url: 'https://civitai.com/api/download/models/474453', path: 'checkpoints/revAnimated_v2Pruned.safetensors', minBytes: 1800 * 1024 * 1024, optional: true },
    { url: 'https://civitai.com/api/download/models/71779', path: 'checkpoints/expmixLine_v3.safetensors', minBytes: 1800 * 1024 * 1024 }
  );
}

const customNodes = [
  { url: 'https://github.com/cubiq/ComfyUI_IPAdapter_plus/archive/refs/heads/main.zip', folder: 'ComfyUI_IPAdapter_plus' },
  { url: 'https://github.com/Fannovel16/comfyui_controlnet_aux/archive/refs/heads/main.zip', folder: 'comfyui_controlnet_aux' },
  { url: 'https://github.com/ltdrdata/ComfyUI-Impact-Pack/archive/refs/heads/Main.zip', folder: 'ComfyUI-Impact-Pack' },
  { url: 'https://github.com/shiimizu/ComfyUI-TiledDiffusion/archive/refs/heads/master.zip', folder: 'ComfyUI-TiledDiffusion' }
];

for (const node of customNodes) {
  await downloadZipNode(node);
}

const optionalFailures = [];
for (const asset of assets) {
  try {
    await downloadFile(asset);
  } catch (error) {
    if (asset.optional) {
      optionalFailures.push(`${asset.path}: ${error.message}`);
      console.log(`OPTIONAL FAILED ${asset.path}: ${error.message}`);
      continue;
    }
    throw error;
  }
}

const loraDir = join(modelsRoot, 'loras');
const presets = {
  'COOLKIDS_MERGE_V2.5.preset.json': {
    label: 'Kids illustration',
    triggerWords: 'kids illustration',
    promptSuffix: "kids illustration, flat 2D children's book devotional art, clean outlines, warm simple colors",
    negativePrompt: 'photorealistic, highly detailed, realistic shading, harsh shadows, 3d render',
    strengthModel: 0.8,
    strengthClip: 0.8,
    notes: 'Best between 0.6 and 1.0. Strong default for devotional child/storybook art.'
  },
  'Pencil_Sketch.preset.json': {
    label: 'Pencil sketch',
    triggerWords: 'pencil sketch',
    promptSuffix: 'monochrome pencil sketch, hand-drawn graphite illustration, clean white background, delicate cross-hatching, fine linework',
    negativePrompt: 'photorealistic, color, glossy render, messy lines, heavy shading',
    strengthModel: 0.7,
    strengthClip: 0.7,
    notes: 'Use for Narada/Krishna/Shiva sketch-style images.'
  },
  'Minute_Sketch_v2_R-16.preset.json': {
    label: 'Old sketch',
    triggerWords: 'old sketch',
    promptSuffix: 'vintage ink sketch, monochrome hand drawn illustration, simple paper texture',
    negativePrompt: 'photorealistic, color photo, 3d, smooth digital painting',
    strengthModel: 0.6,
    strengthClip: 0.6,
    notes: 'Cleaner, lighter sketch look than Pencil Sketch.'
  },
  'quickdraw_v1.2.preset.json': {
    label: 'Quick draw',
    triggerWords: 'quickdraw',
    promptSuffix: 'quick hand-drawn sketch, simple expressive linework, white background',
    negativePrompt: 'photorealistic, high detail, heavy shadows, complex background',
    strengthModel: 0.55,
    strengthClip: 0.55,
    notes: 'Use for quick minimalist social sketches.'
  },
  'leonardo_style.preset.json': {
    label: 'Leonardo illustration',
    triggerWords: 'leonardo style',
    promptSuffix: 'polished fantasy illustration, soft cinematic light, decorative devotional poster composition',
    negativePrompt: 'low quality, muddy colors, bad anatomy, text, watermark',
    strengthModel: 0.5,
    strengthClip: 0.5,
    notes: 'Use as a subtle polish layer; do not overdrive.'
  }
};

ensureDirectory(loraDir);
for (const [name, preset] of Object.entries(presets)) {
  writeFileSync(join(loraDir, name), `${JSON.stringify(preset, null, 2)}\n`, 'utf8');
}

console.log('ComfyUI asset download completed.');
if (optionalFailures.length > 0) {
  console.log('Optional downloads skipped:');
  for (const failure of optionalFailures) {
    console.log(`  - ${failure}`);
  }
  console.log('If you want these too, set CIVITAI_TOKEN and rerun this script.');
}
