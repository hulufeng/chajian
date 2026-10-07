fix(scan): 新增 JSON.parse 未兜住扫描器 scripts/scan-json-parse.mjs

AST 扫描全仓 JSON.parse（按 PropertyAccessExpression 识别 JSON.parse，而非误判成 Identifier），
标记未处于任何 TryStatement 词法作用域内的解析——外部数据（localStorage / IPC / 下载清单）损坏时
会抛未捕获异常。

验证：造临时 _scan_jsontest.tsx（未兜住的外部解析 + try 内解析 + 信任常量），确认精确命中前两者、
排除 try 内那条；删除临时文件后重跑真实代码库，仅 1 处 pluginInstaller.ts:86 命中，但调用方
loadCatalog 已用 try/catch 兜住（回退内置清单），属已知安全模式，无需改代码。
tsc node/web 双过。
