fix(plugins/zip/wiring): 修两处校验/解析误报 + 新增 5 个纯函数自检脚本

校验器 validate-manifest.ts：
- 修 scaffold 文件路径安全误报：原 `file.includes('..')` 把 `main..js` 这类正常文件名误判为路径穿越 → 改为按路径段判定（`file.split(/[\\/]/).includes('..')`），放行 `main..js`、仍拒 `../x`、`foo/../bar`
- 修 devicePanel 类型校验：原 `!dp || typeof dp !== 'object'` 因 JS 数组 typeof 也是 object，导致 `devicePanel: []` 漏报且报出误导性的 `devicePanel.id` 缺失 → 补 `Array.isArray(dp)`

接线图 wiringService.ts：
- 修 analyzeSketchPins 注释/字符串误报：原直接扫原始源码，注释（//、/* */）与字符串里的 `pinMode/digitalWrite` 被当成真实接线 → 增加 stripComments（与 pinConflict 同样严格，字符串内容填空保留长度），并抽 digitalPinToInterrupt 专用正则，修复 `attachInterrupt(digitalPinToInterrupt(5), …)` 嵌套调用导致引脚 5 漏检

自检脚本（纯函数 esbuild 转译 + node 真跑，对齐既有六件套）：
- scripts/check-zip.mjs（19）：零依赖解压器，store/deflate 往返、路径穿越防护、损坏/zip64/坏方法/长度不符/带注释/UTF-8 名/空包
- scripts/check-validate-manifest.mjs（44）：manifest 10 类校验全覆盖，含 main..js 误报与 devicePanel 数组回归
- scripts/check-wiring.mjs（22）：引脚角色、I2C/SPI/UART 外设识别、注释/字符串/变量不误报、Wire.begin 自定义引脚、SVG 产出、findMainSketch
- scripts/check-share-card.mjs（12）：XSS 转义、代码截断 1200、slug 清洗、accent/footer
- scripts/check-burn-history.mjs（23）：快照跳过 build/.git、回滚还原、超大文件/超多文件封顶、缺失处理、删除
- 自检脚本合计 11 个，约 200+ 断言；tsc node/web 双过
