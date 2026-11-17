# codelab-site 官网后台服务端

零运行时依赖的 Node ESM 服务，**同时为官网做静态托管 + 提供后台 API**：
官方插件市场、联系表单、内容块、版本信息、下载计数、以及一套管理后台（登录 / 插件上架 / 联系留言 / 内容管理 / 下载统计 / 版本设置）。

数据默认落 `./data/db.json`（开发/演示用，生产请换正式数据库）。

## 启动

```bash
cd codelab-site/server
node server.mjs                 # 默认端口 8788，静态根 = 上级目录(codelab-site)
PORT=9000 node server.mjs
```

启动后控制台打印：
- 官网首页：`http://127.0.0.1:8788/`
- 管理后台：`http://127.0.0.1:8788/admin/`
- 默认管理员：`admin@bubaicode.dev` / `admin123`（**生产务必用 `SITE_ADMIN_PASSWORD` 改掉**）

客户端（官网前端）默认直接连同源的 `/api/*`；若后台与官网分离部署，前端把请求前缀指向本服务即可。

## 接口一览

### 公开（无需登录）
| 方法 | 路径 | 说明 |
|------|------|------|
| GET  | `/api/plugins` | 已上架插件列表（官网插件市场消费） |
| GET  | `/api/plugins/:id` | 插件详情 |
| POST | `/api/plugins/:id/install` | 记录一次「安装」意向（计数） |
| GET  | `/api/version` | 最新版本号 + 更新说明 |
| GET  | `/api/content/:key` | 读取内容块（官网可嵌入） |
| GET  | `/api/downloads` | 下载总次数 + 各平台（轻量） |
| POST | `/api/contact` | 提交联系留言 `{name?,email?,message}` |

### 下载计数重定向
| 方法 | 路径 | 说明 |
|------|------|------|
| GET  | `/d/windows` `/d/macos` `/d/linux` | 记录一次下载并 302 跳转真实安装包（可用 `DOWNLOAD_URL_*` 覆盖目标） |

### 管理员（需 `Authorization: Bearer <token>`）
| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/admin/login` | `{email,password}` → `{token,user}` |
| POST | `/api/admin/logout` | 注销当前 token |
| GET  | `/api/admin/overview` | 仪表盘概览指标 |
| GET/POST | `/api/admin/plugins` | 列出全部 / 新增插件 |
| PUT/DELETE | `/api/admin/plugins/:id` | 更新 / 删除插件 |
| GET  | `/api/admin/contacts` | 留言列表 |
| POST/DELETE | `/api/admin/contacts/:id` | 标已读 / 删除留言 |
| GET/POST | `/api/admin/content` | 内容块列表 / 新增 |
| PUT/DELETE | `/api/admin/content/:key` | 更新 / 删除内容块 |
| PUT  | `/api/admin/version` | 设置最新版本 |
| GET  | `/api/admin/downloads` | 下载统计（按平台 / 版本 / 最近） |

## 环境变量
| 变量 | 默认 | 说明 |
|------|------|------|
| `PORT` | `8788` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址 |
| `SITE_ADMIN_EMAIL` | `admin@bubaicode.dev` | 管理员邮箱 |
| `SITE_ADMIN_PASSWORD` | `admin123` | 管理员密码（**生产必改**） |
| `SITE_DATA_DIR` | `./data` | 数据目录（自检时指向临时目录） |
| `DOWNLOAD_URL_WINDOWS` / `_MACOS` / `_LINUX` | bluebubai.work | 各平台安装包真实地址 |

## 前端对接点（已在仓库内接好）
- `index.html:811` 的 `loadPlugins()` 已改为 `fetch('/api/plugins')`，失败时回退到静态兜底数据。
- `plugins.html` 同样动态拉取 `/api/plugins` 并渲染，点击「安装」会 `POST /api/plugins/:id/install` 计数。
- `download.html` 的 Windows 下载按钮指向 `/d/windows`（计数后跳转），版本徽标读 `/api/version`。
- `index.html` 新增联系表单，`POST /api/contact`。
- 各页导航已含「管理后台」入口 `/admin/`。

## 验证
```bash
node codelab-site/server/check-site-server.mjs   # 起真实服务打全接口，37 项断言
```

## 安全提示
- 这是**开发/演示**后端：密码 scrypt 哈希、token 随机 UUID，但数据存本地明文 JSON，无频率限制/防爆破，且 `/server/` 目录已被禁止静态托管（防源码与 `db.json` 泄露）。**生产环境请替换为正式鉴权 + 数据库，并启用 HTTPS**。
