#!/usr/bin/env node
/**
 * 生成 resources/gateway.json。
 *
 * 注意：内置云端兜底凭据已于 2026-10-28 彻底移除——云端 AI 仅使用用户自己
 * 登录后的 token，未登录 / token 过期都不再静默回退到任何内置账号。
 * 因此本脚本只写入空凭据，不再注入任何 token（避免内置兜底被重新打包）。
 */
const fs = require('fs');
const path = require('path');

const outDir = path.join(__dirname, '..', 'resources');
const outFile = path.join(outDir, 'gateway.json');

const token = (process.env.LABCODE_GATEWAY_TOKEN || '').trim();
const url = (process.env.LABCODE_GATEWAY_URL || '').trim();

try {
  fs.mkdirSync(outDir, { recursive: true });
  // 内置云端兜底凭据已于 2026-10-28 彻底移除：云端 AI 仅使用用户自己登录后的 token。
  // 不论是否设置 LABCODE_GATEWAY_TOKEN，都只写入空凭据，避免任何内置兜底被重新打入包内。
  fs.writeFileSync(outFile, JSON.stringify({ token: '', url: '' }, null, 2) + '\n', 'utf8');
  console.log('[inject-gateway] 内置云端兜底凭据已移除 → 写入空凭据（云端 AI 仅使用用户登录 token）');
} catch (e) {
  console.error('[inject-gateway] 写入失败：' + e.message);
  process.exit(1);
}
