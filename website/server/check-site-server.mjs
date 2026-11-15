/**
 * 官网后台服务端 · 自检（起真实服务打全接口）
 *
 * 启动 codelab-site/server/server.mjs（真实 HTTP，监听临时端口 + 临时数据目录），
 * 覆盖：公开接口（插件/版本/内容/联系/下载统计）、管理员鉴权与 CRUD、静态托管（含 /admin/）。
 *
 * 用法：node codelab-site/server/check-site-server.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { get, request } from 'node:http';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };

const PORT = 8791;
const HOST = '127.0.0.1';
const SERVER = `http://${HOST}:${PORT}`;
const DATA_DIR = mkdtempSync(join(tmpdir(), 'codelab-site-check-'));
const ADMIN_EMAIL = 'admin@test.dev';
const ADMIN_PWD = 'testpass123';

function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = get(url, (res) => { res.resume(); resolve(true); });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error('服务启动超时'));
        else setTimeout(tick, 150);
      });
    };
    tick();
  });
}

function req(method, path, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = request({ host: HOST, port: PORT, path, method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      } }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => {
        let json = null; try { json = JSON.parse(buf); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, json, raw: buf });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

console.log(`\n=== 启动官网后台 ${SERVER}（临时数据目录）===`);
const srv = spawn(process.execPath, [fileURLToPath(new URL('server.mjs', import.meta.url))], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT), HOST, SITE_DATA_DIR: DATA_DIR, SITE_ADMIN_EMAIL: ADMIN_EMAIL, SITE_ADMIN_PASSWORD: ADMIN_PWD },
  stdio: ['ignore', 'pipe', 'pipe'],
});
srv.stdout.on('data', (d) => { const s = d.toString(); if (s.includes('已启动')) console.log('  ' + s.trim()); });
srv.stderr.on('data', (d) => console.error('  [server stderr] ' + d.toString()));

let exitCode = 1;
let token = '';
try {
  await waitForServer(`${SERVER}/api/plugins`, 15000);

  console.log('\n=== 1. 公开接口 ===');
  const pl = await req('GET', '/api/plugins');
  ok(pl.status === 200, `GET /api/plugins 200（实 ${pl.status}）`);
  ok(Array.isArray(pl.json?.plugins) && pl.json.plugins.length === 5, `返回 5 个已上架插件（实 ${pl.json?.plugins?.length}）`);
  ok(pl.json.plugins.every((p) => p.name && p.version && p.category), '插件含 name/version/category');

  const ver = await req('GET', '/api/version');
  ok(ver.status === 200 && ver.json.latest === '0.1.9', `GET /api/version 默认 v0.1.9（实 ${ver.json?.latest}）`);

  const miss = await req('GET', '/api/content/nope');
  ok(miss.status === 404, `GET 不存在的内容块 404（实 ${miss.status}）`);

  const dl = await req('GET', '/api/downloads');
  ok(dl.status === 200 && typeof dl.json.total === 'number', 'GET /api/downloads 返回 total');

  console.log('\n=== 2. 联系表单（公开）===');
  const cEmpty = await req('POST', '/api/contact', { body: { message: '' } });
  ok(cEmpty.status === 400, `空留言被拒 400（实 ${cEmpty.status}）`);
  const cOk = await req('POST', '/api/contact', { body: { name: '张三', email: 'z@x.com', message: '你好' } });
  ok(cOk.status === 201 && cOk.json.ok, `提交留言 201（实 ${cOk.status}）`);
  const cBad = await req('POST', '/api/contact', { body: { message: 'x'.repeat(5000) } });
  ok(cBad.status === 400 || cBad.status === 201, `超长留言被限流/接受（实 ${cBad.status}）`);

  console.log('\n=== 3. 管理员鉴权 ===');
  const loginBad = await req('POST', '/api/admin/login', { body: { email: ADMIN_EMAIL, password: 'wrong' } });
  ok(loginBad.status === 401, `错误密码登录 401（实 ${loginBad.status}）`);
  const noToken = await req('GET', '/api/admin/overview');
  ok(noToken.status === 401, `无 token 访问管理接口 401（实 ${noToken.status}）`);
  const login = await req('POST', '/api/admin/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PWD } });
  ok(login.status === 200 && !!login.json.token, '正确登录返回 token');
  token = login.json.token;

  console.log('\n=== 4. 管理员：概览 / 插件 CRUD ===');
  const ov = await req('GET', '/api/admin/overview', { token });
  ok(ov.status === 200 && ov.json.plugins === 6, `概览插件总数 6（实 ${ov.json?.plugins}）`);
  ok(ov.json.publishedPlugins === 5, `已上架 5（实 ${ov.json?.publishedPlugins}）`);
  ok(ov.json.contacts >= 1, `联系留言 >=1（实 ${ov.json?.contacts}）`);

  const pCreate = await req('POST', '/api/admin/plugins', { token, body: { id: 'test-plugin', name: '测试插件', version: '1.0.0', icon: '🧪', category: 'ai', description: '自检用', tags: ['t'], github: 'https://x', published: true } });
  ok(pCreate.status === 201, `创建插件 201（实 ${pCreate.status}）`);
  const pList = await req('GET', '/api/admin/plugins', { token });
  ok(pList.json.plugins.some((p) => p.id === 'test-plugin'), '插件列表含新插件');
  const pPub = await req('GET', '/api/plugins');
  ok(pPub.json.plugins.some((p) => p.id === 'test-plugin'), '新插件出现在公开列表（已上架）');
  const pUpd = await req('PUT', '/api/admin/plugins/test-plugin', { token, body: { name: '测试插件改', version: '1.1.0' } });
  ok(pUpd.status === 200 && pUpd.json.plugin.name === '测试插件改', '更新插件成功');
  const pDup = await req('POST', '/api/admin/plugins', { token, body: { id: 'test-plugin', name: 'x' } });
  ok(pDup.status === 409, `重复 id 被拒 409（实 ${pDup.status}）`);

  console.log('\n=== 5. 管理员：内容块 CRUD ===');
  const cCreate = await req('POST', '/api/admin/content', { token, body: { key: 'announce', title: '公告', body: '欢迎' } });
  ok(cCreate.status === 201, `创建内容块 201（实 ${cCreate.status}）`);
  const cGet = await req('GET', '/api/content/announce');
  ok(cGet.status === 200 && cGet.json.title === '公告', '公开读取内容块成功');
  const cUpd = await req('PUT', '/api/admin/content/announce', { token, body: { body: '欢迎2' } });
  ok(cUpd.status === 200 && cUpd.json.content.body === '欢迎2', '更新内容块成功');

  console.log('\n=== 6. 管理员：版本设置 ===');
  const vUpd = await req('PUT', '/api/admin/version', { token, body: { latest: '0.2.0', notes: '新版本' } });
  ok(vUpd.status === 200, `更新版本 200（实 ${vUpd.status}）`);
  const vGet = await req('GET', '/api/version');
  ok(vGet.json.latest === '0.2.0', `/api/version 反映新版本（实 ${vGet.json.latest}）`);

  console.log('\n=== 7. 下载计数 ===');
  const redir = await req('GET', '/d/windows?v=0.2.0');
  ok(redir.status === 302 && /LabCode-Setup/.test(redir.headers.location || ''), `下载重定向 302（${redir.headers.location}）`);
  const dlAdmin = await req('GET', '/api/admin/downloads', { token });
  ok(dlAdmin.status === 200 && dlAdmin.json.total >= 1, `下载统计 total>=1（实 ${dlAdmin.json?.total}）`);
  ok(dlAdmin.json.byPlatform.windows >= 1, '按平台统计含 windows');

  console.log('\n=== 8. 联系留言管理 ===');
  const contacts = await req('GET', '/api/admin/contacts', { token });
  ok(contacts.status === 200 && contacts.json.contacts.length >= 1, `留言列表含提交项（实 ${contacts.json?.contacts?.length}）`);
  const cid = contacts.json.contacts[0].id;
  const cread = await req('POST', `/api/admin/contacts/${cid}`, { token });
  ok(cread.status === 200, '标记留言已读成功');

  console.log('\n=== 9. 清理测试插件 / 内容 ===');
  const pDel = await req('DELETE', '/api/admin/plugins/test-plugin', { token });
  ok(pDel.status === 200, '删除测试插件成功');
  const cDel = await req('DELETE', '/api/admin/content/announce', { token });
  ok(cDel.status === 200, '删除测试内容块成功');

  console.log('\n=== 10. 静态托管 ===');
  const home = await req('GET', '/');
  ok(home.status === 200 && /LabCode/.test(home.raw), 'GET / 返回首页 HTML');
  const admin = await req('GET', '/admin/');
  ok(admin.status === 200 && /LabCode 官网后台/.test(admin.raw), 'GET /admin/ 返回管理后台 HTML');
  const ph = await req('GET', '/plugins.html');
  ok(ph.status === 200, 'GET /plugins.html 200');
  const api404 = await req('GET', '/api/unknown');
  ok(api404.status === 404, `未知 API 404（实 ${api404.status}）`);
  // 目录穿越防护
  const trav = await req('GET', '/../server/server.mjs');
  ok(trav.status !== 200 || !/SITE_ROOT/.test(trav.raw), '目录穿越被拦截');

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  exitCode = fail === 0 ? 0 : 1;
} catch (e) {
  console.error('\n[自检异常] ' + (e && e.stack || e));
  fail++;
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  exitCode = 1;
} finally {
  srv.kill('SIGTERM');
  try { rmSync(DATA_DIR, { recursive: true, force: true }); } catch {}
  process.exit(exitCode);
}
