# TrieCode 官方插件集精读报告（triecode-dev/triecode-plugins，Apache-2.0）

> 日期：2026-10-01 ｜ 性质：GitHub 官方插件集源码精读（9 插件 + 插件规范），对照 codelab 插件生态
> 仓库：https://github.com/triecode-dev/triecode-plugins（组织账号维护，7 commits，最新=新增 sdcc-51-toolchain）
> 许可：**Apache-2.0**（含 LICENSE/NOTICE），官方 README 明示"**开源免费可审计，闭源商业软件亦可在 Apache-2.0 下自由集成**"
> 获取通道：doubao 浏览器 + api.github.com raw（git 直连不可达）
> 与解包关系：本机 `%APPDATA%\TrieCode\plugins\arduino-cli-toolchain\plugin.json` 与此仓库 arduino-cli-toolchain **同一插件**（本仓库为官方开源同步版）——此前逆向学的插件结构在此得到官方规范级确认

---

## 〇、一句话结论

**TrieCode 主程序闭源，但插件生态全开源**。官方插件集 = 9 个嵌入式/电子设计工具链插件，全部是"**plugin.json 声明式 manifest + 宿主标准能力通道**"——插件零宿主特例（`internal` 服务通道接 Agent）。codelab 的插件化（hulufeng/codelab-plugins）可直接对齐这套规范，且 `skills` 字段里的 AI 技能提示词（"烧录前检查""串口日志分析"）是 TrieCode AI 面板在用的一线提示词，Apache-2.0 下可参考改造。

---

## 一、仓库总览

```
triecode-dev/triecode-plugins（main，7 commits）
├── CONTRIBUTING.md / LICENSE / NOTICE / README.md
├── arduino-cli-toolchain/      Arduino CLI 工具链（internal 服务通道）
├── browser-toolchain/          Playwright MCP 浏览器自动化
├── easyeda-toolchain/          立创EDA 深度集成（布线引擎 server + 官方扩展 extension）
├── esp-idf-toolchain/          ESP-IDF 工具链（cli 通道）
├── openscad-toolchain/         3D 建模（内置 BOSL2 库）
├── plugin-dev-toolchain/       插件开发脚手架（AI 创建插件）
├── sdcc-51-toolchain/          51 单片机（SDCC + stcgal 串口 ISP）
├── stm32-cube-toolchain/       STM32Cube（CMake+Ninja+arm-gcc+Programmer_CLI）
└── wokwi-simulator/            Wokwi 仿真（wokwi-cli 本地+云端引擎）
```

**插件通用结构**（官方规范，README 原文）：`plugin.json`（能力声明：MCP/CLI/工具/设置项）+ `README.md` + `assets/`（图标）+ `ui/`（宿主 WebView 内嵌面板）+ `server/`（MCP 服务器，Node 自包含单文件）+ `docs/`

---

## 二、官方插件规范核心（plugin.json 十要素）

以 arduino-cli-toolchain/plugin.json（v0.3.11）为主样本，综合 9 插件：

### 1. 元数据
```json
{ "id": "arduino-cli-toolchain", "name": "Arduino CLI 工具链", "version": "0.3.11",
  "developer": "TrieCode", "icon": "arduino", "category": "嵌入式工具链" }
```

### 2. capabilities（能力声明，三种 transport）
```json
"capabilities": {
  "compile": {
    "transport": "internal",            // internal = 宿主内置服务（零特例）
    "service": "arduinoCli",            // arduinoCli / serialport / serialLog / state
    "method": "compile",
    "output": "avr-gcc"                 // 编译输出解析
  },
  "upload": {
    "transport": "cli",                 // cli = 宿主命令执行
    "steps": [ {"command": ["{nodeBin}", "{pluginDir}/tools/build.mjs", "..."], "cwd": "{projectPath}"} ],
    "env": {"IDF_PATH": "{settings.toolchain.active.path}", "PATH": "{...};{env.PATH}"},
    "stream": true, "streamChannel": "compile:onOutput",
    "pauseSerialPort": true,            // 烧录前自动暂停串口监听！
    "timeoutMs": 600000, "maxOutput": 12000
  }
}
```
- **transport 三通道**：`internal`（宿主内置服务，零宿主特例）｜`cli`（命令执行，支持 `steps` 多步链、`stream` 流式回传、`pauseSerialPort`）｜`mcp`（MCP 服务器，`server/` 单文件 Node）
- **模板变量插值**（宿主统一替换）：`{projectPath}` `{project}` `{name}` `{sketchName}` `{board}` `{port}` `{defaultPort}` `{settings.<id>.<key>}` `{pluginDir}` `{nodeBin}` `{env.PATH}` `{pathSeparator}`

### 3. views（宿主侧边栏 WebView 面板）
```json
"views": [ { "id": "platforms", "title": "平台管理", "icon": "package", "slot": "sidebar",
             "type": "webview", "entry": "ui/platforms.html", "events": ["core:installProgress"] } ]
```

### 4. devicePanel（设备选择面板）
```json
"devicePanel": { "id": "arduino-board", "title": "Arduino 设备",
  "selectors": [
    { "id": "board", "title": "开发板", "source": {"transport":"internal","service":"arduinoCli","method":"board.search"},
      "searchable": true, "key": "fqbn", "placeholder": "搜索开发板…" },
    { "id": "port", "title": "端口", "source": {"transport":"internal","service":"serialport","method":"list"}, "key": "port" }
  ],
  "optionLoader": {"transport":"internal","service":"arduinoCli","method":"board.details"},
  "optionSet": {"transport":"internal","service":"state","method":"setBoardOption"} }
```

### 5. projectTypes + scaffold（项目类型 + 文件脚手架）
```json
"projectTypes": [ { "id": "arduino", "title": "Arduino 项目", "icon": "arduino",
  "scaffold": [ {"file": "{name}.ino", "content": "void setup() {...}"} ],
  "capabilities": ["compile","upload","board-manage","board-select","library-manage"] } ]
```
wokwi 项目脚手架=4 文件：`{name}.ino` + `wokwi.toml`（firmware/elf 指向）+ `diagram.json`（电路图）+ `libraries.txt`（库依赖）

### 6. skills（AI 技能——TrieCode AI 面板在用的提示词！）
```json
"skills": [
  { "name": "烧录前检查", "description": "编译 + 检查板卡/端口选择，确认无误再烧录",
    "prompt": "请按顺序完成烧录前的完整检查：\n1. read_file 当前项目 {sketchName} 的源码，检查明显错误\n2. 确认已选择开发板（select_board）和端口（select_port，当前 {port}）\n3. 用 compile 编译一次，确保无 error\n4. 编译通过后先向用户确认「编译通过，是否烧录？」，确认后再 upload\n5. 烧录成功后用 serial_log_open + serial_log 打开串口确认程序正常运行" },
  { "name": "串口日志分析", "description": "打开串口后台日志，读取并分析运行输出",
    "prompt": "1. 用 serial_log_open 打开当前板子的串口后台日志（端口 {port}，默认 115200）\n2. 让固件运行一段时间，用 serial_log 读取最近日志\n3. 分析输出中的异常/错误信息，定位问题根因\n4. 如需检索特定关键字用 serial_grep\n5. 分析完成后用 serial_log_close 释放串口" }
]
```
> 对应解包源码：serial_log_open/serial_log/serial_grep/serial_log_close 正是 TrieCode SerialLogService（5000 行）暴露的工具。**codelab 可直接参考这套"烧录前检查"工作流提示词。**

### 7. tools（AI 工具声明：JSON Schema + transport + 分类）
```json
"tools": [ { "name": "compile", "description": "Compile/verify a sketch...",
  "parameters": {"type":"object","properties":{"fqbn":{"type":"string","description":"Optional standard FQBN..."}}},
  "transport": "cli", "projectTypes": ["arduino"], "category": "execute",
  "cli": {"command": [...]} } ]
```
- `category`: `query`（只读）/ `execute`（有副作用）——安全分类
- 注意 compile 的 description 明示：**fqbn 必须标准格式（arduino:avr:uno），不是显示名**；缺失 platform 首次编译自动安装

### 8. activation / detection / settings
```json
"activation": { "projectTypes": ["wokwi"] },
"detection": { "envVars": ["WOKWI_CLI_PATH"], "pathGlobs": ["D:/Wokwi/bin", "%USERPROFILE%/wokwi/bin", "C:/wokwi/bin", "%LOCALAPPDATA%/Programs/wokwi"], "validateFile": "wokwi-cli.exe" },
"settings": [ { "id": "wokwi", "title": "Wokwi 配置", "settings": [ {"key":"wokwi.token", "title":"WOKWI_CLI_TOKEN", "type":"string", "placeholder":"wok_xxx", "restartRequired": false} ] } ]
```
- 检测结果存 `pluginSettings.<id>.toolchain.active.path`，cli 命令用 `{settings.toolchain.active.path}/xxx.exe` 插值

### 9. backends（宿主自动启动的 daemon）
- arduino 插件：`arduino-cli daemon`（grpc），由宿主按 backends 声明自动启动（README 原文）
- 依赖下载：插件启用时自动下载 arduino-cli（manifest.dependencies）

### 10. 安全模型
- 第三方插件进不了官方市场（**官方市场仅收录可审计代码**）；插件以用户权限运行
- plugin_dev_install 前强制 `validateManifest`（非法 manifest 拒绝安装）；安装 ≠ 启用

---

## 三、9 插件逐一精读 + codelab 对照

| 插件 | 机制 | 核心能力 | codelab 对照与价值 |
|---|---|---|---|
| **arduino-cli-toolchain** v0.3.11 | internal 服务（arduinoCli daemon grpc）+ 2 侧栏视图（平台/库管理）+ devicePanel + skills×2 + tools×20 | 编译（avr-gcc 解析+失败 AI 修复）/上传（串口/DFU/J-Link）/板卡库管理/串口监控 | ⭐ **最高价值**：与本机解包插件一致；skills 提示词可直接改造为 codelab AI 面板"烧录前检查/串口分析"技能；devicePanel 设备选择= codelab 工具栏 |
| **esp-idf-toolchain** v0.1.11 | cli 通道（idf.py build/flash）+ Kconfig 图形化配置 + ui（config/status）+ detection 复用本机 ESP-IDF | ESP32 编译/烧录/串口日志 | ⭐ 用户主线 ESP32-C3/S3！`{settings.toolchain.active.*}` 环境注入（IDF_PATH/IDF_TOOLS_PATH/IDF_PYTHON_ENV_PATH）可直接照抄 |
| **stm32-cube-toolchain** v0.1.2 | cli 多步（cmake→ninja→Programmer_CLI SWD）+ 内置 CMSIS 器件支持（f1/f4 启动文件+链接脚本） | STM32 裸机脚手架/编译/烧录 | 参考其多步 steps 链（build→flash 两步）与 device-support 布局 |
| **sdcc-51-toolchain** v0.3.3 | cli 多步（build.mjs→flash.mjs）+ **chips.json 驱动芯片表**（加芯片只改表）+ 10 款 STC 头文件 + stcgal 串口 ISP | 51 编译（SDCC）+ STC 串口 ISP 烧录 | ⭐ 设计亮点：**"加芯片只改 chips.json 表"**——codelab 板卡管理可学（数据驱动而非代码驱动）；flash.mjs 串口 ISP 协议实现可参考 |
| **wokwi-simulator** v0.1.4 | wokwi-cli 本地二进制 + Wokwi 云端引擎（与 wokwi.com 同源）；detection 路径探测 + WOKWI_CLI_TOKEN（wok_ 44 字符）+ MCP（实验性） | 6 工具：`wokwi_lint`（电路图校验）/`wokwi_compile_arduino`/`wokwi_run`（流式串口到编译面板，exit 42=正常超时）/`wokwi_ci_test`（期望文本断言）/`wokwi_scenario`（按按钮/改传感器自动化）/`wokwi_screenshot`（OLED 截图） | ⭐ 对应 codelab 仿真需求（用户已否决引入 Wokwi，但**工具面设计**值得抄：lint→compile→run→断言→截图 5 步闭环）；`projectTypes.scaffold` 的 diagram.json 模板=codelab 电路图格式参考 |
| **browser-toolchain** | Playwright MCP | 浏览器自动化 | 低优先（codelab 无此需求） |
| **openscad-toolchain** | AI 写 .scad → 三视角预览自纠 → 渲染 STL/3MF，内置 BOSL2 库 | 3D 建模 | 低优先 |
| **easyeda-toolchain** | 最复杂：官方立创EDA 扩展（extension/，esbuild 构建）+ server 布线引擎（**A* 绕障 router.mjs** + 布局 planner/occupancy/verify）+ ui wizard | 原理图自动布局 + A* 布线 + 40+ 工具 | 中期参考：`server/src/layout/`（planner→router→verify 管线）可做 PCB 教学；非核心先放 |
| **plugin-dev-toolchain** | 3 工具：`plugin_dev_create`（生成骨架）/`plugin_dev_validate`（manifest 合规校验）/`plugin_dev_install`（本地安装）+ Skill「创建插件」 | AI 创建插件闭环 | ⭐ codelab 插件市场必备：validateManifest 强制校验 + 安装≠启用 |

---

## 四、codelab 落地映射（对齐官方标准）

### A. 插件规范 v2（hulufeng/codelab-plugins 对齐官方）
1. **plugin.json 十要素**直接采用：capabilities（transport 三通道）/ views（sidebar webview）/ devicePanel / projectTypes+scaffold / skills / tools（JSON Schema+category query|execute）/ activation / detection（envVars+pathGlobs+validateFile）/ settings / backends+dependencies
2. **模板变量系统**：`{projectPath}` `{settings.*}` `{pluginDir}` `{nodeBin}` `{env.*}` `{pathSeparator}`——宿主统一插值
3. **安全模型**：validateManifest 强制校验 + 安装≠启用 + category 安全分类

### B. codelab 具体抄哪些（第一批，1-2 周）
| 项 | 来源 | 落地 |
|---|---|---|
| "烧录前检查"技能提示词 | arduino skills[0] | codelab AI 面板内置技能（改写原创文案） |
| "串口日志分析"技能提示词 | arduino skills[1] | 同上（serial_log_open→serial_log→serial_grep→serial_log_close 闭环） |
| devicePanel 设备选择 | arduino devicePanel | codelab 工具栏板卡/端口选择器（fqbn key + serialport list） |
| esp-idf 环境注入 | esp-idf capabilities.compile.env | ESP32-C3/S3 编译环境（IDF_PATH 系列变量） |
| pauseSerialPort | esp-idf/stm32 upload | 烧录前自动暂停串口监听（codelab 已有串口面板，加此开关） |
| chips.json 数据驱动 | sdcc | codelab 板卡/芯片表改数据驱动 |
| validateManifest | plugin-dev | 插件安装前强制校验 |

### C. 仿真（对应 codelab 自研 VirtualRuntime 的工具面闭环）
wokwi 6 工具闭环 → codelab 对应：`runtime_lint`（电路校验）→ `runtime_compile` → `runtime_run`（流式串口）→ `runtime_assert`（期望输出断言）→ `runtime_scenario`（交互自动化）→ `runtime_screenshot`（OLED/外设截图）。**功能对齐 wokwi，引擎用自研 VirtualRuntime**（不引入 GPL/AGPL）。

### D. 暂缓项
- easyeda 布线引擎（中期，PCB 教学再启）
- browser-toolchain / openscad（codelab 无场景）
- wokwi MCP 服务器（实验性，codelab 自研引擎不走 MCP）

---

## 附：精读轨迹（可复查）

| 文件 | 已提取 |
|---|---|
| README.md | 仓库定位、9 插件目录、官方/第三方边界、插件结构规范、宿主需求 ≥v1.2.4 |
| arduino-cli-toolchain/plugin.json | 十要素完整样本（internal 通道 + devicePanel + skills×2 + tools 头部） |
| esp-idf-toolchain/plugin.json | cli 通道完整样本（steps/env/stream/pauseSerialPort） |
| stm32-cube-toolchain/plugin.json | 多步 steps 链（cmake→ninja→Programmer_CLI） |
| wokwi-simulator/plugin.json + README | 6 工具面、detection、token、MCP、scaffold 4 文件模板 |
| sdcc-51-toolchain/plugin.json | chips.json 数据驱动、build/flash 两步链 |
| plugin-dev-toolchain/README | AI 创建插件闭环、validateManifest、安装≠启用 |
| 全量目录树 | git/trees/main?recursive=1（openscad BOSL2 库、easyeda server/layout 等） |
