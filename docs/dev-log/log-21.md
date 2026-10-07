修：check-ui-assets 的 asar 兜底分支是死代码

scripts/check-ui-assets.mjs 里 const { getFilesystemSync } = asar 取到的是 undefined
（@electron/asar 导出只有 listPackage / extractFile / statFile / extractAll 等，
没有 getFilesystemSync），结果 asarFiles 每次都静默 catch 成 null，
「文件只在 asar 内」这条分支从来没真正执行过，注释里写的「先问 asar 的文件系统表」是假的。

换成正确的 listPackage，并注意它返回的路径带前导斜杠（/out/main/index.js），
不带斜杠一个都匹配不上 —— 踩过一次。
现在能正确区分「落盘 ✓」/「只在 asar 内 △」/「压根不在包里 ✗」三种情况。
