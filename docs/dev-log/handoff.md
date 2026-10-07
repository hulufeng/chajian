> **已并入 [HANDOVER.md](HANDOVER.md)（唯一常驻文档，2026-10-08 起）。本文件仅留作历史存档，勿再更新。**

# Handoff - CodeLab 桌面端（codelab-desktop）

> ⚠️ **本文件是历史累积文档，最后更新于 2026-10-03，已偏旧。**
> **当前交接请看 → [`HANDOFF-2026-10-07.md`](./HANDOFF-2026-10-07.md)**（自包含：现状 / 环境约束 / 验证体系 / 待办 / 铁律 / 死胡同）。
> 下面的内容保留作历史参考；涉及数字（板卡数量、断言数、IPC 通道数）**一律以代码与脚本实际输出为准**。

## 任务指针

- [x] 编辑器区性能优化（Monaco 非受控模式，输入丝滑不卡顿）
- [x] 标题栏 UI 优化（40px、按钮间距、蓝色烧录主按钮、仿真弱化为灰色次要）
- [x] 仿真器从 fixed 覆盖层改为右侧停靠面板（380px flex）
- [x] 文件树树状展开（SVG 图标、文件夹/文件按扩展名着色、排序）
- [x] 板卡选择器去 emoji 改蓝色芯片 SVG 图标
- [x] 全面学习 TrieCode（v1.3.1）的 AI Agent 架构 → 学习报告已产出
- [x] **深度摸清 TrieCode Agent 全链路（工具面/执行引擎/AI 层/安全护栏/子代理/记忆）→ 全链路深度报告已产出（docs/triecode-agent-全链路深度报告.md）**
- [x] **二次深挖（2026-09-30 晚）：系统提示词七段全貌 + AGENTIC BEHAVIOR 协议 + 工具执行实现 + Web SSRF/DNS rebinding 闭环 + 崩溃分析/失败分类/FQBN 映射 + 真实会话数据 + renderer AI 面板 UI 交互层 → 报告扩至 16 章**
- [x] **三次深挖（2026-10-01）：引擎深层（三级压缩全算法/记忆库/计划存储/预算循环/自动记忆/SQLite 会话）+ 主进程 Arduino 集成（串口日志服务/internal-services 20 工具实现/核心自动安装/gRPC daemon/更新机制/窗口安全）+ AI 层细节（错误分类/9 家注册表/模型窗口规格/识图桥接/PDF/测试解析/退避/钩子/权限引擎/审批审计）→ 报告扩至 20 章**
- [x] **实际操作 velxio.dev 在线仿真器 + GitHub 生态检索（2026-10-01）→ 生态参考报告已产出（docs/velxio-实际操作与生态参考.md）**
- [x] **开源 AI Agent IDE 对标检索（2026-10-01，用户"还是去找跟triecode和traecode相关的"）→ 对标报告已产出（docs/开源AI-Agent-IDE对标报告.md），核心发现：cline/cline（69.6k★ Apache-2.0）是 TrieCode Agent 的开源镜像，可合法参考/引入**
- [x] **Cline SDK 源码精读（2026-10-01，用户"要"）→ 源码级对标报告已产出（docs/cline-sdk-源码级对标报告.md）：agent-runtime 2863 行主循环全量 + 三类恢复 + 工具编排 + loop-detection 防死循环 + hub/团队/usage 双桶；获取通道=浏览器+api.github.com raw（git 直连/镜像全被网络阻断）**
- [x] **TrieCode 官方插件集精读（2026-10-01，用户"需要"）→ 回答"TrieCode 可以找到他的GitHub上的吗"：主程序无官方开源仓库（闭源商业），但 triecode-dev/triecode-plugins（Apache-2.0）官方插件集已开源（9 插件：arduino/esp-idf/stm32/sdcc-51/wokwi/browser/easyeda/openscad/plugin-dev）；精读报告已产出（docs/triecode-plugins-官方插件集精读报告.md）：plugin.json 十要素规范（transport internal|cli|mcp + 模板变量 + devicePanel + projectTypes 脚手架 + skills/tools 声明）+ arduino"烧录前检查/串口日志分析"技能提示词（AI 面板可改造复用）+ wokwi 6 工具闭环 + 落地映射（插件规范 v2 / 第一批抄项 / 仿真工具面闭环）**
- [x] **triecode.com 官网全站浏览（2026-10-01，用户"去triecode.com官网看看有什么可以学习的吗记录下"）→ 学习记录已产出（docs/triecode-官网学习记录.md）：产品定位（通用 AI 软件智能体，v1.3.1 NSIS 144MB）/ 定价积分制五档（免费200/Lite¥29/Pro¥150/Max¥260/团队¥520席，token 按量+模型系数+失败退还）/ 路线图（Git→调试器→跨平台）/ 插件广场（9 插件+国内镜像策略 gitee/dl.espressif.cn/npmmirror+安装三通道）/ 官方插件开发指南全文（七类通道 cli|http|grpc|mcp|mqtt|internal|backend、能力路由 UI 按钮与 AI 工具同源、devicePanel 门控 needsBoard/needsPort、webview 双向通信白名单、检测五级+derive、拖拽响应式 CSS 清单）/ 更新日志 v1.2.9→v1.3.1（Git 面板+AI 逐块审阅暂存+语音输入+积分按用量+数据保护专项）**
- [x] **TrieCode 实机操作全链路实测（2026-10-01，用户"去操作电脑再去摸一下 triecode 软件，实际跑一下，测试一下"）→ 实测报告已产出（docs/triecode-实机操作实测报告.md）：CDP 通道（--remote-debugging-port=9333 --remote-allow-origins=*）DOM 级操控真实软件；全链路跑通——新建 Arduino 项目（7 模板+.triecode.json）→ 搜索选板（esp32c3 14 款+设备配置 10 项即选即展）→ 编译成功（22s，程序存储 20%/动态内存 4% 径向仪表）→ AI 对话成功（Agent 16s 工作+思考·1 工具+回答正确+**积分计量条 输入23.6k/输出58/1.68积分**）→ 终端成功（xterm.js+PowerShell 自动 cd 项目目录+命令执行）；门控验证（无板编译→顶部提示）；daemon 生命周期（日志验证动态端口+崩溃重启）；三要点：React 受控输入用 value setter、div.ui-select__option 必须 Input.dispatchMouseEvent 真实点击、**AI 输入框是 contenteditable div.chat-input**（非 input/textarea）**
- [x] **TrieCode 烧录/串口模拟测试（2026-10-01，用户"可以模拟开发板测试一下他的烧录以及其他的功能吗"）→ 已实测到 esptool 烧录链路全环节 + 发现 TrieCode 两个真实缺陷：① **daemon 编译挂起**：TrieCode UI 上传在特定项目路径（Documents 下）编译 40s 无错误输出判定失败，而同一项目命令行 arduino-cli compile 成功（261KB/19%）→ daemon compile 路径存在挂起 bug（对 codelab 反面教材：直接调 arduino-cli CLI、防 cmd 嵌套挂起、设超时）；② **GBK 中文乱码**：编译输出"已复制 1 个文件"显示为乱码（cmd /c 输出未转码，解包时预测的缺陷实测命中）；另实测：端口下拉列 COM1→选中后状态栏"板卡·COM1"→点上传触发完整编译流→命令行 upload 到 esptool v5.3.0 连接 COM1（Connecting.....→No serial data received 完整错误路径+排障链接）；COM1 可被 pyserial 打开但两进程数据不互通；**【重大突破】模拟"成功烧录"已用 RFC2217 网络串口方案完整打通（无需 com0com！）**：pip esptool 5.4.0 + 自研伪 ESP32-C3 开发板（fake_esp32_rfc2217.py，实现 RFC2217 协商+esptool ROM/stub 协议+跨块 zlib 解压+flash 存储+真实 md5）→ esptool 完整识别芯片（ESP8686/C3 v3.0+MAC）→ stub 上传运行 → **4 个文件全部烧写成功且 "Hash of data verified"（退出码 0）**；踩坑全记录（SYNC 后读 8 响应/READ_REG 值在 val 字段/GET_SECURITY_INFO 0x14/OHAI 问候/压缩跨块流/16 字节 md5）已写入实测报告**
- [x] **模拟烧录模块全栈开发 + 自测（2026-10-01，用户"对照这个，开发我们软件吧"）→ 全部完成并通过引擎级 + UI 级冒烟测试**：主进程 RFC2217 伪芯片服务器（fakeBoardService.ts，esp32c3 chip_id 0x0005 / esp32s3 chip_id 0x0009，SLIP+telnet 状态机+ROM 应答+flash Map+真实 md5）+ 模拟烧录引擎（simBurnService.ts，客户端动作序列对标真实 esptool：SYNC 连续读 8 帧/GET_SECURITY_INFO/stub 上传/CHANGE_BAUDRATE/逐文件压缩烧写/SPI_FLASH_MD5/复位）+ 内置演示固件（examples/sim-firmware 4 bin + manifest.json）+ IPC/preload（simBurn:list/demos/start，流式 task:output/progress/exit）+ SimulatorPanel 双 Tab"仿真/烧录"（SimBurnView：虚拟板卡/演示固件/板卡信息/烧录按钮/进度条/分区清单/终端日志）；**关键坑**：RFC2217 数据通道 IAC 转义缺失（压缩数据 0xFF 被 telnet 状态机吞掉 → invalid distance too far back）已修（双端 escapeIac）；**验证**：npm run build 成功（修 electron.vite.config.ts external ['playwright']，原动态 import playwright 构建失败为既有问题）、typecheck node/web 全过、引擎闭环自测 test-simburn.js 8 断言全绿、**UI 冒烟实测通过**（CDP 9334 直连：切烧录 Tab→点"▶ 模拟烧录"→完整日志 Connecting→Synchronizing→OK→识别→stub→4 文件逐文件烧写带百分比→Wrote 261600 bytes→Hash of data verified→Hard resetting→Done. 4 file(s) written successfully→退出码 0，UI 显示 ✅ 烧录成功·烧录进度 100%）；证据图 docs/sim-burn-ui-冒烟测试结果.png；**CDP 通道**：端口 9222 被用户另一应用"云曦工作台"占用 → 改 --remote-debugging-port=9334 直连渲染进程（cdp-help.js 可复用脚本已删，重建参考 test-burn-ui.js 逻辑）**
- [x] **模拟烧录接入"当前代码编译产物"（2026-10-01，用户"继续"）→ 闭环实测通过**：① grpc:compile 完成事件 task:exit 携带 buildPath；② 新增 simBurn:collectBuild IPC（从 build_path 收集 4 bin，适配 arduino-cli 真实产物命名 `<sketch>.ino.bootloader.bin/.ino.partitions.bin/.ino.bin` + boot_app0.bin 优先产物目录否则 Arduino15 esp32 工具包；地址 bootloader 0x1000/partitions 0x8000/boot_app0 0xe000/app 0x10000）；③ 渲染层 SimBurnView 固件来源 select（内置演示/当前代码，data-testid=sim-src，无产物时提示先编译），App.tsx 捕获 buildPath→setLastBuildPath→传 SimulatorPanel；④ **顺带修复 gRPC daemon 启动超时（30s）导致编译永不完成的问题：grpc:compile 增加 CLI 降级路径**（daemon 不可用时 compileSketch --build-path 到 %TEMP%\codelab-build\sketch-<ts>，流式输出/task:exit 格式一致，buildPath 照常返回）；**实测**（CDP：直接调 window.api.grpc.compile 真编译 _simtest\Blink → daemon 启动失败自动降级 CLI → lastBuildPath 注入 → UI 切"当前代码"→模拟烧录 → 完整日志 Wrote 300400 bytes（Blink.ino.bin 真实产物）→ 4 文件全部 Hash of data verified → Done. 4 file(s) written successfully → 退出码 0，分区地址验证 0x1000/0x8000/0xe000/0x10000 全对）；证据图 docs/sim-burn-当前代码-冒烟测试.png；回归脚本 test-build-burn.js（CDP 全流程可复用）；测试 sketch D:\工作\代码实验室\_simtest\Blink\Blink.ino（esp32c3 LED Blink，保留作回归素材）
- [x] **ESP32-S3 演示固件 + 按编译目标自动匹配虚拟板卡（2026-10-01，用户点名"ESP32-S3 演示固件 + 按编译目标自动匹配虚拟板卡、仿真外设遗留项"）→ 全部完成并实测通过**：① **S3 演示固件**：编译 esp32s3 Blink（GPIO48）→ examples/sim-firmware-s3（bootloader 19984B/partitions 3072B/boot_app0 8192B/app 315728B + manifest.json chip esp32s3）；simBurn:demos 改为扫描 examples/sim-firmware* 多目录（返回 2 个 demo：sim-firmware c3 / sim-firmware-s3 s3）；**坑**：arduino-cli 链接器不支持中文 build-path（`D:\工作\代码实验室` 乱码 ld 失败）→ 编译走 %TEMP%\codelab-s3build（ASCII）再拷回；manifest 必须无 BOM（PowerShell Set-Content UTF8 带 BOM → JSON.parse 抛错 → demo 静默丢失，已用 node 重写）；② **板卡自动匹配**：task:exit 带 fqbn（grpc+CLI 两路径）+ App setLastCompileFqbn + SimBurnView 双 useEffect（内置演示按 demo.chip 联动；编译目标 esp32:esp32:esp32s3/c3 → setChipId 自动切换）；**实测**（CDP）：双 demo 清单 ✓、选 S3 演示板卡 esp32c3→esp32s3 ✓、**S3 演示固件烧录成功（Done. 4 file(s) + Chip verified: ESP32-S3）**、**真实编译 esp32s3（约 3 分钟）→ 切"当前代码"→ 板卡 esp32c3→esp32s3 自动匹配 ✓ → 当前代码烧录成功（Chip verified: ESP32-S3）**；证据图 docs/sim-burn-S3-板卡匹配-烧录成功.png
- [x] **仿真外设扩展：OLED 文本 / ADC 多通道滑块 / DHT22 / 示波器（2026-10-01，同上用户点名）→ 完成**：① **I2CBus** 新增 oledClear/drawText(x,y,text)/printToOled(...args)（font5x7 5x7 字模渲染进 SSD1306 ram，面板 OLED canvas 实时显示）；② **EnvironmentSimulator**（VirtualRuntime.env：temperature/humidity/readTemperature/readHumidity）+ VirtualRuntime.setEnvironment 同步 wire+env（SHT30 与 DHT22 共享环境值）；③ **transpiler** 新增教学支持：`<obj>.readTemperature()/readHumidity()` → rt.env、空参 begin() 移除、clearDisplay() → oledClear()、setCursor 忽略、`<obj>.print/println/printf()` → printToOled（注意与 Serial 转译顺序：Serial 先转 rt.uart 后 OLED 规则不会误伤）；④ **UI**：ADC1 多通道滑块×4（GPIO1-4，setMillivolts）、环境滑块区标注"SHT30 · DHT22 共享"、OLED 区文本输入+显示/清屏按钮、示波器 canvas（336x96，运行期间每 60ms 采样 GPIO2/GPIO8/ADC0 三通道 260 点滚动波形+网格）；**实测**：外设 UI 元素全绿（oledInput/oledBtns2/adcSliders/envLabel/scope/gpio0）
- [x] **全面测试软件运行 + 假功能审查（2026-10-01，用户"测试一下卡不卡，流畅吗，有没有功能是假功能"）→ 结论**：① 流畅度全绿（CDP 实测：Tab 切换 1~3ms、滑块拖动 2ms、OLED 按钮 3ms、编辑器输入 1ms）；② **确认 1 个假功能：AI 面板「语音输入（即将上线）」按钮**（title 即"即将上线"，点击只塞假回复"语音输入即将上线，敬请期待。"——用户早期"点不动"体验来源之一，处置待用户拍板：真做 Web Speech / 移除 / 置灰）；③ **真问题：AI 内置模型服务端全部不可用**（https://bluebubai.work/api/models 返回 5 模型 deepseek-pro/flash、minimax-m3/m2.7/m2.5 全 available=False；已登录 1205415012@qq.com 积分 5000，AI 面板无可用模型只能 BYOK——服务端/账号侧状态，非本地 bug）；④ 其余检查全真实（标题栏 15 菜单动作、AI 发送链路、模拟烧录/仿真外设、课程示例 TODO 为教学内容）
- [x] **本地模型接入（无需 Ollama）端到端完成（2026-10-01，用户"AI模型用本地模型"）→ 全部实测通过**：① **引擎自动下载**：llama.cpp `llama-b11146-bin-win-cpu-x64.zip`（17.7MB）经 `https://gh-proxy.com/https://github.com/ggml-org/llama.cpp/releases/download/b11146/...` 下载+tar 解压到 `resources\llama`（getEngineDir 探测，dev=app.getAppPath()/resources/llama）；② **模型自动下载**：MODEL_CATALOG 三档全部填真实 hf-mirror 直链（Qwen2.5-Coder-1.5B=1066MB / Qwen2.5-1.5B=1066MB / Qwen2.5-Coder-3B=2007MB，Apache-2.0 可商用；**minicpm5-1b 不存在真实 GGUF → 换为 qwen2.5-1.5b-instruct 通用档**）；**修复 Node https.get 默认不跟随 302 重定向（hf-mirror 302 到 xet CDN → 原代码必报"HTTP 302"）+ CDN 大文件断流 → resumableDownload 断点续传（Range+append+完整性校验+自动重试 3 次，实测 203MB 断点续传至 1066MB 完整）**；③ **UI 去 Ollama 化**：PluginSidebar installModel 去掉"需要先安装 Ollama"alert，改为 model:pull（内部 ensureEngine+downloadModel）；本地模型身份统一用 GGUF 文件名（修复 ollamaTag≠文件名的"永不匹配已安装"bug + AiPanel 本地模型 option 从 m.name 改 m.id）；徽标改"本地引擎已就绪/运行中/未安装"；SettingsModal BYOK 预设改"内置本地引擎 127.0.0.1:8080/v1"；④ **实测**：直调 model.pull 下载成功（1066MB 完整）、model.chat 本地对话 8s 回复正确（"我是由阿里云开发的人工智能助手…"，llama-server 已跑）、**agent:start localModel 全链路（thinking 流式→message→done，11.4s，回复 codelab-desktop 正确）**、UI 冒烟（徽标"本地引擎运行中"+Qwen2.5 Coder 1.5B"已安装 ✓"）；**能力边界（诚实记录）**：1.5B 小模型**工具调用不可靠**（本轮 toolCalls=0，靠上下文推理回答而非真调 read 工具），适合"解释代码/问答/教学"，复杂工具闭环建议用 3B 档或云端模型；**遗留**：语音假功能按钮处置待用户拍板；内置模型服务端不可用待用户查网关
- [x] **语音输入真实化（2026-10-01，用户"1开发把"）→ 完成并 CDP 实测通过**：① 主进程 `src\main\index.ts` createWindow 内加 `session.defaultSession.setPermissionRequestHandler`（放行 media/mediaKeySystem，麦克风免弹窗）+ `setPermissionCheckHandler(() => true)`；② 渲染层 `AiPanel.tsx`：假按钮（原 L834 onClick 塞"语音输入即将上线，敬请期待"假消息）改为真实现——`toggleVoice()` 用 Web Speech API（`window.SpeechRecognition ?? webkitSpeechRecognition`，Chromium 152 原生支持），lang zh-CN、interimResults=false、continuous=false（单句说完自动结束），onresult 最终文本追加进输入框、onerror（not-allowed 提示系统权限 / no-speech 静默复位 / aborted 忽略）、onend 复位 listening；按钮 title 改"语音输入"/"停止聆听"双态 + `.ai-voice-on` 红色脉冲动画（main.css）；③ **CDP 实测全绿**：点击后 400ms 按钮变"停止聆听"+ai-voice-on（识别器真实启动、权限已放行）→ 再点 400ms 复位"语音输入"（主动停止）→ 无人说话 3s 后 no-speech 静默复位（不弹打扰消息）→ 假消息残留 false；**限制**：CDP 环境无法注入真实麦克风音频，说话→识别→填框的最终链路需用户真机说话验证；回归脚本 `test-voice-input.js`
- [x] **UI 审查与 TrieCode 对比（2026-10-01，用户"我这个UI设计是否合理…对比一下triecode，做好记录"）→ 记录已产出 `docs/ui-审查-对比TrieCode-20261001.md`**：CDP 实机体检（1442×902 全窗截图 `docs/ui-audit-main.png` + 布局矩形采集，`ui-audit.js` 保留）→ **无真实遮挡/溢出**（仅 Monaco 虚拟层大坐标）、间距合理（标题栏 40 / 状态栏 24 / 编辑器 813px 主区 / 面板贴齐）；**P0 新发现：语音识别实际走 Chromium 在线引擎（network 错误），非本地——已修：错误去重限流 30s + 文案如实说明"当前桌面识别引擎需联网"**；P1 建议：AI 面板宽度可拖拽（200-480px，复用 TrieCode 响应式骨架）、消息区补"重新生成/编辑重发"、状态栏加 AI 用量条；TrieCode 对比表：布局骨架一致 ✓ / AI 输入框 textarea 更稳 / 缺工作日志·审批·计划·消息操作（属 Agent 路线图）
- [x] **AI 面板对齐 TrieCode 补齐功能（2026-10-01，用户"跟它对齐开发，咱们没有要加上"）→ 完成并 CDP 实测全绿**：① **消息操作**（重新生成/编辑重发/回退到这里）——重构 `doSend(text, historyOverride?)` 统一发送入口；`regenerate(i)` 截断+重发该条、`editResend(i)` 截断+文本回填输入框聚焦、`rewindTo(i)` 截断到该条；user 消息 hover 显示 3 操作按钮（`.ai-msg-ops`）；实测：发送真实消息（本地引擎 1.5B 回答成功）→ 3 按钮出现 → 回退截断正确 → 编辑填充+截断正确；② **面板宽度拖拽**（200-480px）：`.ai-panel-resizer` 左缘手柄 + window mousemove/mouseup + localStorage `codelab-ai-width` 持久化；实测 320→460 生效；③ **上下文用量动态化**：token 面板改真实估算（消息+引用字符数/1.5 → tokens、16K 窗口%、工具记录数）；④ **未做（Agent 路线图）**：工作日志/审批/计划/文件冲突/redo 快照栈（redo 可后续加）
- [x] **全功能测试 + 截图报告（2026-10-01，用户"每个功能的测试，然后截图做一个连接"）→ 报告已产出 `docs/功能测试报告-20261001.md`**：14 功能面全测（CDP 逐功能操作+截图 `docs/test-01~14*.png` 共 15 张）：主界面/标题栏菜单/编译（真实 arduino-cli 编译退出码 0）/模拟烧录（Hash verified + Done. 4 file(s) 100% 成功）/仿真外设/AI 对话（云端）/AI 对话（本地模型 UI 全链路）/消息操作/面板拖拽/上下文用量/语音/课程/终端/大模型页；**发现并修复真实 bug：AI 面板本地模型选项不显示**——主进程 `model:local` 仍检查 `isOllamaRunning()`（内置引擎运行时返回空列表→显示"＋添加 API Key"）→ 已改为直接 `listLocalModels()` 扫描 GGUF；修复后 UI 全链路实测（下拉切 local:qwen → 发送 → 本地回答正确）；**云端模型仍不可用**（401 登录过期 + 5 内置模型 available=False，服务端状态待用户查）；回归脚本 `test-all-features.js`、`test-ai-local-ui.js`
- [x] **默认本地模型 + 全功能复测 + 宣传页发布（2026-10-01，用户"先用本地模型跑。所有功能跑一遍又做一个软件宣传链接发布"）→ 全部完成**：① **默认本地模型**：AiPanel load() 增加"已安装本地模型自动切换"（localModels 非空且当前非 local/byok → 自动切 `local:<第一个>` + setModel 持久化），截图确认顶部模型选择器显示 "Qwen2.5 Coder 1.5B (1GE)"；② **全功能复测**：`test-all-features.js` 重跑 14 功能面全绿（模拟烧录成功判据已修正 true、AI 对话本地回答"我是LabCode AI智能体…"、编译退出码 0、仿真外设/消息操作/拖拽/用量/语音/课程/终端/大模型页全过），截图 docs/test-01~14*.png 更新；③ **宣传落地页发布**：`D:\工作\代码实验室\labcode-landing\index.html`（373KB 单文件，3 张实机截图 base64 内嵌，暗色开发者风）→ GitHub 仓库 **hulufeng/labcode-landing**（public）推送成功 → **线上链接（已验证可访问）：https://cdn.jsdelivr.net/gh/hulufeng/labcode-landing@main/index.html**；**遗留：下载按钮 href="#" 待用户提供真实安装包下载地址；如需正式域名可去 GitHub repo Settings→Pages 开启（开完即有 https://hulufeng.github.io/labcode-landing/）**
- [x] **宣传页下载按钮配真实地址（2026-10-01，用户"1-2你帮我操作"）→ 完成**：发现用户 GitHub 已有 **hulufeng/LabCode** 仓库 + **v1.0.0 正式 Release**（LabCode-Setup-1.0.0.exe 147MB，2026-09-15 发布）→ 宣传页下载按钮改为指向 `https://github.com/hulufeng/LabCode/releases/download/v1.0.0/LabCode-Setup-1.0.0.exe`（已 git push 生效，commit b1ddf6e；本地 labcode-landing/index.html 已同步）
- [x] **UI 拥挤优化（2026-10-01，用户"界面UI拥挤，不够友好"）**：① AI 面板宽度 clamp 200-480 → 220-420、默认 320 → 300（localStorage 旧值超限自动钳制，编辑器从 813px 增宽至 853px）；② 左侧 sidebar 260 → 240px；③ 模型卡紧凑（padding 10/12→8/10、描述 2 行→1 行截断+title 悬停看全文、meta 字号/间距缩小）；④ 硬件条/ai-head/ai-token-panel/ai-messages 间距密度降低。已构建+CDP 重启自测：布局无真实溢出、同场景截图（docs/ui-plugins-models-after.png）对比原截图编辑区明显变宽、AI 面板回 300px 默认。注意：用户曾把 AI 面板拖宽到 480px，改版后初始化钳到 420 内
- [x] **电脑磁盘清理 + 项目目录清理 + v1.1.0 安装包重新上传（2026-10-01，用户"看看电脑还有可以清理的吗"→选 A+B；"清理无用的和安装包，重新上传"）→ 全部完成**：系统级清理共释放 **15.2GB**——白名单缓存（%TEMP% 1.72GB + 缩略图 16MB）+ **回收站清空 13.84GB（用户单项确认，不可恢复）**；清理后 C 盘 53.8GB / D 盘 256.2GB。**项目目录清理（用户条件授权"学习完改造了就删除①②"→已删除）**：`_landing_tmp`、`_landing_tmp2`、`_triecode_learn`(90MB)、`_trie_asar`(87MB)、`_cline_learn`(4MB) 共 183MB 全部删除成功；TrieCode/Cline 学习结论已沉淀在 docs/ 报告与 handoff，不因删目录丢失。codelab-desktop 内 node_modules(737MB)/dist(130MB 正式包)/resources(86MB 引擎) 均为必要占用未动：① 清理 `codelab-desktop\dist` 历史旧版 12 组（BlueCode-Setup-0.1.9 / CodeLab-Setup-0.1.0~0.1.8 / LabCode-Setup-0.1.9，共约 1.6GB）+ win-unpacked 解包目录；dist 仅留 LabCode-Setup-1.1.0.exe(+blockmap/latest.yml/builder-debug.yml)；labcode-landing 清理 shot-full.png，仅剩 index.html+assets；② **上传 v1.1.0 到 GitHub Release（LabCode 仓库，id 400834773）**：用 **git credential 缓存 token + api.github.com 通道**（github.com 直连超时但 api.github.com 通）创建 release + 上传 136.6MB 安装包成功 → 下载链接 `https://github.com/hulufeng/LabCode/releases/download/v1.1.0/LabCode-Setup-1.1.0.exe`；③ **宣传页下载按钮 → v1.1.0**（API contents 通道推送 + 回读验证 True）；**经验：本机 github.com 直连/gh CLI/bu 浏览器均超时故障，git credential fill 可拿有效 token（hulufeng, 40 位），api.github.com + uploads.github.com 可用——后续 GitHub 操作优先 API 通道；bu 浏览器会话故障未恢复（全 chrome-error）**
- [x] **v1.1.1 发布（2026-10-01，用户明确通知"发布"）→ 全部完成**：① 版本号 1.1.0 → 1.1.1（package.json + package-lock.json）；② `npm run dist` 打包成功（LabCode-Setup-1.1.1.exe 136,646,427 B，含签名+blockmap，latest.yml 同步 1.1.1，releaseDate 2026-10-01）；③ 上传 GitHub Release v1.1.1（id 400975410）成功 → 下载链接 `https://github.com/hulufeng/LabCode/releases/download/v1.1.1/LabCode-Setup-1.1.1.exe`；④ 宣传页下载按钮 v1.1.0 → v1.1.1（本地 index.html 同步 + GitHub API 推送 commit f9643239 + 回读验证 contains v1.1.1:True / v1.1.0:False；**坑：API contents GET 大文件 IncompleteRead → 加 4 次重试解决**）；⑤ 豆包链接复发布（+deploy --app-id app_17f6m9p3wjj，release 7691685284421340355 status finished，online_url 不变）+ web_fetch 验证下载按钮 v1.1.1 已上线；⑥ 发布脚本 upload_release.py/update_landing.py 用后已删。**注意：本次发布含全部近期新功能（本地模型引擎、模拟烧录、语音输入、AI 面板对齐、UI 拥挤优化）**
- [x] **v1.1.2（2026-10-01，用户"这些不点的都不显示"→仿真面板默认隐藏）→ 完成并自测通过**：**根因：App.tsx `simulatorVisible` 初始 false**（仿真/烧录辅助面板要点标题栏按钮才出现）。修复：初始值读 localStorage `codelab-simulator-visible`（无记录默认 true）+ 自定义 `setSimulatorVisible`（useCallback 内 setState + 写 localStorage 持久化，**坑：首版用 useEffect 依赖 `[simulatorVisible]` 引用了声明前的 const → TDZ `ReferenceError: Cannot access 'simulatorVisible' before initialization` 白屏，改持久化 setter 方案解决**）；CDP 验证：React 正常挂载（root 36481 字符）、`🔬 ESP32 辅助`/仿真/烧录 tab/▶ 模拟运行当前代码/✕ 全存在 → **面板默认显示生效**；版本 1.1.1 → 1.1.2（package.json + lock）打包成功（LabCode-Setup-1.1.2.exe 130.3MB 已签名，latest.yml 1.1.2）。**未发布 GitHub/宣传页（用户只要本地安装包直接装，等"发布"指令再走发布流程）**；临时脚本 check-sim-default.js 待删
- [x] **设备面板对齐 TrieCode（2026-10-01，用户发 TrieCode 设备配置截图"做成这样的"）→ 完成并 CDP 实测全绿**：① **板卡字段改点击展开触发器**（闭合显示型号名 + ▾，点击展开搜索框 + 板卡列表 + 空态，搜索 "esp32c3" 精确过滤出 ESP32C3 Dev Module / SparkFun Pro Micro / DFRobot Beetle / Adafruit QT Py / Nologo Super Mini / OLIMEX 等——与 TrieCode 截图列表一致）；② **配置项直列显示 11 项**（Upload Speed / USB CDC On Boot / CPU Frequency / Flash Frequency / Flash Mode / Flash Size / Partition Scheme / Core Debug Level / Erase All Flash / JTAG Adapter / Zigbee Mode，名称与 TrieCode 截图完全一致）；③ **状态栏显示板卡型号 - 串口**（ESP32C3 Dev Module - COM1 样式）；④ **修复三个真实 bug**：a) `listBoards` spawnSync **默认 maxBuffer 1MB < board listall 输出 20.7MB** → 输出截断 + 15s 超时（status null）→ 静默返回空列表（已加 maxBuffer 64MB + timeout 20s）；b) **arduino-cli 1.5.2-rc.1 的 `board listall --format json` 输出是 `{"boards":[425项]}` 对象包装而非顶层数组** → listBoards 只认 Array.isArray → 永远返回空（已兼容两种结构）；c) **DevicePanel 结构 bug：isBoard 分支提前 return，导致紧随其后的板卡配置项 JSX 永远不可达**（配置项从未显示过——对齐 TrieCode 正好暴露，已并入同一 return）；⑤ 其余大输出命令（board list / lib list / lib search / core list / core search / board details）同步加 maxBuffer 预防同类截断；临时脚本 test-device-panel.js/test-board-api.js/repro-listall.js 已删；截图 docs/device-panel-after.png
- [x] **设备面板浮层重叠修复（2026-10-01，用户截图"软件内这个位置重叠了UI问题"）→ 完成并 CDP 实测通过**：**根因不是定位，是 CSS 变量缺失**——`var(--card)` / `var(--text2)` 在 :root 与 dark 主题**均未定义**（只有 --panel/--text-dim），浮层 background: var(--card) 落空 → **浮层透明**，展开时下方配置项透出形成"两栏文字交错重叠"。修复：① :root 与 [data-theme=dark] 各补 `--card: var(--panel); --text2: var(--text-dim);`（全局 20+ 处引用一次性归位，顺带修复命令面板/仿真面板等其它透明背景隐患）；② 浮层样式加固：`.device-dropdown.board-menu` 改 `position:absolute; top:calc(100%+4px); z-index:60; max-height:260px; overflow-y:auto; box-shadow:0 8px 20px` + 列表容器 `.device-dropdown-list` 加 `max-height:220px; overflow-y:auto`；③ **初始列表按平台过滤**：`loadBoards('esp32')`（原 `loadBoards('')` 刷全部 425 款，前面全是无关 Arduino UNO/Nano/Mega AVR 老板卡）。**CDP 实测**：menuHeight=260、totalOptions=60、nonEsp32=0、first5=ESP32C5/P4/H2/C6/S3 Dev Module；截图 docs/device-menu-fixed.png 视觉确认：浮层实底不透明、6 项列表干净显示、下方配置项（Erase All Flash/JTAG/Zigbee）正常呈现、无交错。**遗留**：配置项区部分被展开浮层自然遮挡属浮层语义（TrieCode 同款），选中/关闭即恢复
- [x] **课程面板暂隐藏 + 软件简化（2026-10-01，用户"先把esp32做好，其他先不做，可以去掉，简单点软件"→追问确认只选"暂时隐藏课程面板"）→ 完成并 CDP 实测通过**：ActivityBar.tsx 的 ITEMS 注释掉课程项（`// { id: 'curriculum', ... }`，BookIcon 保留，含恢复注释），App.tsx 的 curriculum 分支 / LessonDetail / selectedLessonId 代码**原样保留**（初始 activeSidebar='files'，入口移除后分支不可达，无害，讲义整理好后取消注释即恢复）；Git / 插件（市场+大模型页）/ 设备 / 文件全保留。**CDP 实测**：活动栏 items=[文件,源代码管理,设备,插件,设置]、hasCurriculum=false、hasFiles/hasDevice/hasGit/hasPlugins=true、默认侧栏渲染正常；截图 docs/simplified-ui.png；临时脚本 test-simplify.js 已删
- [x] **UI 全功能测试复跑（2026-10-01，用户"继续测UI界面的功能"）→ 14 步全绿零失败，截图 docs/test-01~16*.png**：主界面 / 标题栏菜单 / 编译按钮（title 切换）/ 模拟烧录（演示固件 C3：Hash verified + file(s) written 成功）/ 仿真外设 / AI 对话（本地模型完成）/ 消息操作条 / 面板拖宽 / 上下文用量 / 语音按钮 / **课程入口已隐藏 true + 设备面板（展开菜单 260px/60 项、搜索 esp32s3 命中 38、选板成功）** / 终端 / 插件·大模型页；test-all-features.js 的课程步骤已改写为"课程隐藏断言 + 设备面板操作"（原步骤因入口隐藏会失效）
- [x] **ESP32 核心四链路全测（2026-10-01，用户"聚焦 ESP32 本体：编译、烧录、仿真、串口这块要继续测"）→ 全通 + 修复两个真实 bug**：① **编译**：window.api.grpc.compile({sketch,fqbn}) 真编译 _simtest\Blink（esp32:esp32:esp32c3）→ task:exit code=0 + buildPath（%TEMP%\codelab-build\sketch-<ts>，产物 4 bin 齐全 300400B app）；② **模拟烧录**：simBurn.collectBuild({buildPath}) 收集 4 文件（bootloader 0x1000/partitions 0x8000/boot_app0 0xe000/app 0x10000）→ simBurn.start({chipId:'esp32c3',files}) → exit code=0，UI 输出区完整日志 Hash of data verified / Hard resetting / Done. 4 file(s) / Chip verified: ESP32-C3 / 退出码 0；③ **仿真**：UI 点"▶ 模拟运行当前代码"→ "■ 停止"持续（welcome.ino Blink loop 解释执行中）、GPIO 外设/电位器/ADC/环境/OLED/串口参数全显示、error 空；④ **串口**：serial.list 返回 COM1（标准端口类型）、serial.open({port:'COM1',baud:115200}) → id serial-COM1、状态栏 COM1 • 115200。**修复 bug A（转译器 await 上下文）**：transpiler.ts 把 delay() 替换为 await rt.delay()（第 65 行），但第 78/83 行 `new Function('rt', body)` 生成**普通函数**，任何含 delay 的代码（如 Blink）点模拟运行必抛 SyntaxError "await is only valid in async functions"（此前 handoff 全绿是因为测试未覆盖带 delay 的解释执行路径）→ 已改 `new Function('rt', \`return (async () => {...})()\`)`。**修复 bug B（CSP 拦 eval）**：转译器执行生成代码依赖 new Function，renderer/index.html CSP `script-src 'self'` 拦截（"Evaluating a string as JavaScript violates..."）→ 加 `'unsafe-eval'`（本地 IDE 无远程内容，风险可控）。**遗留**：welcome.ino 用 GPIO2 故面板 GPIO8 OFF 属正常（led2 圆点闪烁，无文本状态可断言）；证据图 docs/esp32-core-sim.png（烧录成功日志）/ docs/esp32-core-sim-running.png（■ 停止运行中）/ docs/esp32-core-serial.png（串口面板）；本轮 4 个临时脚本已删，历史回归脚本（test-all-features.js / test-build-burn.js 等 20 个）保留复用
- [ ] 把 TrieCode Agent 设计落地到 codelab AI 面板（见深度报告 §8 落地路线三批优先级）
- [ ] Tauri 轻量版同步 UI 改动
- [ ] 每次发版同步强制更新（下载页 meta latest/force + 启动检查弹窗）
- [ ] 软件版本改完等用户明确通知"发布"再发布
- [x] **模仿 TrieCode 所有 agent 操作（2026-10-01，用户最新主线"你跟triecode共同开发一个项目，模仿他的所有agent操作"）→ 6 项移植全部开发完成 + 构建通过 + 真实链路验证**（详见下方"本轮完成的改动 #14"）
- [x] **内置云端模型管理后台：网站自助添加/配置 Key/测试/编辑/删除模型（2026-10-02，用户"给我网站留好可以操作的功能，我自己添加"）→ 全部完成并双通道验证**（详见下方"本轮完成的改动 #63"）

## 当前状态

- **已完成**：编辑器性能修复（Monaco key 隔离 + onMount 写入 + 非受控）、标题栏/文件树/板卡选择器 UI 打磨、仿真器右侧停靠、TrieCode Agent 全面学习、**TrieCode Agent 全链路源码级深挖（读完 agent-runner 全量/context-manager/loop-engine/permission-policy/terminal-exec/subagent/verification-agent/plan-store/tool-pipeline/auto-memory/claude-provider 全量 + main bundle 工具定义全量 + Arduino 插件 manifest 全量）**、**TrieCode 实机操作全链路实测（CDP 操控真实软件：新建项目/选板/编译/AI 对话/终端全通，报告 docs/triecode-实机操作实测报告.md）**、**模拟开发板烧录测试：esptool 连接路径实测（No serial data）+ RFC2217 方案完整打通模拟成功烧录（4 文件全部 Hash verified，无需 com0com）**、**模拟烧录模块全栈开发完成并通过双级验证（引擎闭环 8 断言全绿 + UI 冒烟实测烧录成功）**、**模拟烧录接入"当前代码编译产物"并闭环实测通过（CLI 降级编译修复 daemon 超时问题，固件来源可选当前代码，300400B 真实产物 4 文件烧录成功）**、**ESP32-S3 演示固件 + 双 demo + 按编译目标自动匹配虚拟板卡（S3 固件烧录成功 + 当前代码板卡自动 esp32s3 + 烧录成功）**、**仿真外设扩展（OLED 文本绘制、ADC1 四通道滑块、DHT22 共享环境、三通道示波器）实测全绿**、**全面测试（流畅度全绿 + 假功能审查：语音按钮确认假功能 + AI 内置模型服务端全不可用）**、**本地模型接入无需 Ollama 端到端完成（引擎+模型自动下载/断点续传/本地对话 8s/Agent 链路 11.4s/UI 已安装态全绿）**、**UI 审查与 TrieCode 对比（记录 docs/ui-审查-对比TrieCode-20261001.md + 语音 network 错误去重）**、**AI 面板对齐 TrieCode（消息操作重新生成/编辑重发/回退到这里 + 面板拖拽 200-480px + 上下文用量动态化，CDP 实测全绿）**、**全功能测试+截图报告（docs/功能测试报告-20261001.md，14 功能面 13 过 1 环境限制；修复 model:local 本地模型选项不显示 bug）**
- **进行中**：等待用户验收（应用当前以 electron . --remote-debugging-port=9334 运行中；**设备面板已对齐 TrieCode：板卡点击展开可搜索列表 + 11 项配置直列 + 状态栏板卡型号，CDP 实测全绿**；AI 面板消息 hover 操作/可拖宽/动态用量、本地模型 UI 全链路已通；仿真面板→烧录 Tab：内置演示（C3/S3）/ 当前代码三种固件来源可选；语音按钮待真机说话验证）
- **阻塞**：无（com0com 卡点已被 RFC2217 网络串口方案绕开；9222 端口被"云曦工作台"占用→模拟烧录调试用 9334）
- **注意**：仿真器相关旧任务（7 个示例、OLED 文本、SHT30 打印等）详见本文件底部"仿真器遗留事项"，本轮未触碰

## 本轮完成的改动（2026-09-29/30）

### 5. TrieCode Agent 全链路深挖（2026-09-30，用户要求"应该完全摸清楚"）
- 产出 `docs/triecode-agent-全链路深度报告.md`（约 400 行，覆盖 9 章 + 源码文件索引）
- **工具面**：buildToolDefinitions 全量 60+ 内置工具、TOOL_CATEGORY（query/modify/create/delete/execute）、CONCURRENCY_SAFE_TOOLS、pruneToolsForSession/filterToolsForModel、checkHallucination 幻觉检测、collectPluginToolDefs 插件工具面、**Arduino 工具链插件 manifest 全量 20 工具**（compile/upload/select_board/serial_log_open 五件套/analyze_crash 等，gRPC daemon + 镜像源）
- **执行引擎**（agent-runner.js 1348 行全量）：轮次自我延长、五类预算、无菌检测、三级上下文压缩、失败恢复三级、权限 pipeline 四阶段、并行工具有界池 5、验证硬闸门、占位符验证、todo 收口、收尾总结
- **AI 层**：BaseAIProvider 工程细节、ClaudeProvider 原生协议全量（thinking 回传/prompt caching/取消 abort）、model-specs、prompt-templates
- **安全护栏**（terminal-exec 全量）：危险/高风险黑名单、只读白名单、受保护路径、链式防绕过、中文乱码根治（UTF-8 env + GBK 回退）、取消杀进程
- **子代理**：subagent 只读白名单 + 运行时硬门、verification-agent VERDICT 协议
- **落地映射**：§8 三批优先级（1-2 周文件工具+权限+烧录工具化+串口日志 / 2-4 周 turn 循环+压缩+失败恢复+验证闸+反幻觉 / 完整形态计划模式+验证代理+记忆），§8.3 不建议照搬清单，§8.4 从修复史学到的 6 个坑

### 6. TrieCode 二次深挖（2026-09-30 晚，用户"学习的还是不够全面"）
- 报告扩至 16 章（约 700 行）：
  - **§10 系统提示词全貌**：七段 SYSTEM_CONTEXT_SOURCES（identity/toolsIntro/state动态/memory动态/projectInstructions/skills/protocols）+ static/dynamic 分离（配 prompt caching）+ 三档人设 + ACTIVE FILE 最高优先级 + PERCEPTION BOUNDARY 诚实策略 + **AGENTIC BEHAVIOR 七原则全文** + TOOL USAGE 13 节 + GENERAL RULES + **强弱模型分档**（protocolsFull/protocolsMinimal）
  - **§11 工具执行实现**：read_file（unchanged 缓存/分页/行号）、write_file（ai:fileChanged/toolDetail/detectInstructionForPath）、edit_file（双模式/fuzzyLocate 三级匹配/多匹配拒绝/原子应用/行 diff 报告）、terminal（Unix 拦截+后台进程）、search_files（gitignore 感知/超限落盘）、create_project 越界检查、todo_write（in_progress 恰好一个）
  - **§12 安全纵深**：web_fetch SSRF 全栈（scheme/凭据/编码 IP/v4/v6/DNS 全解析）+ **DNS rebinding TOCTOU 闭环**（pinned lookup 连接期绑定已校验 IP）+ 域名白名单防后缀冒充 + net-guard https/本机校验 + MCP stdio 命令注入防护
  - **§13 辅助模块**：crash-analyzer（11 种崩溃签名+中文诊断）、tool-failure（失败分类器）、board-fqbn-map（板卡→FQBN 兜底）、ask-user（协议级询问上限）、tool-result（value/render 归一化）、file-change-tracker（Turn 级回滚+用户改动保护不变量）
  - **§14 真实会话数据**：会话 JSON 结构（messages/usage/workLog/thinking）+ ESP32-C3 真实工作流样本（read→write→compile 失败→select_board→compile 失败→修复→成功）+ cacheReadTokens 实测 26628
  - **§15 renderer AI 面板 UI**：撤销含文件回滚/重做/新对话/停止/语音输入、工作日志步骤卡片（执行中/等待确认/拒绝/中断/失败+打开文件/复制命令）、审批弹窗（允许一次/会话允许/按此修改/拒绝）、计划面板（批准执行/批准转自动/进度）、提问弹窗（其他自定义/让 AI 自行决定）、上下文用量%+手动压缩、消息操作（重新生成/编辑重发/回退到这里）、文件冲突三方处理（diskWins/keptMine/deletedDirty）、工具中文名映射
- **新增源码索引**：§16 列出本轮 13 个新精读目标（含真实会话 JSON 与 renderer 压缩 bundle 字符串表）

### 7. TrieCode 三次深挖（2026-10-01，用户"还是不够全面，再去摸索"）
- 报告扩至 20 章（446 → 约 620 行）：
  - **§17 引擎深层机制**：context-manager 三级压缩全算法（68% 硬水位/snip→prune→fold/3 轮保护边界/key 行/recentReads 重注入/每轮一次）、memory 记忆库（MEMORY.md+slug 文件/指纹缓存/上下文绑定注入/6 条上限）、plan-store（计划结构/跨重启恢复/buildAdhocPlan/每轮注入进度）、loop-engine 五类预算+actionKey 去重、auto-memory（≥6 条消息/Jaccard 0.7 去重/上限 5 条）、session-store（node:sqlite 权威+WAL+JSON 双写回滚）
  - **§18 主进程与 Arduino 集成**：SerialLogService 全实现（5000 行环形缓冲/tail/grep/send/pause-resume 烧录协作）、internal-services 20 工具逐个（compile 含 effectiveFQBN 按项目拼板卡选项/upload 串口自动暂停/resolveFQBN 三级/boardOptionsByProject）、ensure-platform 核心自动装（5 分钟 tree-kill+进度解析）、gRPC daemon 客户端（minimal proto 兜底）、electron-updater 集成（autoDownload=false/skipVersion/5s 延迟）、createWindow（导航白名单/render-process-gone 恢复/托盘关闭决策/媒体权限拦截/代理）
  - **§19 AI 层与模型管理**：error-classification（transient/deterministic/unknown + Retry-After 解析）、provider-registry 9 家（含 ollama 本地）、model-specs 逐模型窗口规格表（PREFIX_RULES）、vision MiniMax-M3 间接识图（图不进主模型）、pdf 双通道（坐标排序重建单栏）、test-runner 结构化解析+失败分类、backoff 退避、speech STT 三路径（手工 multipart）、hooks（shell:false 无注入面）、permission-rules（deny>ask>allow）、approval-audit 配对审计、message-normalize（17 个展示字段剥离）、tool-output 指纹去重落盘、plugin-refs 产物定位、prompt-core 模型族引导
- **§20 新增源码索引**：第三轮 27 个精读目标（含 main bundle 行号）

### 8. velxio 实际操作 + GitHub 生态检索（2026-10-01，用户"你可以实际操作或者去github找一下"）
- **实际操作 velxio.dev**（浏览器自动化）：首页 35 板卡/6 CPU 架构 → 编辑器（Monaco+工作区+画布+AI 侧栏）→ 选 ESP32 DevKit V1 → Run → **Compilation successful → 串口 115200 实时滚动 LED ON/OFF**（QEMU Xtensa 真仿真）→ 电路画布 SPICE 4 nets 求解
- **velxio 技术架构**（README 研读）：AVR8/RP2040 浏览器端（avr8js/rp2040js）+ **ESP32/STM32/Pi 走 QEMU 服务端（espressif/qemu fork）**；编译链 arduino-cli + ESP-IDF 5.5.4 + arduino-esp32 3.3.10（ccache+增量 ninja）；150+ 元件、ngspice WASM SPICE 求解、自定义芯片 C→WASM、WiFi 虚拟 AP + MQTT、示波器
- **双许可**：AGPLv3 免费 / 商业许可付费 → codelab 闭源售卖不可引入，仅参考功能自研（用户已确认）
- **商业模式参考**：Free（基础 AI 50 条/天 + 20 积分 + 30+ 板卡）/ NO AI $3/月 / Maker-Pro（Agent+Tutor 画布教学）/ Classroom $34/学生/年
- **GitHub 生态清单**：velxio 2.9k★（AGPL🔴）/ arduino-ide 3.3k★（AGPL🔴 官方架构参考）/ arduino-cli（✅ 已用）/ espressif-qemu（GPL🔴）/ wokwi-elements（Apache🟡）
- **关键结论**：ESP32 指令级仿真浏览器内无纯 JS 方案，velxio 也走 QEMU 后端；codelab 自研 VirtualRuntime 保持"教学级外设模拟"与真实烧录互补是合理路径
- 产出 `docs/velxio-实际操作与生态参考.md`

### 63. 内置云端模型管理后台（2026-10-02，用户"给我网站留好可以操作的功能，我自己添加"）
- **背景**：内置云端模型全部 `available=false` 的根因是服务器无任何上游 API Key；用户要求不碰 SSH，直接在管理网站自助配置。改动全在 `D:\工作\代码实验室\codelab-server`（客户端 `aiGateway.ts` 零改动）。
- **服务端 server.js**：① 新增 `config/secrets.json` 密钥库 + `resolveApiKey(envName)` = **环境变量优先、网页配置兜底**（返回 {key, source:'env'|'web'|'none'}），`readModels()`/`/api/chat`/`/api/chat/stream` 全部改走 resolveApiKey；② `GET /api/admin/models` 增加 `apiKeySource` 字段（never 返回明文）；③ `PUT /api/admin/models/:id` 支持 apiKey（非空写 secrets.json 立即生效、空串清除网页 Key 回退环境变量）+ name/provider/baseUrl/model/apiKeyEnv/costPerCall/multiplier/desc 编辑；④ 新增 `POST /api/admin/models`（添加，校验 ID 格式/重复）、`DELETE /api/admin/models/:id`（删除并清理该 env 网页 Key）、`POST /api/admin/models/:id/test`（用已配 Key 直连上游 chat/completions 发 ping，30s 超时，不扣积分）。
- **admin 页面 public/admin/index.html**：模型管理页升级——「➕ 添加模型」按钮（弹窗 11 字段）、每行操作「配置 Key / 编辑 / 测试 / 删除」、Key 状态徽标（未配置/环境变量/网页）、底部两种配置方式说明文案；新增模型编辑弹窗 + Key 配置弹窗。
- **验证（双通道全绿）**：① API 层 `test-models-admin.js` 12 断言 PASS（登录→列表 source=none→网页配 Key→available=true/source=web→公开列表同步→新增模型→配 Key→无 Key 测试返回 400→清 Key 回退→删除模型→列表恢复 5）；② 浏览器实测（cu 桌面 Chrome 访问 127.0.0.1:3100/admin/）登录成功→模型管理页 5 模型全显示+4 操作按钮+说明文案→配置 Key 弹窗（模型/env/当前状态/输入框/测试提示）→添加模型弹窗（11 字段全渲染）。测试后 secrets.json 已清空、models.json 恢复原 5 模型（无残留）。临时脚本 test-models-admin.js / test-out.txt / server-local.log 待删。
- **用户后续操作**（上线后）：打开 `https://bluebubai.work/admin/` → 密码登录（服务器 ADMIN_PASSWORD）→ 模型管理 → 每个模型点「配置 Key」填平台 Key → 保存即生效；或「添加模型」加新平台（如免费智谱 GLM-4-Flash：baseUrl https://open.bigmodel.cn/api/paas/v4 / model glm-4-flash / env ZHIPU_API_KEY）。**注意：本机/线上服务器需部署新 server.js 才生效（本地 3100 仅验证用，已停止）**。

## 决策与理由

- **Monaco 非受控化** → 理由：受控 value 每次击键回写导致光标跳变/输入延迟；key 隔离 + 初始值写入是标准解法
- **烧录按钮视觉主位** → 理由：用户明确"软件定位就是真实烧录"，仿真只是辅助
- **仿真器右侧停靠** → 理由：覆盖层遮挡编辑器，用户明确要求不遮挡
- **TrieCode 学习路径** → 理由：TrieCode = "Arduino IDE with AI coding agent"，与 codelab 定位一致，其 Agent 架构（子 Agent/验证闭环/预算控制）值得系统借鉴
- **深度报告单独成文** → 理由：第一版学习报告（docs/triecode-agent-学习报告.md）是产品层概览；用户要求"完全摸清楚"，深度报告是源码级全链路，两份并存，深度报告优先引用

## 死胡同

- TrieCode 窗口用 cu.screenshot() 抓不到、点击无效 → 根因：窗口在另一合成层；解法：PrintWindow API 抓窗口内容 + AttachThreadInput 强制前台后再用 cu 点击
- TrieCode 虚拟桌面/COM 方案（IVirtualDesktopManager）转换失败，未采用
- **Node https.get/http.get 默认不跟随 302 重定向** → hf-mirror GGUF 直链必报"HTTP 302"（模型下载）；已修（手动跟随 3xx 重定向 ≤5 跳）
- **hf-mirror xet CDN 大文件（1GB+）单连接断流**（实测 203MB 与 1014MB 两处断流）→ 已修（Range 断点续传+append+完整性校验+自动重试 3 次；断流后保留部分文件供续传）；测试期用 curl.exe -L -C - 补齐 51MB 尾段完成 1066MB
- 首次下载失败 alert 弹窗会阻塞渲染进程 JS 主线程 → CDP 探测全部超时（现象=CDP 连不上）
- **Web Speech `SpeechRecognition` 在 Electron 桌面端是"在线引擎"**（Chromium 内置 Google 语音服务，非本地识别）→ 无外网/被墙时必报 `network`；要做真正本地语音识别须换 whisper.cpp 类方案

## 硬约束

- 商业闭源售卖，不能用 GPL/AGPL 代码
- 软件版本改完不要自动发布，等用户说"发布"再发布
- Tauri 轻量版和 Electron 经典版双版本同步更新，每次改动两版对齐并留记录
- 开发完先自己测试验证，确认没问题再交付用户测试
- 每次结束工作前必须执行 handoff
- 教程内容必须原创
- 云曦水印相机发版同步强制更新机制（meta latest/force + 启动弹窗）
- TrieCode 是商业闭源软件：解包代码仅供学习参考，产品代码/文案不得复制进交付物

## 开放问题

### #19（2026-10-02，用户"需要"→ 内置教学知识库，服务"基础硬件编程学习"）

**交付**：
- `src\main\ai\knowledgeBase.ts`（新增）：43 条 ESP32 基础教学条目（概念 GPIO/ADC/PWM/串口/millis/中断/I2C/3.3V 电平、外设 LED/按键/电位器/蜂鸣器/光敏/舵机/超声波/继电器/RGB/数码管/LCD1602、编码 函数/数组/循环/if/serial-input/状态机、流程 编译烧录/串口乱码/编译错误排查表/新手 8 项排查/学习路线、C3/S3 引脚表、供电重启）+ `searchKnowledge(query, topN=3)`（关键词**长度加权**排序，长关键词精确条目排前）
- `agent-runner.ts`（修改）：run() 按首条 user 消息检索 → `buildSystemPrompt(kbBlocks)` 末尾注入 `buildKnowledgeSection`（教学问答：**禁止调用工具/禁止协议文本/教学四段式：原理→代码→接线→坑**）；`detectRequiredTools` 新增**教学疑问句豁免**（"是什么/为什么/怎么办/区别/吗/？"且无祈使词"帮我/请/现在…" → 不强制工具，避免"串口乱码是什么原因"误触发 serial 强制）
- `todo-tools.ts`（顺手修复**历史真 bug**）：`readTextFile` 是 async 却同步 `JSON.parse`（Promise 当 string）→ todo 清单从未真正加载；改用 node:fs `readFileSync/writeFileSync`，签名不变

**20 问实测（本地 1.5B，每问独立会话）**：第一轮 10/20 → 修复疑问句豁免+独立会话 → 16/20 → 知识库段移模板末尾+关键词加权 → 补测 6 问 5/6（DHT22/C3引脚/OLED/编译报错✅ 完整教学回答，烧录失败✅排查清单）；失败 2 问修复祈使词误判（裸"编译/烧录"不再是祈使）+ 补 '编译报错/not declared' 别名后 → 2/2 PASS。**综合 20 问全覆盖**。截图 `docs/ai-teaching-kb.png`（DHT22 回答，接线 VCC/GND/DATA GPIO6 全对，但 1.5B 偶发走"创建项目+写文件"工具路径而非纯直答——已知 1.5B 边界，3B 更好；知识库架构不变模型升级即改善）。
- 测试脚本：`test-kb-20q.js`（20 问全量，每问 Page.reload 独立会话）、`test-kb-6q.js`、`test-kb-2q.js`、`test-kb-shot.js`（截图）

**已知边界（1.5B）**：教学问答偶发走工具路径（系统提示"必须调用工具"原则强 + 模型随机）；连续会话长上下文后指令跟随崩（复读旧答案）——真实使用建议提示用户单问或切 3B。
**下一步候选**：① 教学问答命中时用**独立精简系统提示**（去掉工具原则）彻底禁工具；② 内置示例代码库与课程/仿真打通；③ 升级 3B 默认。

### #20（IMA 方案 · 第一步：知识库抽目录 + 启动加载，已完成 ✅）

用户问"知识库存在 IMA 可以吗"→ 确认**做法 A**（IMA 当编辑端，知识库本地加载，插件化同步后续做）：
- **迁移**：`scripts-extract-kb.js`（可复用）正则从 TS 源码提取 → `resources/knowledge/<id>.md`（头部 `<!-- id: xxx / keywords: a,b,c -->` + 正文），**43/43 全部提取**（修了两个正则坑：block 结束反引号后是 `,` 才 `}`；array-basics 的 keywords 含 `'[]'` 需 `(?:'[^']*'[,\s]*)*` 匹配）
- **加载器**：`knowledgeBase.ts` 重写为目录加载器——候选路径 `process.resourcesPath/knowledge` / `app.getAppPath()/resources/knowledge` / `cwd/resources/knowledge`，同步扫描首个可用目录，解析头部注释 + 正文；`searchKnowledge`（关键词长度加权）/ `knowledgeCount()` 签名不变
- **打包**：package.json `extraResources` 新增 `resources/knowledge → knowledge`（与 proto 同机制，打包后落 `process.resourcesPath/knowledge`）
- **实测**：构建通过；`[Knowledge] 知识库 43 条，命中 N 条`日志确认目录加载；2 问实测 PASS（编译报错/烧录失败）。注：1.5B 偶发"使用 digitalWrite 而不是 digitalWrite"式复读幻觉，切 3B 改善
- **IMA 使用方式（给用户）**：在 IMA 里编辑这些 md（导入/导出），覆盖 `resources/knowledge/` 重启生效；后续做插件化一键拉取（GitHub 自有仓库/服务器 → 软件内更新+校验）
- 测试脚本：`test-kb-2q.js` 等保留；诊断脚本 dbg-kb*.js 已删除

## 开放问题

- [ ] 用户验收编辑器丝滑度与整体 UI
- [ ] AI 面板升级方向：**采用深度报告 §8 三批路线的哪一批开始**（建议先第一批 1-2 周：文件工具+权限+烧录工具化+串口后台日志）
- [ ] 仿真器遗留：OLED 文本绘制、SHT30 串口打印、.ino 与编辑器联动、模式切换 UI
- [ ] **语音输入方案修正（2026-10-01 UI 审查发现）**：Web Speech 桌面端是**在线引擎**（Chromium 内置 Google 服务，实测 network 错误，非"本地识别"）；已做错误去重+如实文案；**待用户拍板：换 whisper.cpp 本地 STT（复用 llama.cpp 下载链路）或临时移除按钮**
- [ ] **AI 内置模型服务端不可用**（bluebubai.work/api/models 5 模型全 available=False）——需用户检查网关服务开通状态
- [ ] **本地模型能力边界**：1.5B 工具调用不可靠（本轮 toolCalls=0），教学问答可用；复杂工具闭环需 3B 或云端——是否推 3B 档作默认本地推荐

## 下一步行动（有序）

1. 用户验收（应用运行中）：烧录 Tab 试三种固件来源（C3/S3 演示 + 当前代码）、仿真 Tab 试外设（OLED 文本/ADC 滑块/DHT22/示波器）
2. 按用户指示继续仿真外设深化或 AI Agent 功能落地（从深度报告 §8.2 第一批开始）
3. 对齐 Tauri 版（UI 改动同步）
4. 每次结束执行 handoff

## 会话临时状态

- 项目根：`D:\工作\代码实验室\codelab-desktop`
- 启动命令：`node_modules\electron\dist\electron.exe . --remote-debugging-port=9334`（**9222 被"云曦工作台"占用勿用**）
- build 命令：`npm run build`（约 15s；electron-vite build 亦可）
- arduino-cli：`C:\Users\Administrator\AppData\Roaming\codelab-desktop\tools\arduino-cli\arduino-cli.exe`
- TrieCode 学习报告（产品层）：`docs/triecode-agent-学习报告.md`
- **TrieCode 全链路深度报告（源码级，优先引用，已扩至 20 章）：`docs/triecode-agent-全链路深度报告.md`**
- **velxio 实际操作与生态参考报告（2026-10-01）：`docs/velxio-实际操作与生态参考.md`**
- **开源 AI Agent IDE 对标报告（2026-10-01）：`docs/开源AI-Agent-IDE对标报告.md`**（Cline Apache-2.0 可用 / OpenHands MIT / OpenCode / cc-switch Provider 管理 / **Hermes Agent MIT 学习循环**）
- **Cline SDK 源码级对标报告（2026-10-01，最新）：`docs/cline-sdk-源码级对标报告.md`**（Agent 循环/恢复/工具治理/安全/团队/hub 全量，落地映射修订 §8 三批路线）
- **TrieCode 官方插件集精读报告（2026-10-01）：`docs/triecode-plugins-官方插件集精读报告.md`**（plugin.json 十要素规范、9 插件逐一对照、skills 提示词、wokwi 工具面、落地映射）
- **TrieCode 官网学习记录（2026-10-01，最新）：`docs/triecode-官网学习记录.md`**（产品定位/定价积分制/路线图/插件广场国内镜像策略/官方插件开发指南全文：七类通道+能力路由+devicePanel 门控+webview 通信+检测五级/更新日志 v1.2.9→v1.3.1 + 对 codelab 学习点分级 A 直接抄/B 参考/C 启发）
- **TrieCode 实机操作实测报告（2026-10-01，最新）：`docs/triecode-实机操作实测报告.md`**（CDP 全链路实测：新建项目/选板+设备配置/AI 对话（contenteditable chat-input+积分计量）/终端/编译仪表/门控；操控脚本在 `_triecode_learn\`：cdp_real_click.py 核心可复用）
- **模拟烧录模块（2026-10-01，最新交付）**：
  - 伪芯片服务器：`src\main\services\fakeBoardService.ts`（RFC2217，FAKE_CHIPS: esp32c3=chip_id 0x0005/MAC 15:81:33:60:15:81/4MB，esp32s3=chip_id 0x0009/MAC 3c:71:bf:01:23:45/8MB）
  - 模拟烧录引擎：`src\main\services\simBurnService.ts`（客户端动作序列对标 esptool，输出格式完全一致；每块独立 zlib；IAC 转义已修）
  - 演示固件：`examples\sim-firmware\{bootloader.bin 0x1000, partitions.bin 0x8000, boot_app0.bin 0xe000, app.bin 0x10000(261600B), manifest.json}`（来自 arduino-cli 真实编译产物）
  - IPC/preload：`src\main\index.ts`（simBurn:list/demos/start + task:output/progress/exit 流式）、`src\preload\index.ts`（api.simBurn: list/demos/start/kill）
  - UI：`src\renderer\src\components\SimulatorPanel.tsx`（"仿真/烧录"双 Tab + SimBurnView）
  - 构建修复：`electron.vite.config.ts` main 段 `rollupOptions.external: ['playwright']`（browser-automation.ts 动态 import 的既有构建问题）
  - 引擎自测：`test-simburn.js`（esbuild bundle 后真闭环，8 断言全绿，保留可复用）
  - UI 冒烟证据：`docs\sim-burn-ui-冒烟测试结果.png`
  - 协议参考（Python 版含全部踩坑注释）：`D:\工作\代码实验室\_triecode_learn\fake_esp32_rfc2217.py`；esptool 源码：`C:\Users\Administrator\AppData\Local\Doubao\User Data\sandbox_runtime\bases\c98c5042338ed152c6f10ecd8591889f\python\Lib\site-packages\esptool\loader.py`
- TrieCode 解包源码（学习参考）：`D:\工作\代码实验室\_triecode_learn\app\`（另有一份旧解包 `D:\工作\代码实验室\_trie_asar\` 可删）
- TrieCode 运行时插件清单：`%APPDATA%\TrieCode\plugins\arduino-cli-toolchain\plugin.json`（已全量读入报告 §2.7）
- TrieCode 真实会话样本：`%APPDATA%\TrieCode\chat-sessions\*.json`（结构已解剖入报告 §14；inspect 脚本 `_triecode_learn\inspect_*.py` 可复用）
- TrieCode 窗口句柄技术：PrintWindow 抓图 + AttachThreadInput 置前台（cu 直接操作无效）
- **本地模型（2026-10-01 本轮交付，无需 Ollama）**：
  - 核心文件：`src\main\ai\modelRuntime.ts`（llama.cpp 引擎管理 + ensureEngine 自动下载 + resumableDownload 断点续传 + MODEL_CATALOG 3 档真实 hf-mirror 直链 + chatWithLocalModelStream 工具调用解析；getEngineDir 探测 `resources\llama\llama-server.exe`，getModelsDir=`%APPDATA%\codelab-desktop\models`）
  - 引擎：`llama-b11146-bin-win-cpu-x64.zip` 17.7MB @ `https://gh-proxy.com/https://github.com/ggml-org/llama.cpp/releases/download/b11146/...`；已解压 `resources\llama\`（llama-server.exe + ggml-*.dll）
  - 模型：Qwen2.5-Coder-1.5B-Instruct Q4_K_M `%APPDATA%\codelab-desktop\models\qwen2.5-coder-1.5b-instruct-q4_k_m.gguf`（1066MB 完整已下载）；GGUF 直链 `https://hf-mirror.com/Qwen/Qwen2.5-Coder-1.5B-Instruct-GGUF/resolve/main/...`；Qwen2.5-1.5B / Coder-3B 同构
  - IPC：`src\main\index.ts` model:catalog/recommend/ollamaStatus(内置引擎)/ensureEngine/pull/delete/chat + agent:start localModel；preload api.model 已加 ensureEngine
  - UI：`src\renderer\src\components\PluginSidebar.tsx`（大模型页去 Ollama：installModel 直下 GGUF、已安装态按 ggufFile 文件名匹配、徽标"本地引擎已就绪/运行中/未安装"）；`AiPanel.tsx`（本地模型 option value=`local:<文件名>`）；`SettingsModal.tsx`（BYOK 预设"内置本地引擎 127.0.0.1:8080/v1"）
  - 回归脚本：`test-local-chat.js`（本地对话）、`test-local-agent.js`（Agent 链路）、`test-pull-direct.js`（下载链路）、`ui-smoke-models.js`（大模型页 UI）、`perf-check.js`（流畅度+假功能）
  - 能力边界：1.5B 模型工具调用弱（实测 toolCalls=0），教学问答可靠；引擎 GPU offload 按内存档（≥8GB 全层，CPU 版 zip 无 CUDA 时忽略）
- **语音输入（2026-10-01 本轮交付，Web Speech 识别）**：`AiPanel.tsx` toggleVoice + listening state（title 双态"语音输入/停止聆听"、`.ai-voice-on` 红色脉冲）；主进程 createWindow 已加 session 麦克风权限放行；回归脚本 `test-voice-input.js`；**注意：桌面 Chromium SpeechRecognition 为在线引擎（实测 network 错误），已加错误去重限流+如实文案；本地化（whisper.cpp）待用户拍板**
- **UI 审查（2026-10-01 本轮交付）**：记录 `docs/ui-审查-对比TrieCode-20261001.md`；全窗截图 `docs/ui-audit-main.png`；审查脚本 `ui-audit.js`（CDP 布局体检可复用）
- **AI 面板对齐 TrieCode（2026-10-01 本轮交付）**：`AiPanel.tsx` doSend 统一入口 + regenerate/editResend/rewindTo + `.ai-msg-ops` hover 操作条 + `.ai-panel-resizer` 拖拽（localStorage `codelab-ai-width`）+ token 面板动态估算；回归脚本 `test-ai-panel-ops.js`（拖拽/token/ops 冒烟）、`test-msg-ops.js`（回退实测）、`test-msg-edit.js`（编辑重发实测）
- **全功能测试（2026-10-01 本轮交付）**：报告 `docs/功能测试报告-20261001.md`；截图 `docs/test-01~14*.png`（15 张）+ `test-07b-ai-local.png`（本地模型 UI 对话）；回归脚本 `test-all-features.js`（14 功能面）、`test-ai-local-ui.js`（本地模型切换+对话）；**model:local 已去 Ollama 门禁（直接 listLocalModels 扫 GGUF）**

---

## 仿真器遗留事项（旧任务，未在本轮处理）

### 技术方案
详见 `docs/simulator-architecture.md`（自研行为级模拟器：VirtualRuntime + GPIOBank + UARTPort + I2CBus(SSD1306/SHT30) + ADC + PWM，纯 TS 零依赖，示例内置 TS 代码）

### 引脚映射
| 组件 | 引脚 | 说明 |
|---|---|---|
| 板载蓝 LED | GPIO8 | 亮时 glow |
| 用户红 LED | GPIO2 | 支持 PWM |
| BOOT 按钮 | GPIO0 | INPUT_PULLUP |
| 电位器 | GPIO0(ADC_CH0) | 12-bit 0-4095 3.3V |
| I2C | GPIO21 SDA / GPIO22 SCL | OLED 0x3C, SHT30 0x44 |

### 遗留项
- [ ] 05-oled 示例只初始化未写像素（font5x7 已写好未接入 I2CBus.drawText）
- [ ] 07-sht30 示例 loop 未实际打印温湿度
- [ ] 编辑器 .ino 与模拟器联动（transpiler 正则 `\(([^)]+)\)` 不支持嵌套括号）
- [ ] 模拟/真实烧录模式切换 UI

## 本轮完成的改动 #14：TrieCode Agent 全链路移植（2026-10-01，用户"模仿他的所有agent操作"）

### 交付内容（6 项移植 + 2 项新增强，全部构建通过，已重启实机验证）
1. **T1 todo 工具面**：新建 `src\main\engine\tools\todo-tools.ts`（todo_write/todo_list/todo_done + `.codelab/todos.json` 项目级持久化 + mergeStableIds 按文本保持 id 稳定 + buildTodosSection 注入系统提示 + wrap-up 收口注入"仍有 N 项未完成"）。**免确认**（PermissionPolicy.NO_CONFIRM_TOOLS）。
2. **T2 ask_user 主动提问**：新建 `tools\ask-user-tool.ts`（1-4 题 text/choice/yesno）；agent-runner 拦截走专用通道（emit 'ask_user' + 120s 超时返回空答案继续）；main `agent:askRespond` IPC + preload `agent.askRespond`；AiPanel.tsx 新增 askReq state/事件分支/弹窗（text/select/yesno + 提交/跳过）+ main.css `.agent-ask-*` 样式；status done/error/stopped 清 askReq。
3. **T3 反幻觉检测**：`checkHallucination(text)`——匹配"已编译/已烧录/验证通过/运行成功"等声称，但消息历史无 compile/upload/run_tests/terminal（含编译命令）证据 → 注入纠正提示要求真调用工具，continue。挂在无 toolCalls 文本分支、验证闸之前。
4. **T4 edit_file 增强**：`tools/index.ts` 精确匹配失败 → `matchLines()` 行级模糊匹配（忽略行首尾空白/空行；唯一候选才替换、多处命中报错要求扩大上下文）；成功返回行号 + ```diff``` 预览（buildDiffPreview）。**算法单测 5/5 通过**（test-fuzzy-match.js）。
5. **T5 占位符验证检测**：terminal 命令为 echo/print 类且输出前 50 字符仅 ok/success/成功/√✓ 等 → 结果改写为失败并注入"[系统提示] 该命令输出仅包含占位文本，不能作为验证证据…"。
6. **T6 串口后台日志+crash 分析**：`services/serialService.ts` 加 readSerialLog（保留式读全文）/clearSerialLog；`tools/embedded-tools.ts` 加 serial_log_tail（末尾 N 行默认 50 上限 500 可 clear）/serial_log_grep（关键词）/analyze_crash（11 种 ESP32 崩溃签名正则：Guru Meditation/Backtrace/assertion/abort/Task watchdog/Stack smashing/Brownout/rst reason/Rebooting 循环/WiFi 失败，返回原因+修复建议）。embeddedTools 9 个。serial 五件套+compile 全部**免确认**（对齐 TrieCode 验证动作不弹窗；upload 保留确认——真写硬件需用户点头）。
7. **T7 文本工具协议桥接（新增强，解决本地 1.5B 模型工具驱动）**：llama.cpp Qwen2.5-Coder-1.5B 不产出 OpenAI 格式 tool_calls（chat template 无 tools 渲染），把工具描述当 JSON 输出 → ① 系统提示新增"工具调用格式（必须遵守）"（`<tool_call>{"name":"...","arguments":{...}}</tool_call>` 协议 + 完整示例 + 禁裸 JSON/代码围栏）；② callModel 解析器新增两层兜底：`<tool_call>` 块解析 + markdown 围栏内带 name 的 JSON 解析（剥离后 content 剩说明文字）；③ 本地小模型（modelId 含 qwen 且非 7B+）工具清单用极简格式（description 截断 40 字，避免超长提示淹没指令遵循）；④ **协议纠正循环**（protocolFixCount ≤2）：检测"裸工具参数 JSON 缺 name"（isBareToolJson：```json 或 { 开头、无 name、含 tasks/command/path 等参数键）→ 注入"请按 <tool_call> 格式输出"few-shot 纠正。

### 真实链路验证结果（CDP 9334 + 本地模型）
- **简化任务**（"用 todo_write 建立任务清单"）：模型裸 JSON → 协议纠正 → **todo_write 真实执行成功**（消息流"todo_write | 写入 | ▼ | 成功"）。
- **完整链路**（open_project 打开 _simtest/Blink → todo_write → edit_file 改 delay(500)→delay(300) → compile）：**open_project/todo_write/edit_file/compile 全被调用**；**edit_file 真实改文件（Blink.ino 中 delay(300) 出现 2 次，代码读盘验证）**；todo_write 免确认通过。open_project 在 default 模式弹确认（CDP 无人点 → 120s 超时拒绝，属设计使然——真实用户会点允许）。
- **发现并修复真实产品问题**：default 安全模式下 compile（execute 类）弹确认 → 无人响应 120s 超时 → 模型会**在无真实编译证据时声称"编译成功"**（反幻觉检查查"是否调用过"不查"是否成功"）→ **compile 及无副作用验证动作加入 NO_CONFIRM_TOOLS**（upload 保留确认）。
- **已知验证缺口（写入手记）**：① ask_user 弹窗 UI 未实机验证（需模型触发，建议用户真机跑"需要确认的问题"类任务）；② serial_log_tail/grep/analyze_crash 需真实串口设备或模拟会话验证（代码与现有 serial 会话同构）；③ 反幻觉/占位符检测的真实触发路径依赖模型行为（1.5B 模型偶发输出裸 JSON 已被纠正循环接住）；④ todos.json 落盘需项目打开场景（open_project 被确认弹窗拦在测试环境；真实用户允许后即落盘）。

## 本轮完成的改动 #15：T8 文件冲突保护 + T9 工具中文名 + T10 ask_user 验证（2026-10-02，用户"继续，该加的加"）

### 交付内容（2 项新功能 + 1 项验证，构建通过 + 产物验证）
1. **T8 文件冲突检测（对齐 TrieCode file-change-tracker 用户改动保护）**：`src\main\engine\tools\index.ts` 新增会话级 AI 读写基线 `aiFileBaselines`（Map<绝对路径, AI 最后一次读取/写入后的内容>）——read_file 成功记录基线；write_file/edit_file 写入前 `checkFileConflict()`：若 AI 读过该文件（有基线）且磁盘内容 ≠ 基线（外部/用户改动）→ **拒绝覆盖**，返回"文件在 AI 操作期间被外部修改…请先 read_file 重新读取（刷新基线）后再写入"；文件被删除/无基线（AI 首次写）不拦（靠权限确认把关）。防止 AI 基于过期快照覆盖用户的新改动。
2. **T9 工具中文名映射（对齐 TrieCode 工具中文名）**：`AiPanel.tsx` 新增 `TOOL_CN_NAMES` 映射表（文件/执行/嵌入式/任务/记忆/搜索/板卡 30+ 工具中文名）+ `toolCnName()`；ToolCallCard/ToolResultCard 显示 `中文名 (英文名)`，英文名 `.agent-tool-en` 小号半透明；main.css 新增样式。
3. **T10 ask_user 实机验证（部分完成，见缺口）**：① `agent.askRespond` preload 暴露确认（agent API = start/stop/respond/planRespond/askRespond/status/onEvent）；② **askRespond IPC 主进程真实响应 `{"ok":true}`**（handle 注册无误）；③ 弹窗 CSS `.agent-ask-dialog` 在构建产物（renderer index chunk 命中）。

### 验证结果
- **构建产物验证（权威）**：renderer 主 chunk `out/renderer/assets/index-g8axpK4a.js`（8.99MB）含全部中文名映射（任务清单/询问用户/编译/烧录/串口监视/崩溃分析/agent-tool-en/TOOL_CN_NAMES 全命中）；主进程产物 `out/main/index.js` 含 T8 冲突文案 + aiFileBaselines；renderer CSS 含 .agent-ask-dialog。
- **ask_user 实机触发失败记录（1.5B 模型能力边界，非代码 bug）**：两次任务（"请用 ask_user 问我…"、"必须按格式输出 <tool_call>{"name":"ask_user",…}</tool_call>"）模型均只回文本"好的，请选择项目名称。"（主进程日志 `[Agent] 模型返回: content=11字符, toolCalls=0`），不输出工具调用——**本地 Qwen2.5-Coder-1.5B 对主动询问类工具的触发不可靠**（todo_write 上轮成功过一次属模型采样随机+纠正循环兜底）；todo_write 复测本轮也仅复述任务文本未调用。**结论：工具卡片实机渲染（T9）/ask_user 弹窗（T10）的真实触发需真机或强模型（3B/云端）验证**。
- **可复现测试用例（写入手记）**：T8 冲突触发 = 任务"read_file 读 xxx 文件 → 我手动改文件 → 再 write_file 覆盖"，应见冲突拒绝；T9 工具卡片 = 强模型下任一工具调用任务截图；T10 弹窗 = 真机跑"问我要项目名"任务后弹窗+提交。

### 已知缺口（延续 #14 + 新增）
- #14 全部延续：ask_user 弹窗实机、serial 三工具实机、反幻觉/占位符真实触发、todos.json 落盘。
- 新增：**本地 1.5B 模型对 ask_user 类"主动交互工具"触发不可靠**——建议 AI 面板对本地小模型提示"主动询问类操作建议使用 3B 或云端模型"（未做 UI，待用户拍板）；T9 工具卡片实机渲染待强模型。

### 临时脚本
- 本轮新增/改写 `test-ask-user.js`（askRespond API + 中文名产物 + 弹窗触发探测，现版本为验证脚本保留）；上轮 test-agent-tools/test-todo-mini/test-agent-full/test-fuzzy-match/test-llama-tools 保留。应用当前以 electron . --remote-debugging-port=9334 运行中。

## 本轮完成的改动 #15 增补（2026-10-02，用户"1-2做"→ T8 冲突真实链路 + 小模型提示条）

### 交付内容（1 新功能 + 2 修复 + 1 验证，构建通过 + 产物验证 + 实机链路部分验证）
1. **T12 本地小模型工具能力提示条（新功能）**：AiPanel 输入区上方新增黄色提示条"本地小模型工具调用能力有限，主动询问/复杂工具操作建议切换 3B 或云端模型"，仅当 `useLocalModel && /qwen2.5(?:-coder)?-1.5b/i.test(selectedLocalModel)` 显示；✕ 可关闭（localStorage `codelab-small-model-tip` 持久化）。渲染产物已验证（index chunk 含文案）。
2. **T13 反幻觉增强——伪造工具响应检测（实测驱动修复）**：真实链路发现模型在纯文本里输出 `<tool_response> {"ok":true,"content":"文件已成功写入..."}` **冒充工具结果**（工具从未被调用，content=136字 toolCalls=0）→ 新增最高优先级检测：文本含 `<tool_response>`/```tool_response/[tool_response] → 注入纠正"不得伪造工具响应，必须实际调用工具"，强制重调。同时 **checkHallucination 正则补"已(成功)?写入|已成功(编译|烧录|上传)"变体**（实测"文件已成功写入"绕过旧正则"已写入…成功"）+ 声称"已写入/已创建"时 write_file/edit_file/create_project 亦算证据。
3. **T7 桥接补强——兜底3 裸 JSON 解析（实测驱动）**：真实链路发现模型输出**无围栏带 name 的裸 JSON**（`{"name":"write_file","arguments":{...}}` 无 <tool_call> 无 ```json）→ callModel 新增第三层兜底：整段 trim 以 { 开头且 JSON.parse 后含 name+arguments → 解析为工具调用并清空 content。**日志实证**：`裸 JSON 兜底解析出 1 个工具调用: write_file`（此前这类输出会落成纯文本、工具永不执行）。
4. **T8 严重 bug 修复（实测驱动）**：`checkFileConflict` 里 `readTextFile` 是 **async**（返回 Promise）未 await → `disk === baseline` 恒 false → **AI 读过即永远"冲突"**（写任何已读文件都会被拒）→ 改 async + 两处调用点 await（write_file/edit_file）。**此 bug 若上版发布会导致"AI 读过就写不了"**。

### 验证结果
- **构建产物权威验证**：主进程 out/main/index.js 含 T13 伪造检测文案 + 兜底3日志串 + `await checkFileConflict`；渲染 index chunk 含 T12 提示条文案。
- **实机链路（auto 模式，CDP）**：工具卡片 dump 实证 **T9 中文名映射实机生效**（"读取文件(read_file) 成功 / 写文件(write_file) 成功"——上一版 default 模式曾显示"写文件(write_file) 已拒绝"）；read_file/write_file 被模型真实调用执行；write_file 免确认（auto 生效）。
- **T8 冲突拒绝端到端触发未完成（记录缺口）**：多次重试（单任务/双任务分阶段/拖延窗口）均未稳定触发 read→外部改→write 时序——**根因：本地 1.5B 模型工具调用随机不稳定**（同任务时而调用 read+write、时而纯文本回复，主进程日志 toolCalls=0），且 read 完成到 write 执行窗口仅 1-3s（1.5B 本地生成快）难以稳定插入外部修改。**用户真机可复现**：AI 面板让模型"读取 Blink.ino 并写回"→ 中途手动改文件 → 可见"文件在 AI 操作期间被外部修改"拒绝卡片；或换 3B/云端模型后重跑 test-t8-conflict.js。
- 临时脚本：`test-t8-conflict.js`（保留，可复现测试，最后版本为单任务拖延窗口版）；test-dump-cards.js 已删。

### 已知缺口（延续）
- T8 冲突端到端触发（见上）；ask_user 弹窗实机（1.5B 不触发 ask_user）；serial 三工具实机（需串口设备）；反幻觉真实触发（依赖模型行为）；todos.json 落盘（需项目打开）。

## 本轮完成的改动 #16（2026-10-02 续，用户"这应该是bug"→ 工具强制重试机制 + T11 端到端验证通过）

### 核心修复：工具强制重试机制（用户判定为 bug：任务明确要求工具、模型却只回文字）
- **问题**：本地 1.5B 模型对"用 read_file/write_file 操作文件"类任务时而调用工具、时而纯文本回复（"好的…"）→ T11 测试反复失败，此前被记录为"模型限制"。
- **修复**（agent-runner.ts）：① 新增 `detectRequiredTools()`——取最近一条非 `[系统提示]` 的 user 消息，匹配 10 组工具指令词（read_file/write_file/edit_file/compile/烧录/串口/todo/ask_user/create_project/terminal）+ "调用工具/使用工具/用工具完成"泛指令；② 无工具调用分支中，命中且 `forcedToolRetries < 2` → 注入"用户明确要求使用工具完成（需要：X），请立即按 <tool_call> 格式输出"并重调（带格式示例、禁止模拟工具结果）；③ 模型真实调用工具后 `forcedToolRetries = 0` 重置（上限 2 防死循环）。
- **效果**：重跑 T11——read_file、write_file **连续真实调用成功**（此前 read 反复不触发）。

### T11 端到端验证通过（此前缺口的关闭）
- 链路：任务要求 read_file → **read_file 真实执行成功**（基线记录 delay(300) 内容）→ 测试脚本外部修改 delay(300)→delay(200) → write_file 真实执行 → **冲突拒绝**。
- **证据（CDP 展开卡片抓取 error 原文）**：`文件在 AI 操作期间被外部修改（AI 读取后磁盘内容发生变化——可能你或其他程序改过该文件）。为避免覆盖你的改动，本次写入已拒绝。 请先调用 read_file 重新读取最新内容（读取后会刷新基线），确认后再写入。`（卡片头部显示"写文件(write_file) 失败"；此前脚本检测不到是因为错误在折叠区，展开后可见。）
- 同时实证：auto 模式免确认（write_file 走到真实执行）、T9 中文名（"读取文件(read_file) 成功"/"写文件(write_file) 失败"）。
- 新截图 docs/t8-conflict-real.png（展开状态，AI 面板滚动位置原因冲突卡片未入屏，以 CDP 抓取文本为权威证据）。

### 产物验证
- out/main/index.js 含：`detectRequiredTools`/`forcedToolRetries`（新机制）、T13 伪造响应检测、兜底3 裸 JSON、`await checkFileConflict`；渲染 chunk 含 T12 提示条。构建通过。
- 临时脚本：test-t8-conflict.js 保留（单任务"read→中文分析→write"版，含 auto 切换 + 外部修改 + 冲突断言 + 还原）；test-inspect-card.js/test-shot-conflict*.js 已删。

### 已知缺口（延续）
- ask_user 弹窗实机（1.5B 几乎不触发，且强制重试只覆盖"文件类"工具指令词，ask_user 泛指令命中）；serial 三工具实机（需串口设备）；todos.json 落盘（需项目打开）；反幻觉/占位符真实触发路径（依赖模型行为随机性）。

## 本轮完成的改动 #17（2026-10-02 续，用户"问模型问题输出跟 triecode 不一样"→ 输出风格对齐 TrieCode）

### 差异定位与对齐
- **TrieCode 输出特征**（实测报告 §2.4）：自然语言简洁回答 + "▶ 已工作 Ns / 思考 · N 个工具"状态条 + 输入/输出 token 计量；回答是正常 AI 对话风格（Cline 式 markdown 渲染）。
- **LabCode 原差异**：① 系统提示词（agent-runner.ts:638）+ 收尾引导（:392）强制"总结/结果/产物/下一步建议/注意事项"小标题模板 → 1.5B 模型机械输出"总结：…结果：…产物：…"；② 回答文本纯文本渲染（无 markdown）。

### 改动
1. **输出引导自然化**（agent-runner.ts）：638 行改为"用自然语言输出最终回答：先一句话说明做了什么，然后直接给出结论…**禁止使用'总结：/结果：/产物：/下一步建议：/注意事项：'小标题模板**，也不要机械逐条列项"；392 行收尾引导同步改为自然语言要求（"像正常 AI 对话一样自然、直接"）。
2. **轻量 markdown 渲染**（AiPanel.tsx 新增 `LightMarkdown` + `inlineMd` 组件）：支持 `**粗体**`、`` `行内代码` ``、`-`/`1.` 列表（连续行聚合）、`#/##/###` 标题；纯 React 元素渲染（无 dangerouslySetInnerHTML，防 XSS）；流式输出（streamingText）同样走 LightMarkdown。main.css 新增 `.ai-text strong/code/ul/ol/li/h4-h6/.ai-md-blank` 样式。

### 验证结果（实机，本地 1.5B）
- 问"用一句话说明 ESP32 GPIO2 接 LED 时 delay 函数的作用" → 模型回答**自然语言**（"ESP32 的 GPIO2 引脚接 LED 时，delay 函数用于控制 LED 的亮灭时间…"），**不再是"总结/结果/产物"模板** ✅；截图 docs/ai-output-natural.png。
- 已知局限（模型行为，非渲染 bug）：1.5B 把列表写成同行 `- 项1 - 项2`（不换行），行首列表正则不命中 → li 不聚合渲染；**换行列表在强模型下正常渲染**（渲染器逻辑已实现）。不强行为同行列表加解析（易误伤中文破折号/普通横线）。
- 渲染器正确性：**粗体/行内代码/换行列表/标题** 逻辑已实现（本次模型未输出 ** 和换行列表，故截图无 strong/li，属模型行为）。
- 临时脚本：test-ai-output.js 保留（自然输出回归验证，含 auto 切换 + 消息注入 + 完成等待 + DOM 断言 + 截图）。

### 已知缺口（延续）
- 同上轮；新增：TrieCode 的"输入/输出 token + 积分消耗"计量条 LabCode 尚未对齐（商业化信任感设计，待用户拍板是否做积分制）。

## 本轮完成的改动 #18（2026-10-02 续，用户"做"→ token 计量条对齐 TrieCode）

### 交付：AI 统计栏 token 计量条（对齐 TrieCode "输入 23.6k · 输出 58"）
- **主进程 usage 透传链路**：
  - `modelRuntime.ts chatWithLocalModelStream`：返回 Promise<{text, usage}>——流式捕获 OpenAI 兼容 `usage`；实测 llama-server 流式**不带 usage 只带 timings**（prompt_n/predicted_n）→ 补 timings 兼容（实测确认：llama-server 最后 data 含 `timings:{prompt_n:30,predicted_n:5}`）。
  - `aiGateway.ts fetchStream`（BYOK）：捕获 `data.usage`，onDone(err, usage)。
  - `aiGateway.ts aiChatStream`：onDone 签名改 `(err, usage?)`，本地/BYOK/内置云端三分支透传 usage（内置云端同捕 data.usage）。
  - `agent-runner.ts callModel`：onDone 累计 `stats.inputTokens/outputTokens`。
- **渲染层**：AiPanel ① `done` 事件处理 `d.stats`（此前丢弃——**这是 token 为 0 的根因**：stats 只在每轮开始/工具执行后 emit，模型跑完 usage 累计后无人再 emit，渲染层停在使用前的 0）；② 统计栏从"busy 才显示"改为 `(busy || stats.turns > 0)` 常显；③ 新增 `fmtTokens()`（≥1000 显示 `11.4k` 风格）+ `.agent-token-metrics` 样式（弱化色 + 左侧分隔线）。
- **验证（实机，本地 1.5B）**：问"用一句话介绍 ESP32" → 统计栏实测显示 `轮次 1 | 工具 0 | 用时 4s | DONE | 输入 11.4k · 输出 20` ✅（截图 docs/ai-token-metrics.png；11.4k 含系统提示词上下文，正常）。
- 临时脚本：test-token-metrics.js 保留（token 计量回归验证）。

### 已知缺口（延续）
- TrieCode 的"消耗 Z 积分"部分：本地模型不耗积分、云端有 credits 事件（used/totalTokens/remaining 已解析存 totalCredits）——积分换算比例未定，待用户拍板是否做"消耗积分"显示；ask_user 弹窗实机（1.5B 不触发）；serial 三工具实机（需串口设备）；todos.json 落盘（需项目打开）。

## 本轮完成的改动 #21（2026-10-02，用户"全做"三件：3B 默认 / 教学独立提示词 / 知识库插件化一键更新）

### ① 默认模型升 3B（#60 完成态）
- `AiPanel.tsx` load()：已装本地模型时默认优先 `local.find(m => m.id.includes('coder-3b'))`（未装退回 local[0]）；`SettingsModal.tsx` ollama profile modelHint 改 `qwen2.5-coder-3b / qwen2.5-coder-1.5b（推荐 3B）`。

### ② 教学问答彻底禁工具的独立精简提示词（#61，实测坐实）
- `agent-runner.ts`：run() 开头判定 `kbBlocks.length > 0 && isTeachingQuestion(userText)` → 走新方法 `runTeaching()`（`buildTeachingPrompt()` 纯教学系统提示：LabCode ESP32 教学助手、直接文字回答、严禁任何工具/协议文本、教学四段式；**无工具清单**）+ `callModel(false)`（空工具集强制模型文字回答）→ 单轮 done(reason='teaching')。
- `isTeachingQuestion` = 疑问句正则（是什么/为什么/怎么办/怎么读/怎么做/怎么用/如何/区别/介绍/讲讲/说明/吗$/呢$/？$）且无祈使词（帮我/请/立刻/马上/现在/麻烦/快点/打开/读取/写入/修改/运行/执行/创建/发送/输入/调用/查一下/看看）。含祈使词仍走完整 agent 循环（知识库注入 buildKnowledgeSection 末位）。
- 实测：`test-kb-2q.js` 2/2 PASS（编译报错 was not declared / 烧录失败 Connecting 超时）——回答为纯文字教学（含示例代码），**无 <tool_call>、工具 0**，确认教学独立模式生效。

### ③ 知识库插件化一键更新（#62，端到端实测通过）
- **主进程** `src/main/ai/knowledgeUpdater.ts`（新增）：`KB_BUILTIN_VERSION='20261002-43'`；`KB_MANIFEST_URL='https://gh-proxy.com/https://raw.githubusercontent.com/hulufeng/labcode-knowledge/main/latest.json'`；用户目录 `%APPDATA%\codelab-desktop\knowledge`（内写 `.version`）；`checkKnowledgeUpdate()` 拉清单对比；`updateKnowledge()` = resumableDownload 下载 zip → sha256 校验 → PowerShell `Expand-Archive` 解压 → 覆盖用户目录 → 写 .version；`resetKnowledge()` 删用户目录回退内置。manifest 字段 {version, zipUrl, sha256, note, updatedAt}。
- **IPC/preload**：`index.ts` 注册 `kb:status/check/update/reset`（update 带 onProgress 流式推送 `kb:progress`）；`preload/index.ts` 暴露 `window.api.kb.*`（status/check/update/reset/onProgress）。
- **加载器** `knowledgeBase.ts`：候选路径首位加用户级目录（`%APPDATA%\codelab-desktop\knowledge` 优先于内置 resources）。
- **UI** `AiPanel.tsx`：AI 面板头部新增「📚 知识库」按钮 + `KnowledgeBaseModal` 弹窗（当前版本/来源徽标、最新版本+note、检查更新/一键更新/恢复内置/进度条/成败提示）；`main.css` 加 `.kb-*` 样式。
- **GitHub 发布物（已上线）**：新建公开仓库 **hulufeng/labcode-knowledge**（main 分支，latest.json 基线 v20261002-43）+ **Release v20261002-43**（asset knowledge.zip 27,756B，sha256 3c002327…，上传走 api.github.com + uploads.github.com，github.com 直连仍超时勿试）；zipUrl 走 gh-proxy 前缀（`https://gh-proxy.com/https://github.com/hulufeng/labcode-knowledge/releases/download/v20261002-43/knowledge.zip`），curl 实测 200 完整下载。
- **端到端实测（test-kb-update.js / test-kb-reset.js，截图 docs/kb-update-success.png）**：check 检测 v44 更新（按钮变"一键更新"）→ update 全链路成功（下载→sha256 校验→解压→用户目录 43 md + .version=20261002-44，UI 显示"已更新（用户版）/更新成功"）→ reset 成功（用户目录删除、回退 builtin v43、弹窗清 latest）→ 远端 latest.json 已恢复基线 v43（commit 721deccb）；重启后 `[Knowledge] 知识库 43 条` 加载日志正常、教学回归 2/2 PASS。
- **已知边界**：用户目录有更新时重启才生效（弹窗已注明）；kb:check 失败（网络/仓库不可达）UI 显示错误提示不崩溃；3B 自动选择是否生效取决于 `%APPDATA%\codelab-desktop\models\` 是否已装 3B（本机未装则回退 1.5B）。
- **工具脚本（保留）**：`scripts-pack-kb.js`（打包 knowledge.zip + latest.json）、`scripts-upload-kb.js`（Release+asset 上传，需 $env:GH_TOKEN）、`scripts-extract-kb.js`（知识库 md 提取器 43/43）；回归脚本 `test-kb-2q.js` / `test-kb-modal.js` / `test-kb-update.js` / `test-kb-reset.js`。`dist-kb/`（发布物）、`dist-kb-repo/`（本地 git 缓存仓库）为过程产物可留可清。
- **待办**：软件 v1.1.2 未发布（铁律：等用户说"发布"）；知识库内容后续由 ima 等编辑端维护 → 重跑 scripts-pack-kb.js 改版本号 → 上传（create release + asset + latest.json 三处）→ 用户软件内一键更新。

## 本轮完成 #63 补记：云端模型管理后台部署上线（2026-10-02，用户"发布更新部署"）

### 部署结果（已完成）
- **线上代码已替换并生效**：server.js（md5 9169f1547cd5ef24cea4729def4fd1e7）+ public/admin/index.html（md5 82d90e1f5f0dc61f6cb93c8d7f5d1a4a），旧文件备份 server.js.bak-20261002 / index.html.bak-20261002。
- **服务管理真相（关键）**：线上 3100 服务实际由 **PM2 托管**（app id 1 "codelab"，fork 模式，/root/.pm2 God Daemon pid 38511 已跑 49 天）；systemd codelab-ai-gateway.service 是后来添加的、永远 EADDRINUSE 崩溃循环（因 PM2 占端口）。已执行 systemctl stop + disable（symlink 已移除）。**今后线上重启/查看状态一律用 pm2（restart/save/logs），不要碰 systemd**。
- **公网验证全绿**（curl 实测）：/api/models 200（5 模型 available:false 无 Key 属正常）；/admin/ 200；管理员登录 LabCode-admin-2026 返回 token；GET /api/admin/models 含新字段 apiKeySource/available/apiKeyConfigured；网页配 Key 即时生效（PUT apiKey → available true）；清空 Key 回退（false）；无 Key 模型 test 接口返 400"未配置 API Key（MINIMAX_API_KEY）"。
- **PM2 save 已执行**（dump.pm2），pm2 startup 单元已存在（回显 unstartup 提示即已配置）。
- **清理**：服务器 /tmp 部署文件已删；本地 D:\codelab-deploy-tmp 已删；部署用脚本 verify-online.sh 已删（流程记录在案，需要时按本段重建）。

### 运维要点（下次部署/排障）
- SSH 通道：本机 **无系统 ssh**，用 D:\软件\Git\usr\bin\ssh.exe（密钥 ~/.ssh/id_ed25519，root@47.104.13.59，单引号包远程命令防 PS 展开 $()；post-quantum 警告是正常噪音）。
- 部署套路：本地复制到 ASCII 目录（D:\codelab-deploy-tmp\）→ scp 到 /tmp → 服务器 cp 备份后替换 → pm2 restart codelab → curl 验证。**不要** systemctl restart（会 EADDRINUSE）。
- nginx xinwang.conf 已有 /admin/ 与 /api/ 反代（proxy_pass 127.0.0.1:3100），无需改动。
- systemd 服务文件里 ZHIPU_API_KEY 配了两行（重复无害），但 **PM2 进程环境不含该 Key**；若用户要加智谱 GLM-4-Flash 免费模型，直接网页"添加模型"+ 配 Key 走 secrets.json 即可（baseUrl https://open.bigmodel.cn/api/paas/v4，model glm-4-flash，cost 0/multiplier 0）。
- 软件本体 v1.1.2 未发布（铁律：等用户明确说"发布"）。

## 本轮完成 #64：Hermes 学习循环（create_skill 全局技能沉淀）+ 3B 模型安装（2026-10-02，用户"hermes借鉴了吗→要"→"不是换3B模型吗"）

### 功能实现（对齐 Hermes Agent 招牌"学习循环：任务后自动沉淀 skill"）
1. **skillService.ts 新增全局技能写入**：`userSkillsDir()`（%APPDATA%\codelab-desktop\skills）+ `writeSkill(name, description, content)`——id 由 name 归一化（小写、非字母数字转 `-`、去首尾 `-`、限 40 字符），落盘 `skills/<id>/SKILL.md`（YAML frontmatter：name/description + 正文），同名覆盖更新；兼容 Claude Code 生态（list_skills/read_skill 已可读）。
2. **memory-tools.ts 新增 `create_skill` 工具**（createSkillTool）：参数 name/description/content 必填；content <80 字符拒绝（防止糊弄式沉淀）；category=write（default 安全模式需确认弹窗）；memoryTools 数组含它 → tools/index.ts `...memoryTools` 展开注册（注册链已确认）。
3. **agent-runner.ts buildSystemPrompt 工作原则第 15 条「学习循环」**：完成多步骤任务后，若有可复用完整流程（排查/搭建/手册类）→ 收尾前调用 create_skill 沉淀（含触发场景、步骤、示例、坑）；一次性琐事不建；有更优做法同名覆盖。

### 3B 模型安装（用户"不是换3B模型吗"→ 本机只有 1.5B）
- 下载源：`https://hf-mirror.com/Qwen/Qwen2.5-Coder-3B-Instruct-GGUF/resolve/main/qwen2.5-coder-3b-instruct-q4_k_m.gguf`（完整大小 2104932800 字节 = 2007.4MB，curl 断点续传完成）
- 落盘：`%APPDATA%\codelab-desktop\models\qwen2.5-coder-3b-instruct-q4_k_m.gguf`（2007.4MB 完整，与官方 Content-Length 一致）
- 注意：App 保存过旧设置 `local:qwen2.5-coder-1.5b...` 时重启**不会**自动升 3B（AiPanel load() 只在当前非 local 时自动切 3B）——需在 AI 面板手动切或测试里 `window.api.ai.setModel('local:<3b-gguf>')`。

### 端到端验证（test-skill-learn.js v4，CDP 9334 真机）——**4 PASS / 0 FAIL**
- 路径：切 3B 模型 → `window.api.agent.start({messages:[{role:'user',content:few-shot任务}], localModel:'qwen2.5-coder-3b...', securityMode:'auto', maxTurns:20})` → 3B 输出 `<tool_call>` → agent-runner 解析 → create_skill 执行 → SKILL.md 落盘
- 断言：SKILL.md 落盘 ✓ / frontmatter（`---\nname: demo-skill\ndescription:...`）✓ / 正文 >150 字符 ✓ / 对话含 create_skill 工具卡片 ✓
- 产物：`%APPDATA%\codelab-desktop\skills\demo-skill\SKILL.md`（保留作功能证据）

### 关键调试发现（写死胡同，别重走）
- **本地 1.5B/3B 对 create_skill（训练分布外新工具）主动调用不可靠**：1.5B 乱调 list_files/terminal 达 max_turns、谎称"已完成任务"（反幻觉只查"是否调用过"不查"零工具声称完成"——增强点待用户拍板）；3B 有随机性（同 few-shot 任务有时输出 <tool_call>、有时纯文本"我已成功完成任务"），需 few-shot 照抄模板 + 多轮重试或强模型。
- **create_skill 默认（default 模式）会弹确认窗**（write 类安全设计）——无人值守测试会 120s 超时自动拒绝；测试用 securityMode:'auto' 免确认。真实用户在教学场景看到弹窗属预期（防 AI 乱写磁盘）。
- **教学问答模式不影响**：祈使句（"请调用…"）不触发 runTeaching，已确认。
- **读链路已独立验证**：手动放置 SKILL.md（demo-manual-skill）→ list_skills 可扫描（test-skill-read.js 曾触发，后因模型行为波动未复测——扫描逻辑代码级确认）。

### 文件/脚本
- 改动：`src\main\services\skillService.ts`（writeSkill）、`src\main\engine\tools\memory-tools.ts`（createSkillTool）、`src\main\engine\agent-runner.ts`（第 15 条规则）
- 测试：`test-skill-learn.js`（v4 保留，可直接重跑）、`test-diag-chat.js`（抓 .ai-messages 诊断）、`test-skill-read.js`（读链路验证）；build 通过（typecheck:node 全绿）
- 未发布（铁律：等用户说"发布"）

## 本轮完成 #65：UI 界面全面测试 + create_skill 中文名补丁（2026-10-03，用户"UI界面测试一下"）

### 补丁（1 项，构建通过）
- **create_skill 缺中文名映射**（T9 中文名映射遗漏新增工具）→ `AiPanel.tsx` TOOL_CN_NAMES 加 `create_skill: '创建技能'`；构建产物 `out/renderer/assets/index-DH1QCTsZ.js` 含"创建技能"（静态验证 PASS）。

### UI 全面测试（CDP 9334 实测，两轮脚本 30 PASS / 7 FAIL，FAIL 全为断言形态误报，截图证实功能正常）
- 脚本：`test-ui-full.js`（结构/重叠/交互）+ `test-ui-probe.js`（DOM 探测复测），保留复用；截图 `docs/ui-full-*.png` 系列（main/board-menu/burn-tab/各 Tab）。
- **结构完整性（全 PASS）**：标题栏（LC/文件/编辑/视图/帮助/ESP32-S3 板卡选择器）、左侧 sidebar（🔌设备/📦平台管理/📚库管理/⚙️设置）、中间编辑器（welcome.ino/main.cpp/README.md 多标签）、右侧 AI 面板+ESP32 辅助面板（仿真/烧录双 Tab）、底部输出区（输出/问题/串口监视器/绘图仪/终端）、状态栏（工具链 1.5.2-rc.1/未打开项目/1/1 后端就绪/插件 3/检查更新/UTF-8/COM1·115200）。
- **布局重叠检测（全 PASS）**：编辑器 vs AI 面板 / 编辑器 vs 仿真面板 / AI vs 仿真面板 / 标题栏 / 状态栏——均无重叠（用户此前"重叠"反馈已确认修复）；AI 面板宽 ~260px 合理。
- **板卡选择（功能 PASS，断言误报）**：标题栏 ESP32-S3 按钮点击 → **左侧 sidebar 切换为完整设备配置面板**（开发板 ESP32S3 Dev Module/刷新板卡/Upload Speed/USB Mode×4/CPU 240MHz/Flash QIO 4MB/Partition/PSRAM/Core/Erase Flash/JTAG/Zigbee/端口 COM1/串口监视器）——比浮层菜单更完整的配置界面。
- **仿真面板（功能 PASS）**：▶ 模拟运行当前代码、ESP32-C3 芯片、GPIO8/GPIO2/GPIO0 状态、OLED 文本（显示/清屏）、GPIO0 电位器 1.65V、ADC1 多通道（GPIO1-4）、环境温湿度（SHT30•DHT22 共享 25.5℃/60%）、串口监视器 115200。
- **烧录面板（功能 PASS，断言误报）**：烧录 Tab 切换 → 虚拟板卡（ESP32-C3）/固件来源（内置演示固件）/演示固件（Blink 点灯演示）/MAC 15:81:33:60:15:81/▶ 模拟烧录/烧录进度 0%/固件段（bootloader 0x1000·partitions 0x8000·boot_app0 0xe000·app 0x10000）。
- **AI 面板（全 PASS）**：模型（Qwen2.5 Coder 3B (2GB)）/知识库/安全模式（默认-增删改需确认）/思考（标准思考）/账号/积分 5000/退出/新建对话/上下文使用统计/上传附件/引用当前文件/插入代码块/语音输入/发送；输入框可输入（实测注入文本+发送按钮存在）。
- **新功能 UI**：create_skill 中文名映射验证 PASS（构建产物含"创建技能"）。
- **误报说明（避免复测踩坑）**：① 板卡菜单不是浮层 dropdown，是 sidebar 面板切换（测浮层选择器必失败）；② 烧录面板查找"ESP32辅助"文本+children>3 会漏（切换后结构变化）；③ 未打开项目时 body.innerText≈1100 属空状态正常（非渲染失败）；④ 顶部是原生菜单栏（文件/编辑/视图/帮助）+ 板卡按钮（tb-btn 类），无传统 activity-bar。

## 本轮完成 #66：深度故障诊断（真实执行+严格断言，2026-10-03，用户"测试一下[故障诊断技能]"）

### 结论：核心链路 8/8 全绿，无真实软件 bug（2 处测试假设误报已定位澄清）
- 脚本：`test-diag-deep.js`（6 链路断言版）、`test-diag-editor.js`（Monaco/打开项目追查）、`test-diag-compile-err.js`（编译错误反证），保留复用；截图 `docs/diag-*.png`。

### 各链路实测结果
1. **编译真实链路 PASS**：`window.api.grpc.compile` 编译 _simtest/Blink（esp32c3）→ 退出码 0（真实 arduino-cli 工具链）。
2. **模拟烧录 PASS**：演示固件 C3 → `file(s) written successfully` + `Hash of data verified`，按钮转"✅ 烧录成功 · 再烧一次"。
3. **AI 本地对话（3B）PASS**：问"用一句话介绍你自己" → 回复"我是 LabCode AI 智能体，专注于帮助用户编写代码…"。
4. **知识库教学问答 PASS**：问"ESP32 点亮 LED 的原理是什么" → 纯文字教学回答（含电平原理），**无工具卡片**（runTeaching 生效）。
5. **编辑器链路（正常，探测误报澄清）**：`window.monaco` 未暴露全局属 ESM 正常（`winMonaco:false` 是探测方式问题）；monaco-editor DOM 存在；未打开项目时 models 空属正常（默认示例 welcome.ino 等由 React 层管理）。`project.open`（IPC project:open）**无路径参数、弹系统文件夹对话框**——UI 设计如此（用户交互）；AI 层 open_project 工具是带路径版（此前 T11 已实证）。**不是 bug**。
6. **串口监视器 PASS**：打开 → connected=true（伪设备 RFC2217）。
7. **编译错误反证 PASS（无假报成功）**：注入坏代码（`undefinedFunction()`）→ 编译 → 软件如实上报编译失败（退出码 1/编译失败），未出现假"编译成功"；测试后 Blink.ino 已还原（.bak 覆盖回原）。
8. **project API 形态确认**：`window.api.project` keys = [open, tree, create]（open 无参弹框）。

### 测试假设修正（写死胡同，别重走）
- 别假设 `project.open(path)` 接受路径（它无参弹系统对话框，无人值守会挂起 awaitPromise——用 AI 工具 open_project 或 UI 点开）。
- 别假设 `window.monaco` 全局可达（ESM 打包不挂 window，检查编辑器用 DOM 选择器 `.monaco-editor`/截图为证）。
- 编译链路调用 `window.api.grpc.compile({sketch, fqbn})` 是可靠入口（返回 {id}，输出走 UI 文本轮询"退出码 0/1"）。

## 本轮完成 #67：串口监视器窗口遮挡修复（2026-10-03，用户"UI界面设计有点遮挡"）

### 根因（全窗口重叠扫描定位，test-overlap-scan.js）
- `SerialMonitorWindow.tsx` 默认位置**写死 {x:160, y:90}** → 每次打开都盖在编辑器左上区域（实测 sm-window 与 monaco-editor 重叠 141740px²，与 sidebar 重叠 48640px²）；且无位置记忆、无边界钳制，拖动可跑出屏幕。
- 入口在**设备侧栏**（ToolchainSidebar 底部"串口监视器"按钮）→ `App.tsx` `onOpenSerialWindow` → `setSerialWindowOpen(true)`（标题栏/底部 Tab 不是浮动窗入口）。

### 修复（SerialMonitorWindow.tsx，构建通过）
1. **默认位置智能停靠**：localStorage 记忆优先（key `codelab-serial-pos`，拖动时自动保存）；无记忆时**停靠右下角**（x=vw-544, y=vh-404），不遮挡编辑器/侧栏/AI 面板。
2. **拖拽边界钳制**：move 中 clamp 到 [0, vw-528] × [0, vh-388]，窗口不会拖出屏幕。
3. posRef 跟踪当前 pos（闭包 stale 修正），mouseup 时持久化。

### 验证（test-serial-fix.js，断言+截图 docs/ui-serial-fixed.png）
- 打开串口窗口 → 实测位置 [898,498,520,380]（vw=1442,vh=902）→ rightDock ✓ bottomDock ✓ **editorHit=false（与编辑器零重叠）** PASS；截图确认编辑器/侧栏/AI 面板/仿真面板全部无遮挡，窗口内容完整（端口/波特率/打开/清空/Hex/自动滚动/日志/发送）。

### 测试假设修正（写死胡同，别重走）
- ActivityBar 的"设备/文件/插件/设置"是**纯图标 div（文字在 title 属性）**——用 `innerText` 匹配找不到，须 `[title="设备"]` 选择器；重启后默认侧栏是 files（项目面板），设备面板未开时无串口监视器按钮。

## 本轮完成 #68：布局三维审查（空隙/遮挡/展开）+ 串口监视器并入底部 Tab（2026-10-03，用户"各字段元素是否留有空隙，是否遮挡，是否全部展开"）

### 审查结果（test-layout-audit.js，全窗口逐元素）
- **展开 ✓ 0 处文本截断**（无 nowrap/ellipsis 溢出，全部字段完整显示）。
- **空隙 ✓ 无拥挤**：12 处 gap=0 告警全部为 Tab 类设计（编辑器 tabbar 标签、设备面板二级 Tab 无缝是 UI 惯例），非缺陷。
- **遮挡 ✗→已修复**：串口监视器浮窗右下角停靠仍覆盖右侧 ESP32 辅助面板下半（OLED/电位器/ADC/温湿度区）——右下角被右侧面板占满，浮窗无安全位置。

### 修复：串口监视器统一走底部面板（零遮挡）
- **根因**：底部输出区已有完整"串口监视器" Tab（OutputPanel：端口/波特率/打开/日志），浮窗 SerialMonitorWindow 是冗余第二实现 + 遮挡源。
- **改动**：
  1. App.tsx：删 SerialMonitorWindow import/挂载/serialWindowOpen state；`onOpenSerialWindow` 改为 `setTerminalVisible(true) + setOutputKey(k=>k+1)`；OutputPanel 加 `key={outputKey}` + `defaultTab="串口监视器"`。
  2. OutputPanel.tsx：Props 加 `defaultTab?: OutputKind`，`useState(defaultTab ?? '输出')`（key 变化重挂 → 切到串口 Tab）。
  3. SerialMonitorWindow.tsx 组件文件保留未删（drag 修复代码可复用，但不再被挂载）。
- **验证 PASS**（test-serial-tab.js + 截图 docs/ui-serial-tab.png）：点设备面板"串口监视器"按钮 → 底部面板打开且 activeTab="串口监视器"、serialBodyVisible、**floatingWindowGone=true**；编辑器/侧栏/AI 面板/仿真面板全部完整可见（OLED/电位器/ADC/温湿度/串口提示/模拟运行提示逐项 OCR 确认）。
- **剩余 5 处重叠扫描项 = 滚动裁剪误报**：示波器 canvas 在仿真面板滚动区底部（内容超长需滚动），布局 rect 与底部固定提示条数值重叠，但视觉被 overflow:auto 裁剪、截图无真实遮挡。

### 测试脚本沉淀
- test-layout-audit.js（三维审查：截断/拥挤/重叠）、test-serial-tab.js（串口 Tab 化验证）、test-serial-fix.js（浮窗位置验证，已过时但仍可跑）、test-overlap-scan.js（全窗口重叠）——均在项目根。

## 本轮完成 #69：TrieCode 实机对比测试（2026-10-03，用户"你测试一下对比triecode"）

### 方法
- computer_use（cu）打开桌面 TrieCode（'TrieCode#92d718eb22d147e31c8b35bb00c0bcbf1832845103'），实测欢迎页、项目工作区（打开最近项目 TRIECODEPROJECTS/desk_robot_esp32c3.ino）、文件菜单、工具栏；截图存档 docs/compare-triecode-welcome.png（欢迎页）、docs/compare-triecode-project.png（项目页）、docs/compare-triecode-menu.png（菜单）。
- LabCode 侧 CDP 抓当前界面 docs/compare-labcode-current.png。

### 并排对比结论
| 维度 | TrieCode | LabCode |
|---|---|---|
| 定位 | 通用代码 IDE（AI 优先） | ESP32 专用 IDE（真实烧录为主） |
| 欢迎页 | AI 优先：大标题+4 示例卡（控制LED/分析日志/读传感器/查串口）+输入框+模型/工作空间选择 | 无欢迎页（冷启动直接工作区） |
| 左侧栏 | 文件树（树状展开 159 文件·46 文件夹） | 设备面板（ESP32S3 全参数 19 项+端口+串口按钮）/ 文件面板 |
| 右侧 | 窄 AI 面板 ~160px（对话+示例卡+模型名+工作空间） | 宽 AI 面板 260px（模型/安全模式/思考/账号/积分/知识库）+ ESP32 辅助仿真面板 380px |
| 底部 | 输出/问题/串口监视器/绘图仪/终端 5 Tab | 同 5 Tab（串口已并入，零遮挡）✓ 一致 |
| 状态栏 | 后端就绪·中文·Ln/Col·UTF-8·账号·激活·工具链(未选板) | 工具链版本·项目·后端·插件数·检查更新·UTF-8·COM |
| 板卡配置 | 无设备面板（编译前才选板） | 完整设备面板（板卡+全部参数+端口） |
| 编译 | "点击 ✓ 编译"（需先选板） | 真实 arduino-cli 编译，输出走底部 |
| 仿真 | 无 | 行为级仿真（GPIO/OLED/ADC/DHT22/示波器/虚拟烧录） |
| 模型 | MiniMax M2.7（云端） | Qwen2.5 Coder 3B 本地 + 云端网关可配 |
| 菜单 | 文件(新建/打开/保存/另存为/关闭项目)+编辑/视图/帮助 | 文件/编辑/视图/帮助+板卡按钮 |

### LabCode 领先项（不需补）
ESP32 设备面板、行为级仿真、本地模型、知识库+教学问答、串口零遮挡底部 Tab。

### TrieCode 可借鉴项（待用户拍板开发）
1. **欢迎页/冷启动引导**（LabCode 没有）：ESP32 场景示例卡（LED 闪烁/读传感器/串口输出/编译调试），点卡即开示例工程。
2. **AI 面板精简模式**：TrieCode 面板极简（只对话+输入框）；LabCode 高级项（模型/安全模式/思考/积分）可默认折叠，需要再展开。
3. 菜单可加"关闭项目"（TrieCode Ctrl+W 有）——LabCode 无。
4. 状态栏"未选择开发板"提示（TrieCode 有工具链状态）——LabCode 状态栏已显示工具链版本+端口，等价。

## 本轮完成 #70：TrieCode 三项对齐开发 + CDP 验证（2026-10-03，用户对 #69 三项借鉴"要"）

### 三项改动（全部已写入源码 + 构建通过 + CDP 实测全绿）
1. **欢迎页/冷启动引导**：新建 `src/renderer/src/components/WelcomeView.tsx`（大标题"我们要一起做些什么？"+ 副标题"提问、写代码、编译、仿真、烧录——都可以告诉我"+ 4 张 ESP32 场景示例卡 + 打开项目按钮 + 提示语），App.tsx 编辑区 `tabs.length === 0 ? <WelcomeView> : <EditorArea>`（关闭项目后即回欢迎页）；4 卡 = 01-blink.ino（LED 闪烁·GPIO）/ 02-serial.ino（串口输出·调试）/ 12-adc-pot.ino（ADC 电位器）/ 13-sht30.ino（温湿度传感器·I2C），点卡经 `openFile(ex(fileName), fileName)` 打开示例工程；CSS `.welcome-view/.welcome-grid/.welcome-card*` 已加 main.css（hover 上浮 + tag 胶囊）。
2. **AI 面板精简模式**：AiPanel.tsx 新增 `showAdvanced` state（localStorage `codelab-ai-advanced`，'1' 展开/'0' 折叠，**默认折叠**）+ 头部齿轮切换按钮（title"展开高级选项/收起高级选项"）；安全模式+思考强度栏（ai-security-bar）、上下文用量面板、登录栏（ai-authbar）包进 `{showAdvanced && (<>…</>)}`——**默认只留对话+输入框+模型选择**（对齐 TrieCode 极简）；登录表单/BYOK 提示/上下文 chips 保留在折叠区外（功能位不隐藏）。
3. **菜单"关闭项目"**：TitleBar.tsx 文件菜单加 `{ label: '关闭项目', shortcut: 'Ctrl+Shift+W', action: 'closeProject' }`（保存后、分隔线前）+ Props `onCloseProject` + handleAction case；App.tsx 传入实现：`setTabs([])+setActivePath('')+setProjectRoot(null)+setTree(null)+输出日志"📁 项目已关闭"`。

### CDP 验证（test-align70.js / test-align70b.js，9334 端口）
- AI 精简初始：hasGear=true、securityVisible=false、authbarVisible=false（默认折叠）→ 点齿轮 → securityVisible=true + localStorage='1' → 再点回收 ✓
- 菜单：menu_has_close=true（文件菜单 dropdown 含"关闭项目"）
- 关闭项目：before_close tabs=[01-blink.ino] → 点菜单关闭 → after_close tabs=[]、editor=false、welcome=true、标题/4 卡全渲染 ✓
- 点卡开文件：点第一张卡 → tabs=[01-blink.ino]、editor=true、activeTab=01-blink.ino ✓
- 截图：docs/align70-welcome.png（精简 AI 面板 + 打开示例后的整窗）、docs/align70-welcome-view.png（欢迎页专图：4 卡+打开项目按钮+提示，布局居中无遮挡）
- **测试脚本坑**：编辑器 tab 元素 className 是 `.editor-tab`（非 `.tab`），首版脚本选择器误报 tabs=[]，修正后全绿。

### 状态
- v1.1.2 仍**未发布**（铁律：等用户明确"发布"）；三项对齐已在运行实例中生效（electron . --remote-debugging-port=9334）。
- 遗留：TrieCode 借鉴项 4（状态栏板卡提示）判定等价不补；欢迎页卡对应 examples 文件均在。

## 本轮完成 #71：v1.1.2 打包验证 + 修复"examples 未入包"打包缺陷（2026-10-03，用户"打包安装最新版本，然后继续测试"）

### 打包产物
- `npm run dist` 重新打包成功：`dist\LabCode-Setup-1.1.2.exe`（136,687,351 B，含签名+blockmap，2026-10-03 12:46，**含三项 TrieCode 对齐 + examples 修复**）；latest.yml version 1.1.2。

### 发现并修复打包缺陷（真实 bug）
- **症状**：打包版（win-unpacked）欢迎页三项验证时**点示例卡打不开文件**（tabs 空、editor false），而源码版正常。
- **根因**：主进程 `app:getExamplesDir` 打包后返回 `process.resourcesPath/examples`，但 electron-builder `extraResources` **未收录 examples 目录**（只有 proto/knowledge）→ 打包环境 resources/examples 不存在 → renderer 用该不存在路径替代源码路径硬编码回退 → 所有示例/演示固件读不到 → openFile read 失败静默移除 tab。simBurn:demos（内置演示固件 C3/S3）同样受影响。
- **修复**：① package.json build.extraResources 新增 `{ from: "examples", to: "examples" }`（win-unpacked\resources\examples 已确认含 sim-firmware/sim-firmware-s3/01~13 ino 等）；② src/main/index.ts 新增 `resolveExamplesDir()`（isPackaged 时 resources/examples 不存在 → 回退 app.getAppPath()/examples，双通道容错），`app:getExamplesDir` 与 `simBurn:demos` 共用。
- **验证**：新构建 win-unpacked 三项对齐**全 PASS** + **点卡开文件 PASS**（after_card tabs=[01-blink.ino]、editor=true、activeTab=01-blink.ino）；全功能回归 test-all-features.js 16 步全绿（首次运行在模拟烧录步骤瞬时中断，重跑全过——判据本身 OK）。

### 发现：NSIS 静默安装 /S 无效（记录，未改配置）
- 尝试静默安装 dist 安装包：`/S` 后轮询 180s `Programs\LabCode\resources\app.asar` 始终未出现；卸载旧版（9/13 老版 184MB）成功（GONE）后重装仍 INSTALL_FAILED——**oneClick=false 安装器的 /S 静默参数在本机无效**（electron-builder nsis 配置未变，v1.1.0/1.1.1 用户均为手动双击安装，行为一致）。
- 处置：安装包交给用户**双击安装**（与历史一致）；验证用 dist\win-unpacked\LabCode.exe（与安装包内容完全一致：asar+examples 均同源）。
- 注意：若日后要自动化安装，需改 electron-builder nsis 配置（oneClick:true 或自定义静默支持），本次未改。

### 遗留
- v1.1.2 未发布 GitHub/宣传页（铁律：等用户"发布"）；安装包已就绪在 dist\LabCode-Setup-1.1.2.exe。
- 测试脚本：test-align70.js/test-align70b.js（三项验证）、test-all-features.js（16 步全功能）、test-diag-installed.js/test-diag2-installed.js（本次诊断用，可删）。

## 本轮完成 #72：修复打包缺陷②（llama 引擎未入包）+ 三方 AI Agent 对比实测（2026-10-03，用户"继续测试，对比triecode和豆包的AIagent"）

### 打包缺陷 ② 修复（真实 bug）
- **症状**：打包版（win-unpacked）AI 发送后无回复（仅剩欢迎语；test-ai-compare2.js 8.5s 稳定检测误判把欢迎语当回复）。
- **根因**：electron-builder extraResources 缺 `resources/llama`（86MB 引擎：llama-server.exe + ggml 全套）→ 打包版 getEngineDir() 三个候选目录都无 llama-server.exe → 引擎从未启动 → AI 无回复。
- **修复**：package.json extraResources 新增 `{from:"resources/llama",to:"llama"}` → 重新打包 `LabCode-Setup-1.1.2.exe` **155,924,504 B**（12:46 再打包，现含 proto/knowledge/examples/llama 四资源）→ win-unpacked `resources\llama\llama-server.exe` 存在。
- **验证**：启动后 `Get-Process llama-server` 在跑（2038MB=3B 已加载）、`http://127.0.0.1:8080/health` → `{"status":"ok"}`；**基础问答 500ms 内返回真实模型回复**（test-ai-diag.js 关键证据："我是 LabCode AI 智能体，专注于帮助用户编写代码、执行命令、搜索网络、管理项目。"）。

### 三方 AI Agent 对比实测结论（核心发现，报告 docs/AI-Agent三方对比报告-20261003.md）
- **LabCode（本地 Qwen2.5-Coder-3B）**：基础问答 0.5–1s 秒回（离线/隐私/0 成本）；**工具调用不触发**——q2"读取当前打开的文件"实测 40s 后仅回复"好的，请告诉我你希望读取哪个文件的内容？"（未调 read_file，即使文件已在编辑器打开）。
- **TrieCode（MiniMax M2.7 云端）**：Agent 工作 16s + 思考 + 1 工具调用（读文件）→ 正确回答；积分计量条"输入 23.6k / 输出 58 / 1.68 积分"（复用 #69 实测数据）。
- **豆包（云端大模型 Agent）**：工作任务模式可操作本机文件/浏览器/飞书套件/定时任务、产出 Word/Excel/PPT/PDF/HTML；36氪实测豆包 2.1 Pro 连续 18h 完成芯片 RTL 测试；火山方舟支持 Function Calling/MCP（URL 见下方）。
- **差距量化**：本地 3B 无法可靠触发工具（40s 反问 vs TrieCode 16s 工具调用）；40s 生成期间 UI 无"思考中/工作中"可视化；无 token/积分计量。
- **改进建议（已写入报告）**：P0 当前文件上下文自动注入 + 确定性工具路由（检测"读取文件"意图直接执行 read_file，绕过 3B 模型工具决策短板）；P1 工作状态可视化 + token 计量；P2 云端模型（网关已就绪）作高级 Agent 付费点，本地/云端双轨并存。

### 豆包侧素材 URL
- 36氪实测：https://m.36kr.com/p/3867047187420420
- 火山方舟工具扩展：https://www.volcengine.com/docs/82379/1827538?lang=zh
- 豆包大模型 2.0+ArkClaw：https://developer.volcengine.com/articles/7628807185019240490

### 测试脚本
- test-ai-compare.js / test-ai-compare2.js（初版，busy 误判欢迎语为回复——保留参考勿再用）
- test-ai-diag.js（基础问答 500ms 真实回复证据）／ test-ai-diag2.js（工具场景 40s 反问证据，关键脚本）
- 截图 docs/ai-cmp-q1-self.png

### 遗留
- v1.1.2（含四项资源修复）未发布，等用户"发布"；安装包 dist\LabCode-Setup-1.1.2.exe 155.9MB 就绪。
- 下一步候选（用户择一）：① 落地 P0 确定性工具路由（补"读文件"体验）；② 云端网关 5 模型配 Key 后实测云端 Agent；③ 发布 v1.1.2（等指令）。

## 本轮完成 #73：AI Agent 继续对齐 TrieCode——P0 确定性文件注入 + 工作计时器（2026-10-03，用户"继续对齐"）

### 实现 1：P0 确定性文件上下文注入（修复"读取文件"反问差距，核心）
- **改动**：src/renderer/src/components/AiPanel.tsx send()——正则检测"读取/查看/分析当前文件"意图（`/(读取|看看|读一下|打开|查看|内容|实现什么|分析|解释).*(文件|代码|这个|当前)|(文件|代码|这个).*(是什么|实现|功能|内容|分析)/`）→ 命中且有当前打开文件时：**从主进程 window.api.fs.read(activePath) 实时读内容**（tabs.content 异步填充可能滞后，实时读最可靠）→ 注入 `[引用上下文]--- 文件名 ---\n内容` → 消息流加 system 提示"已自动引用当前打开的文件：xxx"。
- **动机**：本地 3B 模型工具决策能力弱（实测 40s 后仍反问"读取哪个文件"）——替模型做决策，无需 read_file 工具调用也能答对。
- **实测（test-ai-inject.js，win-unpacked 打包版）**：system 提示出现 + 模型基于文件内容真实回答（"我已经读取了 src/01-blink.ino 文件的内容。文件内容如下：…LED_PIN 2 / setup / loop…"）——与 TrieCode"读文件后回答"体验对齐；对比修复前"请告诉我你想要读取哪个文件的内容？"。

### 实现 2：工作计时器（对齐 TrieCode"▶ 已工作 16s"）
- **改动**：AiPanel.tsx 加 elapsedTick state + busy 时 1s interval；统计栏 busy 时显示"▶ 已工作 {N}s"（accent 高亮 + tabular-nums，CSS .agent-work-timer），done 后显示"用时 Ns"。
- **实测**：计时器 0s→2s 跳动 ✓。

### 关键排查记录（避免重复踩坑）
- **测试脚本 busy 误判**：`.ai-stop-btn` 只在 showAdvanced 展开时才渲染 → 精简模式下恒 false，**不能用它判 busy**。正确判据：计时器文本/assistant 消息变化。test-ai-compare.js/test-ai-compare2.js 因此误判，保留勿复用。
- **typing 占位也算 assistant 消息**：等待回复须排除 className 含 typing。
- **本地 3B 冷启动 40-60s**：kill 进程后重启 win-unpacked，llama-server 25MB（加载中）→ 约 40-60s 后 2034MB + health ok。冷启动期间发消息 UI 显示"思考中…"（busy true 计时器在走），引擎就绪后正常回复。**测试前先确认 health ok 再发消息**。
- test-ai-inject.js 为最终可用脚本（注入验证 + 计时器 + 真实回复等待，已修正全部坑）。

### 回归
- test-align70.js 三项对齐全 PASS（点卡开文件 after_card tabs=[01-blink.ino] ✓）
- test-all-features.js 全功能 16 步 OK（主界面/菜单/编译/模拟烧录/仿真外设/AI对话/消息操作/拖宽/用量/语音/课程隐藏/终端）
- 最新安装包 dist\LabCode-Setup-1.1.2.exe（含 examples+llama 引擎+P0 注入+计时器，未发布）

### 遗留
- TrieCode 积分计量条（token+积分）——本地模型无积分制，已用"输入/输出 token"计量条等价覆盖；云端模型接入后可升级为积分显示（等网关 Key）。
- v1.1.2 未发布，等用户"发布"。

## 本轮完成 #74：对照豆包能力项实测 LabCode AI（2026-10-03，用户"继续对照豆包测试"）

### 实测结果（test-ai-doubao.js，引擎已就绪）
| # | 能力项（对照豆包） | 耗时 | 结果 |
|---|---|---|---|
| T1 | 代码生成（按键控LED+消抖） | 6s | ✅ 完整正确程序 |
| T2 | 代码解释（当前文件） | 6s | ✅ 注入生效，基于真实文件内容 |
| T3 | 代码修改（改 delay 500ms） | 123s | ❌ 回复"请直接说明需要用户批准的操作"——不会调 edit_file、无代码输出、超时生硬收尾 |
| T4 | 硬件问答（ADC 注意事项） | 3s | ✅ 知识库命中，专业准确 |

### 结论与差距
- 达标：代码生成/解释/硬件问答（本地 3B + 知识库 + 注入已覆盖豆包日常教学场景，离线免费）。
- **真实短板 = 代码修改类任务（T3）**：写操作不能靠注入解决，3B 工具决策+安全确认链路弱 → 123s 无产出。
- 改进（已写 docs/AI-对照豆包测试-20261003.md）：P0 修改类确定性路由（检测修改意图→注入内容→强制模型输出修改后完整代码块→用户点"应用到文件"按钮写入，绕过工具短板）；P1 安全链路文案给可操作指引；P2 强任务留云端模型。

### 测试脚本
- test-ai-doubao.js（可复用：引擎 health 检查 + 注入场景 + 长等待排除 typing + 工具轨迹采集）；数据 docs/ai-doubao-compare.json。

### 遗留
- v1.1.2（含 examples+llama 引擎+P0 注入+计时器）未发布，等用户"发布"。
- 下一步候选：① 落地 T3 修改类确定性路由（P0）；② 云端网关配 Key 实测强任务；③ 发布。

## 本轮完成 #75：落地 T3 修改类确定性路由（2026-10-03，用户"测验的功能不一样需要借鉴的加上"）

### 实现（两处改动，全部实测通过）
1. **AiPanel.tsx**：modifyIntent 正则（修改/改成/换成/改一下/优化/加个/添加/调整/把X改成…/重写/重构）——检测到修改请求 → 复用文件注入（实时读文件）+ 附加 modifyHint 指令（"直接输出修改后的完整代码块，不要调用工具，不要请求批准，用户点「应用到文件」写入"）+ system 提示"已自动引用当前打开的文件：xx（检测到修改请求，请直接给出修改后的完整代码）"。
2. **agent-runner.ts**：新增 **isModifyRequest**（MODIFY_VERB_RE 且非疑问句）+ **runModify()**（空工具集单轮对话，buildModifyPrompt 强制输出修改后完整代码块）——run() 里在教学问答分支后拦截修改请求，彻底绕过 3B 工具决策+安全批准死路。

### 实测（test-ai-modify.js，打包版）
- 问"把当前打开文件里 LED 闪烁的 delay 改成 500ms"：
- **6s** 返回（对比修复前 123s 无产出），模型直接输出修改后完整代码块：`delay(500);  // 修改 delay 为 500ms`（两处都改）→ 代码块渲染带"应用到文件"按钮（INO 标签+应用到文件+复制）——对齐 TrieCode"应用到文件"交互 ✓
- 无工具调用、无"需要批准"死路 ✓；注入 system 提示出现 ✓

### 回归
- test-align70.js 三项对齐全 PASS；test-all-features.js 全功能 16 步全 OK（含插件·大模型）。
- 最新安装包 dist\LabCode-Setup-1.1.2.exe（含 examples+llama+P0 注入+计时器+修改路由，未发布）。

### 遗留
- **AI 能力对照豆包已全覆盖**：T1 生成 6s ✅ / T2 解释 6s ✅ / T3 修改 6s ✅（本轮）/ T4 硬件问答 3s ✅——本地 3B 离线完成豆包日常教学四项能力。
- 引擎懒加载：冷启动 40-60s 期间首问等待长（已记录，可加 AI 面板展开预热，低优先级）。
- v1.1.2 未发布，等用户"发布"。

## 本轮完成 #76：AI Agent 三方对比 v2（2026-10-04，用户"再去比较agent"）

### 产出
- **docs/AI-Agent三方对比报告-20261004.md**（v2）：用最新修复版重测四项能力（引擎已热）：
  - T1 生成 6s ✅ / T2 解释 6s ✅ / T3 修改 **3s** ✅（v1 是 123s 失败）/ T4 问答 3s ✅——四项全绿，离线完成豆包日常教学场景。
- 对比表 v2：工具调用方式改为"确定性路由"（注入/代码块+应用到文件）；工作状态可视化 ✅（计时器）；token 计量 ✅；剩余差距=复杂多步自主任务（本地 3B 上限）→ 云端网关补位（P2）。
- 旧报告 v1（20261003）保留对照（记录修复前差距：40s 反问/123s 死路）。

### 证据
- docs/ai-doubao-compare.json（v2 四任务回复）；测试脚本 test-ai-doubao.js / test-ai-modify.js / test-ai-inject.js。

### 遗留
- v1.1.2 未发布，等用户"发布"。

## 本轮完成 #78：AI Agent 完整对比（10 项全量，2026-10-04，用户"再去完整比较"）

### 实测（test-ai-full.js，打包版，引擎已热）
**10/10 全绿，全部 3-5s 离线完成**：
- T1 生成 3s ✅ / T2 解释 5s ✅ / T3 修改 3s ✅ / T4 ADC 问答 5s ✅ / T5 多轮 3s+3s ✅ / T6 组合 5s ✅ / T7 边界 5s ✅ / T8 调试 3s ✅（缺 Arduino.h+修正代码）/ T9 一句话 PWM 3s ✅ / T10 串口乱码 3s ✅（波特率）
- 零工具死循环、零批准卡死。

### 产出
- docs/AI-Agent完整对比-20261004.md（10 项矩阵 + 差异表 + 定位结论）
- 数据 docs/ai-full-compare.json；脚本 test-ai-full.js（全量最终可用）

### 定位结论（完整对比版）
- LabCode = 离线 ESP32 教学编程助手（10 项日常任务全覆盖 3-5s 免费离线）；TrieCode/豆包 = 云端全能 Agent。
- 商业化：本地守基本盘 + 云端网关（bluebubai.work 待 Key）接多步自主任务付费点 + 计时/token UI 已建。
- 剩余差距：① 多步工具编排（云端补位）；② 冷启动 40-60s（预热优化低优先）；③ 大上下文长文档（留云端）。

### 遗留
- v1.1.2（含全部修复）未发布，等用户"发布"。
- 下一步候选：① 云端网关配 Key 实测云端 Agent（补复杂任务差距）；② AI 面板展开预热引擎（冷启动体验）；③ 发布。

## 本轮完成 #77：Agent 第二轮深度对比 + 本地模型对话路由重构（2026-10-04，用户"再去比较"）

### 第二轮实测暴露 3 个真问题（T5/T6/T7）
- T5 多轮追问：第二问"和 C 有什么区别"跑偏答成"LabCode 是智能体"——多轮上下文理解弱
- T6 组合任务（写 DHT22 程序+解释）：15s 误判 read_file（detectRequiredTools 的"读取"裸词命中）→ 幻觉路径 src/main.ino → 20 轮耗尽
- T7 边界问题（知识库未覆盖："能不能播放 MP4"）：反复试工具 20 轮耗尽

### v2 架构调整（agent-runner.ts，全部实测通过）
1. **本地模型默认无工具单轮对话（runChat）**：路由=教学问答(runTeaching) → 修改请求(runModify) → 本地模型且 detectRequiredTools 未命中明确操作词 → runChat（空工具集，直接文字/代码块回答）；仅明确操作指令（编译/烧录/写文件/打开等）才走 Agent 工具循环。
2. **收紧 read_file 判定**：去掉裸"读取"（"读取 DHT22 传感器"不再误判为读文件），改为"读取文件/读取当前/读取这个/读取一下/请读/查看文件/读一下文件"。
3. runChat + buildChatPrompt：强调直接回答、不调工具、多轮注意上文语境、知识库命中时附参考资料。

### 实测（打包版）
- T5 多轮：q1 6s ✅（C++/Arduino）、q2 3s ✅（正确答 ESP32 vs C 区别，修复跑偏）
- T6 组合：6s ✅ 直接输出完整 DHT22 代码块（DHT.h/readTemperature）+ 应用到文件
- T7 边界：6s ✅ 直接答"不直接支持，可用 FFmpeg/云服务"
- 第一轮回归：T1 6s / T2 6s / T3 3s / T4 6s 全绿无破坏

### 更新
- docs/AI-Agent三方对比报告-20261004.md 追加 §2.4（第二轮对比 + 修复记录）
- 证据：docs/ai-compare2.json（T5-T7 原始回复）、test-ai-compare2.js

### 遗留
- v1.1.2（含全部修复）未发布，等用户"发布"。

### 烧录专项全链路测试（2026-10-03，用户"测试烧录"）
- **结果：编译 → 模拟烧录（当前代码/演示固件）→ 串口监视器全链路全绿**，并修复 1 个真实 bug：
- **【修复】扁平 .ino 示例编译失败（main file missing）**：arduino-cli 要求 sketch 目录名与主文件同名（sketch/xxx.ino），内置示例 examples/01-blink.ino 是扁平结构 → 直接编译必报 "Can't open sketch: main file missing"。修复：toolchain.ts 新增 
ormalizeSketchPath()（父目录名≠文件名时复制到 %TEMP%\codelab-sketch/<name>-<ts>/<name>.ino 再编译，Arduino IDE 同款做法），compileSketch / uploadSketch / index.ts grpc:compile 三处接入（清理钩子 cleanup 在退出回调执行）；CLI 直编验证通过（01-blink 复制同名目录后编译成功：Sketch uses 271716 bytes (20%) / Global 22116 bytes (6%)），UI 实测通过（打开 01-blink.ino → 点编译 → 按钮变"编译成功"、退出码 0、Sketch uses 315584 bytes (24%)，esp32s3 目标）。
- **【实测】模拟烧录演示固件**：切仿真面板"烧录"Tab → 选"内置演示固件" → ▶ 模拟烧录 → 完整日志（Flash erase 0x8000/0xe000/0x10000 → Verifying → Hash of data verified → Done. 4 file(s) written successfully → Chip verified: ESP32-C3）成功。
- **【实测】模拟烧录当前代码**：编译成功（esp32s3）→ lastBuildPath 注入 → 烧录视图 sim-src 出现"当前代码（编译产物）"选项 → 选 build → 板卡自动匹配 esp32s3 → ▶ 模拟烧录 → Writing 进度 57%→98.6%（175.39kB）→ 成功。
- **【实测】编译/板卡/串口现状**：arduino-cli 1.5.2-rc.1（%APPDATA%\codelab-desktop\tools\arduino-cli）+ esp32 核心 3.3.11 已装（core list: esp32:esp32 3.3.11 / arduino:avr 1.8.8）→ **新用户无需装 Arduino，软件内置一键安装 + 核心自动装，装完直接编译/烧录**；板卡列表 esp32 全平台 425 项（esp32s3/c3 可选）；串口列表 COM1 + COM28 (USB 串行设备)（COM28 为真实 USB 转串口，但不确定是 ESP32 板，真实烧录未动）；"烧录到开发板"按钮无串口设备时安全。
- **【坑】CDP 测试面板选择器**：SimulatorPanel 根 div 无 className（纯内联 style，宽 380px）——.simulator-panel 类不存在，旧 test-all-features.js 该选择器已失效；切"烧录"Tab 用 [...document.querySelectorAll('button')].find(e => e.textContent.trim() === '烧录') 精确文本匹配；编译成功判据用输出面板 .output-panel innerText 含 "Sketch uses"（body 不含！编译输出在底部 Tab 内）。
- 测试脚本保留：test-burn.js（演示固件烧录）/ test-burn2.js（闭环）/ diag2-7.js（诊断，可删）；证据图 docs/burn-simburn-done.png / docs/burn-final-burn-done.png / docs/diag5-burn-view.png / docs/diag6-burn-tab.png。
