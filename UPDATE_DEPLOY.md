# CodeLab 自动更新 · 上线部署指南

CodeLab 桌面端使用 **electron-updater（generic provider）** 做增量自动更新。上线只做两件事：**① 把更新产物放到一个可公网访问的静态服务器；② 把服务器地址告诉应用**。

---

## ✅ 当前部署状态（2026-09-03 HTTPS 已上线并验证）

| 项 | 值 |
|---|---|
| 更新服务器 | **阿里云 ECS**（青岛 cn-qingdao，`47.104.13.59`） |
| 实例 | `launch-advisor-20260812`（Alibaba Cloud Linux 4，包年包月至 2027-08） |
| 域名 | **bluebubai.work**（阿里云云解析，A 记录 → 47.104.13.59） |
| 服务方式 | 复用既有 HTTPS 站点（nginx 443 / HTTP2），新增 `/updates/` location |
| 站点根目录 | `/var/www/codelab-updates/` |
| **更新源 URL** | **`https://bluebubai.work/updates/`**（HTTPS 已启用，证书 Let's Encrypt 有效期至 2026-11-29） |
| 已发布版本 | 0.1.0、0.1.1、**0.1.2（HTTPS 首发）** |
| 验证结果 | `https://bluebubai.work/updates/latest.yml` → HTTP/2 200；应用真实请求 latest.yml（UA=electron-builder）返回 200 |

> ✅ **HTTPS 已完成**：证书为 Let's Encrypt（SAN 覆盖 bluebubai.work / www / app / app2），有效期至 2026-11-29，到期需续签（服务器 `/var/www/letsencrypt` 已配置 acme-challenge 目录）。旧 8088 HTTP 端口仍保留可用（内网/兜底），对外统一走 HTTPS。

---

## 一、更新产物是什么

每次 `npm run dist` 打包，`dist/` 目录会生成三样东西（这就是一次「发布单元」）：

| 文件 | 作用 |
|---|---|
| `CodeLab-Setup-<版本>.exe` | 完整安装包（增量更新时按需下载） |
| `CodeLab-Setup-<版本>.exe.blockmap` | 差量升级所需的块映射（已装老版本的用户只下差异部分） |
| `latest.yml` | 更新清单（版本 / sha512 / 大小），**应用检查更新的入口** |

> 三件必须**一起上传、保持同名同目录**。`latest.yml` 里的文件名路径是相对的，不能拆开放。

## 二、发布新版本的固定流程（每次发版）

```powershell
cd D:\工作\代码实验室\codelab-desktop

# 1) 改 package.json 的 version（如 0.1.3）
# 2) 打包
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run dist

# 3) 上传三件套（登录 ECS 用 root 密码，见 scripts/ssh-exec.js 顶部说明）
node scripts/sftp-upload.js 47.104.13.59 root "<密码>" "dist\latest.yml" "/var/www/codelab-updates/latest.yml"
node scripts/sftp-upload.js 47.104.13.59 root "<密码>" "dist\CodeLab-Setup-<版本>.exe.blockmap" "/var/www/codelab-updates/CodeLab-Setup-<版本>.exe.blockmap"
node scripts/sftp-upload.js 47.104.13.59 root "<密码>" "dist\CodeLab-Setup-<版本>.exe" "/var/www/codelab-updates/CodeLab-Setup-<版本>.exe"

# 4) 完成，老用户下次「检查更新」即可升级（走 HTTPS）
```

> 建议清理服务器上旧版 exe（保留最新 1~2 版），避免目录臃肿。

## 三、把更新源告诉应用（三选一）

### 方式 1（推荐，免改代码、免重打包）：运行时设置

```powershell
cd D:\工作\代码实验室\codelab-desktop
node scripts/set-update-url.js https://bluebubai.work/updates/
```

会写入 `%APPDATA%\codelab-desktop\settings.json`，应用下次「⟳ 检查更新」即生效。重置：

```powershell
node scripts/set-update-url.js --reset
```

### 方式 2：环境变量（临时/测试）

```powershell
$env:CODELAB_UPDATE_URL = "https://bluebubai.work/updates/"
CodeLab.exe
```

### 方式 3：打包内置默认值（长期固定，已配置）

当前 `package.json` 的 `build.publish` 已指向 HTTPS 更新源：

```json
"publish": [
  { "provider": "generic", "url": "https://bluebubai.work/updates/" }
]
```

> 优先级：**环境变量 > settings.json > 打包内置**。状态栏「⟳ 检查更新」按钮的悬浮提示会显示当前生效的更新源，方便核对。

## 四、服务器维护

### nginx 站点配置（/etc/nginx/conf.d/xinwang.conf，443 站点内新增 /updates/）

```nginx
# 既有 HTTPS 站点（listen 443，bluebubai.work 证书）内新增：
location /updates/ {
    alias /var/www/codelab-updates/;
    autoindex on;
    charset utf-8;
    location ~* \.(yml|yaml|json)$ {
        add_header Cache-Control "no-store";
    }
    location ~* \.(exe|blockmap|zip|deb|rpm|AppImage)$ {
        add_header Cache-Control "no-cache";
    }
}
```

- 80 端口对 `/updates/` 同样配置（HTTP 访问自动升级），其余请求 301 → HTTPS。
- 旧独立配置 `/etc/nginx/conf.d/codelab-updates.conf`（listen 8088）保留作兜底。

### 端口放行（已完成）

- HTTPS：443（既有站点已放行）；HTTP：80（既有）
- 8088 兜底端口：安全组 + firewalld 均已放行

### 证书到期轮换（⚠️ 2026-11-29 前必须完成）

> 当前 HTTPS 用的 Let's Encrypt 证书有效期至 **2026-11-29**，到期前需轮换，否则更新源 `https://bluebubai.work/updates/` 将失效（浏览器报证书错误，老用户无法自动更新）。

**证书现状**

| 证书 | 状态 | 用途 |
|---|---|---|
| Let's Encrypt（服务器 `/etc/nginx/ssl/bluebubai.work/`） | 在用，SAN 覆盖 bluebubai.work / www / app / app2，到期 **2026-11-29** | 当前 HTTPS 更新源 |
| 阿里云个人测试证书（实例 `cas_dv-cn-7ev4xydtt00t`，DigiCert DV 90 天） | 已下单 + DNS 自动验证通过，**备用待签发** | 到期轮换备胎 |

**轮换路线 A（推荐）：Let's Encrypt 自动续签**

服务器 `/var/www/letsencrypt` 已配置 acme-challenge 目录，到期前在服务器上续签即可：

```bash
# 1) 续签（certbot 会自动校验 acme-challenge 并替换证书）
sudo certbot renew --cert-name bluebubai.work

# 2) 重新加载 nginx 使新证书生效
sudo nginx -t && sudo systemctl reload nginx

# 3) 验证新证书有效期
sudo openssl x509 -enddate -noout -in /etc/nginx/ssl/bluebubai.work/fullchain.cer
# 应显示到期日期已顺延（约 90 天后）
```

**轮换路线 B（备用）：阿里云免费测试证书**

若 Let's Encrypt 续签失败，用已备好的阿里云个人测试证书（DigiCert DV 90 天，实例 `cas_dv-cn-7ev4xydtt00t`）：

1. 登录阿里云证书服务控制台 → 个人测试证书 → 对 `bluebubai.work` 完成申请签发（DNS 验证已通过，点「签发」即可）。
2. 下载签发后的证书，SFTP 上传替换服务器 `/etc/nginx/ssl/bluebubai.work/` 下的 `fullchain.cer` 与 `private.key`（先备份旧文件）。
3. `sudo nginx -t && sudo systemctl reload nginx`。
4. 浏览器访问 `https://bluebubai.work/updates/latest.yml` 确认锁 + HTTP/2 正常。

> 到期日提醒：建议在 **2026-11-15 前后**完成轮换，预留缓冲；可配合定时任务到点提醒。

### 常用运维脚本（scripts/）

| 脚本 | 用途 |
|---|---|
| `ssh-exec.js <ip> <user> <pass> "<命令>"` | 在 ECS 上执行命令 |
| `sftp-upload.js <ip> <user> <pass> <本地> <远端>` | 上传文件到 ECS |
| `set-update-url.js <url>` | 写入应用更新源 |
| `aliyun-ecs.js [region]` | 用 AccessKey 探测 ECS 实例信息 |
| `aliyun-rpc.js <Action> <region> <host> <k=v>...` | 通用阿里云 RPC API |
| `publish-update.js --to-dir/--scp` | 批量复制/上传三件套 |

## 五、验证是否上线成功

1. 浏览器打开 `https://bluebubai.work/updates/latest.yml`，应能直接看到 yaml 内容（HTTP/2，地址栏有锁）。
2. 打开 CodeLab → 状态栏点「⟳ 检查更新」→ 提示「正在检查更新…」→ 出现「已是最新版本」说明源连通。
3. 想验证真实升级：发布一个更高版本（bump version → 打包 → 上传），老版本应用点检查 → 应出现「发现新版本 → 下载 → 安装」。

---

**说明**：2026-09-03 已完成 HTTPS 全链路上线——0.1.2 三件套已上传，`https://bluebubai.work/updates/` 公网可访问（HTTP/2 200），应用端更新源已指向 HTTPS。证书为 Let's Encrypt，**到期 2026-11-29 前需续签**（acme-challenge 目录已就绪；阿里云个人测试证书 `cas_dv-cn-7ev4xydtt00t` 已备为轮换备用）。后续每次发版只需「bump version → 打包 → 上传三件套」；证书轮换见「四、服务器维护 → 证书到期轮换」。
