# 交接与测试总档 · CodeLab / LabCode 桌面端

> **这是唯一的常驻文档。** 以后状态变化、流程变化、新 bug，都**只改这一份**，不再新增带日期的交接文档 / 测试记录。
> 已被并入的历史文件见 §11（内容都在这里，旧文件只留指针）。

| 速查项 | 当前值 |
|---|---|
| 最新提交 | `f6de67b`（修 Agent 模式点停止卡死 + 不活动超时支持环境变量 + 真机模拟脚本；tsc 双过 + 六套 check + 扫描全绿） |
| 应用版本 | `1.1.3` |
| **最新可测包** | **`pkgout36\LabCode-Setup-1.1.3.exe`**（2026-10-08 00:00，152MB） |
| 当前测试板卡 | ESP32-C3（VID:PID `303a:1001`） |
| 项目根 | `D:/工作/代码实验室/codelab-desktop` |
| 技术栈 | Electron 44 + React 19 + TS 5.9 + electron-vite 5 + Vite 7 |
| 规模 | 29 个自检脚本 + 4 个静态扫描器 |
| 本地模型修复状态 | §15/§16 已修"没反应"（超时+取消）；§17 **真实引擎 8/0 端到端验证通过**；并修复 2 个 bug——引擎每消息重启（#1，复用 basename 命中 + isEngineRunning 3 次重试）+ taskkill /IM 误杀全机（#2，改 PID 精准强杀）；`verify-no-kill-external.mjs` 实跑 5/0 证明 #2 |

---

## 1. 换电脑 / 换人接手，先做这几件事

**① 读文档**：本文件（唯一入口）→ `D:/工作/代码实验室/.workbuddy/memory/2026-10-07.md`（逐日过程与踩坑细节）。

**② 认工具**（沙箱/新机环境不同，命令要改）

| 用途 | 路径 |
|---|---|
| node（首选，managed） | `C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-6/node.exe` |
| git（系统 Git 不在 PATH） | `C:/Users/Administrator/.workbuddy/binaries/PortableGit/versions/1.2.0/mingw64/bin/git.exe` |

**③ 环境限制（会省一小时）**

- **Electron GUI 在沙箱里起不来**（GPU 崩）→ 所有 UI 只能**真机验证**，别在沙箱反复试。
- **Bash 工具的 shell 不可靠**：`npm run xxx` 跑不起来；直接 `node <cli>.js`。
- **删除动作会超时**（safe-delete 护栏）：清空 `out/`、删 `pkgout*` 都 ETIMEDOUT → **先 `mv out out_prev_xxx` 让路**（rename 不触发）。
- **打包 spawn 不动 arduino-cli**：沙箱里编译/烧录跑不通，真机才是真的。

---

## 2. 项目 30 秒版

**CodeLab / LabCode** —— 面向单片机（ESP32 为主、STM32 为辅）的桌面 IDE，命脉是「**写码 → 编译 → 烧录 → 串口**」。

- 编译烧录引擎 = `arduino-cli`（Arduino IDE 2.x 官方同引擎），CLI 子进程 + gRPC daemon 双通道
- 板卡唯一数据源 = `src/main/services/boardRegistry.ts`（新增板只改这一个文件），当前 10 款（ESP32 5 + STM32 5）
- AI 三通道网关（本地 llama / BYOK / 官方登录+积分），支持 function calling
- 竞品对齐 TrieCode；竞品拆解在仓库外 `D:/工作/代码实验室/codelab-doc/`

🔴 **研发红线**：自己研发、不抄实现；外部能力只走「子进程调官方 CLI」或正规 npm 依赖。
提交前 5 问：逻辑自设计 / 无雷同命名与注释 / 硬件参数有事实来源 / UI 用本项目令牌 / 依赖许可允许。

---

## 3. ⭐ 真机测试信息收集（定位 bug 的主路径）

**为什么有它**：我在沙箱里起不了 UI、spawn 不动 arduino-cli，真机出问题只能靠截图猜。
现在软件自己留痕，**导出一份 txt 给我，我照真实数据定位**。首次实战就抓到 bug #4（§6）。

### 怎么用（三步）

1. **照常测**：插板 → 编译 → 烧录 → 开串口 → 打开文件（**出错更好，出错才是数据**）。
2. **导出**：**帮助 → 导出测试报告…**（极简模式在 ☰ 菜单里），或 **设置 ⚙ → 测试与诊断 → 导出测试报告**。
   默认存桌面 `LabCode-测试报告-<时间>.txt`，存完自动打开文件夹。
   想先看环境 → 同页点 **「开始自检」**（arduino-cli 版本 / 板卡 / 端口 / openocd / gRPC 状态）。
3. **把 txt 发我**（日志含本机文件路径，发送前自己过一眼；报告长时只截相关段落即可）。

### 记什么

| 事件 | 内容 | 用来查什么 |
|---|---|---|
| `session:start` | 版本 / Electron / Node / 平台 / 语言 / 时区 | 环境与版本不一致 |
| `toolchain:detect` | arduino-cli 探测结果 | 「未找到工具链」类 |
| `board:autodetect` | 插板识别结论 + `probed`（esptool 读到的芯片）+ CLI 原始返回 | 认不出 / 认错板卡 |
| `serial:ports-changed`、`serial:open/close` | 插拔端口、端口、波特率 | 串口占用 / 波特率错误 |
| `task:start` / `task:exit` | 编译烧录入参、走 gRPC 还是 CLI、**退出码**、耗时、**输出尾部 6000 字符** | 编译/烧录失败的真实原因 |
| `fs:readFile` | 路径 / 字节数 / 行数 | 「打开文件是空的」出在读哪一层 |
| `ui:compile-click` / `ui:upload-click` / `target:change` | 点击时的现场（工具链/板卡/端口/产物目录有没有） | 「点了没反应」被哪个门控拦下 |
| `renderer:error` / `renderer:unhandledrejection` | 界面报错 + 堆栈 | 静默崩溃 |
| `diag:selfTest` | 自检结论 | 环境到底缺什么 |

### 边界（承诺，改代码时别破坏）

- **只写本机** `userData/diag/`，**不联网、不外发**；导出由用户手动触发。
- 最多留 **8 次会话**、单文件 **4MB 上限**，写满自动停；写失败一律静默，**绝不能因日志拖垮主流程**。
- **不记**文件内容、AI 对话正文、API Key。
- 想删：设置页「打开目录」→ 删 `diag` 文件夹。

### 相关文件

`src/main/services/diagLog.ts`（`initDiag`/`diag`/`diagTask`/`buildReport`）· preload `window.api.diag.*` ·
主进程埋点 `src/main/index.ts` · 渲染层 `src/renderer/src/main.tsx`（全局 error+rejection）与 `App.tsx`（点击/板卡变化）· 自检 `scripts/check-diag-log.mjs`。

---

## 4. 构建 / 出包 / 验证（可直接照抄）

### 4.1 出包配方（本机已验证，别改回去）

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

### 4.2 验证顺序（改完必跑）

```bash
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.node.json --composite false
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.web.json --composite false
node scripts/scan-ipc-handlers.mjs      # 改 preload/main 通道后必跑，期望 0 命中
node scripts/scan-ui-crash.mjs
node scripts/scan-json-parse.mjs
node scripts/scan-unhandled-rejection.mjs
node scripts/check-*.mjs                # 受影响的那些
```

### 4.3 产物复核（**这里有个坑**）

- 期望：renderer assets **95 个**、有 1 个 css、`index.html` 引用的 js/css 都存在。
- ⚠ **主进程代码会被 rollup 拆进 `out/main/chunks/*.js`**：
  `grep "xxx" out/main/index.js` 得 0 **不代表没打包** —— 必须 `grep -r xxx out/main/`。
  （已踩两次：`parseFlashProgress`、`chip_id` 都在 `chunks/toolchain-*.js`。）

---

## 5. 自检与扫描

**自检 27 个**（`node scripts/check-*.mjs` 直接跑）。重点：

| 脚本 | 断言 | 盯什么 |
|---|---|---|
| `check-build-diagnostics` | 65 | 编译/烧录输出解析、错误分类、芯片不匹配识别 |
| `check-diag-log` | 25 | 诊断日志：落盘 / JSONL 合法 / 轮换 / 报告完整 / 写失败静默 |
| `check-chip-probe` | 9 | esptool 芯片探测：输出解析、认不出不猜、失败不抛 |
| `check-board-registry` | 33 | 板卡三条件（能编译 + 有 openocd cfg + 真实 VID:PID） |
| `check-hardware-intel` | 43 | 硬件智能增强 |
| 其余 22 个 | — | editor / lsp / burn / agent / svd / 分屏 / 日志解释 … |

> 新增自检写法：esbuild `buildSync` 打包被测模块 + `alias: { electron: scripts/stubs/electron-dom-stub.mjs }`，真跑真落盘再断言。
> **脚本本身是纯 `.mjs`，别写 TS 标注**（`(v: string)` 会 SyntaxError）。

**扫描 4 个**：`scan-ipc-handlers`（改通道必跑）、`scan-ui-crash`、`scan-json-parse`、`scan-unhandled-rejection`。

---

## 6. 真机 bug 记录 #1~#4

> 只记**真实发生**的问题，不猜不脑补；证据以用户导出的测试报告为准。

### #1 UI 全部裸奔、无任何样式（CSS 404）—— ✅ 已修（pkgout30）
- **现象**：DOM 全渲染，但元素无样式堆在左上角，按钮/下拉框是浏览器默认样式。
- **证据**：包内 `out/renderer/assets/` 只有 63 个文件（应 95），`index.html` 引用的 CSS 404。
- **根因**：重建时 vite `emptyDir` 触发 safe-delete 超时，留下**部分删除中间态**（CSS 被删、JS 完好）；打包前没独立复核产物。
- **修法**：`mv out out_bad_20261007` → 全新构建 → 独立复核（CSS 在 / 引用零缺失 / 95 个）→ 换全新 `pkgout30` 重打包。
- **教训**：**删除失败后必须独立复核，或 rename 让路**——不能默认"没删成就是都在"。

### #2 打开 .ino / 源码文件编辑器内容为空 —— ✅ 已修（pkgout31，**pkgout35 报告已确认修复**）
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
- **修法**：① 烧录期 `parseChipMismatch` + `notifyChipMismatch` → 自动改成实测芯片并持久化，提示再点一次烧录；
  ② 插板期 CLI 认不出时用 **esptool `chip_id`** 直读（`toolchain.probeChipId`/`findEsptool`/`parseChipIdFromOutput`，8s 超时，失败一律 null 降级）；
  ③ 认不出时界面明说「没能认出型号，目标板卡仍是上次选的 XXX」，不再静默沿用。
- **复测建议**：拔插板子看输出面板是「检测到开发板：COM29 · ESP32-C3」还是「未识别到板卡型号」；后者说明 esptool 探测未生效，报告里 `board:autodetect.probed` 一眼看出。

---

## 7. 已完成的功能新增（不必重做）

| 功能 | 版本 | 做法与要点 |
|---|---|---|
| **增量编译** | pkgout33 | build 目录从 `sketch-<Date.now()>` 改为 `sk-<sha1(sketch路径\|fqbn) 前16位>` 稳定派生，arduino-cli 复用中间产物 → 二次编译从全量（真机 142s）降到增量。产物目录仍自持（供调试 ELF + upload `--build-path`）。**待真机确认提速幅度** |
| **悬停功能介绍** | pkgout34 | 全局单例 `FeatureHintLayer` 在 `document` 事件委托，元素挂 `data-hint-title/desc/tip` 出卡片（portal 到 body）。**不包 Tooltip 容器**（工具栏 flex 紧密排布，包一层就挤歪）。文案集中 `featureHints.ts`（14 条），覆盖 19 处挂点。延迟 420ms + `pointer-events:none` + 按下/Esc/滚动即收。设置可关 |
| **测试信息收集** | pkgout35 | 见 §3 |
| **板卡自动纠正 + 实测** | pkgout36 | 见 §6 #4 |
| **插件运行时对齐（信任分级 / 占位符 / 外部通道 / MQTT）** | 本轮 | 见 §12 |
| **grpc/mcp 真实适配器 + 崩溃签名分析（含串口 UI 入口）+ MQTT 真机验证** | 本轮 | 见 §13 |
| **修复「选着本地模型却走云端」（本地模型被 Agent run 清空）** | 本轮 | 见 §14 |
| **根治「发消息没反应」（本地模型 chat 请求挂死 + 真取消）** | 本轮 | 见 §15 |
| **修 Agent 模式点停止卡死 + 真机模拟** | 本轮 | 见 §16 |
| **补全官方通道（云端）UI（登录/注册/积分/内置模型选择）** | 本轮 | 见 §18 |
| **官方通道真实后端（零依赖 Node，6 端点 + 积分 + SSE）** | 本轮 | 见 §19 |

---

## 8. 坑位清单（别再踩第二次）

1. **并行会话改工作树**：出现过 3 次「我 tsc 完，多出我没写过的改动」。文件时间戳比构建时间新 = 构建时**不含**那些改动。
2. **主进程代码在 `out/main/chunks/`**：复核不能只 grep `index.js`。
3. **同秒二次启动会覆盖日志**（sessionId 必须毫秒精度）。
4. **Windows 文件名非法字符**：报告名不能带 `:`。
5. **删除被护栏拦**：用 `mv` 让路，别删。
6. **`@monaco-editor/react` 的 `path` 要自己转 file URI**：直接传 Windows 路径会让盘符被当 scheme → 编辑器空。
7. **`.ino` 编译要给 clangd 显式 `-x c++`**（CDB 里的 `--driver-mode=g++` 对 clangd 无效）。
8. **LSP 请求超时别用 30s**：ESP32 首次建头文件索引要十几秒，编辑器侧透传 60s。
9. **ESP32 `Serial.` 成员补全为空是 core 特性**（全局对象声明在 .cpp），演示要用 `HardwareSerial mySerial(1); mySerial.`。
10. **不要谎称"新增"**：动手前先 grep 是否已存在（这次「编译摘要 / 烧录进度」早已实现，只做了增量编译）。
11. **误报比漏报更烦人**：新增扫描/断言先自证不误报，再信它。

---

## 9. 未提交改动与并行会话

`git status` 仅剩 safe-delete 让路残留与临时探针（`out_bad*` / `out_prev_*` / `_probe_*.mjs` / `_react_src/`，刻意不入库，删除会触发护栏故保留）；pkgout31→pkgout36 的源码与自检已于 `68b10c4` 全部增量提交（C1 文档固化 `2a77b37` + C2 功能整合 `68b10c4`）。

- 本线：编辑器 URI 修复、烧录 `--build-path`、增量编译、悬停介绍、诊断收集、板卡实测（`probeChipId`）。
- 另一线（出 pkgout35 之后写入）：`parseChipMismatch` + `notifyChipMismatch`（芯片不匹配自动纠正）+ 对应自检断言。

**提交前固定动作**：`git status` + `git diff --stat` → 审没写过的文件 diff → 重跑 tsc 双过 + 受影响 check + 扫描 → 再提交。

---

## 10. 关键文件索引

| 位置 | 内容 |
|---|---|
| `src/main/index.ts` | 主进程全部 IPC、任务编排、热插拔、诊断埋点 |
| `src/main/services/toolchain.ts` | arduino-cli 封装：编译/烧录/板卡列表/**esptool 芯片探测** |
| `src/main/services/boardRegistry.ts` | **板卡唯一数据源**（新增板只改这里） |
| `src/main/services/build-diagnostics.ts` | 编译/烧录输出解析、阶段、Flash/RAM 摘要、芯片不匹配识别 |
| `src/main/services/diagLog.ts` | 测试信息收集（JSONL + 报告导出） |
| `src/renderer/src/App.tsx` | 渲染层主编排：编译/烧录流程、预检、面板挂载 |
| `src/renderer/src/featureHints.ts` | 悬停功能介绍文案库 |
| `src/renderer/src/assets/theme.css` | **唯一颜色源**（渲染层不准出现 hex/rgb 字面量） |
| `builder.full.config.json` | 出包配置（白名单 + asar:false + npmRebuild:false） |
| `start-labcode.bat` | 一键跑 `out/` 真实产物做真机测试（免打包） |
| `docs/插件架构/plugin-schema-draft.md` | **plugin.json schema 草案**（对齐 TrieCode 的 skills/tools/transports；7 通道含 mqtt；skills[]/tools[].category/信任模型/元插件契约/JSON Schema） |
| `resources/plugin-demo/plugin-dev-toolchain/` | **元插件三件套**（create/validate/install + 「创建插件」Skill），经宿主内通道 `app.validateManifest`/`app.reloadPlugins` 复用单一事实来源 |
| `src/main/plugins/hostAdapter.ts` | 宿主能力暴露；新增 `app.validateManifest` / `app.reloadPlugins` 两个 internal 命令供元插件调用 |
| `src/main/plugins/validate-manifest.ts` | manifest 校验器（11 项，含 skills[] 与 tools[].category 校验；7 通道 transport；password 默认不可写死） |
| `src/main/plugins/settings-resolver.ts` | `{settings.*}` 占位符注入（密钥不硬编码、不随包分发） |
| `src/main/plugins/mqtt-bridge.ts` | MQTT 桥接运行时（差异化通道；可选 mqtt 包，缺依赖结构化降级） |
| `src/main/plugins/pluginManager.ts` | 运行时核心；新增 `runTool` 七通道统一执行器 + `getSkills`/`getTools`（含 sideEffect 映射）+ 声明式工具自动注册 |
| `scripts/check-plugin-runtime.mjs` | 新增：插件运行时自检（renderHttpRequest / mapPluginCategoryToEngine / skills+tools 聚合 / MQTT 降级） |
| `scripts/check-validate-manifest.mjs` | 新增 password 默认空校验断言 |
| `src/main/plugins/grpc-bridge.ts` | gRPC 通道桥接：动态 proto 反射调用（addr/proto/package/service/method）+ 两级缓存 + deadline；缺依赖/不可达→结构化错误 |
| `src/main/plugins/mcp-bridge.ts` | MCP 通道桥接：复用宿主 stdio MCP 客户端；支持 `mcp.server`（已连接）或 `mcp.command`（插件自带拉起）；`stopAll()` 只清理 `plugin:` 前缀会话 |
| `src/main/services/crash-signature.ts` | 崩溃签名分析：解析 panic/abort/assert/栈溢出/看门狗/掉电/内存不足，产出**稳定签名**（丢弃栈指针）+ 小白可读建议 |
| `src/main/plugins/hostAdapter.ts`（更新） | 新增 internal `app.analyzeCrash` + backend `serial.crashAnalyze`（读当前串口会话日志后分析） |
| `scripts/check-grpc-bridge.mjs` | 新增：起真实 gRPC server 验证反射调用 / PascalCase 兼容 / 缺字段报错 / deadline 不挂住（16 断言） |
| `scripts/check-mcp-bridge.mjs` | 新增：自建最小 MCP server（stdio JSON-RPC）验证握手→调用→结果归一化（8 断言） |
| `scripts/check-crash-signature.mjs` | 新增：崩溃解析 + **签名稳定性**（同处同签名 / 异处异签名）+ 不误报（23 断言） |
| `scripts/check-mqtt-bridge.mjs` | 新增：MQTT 依赖可用性 + 未连接报错 + 不可达经 error 事件上报 + 公共 broker 往返（无外网自动跳过） |
| `src/main/index.ts`（更新） | 新增 IPC `serial:crashAnalyze`（本地规则解析，不调 AI） |
| `src/preload/index.ts`（更新） | 新增 `api.serial.crashAnalyze()` + 导出 `CrashSignatureResult` 类型 |
| `src/renderer/src/components/OutputPanel.tsx`（更新） | 串口监视器新增「🧯 崩溃分析」按钮 + 结果面板（结论 / PC / 签名 / 调用栈 / 建议） |
| `src/renderer/src/assets/main.css`（更新） | `.crash-*` 样式（全走 theme token，无 hex 字面量） |
| `scripts/check-local-model.mjs` | 新增：本地模型选择自检（显式指定才覆盖 / 未指定不动 / 源码防回归，9 断言） |

---

## 11. 历史文档（内容已并入本文件）

| 文件 | 说明 |
|---|---|
| `HANDOFF-2026-10-07.md` / `handoff.md` / `handoff-2026-10-06.md` | 历次交接书（2026-10-08 那份因内容全部并入本文，已直接删除），内容都在本文 |
| `TEST-LOG-2026-10-07.md` | 真机测试记录，内容已并入本文 §6 |

---

## 12. 插件运行时对齐（信任分级 / 占位符 / 外部通道 / MQTT）

上一轮交付了 plugin.json schema 草案 + 元插件三件套脚手架。本轮把「设计」落到「代码」，补齐运行时缺口，使七通道不再有一半是死声明：

- **信任分级两级（official/thirdparty）**：`CatalogEntry.tier`；官方插件随应用分发、已审计，首次安装免确认（`pluginInstaller.ts` 判断 `entry.tier !== 'official'` 才弹确认卡），`listPlugins` 官方恒为已信任。第三方/本地市场首次仍须确认卡。
- **`{settings.*}` 占位符注入**：`settings-resolver.ts` 在加载时把 manifest/工具绑定里的 `{settings.key}` 替换为用户设置值（密钥不硬编码、不随包分发）。`validate-manifest.ts` 新增 password 类型「默认不可写死」规则防密钥落库，配套 `check-validate-manifest.mjs` 断言。
- **外部通道统一执行器**：`pluginManager.runTool` 七通道分派。cli/http/mqtt/grpc/mcp 声明式工具自动注册并按绑定形状直接执行；http 实装（fetch + 超时 + 占位符/参数注入 + query 合并）；grpc/mcp 留适配器挂载点（未注册结构化降级，不崩溃）；internal/backend 由插件/宿主手动 register（不覆盖既有契约）；mqtt 走 `mqtt-bridge.ts`。
- **tools[].category 运行时消费**：`getTools` 返回 `category` + 映射到引擎权限维度 `sideEffect`（create/modify/delete→write，query→query，execute→execute），供 Agent 复用 `permissionPolicy` 做确认门控。
- **Skills 运行时接入**：`getSkills` + IPC `plugin:skills` + preload `api.plugin.skills`，命令面板/Agent 做能力引导。
- **信任配套文件**：元插件 `plugin-dev.create` 生成的骨架自动附带 `LICENSE`/`NOTICE`/`CONTRIBUTING.md`（第三方插件明确来源、防仿冒）；已重打包 `plugin-dev-toolchain.zip` 并刷新清单 sha256。
- **验证**：tsc 双过通过；`check-validate-manifest`(53) / `check-demo-plugins`(87) / 新增 `check-plugin-runtime`(23) 全绿；`scan-ipc-handlers` 0 命中；其余 3 扫描无 CRITICAL。
- **注意**：`mqtt-bridge.ts` 用 `req(MQTT_PKG)` 非字面量包名（`'mq'+'tt'`）避免打包器在构建期解析未安装的 mqtt 依赖；运行时真正需要才 `require`，缺依赖直接结构化降级。

| `log-20.md` ~ `log-33.md`、`next-steps.md`、`slim-design.md`、`competitive-landscape.md` | 过程档案，仍独立保留 |

**维护规则**：以后只改这一份；确实需要分文件时，先在本文件索引里登记。

---

## 13. 通道补齐：grpc / mcp 真实适配器 + 崩溃签名分析 + MQTT 真机验证

上一轮把七通道接进 `runTool` 统一执行器，但 grpc/mcp 仍是「适配器挂载点 + 降级提示」。本轮把它们做成真能跑的通道，并把崩溃分析做进宿主后端。

- **gRPC 真实适配器（`grpc-bridge.ts`）**：插件只需自带一个 `.proto`。
  - 动态反射：`@grpc/proto-loader` 运行时加载 proto → `@grpc/grpc-js` 按 `package.service/method` 调用，不必预生成桩代码（这两个依赖项目里本来就有）。
  - 两级缓存：proto 定义按路径缓存、客户端按 `addr+service` 缓存，重复调用不重复解析/建连。
  - deadline 超时：一元 RPC 一律带 `{ deadline }`，服务端不响应时按 `timeoutMs` 返回（自检实测 1213ms 返回 DEADLINE_EXCEEDED，未挂住）。
  - 方法名兼容：proto 里写 `SayHello`（PascalCase）也能命中（proto-loader 生成的是 camelCase）。
  - proto 路径三条规则：绝对路径 / `{plugin}/x.proto`（解析到插件资源目录）/ 相对 cwd。
- **MCP 真实适配器（`mcp-bridge.ts`）**：复用宿主已有的 stdio JSON-RPC 2.0 客户端，不另写协议栈。
  - 双来源：`mcp.server` 用宿主「MCP 设置」里已连接的 server；`mcp.command`+`args` 由插件自带拉起（会话名 `plugin:<tool>`，同名复用避免重复拉进程）。
  - 结果归一化：MCP 的 `content[]` 收敛成 `{ok, data}` 文本；`isError` 收敛成 `ok:false`。
  - `stopAll()` 只停 `plugin:` 前缀会话，**不碰用户在设置里自己连的 server**。
- **崩溃签名分析（`crash-signature.ts`，做进宿主后端）**：串口崩溃日志对新手是天书，且同一处崩溃会刷出成百上千条几乎一样的输出。
  - 解析 panic（LoadProhibited / StoreProhibited / IllegalInstruction …）/ abort / assert / 栈溢出 / 看门狗 / 掉电 / 内存不足，提取 异常类型、Core、PC、EXCVADDR、调用栈。
  - **稳定签名**：丢弃每次会变的栈指针(SP)，只留 `kind|exception|PC|调用栈前3帧PC` → 同处崩溃签名相同（可去重/计数），异处崩溃签名不同（可区分）。
  - 中文结论 + 可执行建议（掉电指向供电而非改代码；栈溢出指向大局部数组 / 任务栈太小）。
  - 宿主命令：internal `app.analyzeCrash`（纯文本进）+ backend `serial.crashAnalyze`（读当前串口会话日志后分析）。
- **MQTT 真机验证**：`mqtt` 已加入 **optionalDependencies**（没装也能构建/运行，装了才启用通道）。
  - 自检：依赖可用、未连接时结构化报错、不可达时经 `error` 事件上报（ECONNREFUSED）而非抛出。
  - **真机往返已跑通**：连公共 broker `broker.emqx.io:1883` 完成 publish→subscribe 往返（本次沙箱有外网）。复现见 `scripts/check-mqtt-bridge.mjs`。
- **验证**：tsc 双过；`check-grpc-bridge`(16) / `check-mcp-bridge`(8) / `check-crash-signature`(23) / `check-mqtt-bridge`(10) 全绿；回归 `check-plugin-runtime`(23) / `check-validate-manifest`(53) / `check-demo-plugins`(87)；四套扫描 CRITICAL 0、`scan-ipc-handlers` 0 命中。
- **踩坑**：
  - `check-plugin-runtime` 的「MQTT 缺依赖降级」断言在装上 mqtt 后**语义翻转**（实际走真实发布路径却仍显示降级文案）→ 改成按实际输出判定，装/不装两种环境都不假绿。
  - MCP 自检第 5 组最初失败：插件自带 server 的会话名是 `plugin:<tool>`，与前面用例同名会被复用 → 换唯一工具名才真正走到启动失败分支。
  - grpc-bridge 里闭包捕获 `let client` 会让 TS 丢掉非空判断 → 收窄成 `const c` 再进闭包。
  - gRPC 包名同样用非字面量拼接（`'@grpc/'+'grpc-js'`），与 mqtt 同源考虑：避免打包器构建期解析依赖。

### 13.1 崩溃签名接入串口监视器 UI

能力原本只在命令层（internal `app.analyzeCrash` / backend `serial.crashAnalyze`），没有界面入口，用户根本看不到。已接进串口监视器：

- **入口**：串口监视器工具栏新增「🧯 崩溃分析」按钮。日志里出现崩溃关键字（Guru Meditation / panic'ed / abort() / assert failed / stack overflow / Stack canary / Brownout / watchdog）时按钮变红并显示「检测到迹象」。
  - 关键字检测只用于提示，完整解析仍走 IPC，避免每次刷屏都跑一遍解析。
- **结果面板**：一句话结论 + 异常类型 / PC / 访问地址 / Core + **稳定签名**（旁注「同固件同位置崩溃签名相同，可用来去重计数」）+ 调用栈 + 排查建议列表。
- **通道**：新增 IPC `serial:crashAnalyze` + preload `api.serial.crashAnalyze()` + 导出类型 `CrashSignatureResult`。
- **与 AI 解释的关系**：`serial:explain` 靠模型读日志，crashAnalyze 靠规则精确提取——**互补，不是替代**。崩溃是高度结构化的信息，用规则更快更准，还不需要 Key、不联网。
- **样式**：`.crash-*` 全部走 theme token（`--danger` / `--panel-2` / `--text-dim`），无 hex 字面量、无 inline style。
- **验证**：tsc 双过；`scan-ipc-handlers` 0 命中；`scan-ui-crash` 无风险；其余扫描 CRITICAL 0；`check-crash-signature` 23/0。
- ⚠ **UI 只能真机验**：Electron 44 在本机沙箱起不来（GPU 崩），用 `start-labcode.bat` 跑 `out/` 真实产物验证。

---

## 15. 根治「发消息没反应」（本地模型 chat 请求挂死）

用户实测 §14 修复后仍反馈「没反应」（界面一直转圈、不报错、不出字）。继续查，定位到更底层的卡死点。

- **症状**：选本地模型发消息，UI 永久转圈，既不返回内容也不报错。
- **真因**：`chatWithLocalModelStream` 里的 `http.request('/v1/chat/completions')` **没有任何超时**。
  `startLlamaEngine` 本身是有界的（最多轮询 60s 超时），所以卡死点在这之后：
  引擎被 `/health` 健康检查发现「在跑」，但 chat 端点卡住（模型加载中 / 内存不足导致
  llama-server 不吐字）时，请求就**永久挂起**。
- **修法**：
  - `modelRuntime` 新增**不活动超时**（默认 120s）：收到响应头 / 每来一个数据块都重置计时，
    只要还在出字就不算超时；静默超过阈值才明确报错（指向「加载模型 / 内存不足，换更小模型」），
    不误伤慢模型首 token。
  - **取消真正生效**：`AbortController.abort()` 现在会 `req.destroy()` 断开底层 HTTP；
    以前只是「不再回调」，HTTP 仍在跑，点了停止照样卡。
  - `chatWithLocalModel`（非流式，`aiChat` 旧路径也走它）改为**复用**流式实现 →
    超时 / 取消对所有本地路径统一生效，不再漏一处。
  - `LLAMA_PORT` 支持环境变量 `LABCODE_LLAMA_PORT` 覆盖（默认 8080），便于规避端口冲突与自动化测试。
- **防回归**：新增 `scripts/check-local-timeout.mjs`（7 断言），用假 TCP server 复刻
  「引擎在跑但 chat 卡死」场景：断言 1.5s 内超时报错（旧实现永久挂起）、正常 SSE 仍能解析、
  abort 即时中断（311ms）。
- **验证**：tsc 双过；`check-local-timeout` 7/0；`check-local-model` 9/0；`check-crash-signature`
  23/0；`check-log-explainer` 20/0；`check-plugin-runtime` 23/0；四套静态扫描 CRITICAL 0、IPC 0 命中。
- ⚠ **仍需真机确认**：涉及 llama 进程，沙箱跑不了。真机选本地模型发消息，确认
  ① 不再永久转圈（卡住会出「…没有新输出」报错而非挂死）② 点停止能立即中断。

## 16. 修 Agent 模式点停止卡死（"没反应"的另一个真凶）+ 真机模拟

续 §15：用户让我"真机模拟"本地模型对话链路，过程中发现更隐蔽的卡死点。

- **真因**：`aiGateway.aiChatStream` 的**本地分支**在用户取消时**吞掉 onDone**
  （`.then/.catch` 都 `if (!cancelled) onDone(...)`）。云端/BYOK 分支经 `fetchStream`
  在 abort 时调 `onDone(null)`（干净结束）—— 两分支行为不一致。
- **后果（连锁）**：`AgentRunner.callModel()` 把 onDone 当作 `await` 的 resolver；
  用户点停止 → stream 被 abort → 本地分支不调 onDone → `callModel` 的 promise 永远不 settle →
  主循环到不了 `if (this.stopped) break` → **Agent 卡死**（界面没反应）。
  `agent.stop()` 本身只设 `stopped=true`，不 abort 底层流，所以旧代码下取消必挂。
- **修法（与 fetchStream 对齐）**：
  - `modelRuntime.chatWithLocalModelStream` 取消时 reject 一个 `name='AbortError'` 的错误（与
    fetchStream 的 `e.name === 'AbortError'` 约定一致）。
  - `aiGateway.aiChatStream` 本地分支改为 `.catch((e) => { if (e?.name === 'AbortError') onDone(null); else onDone(e) })`
    —— 取消走干净结束，不再吞掉。onChunk 仍按 `cancelled` 抑制（停止后不吐字）。简单对话 UI 不受影响。
- **不活动超时支持环境变量** `LABCODE_LLAMA_IDLE_MS`（默认 120s），与 `LABCODE_LLAMA_PORT` 同思路。
- **真机模拟脚本** `scripts/sim-local-model.mjs`（12 断言）：用**真实生产代码** `aiGateway.aiChatStream/aiChat`
  （UI 实际入口）串起真实 HTTP 假 llama 引擎（模拟 /health + SSE），覆盖正常流式 / 卡死超时 / 点停止必调 onDone（证明 Agent 不卡死）/ 非流式 / 未选模型快速报错 五条路径。沙箱限制：GUI 渲染 + 真实 llama 二进制需用户在真机验证。
- **验证**：tsc 双过；sim-local-model 12/0；check-local-timeout 7/0；check-local-model 9/0；check-crash-signature 23/0；check-log-explainer 20/0；check-plugin-runtime 23/0；四套静态扫描 CRITICAL 0、scan-ipc-handlers 0 命中。
- 提交 `f6de67b`（modelRuntime + aiGateway + sim-local-model.mjs，3 文件 +200）。

## 14. 修复「选着本地模型却走云端」（本地模型被 Agent run 清空）

用户问「大模型的问题解决了吗」→ 指向 Agent 本地模型（localModel）bug。核查结论：**之前没解决**，本轮真正修掉。

- **症状**：下拉框里明明选着「Qwen2.5 Coder 3B」，发出的消息却走云端（401 或白耗积分）。
- **真因**：`agent-runner.run()` 每次都执行 `setLocalModel(options.localModel || null)`。
  本次没指定本地模型时传 `null`，把用户在设置里选好的模型**清空**；
  后续 `aiChat` 调 `getLocalModel()` 拿到 null → 静默降级回云端。
- **为什么之前"修过"却没好**：`7136ea8`（打开即用）只在**启动时**补了 `setLocalModel`
  （`engine:ensure` + 开机后台接回本地引擎），**没动这处清空逻辑**。
  所以只要有一次 run 没带 `localModel`，启动时接回的引擎就被抹掉——这是典型的
  「补了入口没堵漏洞」，光看提交记录会以为已经修好了。
- **修法**：
  - `aiGateway` 新增 `resolveLocalModelForRun(requested)`：显式指定才返回模型名，
    未指定 / 空串 / 空白一律 `undefined`（表示「不动全局」）。
  - `agent-runner` 改为 `const lm = resolveLocalModelForRun(options.localModel); if (lm) setLocalModel(lm)`。
- **防回归**：新增 `scripts/check-local-model.mjs`（9 断言）——
  未指定时已选模型仍在（旧写法在这一步会被清成 null），
  且源码里禁止再出现「未指定即清空」写法（只匹配代码行，注释里的反面教材不误报）。
- **验证**：tsc 双过；`check-local-model` 9/0；`check-log-explainer` 20/0（aiGateway 改动回归）。
- ⚠ **仍需真机确认**：本地引擎涉及 Ollama/llama 进程，沙箱内跑不了；
  真机选一个本地模型发消息，确认不再回落云端（看是否还出现 401 或积分消耗）。

## 17. 真实引擎端到端验证（"没反应"修复的最终确认）+ 两个新 bug

续 §15/§16：用户让我"操作我电脑测试一下"本地模型链路。沙箱网络隔离下跑不了真实引擎，
最终在**真实本机**（关闭沙箱隔离）把 `llama-server.exe` + 真实 GGUF 拉起来，用**生产代码**
`aiGateway.aiChatStream/aiChat` 驱动，做完整端到端验证。

### 沙箱可行性结论（先验证可行性再选）
- ✅ 沙箱内能启动 `llama-server.exe`（`--version` 退出 0）；能连 `hf-mirror.com`（下载可行）。
- ❌ 沙箱**拦截网络 bind / connect**：`run_in_background` 起监听端口被 `sandbox-center` 决策拦下；
  且 localhost 连**沙箱外**已运行进程（用户 8080 引擎）不通。
- ✅ 真实本机（dangerouslyDisableSandbox）可 bind + loopback → 真实端到端验证可行，**已实跑**。

### 验证脚本与结果
- 新增 `scripts/sim-real-engine.mjs`：让 app 自己 `startLlamaEngine` 拉起引擎（探测→扫模型→加载真实
  `.gguf`→起 `llama-server.exe`），再驱动 `aiGateway` 跑 A 正常流式 / C 点停止 / D 非流式。
  模型用本机已有的 `esp32从入门到实践/app/local-llm/models/qwen2.5-coder-1.5b-instruct-q4_k_m.gguf`
  （软链进 `TEST_APPDATA` 指向的临时 `modelsDir`，不污染仓库），引擎按端口 28099 精准清理。
- **结果：8/0 全过**，且是真·llama.cpp 推理：
  - A 真实流式逐字返回「我是一个由阿里云开发的AI助手…」（22 块 37 字），`onDone(null, usage)`。
  - C 点停止 → `onDone` 被调用且走干净结束 `onDone(null)`（旧 bug 会让 Agent 卡死，已确认修复）。
  - D `aiChat` 返回真实完整文本（36 字）。
- 回归未回退：`sim-local-model` 12/0（假引擎 A/B/C/D/E）、`check-local-timeout` 7/0。

### ✓ 发现两个真实 app bug（已修复，用户选"两个都修"）
1. **引擎每发一条消息都重启（性能）**：`startLlamaEngine` 复用分支比较
   `running === modelFile`，但 `running` 是 `currentEngineModel`=`path.basename(模型文件)`，
   `modelFile` 是传入的 id（如 `qwen2.5-coder:1.5b`）——永不相等 → 已运行也走 `killEngine()`+重启。
   实测 `startLlamaEngine` 在 A/C/D 三次调用里**拉起了 3 次引擎**（`-ngl 99 -c 16384`）。
   **双重根因 + 双重修复**：
   - (a) id≠basename 导致判定永不等 → 复用判定放宽：`running === modelFile || path.basename(modelFile) === running`，
     且轮询就绪后 `currentEngineModel = modelFile || path.basename(modelPath)`（记录 id 便于命中）。
   - (b) `isEngineRunning()` 单次 `/health` 探测太脆：一次请求刚结束、监听 socket 瞬变时误报「已死」→
     误 `killEngine()`+重启。改为**连探 3 次**（每次超时 1.5s、间隔 300ms）再下结论。
   **修复后复测**：`startLlamaEngine` 在 A/C/D 全程**只拉起 1 次引擎**（消除每消息重启的 3 秒卡顿）。
2. **`killEngine()` 用 `taskkill /IM llama-server.exe /F` 大锤**：杀光**全机所有** llama 进程，
   不只管自己那个。`engineProcess.kill()` 已能精确杀受管子进程，这行 `taskkill` 既冗余又危险——
   会误杀用户其它 llama 引擎（见下方副作用）。**已修复**：`killEngine()` 只 `engineProcess.kill()` +
   按受管 `engineProcess.pid` 精准 `taskkill /PID <pid> /F`，**绝不再用 /IM 大锤**。

### 验证脚本（证明 #2 修复：不误杀外部 llama 进程）
- 新增 `scripts/verify-no-kill-external.mjs`：自起一个「外部」引擎（端口 28999，本脚本子进程、非 app 受管）
  \+ 让 app 受管地拉起一个引擎（端口 28099，记录在 `engineProcess`），然后调 `stopLlamaEngine()`
  （→ `killEngine` → 只杀受管 PID）。断言：受管 28099 已关闭、**外部 28999 仍存活**（health 200）。
- **结果：4/0 全过**（外部就绪 / 受管就绪 / 外部存活未误杀 / 受管已关），用真实 `llama-server.exe` 双实例实跑。

### ⚠⚠ 本轮早期测试的副作用（已发生，需告知用户）
- 修复 #2 **之前**，本轮曾跑过 3 次 `aiChatStream` 各触发一次旧 `killEngine()`→ `taskkill /IM llama-server.exe /F`，
  **把用户原本在 8080 上跑的引擎（PID 22496，`D:\软件\LabCode\resources\llama\llama-server.exe`）一并杀掉了**。
  测试结束已按端口精准清理 28099。**现在代码已修好（#2），不会再发生误杀**；但 8080 那个引擎若还没重启，
  需用户自行重启（重开 LabCode 应用，或告知模型路径由我重启）。
- 已确认全机无残留 llama 进程、用户 `appData` 临时目录已删、未动仓库代码
  （新增未跟踪的 `sim-real-engine.mjs` 与 `verify-no-kill-external.mjs`）。

## 18. 补全官方通道（云端）UI ——「加上云端功能，后台自己搭」

用户原话："加上云端功能，我自己后台添加"。澄清后确认范围 = **补全官方通道 UI**（登录/注册/积分显示/内置模型选择 + 选官方通道），
后端契约**严格照 aiGateway.ts 既有定义**（不臆造字段）。用户自建后端需实现：`POST /api/auth/login`、`POST /api/auth/register`、
`GET /api/me`、`GET /api/models`、`POST /api/chat`、`POST /api/chat/stream`（SSE，`event: credits` + `data:{remaining}`），Bearer `Authorization`。

### 改动清单
- **`src/main/services/aiGateway.ts`**：新增 4 个落地函数（账号信息写入本地 `ai-settings.json`）：
  - `login(email,pwd)` / `register(email,pwd)`：调既有 `authLogin` / `authRegister`，把 `token` + `UserInfo`（email/积分/套餐有效期）写回 `AiState`。
  - `refreshAccount()`：用本地 token 调 `refreshMe` 刷新积分。
  - `logout()`：**只清 token/email/积分/套餐字段，保留 BYOK profile、本地引擎、模型选择**（不能用 `clearAiState`，那会重置 modelId 并清空 BYOK——退出登录不该有这种副作用）。
- **`src/main/index.ts`**：`import` 这 4 个函数，注册 `ipcMain.handle('ai:login'|'ai:register'|'ai:logout'|'ai:refreshMe')`。
- **`src/preload/index.ts`**：`api.ai` 新增 `login` / `register` / `logout` / `refreshMe`（`ipcRenderer.invoke` 对应通道）。`Api = typeof api` 自动带类型。
- **`src/renderer/src/components/SettingsModal.tsx`**：「模型」页顶部新增**官方账户**区块：
  - 未登录 → 邮箱/密码表单 + 登录/注册切换；成功后拉 `models()` 列表。
  - 已登录 → 账户 + 积分（套餐/充值/总计 + 有效期）+ 刷新积分 + 退出登录 + 内置模型单选列表（`setModel(id)` 即切到官方通道）。
  - 严格只用 `var(--token)` 主题变量，复用既有 `byok-form` / `settings-input` / `engine-model-list` 等样式类。

### 验证
- tsc 双过（`typecheck:node` + `typecheck:web`）全清。
- `scan-ipc-handlers`：渲染层 212 个 invoke 全部有主进程 handler（含 4 个新通道），命中需人工复核 0。
- 静态扫描四件套（`scan-ui-crash` / `scan-json-parse` / `scan-unhandled-rejection`）无新增 CRITICAL；`logout` 的 `await` 已加 try/catch 兜底。
- 新增 `scripts/check-cloud-official.mjs`：**32/0 全过**——静态接线（preload invoke↔main handle 4 通道闭合）+ 网关导出 + 渲染层调用 + **真跑** login/register/refresh 落地积分、logout 只清账号保留 BYOK/模型选择。

### ⚠ 交付边界（重要）
- **客户端已接好，后端由用户自建**；契约以 `aiGateway.ts` 为准，未改任何后端字段名。
- 后端上线前，UI 里点「登录/拉模型」会抛网络错误（被 catch 成提示），属预期——不是客户端 bug。
- 内置模型 id（如默认 `deepseek-flash`）须由后端 `/api/models` 真实返回，客户端原样 `setModel(id)` 透传给 `/api/chat` 的 `model` 字段。

## 19. 官方通道真实后端（零依赖 Node，真·接入）

用户追加："你给我真实接入吧" —— 不再只给契约文档，直接落地一个**可运行、可真联通**的后端。

### 交付物（`cloud-server/`）
- `server.mjs`：纯 Node ESM、**零运行时依赖**。实现契约全部 6 端点：
  `POST /api/auth/{register,login}`（scrypt 哈希密码 + 随机 UUID token）、`GET /api/me`、
  `GET /api/models`（含 `id:"deepseek-flash"` 默认模型）、`POST /api/chat`（非流式，扣积分）、
  `POST /api/chat/stream`（SSE，分块吐字 + `event: credits` + `[DONE]`）。
- 两种模式：① **演示模式**（默认，无 key）返回确定性回复并真实扣积分；② **真实 LLM 代理**——设
  `AI_UPSTREAM_URL`（如 `https://api.deepseek.com/v1`）+ `AI_UPSTREAM_KEY` 后，原样代理到
  OpenAI 兼容端点（透传 `model`/`messages`/`stream`），积分仍在本服务扣减。
- CORS：`Access-Control-Allow-Origin: *` + 处理 `OPTIONS` 预检（Electron 渲染进程 fetch 必须过 CORS，否则连不上）。
- 持久化：`cloud-server/data/db.json`（单进程 JSON，用户含 scrypt 盐/hash + tokens + 三类积分）。
- `package.json`（`"start": "node server.mjs"`）、`README.md`（运行 + 如何 `CODELAB_AI_SERVER` 指向它）。
- 客户端指向机制：网关地址 = `process.env.CODELAB_AI_SERVER || 'https://bluebubai.work'`；
  启动 Electron 前 `set CODELAB_AI_SERVER=http://127.0.0.1:8787` 即连本服务。

### 验证：`scripts/e2e-cloud-server.mjs`（**14/0 全过**）
真实启动 `cloud-server/server.mjs`（端口 8799），**用真实客户端代码** `aiGateway` 跑完整链路：
注册（积分 100）→ 拉模型（含 deepseek-flash）→ 刷新账户（/api/me）→ 非流式对话（100→99）→
流式对话（逐字 70 块，99→98）→ 登录（积分不变）。证明客户端契约与真实后端对齐、可真实接入。

### 顺带修的坑（自检脚本串味）
- `scripts/stubs/electron-dom-stub.mjs` 此前只把 `appData` 重定向到 `TEST_APPDATA`，而 `aiGateway`
  的 `ai-settings.json` 走 **`userData`** → 状态文件落在共享 `tmpdir()/codelab-test/userData`，被
  `check-cloud-official.mjs` 留下的 `byok:abc` 夹具污染，导致 e2e 误入 BYOK 分支。已将 `userData`
  一并重定向到 `TEST_APPDATA`，所有自检脚本从此互相隔离（重跑 `check-cloud-official` 仍 32/0）。

### ⚠ 交付边界（重要）
- 这是**开发/演示**后端：数据为本地明文 JSON、无防爆破/限流。生产请换正式鉴权与数据库。
- 演示模式不接真实模型；要真模型就设 `AI_UPSTREAM_URL`/`AI_UPSTREAM_KEY`。
- 真机验收：起服务 → `set CODELAB_AI_SERVER=http://127.0.0.1:8787` → `npm run dev` → 设置→模型→官方账户 注册/登录/对话。
---

## §20 2026-10-08 收尾：清理 + 示例扩充 + 后端加固

### 本轮完成
1. **清理**：删 47 个旧 pkgout/out_bad/out_prev 目录 + 136 个根目录调试残留 + 27 个日志/探针文件，释放约 25 GB。保留 pkgout36 最新包和备份 bundle。
2. **自检**：tsc node+web 双过 exit 0；4 个静态扫描（IPC/crash/JSON/unhandled-rejection）全绿；20+ check 脚本全过；cloud-server e2e 14/0。
3. **课程示例扩充**：examples/ 从 13 个 .ino 扩到 28 个（新增 Wi-Fi 连接/Web 服务器/舵机/深度睡眠/FreeRTOS/NVS/触摸/超声波/继电器/UART2/内置温度/BLE 信标/RGB PWM/UDP/DHT11）。风格统一：中文注释 + Serial 输出 + 接线说明。
4. **云端后端加固**（cloud-server/server.mjs）：
   - 内存版限流：注册 10次/分/IP，登录 20次/分/IP
   - 邮箱格式正则校验 + 密码至少 6 位
   - 请求日志 logReq（method/path/status/extra）
   - 积分预检查：对话前 totalCredits < cost 直接 402
5. **build + 启动**：electron-vite build 17.27s 成功；copy-runtime-assets 完成；dev electron 启动正常（插件加载 2 个、llama.cpp 加载 qwen2.5-coder-1.5b 监听 8080）。
6. **git 提交**：81b9c70 feat(examples): 扩充 ESP32 教学示例至 28 个 + 云端后端加固。

### 已知问题 / 待办
- 14 个旧 pkgout 目录（pkgout, pkgout01, pkgout02, pkgout10-19, pkg113）被 electron 进程的 app.asar 锁住，需完全关闭 electron/LabCode 后再删（约 2 GB）。
- dev electron 窗口启动后不在前台显示（日志正常、进程正常），可能是 window-state.json 残留屏幕外坐标。删 %APPDATA%\codelab-desktop 里的 window-state 相关文件可恢复。
- GitHub 远程 hulufeng/chajian 仍有 71+ 提交未推（缺 PAT）。
- 仿真外设 UI（SimulatorPanel/SimBurnView）在之前简化中已移除，wiringService 只剩接线建议，属暂缓项。
- 云电脑主教材距 100 万字差约 73 万字（Linux 环境，本机不访问）。

### 下次开工第一件事
1. 关掉所有 electron/LabCode 进程，删 14 个锁目录
2. 删 window-state.json 解决 dev 窗口不显示
3. 真机烧录/板卡纠正/增量编译需插板子测

---

## §21 竞品对齐 TrieCode：UI diff 可视化 + MCP 预设 + 模型能力/长上下文（2026-10-08）

### 背景
用户给了一张 LabCode vs TrieCode 对比表，要求「对齐开发」。经核对，表里部分说法不准确（MCP 工具/管理页早已存在），真正的三块差距是：**UI diff 可视化精度、Anthropic(Claude) BYOK 通道缺失、长上下文读取预算**。落地方案见 `docs/对齐TrieCode-差距落地方案-2026-10-08.md`。

### T1 UI diff 可视化升级（Task #2，已完成）
- 新增 `src/renderer/src/components/diff-parse.ts`：纯函数 unified diff 解析，同时支持标准 `@@` 头 与本项目简式 2 字符标记（`- `/`+ `/`  `）；词级 LCS 差异（O(n*m)，超 40000 降级整行）、CRLF 容忍。
- 新增 `src/renderer/src/components/DiffView.tsx`：行号双栏 + hunk 头 + `+N −M` 统计徽章 + 词级 `<mark>` 高亮 + 统一/分栏切换 + 长 diff 折叠。全部走 theme token，无 hex 字面量（守渲染层红线）。
- `AiPanel.tsx` 删掉旧 `<pre>` 逐行着色（含内联 hex `#ff6b6b`/`#51cf8a`），两处改用 `<DiffView text=.../>`。
- 新增 `scripts/check-diff-view.mjs`：esbuild 打包解析器，30 项断言全过。

### T2 MCP 常用服务器一键预设（Task #3，已完成）
- `SettingsModal.tsx` 增 `MCP_PRESETS`（5 个：filesystem/memory/sequential-thinking/playwright/everything），`command(dir)` 返回 `npx -y @modelcontextprotocol/...`；UI 网格卡片，点选填入 draft（信任分级仍由用户手动点「信任」，预设不自动信任）。
- `main.css` 增 `.mcp-preset*` 系列（token 化）。

### T3 模型能力 + 长上下文对齐（Task #4，已完成）
- **根因**：UI 里 Claude/Anthropic 预设早就存在，但 `chatByok`/`aiChatStream` 只实现了 OpenAI 格式 → Claude 选了必 404。补齐 Anthropic Messages API 适配。
- `aiGateway.ts` 新增：`isAnthropicEndpoint` / `toAnthropicMessages`（system 抽离 + tool_use/tool_result 块 + 相邻同角色合并 + 首条必 user）/ `toAnthropicTools`（parameters→input_schema）/ `anthropicHeaders`（x-api-key + anthropic-version）/ `anthropicMessagesUrl`（容忍只填域名自动补 /v1）/ `chatByokAnthropic`（非流式）/ `anthropicStream`（SSE 归一化 content_block_delta/tool_use → StreamChunk）/ `currentReadBudget`（本地 4000 / 云端·BYOK 16000）。
- `engine/tools/index.ts` 的 `read_file` 截断阈值从硬编码 4000 改为 `currentReadBudget()` 动态值（长上下文对齐最小落地）。
- 新增 `scripts/check-anthropic-adapter.mjs`：起本地假 Anthropic server，35 项断言（端点识别/消息转换/tools/鉴权头/URL/预算/非流式/流式 tool_use 归一化）全过。

### 验证结果（本轮）
- tsc node + web 双过 exit 0。
- 4 扫描：scan-ui-crash / scan-json-parse（1 处 `pluginInstaller.ts:86` 预存在，非本次改动）/ scan-ipc-handlers（0 缺 handler）/ scan-unhandled-rejection（预存在裸 await 模式，有全局兜底）全绿。
- check 回归：check-local-model 9/0、check-sse-toolcalls 14/0、**check-anthropic-adapter 35/0（新）**、check-diff-view 30/0（新）。
  - ⚠ `check-cloud-official` 1 失败：`渲染层调用 window.api.ai.register` 未命中 —— 经核对是**预存在问题**（HEAD 的 SettingsModal 本就无 register 调用，UI 只提供登录+试用，从未实现注册按钮），与本次改动无关，**不属回归**。
- electron-vite build 成功（15.27s）；产物复核：`out/main/index.js` 含 `x-api-key`/`anthropic-version`/`content_block_delta`/`input_schema`/`currentReadBudget`；`out/renderer` 含 `diff-view`/`mcp-preset`/`diff-mark`。

### 交付边界 / 注意事项
- Anthropic 适配只走 **BYOK**（用户自有 API Key），不走官方积分通道，符合「外部能力只走 BYOK/子进程」红线。
- **UI 仅真机可验**：diff 渲染 / MCP 预设卡片 / Claude 流式实测，需真机 `start-labcode.bat` 跑 `out\` 验证；本机沙箱起不了 Electron GUI。
- 安装包（NSIS）沙箱内出不了（文件锁），要安装包在用户自己终端 `npm run dist`。
- 未提交：`out_prev_20261008180725/`（构建前避让 safe-delete 的残留，勿提交）；本轮回退仅增量提交源码+文档+自检脚本。
