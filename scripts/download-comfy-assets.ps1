param(
  [switch]$SkipLargeCheckpoints
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$root = Split-Path -Parent $PSScriptRoot
$modelsRoot = Join-Path $root "comfyui-local\models"
$customNodesRoot = Join-Path $root "comfyui-local\custom_nodes"

function Ensure-Directory {
  param([Parameter(Mandatory)] [string] $Path)
  if (!(Test-Path -LiteralPath $Path)) {
    New-Item -ItemType Directory -Path $Path | Out-Null
  }
}

function Download-File {
  param(
    [Parameter(Mandatory)] [string] $Url,
    [Parameter(Mandatory)] [string] $Destination,
    [Parameter(Mandatory)] [int64] $MinBytes
  )

  Ensure-Directory -Path (Split-Path -Parent $Destination)

  if (Test-Path -LiteralPath $Destination) {
    $existing = (Get-Item -LiteralPath $Destination).Length
    if ($existing -ge $MinBytes) {
      Write-Host "SKIP existing $Destination ($existing bytes)"
      return
    }
    Write-Host "REMOVE undersized $Destination ($existing bytes)"
    Remove-Item -LiteralPath $Destination -Force
  }

  $partial = "$Destination.part"
  if (Test-Path -LiteralPath $partial) {
    Remove-Item -LiteralPath $partial -Force
  }

  Write-Host "DOWNLOAD $Url"
  Write-Host "  -> $Destination"
  & curl.exe -L --ssl-no-revoke --fail --retry 4 --retry-delay 5 --connect-timeout 30 --output $partial $Url
  if ($LASTEXITCODE -ne 0) {
    throw "curl failed with exit code $LASTEXITCODE for $Url"
  }

  $downloaded = (Get-Item -LiteralPath $partial).Length
  if ($downloaded -lt $MinBytes) {
    throw "Downloaded file is too small: $Destination ($downloaded bytes, expected >= $MinBytes)"
  }

  Move-Item -LiteralPath $partial -Destination $Destination -Force
}

function Download-ZipNode {
  param(
    [Parameter(Mandatory)] [string] $Url,
    [Parameter(Mandatory)] [string] $FolderName
  )

  Ensure-Directory -Path $customNodesRoot
  $destination = Join-Path $customNodesRoot $FolderName
  if (Test-Path -LiteralPath $destination) {
    Write-Host "SKIP existing custom node $destination"
    return
  }

  $zipPath = Join-Path $customNodesRoot "$FolderName.zip"
  $extractPath = Join-Path $customNodesRoot "_extract_$FolderName"
  if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
  }
  if (Test-Path -LiteralPath $extractPath) {
    Remove-Item -LiteralPath $extractPath -Recurse -Force
  }

  Write-Host "DOWNLOAD custom node $FolderName"
  & curl.exe -L --ssl-no-revoke --fail --retry 4 --retry-delay 5 --connect-timeout 30 --output $zipPath $Url
  if ($LASTEXITCODE -ne 0) {
    throw "curl failed with exit code $LASTEXITCODE for $Url"
  }

  Expand-Archive -LiteralPath $zipPath -DestinationPath $extractPath -Force
  $top = Get-ChildItem -LiteralPath $extractPath -Directory | Select-Object -First 1
  if (!$top) {
    throw "Could not find extracted custom node folder for $FolderName"
  }

  Move-Item -LiteralPath $top.FullName -Destination $destination
  Remove-Item -LiteralPath $extractPath -Recurse -Force
  Write-Host "INSTALLED custom node $destination"
}

$assets = @(
  @{ Url = "https://civitai.com/api/download/models/67980"; Path = "loras\COOLKIDS_MERGE_V2.5.safetensors"; MinBytes = 100MB },
  @{ Url = "https://civitai.com/api/download/models/161676"; Path = "loras\Pencil_Sketch.safetensors"; MinBytes = 10MB },
  @{ Url = "https://civitai.com/api/download/models/46621"; Path = "loras\Minute_Sketch_v2_R-16.safetensors"; MinBytes = 10MB },
  @{ Url = "https://civitai.com/api/download/models/16005"; Path = "loras\quickdraw_v1.2.safetensors"; MinBytes = 100MB },
  @{ Url = "https://civitai.com/api/download/models/129286"; Path = "loras\leonardo_style.safetensors"; MinBytes = 20MB },

  @{ Url = "https://civitai.com/api/download/models/9208"; Path = "embeddings\easynegative.safetensors"; MinBytes = 10KB },
  @{ Url = "https://civitai.com/api/download/models/60938"; Path = "embeddings\negative_hand-neg.pt"; MinBytes = 10KB },
  @{ Url = "https://civitai.com/api/download/models/25820"; Path = "embeddings\verybadimagenegative_v1.3.pt"; MinBytes = 10KB },

  @{ Url = "https://huggingface.co/lllyasviel/control_v11p_sd15_canny/resolve/main/diffusion_pytorch_model.fp16.safetensors"; Path = "controlnet\control_v11p_sd15_canny_fp16.safetensors"; MinBytes = 600MB },
  @{ Url = "https://huggingface.co/lllyasviel/control_v11f1p_sd15_depth/resolve/main/diffusion_pytorch_model.fp16.safetensors"; Path = "controlnet\control_v11f1p_sd15_depth_fp16.safetensors"; MinBytes = 600MB },
  @{ Url = "https://huggingface.co/lllyasviel/control_v11p_sd15_lineart/resolve/main/diffusion_pytorch_model.fp16.safetensors"; Path = "controlnet\control_v11p_sd15_lineart_fp16.safetensors"; MinBytes = 600MB },
  @{ Url = "https://huggingface.co/lllyasviel/control_v11p_sd15_openpose/resolve/main/diffusion_pytorch_model.fp16.safetensors"; Path = "controlnet\control_v11p_sd15_openpose_fp16.safetensors"; MinBytes = 600MB },
  @{ Url = "https://huggingface.co/lllyasviel/control_v11p_sd15_softedge/resolve/main/diffusion_pytorch_model.fp16.safetensors"; Path = "controlnet\control_v11p_sd15_softedge_fp16.safetensors"; MinBytes = 600MB },
  @{ Url = "https://huggingface.co/lllyasviel/control_v11p_sd15_scribble/resolve/main/diffusion_pytorch_model.fp16.safetensors"; Path = "controlnet\control_v11p_sd15_scribble_fp16.safetensors"; MinBytes = 600MB },

  @{ Url = "https://huggingface.co/h94/IP-Adapter/resolve/main/models/ip-adapter_sd15.safetensors"; Path = "ipadapter\ip-adapter_sd15.safetensors"; MinBytes = 40MB },
  @{ Url = "https://huggingface.co/h94/IP-Adapter/resolve/main/models/ip-adapter-plus_sd15.safetensors"; Path = "ipadapter\ip-adapter-plus_sd15.safetensors"; MinBytes = 40MB },
  @{ Url = "https://huggingface.co/h94/IP-Adapter/resolve/main/models/image_encoder/model.safetensors"; Path = "clip_vision\CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors"; MinBytes = 1GB },

  @{ Url = "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.4/RealESRGAN_x2plus.pth"; Path = "upscale_models\RealESRGAN_x2plus.pth"; MinBytes = 50MB },
  @{ Url = "https://huggingface.co/lokCX/4x-Ultrasharp/resolve/main/4x-UltraSharp.pth"; Path = "upscale_models\4x-UltraSharp.pth"; MinBytes = 40MB }
)

if (!$SkipLargeCheckpoints) {
  $assets += @(
    @{ Url = "https://civitai.com/api/download/models/128713"; Path = "checkpoints\dreamshaper_8.safetensors"; MinBytes = 1800MB },
    @{ Url = "https://civitai.com/api/download/models/474453"; Path = "checkpoints\revAnimated_v2Pruned.safetensors"; MinBytes = 1800MB },
    @{ Url = "https://civitai.com/api/download/models/71779"; Path = "checkpoints\expmixLine_v3.safetensors"; MinBytes = 1800MB }
  )
}

Download-ZipNode -Url "https://github.com/cubiq/ComfyUI_IPAdapter_plus/archive/refs/heads/main.zip" -FolderName "ComfyUI_IPAdapter_plus"
Download-ZipNode -Url "https://github.com/Fannovel16/comfyui_controlnet_aux/archive/refs/heads/main.zip" -FolderName "comfyui_controlnet_aux"
Download-ZipNode -Url "https://github.com/ltdrdata/ComfyUI-Impact-Pack/archive/refs/heads/Main.zip" -FolderName "ComfyUI-Impact-Pack"
Download-ZipNode -Url "https://github.com/shiimizu/ComfyUI-TiledDiffusion/archive/refs/heads/master.zip" -FolderName "ComfyUI-TiledDiffusion"

foreach ($asset in $assets) {
  Download-File -Url $asset.Url -Destination (Join-Path $modelsRoot $asset.Path) -MinBytes $asset.MinBytes
}

$presetFiles = @{
  "COOLKIDS_MERGE_V2.5.preset.json" = @{
    label = "Kids illustration"
    triggerWords = "kids illustration"
    promptSuffix = "kids illustration, flat 2D children's book devotional art, clean outlines, warm simple colors"
    negativePrompt = "photorealistic, highly detailed, realistic shading, harsh shadows, 3d render"
    strengthModel = 0.8
    strengthClip = 0.8
    notes = "Best between 0.6 and 1.0. Strong default for devotional child/storybook art."
  }
  "Pencil_Sketch.preset.json" = @{
    label = "Pencil sketch"
    triggerWords = "pencil sketch"
    promptSuffix = "monochrome pencil sketch, hand-drawn graphite illustration, clean white background, delicate cross-hatching, fine linework"
    negativePrompt = "photorealistic, color, glossy render, messy lines, heavy shading"
    strengthModel = 0.7
    strengthClip = 0.7
    notes = "Use for Narada/Krishna/Shiva sketch-style images."
  }
  "Minute_Sketch_v2_R-16.preset.json" = @{
    label = "Old sketch"
    triggerWords = "old sketch"
    promptSuffix = "vintage ink sketch, monochrome hand drawn illustration, simple paper texture"
    negativePrompt = "photorealistic, color photo, 3d, smooth digital painting"
    strengthModel = 0.6
    strengthClip = 0.6
    notes = "Cleaner, lighter sketch look than Pencil Sketch."
  }
  "quickdraw_v1.2.preset.json" = @{
    label = "Quick draw"
    triggerWords = "quickdraw"
    promptSuffix = "quick hand-drawn sketch, simple expressive linework, white background"
    negativePrompt = "photorealistic, high detail, heavy shadows, complex background"
    strengthModel = 0.55
    strengthClip = 0.55
    notes = "Use for quick minimalist social sketches."
  }
  "leonardo_style.preset.json" = @{
    label = "Leonardo illustration"
    triggerWords = "leonardo style"
    promptSuffix = "polished fantasy illustration, soft cinematic light, decorative devotional poster composition"
    negativePrompt = "low quality, muddy colors, bad anatomy, text, watermark"
    strengthModel = 0.5
    strengthClip = 0.5
    notes = "Use as a subtle polish layer; do not overdrive."
  }
}

$loraDir = Join-Path $modelsRoot "loras"
foreach ($name in $presetFiles.Keys) {
  $path = Join-Path $loraDir $name
  $json = $presetFiles[$name] | ConvertTo-Json -Depth 4
  Set-Content -LiteralPath $path -Value $json -Encoding UTF8
}

Write-Host "ComfyUI asset download completed."
