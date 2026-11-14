// 聚合回归验证入口：npm test → node scripts/verify-all.cjs
// 自动发现 scripts/verify-*.cjs（node:test / IPC 契约检查），并纳入 theme-probe.mjs 与 wf_logic_test.js。
// 零第三方依赖、跨平台（不用 shell 通配符）；任一脚本失败即以非零退出码结束。
// --legacy 额外运行 scripts/wf_integration_test.js（已知失效，见该文件头部说明），仅用于排查。
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const root = path.join(dir, '..');
const discovered = fs.readdirSync(dir)
  .filter((f) => /^verify-.*\.cjs$/.test(f) && f !== 'verify-all.cjs')
  .sort();
const extras = ['theme-probe.mjs', 'wf_logic_test.js'].filter((f) => fs.existsSync(path.join(dir, f)));
const files = [...extras, ...discovered];

if (process.argv.includes('--legacy')) {
  if (fs.existsSync(path.join(dir, 'wf_integration_test.js'))) files.push('wf_integration_test.js');
}

let failed = 0;
let totalTests = 0;
const rows = [];

for (const f of files) {
  const r = spawnSync(process.execPath, [path.join(dir, f)], {
    encoding: 'utf8', cwd: root, timeout: 120000
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const ok = r.status === 0;
  if (!ok) failed++;
  const p = out.match(/ℹ pass (\d+)/);
  if (p) totalTests += Number(p[1]);
  rows.push({ f, ok, detail: p ? `${p[1]} tests` : (ok ? 'ok' : `exit=${r.status}${r.error ? ' ' + r.error.message : ''}`) });
  if (!ok) {
    console.log(`\n----- ${f} 失败输出（尾部） -----`);
    console.log(out.split('\n').slice(-15).join('\n'));
  }
}

const pad = Math.max(...rows.map((x) => x.f.length)) + 2;
console.log('\n=== BubaiCode 回归验证 ===');
for (const x of rows) {
  console.log(`${x.ok ? 'PASS' : 'FAIL'}  ${x.f.padEnd(pad)} ${x.detail}`);
}
console.log('─'.repeat(pad + 20));
console.log(`脚本 ${files.length} 个：${files.length - failed} 通过 / ${failed} 失败` + (totalTests ? `，断言 ${totalTests} 项` : ''));
if (process.argv.includes('--legacy')) {
  console.log('注意：--legacy 的 wf_integration_test.js 为已知失效的历史测试，不计入默认 npm test。');
}
process.exit(failed ? 1 : 0);
