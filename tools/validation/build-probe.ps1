param(
  [string]$SimutransSource = 'E:/chore/simutrans',
  [string]$Compiler = 'C:/msys64/mingw64/bin/g++.exe'
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$expectedCommit = 'af90444e46dfd422bfdf80518aaa568659ec6b00'
$actualCommit = (& git -C $SimutransSource rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $actualCommit -ne $expectedCommit) { throw 'Unexpected Simutrans source revision' }
& git -C $SimutransSource diff --exit-code HEAD -- src/simutrans
if ($LASTEXITCODE -ne 0) { throw 'Simutrans source has uncommitted changes' }
$sourceRoot = Join-Path $SimutransSource 'src/simutrans'
$outputDir = Join-Path $repoRoot '.validation'
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
$env:PATH = (Split-Path $Compiler -Parent) + ';' + $env:PATH
$sourceFiles = @(
  'dataobj/height_map_loader.cc', 'io/raw_image.cc', 'io/raw_image_bmp.cc',
  'io/raw_image_png.cc', 'io/raw_image_ppm.cc', 'io/classify_file.cc',
  'io/rdwr/raw_file_rdwr_stream.cc', 'io/rdwr/rdwr_stream.cc',
  'simmem.cc', 'simio.cc', 'utils/log.cc', 'world/surface.cc'
)
$compileArgs = @('-std=c++17', '-O2', '-flto', '-DMAKEOBJ', '-ffunction-sections', '-fdata-sections', '-I', $sourceRoot)
$compileArgs += Join-Path $PSScriptRoot 'simutrans-probe.cc'
$compileArgs += $sourceFiles | ForEach-Object { Join-Path $sourceRoot $_ }
$compileArgs += @('-Wl,--gc-sections', '-lpng', '-lz', '-o', (Join-Path $outputDir 'simutrans-probe.exe'))
& $Compiler @compileArgs
if ($LASTEXITCODE -ne 0) { throw 'Simutrans probe build failed' }

function Get-ProbeHash([string]$Path) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($algorithm.ComputeHash([IO.File]::ReadAllBytes($Path)))).Replace('-', '').ToLowerInvariant() }
  finally { $algorithm.Dispose() }
}
$manifest = @{
  sourceCommit = $actualCommit
  compiler = (& $Compiler --version | Select-Object -First 1)
  executableSha256 = Get-ProbeHash (Join-Path $outputDir 'simutrans-probe.exe')
  probeSha256 = Get-ProbeHash (Join-Path $PSScriptRoot 'simutrans-probe.cc')
  buildScriptSha256 = Get-ProbeHash $PSCommandPath
}
$manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $outputDir 'probe-build.json') -Encoding utf8
