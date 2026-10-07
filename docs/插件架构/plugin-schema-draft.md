# codelab-desktop 插件 manifest 规范（草案 v0.1）

> 设计先行文档。本规范把《TrieCode 插件架构竞品分析》（`codelab-doc/TrieCode-插件架构竞品分析.md`）§9 行动建议落成**我方可落地的 plugin.json schema**，
> 并配套「元插件三件套」`plugin-dev-toolchain`（create/validate/install + 「创建插件」Skill）。
>
> **合规边界**：借鉴的是架构范式 / 字段命名 / 信任模型（同业通用做法，MCP/CLI 封装为行业共识），**不是抄代码**。实现一律自研。

---

## 0. 一句话定位

codelab 插件是**专门暴露给 AI Agent 调用**的能力包（区别于传统 IDE 给人用的插件）。一个插件由三层封装：

- **skills（技能层）**：多步规划与选型引导，承载领域知识（如「创建插件」Skill 把 transport 选择写进 prompt）。
- **tools（工具层）**：AI 可直接调用的原子能力，每个 tool 绑定到一条 **transport 通道**。
- **通用后端（backend）**：重执行 / 长任务 / 领域智能由宿主或插件自带后端承担（对应 TrieCode 的 `internal` + `backend`）。

对外讲架构复用 TrieCode 已通行的词汇：`skills` / `tools` / `transports`。

---

## 1. transports 通道枚举（7 种，对齐 TrieCode + 我方增量）

| transport | 含义 | 典型绑定字段 | 我方定位 |
|---|---|---|---|
| `cli` | 直接 spawn 子进程调外部 CLI（arduino-cli / esptool / openocd） | `cli.command[]`, `cli.timeoutMs`, `cli.successCodes`, `cli.stream` | 与 TrieCode 一致；直调保真度高于包一层 MCP |
| `internal` | 调宿主标准服务（串口 / 编译 / 插件开发…） | `internal.service`, `internal.method` | 同构；`service:"pluginDev"` 专供元插件 |
| `http` | 调远程 HTTP 服务 | `http.url`, `http.method`, `http.headers` | 同构 |
| `grpc` | 调 gRPC 后端（如 arduino-cli daemon） | `grpc.service`, `grpc.method` | TrieCode 已有；我方 arduino-cli daemon 用 |
| `mcp` | 调 MCP 服务器暴露的工具 | `mcp.server`, `mcp.tool` | 同构（主流方案仅用 MCP，我方把它列为七通道之一） |
| `backend` | 调插件自带后端（进程 / stdio JSON-RPC / grpc） | `backend.backendId`, `backend.method` | 同构 |
| `mqtt` | 设备遥测回流 / 长任务状态 / 多智能体协同 | `mqtt.server`, `mqtt.op` | **我方差异化新增量**，TrieCode 六通道无此 |

> **差异化卖点**：`mqtt` 命中嵌入式 / IoT 真实需求（板子主动上报采样、烧录长任务进度回流、多 Agent 协同）。对外单列。

---

## 2. 顶层字段表

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string(kebab-case) | 否* | 插件唯一 id；缺省时回退 `name` |
| `name` | string | **是** | 插件名（英文标识） |
| `displayName` | string | **是** | 展示名（中文友好） |
| `version` | string | **是** | semver |
| `description` | string | **是** | 一句话能力描述 |
| `author` / `developer` | string | 否 | 作者 |
| `icon` | string | 否 | 图标（路径或 emoji id） |
| `minAppVersion` | string | 否 | 最低宿主版本 |
| `entry` | string | **是** | 入口文件（如 `index.js`） |
| `channels` | `Record<transport, string[]>` | **是** | 全量七通道表，列出本插件在各通道注册/声明的命令名 |
| `capabilities` | `Record<kebab, {transport,service?,method?,output?}>` | 否 | 能力声明 map |
| `tools` | `Tool[]` | 否 | 暴露给 AI 的工具列表 |
| `skills` | `Skill[]` | 否 | 技能/引导（多步规划） |
| `settings` | `Setting[]` | 否 | 设置项（密钥走 `{settings.*}` 占位符） |
| `projectTypes` | `ProjectType[]` | 否 | 新建项目脚手架（含 `scaffold[].file/content`，路径安全校验） |
| `devicePanel` | object | 否 | 设备侧栏面板（selectors/actions） |
| `commands` | `Command[]` | 否 | UI 命令（action / open-view） |
| `views` | `View[]` | 否 | 视图挂载（sidebar/activitybar/panel/webview） |
| `mqttServers` | `MqttServer[]` | 否 | MQTT 服务器声明（name/url/topics） |
| `backends` | `Backend[]` | 否 | 插件自带后端声明（type/command） |
| `detection` | object | 否 | 环境探测（如工具链是否存在） |

> *校验器（validate-manifest.ts）对 `name`/`version` 强制必填；`id` 仅做格式校验，缺失不报错（回退 name）。

---

## 3. skills[] —— 技能层

```jsonc
"skills": [
  {
    "name": "创建插件",
    "description": "引导 AI 从零生成一个 codelab 插件：先问清需求，再选 transport，再产出骨架并校验。",
    "prompt": "（见 skill-create-plugin.md：需求→基础→选 transport→create→完善 manifest→validate→问是否安装→install→问是否启用）"
  }
]
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | **是** | 技能名 |
| `description` | string | **是** | 技能用途 |
| `prompt` | string | 否 | 多步引导 prompt；可引用独立 `.md` 文件 |

**设计要点**：领域知识**同时**固化进 `tools[].description`（单工具上下文）与 `skills[].prompt`（多步流程），二者解耦但互补。

---

## 4. tools[] —— 工具层

```jsonc
"tools": [
  {
    "name": "plugin-dev.create",
    "transport": "internal",
    "category": "create",                 // 可选：create/query/modify/delete/execute
    "description": "根据入参生成一个新的插件骨架（plugin.json + index.js），落盘到指定目录。",
    "internal": { "service": "pluginDev", "method": "create" },
    "schema": {                          // 参数 JSON Schema
      "type": "object",
      "properties": {
        "id":       { "type": "string", "description": "插件 kebab id" },
        "transport":{"type": "string", "enum": ["cli","internal","http","grpc","mcp","backend","mqtt"] },
        "outDir":   { "type": "string", "description": "骨架输出根目录" }
      },
      "required": ["id", "transport", "outDir"],
      "additionalProperties": false
    }
  }
]
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | **是** | 工具名（命令名） |
| `transport` | enum(7) | **是** | 绑定通道 |
| `category` | enum | 否 | `create`/`query`/`modify`/`delete`/`execute`（元插件用前三者） |
| `description` | string | **是** | 含领域知识（如 fqbn 格式提示） |
| `schema` | JSON Schema | 否 | 参数定义 |
| `cli`/`http`/`grpc`/`mcp`/`internal`/`backend`/`mqtt` | object | 按 transport | 绑定形状见下表 |

### transport 绑定形状

| transport | 绑定字段 | 校验要求 |
|---|---|---|
| `cli` | `cli.command[]`, `cli.timeoutMs?`, `cli.successCodes?`, `cli.stream?` | command 非空数组；占位符 `{argName}`/`{defaultPort}`/`{defaultFQBN}` |
| `http` | `http.url`, `http.method?`, `http.headers?` | url 必填 |
| `grpc` | `grpc.service`, `grpc.method` | 两者必填 |
| `mcp` | `mcp.server`, `mcp.tool` | 两者必填 |
| `internal` | `internal.service`, `internal.method` | 两者必填（元插件用 `service:"pluginDev"`） |
| `backend` | `backend.backendId`, `backend.method` | 两者必填 |
| `mqtt` | `mqtt.server`, `mqtt.op` | 两者必填 |

> **元插件约定**：`internal.service === "pluginDev"` 时 `method ∈ {create, validate, install}`，对应三件套。

---

## 5. capabilities —— 能力声明 map

```jsonc
"capabilities": {
  "sensor-read":  { "transport": "internal", "service": "sensor", "method": "sample" },
  "sensor-chart": { "transport": "internal", "service": "sensor", "method": "history" }
}
```

- key 为 kebab-case 能力 ID；不在内置白名单时**仅提示不拦截**（前向兼容扩展能力）。
- 绑定形状与 `tools[].internal` 同构。

---

## 6. settings[] 与 `{settings.*}` 占位符（密钥不落包）

```jsonc
"settings": [
  { "key": "mqtt.brokerToken", "label": "MQTT 令牌", "type": "password", "default": "" }
]
```

- `type ∈ {string, number, boolean, select, url, urlArray, password}`。
- **密钥规范**：manifest 与代码里**不硬编码**密钥；命令/绑定中用 `{settings.mqtt.brokerToken}` 占位符，安装或启用时由用户在设置页填入，宿主注入运行时值。
- 与 TrieCode 的 `{settings.*}` 同职；仓库不含生产密钥 / 凭据 / 内网地址。

---

## 7. 信任模型（官方 / 第三方两级 + 配套）

| 维度 | 规则 |
|---|---|
| **官方市场** | 只收**可审计**插件（源码可查、无隐藏网络/文件操作）；配套 `Apache-2.0` + `NOTICE` + `CONTRIBUTING`（第三方视角） |
| **第三方发现** | GitHub topic（如 `codelab-plugin`）自助发现；用户自行决定是否信任 |
| **首次安装确认** | 弹确认卡展示 来源 / 版本 / 暴露能力 / zip sha256 校验和；确认后写入 `pluginTrusted`，之后更新不再打扰 |
| **两层校验** | ① manifest 校验（validate-manifest.ts 11 项，防误配置不防恶意）② zip sha256 校验和（防中途换包） |
| **诊断纪律** | 沿用 HANDOVER 红线「只写本机不外发、不记 Key」——与 TrieCode 同源但更强调本机边界 |

---

## 8. 元插件三件套契约（`plugin-dev-toolchain`）

| 工具 | category | 行为 | 宿主协作 |
|---|---|---|---|
| `plugin-dev.create` | create | 按 `id/name/transport/author/outDir` 生成骨架目录（plugin.json + index.js + 样例 tool），落盘 | 纯本地文件生成 |
| `plugin-dev.validate` | query | 读 `path` 下的 plugin.json，复用宿主校验口径 | `ctx.invoke('internal','app.validateManifest',{manifest})` |
| `plugin-dev.install` | modify | 校验通过后把插件目录落盘 `userData/plugins/<id>` 并热加载 | `ctx.invoke('internal','app.reloadPlugins',{})` |

**「创建插件」Skill 端到端流程**：需求 → 基础信息 → **选 transport**（写进 Skill 引导，说明每种通道适用场景）→ create → 完善 manifest → validate → **问用户是否安装** → install → **问是否启用**。

### 选型对照（Skill 引导用）

- `cli`：有现成命令行工具要包一层（arduino-cli / esptool / openocd）。
- `internal`：复用宿主已有能力（串口 / 编译 / 插件开发）。
- `http`：后端是远程服务。
- `grpc`：后端是 gRPC 服务（如 arduino-cli daemon）。
- `mcp`：能力已由某个 MCP 服务器提供。
- `backend`：插件自己带重执行后端（进程 / stdio）。
- `mqtt`：设备主动上报 / 长任务状态回流 / 多 Agent 协同。

---

## 9. JSON Schema 草案（machine-readable）

> 用于编辑器自动补全与 CI 校验。枚举与校验器 `VALID_TRANSPORTS` / `VALID_SETTING_TYPES` / `VALID_COMMAND_KINDS` 保持一致。

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "codelab plugin.json",
  "type": "object",
  "required": ["name", "displayName", "version", "description", "entry", "channels"],
  "properties": {
    "id": { "type": "string", "pattern": "^[a-z0-9]+(-[a-z0-9]+)*$" },
    "name": { "type": "string" },
    "displayName": { "type": "string" },
    "version": { "type": "string" },
    "description": { "type": "string" },
    "author": { "type": "string" },
    "developer": { "type": "string" },
    "icon": { "type": "string" },
    "minAppVersion": { "type": "string" },
    "entry": { "type": "string" },
    "channels": {
      "type": "object",
      "properties": {
        "internal": { "type": "array", "items": { "type": "string" } },
        "backend":  { "type": "array", "items": { "type": "string" } },
        "cli":      { "type": "array", "items": { "type": "string" } },
        "http":     { "type": "array", "items": { "type": "string" } },
        "grpc":     { "type": "array", "items": { "type": "string" } },
        "mcp":      { "type": "array", "items": { "type": "string" } },
        "mqtt":     { "type": "array", "items": { "type": "string" } }
      },
      "required": ["internal","backend","cli","http","grpc","mcp","mqtt"]
    },
    "capabilities": { "type": "object" },
    "tools": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["name", "transport", "description"],
        "properties": {
          "name": { "type": "string" },
          "transport": { "type": "string", "enum": ["cli","internal","http","grpc","mcp","backend","mqtt"] },
          "category": { "type": "string", "enum": ["create","query","modify","delete","execute"] },
          "description": { "type": "string" },
          "schema": { "type": "object" },
          "cli": { "type": "object" }, "http": { "type": "object" },
          "grpc": { "type": "object" }, "mcp": { "type": "object" },
          "internal": { "type": "object" }, "backend": { "type": "object" },
          "mqtt": { "type": "object" }
        }
      }
    },
    "skills": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["name", "description"],
        "properties": {
          "name": { "type": "string" },
          "description": { "type": "string" },
          "prompt": { "type": "string" }
        }
      }
    },
    "settings": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["key"],
        "properties": {
          "key": { "type": "string" },
          "label": { "type": "string" },
          "type": { "type": "string", "enum": ["string","number","boolean","select","url","urlArray","password"] },
          "default": {}, "description": { "type": "string" }, "restartRequired": { "type": "boolean" }
        }
      }
    },
    "projectTypes": { "type": "array" },
    "devicePanel": { "type": "object" },
    "commands": { "type": "array" },
    "views": { "type": "array" },
    "mqttServers": { "type": "array" },
    "backends": { "type": "array" }
  }
}
```

---

## 10. 与 TrieCode 字段对照速查

| 概念 | TrieCode | 我方（本草案） | 关系 |
|---|---|---|---|
| 技能 | `skills[]` `{name,description,prompt}` | `skills[]` 同 | **完全一致** |
| 工具 | `tools[]` `{name,description,parameters,category,internal{service,method},transport}` | `tools[]` 同 + `schema`(JSON Schema) | **同构** |
| 通道枚举 | `cli/internal/http/grpc/mcp/backend`（6） | 同上 + `mqtt`（7） | 我方多 MQTT |
| 能力声明 | `capabilities` map | `capabilities` map | **同构** |
| 设置+密钥 | `settings[]` + `{settings.*}` 占位符 | `settings[]` + `{settings.*}` 占位符 | **同职** |
| 元插件 | `plugin-dev-toolchain` create/validate/install + Skill | `plugin-dev-toolchain` create/validate/install + Skill | **直接对标** |
| 校验 | `validateManifest`（TrieCode core） | `validate-manifest.ts`（11 项） | 同职，我方多 skills/category |
| 信任 | 官方市场审计 + 第三方 GitHub topic + Apache-2.0 | 同上 + 本机「只写不外发」纪律 | 我方更强调本机边界 |

---

## 11. 红线与合规

- 自研不抄实现；本规范借鉴的是**架构范式 / 字段命名 / 信任模型**（同业通用），实现（校验器、宿主命令、元插件）一律自研。
- 插件必须**自包含**：不跨插件 `require('../')`，不 require 宿主模块（耦合只靠通道命令名，路径解析交给运行时 `ctx.invoke`）。
- 密钥不硬编码、不随包分发；统一走 `{settings.*}` 占位符。
