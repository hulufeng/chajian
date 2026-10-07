fix(log): 修串口日志扫描两条正则 bug + 补全自检套件

纯函数 esbuild 转译 + node 真跑打法继续推进到日志解读与 SVD 解析。

- logExplainer.ts（2 个真 bug）
  - stack 规则里的 `\ATP`：JS 不支持 `\A` 会被当成字面量 `ATP`，任何含 "ATP" 的行都被误报成栈回溯
    （误报，踩中「误报比漏报更烦人」）。改为只保留 `stack trace` / 两相邻 8 位地址 / `at 0x`。
  - uart 规则末尾的 `\b` 跟在 `\r?\n` 后，导致行尾的 `OK`/`ERROR`（AT 指令响应）匹配不到（漏报）。去掉该 `\b`。

- scripts/check-log-explainer.mjs（新增，20 项全过）
  esbuild 插件把 ./aiGateway 与 electron 顶成 stub，node 真跑 scanLogFindings / explainSerialLog；
  覆盖各规则命中、行号(1-based)、空行跳过、单行只记一规则、去重、上限(40)、空日志报错、
  以及两条 bug 的回归断言（含 ATP 不误报 stack / 行尾 OK·ERROR 命中 uart）。

- scripts/check-svd.mjs（新增，31 项全过）
  esbuild alias 把 electron 顶成 stub（appData→临时目录），node 真跑 parseSvd/loadSvd/findRegister 全链路；
  覆盖 normalizeChip / suggestChipByFqbn / 外设·寄存器·位域·derivedFrom 继承·数组寄存器 / looksLikeSvd 损坏判定 /
  缺失报错 / findRegister 前缀拆解(GPIO_OUT_REG→GPIO.OUT) / hex / formatRegister 位域区间。
  注：svdService 解析核心经此全链路验证无 bug，该脚本作回归护栏。

验证：6 个自检脚本全过（board 33 / diag 57 / pin 22 / partition 19 / svd 31 / log 20），tsc node/web 双过。
