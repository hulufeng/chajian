// 生成 BubaiCode 品牌图标（与界面 icon-app-logo 同款：圆角矩形 + > 线条 + 圆点）
// 用法: node scripts/gen-brand-icons.cjs
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// 界面 SVG：viewBox 0 0 200 200，stroke12，rect(52,52,96,96,rx26)，path M86 84 L108 100 L86 116，circle(126,100,r7.5)
// 生成一个带底色的 512x512 图标：浅色圆角底 + 深色线条（与当前主题 --brand-ink 亮色一致 #1a1a2e）
function makeSvg(size, { bg = '#ffffff', ink = '#1a1a2e', pad = 0 } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 200 200">
  <rect x="0" y="0" width="200" height="200" rx="44" fill="${bg}"/>
  <g transform="translate(${pad} ${pad})" fill="none" stroke="${ink}" stroke-width="12" stroke-linecap="round" stroke-linejoin="round">
    <rect x="52" y="52" width="96" height="96" rx="26"/>
    <path d="M86 84 L108 100 L86 116"/>
    <circle cx="126" cy="100" r="7.5" fill="${ink}" stroke="none"/>
  </g>
</svg>`;
}

async function main() {
  const jobs = [
    // 应用窗口/任务栏图标：白底深墨，多尺寸 ICO
    { out: path.join(ROOT, 'resources', 'icon.png'), svg: makeSvg(256), size: 256 },
    // renderer 内嵌图标（保留文件名兼容）
    { out: path.join(ROOT, 'renderer', 'bubai-icon.png'), svg: makeSvg(256), size: 256 },
  ];
  for (const j of jobs) {
    fs.mkdirSync(path.dirname(j.out), { recursive: true });
    await sharp(Buffer.from(j.svg)).png().toFile(j.out);
    console.log('written', path.relative(ROOT, j.out));
  }
  // ICO：sharp 不直接支持 ico，用多尺寸 PNG 缓冲区手搓 ICO 容器
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const pngBufs = [];
  for (const s of icoSizes) {
    const buf = await sharp(Buffer.from(makeSvg(s))).png().toBuffer();
    pngBufs.push({ s, buf });
  }
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(icoSizes.length, 4);
  const entries = [];
  let offset = 6 + 16 * icoSizes.length;
  for (const { s, buf } of pngBufs) {
    const e = Buffer.alloc(16);
    e.writeUInt8(s === 256 ? 0 : s, 0); e.writeUInt8(s === 256 ? 0 : s, 1);
    e.writeUInt8(0, 2); e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(buf.length, 8); e.writeUInt32LE(offset, 12);
    offset += buf.length;
    entries.push(e);
  }
  const ico = Buffer.concat([header, ...entries, ...pngBufs.map(p => p.buf)]);
  const icoPath = path.join(ROOT, 'resources', 'icon.ico');
  fs.writeFileSync(icoPath, ico);
  console.log('written', path.relative(ROOT, icoPath), ico.length, 'bytes');
}
main().catch(e => { console.error(e); process.exit(1); });
