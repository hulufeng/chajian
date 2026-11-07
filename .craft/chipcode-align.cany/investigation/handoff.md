# Handoff

【功能 4 Git 冲突：更正 + 落地】
- 更正 fnd_14（错误结论）：LabCode **并非**完全没有冲突处理。main/index.js @1343 早已存在完整 `git:aiResolveConflicts` 后端（扫描 U* 状态、正则逐块解析 ours/theirs、每块调 `callAiOnce` 合并、写回并 `git add` 暂存）。真正缺口是**呈现层**：缺 `git:listConflicts` 列表 IPC、git 面板没有 ChipCode 那样的冲突区块（逐文件列出 + 逐文件「AI 合并」）。详见 fnd_15（revision 27）。
- 本轮回填落地：① main 新增 `git:listConflicts`（U* 状态 + 读磁盘数 `^<<<<<<< ` 块数）；② `git:aiResolveConflicts` 加 `onlyRel` 单文件参数；③ preload 暴露 `git.listConflicts`；④ renderer 新增 `#git-conflicts` 区块（标题『N 个文件存在合并冲突』+ 每行『文件·N处』+『AI 合并』按钮，点击调 `git.aiResolveConflicts(cwd,path)` 后刷新）。
- CDP 实机验证全通过：构造真实 merge 冲突仓库（MERGE_HEAD + UU a.txt）→ 区块显示 1 文件 + 按钮 → 点击后 a.txt 由 UU 变已暂存 M、`listConflicts` 返回空、区块隐藏，全程无 JS 异常。callAiOnce 走 main 进程 AI，本例真实生效。

【已完成功能清单（证据驱动）】
1) 搜索代码符号：bundle @473960 + i18n ai.symbolSearch.* 仿写 debounce(250ms)/竞态序号/空输入空列表/limit30/五态/inline 浮层(宽540 top52 遮罩z90)/跳转前读文件；架构差异 tree-sitter 保留 unk_831150…。
2) 欢迎页/最近打开：bundle @500186 i.slice(0,5) 与 @505482 file.recentMissing 仿写前5项 + fs.exists 失效检测 + 自动移除。
3) 产品工厂五阶段：main 早已等价(computeStages/buildPackage/fingerprint+packageStale); 本轮补 pf-export 点击行为(已生成→shell:showItemInFolder 打开 hardware-package，未生成→api.package 导出)+ 修 preload 重复 shell 键覆盖隐患。三态+stale高亮+文件数徽标 CDP 验证通过。
4) Git 进行中操作：main 仿写 detectPendingOp(6标记)/finishOp(continue/abort) + renderGitPendingOp 横幅；真实冲突仓库验证 git merge --abort 生效。
5) 提交信息生成：main git:status 补 x/y/staged 保留暂存位；renderer 前置检查无暂存拦截 + 生成中禁用态；有暂存时真实 AI 生成写入提交框。
6) Git 冲突区块 + 逐文件 AI 合并：见上「功能 4 更正 + 落地」。
源码提交至 c51c519(功能3) / 7490eda(功能4/5) / 本功能待提交。交接文档 §14.12/§14.13/§14.14。H1 supported、fnd_1..15、unk_831150…、handoff 在 .craft/chipcode-align.cany。中文 Git i18n 全量 D:/work/tmp/ca_git_i18n_zh.txt(420 条/20 组)。

【下一轮功能顺序】git 剩余(review/rejectHunk/remoteStatus/probe/pullRebase 等，issues:list 见 fnd_16、pr:create 见 fnd_17)、ai(40 通道，子代理确认多数已等价)、plugins(10)、board+core+lib(15)、devicePanel(3)、settings 分组、schedule(16)、agents(12)。每个功能：node D:/work/tmp/ca_locate.mjs 定位 renderer → node D:/work/tmp/ca_main_locate.mjs 看主进程 → 写差异表 → 仿写 → 复制 asar 镜像 → 部署 → CDP 验证 → core-finding-record。

【陷阱】
- craft-anything MCP 自检超时，用 CLI 绝对路径(--deep --project)，--json 写文件 @路径。
- ChipCode Vite React minified 非混淆；LabCode app.js 普通脚本顶层 const 全局共享，重复 const 整文件 SyntaxError，改完 node --check 源与镜像双份。
- preload 同一 exposeInMainWorld 对象内重复同名键会静默覆盖(功能3踩过)，新增 API 后必须 CDP 验证 window.LabCode.x.y 存在。
- asar 注入需同步复制 main/preload(不只 renderer)；部署后实例通常不带端口，验证需 Stop-Process 带 --remote-debugging-port=9223 重启。
- window.LabCode.* 是 contextBridge 只读对象，CDP stub 其方法静默失败。
- CDP 验证脚本：Runtime.evaluate 对返回 Promise 的表达式必须加 awaitPromise:true，否则拿到 {}；渲染进程同步 require('fs') 偶发失败，读文件改走 IPC 或 fs 异步。
- 原生选择文件夹对话框输入路径两次 Return；换前台窗口先 focus_window 再 type_text；不要改 ChipCode 安装版；不记录账号密钥。

【剩余 unknown】unk_831150…：是否补 tree-sitter 持久符号索引(评估 indexer-worker.js 依赖与大型项目耗时)。
