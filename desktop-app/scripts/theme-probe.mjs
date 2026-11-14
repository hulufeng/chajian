// BubaiCode JS 应用主题探针
// 解析 desktop-app/renderer/css/style.css 的 :root(暗) 与 [data-theme="light"](亮)，
// 解析 var() 链，核对是否全量对齐参考基线 v1.3.1 的目标数值。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cssPath = join(__dirname, '..', 'renderer', 'css', 'style.css');
const css = readFileSync(cssPath, 'utf8');

function extractBlock(re) {
  const m = css.match(re);
  if (!m) return {};
  const body = m[1];
  const map = {};
  const decl = /(--[\w-]+)\s*:\s*([^;]+);/g;
  let d;
  while ((d = decl.exec(body))) {
    map[d[1].trim()] = d[2].trim();
  }
  return map;
}

const root = extractBlock(/:root\s*\{([^}]*)\}/);
const lightRaw = extractBlock(/\[data-theme="light"\]\s*\{([^}]*)\}/);
const light = { ...root, ...lightRaw };

function resolve(name, ctx, seen = new Set()) {
  if (seen.has(name)) return null;
  seen.add(name);
  const raw = ctx[name];
  if (raw == null) return null;
  const m = raw.match(/var\((--[\w-]+)(?:,\s*([^)]+))?\)/);
  if (m) {
    const ref = m[1];
    const fb = m[2];
    const v = resolve(ref, ctx, seen);
    return v != null ? v : (fb != null ? fb.trim() : null);
  }
  return raw;
}

const norm = (v) => (v ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

// 参考基线 v1.3.1 目标数值（明暗两套）
const expected = {
  dark: {
    '--accent': '#3b82f6',
    '--surface-0': '#0d1117',
    '--surface-1': '#131820',
    '--surface-2': '#1a212b',
    '--surface-3': '#232c38',
    '--toolbar-height': '36px',
    '--text': '#e6edf3',
    '--border': '#2b333d',
  },
  light: {
    '--accent': '#2563eb',
    '--surface-0': '#f5f6f8',
    '--surface-1': '#ffffff',
    '--surface-2': '#f0f1f3',
    '--surface-3': '#e9ebef',
    '--toolbar-height': '36px',
    '--text': '#2b2f36',
    '--border': '#e2e5ea',
  },
};

const aliasTokens = [
  '--accent', '--surface-0', '--surface-1', '--surface-2', '--surface-3',
  '--toolbar-height', '--text', '--border', '--bg-active', '--border-color',
];

let ok = true;

for (const theme of ['dark', 'light']) {
  const ctx = theme === 'dark' ? root : light;
  const exp = expected[theme];
  console.log(`\n=== ${theme.toUpperCase()} (比对 BubaiCode v1.3.1) ===`);
  for (const [token, want] of Object.entries(exp)) {
    const got = norm(resolve(token, ctx));
    const pass = got === want;
    if (!pass) ok = false;
    console.log(`  ${pass ? '✓' : '✗'} ${token.padEnd(16)} got=${got.padEnd(12)} want=${want}`);
  }
  // 别名必须存在且可解析（含补齐的 --bg-active / --border-color）
  for (const a of aliasTokens) {
    if (resolve(a, ctx) == null) {
      console.error(`  [FAIL] ${a} 在 ${theme} 主题下缺失或无法解析`);
      ok = false;
    }
  }
}

if (ok) {
  console.log('\n[PASS] JS 应用主题已全量对齐 BubaiCode v1.3.1（明暗数值一致，缺失 token 已补齐）。');
  process.exit(0);
} else {
  console.error('\n[FAIL] 存在与 BubaiCode 不一致的 token。');
  process.exit(1);
}
