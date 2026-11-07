# ============================================================
# BubaiCode Toolchain Check / Install Script (ASCII only for PS 5.1 compatibility)
# Usage:
#   powershell -ExecutionPolicy Bypass -File check-toolchains.ps1           # check only
#   powershell -ExecutionPolicy Bypass -File check-toolchains.ps1 install   # check + auto-install pip items, prompt for winget items
# Notes:
#   - pip items (mpremote/esptool/pyserial/black) are small and auto-installed in install mode
#   - winget items (OpenSCAD/SDCC/OpenOCD/LLVM) are large; install mode asks y/n for each
#   - STM32CubeMX requires an ST account: manual download only
#   - wokwi-cli: downloads latest win zip into scripts\tools\ (add to PATH manually)
# ============================================================
$ErrorActionPreference = 'Continue'
$mode = 'check'
if ($args.Count -ge 1) { $mode = $args[0] }
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$toolsDir = Join-Path $root 'tools'
if (-not (Test-Path $toolsDir)) { New-Item -ItemType Directory -Path $toolsDir | Out-Null }

function Test-Cmd($name) {
  $c = Get-Command $name -ErrorAction SilentlyContinue
  return [bool]$c
}
function Test-PipModule($mod) {
  # import-based check: works for every package (pyserial has no __main__, esptool v5 has no --version)
  try {
    & python -c ("import " + $mod) 2>$null | Out-Null
    return ($LASTEXITCODE -eq 0)
  } catch { return $false }
}

$results = @()
function Add-Result($name, $ok, $hint, $installer) {
  $script:results += [pscustomobject]@{ Tool = $name; Ready = $ok; InstallHint = $hint; Installer = $installer }
}

$pyOk = Test-Cmd 'python'
$mpOk = $false; $esOk = $false; $serOk = $false; $blOk = $false
if ($pyOk) {
  $mpOk = Test-PipModule 'mpremote'
  $esOk = Test-PipModule 'esptool'
  $serOk = Test-PipModule 'serial'
  $blOk = Test-PipModule 'black'
}
$ocd = $false
try { $ocd = [bool](winget list --id xpack-dev-tools.openocd --accept-source-agreements 2>$null | Select-String 'openocd') } catch { $ocd = $false }

Add-Result 'python'          $pyOk   'https://www.python.org/downloads/' ''
Add-Result 'pip:mpremote'    $mpOk   'python -m pip install -U mpremote' 'pip'
Add-Result 'pip:esptool'     $esOk   'python -m pip install -U esptool'  'pip'
Add-Result 'pip:pyserial'    $serOk  'python -m pip install -U pyserial' 'pip'
Add-Result 'pip:black'       $blOk   'python -m pip install -U black'    'pip'
Add-Result 'arduino-cli'     (Test-Cmd 'arduino-cli')  'bundled auto-download; or: winget install ArduinoCLI.CLI' 'skip'
Add-Result 'openscad'        ((Test-Cmd 'openscad') -or (Test-Cmd 'OpenSCAD'))  'winget install OpenSCAD.OpenSCAD' 'winget'
Add-Result 'sdcc(8051)'      (Test-Cmd 'sdcc')         'winget install SDCC.SDCC  or https://sdcc.sourceforge.net/' 'winget'
Add-Result 'openocd(STM32)'  ((Test-Cmd 'openocd') -or $ocd)  'winget install xpack-dev-tools.openocd' 'winget'
Add-Result 'wokwi-cli'       (Test-Cmd 'wokwi-cli')    'https://github.com/wokwi/wokwi-cli/releases (add to PATH)' 'gh'
Add-Result 'clangd(C/C++)'   (Test-Cmd 'clangd')       'winget install LLVM.LLVM (includes clangd)' 'winget'
Add-Result 'STM32CubeMX'     ((Test-Cmd 'STM32CubeMX') -or (Test-Cmd 'stm32cubemx'))  'ST account required: https://www.st.com/en/development-tools/stm32cubemx.html' 'skip'

Write-Host ''
Write-Host '===== BubaiCode Toolchain Status =====' -ForegroundColor Cyan
foreach ($r in $results) {
  $tag = '[MISS]'
  if ($r.Ready) { $tag = '[OK]  ' }
  $color = 'Yellow'
  if ($r.Ready) { $color = 'Green' }
  $line = '  ' + $tag + ' ' + $r.Tool.PadRight(16) + ' ' + $r.InstallHint
  Write-Host $line -ForegroundColor $color
}
$missing = @($results | Where-Object { -not $_.Ready })

if ($mode -eq 'install' -and $missing.Count -gt 0) {
  Write-Host ''
  Write-Host ('===== Installing {0} missing item(s) =====' -f $missing.Count) -ForegroundColor Cyan
  foreach ($m in $missing) {
    if ($m.Installer -eq 'pip') {
      $mod = ($m.Tool -replace '^pip:', '')
      $pkg = $mod
      if ($mod -eq 'pyserial') { $pkg = 'pyserial' }
      Write-Host ('>> pip install ' + $pkg) -ForegroundColor Cyan
      & python -m pip install -U $pkg 2>&1 | Select-Object -Last 1
    }
    elseif ($m.Installer -eq 'winget') {
      $ans = Read-Host ('  Install ' + $m.Tool + ' via winget? (y/N, large download)')
      if ($ans -eq 'y') {
        $wg = ''
        if ($m.Tool -eq 'openscad') { $wg = 'OpenSCAD.OpenSCAD' }
        if ($m.Tool -eq 'sdcc(8051)') { $wg = 'SDCC.SDCC' }
        if ($m.Tool -eq 'openocd(STM32)') { $wg = 'xpack-dev-tools.openocd' }
        if ($m.Tool -eq 'clangd(C/C++)') { $wg = 'LLVM.LLVM' }
        if ($wg -ne '') { winget install --id $wg --accept-source-agreements --accept-package-agreements }
      }
    }
    elseif ($m.Installer -eq 'gh') {
      if ($m.Tool -eq 'wokwi-cli') {
        $ans = Read-Host '  Download wokwi-cli into scripts\tools\? (y/N)'
        if ($ans -eq 'y') {
          $url = 'https://github.com/wokwi/wokwi-cli/releases/latest/download/wokwi-cli-win.zip'
          try {
            Invoke-WebRequest -Uri $url -OutFile (Join-Path $toolsDir 'wokwi-cli.zip') -UseBasicParsing
            Expand-Archive -Path (Join-Path $toolsDir 'wokwi-cli.zip') -DestinationPath $toolsDir -Force
            Remove-Item (Join-Path $toolsDir 'wokwi-cli.zip') -Force
            Write-Host ('  Extracted to ' + $toolsDir + ' (add to PATH manually)') -ForegroundColor Green
          } catch { Write-Host ('  Download failed: ' + $_.Exception.Message) -ForegroundColor Red }
        }
      }
    }
    else {
      Write-Host ('  Skip ' + $m.Tool) -ForegroundColor DarkGray
    }
  }
  Write-Host ''
  Write-Host '===== Re-check =====' -ForegroundColor Cyan
  & $MyInvocation.MyCommand.Path
}
else {
  Write-Host ''
  if ($missing.Count -eq 0) { Write-Host 'All toolchains ready.' -ForegroundColor Green }
  else { Write-Host ('{0} item(s) missing. Run with "install" to auto-install pip items.' -f $missing.Count) -ForegroundColor Yellow }
}
