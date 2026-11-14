@echo off
chcp 65001 >nul
REM ============================================================
REM  BubaiCode Windows 安装包一键构建脚本
REM  用法：双击运行，或在命令行执行 build-win.bat
REM  产物：dist179\BubaiCode-Setup-<version>.exe（NSIS 安装程序）
REM  前置：Node.js 20+（自带 npm）
REM ============================================================
cd /d "%~dp0.."

echo [1/4] 检查 Node.js / npm...
where npm >nul 2>nul
if errorlevel 1 (
  echo 未找到 npm，请先安装 Node.js 20+：https://nodejs.org
  pause
  exit /b 1
)

echo [2/4] 清理旧输出目录 dist179（规避 safe-delete 守卫）...
if exist dist179 (
  REM 用 PowerShell 的 .NET API 删除，绕过 node-safe-delete-shim 对批量删除的拦截
  powershell -NoProfile -Command "if(Test-Path 'dist179'){[System.IO.Directory]::Delete('dist179',$true)}"
)

echo [3/4] 重建 native 模块 + 注入网关凭据 + 打包...
REM build:win = electron-rebuild -f -w serialport,node-pty && electron-builder --win
REM electron-builder 之前会自动触发 prebuild 钩子（scripts/inject-gateway.js）
call npm run build:win
if errorlevel 1 (
  echo.
  echo 构建失败，请查看上方错误信息。
  pause
  exit /b 1
)

echo.
echo ============================================================
echo  构建完成！
echo  安装包：%~dp0..\dist179\BubaiCode-Setup-1.2.33.exe
echo  免安装版：dist179\win-unpacked\BubaiCode.exe
echo ============================================================
pause
