修：板卡反查认不出 USB ID（0x 前缀靠巧合）/ 共用 VID:PID 被误报成 S3

新增 scripts/check-board-registry.mjs（esbuild 转译 boardRegistry.ts 后跑真单测，
把「板卡唯一数据源」的映射/唯一性/收录门槛钉成回归护栏）。跑它的时候炸出两个真 bug：

1) targetForUsbId 只做 trim + toLowerCase 全串比，表里写的是 '0x303a:0x1001'（带 0x），
   传 '303A:1001' 必然 undefined。target:detect 恰好拼成带 0x 的形式才没炸 —— 纯属
   巧合，任何新调用方按「VID:PID 就是 303A:1001」写都会静默认不到板。
   加 normalizeUsbId()：把 303A:1001 / 0x303a:0x1001 / 0x303a:1001 全压成
   '303a:1001'（0x 可省、大小写不敏感、冒号可省）再比对，写法差异不再等于认得到/认不到。
   裸值按十六进制解释，与 arduino-cli / serialport 的惯例一致。

2) ESP32-S3 / C3 / P4 三块板的原生 USB 都是 303a:1001（Espressif USB JTAG/serial 就这
   一个 VID:PID，硬件事实），原来线性 find 只会命中第一条 → 插 C3 / P4 在界面上被认成
   S3。加 targetsForUsbId() 返回全部候选，target:detect 多吐一个 candidateIds 让 UI /
   Agent 看得到"还没认准"，Agent 的 detect 也会明写"该 VID:PID 与 N 块板共用"，
   不再拿第一条结果当定论去选板。targetForUsbId 保留（取候选第一条）只作兼容出口。

顺带修测试自身三处写错的前提：s3.options（表里没这个字段）、debugLink（真实字段是
debug.link / debug.cfg）、STM32 没有 fqbn 却被算进 FQBN 唯一性比较；并把记忆里
「17 款板卡」纠正为代码实际的 10 款（ESP32 5 + STM32 5）当下限护栏。
P4 有意只有 PlatformIO 路径、svdChip:null（板上注释：P4 无 arduino-cli 官方 core），
属收录门槛允许的合法情况，检查改成"多数 ESP32 有 FQBN + P4 除外要有 SVD"。

验证：node scripts/check-board-registry.mjs → 33 项全过；tsc node / tsc web 均 0；
electron-vite build 通过。
