@echo off
chcp 65001 >nul
REM ============================================================
REM  BubaiCode Windows 安装包一键构建脚本
REM  用法：双击运行，或在命令行执行 build-win.bat
REM  产物：dist\BubaiCode Setup 1.0.0.exe（NSIS 安装程序）
REM  前置：Node.js 20+（自带 npm）
REM ============================================================
cd /d "%~dp0.."
echo [1/3] 检查 Node.js / npm...
where npm >nul 2>nul
if errorlevel 1 (
  echo 未找到 npm，请先安装 Node.js 20+：https://nodejs.org
  pause
  exit /b 1
)
echo [2/3] 检查 electron-builder 依赖...
if not exist node_modules\electron-builder\package.json (
  echo 首次构建，安装 electron-builder（约 1 分钟）...
  call npm install -D electron-builder
  if errorlevel 1 ( echo 依赖安装失败 & pause & exit /b 1 )
)
echo [3/3] 构建 Windows 安装包（约 2-5 分钟）...
call npx electron-builder --win --publish never
if errorlevel 1 (
  echo.
  echo 构建失败，请查看上方错误信息。
  pause
  exit /b 1
)
echo.
echo ============================================================
echo  构建完成！
echo  安装包：%~dp0..\dist\BubaiCode Setup 1.0.0.exe
echo  免安装版：dist\win-unpacked\BubaiCode.exe
echo ============================================================
pause
