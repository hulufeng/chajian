# LabCode 项目文档

> 最后更新：2026-10-08
> 版本：1.1.3
> 技术栈：Electron 44 + React 19 + TypeScript 5.9 + electron-vite 5

---

## 1. 项目定位

面向 ESP32 开发的**商业化桌面 IDE**，核心卖点：
- 内置 AI 编程助手（本地小模型 + 云端大模型）
- 真实烧录（Arduino CLI 工具链）
- 板级仿真（不接板子也能跑）
- 课程体系（28+ 个 ESP32 教学示例）

**目标用户：** ESP32 初学者、单片机教学场景、低配电脑（4GB/8GB 内存可跑）。

---

## 2. 技术架构

```
src/
├── main/                  # 主进程（Node.js）
│   ├── engine/           # Agent 引擎核心（36 文件）
│   │   ├── agent-runner # 主循环：工具调用循环
│   │   ├── tools/       # 40+ 个工具定义
│   │   ├── prompts/     # 系统提示词
│   │   └── types.ts
│   ├── services/         # 各种服务（41 文件）
│   │   ├── aiGateway    # AI 网关（本地+云端）
│   │   ├── serialService # 串口
│   │   ├── toolchain    # Arduino CLI 编译
│   │   ├── platformio   # PlatformIO
│   │   ├── debug/       # 片上调试（7 文件）
│   │   │   ├── debugService        # openocd 会话 / 断点 / 读写内存
│   │   │   ├── svdService          # SVD 外设寄存器
│   │   │   ├── debug-symbols       # ELF 符号索引
│   │   │   ├── debug-symbols-service # 符号服务编排
│   │   │   ├── debug-dwarf-info    # DWARF 变量解析
│   │   │   ├── debug-callstack     # 调用栈回溯
│   │   │   └── debug-variables     # 全局变量读写
│   │   ├── lsp/         # 代码智能提示（4 文件）
│   │   │   ├── lspService          # 对外门面
│   │   │   ├── lsp-client          # JSON-RPC 客户端
│   │   │   ├── lsp-compile-db      # compile_commands.json
│   │   │   └── lsp-server-path     # clangd 定位
│   │   ├── gitService  # Git
│   │   ├── mcpManager  # MCP 外部协议
│   │   └── ...
│   ├── plugins/          # 插件系统（15 文件）
│   ├── mcp/             # MCP 协议（4 文件）
│   └── index.ts         # 入口
├── renderer/            # 渲染进程（React）
│   └── src/
│       └── components/   # 29 个 UI 组件
│           ├── EditorArea    # Monaco 编辑器
│           ├── AiPanel      # AI 面板
│           ├── SerialPlotter # 串口监视器
│           ├── DevicePanel    # 设备面板
│           ├── TerminalView  # 终端
│           └── ...
└── preload/             # 预加载脚本
```

---

## 3. 核心功能

### 3.1 AI 助手

**本地模型：**
- Qwen2.5 Coder 3B（gguf 格式，4GB 内存可跑）
- 内置知识库（40-60 条 ESP32 基础问答）
- 教学问答模式（精简提示词，禁工具）

**云端模型（9 个，来自后端 `/api/models`，客户端不写死）：**
- DeepSeek Flash（快速，1分/次）、Coder（代码专用，2分/次）、R1 推理（深度推理，4分/次）
- 通义千问 Coder（中文友好，2分/次）、Max（通用强模型，3分/次）
- GPT-4o（6分/次）、GPT-4o mini（3分/次）— 需服务端配 `OPENAI_API_KEY`
- Gemini 1.5 Pro（5分/次）、Gemini 2.0 Flash（3分/次）— 需服务端配 `GEMINI_API_KEY`
- 未配对应 Key 的模型返回演示回复（仍真实扣积分，便于验证整链路）

**账号体系：**
- 邮箱验证码注册/登录（SMTP 发 6 位验证码，10 分钟有效）
- 新用户送 100 积分
- Guest 模式（匿名，50 次免费额度）

**Agent 能力：**
- 40+ 工具：文件读写/终端/Git/网页搜索/编译/烧录/SVD 调试
- Todo 工具（任务规划）
- ask_user（主动提问）
- 文件冲突检测（防 AI 覆盖用户改动）
- 反幻觉检测（声称 vs 工具证据）
- Diff 可视化（红绿行）

### 3.2 ESP32 开发

- **编译：** Arduino CLI / PlatformIO 双工具链
- **烧录：** esptool 一键烧录
- **串口监视器：** 实时日志 + 波形图
- **板级仿真：**
  - OLED 文本显示
  - ADC 滑块（模拟传感器）
  - DHT22 温湿度
  - 示波器（GPIO 波形）
- **演示固件：** ESP32-C3 / ESP32-S3 内置 bin

### 3.3 课程体系

28+ 个教学示例：
- 基础：LED、按键、PWM
- 通信：Wi-Fi、BLE、UART
- 传感器：DHT22、OLED、ADC
- 系统：FreeRTOS、任务调度
- 项目：智能家居、传感器节点

---

## 4. 已修复的 Bug

| 日期 | Bug | 修复 |
|---|---|---|
| 2026-10-08 | tool-observers.ts 给箭头函数设 .name 报错 | Object.defineProperty + try-catch |
| 2026-10-08 | 插件 UI XSS 风险 | 加 escapeHtml 转义 |
| 2026-10-07 | 串口监视器窗口遮挡 | 串口并入底部 Tab |
| 2026-10-06 | 文件冲突检测（防 AI 覆盖） | T8 冲突检测 |
| 2026-10-05 | 反幻觉检测（伪造工具响应） | T13 增强 |

---

## 5. 对标 TrieCode 的差距

**已对齐：**
- 工具集（40+ 个，基本持平）
- Diff 可视化
- 邮箱注册/登录
- 本地小模型（3B）

**仍有差距：**
- 模型绝对能力：已补 GPT-4o / Gemini，但需服务端配 Key 才真实生效（未配则演示回复）；Claude 仅 BYOK（用户自带 Key），不走官方积分通道
- 长上下文窗口（已给云端/BYOK 16000 字符读取预算，本地 4000）
- 商业化成本（Claude API 太贵，不适合免费内置）

---

## 6. 云端后端

**技术栈：** 零依赖 Node.js ESM（cloud-server/server.mjs）

**API：**
- `POST /api/auth/register` / `/api/auth/login` — 邮箱密码注册/登录
- `POST /api/auth/send-code` / `/api/auth/verify-code` — 邮箱验证码登录（新用户送 100 积分）
- `POST /api/guest` — Guest 匿名试用（设备指纹，50 次免费）
- `GET /api/me` — 查账户积分
- `GET /api/models` — 模型列表（9 个，见 3.1）
- `POST /api/chat` / `POST /api/chat/stream` — 非流式 / SSE 流式对话（含工具调用）

**按 provider 分派：** 每个模型自带 `provider + baseUrl + keyEnv`，后端按 provider 转发：
OpenAI 兼容档（openai / deepseek / qwen）直连 `/chat/completions`；**Gemini 由后端把 OpenAI 格式翻译成 Gemini 格式，并把响应归一化回 OpenAI 兼容 SSE**，因此客户端零改动。

**部署：** https://bluebubai.work（生产）/ 127.0.0.1:8787（本地开发）

---

## 7. GitHub 仓库

- 地址：https://github.com/hulufeng/chajian（public，默认分支 main）
- 状态：桌面端（codelab-desktop）**已推送成功**
- 注意：推送**必须走系统代理**（端口会变，用 `GIT_CURL_VERBOSE=1` 看实际端口）；清空代理环境变量会导致推送必败；代理偶发 502 需忽略重试
- 官网（codelab-site）是**独立 git 仓库**，不在此仓库内（见第 9 节）

---

## 8. 待办

- [x] 全量代码推到 GitHub（已完成 → hulufeng/chajian）
- [ ] SMTP 配置（生产环境需要用户提供 SMTP_HOST/PORT/USER/PASS）
- [ ] 线上 cloud-server 部署最新代码（含 GPT-4o / Gemini 模型）
- [ ] 服务端配 `OPENAI_API_KEY` / `GEMINI_API_KEY`（未配则对应模型走演示回复）
- [ ] debug 相关文件合并成目录
- [ ] LSP 相关文件合并成目录

---

## 9. 官网后台（codelab-site）

**技术栈：** 零依赖 Node.js ESM（`codelab-site/server/server.mjs`，端口 8788）

**职责：** 静态托管官网 + 管理后台 API —— 登录管理 / 插件上架 / 下载统计 / 内容管理 / 联系留言

**启动：** `cd codelab-site && node server/server.mjs` → 官网 `http://127.0.0.1:8788/`，后台 `/admin/`

**公开接口：**
- `GET /api/plugins` — 插件市场列表；`GET /api/plugins/:id` 详情
- `POST /api/plugins/:id/install` — 安装意向计数
- `GET /api/version` — 最新版本号（下载页徽标）
- `GET /api/content` — 内容列表（首页公告条消费）；`GET /api/content/:key` 单条
- `GET /api/downloads` — 下载统计（轻量）
- `POST /api/contact` — 提交联系留言
- `GET /d/:os`（windows/macos/linux）— 记录一次下载后 **302 跳转真实安装包**

**管理接口（Bearer token）：** `/api/admin/login` `/logout`；`plugins` / `content` CRUD；`contacts` 留言管理；`version` 版本设置；`downloads`、`overview` 统计

**配置：** `server/.env`（不入库，模板 `server/.env.example`）—— 管理员 `admin@labcode.dev` + 强密码；下载地址指向 `https://bluebubai.work/updates/LabCode-Setup-0.1.9.exe`（.dmg / .AppImage）。
⚠ 改管理员密码时：若 `server/data/db.json` 已存在，改 `.env` **不生效**，需删 `db.json` 重建账号。

**验证：** 从**工作区根**运行 `node codelab-site/server/check-site-server.mjs`（37 项断言，当前 37/0）。
⚠ 必须从工作区根运行 —— 脚本 spawn 的是相对根的路径；从 `codelab-site/` 或 `server/` 运行会 MODULE_NOT_FOUND。

**仓库：** `codelab-site` 已初始化为独立 git 仓库（首次提交 `94b997b`）；`.gitignore` 排除 `server/.env` 与 `server/data/`（含凭据与运行时数据）。

**前端对接点：** `index.html` 顶部公告条 + 联系表单 + `loadPlugins()`；`plugins.html` 动态拉插件；`download.html` 版本徽标 + `/d/windows` 下载按钮；各页导航含「管理后台」入口 `/admin/`。

---

## 10. 构建 / 出包 / 验证（可直接照抄）

### 10.1 出包配方（本机已验证，别改回去）

```bash
# 1) 先让路（清空 out 会撞 safe-delete 超时）
mv out out_prev_$(date +%H%M)

# 2) 构建（bin 是 bin/electron-vite.js，不是 bin.mjs）
node node_modules/electron-vite/bin/electron-vite.js build
node scripts/copy-runtime-assets.mjs

# 3) 打包（输出目录必须是**全新未用过**的 pkgoutNN，绝不删旧目录）
sed -i 's/"output": "pkgoutXX"/"output": "pkgoutNN"/' builder.full.config.json
node node_modules/electron-builder/cli.js --win nsis -c builder.full.config.json
```

`builder.full.config.json` 三个要点（缺一个就会重演「EBUSY 打不出包」）：
`files: ["out/**/*","package.json"]` 白名单 + `asar: false` + `npmRebuild: false`。
（历史上 `files` 非白名单把旧 `pkgout*/dist` 递归打进 app → GB 级包 → 杀软锁文件。）

⚠ **不要跑 `npm run build/dist`**：electron-vite 会清空 `out/`（撞护栏），且 `build` 字段里的 `output` 指向旧目录。

### 10.2 验证顺序（改完必跑）

```bash
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json --composite false
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json --composite false
node scripts/scan-ipc-handlers.mjs      # 改 preload/main 通道后必跑，期望 0 命中
node scripts/scan-ui-crash.mjs
node scripts/scan-json-parse.mjs
node scripts/scan-unhandled-rejection.mjs
node scripts/check-*.mjs                # 受影响的那些
```

### 10.3 产物复核（**这里有个坑**）

- 期望：renderer assets **95 个**、有 1 个 css、`index.html` 引用的 js/css 都存在。
- ⚠ **主进程代码会被 rollup 拆进 `out/main/chunks/*.js`**：`grep "xxx" out/main/index.js` 得 0 **不代表没打包** —— 必须 `grep -r xxx out/main/`（已踩两次：`parseFlashProgress`、`chip_id` 都在 `chunks/toolchain-*.js`）。

---

## 11. 真机 bug 记录 #1~#4

> 只记**真实发生**的问题，不猜不脑补；证据以用户导出的测试报告为准。

### #1 UI 全部裸奔、无任何样式（CSS 404）—— ✅ 已修（pkgout30）

- **现象**：DOM 全渲染，但元素无样式堆在左上角，按钮/下拉框是浏览器默认样式。
- **证据**：包内 `out/renderer/assets/` 只有 63 个文件（应 95），`index.html` 引用的 CSS 404。
- **根因**：重建时 vite `emptyDir` 触发 safe-delete 超时，留下**部分删除中间态**（CSS 被删、JS 完好）；打包前没独立复核产物。
- **修法**：`mv out out_bad_20261007` → 全新构建 → 独立复核（CSS 在 / 引用零缺失 / 95 个）→ 换全新 `pkgout30` 重打包。
- **教训**：**删除失败后必须独立复核，或 rename 让路** —— 不能默认"没删成就是都在"。

### #2 打开 .ino / 源码文件编辑器内容为空 —— ✅ 已修（pkgout31，pkgout35 报告已确认）

- **现象**：文件能开、标签页正常，编辑区为空（`jiqiren.ino` 30KB、`FluxGarage_RoboEyes.h` 26KB）。
- **逐层排除（均实证）**：① 文件本身正常（UTF-8 无 BOM、0 个 U+FFFD）② 主进程读取正常 ③ `classifyFile` 未触发只读保护 ④ **确凿异常**：`@monaco-editor/react` 用 `Uri.parse(path)` 生成 model URI，`Uri.parse('C:\Users\...')` 把盘符 `C` 当 scheme（toString 变 `C:%5CUsers%5C...`），路径含中文/空格同样中招。
- **修法**：`MonacoWrapper.toModelPath()` 显式转 `file:///C%3A/...`；`openFile` 增加反馈 `✓ 已打开 xxx（N 字节 / M 行）`，0 字节额外打 `⚠ 内容为空`。
- **确认**：pkgout35 报告里 `fs:readFile` 显示 `jiqiren.ino bytes:25452 lines:732` 且用户能正常看代码 → **已修复**。

### #3 烧录失败 `Compiled sketch not found in ...\arduino\sketches\1698...` —— 🔧 已修（pkgout32）

- **根因（代码实证）**：CLI 降级编译带 `--build-path` 写进自建目录，而 `uploadSketch` **从不传** → arduino-cli upload 只去默认缓存 `sketches\<hash>` 找 → 必然 not found。**烧录在 CLI 降级路径下从未可能成功过。**
- **修法（5 处打通 buildPath 链）**：`uploadSketch` 支持 `--build-path` → `grpc:upload` opts 增 `buildPath?` 双分支透传 → `grpc-client.upload` 带 `build_path` → `App.tsx` 新增 `lastCompileBuildPathRef`（编译成功时记下产物目录，烧录时回传）→ preload 类型扩展。

### #4 烧录失败 `This chip is ESP32-C3, not ESP32-S3. Wrong chip argument?` —— 🔧 已修（pkgout36，待复测）

- **来源**：**pkgout35 测试报告**（这套收集机制首次实战即命中）。
- **证据链**（同一份报告里的三行）：

| 时间 | 事件 | 说明 |
|---|---|---|
| t=2.1s | `target:change fqbn=esp32s3 port=COM29 boardName=""` | 板卡不是识别出来的，是 `device.get()` **恢复的上次选择** |
| t=70s | `board:autodetect fqbn=""` | 插板时 arduino-cli **根本认不出**（C3/S3/P4 共用 `303a:1001`） |
| t=227s | `task:exit code=0, ms=141988` | 编译全过，**白等 142 秒** |
| t=240s | `task:exit code=1` | 烧录被 esptool 打回：目标 S3、实物 C3 |

- **两层根因**：表层 = 目标板卡错且无自动纠正；**底层 = 根本认不出板卡** → 静默沿用旧板卡 → 白等全量编译 → 最后一步才被打回。
- **修法**：① 烧录期 `parseChipMismatch` + `notifyChipMismatch` → 自动改成实测芯片并持久化，提示再点一次烧录；② 插板期 CLI 认不出时用 **esptool `chip_id`** 直读（`toolchain.probeChipId`/`findEsptool`/`parseChipIdFromOutput`，8s 超时，失败一律 null 降级）；③ 认不出时界面明说「没能认出型号，目标板卡仍是上次选的 XXX」，不再静默沿用。
- **复测建议**：拔插板子看输出面板是「检测到开发板：COM29 · ESP32-C3」还是「未识别到板卡型号」；后者说明 esptool 探测未生效，报告里 `board:autodetect.probed` 一眼看出。

---

## 12. 坑位清单（别再踩第二次）

1. **并行会话改工作树**：出现过 3 次「我 tsc 完，多出我没写过的改动」。文件时间戳比构建时间新 = 构建时**不含**那些改动。
2. **主进程代码在 `out/main/chunks/`**：复核不能只 grep `index.js`。
3. **同秒二次启动会覆盖日志**（sessionId 必须毫秒精度）。
4. **Windows 文件名非法字符**：报告名不能带 `:`。
5. **删除被护栏拦**：用 `mv` 让路，别删。
6. **`@monaco-editor/react` 的 `path` 要自己转 file URI**：直接传 Windows 路径会让盘符被当 scheme → 编辑器空。
7. **`.ino` 编译要给 clangd 显式 `-x c++`**（CDB 里的 `--driver-mode=g++` 对 clangd 无效）。
8. **LSP 请求超时别用 30s**：ESP32 首次建头文件索引要十几秒，编辑器侧透传 60s。
9. **ESP32 `Serial.` 成员补全为空是 core 特性**（全局对象声明在 .cpp），演示要用 `HardwareSerial mySerial(1); mySerial.`。
10. **不要谎称"新增"**：动手前先 grep 是否已存在。
11. **误报比漏报更烦人**：新增扫描/断言先自证不误报，再信它。

---

## 13. 关键文件索引

| 位置 | 内容 |
|---|---|
| `src/main/index.ts` | 主进程全部 IPC、任务编排、热插拔、诊断埋点 |
| `src/main/services/toolchain.ts` | arduino-cli 封装：编译/烧录/板卡列表/**esptool 芯片探测** |
| `src/main/services/boardRegistry.ts` | **板卡唯一数据源**（新增板只改这里） |
| `src/main/services/build-diagnostics.ts` | 编译/烧录输出解析、阶段、Flash/RAM 摘要、芯片不匹配识别 |
| `src/main/services/diagLog.ts` | 测试信息收集（JSONL + 报告导出） |
| `src/main/services/crash-signature.ts` | 崩溃签名分析：panic/abort/assert/栈溢出/看门狗/掉电/内存不足 → **稳定签名**（丢弃栈指针）+ 小白可读建议 |
| `src/main/services/aiGateway.ts` | AI 网关（本地 + 云端 + BYOK） |
| `src/renderer/src/App.tsx` | 渲染层主编排：编译/烧录流程、预检、面板挂载 |
| `src/renderer/src/featureHints.ts` | 悬停功能介绍文案库 |
| `src/renderer/src/assets/theme.css` | **唯一颜色源**（渲染层不准出现 hex/rgb 字面量） |
| `src/main/plugins/pluginManager.ts` | 插件运行时核心：`runTool` 七通道统一执行器 + `getSkills`/`getTools` + 声明式工具自动注册 |
| `src/main/plugins/hostAdapter.ts` | 宿主能力暴露（`app.validateManifest`/`app.reloadPlugins`/`app.analyzeCrash`） |
| `src/main/plugins/validate-manifest.ts` | manifest 校验器（11 项；7 通道 transport；password 默认不可写死） |
| `src/main/plugins/settings-resolver.ts` | `{settings.*}` 占位符注入（密钥不硬编码、不随包分发） |
| `src/main/plugins/mqtt-bridge.ts` / `grpc-bridge.ts` / `mcp-bridge.ts` | MQTT / gRPC 动态 proto 反射 / MCP 通道桥接 |
| `resources/plugin-demo/plugin-dev-toolchain/` | **元插件三件套**（create/validate/install + 「创建插件」Skill） |
| `builder.full.config.json` | 出包配置（白名单 + asar:false + npmRebuild:false） |
| `start-labcode.bat` | 一键跑 `out/` 真实产物做真机测试（免打包） |
| `docs/插件架构/plugin-schema-draft.md` | plugin.json schema 草案（skills/tools/transports；7 通道含 mqtt；信任模型；元插件契约） |
| `scripts/check-*.mjs` | 各自检脚本（改完跑受影响的那几个） |
| `scripts/scan-ipc-handlers.mjs` 等扫描四件套 | 改 preload/main 通道后必跑，期望 0 命中 |
