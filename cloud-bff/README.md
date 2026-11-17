# BubaiCode 云端 BFF

客户端 → 本服务（鉴权/限流/记账）→ DeepSeek 官方 API。零依赖，Node 18+。

## 本地联调

```bash
set DEEPSEEK_API_KEY=sk-xxxx
set BFF_USERS=demo=dev-token
node server.js
# 监听 http://127.0.0.1:8787
```

测试：

```bash
curl http://127.0.0.1:8787/health
curl -X POST http://127.0.0.1:8787/v1/chat/completions ^
  -H "Authorization: Bearer dev-token" -H "Content-Type: application/json" ^
  -d "{\"model\":\"deepseek-chat\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
```

## ECS 部署（i-m5eihcqadjdav7u2cqq9，cn-qingdao）

1. 把 `server.js` + `package.json` 放到 `/opt/bubaicode/bff/`；
2. 环境变量写 systemd unit：
   - `DEEPSEEK_API_KEY`（DeepSeek 官方）
   - `BFF_USERS`（`用户=token,用户=token`，签发 token 给客户端）
   - `PORT=8787`
3. 前面用 Nginx/Caddy 套 HTTPS，反代到 127.0.0.1:8787；
4. 客户端 config 里把 provider 切到 gateway，baseURL 指 `https://你的域名/v1`。

## 客户端侧

- `ai.provider = gateway`
- `ai.baseURL = https://你的域名`
- `ai.gatewayToken = 服务端签发的 token`

主进程 `main/index.js` 已支持 gateway 分支（`/api/chat/stream`，Bearer 鉴权，credits 事件透传）。

## 注意

- 本服务不跑模型，ECS CPU 实例即可；
- `DEEPSEEK_API_KEY` 只在服务端；
- 用量目前打印到 stdout + 内存，生产需落库/接计费；
- 上线前必须：① 挂 HTTPS；② 把 `BFF_USERS` 里的 demo token 换掉；③ 加 fallback（DeepSeek 故障时切 Qwen/GLM API）。
