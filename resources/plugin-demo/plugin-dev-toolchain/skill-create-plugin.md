# 技能：创建插件（Skill「创建插件」引导流程）

> 本文件是 `plugin-dev-toolchain` 插件的 `skills[].prompt` 引用内容。引导 AI 从零生成一个 codelab 插件。
> 流程与 TrieCode 的「创建插件」Skill 对标，但把 **transport 选择**写进引导，并强调我方差异化通道 `mqtt`。

## 端到端流程

1. **问清需求**：这个插件要解决什么嵌入式 / 软硬件问题？面向 Agent 暴露哪些能力？是否需要 UI（devicePanel / view）？
2. **定基础信息**：拿到 `id`(kebab-case)、`displayName`、作者。先 `plugin-dev.create` 生成骨架。
3. **选 transport（关键一步）**——根据能力性质选主通道：
   - `cli`：有现成命令行工具要包一层（arduino-cli / esptool / openocd）。命令数组 + 参数占位符 `{argName}`/`{defaultPort}`/`{defaultFQBN}`。
   - `internal`：复用宿主已有能力（串口 / 编译 / 插件开发 `pluginDev`）。绑定 `{service, method}`。
   - `http`：后端是远程服务。绑定 `url`。
   - `grpc`：后端是 gRPC 服务（如 arduino-cli daemon）。绑定 `{service, method}`。
   - `mcp`：能力已由某个 MCP 服务器提供。绑定 `{server, tool}`。
   - `backend`：插件自己带重执行后端（进程 / stdio JSON-RPC / grpc）。绑定 `{backendId, method}`。
   - `mqtt`：**我方差异化**，命中设备遥测回流 / 长任务状态 / 多智能体协同。绑定 `{server, op}`。
4. **create**：调用 `plugin-dev.create`，入参 `id / name / displayName / transport / author / outDir`，生成 `plugin.json` + `index.js`。
5. **完善 manifest**：补全 `description`、`capabilities`、`settings`（密钥一律走 `{settings.*}` 占位符，不硬编码）、必要时加 `devicePanel` / `views`。
6. **validate**：调用 `plugin-dev.validate` 校验 `plugin.json`（复用宿主 `app.validateManifest` 口径）。有错就改到通过。
7. **问用户是否安装**：用 `ask_user`（type=yesno）确认「是否把这个插件安装到本机」。用户同意后进入下一步。
8. **install**：调用 `plugin-dev.install`，把本地目录落盘 `userData/plugins/<id>` 并热加载。
9. **问是否启用**：确认插件命令已出现在可调用清单（如 `plugin list` / 命令面板），再交给用户正式使用。

## 自检清单（交付前）

- [ ] `plugin.json` 通过 `plugin-dev.validate`（零错误）
- [ ] 每个 `tools[].transport` 的绑定字段齐全（cli 有 command、http 有 url、internal 有 service+method…）
- [ ] 密钥只用 `{settings.*}` 占位符，仓库不含生产密钥
- [ ] 插件自包含：无跨插件 `require('../')`、无 `require` 宿主模块
- [ ] `channels` 声明的命令都在 `index.js` 的 `load()` 里 `register` 了
