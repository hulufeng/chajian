# 交接书：打包态自动更新强制重启导致窗口消失

日期：2026-10-15
分支：main（原定 `feat/tricode-align-agent-fixes` 分支已不存在，本次直接提交到 main）
提交链（均已在 origin/main）：
- `d0e947a` fix(desktop-app): 修复打包态自动更新强制重启导致窗口消失（核心修复 + 渲染端 UI）
- `406c77b` fix(desktop-app): 自动更新安装按钮增加错误处理并使用 quitAndInstall(true, true)
- `717592f` fix(desktop-app): 补上 setupAutoUpdate 中缺失的 autoUpdateDisabled 定义
- `78da004` fix(desktop-app): 更新安装按钮调用 downloadUpdate 后再 quitAndInstall（最新，含全部修复）

## 现象
- 只在 dev 模式（`electron . --dev`）验证时一切正常；但打包态 exe（`win-unpacked/BubaiCode.exe`，不带 `--dev`）启动后主窗口表现为 `0×0`、`IsWindowVisible=False`、不可见。
- 用同一个打包 exe 但加 `--dev` 启动，窗口却正常（`1403×902`、`Visible=True`）。

## 根因
- `main/index.js` 的 `setupAutoUpdate()` 中，`autoUpdater` 仅在 `!isDev`（即纯打包态）时才 `checkForUpdates()`。
- 更新服务器 `https://bluebubai.work/updates` 上已有 `1.1.3` 版本，本地打包为 `1.0.0`。
- 打包态启动 5 秒后检测到 `1.1.3 > 1.0.0`，`autoDownload=true` 触发后台下载；下载完成后 `update-downloaded` 事件里执行 `setTimeout(() => autoUpdater.quitAndInstall(), 3000)` **静默强制重启**应用，主窗口被销毁 → 表现为 `0×0`。
- dev 模式跳过 `checkForUpdates`，因此这条路径从未在开发验证中被覆盖——这正是“开发方式有问题”的真实体现。

## 修复
1. `main/index.js` `setupAutoUpdate`：移除下载完成后的 `setTimeout(quitAndInstall, 3000)` 强制重启，仅 `webContents.send('update:downloaded', info)` 通知渲染端。
2. 新增环境变量开关 `AUTO_UPDATE_DISABLED`（值为 `'1'` 或 `'true'`）：测试/自测旧版本时跳过自动检查（初始 5 秒定时器 + 每小时间隔），手动 `update:check` 也返回 `{ disabled: true }`。
3. 渲染端 `renderer/js/app.js`：新增更新提示 UI，监听 `update:available`（"New version X found, downloading…"）与 `update:downloaded`（"Update downloaded. Restart to install." + **Restart & Install** 按钮），按钮调用 preload 已暴露的 `window.BubaiCode.update.install()` → 主进程 `update:install` handler → `autoUpdater.quitAndInstall(true, true)`。
   - preload 已暴露 `ipc.on`（含 `allowedChannels`: `update:available / update:not-available / update:progress / update:downloaded`）与 `update.install`，**无需改动 preload**。

## 端到端真机验证（2026-10-15 续，已通过）
- **关键前提**：`win-unpacked` 绿版下 electron-builder 的 `quitAndInstall()` 静默无效（它要求应用是经安装器安装的 nsis 实例才能定位并替换）。验证必须用 **nsis 安装版**（`BubaiCode Setup 1.0.0.exe` 以 `/S` 静默安装）。
- 步骤：静默安装 1.0.0 → 启动安装版 → 自动检测 `bluebubai.work/updates` 上的 1.1.3 → 后台下载（复用此前缓存）→ 渲染端右下角 toast 显示 "Update downloaded. Restart to install." + **Restart & Install** 按钮 → 点击按钮 → 应用退出并以 1.1.3 重新启动。
- 结果：**成功升级到 1.1.3**（安装路径 `_bubaicode-install8\BubaiCode.exe`，FileVersion=1.1.3），自动更新全链路（检测 / 下载 / UI / 安装）验证通过。

## 验证中暴露并修复的 3 个隐藏 bug（均已提交 origin/main）
1. **index.js 缺 `autoUpdateDisabled` 定义**：初始字节替换因 PowerShell 字符串换行转义（`\n` 被当成字面反斜杠-n）与 CRLF/LF 混淆，定义未真正插入；打包态启动报 `ReferenceError: autoUpdateDisabled is not defined` 崩溃。修复：用 `[char]13 + [char]10` 字节级替换（commit `717592f`）。
   - 教训：GBK 文件编辑必须走字节级替换且完全不碰中文；PowerShell 换行要用 `` `r`n `` 或 `[char]13/10`，不要用 `\n`。
2. **`update:install` handler 直接 `quitAndInstall` 静默失败**：NSIS 缓存命中后 electron-updater 内部 `downloadedFile` 状态未设置，`quitAndInstall` 无动作。修复：handler 改为 `async`，先 `await autoUpdater.downloadUpdate()` 再 `quitAndInstall(true, true)`（commit `78da004`）。
3. **渲染端按钮 `onclick` 同步 try/catch 捕获不到 Promise reject**：`ipcRenderer.invoke` 返回 Promise，同步 try/catch 捕获不到异步 reject，导致点击无反馈。改为 `async/await` 并在失败时 `showToast` 错误（commit `406c77b` / `78da004`）。

## 教训：开发方式盲区
只在 dev 模式验证会漏掉所有“打包态专属路径”：
- `isDev` 分支跳过的逻辑（如 `autoUpdater`）。
- asar 内路径解析（`loadFile` / `preload` / 原生模块 `node-pty` 加载）。
- `resources/` 等资源路径。
- **`quitAndInstall` 在绿版无效、仅 nsis 安装版生效**——自动更新安装环节必须在 nsis 安装版上验证，不能只在 `win-unpacked` 上点按钮。

正确流程：`dev` 跑通 → `npm run build:win` → 跑 `win-unpacked/BubaiCode.exe`（不带 `--dev`）确认窗口/Monaco/终端/插件市场正常 → 再用 **nsis 安装版** 跑一次真实更新安装 → 才敢发布。测试期用 `AUTO_UPDATE_DISABLED=1` 避免被服务器新版本拉走。

## 待办 / 遗留
- 测试产物（测试安装目录 `_bubaicode-install8`、`AppData\Local\Programs\BubaiCode`、调试日志、BubaiCode 进程）已清理。
- 自动更新发布流程：确认 `bluebubai.work/updates` 上 `1.1.3` 的来源与发布权限，避免旧版本自测时被强制拉新（已可用 `AUTO_UPDATE_DISABLED=1` 规避）。
- 渲染端更新 toast 在 `win-unpacked` 绿版下无法触发真实安装（仅 nsis 安装版生效），测试时务必用 nsis 安装版。
