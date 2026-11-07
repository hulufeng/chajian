# ============================================================
#  BubaiCode Windows 安装包一键构建脚本（PowerShell）
#  用法：右键“使用 PowerShell 运行”，或:
#        powershell -ExecutionPolicy Bypass -File build-win.ps1
#  产物：dist\BubaiCode Setup 1.0.0.exe（NSIS 安装程序）
#  前置：Node.js 20+（自带 npm）
# ============================================================
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

Write-Host '[1/3] 检查 Node.js / npm...' -ForegroundColor Cyan
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Write-Host '未找到 npm，请先安装 Node.js 20+：https://nodejs.org' -ForegroundColor Red
    Read-Host '按回车退出'
    exit 1
}

Write-Host '[2/3] 检查 electron-builder 依赖...' -ForegroundColor Cyan
if (-not (Test-Path 'node_modules\electron-builder\package.json')) {
    Write-Host '首次构建，安装 electron-builder（约 1 分钟）...' -ForegroundColor Yellow
    npm install -D electron-builder
}

Write-Host '[3/3] 构建 Windows 安装包（约 2-5 分钟）...' -ForegroundColor Cyan
npx electron-builder --win --publish never
if ($LASTEXITCODE -ne 0) {
    Write-Host '构建失败，请查看上方错误信息。' -ForegroundColor Red
    Read-Host '按回车退出'
    exit 1
}

Write-Host ''
Write-Host '============================================================' -ForegroundColor Green
Write-Host ' 构建完成！' -ForegroundColor Green
Write-Host " 安装包：$((Join-Path $PSScriptRoot '..\dist\BubaiCode Setup 1.0.0.exe'))" -ForegroundColor Green
Write-Host ' 免安装版：dist\win-unpacked\BubaiCode.exe' -ForegroundColor Green
Write-Host '============================================================' -ForegroundColor Green
Read-Host '按回车退出'
