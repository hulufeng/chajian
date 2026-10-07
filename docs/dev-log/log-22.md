修：板卡搜索卡主线程 / 早退不改状态留假成功 / 端口不跟热插拔

1) DevicePanel 板卡搜索每击键起一次 arduino-cli 子进程（真卡顿）
   board.search 链路：board:list → toolchain.boardSearch → searchBoards → listBoards →
   **spawnSync(arduino-cli board listall --format json, timeout 20000, 输出 1MB+)**。
   同步阻塞主进程，而主进程一卡渲染层 IPC 就回不来 —— 敲 "esp32" 发 5 次，
   整个 IDE 输入掉帧。改 300ms 防抖。
   )

2) 顺带修乱序覆盖：并发请求谁先回来谁 setBoards，
   慢的旧请求（"esp"）会覆盖掉新的（"esp32"），列表莫名少一条。
   加请求序号，只认最后一次发出的。卸载时清掉待触发的防抖定时器。

3) DevicePanel Fragment 缺 key
   board 选择器 return 的是 <>...</>，key 却挂在里面那层 div 上；
   React 校验的是 map 直接返回值的 key，每次渲染刷一条 key 警告。改 <Fragment key={sel.id}>。

4) App 编译/烧录早退路径不复位 compileState（显示假成功）
   runCompile 的 !fqbn、runUpload 的 !toolchain / !selectedPort 三条早退只写了日志就 return，
   compileState 还是上一次的 'success' —— 状态栏继续显示「编译完成」+ 上一版的 Flash/RAM 用量卡，
   而这一趟一次都没跑。比直接报错更容易骗人。三条路径统一 setCompileState('error') 并清掉耗时/错误。
   （!resolved 那条本来就有，保持一致。）

5) TargetPanel 端口不跟热插拔，拔板后残留
   selPort 只在首次为空时赋值（load 里 `prev || port || p[0]?.path`），又没订阅 onPortsChanged：
   板子拔了下拉还留着那个已消失的端口，点烧录就是对着不存在的 COM 口发命令；插新板也不补。
   更糟的是 DevicePanel 那边会清成空，同一块信息两块面板一个留一个清，直接自相矛盾。
   补 onPortsChanged 订阅：刷新列表 + 选中端口不在新列表里就清空。
