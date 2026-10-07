修：引脚检测把注释里的调用当真代码（误报比漏报更烦人）

新增 scripts/check-pin-conflict.mjs：pinConflict 会真实扫目录，所以用临时工程做夹具
（mkdtemp 写 .ino，跑完 rmSync），22 项断言盯项目原则「不猜、不编造引脚号」。一跑炸出真 bug：

**注释没剥离 → 误报。**
walkSources 之后直接拿原始行去匹配 FN_PATTERNS，行首 `//` / `/*` 的行虽然会跳过，
但下面这些照样被当成真代码：
- 跨行块注释：`/*` 单独一行时，调用写在下一行（那行不以 /* 开头），会被当真代码 →
  报「GPIO9 是内部 flash 保留脚 / 被 USB-JTAG 占用」，而用户压根没写这行。
- 行内块注释夹在真代码中间：`pinMode(9, OUTPUT); /* 板载 LED 脚 */` 这种写法同样漏网。

误报比漏报更烦人 —— 用户照着一条"你踩了 strapping 脚"的警告去改，改完发现警告还在，
只有删代码才消失，基本等于把这个功能的可信度打没了。

改：加 stripComments(lines)，在扫之前把注释抹掉（行尾 `//`、块注释 `/*…*/`、跨行块注释），
带字符串/转义字符识别（`"a//b"` 里的 // 不当注释，抹成空格而不是删掉）。
collectMacros 也走剥注释后的行（`#define X 2 // LED` 这种以前宏值会带注释尾巴解析失败）。

测试同时加了一条**反向断言**锁死边界：剥注释不能把真代码一起吃掉 ——
`digitalWrite(2, HIGH); // 点亮 LED` 里调用是真的，GPIO2 是 ESP32 strapping 脚，警告必须照报；
另一条 `// digitalWrite(2, HIGH);`（整行注释掉）则不许再报。

验证：node scripts/check-pin-conflict.mjs → 22 项全过（改之前挂 3 项）；
check-build-diagnostics 57 项 / check-board-registry 33 项复跑仍全过；tsc node 0；build 通过。
