# TrieCode v1.3.1 实际操作实测报告

> 实测日期：2026-10-01（本地）
> 方式：CDP（Chrome DevTools Protocol，`--remote-debugging-port=9333`）DOM 级全链路操控真实软件
> 环境：Windows，TrieCode v1.3.1（商业闭源），渲染进程入口 `app.asar\packages\renderer\dist\index.html`
> 前置素材：triecode-dev/triecode-plugins 插件集精读报告、triecode.com 官网学习记录（本报告为"实操验证层"）

---

## 0. 实测结论（TL;DR）

TrieCode 软件的实际使用层与官网文档/插件集声明**高度一致**，全部核心链路跑通：

| 功能 | 实测结果 | 关键数据 |
|---|---|---|
| 新建 Arduino 项目 | ✅ 成功 | 7 类项目模板；自动生成 `.triecode.json`、激活 Arduino 工具链 |
| 开发板选择（门控） | ✅ 成功 | 搜索 esp32c3 命中 14 款板卡；**设备配置面板自动展开**（10 项配置） |
| 编译 | ✅ 成功 | 22 秒（含首次核心加载）；程序存储 20%、动态内存 4% |
| AI 对话（Agent） | ✅ 成功 | 16 秒工作、思考+1 个工具调用、回答正确；**输入 23.6k / 输出 58 / 消耗 1.68 积分** |
| 终端 | ✅ 成功 | xterm.js + PowerShell；**工作目录自动切到项目目录**，命令执行成功 |
| 门控机制 | ✅ 验证 | 未选板点编译 → 顶部提示"请先选择一个开发板" |
| 插件后端 daemon | ✅ 验证（日志） | 动态端口分配 + 就绪检测 + 崩溃自动重启 |
| 串口监视器/绘图仪 | ⚠️ 未深测 | 无物理串口设备（连接失败路径未验证） |

---

## 1. 实测方法与通道

### 1.1 操控通道演进（三阶段）

1. **cu 平面（seed_computer_use）❌**：合成屏 1920×1080 与真实显示器分离（TrieCode renderer `device-scale-factor=1.25`），任务栏点击/坐标点击/系统级鼠标模拟全部对真实窗口无效。
2. **Win32 API（PowerShell+Add-Type）✅ 部分**：`EnumWindows` 找到主窗口 HWND（初始 `Visible=False`）→ `ShowWindow(5)+SetWindowPos(50,30,1850,1000)+SetForegroundWindow` 移到可视区；**`PrintWindow(hwnd,hdc,2)` 是唯一能"看见"真实 UI 的方法**（欢迎页/编译结果截图）。
3. **CDP 通道 ✅ 决定性**：停进程 → `TrieCode.exe --remote-debugging-port=9333 --remote-allow-origins=*` 启动 → python websocket-client 连 `ws://127.0.0.1:9333/devtools/page/<id>`（每次重启需重新 `GET /json` 取最新 webSocketDebuggerUrl）。

### 1.2 CDP 操控三要点（血泪教训）

1. **React 受控输入**：用原生 value setter + `input` 事件（直接赋值无效）。
2. **自定义下拉（`div.ui-select__option`）**：DOM `.click()` 无效，必须 `getBoundingClientRect` 取坐标 + `Input.dispatchMouseEvent`（mousePressed+mouseReleased）真实点击。
3. **实时状态读取**：`document.body.innerText`（比逐个选器稳定）。

### 1.3 AI 输入框的坑

AI 输入框**不是 input/textarea，而是 `div.chat-input`（contenteditable）**，且 `offsetParent=null`（视觉隐藏但存在）。发送消息 = 聚焦 + `Input.insertText` 注入 + `Input.dispatchKeyEvent` 真实按 Enter。DOM 模拟的 KeyboardEvent（`dispatchEvent`）不触发 React 发送。

---

## 2. 全链路实测记录

### 2.1 新建项目

- 欢迎页"新建项目" → 对话框列 7 类模板：**插件开发工具链 / Arduino / Node / Python / C / C++ / Rust / 通用**
- 填项目名 `TestBlink`（placeholder=MySketch）→ "创建"
- 成功：打开 `TestBlink.ino`（空 setup/loop 模板）+ 自动生成 `.triecode.json` + Arduino CLI 工具链自动激活（状态栏切换）

### 2.2 选板与设备配置（**devicePanel 门控实测**）

- 无板点编译 → **"请先选择一个开发板"**（顶部提示，编译被拦截）
- 活动栏"Arduino CLI 工具链"面板 → 设备/平台管理/库管理/设置 四选项卡
- 点"搜索开发板…" → 搜索框输入 `esp32c3` → **14 款 ESP32-C3 板卡**（Adafruit QT Py、AirM2M_CORE_ESP32C3、DFRobot Beetle、**ESP32C3 Dev Module**、Geekble Mini、Nologo Super Mini、OLIMEX DevKit-Lipo、Pandabyte xC3m、SparkFun Pro Micro、WeAct Studio、XIAO_ESP32C3、uPesy Basic/Mini）
- 真实点击选中 ESP32C3 Dev Module → **设备配置面板自动展开**：
  - Upload Speed 921600
  - USB CDC On Boot Disabled
  - CPU Frequency **160MHz (WiFi)**
  - Flash Frequency 80MHz / Flash Mode QIO
  - Flash Size **4MB (32Mb)**
  - Partition Scheme **Default 4MB with spiffs (1.2MB APP/1.5MB SPIFFS)**
  - Core Debug Level None / Erase All Flash Disabled / JTAG Adapter Disabled / Zigbee Mode Disabled
- 状态栏：未选择开发板 → **ESP32C3 Dev Module**（官网 devicePanel `needsBoard` 门控 + optionLoader 机制得到实机验证）

### 2.3 编译（arduino-cli 真实编译）

- 点工具栏"编译" → **22 秒成功**（首次编译现场装核心/工具链）
- 输出面板顶部**径向仪表**（编译成功卡片）：
  - 程序存储：**261,454 / 1,310,720 bytes（20%）**
  - 动态内存：**13,192 / 314,488 bytes（4%）**
  - "详细输出"展开按钮
- 后端日志佐证（`%APPDATA%\triecode\backends\arduino-cli-toolchain.log`）：
  ```
  [2026-09-30T17:48:21.907Z] 动态端口：已分配空闲端口 56312
  spawn: ...\arduino-cli.exe daemon --port 0 --daemonize --max-grpc-recv-message-size 16777216 (pid 22636)
  Daemon is now listening on 127.0.0.1:56312
  daemon 就绪 127.0.0.1:56312（pid 22636）
  ```
  → **完整验证 BackendProcessManager：动态端口分配 → spawn daemon → 端口就绪轮询 → 崩溃检测重启（exit code=4294967295 → 重启）**

### 2.4 AI 对话（Agent 全链路）

- 消息："用一句话说明当前 TestBlink.ino 代码的作用"
- **Agent 工作 16 秒**，UI 显示"▶ 已工作 16s / **思考 · 1 个工具**"（Agent 调用了 1 个工具——读文件，拿到代码内容后回答）
- 回答：**"TestBlink.ino 是一个空的 Arduino 框架文件，setup() 和 loop() 函数体均为空白，尚未写入任何实际逻辑。"**（正确）
- **计量条：输入 23.6k · 输出 58 · 消耗 1.68 积分**（官网"积分按 token 用量"机制实机显示；token→积分换算可见）
- 模型：MiniMax M2.7；execPath=account（账号计费路径）
- 历史证据（`%APPDATA%\triecode\logs\`）：
  - `slow-turns.jsonl`：真实会话记录（firstChunkMs 3.8~7.4s、totalMs 10~24s）
  - **`cache-audit.jsonl`：TrieCode 有 prompt 缓存审计体系**（toolsHash/staticHash/dynHash、cacheReadTokens、**hitRate 最高 0.976**）

### 2.5 终端（xterm.js + PowerShell）

- 点工具栏"终端" → 底部面板打开 **Windows PowerShell**
- **提示符直接位于项目目录**：`PS C:\Users\Administrator\Documents\TrieCodeProjects\TestBlink>`
- 输入 `Get-Location; Get-ChildItem -Name` → 输出：
  ```
  Path
  ----
  C:\Users\Administrator\Documents\TrieCodeProjects\TestBlink
  .triecode.json
  TestBlink.ino
  ```
- 输入通道：`textarea.xterm-helper-textarea` 聚焦 + Input.insertText + Enter

### 2.6 未测项（受硬件限制）

- **串口监视器/绘图仪**：无物理串口设备，端口下拉为空（连接路径未验证——需要真实板子）
- **上传烧录**：需要物理开发板（定位=真实烧录，无板不可测）
- **Git 面板 / 插件管理 / 设置**：DOM 可见（活动栏"源代码管理/插件"入口）但本轮未逐项深测

---

## 2.7 烧录（上传）链路模拟测试（2026-10-01 补充）

### 已实测到的上传链路全环节

| 环节 | 实测结果 |
|---|---|
| 端口枚举 | 端口下拉列出 **COM1 ((标准端口类型))**（arduino-cli board list 来源） |
| 端口选择 | CDP 真实点击选中 → 状态栏显示"ESP32C3 Dev Module · COM1" |
| 上传触发 | 点上传 → 完整编译流输出（FQBN esp32:esp32:esp32c3、核心 3.3.11、esptool 生成 bootloader 镜像） |
| esptool 连接 | **esptool v5.3.0 打开 COM1 发同步帧**（Connecting....）→ 无芯片响应 → `A fatal error occurred: Failed to connect to ESP32-C3: No serial data received` + 排障链接（完整错误处理路径） |
| 命令行对照 | 同一项目 `arduino-cli compile` 成功（261,454B/19%、动态内存 13,192/4%）；`arduino-cli upload -p COM1` 触达 esptool 连接阶段，错误码 exit status 2 |
| COM1 特性 | 可被 pyserial 打开（真实串口条目），但两个进程数据不互通 → 无法当虚拟对做板端模拟 |

### 发现 TrieCode 两个真实缺陷（codelab 反面教材）

1. **daemon 编译挂起**：TrieCode UI 上传在特定项目路径（`C:\Users\Administrator\Documents\TestBlink2`）下编译 **40 秒无错误输出判定失败**，且日志停在 bootloader elf2image 生成后不前进；**同一项目命令行 compile 秒级成功** → daemon compile 路径存在挂起 bug（构建目录/子进程管道问题）。**codelab 落地启示：直接调 arduino-cli CLI（不绕 daemon）、为编译设超时、防 cmd /c 嵌套挂起、失败时输出真实 stderr。**
2. **GBK 中文乱码**：编译输出中"已复制 1 个文件"（cmd /c COPY 的 GBK 输出）显示为 `�Ѹ��� 1 ���ļ���`——**cmd 子进程输出未转码**，解包源码时预测的编码缺陷实测命中。**codelab 启示：子进程输出统一 UTF-8/GBK 双通道解码（terminal-exec 已有此实现）。**

### "模拟成功烧录"方案（已打通！RFC2217 网络串口，无需 com0com）

**2026-10-01 重大突破：不依赖虚拟串口驱动，用 RFC2217 网络串口方案完整跑通 esptool 烧录成功路径。**

**背景**：com0com 虚拟串口驱动下载被网络/反爬全面阻断（SourceForge Cloudflare / GitHub 无 release / gitee·CSDN 验证码）。TrieCode 内置 esptool（PyInstaller 打包的 pyserial 精简版）不支持 `socket://`/`rfc2217://` URL 端口（实测 ValueError: protocol not known）——但 **pip 安装的完整版 esptool 5.4.0（系统 pyserial）完整支持 rfc2217://**。

**方案**（`_triecode_learn\fake_esp32_rfc2217.py`，完整模拟 ESP32-C3 开发板）：
1. Python TCP 服务器监听 `127.0.0.1:3232`，实现 RFC2217 telnet 协商（COM-PORT-OPTION 0x2C + 全部 SET 子命令应答映射 0x01-0x0C → 0x65-0x70，严格按 pyserial serial/rfc2217.py 协议）
2. 实现 esptool 5.x ROM 协议（精确按 loader.py）：请求帧 `<BBHI`（0x00,op,len,chk）+ data；应答帧 `<BBHI`（0x01,op,len,val）+ data
3. 命令码表（ESP32-C3）：FLASH_BEGIN=0x02 FLASH_DATA=0x03 FLASH_END=0x04 SYNC=0x08 WRITE_REG=0x09 READ_REG=0x0A SPI_ATTACH=0x0D CHANGE_BAUDRATE=0x0F FLASH_DEFL_BEGIN=0x10 FLASH_DEFL_DATA=0x11 FLASH_DEFL_END=0x12 SPI_FLASH_MD5=0x13 GET_SECURITY_INFO=0x14
4. 关键细节（全部实测踩坑得出）：
   - **SYNC(0x08) 后 esptool 连续读 8 个响应**（1 主 + 7 多余），只回 1 个会 "Serial data stream stopped"
   - **READ_REG 寄存器值放帧头 val 字段**，data 前 2 字节是状态（0）——放错报 "result was 8115"
   - **GET_SECURITY_INFO(0x14)** 回 20 字节 `<IBBBBBBBBII`（chip_id=0x0005）——芯片识别（ESP8686/C3 v3.0、MAC 15:81:33:60:15:81）全靠它
   - **stub flasher**：MEM_BEGIN(0x05)/MEM_DATA(0x07)/MEM_END(0x06) 应答 + MEM_END 后发 **"OHAI"** SLIP 帧
   - **压缩烧写是跨块 zlib 流**（app 261600 字节分 8 块共享一个压缩流）——必须用 `zlib.decompressobj()` 有状态解压，独立 decompress 会 -3/-5 报错
   - **SPI_FLASH_MD5(0x13)**：stub 模式回 16 字节二进制 md5（非 ROM 的 32 字节 hex）；伪板维护 flash 存储（offset→bytes dict），按 addr/size 拼数据算**真实 md5** 才能过 "Hash of data verified"
5. 伪板跨连接保持 flash 数据（Hard reset 后 esptool 重连 verify 也能对上）

**实测完整输出**（真实 esptool 日志）：
```
Connected to ESP32-C3 on rfc2217://127.0.0.1:3232:
Chip type:          ESP8686 (QFN24) (revision v3.0)
MAC:                15:81:33:60:15:81
Uploading stub flasher... / Running stub flasher... / Stub flasher running.
Changing baud rate to 921600... / Changed.
Configuring flash size...
Wrote 19536 bytes (12730 compressed) at 0x00001000 in 0.4 seconds (365.2 kbit/s).  Hash verified
Wrote 3072 bytes (146 compressed) at 0x00008000 in 0.5 seconds (52.9 kbit/s).       Hash verified
Wrote 8192 bytes (49 compressed) at 0x0000e000 in 0.7 seconds (98.7 kbit/s).        Hash verified
Wrote 261600 bytes (146295 compressed) at 0x00010000 in 2.4 seconds (889.6 kbit/s). Hash verified
Hard resetting via RTS pin...
```
**退出码 0，4 个文件全部 md5 校验通过。**

**对 codelab 的启示**：codelab 的仿真辅助可以内置 RFC2217 伪芯片服务器（Node 实现 esptool ROM+stub 协议或直接 spawn pip esptool），**无需虚拟串口驱动**，软件内模拟烧录链路（连接→识别→擦除→烧写→校验）全程可见——比 TrieCode 的依赖物理串口方案更强。

**TrieCode UI 的限制**：TrieCode 端口下拉只列 arduino-cli 枚举的 COM 口（rfc2217 不出现），且内置 esptool 不支持 URL 端口——TrieCode UI 无法走通此模拟路径（需 com0com + daemon 编译修复后才能用 UI 测成功烧录）。

---

## 3. 实机验证的关键发现（对 codelab 有参考价值）

1. **积分计量 UI 是卖点级细节**：AI 回答卡片显示"输入/输出 token + 积分消耗"，让用户对"为什么扣积分"透明。codelab 若商业化 AI 功能，这是必须的设计（信任感）。
2. **Agent 工作状态可视化**：工作计时器（"已工作 16s"）+ 工具调用计数（"思考 · 1 个工具"）——用户能感知 Agent 在干活。codelab 的 AI 助手应复刻此交互。
3. **终端自动切工作目录**：打开即 `cd` 到当前项目目录，零配置。codelab 的内置终端（若做）应默认此行为。
4. **设备配置面板的"即选即展"**：选板后配置项自动展开且带默认值（160MHz/4MB/QIO/spiffs），符合 ESP32 生态习惯。codelab 的烧录面板应对齐。
5. **门控提示轻量**：未选板时点编译只是顶部一条提示（不弹窗不打断），"引导而非惩罚"。
6. **编译仪表**：径向仪表显示程序存储/动态内存占用（百分比+bytes），是 Arduino 生态的直观反馈。codelab 已有类似设计，可对照优化。
7. **xterm 终端输入框是隐藏 textarea**（`xterm-helper-textarea`）——若 codelab 集成 xterm，输入注入走这条路。

---

## 4. 对 codelab-desktop 的落地映射

| TrieCode 实机能力 | codelab 对应 | 差距/动作 |
|---|---|---|
| 新建项目 7 模板 + .triecode.json | 已有项目创建 | 对齐"项目内自动生成配置文件"习惯 |
| 搜索选板 + 设备配置即选即展 | VirtualRuntime 选板已有 | 补"选板后配置默认值自动填充" |
| 编译仪表（%+bytes） | 已有编译反馈 | 对照径向仪表样式 |
| Agent 工作计时 + 工具计数 | AI 对话区 | **待补：工作状态可视化（计时/工具数）** |
| 积分计量条（token+积分） | 无计费 | 商业化 AI 需设计 |
| 终端 cd 到项目目录 | 无终端 | 若加终端，默认行为=项目目录 |
| daemon 动态端口+崩溃重启 | 插件后端架构 | 已在插件架构中参考（Apache-2.0 插件集） |

---

## 5. 附：操控脚本清单（可复用）

位置：`D:\工作\代码实验室\_triecode_learn\`

| 脚本 | 用途 |
|---|---|
| `cdp_client.py` / `cdp_action.py` | CDP 基础客户端 / eval+click-by-text 动作 |
| `cdp_create_arduino.py` | 新建 Arduino 项目 |
| `cdp_search_board.py` | 搜索开发板（esp32c3 → 14 款） |
| `cdp_real_click.py` | **Input.dispatchMouseEvent 真实点击选板（核心）** |
| `cdp_compile2.py` | 编译 + 轮询结果 |
| `cdp_ai_chat.py` / `cdp_ai_wait.py` | **AI 对话（contenteditable chat-input）** |
| `cdp_terminal_cmd2.py` | xterm 终端执行命令 |
| `cdp_find_send.py` 等 | 失败路径记录（勿重试） |

**已验证死路（勿重试）**：cu 平面坐标操控真实窗口（缩放 1.25/虚拟屏分离）；DOM `.click()` 触发 React 下拉/React 键盘事件模拟（`dispatchEvent` KeyboardEvent）。
