# 官方通道（云端）后端契约 · 最小可用对照表

> 本文档**严格取自客户端源码** `src/main/services/aiGateway.ts`，未臆造任何字段。
> 客户端「设置 → 模型 → 官方账户」区块已接好，后端照此实现即可端到端联通。
> 网关地址：`process.env.CODELAB_AI_SERVER || 'https://bluebubai.work'`（自动去掉结尾 `/`）。
> 所有请求 `Content-Type: application/json`；登录态接口带 `Authorization: Bearer <token>`。

---

## 1. 鉴权流程概览

```
注册/登录  ──POST /api/auth/{register|login}──▶  { token, user }
   │
   ├─ 客户端把 token + user(积分等) 写入本地 ai-settings.json
   │
   ├─ 拉模型    ──GET  /api/models──────────────▶  { models: [...] }
   ├─ 查账户    ──GET  /api/me (Bearer)──────────▶  { user }
   ├─ 发消息(非流) ──POST /api/chat──────────────▶  { content, creditsLeft, cost }
   └─ 发消息(流式) ──POST /api/chat/stream (SSE)─▶  data:{...} + event:credits
```

- 登录态以**客户端本地缓存的 token** 为准；`/api/models` 无需 token（但 401/403 会被当成「未登录/过期」提示）。
- 登录/注册/刷新都会把 `user` 里的积分字段写回本地，UI 直接读本地显示。

---

## 2. 端点对照表

| # | 方法 | 路径 | 鉴权 | 请求体 | 成功响应 | 失败 |
|---|------|------|------|--------|----------|------|
| 1 | POST | `/api/auth/register` | 否 | `{ email, password }` | `{ token, user }` | `2xx` + `data.error?` 否则抛错 |
| 2 | POST | `/api/auth/login` | 否 | `{ email, password }` | `{ token, user }` | 同上 |
| 3 | GET | `/api/me` | Bearer | — | `{ user }` | 非 2xx / 无 `user` → 抛错 |
| 4 | GET | `/api/models` | 否* | — | `{ models: AiModel[] }` | 401/403 → 「未登录或过期」；其它非 2xx → 抛错 |
| 5 | POST | `/api/chat` | Bearer | `{ model, messages }` | `{ content, creditsLeft, cost }` | 非 2xx → 抛错（含 `data.error`） |
| 6 | POST | `/api/chat/stream` | Bearer | `{ model, messages, stream:true, tools?, tool_choice? }` | SSE 流（见 §4） | 非 2xx → 抛错 |

> *`/api/models` 客户端未带 token；若你希望「未登录不给模型列表」，返回 401 即可，客户端会提示去登录。

### 2.1 请求/响应样例

**① 注册（login 同结构）**
```http
POST /api/auth/register
Content-Type: application/json

{ "email": "user@example.com", "password": "secret123" }
```
```json
{ "token": "eyJhbGciOi...", "user": {
    "email": "user@example.com",
    "planCredits": 100,
    "rechargeCredits": 0,
    "totalCredits": 100,
    "planMonth": "2026-12"
} }
```

**③ 查账户**
```http
GET /api/me
Authorization: Bearer eyJhbGciOi...
```
```json
{ "user": {
    "email": "user@example.com",
    "planCredits": 100,
    "rechargeCredits": 0,
    "totalCredits": 95,
    "planMonth": "2026-12"
} }
```

**④ 模型列表**（字段含义见 §3）
```http
GET /api/models
```
```json
{ "models": [
  { "id": "deepseek-flash", "name": "DeepSeek Flash", "provider": "deepseek",
    "baseUrl": "", "model": "deepseek-chat", "costPerCall": 1,
    "desc": "快速、便宜", "available": true }
] }
```

**⑤ 非流式对话**
```http
POST /api/chat
Authorization: Bearer eyJhbGciOi...
Content-Type: application/json

{ "model": "deepseek-flash",
  "messages": [ { "role": "user", "content": "ESP32 怎么点灯？" } ] }
```
```json
{ "content": "用 digitalWrite(2, HIGH) …", "creditsLeft": 94, "cost": 1 }
```

**⑥ 流式对话**（SSE，见 §4）
```http
POST /api/chat/stream
Authorization: Bearer eyJhbGciOi...
Accept: text/event-stream
Content-Type: application/json

{ "model": "deepseek-flash",
  "messages": [ { "role": "user", "content": "ESP32 怎么点灯？" } ],
  "stream": true }
```

---

## 3. 数据结构

### UserInfo（鉴权相关响应的 `user` 字段）
```ts
interface UserInfo {
  email: string
  planCredits: number      // 套餐赠送积分
  rechargeCredits: number  // 充值积分
  totalCredits: number     // 总积分（UI 主显示项）
  planMonth: string        // 套餐有效期，如 "2026-12"（纯展示）
}
```

### AiModel（`/api/models` 数组元素）
```ts
interface AiModel {
  id: string          // ★ 关键：客户端会原样回传为 /api/chat 的 model 字段
  name: string        // 界面显示名
  provider: string    // 如 "deepseek" / "openai"（展示用）
  baseUrl: string     // 官方通道一般留空 ""
  model: string       // 后端实际模型标识（展示/透传用）
  costPerCall: number // 单次消耗积分（展示用）
  desc: string        // 描述（展示用）
  available: boolean  // 是否可用（展示用）
}
```

### ChatMessage（对话消息）
```ts
interface ChatMessage { role: 'user' | 'assistant'; content: string }
```

### FunctionSchema（仅 Agent 模式带 tools 时发送，最小可用可忽略）
```ts
interface FunctionSchema {
  type: 'function'
  function: { name: string; description: string; parameters: object }
}
```

---

## 4. 流式响应（SSE）格式

`POST /api/chat/stream` 返回 `text/event-stream`，**OpenAI 兼容**增量格式：

```
data: {"choices":[{"delta":{"content":"用 "}}]}
data: {"choices":[{"delta":{"content":"digitalWrite"}}]}
data: {"choices":[{"delta":{"content":"(2, HIGH) 即可。"}}]}
data: {"choices":[{"delta":{},"usage":{"prompt_tokens":12,"completion_tokens":34}}]}
event: credits
data: {"remaining": 93}

data: [DONE]
```

客户端解析规则（来自 `aiGateway.ts`）：
- 每行 `data:` 后接 JSON；`delta.content` 逐字拼接为助手回复。
- `delta.reasoning_content`（推理内容，可选）也会透传。
- `delta.tool_calls`（OpenAI 兼容，Agent 模式才发）按 `index` 累积，格式：
  `{ index, id?, function?: { name?, arguments? } }`。最小可用后端可**不发** tool_calls。
- **积分更新**二选一：
  - 推荐：`event: credits` + `data: { "remaining": <number> }` → 客户端写 `totalCredits = remaining`。
  - 兼容：`data: { "creditsLeft": <number> }` → 客户端同样更新。
- 流结束可发 `data: [DONE]`（客户端忽略该标记，以连接关闭为准）。

---

## 5. 关键约定（务必遵守，否则客户端会报错或积分不更新）

1. **`model` 字段**：客户端默认 `modelId = 'deepseek-flash'`，登录后会把该值作为 `model` 发给 `/api/chat` 与 `/api/chat/stream`。
   → 你的 `/api/models` **至少返回一个 `id: "deepseek-flash"` 的模型**，且 `/api/chat`、`/api/chat/stream` 必须能识别它。
   → 用户若在下拉里选了别的模型，`model` 就是你返回的其它 `id`，原样透传，无需客户端再转换。
2. **错误响应**：失败请返回 **HTTP 非 2xx** + body `{ "error": "人类可读原因" }`。客户端对非 2xx 抛 `data.error || '请求失败（status）'`，UI 直接展示该文案。
3. **积分**：`/api/chat` 必须返回 `creditsLeft`（整数）；`/api/chat/stream` 建议发 `event: credits` + `remaining`。客户端据此刷新界面「积分」显示，**不**依赖你另外的通知机制。
4. **token**：`/api/auth/{login,register}` 返回的 `token` 会被客户端原样放进后续请求的 `Authorization: Bearer <token>`；`/api/me` / `/api/chat` / `/api/chat/stream` 必须认这个 token。
5. **CORS**：若前端是 Electron 内 `file://` / `app://` 或本地 dev server 调你后端，确保后端允许对应 Origin（Electron 渲染进程在 `app://` 协议下，必要时对 `Origin: null` 或特定 dev origin 放行）。

---

## 6. 最小可用后端自检清单

- [ ] `POST /api/auth/register` 返回 `{ token, user }`（user 含 5 个字段）
- [ ] `POST /api/auth/login` 返回 `{ token, user }`
- [ ] `GET /api/me`（带 Bearer）返回 `{ user }`
- [ ] `GET /api/models` 返回 `{ models: [...] }`，且**含 `id:"deepseek-flash"`**
- [ ] `POST /api/chat`（带 Bearer，body `{model,messages}`）返回 `{ content, creditsLeft, cost }`
- [ ] `POST /api/chat/stream`（带 Bearer）返回 SSE，至少发 `content` 增量 + 结束；建议带 `event: credits`
- [ ] 失败时返回非 2xx + `{ "error": "..." }`
- [ ] token 在 `/api/me`、`/api/chat`、`/api/chat/stream` 均有效
- [ ] （可选）`tool_calls` 工具调用——仅当要支持 Agent 模式走官方通道时才需实现

> 上线前：客户端「设置 → 模型 → 官方账户」点登录/拉模型会报网络错误（被 catch 成提示），属预期；
> 后端起好、地址可达（默认 `https://bluebubai.work`，或用环境变量 `CODELAB_AI_SERVER` 指向你的地址）即联通。
