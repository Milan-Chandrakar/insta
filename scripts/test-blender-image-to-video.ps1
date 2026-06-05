$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$blenderScript = Join-Path $PSScriptRoot 'blender-image-to-video-test.py'
$defaultImage = Join-Path $repoRoot 'dashboard-test.png'
$outputFile = Join-Path $repoRoot 'data\blender-test-output\blender-image-to-video-test.mp4'

function Get-BlenderExecutable {
  $command = Get-Command blender -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }

  $candidateRoots = @(
    'C:\Program Files\Blender Foundation',
    'C:\Program Files (x86)\Blender Foundation'
  )

  foreach ($root in $candidateRoots) {
    if (-not (Test-Path $root)) {
      continue
    }

    $candidate = Get-ChildItem -Path $root -Recurse -Filter blender.exe -ErrorAction SilentlyContinue |
      Select-Object -First 1

    if ($candidate) {
      return $candidate.FullName
    }
  }

  return $null
}

$blender = Get-BlenderExecutable
if (-not $blender) {
  throw 'Blender executable not found on PATH or in standard Program Files locations.'
}

if (-not (Test-Path $defaultImage)) {
  throw "Default test image not found: $defaultImage"
}

New-Item -ItemType Directory -Force -Path (Split-Path $outputFile) | Out-Null

& $blender -b --python $blenderScript -- --image $defaultImage --output $outputFile --duration 11 --fps 30 --width 1080 --height 1920
