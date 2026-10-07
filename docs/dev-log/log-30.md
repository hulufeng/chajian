chore: 清理零引用死代码（Toolbar 旧工具栏 + simulator 虚拟运行时）

这两个模块经全仓检索确认零引用（无其他文件 import / 动态加载），属遗留死代码：
- src/renderer/src/components/Toolbar.tsx：被「工具栏三段」新方案取代，已不再渲染。
- src/renderer/src/simulator/：未接线的虚拟外设/运行时（GPIO/I2C/PWM/UART/ADC + transpiler），当前无入口。

均为已跟踪文件，git 可一键还原；tsc node/web 双过验证无编译断裂。

另：3 个未跟踪的过时备份（_burnsim.js / _sim / out_bak_b19）已按项目约定搬到
D:\work\_cleanup-codelab-desktop-20261006（同盘 rename，可恢复），让仓库 git status 归零，
待确认后再永久删除。
