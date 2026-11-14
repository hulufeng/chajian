// 网关模型选择回归（2026-11-14「付费模型被静默降级」修复）
// 背景：旧实现把 GW_AVAILABLE_MODELS 硬编码成 ['qwen3-8b']，normalizeGwModel 把任何
// 其它模型（含用户显式选的 DeepSeek PRO）静默替换成 qwen3-8b，返回体 model 却是 qwen3-8b，
// 用户以为在用付费模型。现改为 /api/models 动态池 + 显式拒绝 + 矫正告警。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAIN = fs.readFileSync(path.join(__dirname, '..', 'main', 'index.js'), 'utf8');

test('不再硬编码单模型白名单，改用动态池 + 兜底', () => {
  assert.ok(!/const GW_AVAILABLE_MODELS\s*=\s*\['qwen3-8b'\]/.test(MAIN), '旧硬编码白名单应移除');
  assert.match(MAIN, /GW_FALLBACK_MODEL\s*=\s*'qwen3-8b'/, '需保留兜底模型');
  assert.match(MAIN, /gwModelPool/, '需有模型池缓存');
  assert.match(MAIN, /GW_MODEL_POOL_TTL/, '缓存需有 TTL');
  assert.match(MAIN, /\/api\/models/, '池需从网关 /api/models 拉取');
  assert.match(MAIN, /available\s*===\s*true|available:\s*m\.available/, '需按 available 字段过滤');
});

test('显式指定的不可用模型返回明确错误，不再静默降级', () => {
  assert.match(MAIN, /async function checkExplicitGwModel/, '需有显式校验函数');
  assert.match(MAIN, /unavailableModel/, '错误需带不可用模型 id');
  assert.match(MAIN, /availableModels/, '错误需告知可用模型列表');
  assert.match(MAIN, /当前未开放/, '错误文案需明确说明模型未开放');
  assert.match(MAIN, /if \(model\) \{[\s\S]{0,300}checkExplicitGwModel/, '非流式分支需接入');
  assert.match(MAIN, /throw new Error\(rejected\.error\)/, '流式分支需抛错走 ai:stream error 事件');
});

test('配置残留仍走矫正且留下可观测告警，避免 404 无响应', () => {
  assert.match(MAIN, /normalizeGwModel/, '需保留同步矫正');
  const warnings = (MAIN.match(/console\.warn\(`\[(?:ai:chat|chatStream)\][\s\S]{0,120}已改用/g) || []).length;
  assert.equal(warnings, 2, '非流式与流式两条路径都要有降级告警');
});

test('gatewayModels 刷新池缓存，保证主流程与 UI 使用同一份数据', () => {
  assert.match(MAIN, /gwModelPool\s*=\s*\{[\s\S]{0,400}at:\s*Date\.now\(\),\s*ok:\s*true/, 'gatewayModels 处需写缓存');
});

test('动态池行为模拟：可用模型直用 / 不可用模型拒绝 / 未知 id 矫正', () => {
  // 复刻 main/index.js 的池判定逻辑做纯函数验证
  const FALLBACK = 'qwen3-8b';
  const pool = {
    models: [
      { id: 'deepseek-pro', name: 'DeepSeek PRO', available: false },
      { id: 'deepseek-flash', name: 'DeepSeek FLASH', available: false },
      { id: 'qwen3-8b', name: '硅基流动 Qwen3-8B（免费）', available: true }
    ]
  };
  const usable = pool.models.filter(m => m.available).map(m => m.id);
  const normalize = (m) => (usable.includes(m) ? m : (usable[0] || FALLBACK));
  const check = (requested) => {
    if (!requested) return null;
    if (usable.includes(requested)) return null;
    const hit = pool.models.find(m => m.id === requested);
    if (hit && hit.available === false) {
      return { success: false, unavailableModel: requested, availableModels: usable.join('、') };
    }
    return null;
  };

  assert.equal(normalize('qwen3-8b'), 'qwen3-8b', '可用模型应原样使用');
  assert.equal(check('qwen3-8b'), null, '可用模型不应被拒绝');
  const r = check('deepseek-flash');
  assert.ok(r && r.success === false, '显式选不可用模型应被拒绝');
  assert.equal(r.unavailableModel, 'deepseek-flash');
  assert.equal(r.availableModels, 'qwen3-8b');
  assert.equal(check('some-old-residual-id'), null, '未知旧配置 id 不拒绝');
  assert.equal(normalize('some-old-residual-id'), 'qwen3-8b', '未知旧配置 id 走矫正');
  assert.equal(normalize(undefined), 'qwen3-8b', '未指定模型走兜底');
});
