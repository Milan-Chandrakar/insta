import fs from 'node:fs/promises';
import path from 'node:path';
import { config, getConfigWarnings } from '../src/config.js';
import { getResolvedImageProviderSummary } from '../src/services/provider-summary.js';

function yesNo(value) {
  return value ? 'yes' : 'no';
}

function listNames(items = []) {
  return items.map((item) => `- ${item.label || item.id}`).join('\n') || '- none';
}

async function main() {
  const summary = await getResolvedImageProviderSummary();
  const reportPath = path.resolve(process.cwd(), 'data', 'comfyui-sync-report.md');
  const warnings = getConfigWarnings();
  const blockers = [
    ...(summary.comfyuiReachable
      ? []
      : [
          '- ComfyUI server is not reachable from the app. The UI will now disable Comfy-only features until the server comes up.'
        ]),
    ...(!summary.comfyuiFeatures.lora ? ['- LoraLoader or live LoRA options are missing.'] : []),
    ...(!summary.comfyuiFeatures.controlNet ? ['- ControlNetLoader/ControlNetApplyAdvanced or live ControlNet models are missing.'] : []),
    ...(!summary.comfyuiFeatures.ipAdapter ? ['- IPAdapterAdvanced/IPAdapterModelLoader/CLIPVisionLoader or their models are missing.'] : []),
    ...(!summary.comfyuiFeatures.upscaler ? ['- UpscaleModelLoader or live upscaler models are missing.'] : []),
    ...(!summary.comfyuiFeatures.tiledDiffusion ? ['- TiledDiffusion node is not exposed by the current ComfyUI instance.'] : []),
    ...(!summary.comfyuiFeatures.tiledVae ? ['- VAEDecodeTiled_TiledDiffusion node is not exposed by the current ComfyUI instance.'] : []),
    ...warnings.map((warning) => `- ${warning}`)
  ];

  const lines = [
    '# ComfyUI Sync Report',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    '## Provider status',
    '',
    `- Default provider: ${summary.default}`,
    `- Selected label: ${summary.selectedLabel}`,
    `- Cloudflare configured: ${yesNo(summary.cloudflareConfigured)}`,
    `- Google configured: ${yesNo(summary.googleConfigured)}`,
    `- ComfyUI configured: ${yesNo(summary.comfyuiConfigured)}`,
    `- ComfyUI reachable: ${yesNo(summary.comfyuiReachable)}`,
    `- ComfyUI error: ${summary.comfyuiError || 'none'}`,
    '',
    '## ComfyUI features',
    '',
    `- Checkpoint loader: ${yesNo(summary.comfyuiFeatures.checkpoint)}`,
    `- LoRA: ${yesNo(summary.comfyuiFeatures.lora)}`,
    `- Upscaler: ${yesNo(summary.comfyuiFeatures.upscaler)}`,
    `- Img2Img: ${yesNo(summary.comfyuiFeatures.img2img)}`,
    `- ControlNet: ${yesNo(summary.comfyuiFeatures.controlNet)}`,
    `- IP-Adapter: ${yesNo(summary.comfyuiFeatures.ipAdapter)}`,
    `- CLIP Vision: ${yesNo(summary.comfyuiFeatures.clipVision)}`,
    `- Tiled Diffusion: ${yesNo(summary.comfyuiFeatures.tiledDiffusion)}`,
    `- Tiled VAE: ${yesNo(summary.comfyuiFeatures.tiledVae)}`,
    '',
    '## ComfyUI system',
    '',
    `- GPU: ${summary.comfyuiSystem?.name || 'unknown'}`,
    `- VRAM free: ${summary.comfyuiSystem?.vramFree ?? 'unknown'}`,
    `- VRAM total: ${summary.comfyuiSystem?.vramTotal ?? 'unknown'}`,
    '',
    '## Asset visibility',
    '',
    '### Checkpoints',
    listNames(summary.availableModels?.comfyui),
    '',
    '### LoRAs',
    listNames(summary.availableLoras?.comfyui),
    '',
    '### Upscalers',
    listNames(summary.availableUpscalers?.comfyui),
    '',
    '### ControlNet',
    listNames(summary.availableControlNets?.comfyui),
    '',
    '### IP-Adapter',
    listNames(summary.availableIpAdapters?.comfyui),
    '',
    '### CLIP Vision',
    listNames(summary.availableClipVision?.comfyui),
    '',
    '## Current blockers',
    '',
    ...(blockers.length > 0 ? blockers : ['- none']),
    '',
    '## Next run plan',
    '',
    '- Start ComfyUI first and verify `/system_stats` and `/object_info/...` routes on the configured base URL.',
    '- Refresh the app; ComfyUI provider should only become selectable when the server is actually reachable.',
    '- Test features in this order: checkpoint only, LoRA, ControlNet, IP-Adapter, upscaler, Tiled Diffusion.',
    '- Keep one golden SD1.5 preset as the default path and use the advanced toggles only after the base path is stable.'
  ];

  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, `${lines.join('\n')}\n`, 'utf8');
  console.log(`Wrote ${reportPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
