/**
 * BubaiCode 终端安全护栏（对齐参考基线 engine terminal-exec.js 机制，2026-09-13 移植）
 * 三层防线：
 *   1. DANGEROUS_PATTERNS 危险命令黑名单 —— 命中直接拒绝，不可绕过
 *   2. RISKY_PATTERNS 高风险命令 —— auto 模式需用户确认（BubaiCode 当前无模式系统，默认按 auto 语义）
 *   3. isReadOnlyCommand 只读白名单 —— 免确认放行
 * 另附：敏感路径（读也不豁免）、受保护路径（写保护）、命令语义前缀（会话级允许粒度）、
 *       GBK/UTF-8 双解码（中文 Windows 乱码根治）
 */

const os = require('os');

// ---------- 分段工具：引号感知，跳过引号内容防 `echo "rm -rf /"` 误判 ----------
function splitSegments(input) {
  const segments = [];
  let current = '';
  let inQuote = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuote) {
      current += ch;
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      current += ch;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (current) { segments.push(current); current = ''; }
      continue;
    }
    current += ch;
  }
  if (current) segments.push(current);
  return segments;
}

// cmd 的 ^ 转义处理：`rd /q ^/s` 或 `rm -rf ^/` 场景剥掉 ^（cmd 中 ^ 是转义符）
function unescapeCmd(input) {
  return input.replace(/\^/g, '');
}

// 剔除引号包裹内容（替换为同长度 'x'）：防 `echo "rm -rf /"` 全文正则误判
function stripQuoted(input) {
  let out = '';
  let inQuote = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuote) {
      out += 'x';
      if (ch === inQuote) { inQuote = null; out += 'x'; }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      out += 'x';
      continue;
    }
    out += ch;
  }
  return out;
}

// ---------- 1. 危险命令黑名单（命中即拒绝，不可绕过） ----------
const DANGEROUS_PATTERNS = [
  // 递归/盘符级删除（含乱序变体与多旗标组合）
  { re: /\brm\s+-[a-z]*r[a-z]*f\s+\/(?:c\b)?/i, desc: '递归强制删除根目录' },
  { re: /\brm\s+-[a-z]*r[a-z]*f\s+[a-z]:/i, desc: '递归强制删除盘符' },
  { re: /\brd\s+\/s\s+\/q\b|\brd\s+\/q\s+\/s\b|\brmdir\s+\/s\s+\/q\b|\brmdir\s+\/q\s+\/s\b/i, desc: '强制删除目录（rd /s /q 系）' },
  { re: /\b(?:del|erase)\s+(?:\/[fqs])+(?:\s*\/[fqs])*\s+[a-z]:/i, desc: '强制删除盘符文件' },
  // 磁盘/分区级
  { re: /\bdiskpart\b/i, desc: '磁盘分区操作' },
  { re: /\bmkfs(?:\s|\.)/i, desc: '格式化文件系统' },
  { re: /\bfdisk\b/i, desc: '磁盘分区操作' },
  { re: /\bcipher\s+\/w\b/i, desc: '磁盘覆写' },
  { re: /\bshutdown\b/i, desc: '关机/重启' },
  { re: /\breg\s+delete\b/i, desc: '删除注册表项' },
  // 进程/账号级
  { re: /\btaskkill\s+\/f\s+\/im\b/i, desc: '强制结束进程' },
  { re: /\bnet\s+user\b/i, desc: '用户账号操作' },
  { re: /\bnet\s+localgroup\b/i, desc: '用户组操作' },
  { re: /(?:powershell|pwsh)(?:\.exe)?(?:\s+[^\s|&;]+)*?\s+-(?:e|enc|encodedcommand)\b/i, desc: 'PowerShell 编码执行' }
];

// ---------- 2. 高风险命令（auto 模式需用户确认） ----------
const RISKY_PATTERNS = [
  // git 破坏性/推送
  { re: /\bgit\s+push\b/i, desc: 'git push（推送远端）' },
  { re: /\bgit\s+reset\s+--hard\b/i, desc: 'git reset --hard（丢弃改动）' },
  { re: /\bgit\s+checkout\s+--\b/i, desc: 'git checkout --（丢弃工作区改动）' },
  { re: /\bgit\s+clean\b/i, desc: 'git clean（删除未跟踪文件）' },
  // 发布/容器/删除
  { re: /\bnpm\s+publish\b/i, desc: 'npm publish（发布包）' },
  { re: /\bdocker\s+(?:rm|rmi|system\s+prune)\b/i, desc: 'docker 删除/清理' },
  { re: /\brm\s+-[a-z]*r[a-z]*f\b/i, desc: '递归强制删除' },
  { re: /\btaskkill\b/i, desc: '结束进程' },
  { re: /\bformat\s+[a-z]:/i, desc: '格式化盘符' },
  { re: /\bdiskpart\b/i, desc: '磁盘分区操作' },
  // 内联执行器防绕（容忍旗标中间任意 token）
  { re: /(?:^|[\s\\/])(?:powershell|pwsh)(?:\.exe)?(?:\s+[^\s|&;]+)*?\s+-(?:command|c|e|enc|encodedcommand)\b/i, desc: 'PowerShell 内联执行' },
  { re: /(?:^|[\s\\/])(?:cmd)(?:\.exe)?(?:\s+[^\s|&;]+)*?\s+\/c\b/i, desc: 'cmd /c 内联执行' },
  { re: /(?:^|[\s\\/])(?:python|python\d+(?:\.\d+)?|py)(?:\.exe)?(?:\s+[^\s|&;]+)*?\s+-c\b/i, desc: 'Python 内联执行' },
  { re: /(?:^|[\s\\/])node(?:\.exe)?(?:\s+[^\s|&;]+)*?\s+-(?:e|p)\b/i, desc: 'Node 内联执行' },
  { re: /(?:^|[\s\\/])bash(?:\s+[^\s|&;]+)*?\s+-c\b/i, desc: 'Bash 内联执行' },
  { re: /(?:^|[\s\\/])perl(?:\.exe)?(?:\s+[^\s|&;]+)*?\s+-e\b/i, desc: 'Perl 内联执行' },
  // 下载-执行管道
  { re: /\bcurl\b[^|&;\n]*\|\s*(?:sudo\s+)?(?:bash|sh|zsh)\b/i, desc: 'curl|bash 下载执行' },
  { re: /\biwr\b[^|&;\n]*\|\s*iex\b/i, desc: 'iwr|iex 下载执行' },
  // 系统/持久化变更
  { re: /\breg\s+add\b/i, desc: '修改注册表' },
  { re: /\bsc\s+create\b/i, desc: '创建系统服务' },
  { re: /\bschtasks\b/i, desc: '计划任务' },
  { re: /\bbcdedit\b/i, desc: '启动配置' },
  // 下载类
  { re: /\bcertutil\s+-urlcache\b/i, desc: 'certutil 下载' },
  { re: /\bbitsadmin\s+\/transfer\b/i, desc: 'bitsadmin 下载' },
  { re: /\bcurl\s+(-o|--output)\b/i, desc: 'curl 下载文件' },
  { re: /\bwget\s+(-O|-o|--output-document)\b/i, desc: 'wget 下载文件' }
];

// ---------- 3. 敏感路径（只读命令命中也强制确认，防免确认泄密） ----------
const SENSITIVE_PATH_RE = /(?:^|[\\/])(?:\.ssh|\.aws|\.gnupg|credentials?)[\\/]|(?:id_rsa|id_ed25519|id_dsa|\.pem|\.env)(?:$|[\\/'"\s])/i;

// ---------- 4. 受保护路径（写保护） ----------
const PROTECTED_BASENAMES = [
  '.git', '.env', '.npmrc', '.yarnrc', '.pnpmrc',
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', '.gitignore',
  'CLAUDE.md', 'AGENTS.md', '.bashrc', '.zshrc', '.profile', 'settings.json'
];
function isProtectedPath(command) {
  // 对含路径的命令做目录段扫描
  const segments = splitSegments(command);
  for (const seg of segments) {
    if (seg.startsWith('-')) continue;
    const parts = seg.split(/[\\/]/);
    for (const part of parts) {
      const base = part.toLowerCase();
      if (PROTECTED_BASENAMES.some(p => base === p || (p.startsWith('.') && base === p))) return true;
      if (base === '.claude' || base === '.cursor') return true;
    }
  }
  return false;
}

// ---------- 5. 只读命令判定 ----------
const WRITE_CMD_RE = new RegExp(
  '^(' +
  'rm|rmdir|del|erase|mkdir|move|copy|xcopy|ren|rename|attrib|write|taskkill|shutdown|format|diskpart|' +
  'git add|git commit|git push|git pull|git reset|git checkout|git clean|git merge|git rebase|git branch -d|git branch -D|git branch -f|git branch -m|git remote add|git tag -d|git init|git clone|git apply|git am' +
  ')\\b'
);
const READONLY_PREFIXES = [
  'ls', 'dir', 'cat', 'type', 'pwd', 'cd', 'echo', 'cls', 'clear', 'where', 'tree', 'more', 'findstr',
  'git status', 'git diff', 'git log', 'git branch', 'git remote -v', 'git show', 'git stash list',
  'node -v', 'node --version', 'python -v', 'python --version', 'python -m pip list', 'pip list', 'pip show',
  'npm ls', 'npm view', 'npm --version', 'go version', 'cargo --version', 'java -version', 'where.exe',
  'arduino-cli version', 'arduino-cli core list', 'arduino-cli board list'
];

function isReadOnlyCommand(command) {
  const raw = command.trim();
  // 关键：先查原始串中的分隔符/命令替换/换行 —— 防 `git status\nmkdir x` 把换行压成空格后误判只读
  if (/[&|;`]|\$\(|\r|\n/.test(raw)) return false;
  // 重定向写入（echo x > file / 2>> log）→ 非只读
  if (/[^<>=]>>?/.test(raw)) return false;
  const normalized = raw.replace(/\s+/g, ' ').trim();
  const lower = normalized.toLowerCase();
  // 写命令前缀 → 非只读
  if (WRITE_CMD_RE.test(lower)) return false;
  // 精确前缀匹配（整条命令就是该前缀或其子命令）
  for (const p of READONLY_PREFIXES) {
    if (lower === p || lower.startsWith(p + ' ')) return true;
  }
  return false;
}

// 复合命令拆段（按 & | ; 换行 $() 切，引号内不切）
function splitByChain(input) {
  const segments = [];
  let current = '';
  let inQuote = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuote) { current += ch; if (ch === inQuote) inQuote = null; continue; }
    if (ch === '"' || ch === "'") { inQuote = ch; current += ch; continue; }
    if (ch === '&' || ch === '|' || ch === ';' || ch === '\r' || ch === '\n') {
      if (current.trim()) segments.push(current.trim());
      // 跳过后续连续分隔符（如 && 、 ||）
      while (i + 1 < input.length && '&|;\r\n'.includes(input[i + 1])) i++;
      current = '';
      continue;
    }
    if (ch === '$' && input[i + 1] === '(') { if (current.trim()) segments.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

// ---------- 6. 统一判定入口 ----------
function checkCommand(command) {
  const raw = String(command || '').trim();
  if (!raw) return { verdict: 'allow', reason: '空命令', pattern: null };

  // 先剥 ^ 转义、再剔除引号内容（防 `echo "rm -rf /"` 误判）→ 判定串
  const decoded = unescapeCmd(raw);
  const judged = stripQuoted(decoded);

  // 1. 危险黑名单 → deny（不可绕过）
  for (const p of DANGEROUS_PATTERNS) {
    if (p.re.test(judged)) {
      return { verdict: 'deny', reason: p.desc, pattern: p.re.source };
    }
  }

  // 1.5 敏感路径（读也不豁免，优先于只读判定）→ confirm
  if (SENSITIVE_PATH_RE.test(judged)) {
    return { verdict: 'confirm', reason: '命令涉及敏感凭据路径', pattern: SENSITIVE_PATH_RE.source };
  }

  // 1.6 复合命令（分隔符/换行/命令替换）：拆段后全只读才放行，否则 confirm（防注入）
  if (/[&|;`]|\$\(|\r|\n/.test(raw)) {
    const segs = splitByChain(raw);
    if (segs.length > 0 && segs.every(s => isReadOnlyCommand(s))) {
      return { verdict: 'allow', reason: '复合只读命令', pattern: null };
    }
    return { verdict: 'confirm', reason: '复合命令需确认', pattern: null };
  }

  // 2. 只读命令 → allow（免确认）
  if (isReadOnlyCommand(raw)) return { verdict: 'allow', reason: '只读命令', pattern: null };

  // 3. 高风险 → confirm
  for (const p of RISKY_PATTERNS) {
    if (p.re.test(judged)) {
      return { verdict: 'confirm', reason: p.desc, pattern: p.re.source };
    }
  }

  // 4. 受保护路径写 → confirm（auto 模式 protectedPathWrite）
  if (isProtectedPath(raw)) {
    return { verdict: 'confirm', reason: '命令涉及受保护文件', pattern: null };
  }

  return { verdict: 'allow', reason: '普通命令', pattern: null };
}

// ---------- 7. 命令语义前缀（会话级允许粒度：防 git push 与 rm -rf 共享计数） ----------
const ARITY = { git: 2, npm: 3, pnpm: 3, yarn: 3, docker: 2, npx: 2 };
function getTerminalPrefix(command) {
  const raw = String(command || '').trim();
  if (!raw) return '';
  // 链式命令 → 整条作前缀（防 git push origin main & type C:\secrets.txt 被 git push 前缀放行）
  if (/[&|;`]|\$\(|\r|\n/.test(raw)) return raw;
  const segs = splitSegments(unescapeCmd(raw));
  if (segs.length === 0) return '';
  const tool = segs[0].toLowerCase();
  const arity = ARITY[tool] || 1;
  return segs.slice(0, arity).join(' ');
}

// ---------- 8. 输出解码：UTF-8 严格 → 失败回退 GBK(win32)/latin1（中文 Windows 乱码根治） ----------
function decodeOutput(buf) {
  if (!buf) return '';
  if (typeof buf === 'string') return buf;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (e) {
    // UTF-8 严格解码失败 → 按平台回退
    const enc = os.platform() === 'win32' ? 'gbk' : 'latin1';
    try {
      return new TextDecoder(enc).decode(buf);
    } catch (e2) {
      // 连 gbk 都不识别（Node 无 full-icu）→ 兜底 latin1 不抛错
      return new TextDecoder('latin1').decode(buf);
    }
  }
}

module.exports = {
  checkCommand,
  isReadOnlyCommand,
  isProtectedPath,
  getTerminalPrefix,
  decodeOutput,
  splitSegments,
  DANGEROUS_PATTERNS,
  RISKY_PATTERNS
};
