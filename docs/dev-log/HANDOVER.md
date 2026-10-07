# 交接与测试总档 · CodeLab / LabCode 桌面端

> **这是唯一的常驻文档。** 以后状态变化、流程变化、新 bug，都**只改这一份**，不再新增带日期的交接文档 / 测试记录。
> 已被并入的历史文件见 §11（内容都在这里，旧文件只留指针）。

| 速查项 | 当前值 |
|---|---|
| 最新提交 | `bf855e8`（plugin.json schema 草案 + 元插件三件套脚手架；仅剩 safe-delete 残留 out_*/_probe* 未提交） |
| 应用版本 | `1.1.3` |
| **最新可测包** | **`pkgout36\LabCode-Setup-1.1.3.exe`**（2026-10-08 00:00，152MB） |
| 当前测试板卡 | ESP32-C3（VID:PID `303a:1001`） |
| 项目根 | `D:/工作/代码实验室/codelab-desktop` |
| 技术栈 | Electron 44 + React 19 + TS 5.9 + electron-vite 5 + Vite 7 |
| 规模 | 27 个自检脚本 + 4 个静态扫描器 |

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