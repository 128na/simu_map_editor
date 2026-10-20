param(
  [string]$SimutransSource = 'E:/chore/simutrans',
  [string]$RuntimeData = 'E:/chore/simutrans_addon/simuwin',
  [string]$Pakset = 'E:/chore/simutrans_addon/simuwin/pak128',
  [string]$CompilerBin = 'C:/msys64/mingw64/bin',
  [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$root = Join-Path $repoRoot '.validation/world-probe'
$sourceCopy = Join-Path $root 'source'
$build = Join-Path $root 'build'
$expectedCommit = 'af90444e46dfd422bfdf80518aaa568659ec6b00'
$oldPath = $env:PATH
$oldSnapshot = $env:SIMUTRANS_VALIDATION_PREBEACH

function Get-ProbeHash([string]$Path) {
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($algorithm.ComputeHash([IO.File]::ReadAllBytes($Path)))).Replace('-', '').ToLowerInvariant() }
  finally { $algorithm.Dispose() }
}
function Check-Exit([string]$Step) {
  if ($LASTEXITCODE -ne 0) { throw "$Step failed, exit $LASTEXITCODE" }
}
function Write-TerrainFixture([string]$Path, [bool]$Coast) {
  $w=24; $h=24; $stride=72
  $bytes = New-Object byte[] (54+$stride*$h)
  $bytes[0]=66; $bytes[1]=77
  [BitConverter]::GetBytes([int]$bytes.Length).CopyTo($bytes,2)
  [BitConverter]::GetBytes([int]54).CopyTo($bytes,10)
  [BitConverter]::GetBytes([int]40).CopyTo($bytes,14)
  [BitConverter]::GetBytes([int]$w).CopyTo($bytes,18)
  [BitConverter]::GetBytes([int]$h).CopyTo($bytes,22)
  [BitConverter]::GetBytes([int16]1).CopyTo($bytes,26)
  [BitConverter]::GetBytes([int16]24).CopyTo($bytes,28)
  [BitConverter]::GetBytes([int]($stride*$h)).CopyTo($bytes,34)
  for($y=0;$y -lt $h;$y++){for($x=0;$x -lt $w;$x++){
    $v=0; if($Coast -and $x -ge 12){$v=128}
    $i=54+($h-1-$y)*$stride+$x*3
    $bytes[$i]=$v; $bytes[$i+1]=$v; $bytes[$i+2]=$v
  }}
  [IO.File]::WriteAllBytes($Path,$bytes)
}

try {
  $env:PATH = "$CompilerBin;$oldPath"
  New-Item -ItemType Directory -Path $root -Force | Out-Null
  if (!(Test-Path $sourceCopy)) {
    & git clone --local --no-hardlinks $SimutransSource $sourceCopy
    Check-Exit 'clone isolated source'
    & git -C $sourceCopy checkout $expectedCommit
    Check-Exit 'checkout source revision'
  }
  $actualCommit = (& git -C $sourceCopy rev-parse HEAD).Trim()
  Check-Exit 'read isolated revision'
  if($actualCommit -ne $expectedCommit){throw 'Unexpected isolated source revision'}
  $patch = Join-Path $PSScriptRoot 'world-probe.patch'
    $previousErrorPreference=$ErrorActionPreference
  $ErrorActionPreference='Continue'
  try { & git -C $sourceCopy apply --check $patch 2>$null; $canApply=$LASTEXITCODE -eq 0 }
  finally { $ErrorActionPreference=$previousErrorPreference }
  if($canApply){
    & git -C $sourceCopy apply $patch
    Check-Exit 'apply instrumentation patch'
  } else {
    & git -C $sourceCopy apply --reverse --check $patch
    Check-Exit 'verify instrumentation already applied'
  }
  $actualDiff=& git -C $sourceCopy diff --no-ext-diff --no-color --binary HEAD --
  Check-Exit 'read full isolated source diff'
  $expectedDiff=([IO.File]::ReadAllText($patch)).Replace("`r`n","`n").TrimEnd()
  if(($actualDiff -join "`n").TrimEnd() -cne $expectedDiff){throw 'Isolated source differs from the instrumentation patch; use a clean isolated clone'}
  $unexpectedFiles=& git -C $sourceCopy ls-files --others --exclude-standard
  Check-Exit 'check isolated untracked files'
  if($unexpectedFiles){throw 'Unexpected untracked files in isolated source'}
  $stampPath=Join-Path $root 'world-build.json'
  $exe=Join-Path $build 'simutrans/simutrans.exe'
  if($SkipBuild){
    if(!(Test-Path $stampPath)){throw 'No build manifest; run without -SkipBuild first'}
    $stamp=Get-Content $stampPath -Raw | ConvertFrom-Json
    if($stamp.sourceCommit -ne $actualCommit -or $stamp.patchSha256 -ne (Get-ProbeHash $patch) -or $stamp.executableSha256 -ne (Get-ProbeHash $exe)){throw 'Stale world build; run without -SkipBuild'}
  }
  if(!$SkipBuild){
    & "$CompilerBin/cmake.exe" -S $sourceCopy -B $build -G Ninja -DCMAKE_TOOLCHAIN_FILE= -DCMAKE_BUILD_TYPE=Release '-DCMAKE_CXX_FLAGS_RELEASE=-O0 -DNDEBUG' -DSIMUTRANS_BACKEND=none -DSIMUTRANS_MULTI_THREAD=OFF -DSIMUTRANS_USE_FLUIDSYNTH_MIDI=OFF -DSIMUTRANS_USE_UPNP=OFF -DSIMUTRANS_USE_ZSTD=OFF -DSIMUTRANS_INSTALL_PAK64=OFF -DSIMUTRANS_USE_REVISION=99999
    Check-Exit 'configure headless'
    & "$CompilerBin/cmake.exe" --build $build --target simutrans -j 4
    Check-Exit 'build headless'
    @{sourceCommit=$actualCommit;patchSha256=(Get-ProbeHash $patch);executableSha256=(Get-ProbeHash $exe)} | ConvertTo-Json | Set-Content $stampPath -Encoding UTF8
  }
  $exe=Join-Path $build 'simutrans/simutrans.exe'
  $nativeExe=Join-Path $repoRoot '.validation/simutrans-probe.exe'
  if(!(Test-Path $nativeExe)){throw 'Run npm run validate:heightmaps first'}
  $nativeStamp=Get-Content (Join-Path $repoRoot '.validation/probe-build.json') -Raw | ConvertFrom-Json
  if($nativeStamp.sourceCommit -ne $actualCommit -or $nativeStamp.executableSha256 -ne (Get-ProbeHash $nativeExe)){throw 'Stale native comparator; run npm run validate:heightmaps'}
  $fixtures=Join-Path $repoRoot '.validation/fixtures'
  Write-TerrainFixture "$root/sea.bmp" $false
  Write-TerrainFixture "$root/coast.bmp" $true
  $cases=@(
    @{name='flat'; input="$fixtures/flat.png"; mode=2},
    @{name='corners'; input="$fixtures/corners.png"; mode=2},
    @{name='asymmetric-bmp'; input="$fixtures/asymmetric-bottom-up.bmp"; mode=3},
    @{name='sea'; input="$root/sea.bmp"; mode=2},
    @{name='coast'; input="$root/coast.bmp"; mode=2}
  )
  $uiExport=Join-Path $repoRoot '.validation/ui-export-chrome.bmp'
  if(Test-Path $uiExport){$cases+=@{name='ui-export'; input=$uiExport; mode=3}}
  $results=@()
  foreach($case in $cases){
    if(!(Test-Path $case.input)){throw "Missing fixture $($case.input); run npm run validate:heightmaps first"}
    # Use slash paths because the C++ JSON instrumentation prints the input directly.
    $inputPath=$case.input.Replace('\','/')
    $userdir="$root/user-$($case.name)"
    New-Item -ItemType Directory -Path $userdir -Force | Out-Null
    $out="$root/$($case.name).json"; $before="$root/$($case.name)-prebeach.json"
    $env:SIMUTRANS_VALIDATION_PREBEACH=$before
    $start=Get-Date
    $gameArgs=@('-set_basedir',('"'+$RuntimeData+'"'),'-set_userdir',('"'+$userdir+'"'),'-set_pakdir',('"'+$Pakset+'"'),'-noaddons','-nosound','-nomidi','-lang','en','-validation-heightmap',('"'+$inputPath+'"'),'-validation-output',('"'+$out+'"'),'-validation-mode',$case.mode)
    $proc=New-Object System.Diagnostics.Process
    $proc.StartInfo.FileName=$exe
    $proc.StartInfo.Arguments=($gameArgs -join ' ')
    $proc.StartInfo.UseShellExecute=$false
    $proc.StartInfo.CreateNoWindow=$true
    $proc.StartInfo.RedirectStandardOutput=$true
    $proc.StartInfo.RedirectStandardError=$true
    $null=$proc.Start()
    $stdout=$proc.StandardOutput.ReadToEndAsync()
    $stderr=$proc.StandardError.ReadToEndAsync()
    if(!$proc.WaitForExit(30000)){ $proc.Kill(); throw "World probe timed out: $($case.name)" }
    [IO.File]::WriteAllText("$root/$($case.name).stdout.log",$stdout.Result)
    [IO.File]::WriteAllText("$root/$($case.name).stderr.log",$stderr.Result)
    if($proc.ExitCode -ne 0 -or !(Test-Path $out)){throw "World probe failed: $($case.name), exit $($proc.ExitCode)"}
    if((Get-Item $out).LastWriteTime -lt $start){throw 'Stale world output'}
    $world=Get-Content $out -Raw | ConvertFrom-Json
    if(!(Test-Path $before) -or (Get-Item $before).LastWriteTime -lt $start){throw 'Missing or stale pre-beach snapshot'}
    $pre=Get-Content $before -Raw | ConvertFrom-Json
    $nativeText=& $nativeExe $inputPath $world.mode $world.factor ([int]$world.doubleSlopes) $world.minimumHeight $world.maximumHeight
    Check-Exit 'native comparator'
    $native=$nativeText | ConvertFrom-Json
    if($world.width -ne $native.width -or $world.height -ne $native.height){throw 'World/native image dimensions mismatch'}
    $nativeText | Set-Content "$root/$($case.name)-native.json" -Encoding UTF8
    if($pre.Count -ne $native.grid.Count -or $pre.Count -ne $world.grid.Count){throw 'Grid dimensions mismatch'}
    $preMismatch=0; $finalMismatch=0; $beachChanges=0; $waterMismatch=0
    for($i=0;$i -lt $pre.Count;$i++){
      if($pre[$i] -ne $native.grid[$i]){$preMismatch++}
      if($world.grid[$i] -ne $native.grid[$i]){$finalMismatch++}
      if($world.grid[$i] -ne $pre[$i]){$beachChanges++}
    }
    for($y=0;$y -lt $world.height;$y++){for($x=0;$x -lt $world.width;$x++){
      $g=$y*($world.width+1)+$x; $i=$y*$world.width+$x
      $max=[Math]::Max([Math]::Max($world.grid[$g],$world.grid[$g+1]),[Math]::Max($world.grid[$g+$world.width+1],$world.grid[$g+$world.width+2]))
      if(($max -le $world.waterHeights[$i]) -ne $world.water[$i]){$waterMismatch++}
    }}
    if($preMismatch -or $waterMismatch){throw "Terrain mismatch in $($case.name)"}
    $results += [ordered]@{name=$case.name; inputSha256=(Get-ProbeHash $inputPath); width=$world.width; height=$world.height; factor=$world.factor; doubleSlopes=$world.doubleSlopes; mode=$world.mode; minimumHeight=$world.minimumHeight; maximumHeight=$world.maximumHeight; seaLevel=$world.seaLevel; vertices=$pre.Count; preBeachNativeMismatches=$preMismatch; finalNativeMismatches=$finalMismatch; beachChangedVertices=$beachChanges; waterTiles=@($world.water | Where-Object {$_}).Count; waterClassificationMismatches=$waterMismatch; exitCode=$proc.ExitCode}
  }
  $summary=[ordered]@{sourceCommit=$actualCommit; scope='Full karte_t::load_heightfield -> init runtime, instrumentation-only hooks'; executableSha256=(Get-ProbeHash $exe); patchSha256=(Get-ProbeHash $patch); cities=0; factories=0; attractions=0; trees='none'; lakes='disabled'; rivers='disabled'; beaches='enabled, pre/post snapshots compared'; cases=$results}
  $summary | ConvertTo-Json -Depth 8 | Set-Content "$root/results.json" -Encoding UTF8
  $summary | ConvertTo-Json -Depth 8
} finally {
  $env:PATH=$oldPath
  $env:SIMUTRANS_VALIDATION_PREBEACH=$oldSnapshot
}
