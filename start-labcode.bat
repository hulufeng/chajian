@echo off
rem 一键启动 LabCode（跑已构建的 out/ 产物，非沙箱）
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo [ERROR] 找不到本地 Electron 运行时：node_modules\electron\dist\electron.exe
  echo 请先在项目根执行：npm install
  pause
  exit /b 1
)
if not exist "out\main\index.js" (
  echo [ERROR] 找不到构建产物 out\main\index.js
  echo 请先在项目根执行：npm run build
  pause
  exit /b 1
)
echo [LabCode] 正在从 out\ 启动（真实编译产物 + 项目 node_modules）...
echo [LabCode] 关闭此窗口即退出应用。
start "" "node_modules\electron\dist\electron.exe" "."