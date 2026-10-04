# TrieCode 官网学习记录（triecode.com 全站）

> 日期：2026-10-01 ｜ 来源：https://www.triecode.com（首页/价格/路线图/插件广场/文档六页全量浏览）
> 意义：TrieCode 是 codelab 的直接对标产品（商业闭源售卖 + AI 智能体 + 嵌入式工具链），官网是**产品定位、定价、路线图、插件规范、版本节奏**的一手权威来源，与解包源码、GitHub 插件集三源互证

---

## 一、公司/产品基本信息

| 项 | 内容 |
|---|---|
| 产品定位 | **通用 AI 软件开发智能体**（不只是嵌入式！覆盖软件开发全流程：读写代码/执行命令/跑测试/联网检索） |
| 当前版本 | v1.3.1（Windows，NSIS 安装包，约 144 MB） |
| 系统要求 | Windows 10/11 x64 |
| 公司邮箱 | TrieCode@xinxianzn.com（芯先智能） |
| 备案 | 豫ICP备2025140744号-2 |
| 下载直链 | https://dl.triecode.com/TrieCode-Setup-1.3.1.exe |
| 站点结构 | 首页（功能/产品/价格/路线图锚点）+ 插件广场（/plugins/）+ 文档（/docs/）+ 账户中心 |

**学习点**：TrieCode 把"通用软件 IDE + AI Agent + 嵌入式工具链插件"三合一卖——codelab 目前只做嵌入式教学，可考虑"通用开发入口 + 嵌入式特色"的扩展空间。

---

## 二、首页功能页（产品能力全景）

### AI 智能体四能力（官网文案）
1. **读写代码**：读取项目结构、精准修改文件、自动生成模板——**AI 改完的每一块可逐块审阅后一键暂存**（v1.3.1 独有卖点："四家主流 AI 工具都还没有这个能力"）
2. **执行命令·跑测试**：内置终端；**结构化测试运行器**自动识别 pytest/unittest/go test/cargo test 并解析结果，失败按**断言/编译/超时/崩溃分类**，AI 逐类修复
3. **联网检索**：内建 web_search/web_fetch
4. **记忆·技能·子智能体**：跨会话记忆、可复用技能（**兼容 Claude Code 生态**）、只读研究子智能体

### 工作台五件套
| 部件 | 技术 | 说明 |
|---|---|---|
| 现代编辑器 | **Monaco 内核** | 多语言高亮、文件树+多标签+脏文件管理、图片实时预览 |
| 内置终端 | xterm | 交互式 shell（Python REPL/vim/ssh），**AI 也能在其中直接执行命令** |
| 测试运行器 | 结构化 | 一键探测框架、失败分类、AI 修复 |
| 源代码管理 | Git 面板 | 改动列表/diff、暂存/提交/推送/拉取、克隆、冲突解决（逐块选"我的/对方的/都要"）、**检查点回退（回到任意回合前，回退本身可撤销）** |
| 通用插件系统 | **七类通道** | CLI/HTTP/gRPC/MCP/MQTT/internal/stdio |

### 操作模式与安全
- **plan / default / auto 三种操作模式**（官网口径；与 Cline 的 plan/act/yolo 类似，注意 TrieCode 是三档"权限逐步放开"）
- API Key 本机保存

### 内置 AI 模型（截至 2026.09）
DeepSeek V4 / 通义千问 Qwen / MiniMax M3（1M 上下文）/ 智谱 GLM-5.2（1M 上下文）+ Kimi/Doubao/OpenAI/Claude/**Ollama 本地**/任意 OpenAI 兼容端点

### 对比表口径（营销话术，但暴露产品取舍）
TrieCode vs Cursor/Copilot/Claude Code："真正执行命令/终端：内置终端 vs 受限 vs — vs 命令执行"；"嵌入式工具链：插件开箱即用 vs 需配置 vs — vs —"

---

## 三、定价页（积分制——codelab 定价直接参考）

| 档位 | 价格 | 积分/月 | 定位 |
|---|---|---|---|
| 免费版 | ¥0 | 200 | 入门体验 |
| Lite | ¥29/月 | 1,500 | 日常开发 |
| Pro | ¥150/月 | 7,000 | 专业开发 |
| Max | ¥260/月 | 15,000 | 专业团队 |
| 团队标准版 | **¥520/月/席** | 40,000 | 至少 2 席，共享积分池，管理员邀请+成员申请 |

**积分机制（关键设计）**：
- 套餐积分每 30 天刷新；**充值/邀请奖励积分永久有效**（100 积分 = ¥5）
- 月付/季付(95折)/年付(9折)
- **AI 提问按模型系数消耗积分**（v1.3.0 起改为**按实际 token 用量计算**，短问便宜；每个模型独立系数，系数=每 2000 token 的积分数）
- AI 回复下方显示本次消耗积分；子任务（分工/验证/图片识别/代码索引/记忆提取）也计入
- 调用失败/中途取消**全额退还预扣积分**
- 邀请好友注册双方各得 200 积分
- 支付：收钱吧（微信/支付宝扫码），官网账户中心

**学习点**：codelab 若做积分制，可直接套这套"套餐积分刷新 + 充值永久 + token 按量 + 失败退还 + 模型系数"模型；比 TrieCode 更早的点：把"烧录次数/仿真时长"也做成消耗项。

---

## 四、路线图页（产品规划节奏）

**已交付**：通用软件 AI 智能体（读写/执行/测试/联网）、源代码管理（Git 面板+检查点回退+AI 改动逐块审阅暂存）、通用插件体系、记忆/技能/子智能体/MCP、**终端版 CLI 与定时任务**

**规划中**：
1. Git 分支管理（面板已交付，缺分支切换/新建/合并）
2. 更多语言代码智能（当前 C/C++ 走 clangd 全量符号；扩展 TS/Python/Rust LSP）
3. **调试器与断点（DAP）**，覆盖通用语言与嵌入式
4. 跨平台 macOS/Linux + 性能优化

**学习点**：TrieCode 版本节奏=先桌面核心（编辑器/AI/插件）→ 再 Git/测试/语音 → 后调试器/跨平台。codelab 可对照排出自己 3-6 个月路线（当前 codelab 已有：编辑器/Monaco、串口、烧录、仿真；缺：Git、测试运行器、语音输入、DAP）。

---

## 五、插件广场（官方市场 + 社区生态）

**市场现状**：全部官方插件已开源（Apache-2.0），源码可审计、可自由集成

| 插件 | 版本 | 亮点/更新日志要点 |
|---|---|---|
| 插件开发工具链 | v0.1.1 | AI 完全主导：问需求→生成骨架→校验→问是否安装→问是否启用 |
| Arduino CLI 工具链 | v0.3.11 | **依赖下载完整性校验（国内 gitee 优先、官方备用）**——国内化下载策略 |
| ESP-IDF 工具链 | v0.1.11 | **一键安装器走国内镜像（dl.espressif.cn）下载提速** |
| STM32Cube 工具链 | v0.1.2 | CMake+GCC 编译、SWD 一键烧录、裸机脚手架（F103/F401/F411） |
| 浏览器自动化 | v0.1.5 | **直接驱动系统已装 Microsoft Edge（免下载浏览器内核）+ 便携 Node 下载完整性校验 + npx 走 npmmirror 国内镜像** |
| Wokwi 模拟器 | v0.1.4 | 编译固件→仿真引擎运行→串口断言→自动化场景→电路图校验→截图 |
| 立创EDA | v0.2.3 | **一键重排（主IC居中/VCC上/GND下/外围贴脚/留通道+自动布线验证）+ 桥进程插件托管 + 握手 token 认证 + 失败自动重连自愈** |
| OpenSCAD 工具链 | v0.1.1 | 写 .scad→三视角预览自纠→渲染 STL/3MF→切片，内置 BOSL2 |
| 51 单片机 | v0.3.3 | SDCC 编译 + stcgal 串口 ISP 烧录 STC，10 款芯片（加芯片只改配置表） |

**社区生态**：GitHub `triecode-plugin` topic 发现；发布流程=Fork 官方仓库→打 topic→可选提 PR；**官方市场仅收录可审计代码，社区插件不进官方市场**

**安装方式**：官方市场一键安装 / 从文件夹安装 / 从 ZIP 安装；安装后自动接入（活动栏面板 + AI 工具与技能）

**学习点（codelab 插件市场直接可抄）**：
1. **国内下载镜像三策略**：gitee 优先官方备用 / dl.espressif.cn 专用镜像 / npmmirror——codelab 的 arduino-cli 等依赖下载同样面临国内网络问题
2. 便携二进制（Node/工具链）下载 + SHA 完整性校验
3. 插件安装三通道（市场/文件夹/ZIP）
4. 官方市场只收录可审计代码

---

## 六、文档-插件开发指南（官方规范全文，codelab 插件体系圣经）

### 插件结构
```
my-toolchain/
├── plugin.json   # manifest（必填）
├── ui/           # Web 视图（views.webview entry）
├── tools/        # cli 插件的可执行脚本/二进制
├── proto/        # gRPC 插件自带 .proto
└── assets/       # 资源（如 lib/ 库）
```
运行时宿主创建 `bin/`（dependencies 下载的二进制，不属打包内容）

### 七类通用通道（重点！比 GitHub README 更全）
| transport | 说明 | 关键实现细节 |
|---|---|---|
| **cli** | 一次性命令行 | **spawn 数组参数不经 shell 防注入**；`{参数名}` 占位符替换（值永远单 argv）；`{defaultPort}`/`{defaultFQBN}` 特殊占位符；**必须声明 timeoutMs**（默认 30s 会误判长编译，ESP-IDF 编译 600000）；`stream+streamChannel` 逐行输出到编译面板；`pty` 真终端（idf.py menuconfig）；`pauseSerialPort` 烧录前暂停串口日志 |
| **http** | REST API | 全局 fetch 尊重代理；URL/query/headers 模板；`parse:{type:json,pick}` |
| **grpc** | 动态 proto | 自带 .proto，宿主动态加载；`backends` 声明 daemon（port 0=随机分配）；**只连自己声明的端口（安全边界）**；unary+server-streaming；camelCase↔snake_case 映射 |
| **mcp** | MCP 服务器 | mcpServers 声明（command/args/autoApprove）+ mcp transport 认领工具 |
| **internal** | 宿主标准能力 | serialport（串口列表/选择）、serialLog（后台串口日志）、state（板卡选项）、arduinoCli、toolchain（工具链检测状态）——**插件零宿主特例** |
| **backend** | stdio 长驻后端 | JSON-RPC over stdin/stdout（ESP-IDF confserver）；rpc:'jsonrpc' 标准 或 'kconfig' 适配（启动横幅=整棵树）；stdioBridge 惰性管理（项目切换停旧起新） |
| **mqtt** | MQTT 设备通道 | mqttServers 声明 + op 五种（publish/request/collect/read_state/status）；**安全：非回环 broker 强制 TLS、allowedPublishTopics 白名单 fail-closed、密码 {settings.*} 永不进日志** |

### 能力声明（UI 主按钮与 AI 工具同源路由！）
- 能力 id 枚举：compile / upload / flash / debug / board-manage / board-select / library-manage / platform-install
- **UI 编译/上传按钮与 AI 工具经同一条能力路由执行**——codelab 直接抄这条架构（UI 按钮=能力绑定，AI 工具=同一绑定）
- 绑定可声明 output（如 avr-gcc，宿主显示编译仪表）

### 命令 / 视图 / 项目类型
- **命令 commands**：kind=action（触发工具）| open-view（开视图）；placement=plugin.panel / sidebar.*.header / panel.header / context.menu / device-panel.action；**顶部工具栏不接受插件按钮（toolbar.action 已移除，写了会被启动校验拒绝）**；when 最小 DSL（projectType=arduino、&& || !、key 白名单 fail-safe）；命令 id 前缀 {pluginId}.{commandId}
- **项目类型 projectTypes**：scaffold 模板 {name} 占位符 + 宿主路径安全清洗（拒绝绝对路径/.. 穿越）
- **视图 views**：slot=sidebar/activitybar/panel；triecode-plugin:// 协议（仅服务 active 插件、path 约束+MIME 白名单）；iframe 沙箱无 same-origin；postMessage 通信（来源+schema 校验）

### 插件左侧栏两段式布局 + 拖拽适配（codelab 仿真面板右侧停靠可对照）
- 宿主自动生成顶部选项卡：[设备][视图A][视图B][设置]
- webview 内不要加大标题/说明角标（宿主已是标题）
- **拖拽 200-480px 响应式 CSS 骨架**（输入框 flex:1 1 auto + min-width:0、按钮 flex-shrink:0、行 flex-wrap、控件 width:min(100%,150px)、body overflow-x:hidden）——codelab 右侧面板宽度自适应直接复用此清单

### 设备面板（devicePanel）——数据驱动通用设备壳
- selectors：设备维度选择器（source 复用工具后端；searchable；key=fqbn/board/port 写设备上下文；**onSelect 自动执行动作**省去"选完再点应用"）
- optionLoader/optionSet：配置选项读写（**AI 与 UI 选项同源**）
- actions：设备动作（自动携带设备上下文；hidden 保留供 onSelect/AI 复用）
- **宿主按 selectors key 派生编译/上传前置门控 needsBoard/needsPort**：Arduino 有 fqbn+port → 都要先选；ESP-IDF 只有 target+port → 只需端口——**codelab 烧录前置校验直接抄**
- detailView：webview 兜底

### webview 双向通信
ready→host.ready；host.invoke（白名单：capability:run/command:invoke/devicePanel:*/toolchain:resolve/core:*）；state.subscribe（设备上下文推送）；events（宿主事件）；安全五重（sandbox+来源校验+方法白名单+path/MIME 约束+仅 active 插件）

### 工具链检测与一键安装（G7）
**检测五级**：手动路径→envVars→官方安装器 JSON（installerJson）→pathGlobs（支持 $USERPROFILE/~/<toolsPath> 展开）→validateFile
**derive 派生**：toolsPath=parent(frameworks)、pythonEnv=glob(...)、exportPathFrom=tools/tools.json（**复刻官方 export 脚本 <5ms 免跑慢命令**）
**installer**：宿主下载并运行官方安装器（**文件名白名单 [a-z0-9-]+.exe**）
**projectDetection**：文件标记→项目类型声明式推断（CMakeLists.txt 含 project.cmake → esp-idf）

### 打包发布
zip 上传市场（zip 内直接 plugin.json 或子目录）；安装三通道；**validateManifest 校验：能力 keys/工具 transport/命令 kind/placement/scaffold 路径安全/视图 entry，非法拒绝**

---

## 七、文档-快速开始（产品使用流程样板）

通用流程（5 分钟）：下载安装→新建项目（选类型自动生成结构）→AI 面板自然语言描述→AI 读结构写代码（auth.py）→AI 跑测试（pytest/npm test/go test/cargo test）→验证

嵌入式流程（Arduino 示例）：启用插件→新建 Arduino 项目（生成 .ino）→插件"设备"选项卡选板（FQBN）选口→工具栏"上传"一键编译烧录→底部"串口监视器"实时查看

---

## 八、更新日志（版本节奏与功能演进 v1.2.9→v1.3.1）

### v1.3.1（2026.09）——源代码管理重点版
- Git 面板全量（改动列表 diff、暂存/提交/推送/拉取、克隆自动打开、冲突解决逐块选+AI 合并建议、**检查点回退可撤销**）
- **AI 本轮改动逐块审阅后直接暂存**（独家卖点，四家主流 AI 只有"全部保留/全部撤销"）
- 账号令牌用于 git（认证失败自动重试；令牌不写地址/不进命令行/不落盘）
- AI 工作流显示修正：工具失败不再显示绿勾（编译失败/插件错误/被拒绝三类）；子代理独立卡片
- 修两个老问题：AI 输出把对话往下拽（滚动跟随解锁/重锁策略）、完成提示音不响（音频时钟冻结）
- **数据保护专项**：AI 改文件不顶掉编辑器正在写的内容、检查点回退先落盘再动手、长期记忆不因一次读取失败清空
- 英文界面双语；性能（面板刷新不再重复扫描整个工作树）

### v1.3.0（2026.09）——语音输入 + 积分按用量
- **语音输入**（焊接/接线/拿万用表时用）：麦克风→录音读秒→自动识别填输入框→可改→自己点发送
- **积分改按 token 用量**（问得短就便宜，一句话 0.0x 积分）；模型独立系数；子任务消耗也计入
- 邮箱登录；窗口拉窄工具栏按优先级收起（模式→思考强度→麦克风→文件名）
- 安全：修复仅凭密码完成邮箱验证码登录的问题；预扣积分失败/取消全额退

### v1.2.9（2026.08）——Agent 升级 + 加固
- **分步任务清单 + 强制验证**：复杂任务自动建清单一步步做、全部完成才收尾、停滞自动提醒；AI 改完代码必须运行验证并引用真实结果（用无关命令冒充会被追问）；连续失败自动换策略
- 桌面端加固（外部项目文件树刷新、Ctrl+R 双触发、未保存标记、格式化、串口按当前波特率打开）
- MCP 总开关即时连接/断开、同名服务器拒绝
- CLI 修复（硬件命令参数错位曾向端口 myproj 烧录——`flash --board uno COM3 myproj` 经典 bug）

---

## 九、对 codelab 的学习点汇总（分级）

### A. 直接抄（架构级）
1. **能力路由**：UI 编译/上传按钮与 AI 工具同一条能力绑定（capabilities + transport + service + method）——codelab 工具栏与 AI 面板不再双轨
2. **设备面板门控**：selectors key（fqbn/board/port）→ 自动派生 needsBoard/needsPort 前置校验
3. **七类通道**：codelab 插件化至少先做 internal（串口/烧录/状态）+ cli（spawn 数组防注入 + timeoutMs 必填 + pauseSerialPort）+ backend（stdio JSON-RPC）
4. **validateManifest**：安装前校验（能力 keys/transport/scaffold 路径安全/视图 entry），非法拒绝
5. **拖拽响应式 CSS 清单**：右侧面板（codelab 仿真辅助 380px）宽度自适应复用

### B. 参考（产品级）
1. **定价积分制**：套餐积分刷新+充值永久+token 按量+模型系数+失败退还——codelab 若做会员直接套
2. **国内镜像三策略**：gitee 优先/dl.espressif.cn/npmmirror + 便携二进制完整性校验
3. **安装三通道**：市场/文件夹/ZIP
4. **语音输入**（焊接场景）——codelab 硬件调试场景强相关
5. **AI 改动逐块审阅暂存**（独家卖点）——codelab 编辑器已有，可加"AI 改动高亮+逐块接受"
6. **失败分类显示**：工具失败不显示绿勾；编译失败/插件错误/被拒绝三类明确标注

### C. 启发（路线级）
1. 更新日志的"数据保护专项"清单（AI 不顶掉正在编辑的内容、回退先落盘、记忆不因一次失败清空）——codelab 发布前专项检查对照表
2. 路线图顺序：核心→Git→调试器(DAP)→跨平台；codelab 可排：编辑器/AI/烧录→Git/测试→DAP/跨平台
3. 插件市场只收录可审计代码 + 社区 topic 去中心化——codelab 插件生态起步即可用
4. "加芯片只改配置表"（sdcc chips.json）——codelab 板卡数据驱动

---

## 附：浏览轨迹（可复查）
- https://triecode.com（首页：AI 四能力/工作台五件套/三模式/内置模型/对比表/嵌入式）
- https://www.triecode.com/#pricing（定价：五档积分制）
- https://www.triecode.com/#roadmap（路线图：已交付/规划中）
- https://www.triecode.com/plugins/（插件广场：9 插件+版本+安装方式+社区生态）
- https://www.triecode.com/docs/（文档目录）
- https://www.triecode.com/docs/quick-start/（快速开始：通用+嵌入式流程）
- https://www.triecode.com/docs/plugin-dev/（插件开发指南：七类通道/能力/命令/视图/项目类型/devicePanel/webview 通信/检测五级/打包）
- https://www.triecode.com/docs/changelog/（更新日志 v1.2.9/v1.3.0/v1.3.1）
