'use strict';
/**
 * 出站地址安全闸验收（对齐参考基线 net-guard 的性质：凭据发出前必须过 https/本机 判定）。
 * 运行：node scripts/verify-net-guard.cjs
 * 手段：直接 require packages/engine/net-guard.js 验真实行为 + 静态检查主进程接线，
 *       并回归校验「内置供应商默认地址」全量过闸（免得哪天把默认值写成 http 而自断链路）。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const G = require(path.join(ROOT, 'packages/engine/net-guard.js'));
const MAIN = fs.readFileSync(path.join(ROOT, 'main/index.js'), 'utf8');

const passes = (u) => { try { G.assertHttpsOrLocal(u, '测试地址'); return true; } catch (e) { return false; } };
const msgOf = (u) => { try { G.assertHttpsOrLocal(u, '测试地址'); return ''; } catch (e) { return e.message || String(e); } };

test('https 公网地址放行', () => {
  assert.ok(passes('https://api.deepseek.com/v1'));
  assert.ok(passes('HTTPS://API.Example.com/v1'), '协议大小写不敏感');
});

test('本机地址放行：localhost / 127.x / IPv6 方括号', () => {
  assert.ok(passes('http://localhost:11434/v1'));
  assert.ok(passes('http://127.0.0.1:8080/v1'));
  assert.ok(passes('http://127.9.9.9:11434'), '整段 127/8 都算本机');
  // WHATWG URL 把 IPv6 主机返回成带方括号的 [::1]，只判 '::1' 是永远不命中的死分支
  assert.ok(passes('http://[::1]:8000/v1'), 'IPv6 回环必须放行，否则本机推理服务被误拒');
  assert.ok(passes('http://[0:0:0:0:0:0:0:1]:8000'), '未压缩写法的 IPv6 回环同样放行');
});

test('非 https 的非本机地址拒发', () => {
  assert.ok(!passes('http://192.168.1.20:11434/v1'), '局域网 http 一样算明文');
  assert.ok(!passes('http://bluebubai.work'), '公网域名不因「是自己家网关」而豁免');
  assert.ok(!passes('ftp://files.example.com'), '非 https 协议一律拒');
});

test('拒发文案可操作：点明地址、原因与本机写法', () => {
  const m = msgOf('http://10.0.0.5:11434/v1');
  assert.match(m, /测试地址/, '带上是哪个地址的错');
  assert.match(m, /必须使用 https/, '说清要求');
  assert.match(m, /10\.0\.0\.5:11434/, '把原地址带回去，用户不必翻设置对照');
  assert.match(m, /明文/, '说明风险');
  assert.match(m, /127\.0\.0\.1/, '给出可执行的替代写法');
});

test('非法地址单独报错，不与「必须 https」混淆', () => {
  assert.match(msgOf('not a url'), /不是合法地址/);
  assert.match(msgOf(''), /不是合法地址/);
  assert.match(msgOf(null), /不是合法地址/);
});

test('stripTrailingSlash 幂等且吞空值', () => {
  assert.equal(G.stripTrailingSlash('https://a.com///'), 'https://a.com');
  assert.equal(G.stripTrailingSlash('https://a.com'), 'https://a.com');
  assert.equal(G.stripTrailingSlash(''), '');
  assert.equal(G.stripTrailingSlash(null), '');
  assert.equal(G.stripTrailingSlash(undefined), '');
});

test('guardEndpoint = 校验 + 归一，过闸即可直接拼路径', () => {
  assert.equal(G.guardEndpoint('http://127.0.0.1:8080/v1/', 'API'), 'http://127.0.0.1:8080/v1');
  assert.throws(() => G.guardEndpoint('http://192.168.1.20:11434', '账号 API 地址'), /必须使用 https/);
});

test('内置供应商默认地址全部过闸（防止默认值自断链路）', () => {
  const registry = require(path.join(ROOT, 'packages/engine/provider-registry.js'));
  const list = registry.toAiProviders();
  assert.ok(Object.keys(list).length >= 5, '注册表应有内置供应商：' + Object.keys(list).join(','));
  for (const [id, p] of Object.entries(list)) {
    if (!p.baseURL) continue; // custom 允许留空，由用户填
    assert.ok(passes(p.baseURL), id + ' 的默认 baseURL 过不了闸：' + p.baseURL);
  }
});

// ---------- 接线：凭据外发的每一处都必须过闸 ----------

test('主进程引入 net-guard 并提供统一取址口径', () => {
  assert.match(MAIN, /require\('\.\.\/packages\/engine\/net-guard\.js'\)/, '引入闸门');
  assert.match(MAIN, /function insecureEndpoint\(base, label\)/, '错误文案出口（各调用点契约不同）');
  assert.match(MAIN, /const gwEndpoint = \(raw\) => netGuard\.guardEndpoint\(raw \|\| AI_PROVIDERS\.gateway\.baseURL, '账号 API 地址'\)/, '网关取址唯一口径');
});

test('对话 / 流式 / 识图 / one-shot 调用在发请求前过闸', () => {
  assert.match(MAIN, /insecureEndpoint\(baseURL, aiCfg\.provider === 'gateway' \? '账号 API 地址' : 'API 地址'\)/, 'ai:chat');
  assert.match(MAIN, /if \(baseURL\) netGuard\.assertHttpsOrLocal\(baseURL, aiCfg\.provider === 'gateway' \? '账号 API 地址' : 'API 地址'\)/, 'ai:chatStream');
  assert.match(MAIN, /guardEndpoint\(resolveAiBaseURL\(aiCfg\) \|\| provider\.baseURL, '识图 baseURL'\)/, 'fs:analyzeImage');
  assert.match(MAIN, /guardEndpoint\(baseURL, isGateway \? '账号 API 地址' : 'API 地址'\)/, 'callAiOnce（ghost/定时任务）');
});

test('语音识别的拒因不被网络兜底文案吃掉', () => {
  // 闸门必须挂在 try 之前：try 里的 throw 会变成「网络连接失败」，用户不知道该改哪个字段
  const stt = MAIN.slice(MAIN.indexOf("ipcMain.handle('stt:transcribe'"), MAIN.indexOf("ipcMain.handle('stt:transcribe'") + 2600);
  const atGuard = stt.indexOf('insecureEndpoint(stt.baseURL');
  const atTry = stt.indexOf('const started = Date.now();');
  assert.ok(atGuard > 0, 'STT 有出站闸');
  assert.ok(atTry > atGuard, '闸在 try 之前，拒因原样 return');
  assert.match(stt, /code: 'STT_INSECURE_URL'/, '带错误码，便于渲染层与日志区分');
});

test('网关凭据端点（含登录/注册/账号/套餐）统一经 gwEndpoint 取址', () => {
  assert.equal((MAIN.match(/gwEndpoint\(c\.url\)/g) || []).length, 4, '四个候选凭据端点');
  assert.match(MAIN, /url = gwEndpoint\(aiCfg\.gatewayUrl\)/, '本地失败回退云端时也过闸');
  assert.match(MAIN, /try \{ gwBase = gwEndpoint\(gatewayUrl \|\| savedGw \|\| process\.env\.GATEWAY_URL\)/, '登录注册前先过闸（邮箱密码风险最高）');
  assert.match(MAIN, /const gwBase = gwEndpoint\(savedGw \|\| process\.env\.GATEWAY_URL\)/, '套餐查询在 try 内取址，拒发时落内置兜底');
  assert.ok(!/c\.url \|\| AI_PROVIDERS\.gateway\.baseURL/.test(MAIN), '不留旧的手拼地址');
});

test('免鉴权端点不被误加闸（/api/models 无凭据，加闸只会把降级路径变成硬失败）', () => {
  const pool = MAIN.slice(MAIN.indexOf('async function getGatewayModelPool'), MAIN.indexOf('const gwUsableIds'));
  assert.match(pool, /AI_PROVIDERS\.gateway\.baseURL \|\| 'https:\/\/bluebubai\.work'\)\.replace/, '模型池仍走原兜底拼接');
  assert.ok(!/gwEndpoint\(/.test(pool), '模型池不经闸门');
});
