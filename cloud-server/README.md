# codelab-desktop 官方通道（云端）后端

零运行时依赖的 Node ESM 服务，**严格实现**客户端契约（详见仓库内
`docs/dev-log/CLOUD-BACKEND-CONTRACT.md`，契约取自 `src/main/services/aiGateway.ts`）：

| 端点 | 说明 |
|------|------|
| `POST /api/auth/register` | `{email,password}` → `{token,user}` |
| `POST /api/auth/login` | `{email,password}` → `{token,user}` |
| `GET  /api/me` | (Bearer) → `{user}` |
| `GET  /api/models` | → `{models:[AiModel]}`，**必须含 `id:"deepseek-flash"`** |
| `POST /api/chat` | (Bearer) `{model,messages}` → `{content,creditsLeft,cost}` |
| `POST /api/chat/stream` | SSE (Bearer) → `data:{...}` + `event: credits` |

## 运行

```bash
cd cloud-server
node server.mjs                 # 默认端口 8787，数据落 ./data/db.json
# 或自定义
PORT=9000 node server.mjs
```

启动后控制台打印：`监听 http://127.0.0.1:8787`，客户端应设 `CODELAB_AI_SERVER=http://127.0.0.1:8787`。

## 内置模型清单（/api/models）

> 客户端不写死模型，全部来自本服务的 `/api/models`，新增/调整模型只改本文件 `MODELS` 即可。

| id | provider | 说明 | 配 Key |
|---|---|---|---|
| `deepseek-flash` / `deepseek-coder` / `deepseek-r1` | `deepseek` | DeepSeek（OpenAI 兼容） | `DEEPSEEK_KEY` |
| `qwen-coder` / `qwen-max` | `qwen` | 通义千问（DashScope 兼容模式） | `DASHSCOPE_API_KEY` |
| `gpt-4o` / `gpt-4o-mini` | `openai` | OpenAI（OpenAI 兼容） | `OPENAI_API_KEY` |
| `gemini-1.5-pro` / `gemini-2.0-flash` | `gemini` | Google Gemini（**非** OpenAI 兼容，后端负责归一化） | `GEMINI_API_KEY` |

每个模型在 `MODELS` 里带 `baseUrl` + `keyEnv`；**只有你在本机配了对应 KEY，该模型才真实代理，否则返回演示回复**（积分照样扣，便于先验证整链路）。

## 两种模式

1. **演示模式（默认，无需任何 key）**：`/api/chat` 与 `/api/chat/stream` 返回确定性演示回复，
   并**真实扣减积分**——足以让客户端「设置 → 模型 → 官方账户」整链路跑通。
2. **真实 LLM 代理**：给每个 provider 配服务端 Key 后即接管 `/api/chat` 与 `/api/chat/stream`，
   按 provider 分派：
   - `openai` / `deepseek` / `qwen` → OpenAI 兼容 `/chat/completions`（透传 `model` + `messages` + `tools` + `stream`）；
   - `gemini` → Google Generative Language API，后端把 OpenAI 格式的 `messages`/`tools` 翻译成
     Gemini 的 `contents`/`functionDeclarations`，并把 Gemini SSE **归一化为客户端契约**（OpenAI 兼容 SSE），
     所以客户端无需为 Gemini 写特殊解析。

   ```bash
   # 各 provider 的服务端 Key（缺哪个，哪个模型就走演示）
   OPENAI_API_KEY=sk-xxxx \
   GEMINI_API_KEY=xxx \
   DEEPSEEK_KEY=sk-xxxx \
   DASHSCOPE_API_KEY=sk-xxxx \
   node server.mjs
   ```

   **可选**：用环境变量覆盖各 provider 的 baseUrl（便于走代理 / Azure OpenAI / 自建网关）：
   `OPENAI_BASE_URL` / `GEMINI_BASE_URL` / `DEEPSEEK_BASE_URL` / `DASHSCOPE_BASE_URL`
   （默认已填官方地址，仅覆盖其一即可）。

3. **全局单上游兜底（兼容旧部署）**：若只设了 `AI_UPSTREAM_URL` + `AI_UPSTREAM_KEY`（不设 per-provider），
   则所有 **OpenAI 兼容档**（deepseek/qwen/openai）都走它；**Gemini 必须自己配 `GEMINI_API_KEY`**，否则演示。

## 让桌面客户端连上本服务

客户端默认网关地址是 `process.env.CODELAB_AI_SERVER || 'https://bluebubai.work'`。
启动 Electron 前注入环境变量即可指向本地服务（以 Windows 为例）：

```bat
set CODELAB_AI_SERVER=http://127.0.0.1:8787
npm run dev
```

或在已构建产物里：

```bat
set CODELAB_AI_SERVER=http://127.0.0.1:8787
start-labcode.bat
```

打开「设置 → 模型 → 官方账户」：注册/登录 → 看到积分 → 选内置模型 → 在对话里发消息，
会走官方通道、流式返回、并扣减积分。

## 验证

仓库内 `scripts/e2e-cloud-server.mjs` 会真实启动本服务，并用**真实客户端代码**
`aiGateway` 跑 注册 → 登录 → 拉模型 → 发消息 → 积分下降 → 流式，全部断言通过后停服务：

```bash
node scripts/e2e-cloud-server.mjs
```

## 安全提示

- 这是**开发/演示**后端：密码用 scrypt 哈希、token 为随机 UUID，但数据存本地明文 JSON、
  无频率限制/防爆破。生产环境请替换为正式鉴权与数据库。
- 演示模式不接真实模型，仅用于验证客户端整链路。
