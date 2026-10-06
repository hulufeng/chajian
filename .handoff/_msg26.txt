修：编译诊断三处真 bug（已知提示永远认不出 / 工具链缺失规则是死规则 / 光标行着色）

新增 scripts/check-build-diagnostics.mjs：build-diagnostics 是零依赖纯函数，
用 esbuild 转译后直接在 node 里跑真单测（57 项），盯项目三条硬规则——
只有 error/fatal error 阻断编译、warning 永不进 errors、note/#pragma/上下文永不进 errors。
一跑就炸出三个真 bug，都是"能编译、能打包、表面上完全正常"的类型：

1) KNOWN_NOTES 永远匹配不到（特性等于没做）。
   ESP32 蓝牙栈那行 `BT: forcing BR/EDR max sync conn eff to 1` 没有 `file:line: note:`
   前缀也不是 #pragma，classifyOutputLine 判成 plain 直接被丢掉，
   而 knownNotes 只在 kind==='note'|'context' 的分支里填 → 「已知平台提示，可忽略」
   从未命中过。改：在 plain 丢弃前先接住 KNOWN_NOTES，命中就当提示收集。

2) toolchain_missing 是死规则。原写法
   `(arduino-cli|...-elf-gcc)[^:\n]*(not found|command not found)`，
   `[^:\n]*` 跨不过工具名后那个冒号 → 真实输出 `xtensa-esp32-elf-gcc: command not found`
   （以及 sh 那条链 `sh: 1: xtensa-esp32-elf-gcc: not found`）全都漏判。
   改：`:?\s*` 让冒号与空白可选。

3) gcc 代码框的纯光标行 `     |     ^~~~~~` 落 plain（默认色）而不是「提示灰」。
   它前面没有数字行前缀，原 context 规则（要求 `from|\d+\|` 且含 ^）吃不到。
   补一条 `^[\s|~^.:+\-*]*\^[\s^~.:+\-*|]*$` → context；放在 error/warning/note 判定之后，
   不可能抢走真正的诊断行。

顺带把 3 处测试输入改成真实工具链形态（原来写成 "failed to connect; aborting"、
"Error during build: Unknown FQBN" 这类工具根本不打的东西），
并加了两条新断言：esptool 只打 `Failed to connect` 也算 flash_error、
arduino-cli 建壳噪声行不产生第二条错误。

验证：node scripts/check-build-diagnostics.mjs → 57 项全过；tsc node 0；build 通过。
