修：打包后工具链内置页可达性闭环 + 修 copy 脚本两处坑

1) asarUnpack  Regression（高危）
   package.json 里 asarUnpack 曾整体被换成只有 "**/plugins/**"，
   等于把 node-pty / serialport / @serialport 的 .node 原生模块塞回 asar，
   生产包串口与终端会一起挂。恢复四条原生模块模式，再追加 **/plugins/**。

2) toolchain:ui-url 候选根补上打包后唯一有效的一处
   asarUnpack('**/plugins/**') 之后 UI 落盘在
   resources/app.asar.unpacked/out/main/plugins/arduino-toolchain/ui/*.html
   旧候选（resources 根 / app.asar 内 / resources/out/main）三个都判存落空。

3) copy-runtime-assets.mjs
   - 移除 src/main/proto 死路径：该路径在仓库里从不存在（git ls-files 为 0），
     proto 由 extraResources 发到 resources/proto，不需要进 out/main；
     留着只会打印「跳过」误导成漏拷。
   - fs.cpSync 改成 readFileSync+writeFileSync：目标是上次构建同名文件时
     cpSync 走 unlink 重名处理，在本环境（中文路径 + fs shim）会抛
     errno 0 / "The operation completed successfully" 的假错误。改后幂等可重跑。

4) 新增 scripts/check-ui-assets.mjs
   对真实安装包自检三页内置 UI 是否在包内、能否拼出 file:// 落盘路径，
   候选根与 handler 保持一致；之前靠人肉开安装包点三个 tab 验，回归必漏。
