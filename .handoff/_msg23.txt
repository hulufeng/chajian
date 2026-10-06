修：流式日志无上限+全量重渲染 / 取消后假报错 / 界面显示≠实际生效（3 处）

按 code-review 双轴（Fowler 12 类坏味道 + 本项目规范）评审渲染层查出并修掉：

性能（long session 掉帧 / OOM 根因）
- 输出面板与串口监视器两条日志只增不减：编译 gRPC 每几十毫秒一个 chunk，
  串口 115200 baud 每秒上百个，每个 chunk 都 setState —— App 顶层 state 一动
  整棵子树（Monaco / xterm）重算，OutputPanel 全量重渲染、SerialPlotter canvas
  全量重画。改：ref 作唯一事实源 + 20 万字符上限截断；输出面板未挂载时完全
  不碰 state（省下整树重算）；流式 chunk 120ms 节流合并；订阅卸载清定时器。

正确性
- cancelBuild 没清 180s/120s 兜底定时器：点「取消」后 180s 仍会追加一条
  「编译超过 180s 无响应」假错误。改为一并 clearTimeout。
- 关项目只清 tab 不清 burnCtxRef / serialOpen：下次烧录收尾会把上个项目的
  日志尾巴记到新项目上，恢复串口也会对着已关路径去 open。
- AiPanel newChat 不复位 busy、按钮没 disabled：agent 运行时点「新建对话」
  等于截对话 + 按钮永久 disabled 假死。
- 设置页 SVD 下拉显示取 svdPick、下载取 svdImportChip：knownChips 不含
  esp32s3 时界面显示 A、实际下载 B（同一个坑只修一半等于没修）。
- onClose 在 setTabs 的 updater 里调 setActivePath：updater 必须是纯函数，
  StrictMode 双调用会切到错误 tab。
- DevicePanel 板卡选项写盘用渲染期 optionValues 快照：同一 tick 连改两项，
  第二项会把第一项从 localStorage 抹掉。
- TitleBar logo 6 个 hex 字面量：深色主题下黑描边压深底等于消失；改走
  var(--token)（SVG 表现属性不认 var()，必须写进 style 对象）。
