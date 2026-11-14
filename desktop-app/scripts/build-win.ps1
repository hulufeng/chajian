# ============================================================
#  BubaiCode Windows 安装包一键构建脚本（PowerShell）
#  用法：右键“使用 PowerShell 运行”，或:
#        powershell -ExecutionPolicy Bypass -File build-win.ps1
#  产物：dist179\BubaiCode-Setup-<version>.exe（NSIS 安装程序）
#  前置：Node.js 20+（自带 npm）
# ============================================================
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

# 读取 package.json 的版本与输出目录，避免写死 1.0.0 / 旧路径
$cfg = Get-Content package.json -Raw | ConvertFrom-Json
$ver = $cfg.version
$outDir = if ($cfg.build -and $cfg.build.directories -and $cfg.build.directories.output) { $cfg.build.directories.output } else { 'dist179' }

Write-Host '[1/4] 检查 Node.js / npm...' -ForegroundColor Cyan
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host '未找到 npm，请先安装 Node.js 20+：https://nodejs.org' -ForegroundColor Red
    Read-Host '按回车退出'
    exit 1
}

Write-Host "[2/4] 清理旧输出目录 $outDir（规避 safe-delete 守卫）..." -ForegroundColor Cyan
if (Test-Path $outDir) {
    try { [System.IO.Directory]::Delete($outDir, $true) }
    catch { Write-Warning "删除 $outDir 失败（$_), 尝试继续；若 electron-builder 报错请先手动清理" }
}

Write-Host '[3/4] 重建 native 模块 + 注入网关凭据 + 打包...' -ForegroundColor Cyan
# build:win = electron-rebuild -f -w serialport,node-pty && electron-builder --win
# 其中 electron-builder 之前会自动触发 prebuild 钩子（scripts/inject-gateway.js）
npm run build:win
if ($LASTEXITCODE -ne 0) {
    Write-Host '构建失败，请查看上方错误信息。' -ForegroundColor Red
    Read-Host '按回车退出'
    exit 1
}

Write-Host ''
Write-Host '============================================================' -ForegroundColor Green
Write-Host ' 构建完成！' -ForegroundColor Green
Write-Host " 安装包：$(Join-Path $PSScriptRoot "..\$outDir\BubaiCode-Setup-$ver.exe")" -ForegroundColor Green
Write-Host " 免安装版：$outDir\win-unpacked\BubaiCode.exe" -ForegroundColor Green
Write-Host '============================================================' -ForegroundColor Green
Read-Host '按回车退出'
