// 右侧 AI 面板排版回归（2026-11-14「右侧界面太丑」修复）
// 校验关键不变量，防止后续「对齐 ChipCode」的 !important 规则再次把面板压回 340px / 工具栏压成单行。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const CSS = fs.readFileSync(path.join(ROOT, 'renderer', 'css', 'style.css'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'renderer', 'js', 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');

// 取 style.css 末尾的「2026-11-14 右侧 AI 面板排版修复」段（后续覆盖段，优先级最高）
const MARK = '2026-11-14 右侧 AI 面板排版修复';
const tail = CSS.slice(CSS.lastIndexOf(MARK));

test('面板宽度放宽到 400px 且窄窗仍可收缩', () => {
  assert.match(tail, /\.ai-panel\s*\{[^}]*flex:\s*0 1 400px\s*!important/, '面板应以 400px 为基准并可收缩');
  assert.match(tail, /\.ai-panel\s*\{[^}]*min-width:\s*360px/, '窄窗保底 360px');
});

test('工具栏单行对齐 ChipCode，仅极窄容器兜底折行（2026-11-20 策略变更）', () => {
  // ChipCode 取证：composer 工具栏从不设 flex-wrap（窄面板下静默裁切）。
  // 11-14 当时的病因是 padding 链把内宽压到 241px，而非"必须两行"；11-20 已清零横向 padding
  // 并把模式/思考按钮收成纯图标，故撤销无条件 wrap 覆盖，只保留容器查询兜底。
  assert.doesNotMatch(tail, /(?<!\.ai-input-container )\.ai-input-toolbar\s*\{[^}]*flex-wrap:\s*wrap/, '不应再无条件 wrap，否则回到 11-14 的两行形态（@container 兜底那条带 .ai-input-container 前缀，不算）');
  assert.match(CSS, /#ai-input-container\s*\{[^}]*container-type:\s*inline-size/, '兜底折行需要容器查询上下文');
  assert.match(CSS, /@container \(max-width: 336px\)[\s\S]*?\.ai-input-container \.ai-input-toolbar\s*\{[^}]*flex-wrap:\s*wrap\s*!important/, '容器 ≤336px 才退回两行（宁可两行也不裁切按钮）');
  assert.match(CSS, /\.ai-input-toolbar #tb-mode-btn\s*\{[^}]*width:\s*28px\s*!important/, '模式按钮纯图标 28px（ChipCode 同形）');
  assert.match(tail, /\.model-selector\s*\{[^}]*min-width:\s*96px/, '模型选择器最小宽 96px（ChipCode 原值，可收缩到省略号）');
  assert.match(APP, /tbBtn\.title = '安全模式：'/, '标签被 CSS 隐藏后，当前模式名必须由 tooltip 承载');
});

test('流式上屏在代码围栏闭合时渲染 Markdown', () => {
  assert.match(APP, /function renderStreamBubble\(bubble, text\)/, '需有流式渲染辅助函数');
  assert.match(APP, /fences >= 2 && fences % 2 === 0/, '仅成对闭合围栏才渲染，避免半截代码块闪烁');
  const uses = (APP.match(/renderStreamBubble\(currentAIBubble, content\)/g) || []).length;
  assert.equal(uses, 2, '两条流式路径（主路径 + 诊断修复路径）都要接入');
});

test('模式按钮按内容自适应、项目药丸去重、用户头像隐藏', () => {
  assert.match(tail, /#tb-mode-btn\s*\{[^}]*width:\s*auto\s*!important/, '「⚡ 自动」不应被压成竖排');
  assert.match(tail, /#project-status\s*\{[^}]*display:\s*none/, '项目状态药丸与下方项目栏重复，应隐藏');
  assert.match(tail, /\.chat-message\.user \.chat-avatar\s*\{[^}]*display:\s*none/, '用户头像在窄面板会被裁成半个字');
});

test('状态条紧凑化', () => {
  assert.match(tail, /\.work-status-msg \.work-status-bubble\s*\{\s*padding:\s*6px 10px/, '状态条留白需收紧');
});

test('模型名与计时显示改为友好格式', () => {
  assert.match(APP, /function friendlyModelLabel\(file\)/, '需有可读模型短名函数');
  assert.match(APP, /return 'Qwen2\.5-Coder ' \+ m\[1\] \+ 'B'/, '7B/3B 文件名应转成短名');
  assert.match(APP, /function formatWorkSec\(sec\)/, '需有统一计时格式函数');
  assert.match(APP, /Math\.min\(1800/, '计时需封顶 30 分钟');
  assert.match(APP, /tEl\.textContent = formatWorkSec\(sec\)/, 'finalize 也须用友好格式');
  assert.ok(!/tEl\.textContent = '已工作 ' \+ sec \+ 's'/.test(APP), '不应再直接写秒数');
});

test('验证结论徽章按结论配色，不再 FAIL 显示绿底', () => {
  assert.match(APP, /badge\.className = 'ai-verdict-badge'/, '徽章需有稳定 class');
  assert.match(APP, /level === 'PASS'/, 'PASS 与 FAIL 需区分');
  assert.match(APP, /level === 'FAIL'/, 'FAIL 需单独配色');
  assert.ok(!/conf === 'high' \? '#52C41A'/.test(APP), '不应再只按置信度取亮绿');
});

test('转入后台提示轻量化且不压输入区', () => {
  assert.match(APP, /bottom:250px/, '悬浮提示需上移避开输入区/状态栏');
  assert.ok(!/bottom:80px;z-index:9999;background:var\(--primary\)/.test(APP), '不应再是大蓝实心胶囊');
});

test('流式残留裸围栏气泡在轮次结束时统一补渲染', () => {
  assert.match(APP, /list\.forEach\(\(m\) => \{[\s\S]{0,400}renderChatMarkdown\(b, b\.textContent/, '需扫描所有未 done 的 AI 气泡');
});

test('CodeBuddy 风格主题层：令牌驱动、可回退', () => {
  assert.ok(CSS.includes('CodeBuddy 风格 AI 面板'), 'style.css 需含主题层');
  // 令牌策略已改为直接复用全局令牌（--cb-* 会被构建链当未使用变量删除，见 style.css 6844 注释）
  assert.match(CSS, /body\.cb-compact \.ai-panel\s*\{[^}]*background:\s*var\(--surface-1/, '面板背景须走全局令牌');
  assert.match(CSS, /body\.cb-compact \.ai-panel\s*\{[^}]*border-left:\s*1px solid var\(--border/, '边框须走全局令牌');
  assert.match(CSS, /body\.cb-compact \.chat-message\.user\s*\{[^}]*background:\s*var\(--surface-2\)/, '用户消息应为浅底卡片而非蓝气泡');
  assert.match(CSS, /body\.cb-compact \.work-status-msg \.work-status-bubble\s*\{[^}]*background:\s*none/, '状态条应去掉绿紫大色块');
  assert.match(CSS, /body\.cb-compact \.ai-input-box\s*\{[^}]*border:\s*1px solid/, '输入框应为独立带边框容器');
  assert.match(CSS, /body\.cb-compact \.ai-tool-flow-body\s*\{[^}]*max-height/, '过程性工具流应收拢');
  assert.match(APP, /__bubaiClassicUI/, '需提供回退开关');
  assert.match(APP, /__bubaiCompactUI/, '需提供恢复开关');
  assert.match(APP, /__onDCL\(\(\) => \{[\s\S]{0,240}cb-compact/, '类添加须在 DOM 就绪后');
});

test('输入框 placeholder 缩短避免换行', () => {
  const m = HTML.match(/id="ai-input"[\s\S]{0,240}?placeholder="([^"]+)"/);
  assert.ok(m, '应能找到输入框 placeholder');
  assert.ok(m[1].length <= 40, `placeholder 过长会在窄面板换行：${m[1]}`);
  assert.doesNotMatch(m[1], /输入 \/ 使用技能/, '不应保留冗长旧文案');
});
