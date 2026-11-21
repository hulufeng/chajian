// 出站地址安全闸（纯函数，零依赖）
//
// 为什么要有它：设置里的 Base URL / 网关地址 / 语音识别地址都是用户可编辑的，
// 一旦填成 http://，我们的 API key、登录 token、邮箱密码就会以明文离开这台机器。
// 判定只写在这一份实现里——散在各调用点复制粘贴迟早会漂移（一处补了另一处没补）。
'use strict';

// WHATWG URL 对 IPv6 返回带方括号的 hostname（http://[::1]:8000 → "[::1]"），
// 所以先把方括号剥掉再比，否则 '::1' 那条判断永远不命中，本机推理服务会被误拒。
function isLoopbackHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[+|\]+$/g, '');
  if (h === 'localhost' || h === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

// 校验即将发请求的目标地址：非 https 且非本机 → 抛错（错话给人看的，直接透传到 UI）。
function assertHttpsOrLocal(base, label) {
  const raw = String(base == null ? '' : base);
  const who = label || '接口地址';
  let u;
  try {
    u = new URL(raw);
  } catch (e) {
    throw new Error(who + ' 不是合法地址：' + raw);
  }
  if (u.protocol !== 'https:' && !isLoopbackHost(u.hostname)) {
    throw new Error(who + ' 必须使用 https（' + raw + ' 会以明文送出密钥，已拒绝发送）。本机服务请用 http://127.0.0.1:端口');
  }
  return u;
}

// 去掉尾部斜杠，供安全拼接路径（免得出现 //chat/completions 或漏斜杠）。
function stripTrailingSlash(url) {
  let s = String(url == null ? '' : url);
  while (s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

// 校验 + 归一化一步到位：过闸返回干净可用的 base，不过闸抛错。
function guardEndpoint(base, label) {
  assertHttpsOrLocal(base, label);
  return stripTrailingSlash(base);
}

module.exports = { assertHttpsOrLocal, stripTrailingSlash, guardEndpoint, isLoopbackHost };
