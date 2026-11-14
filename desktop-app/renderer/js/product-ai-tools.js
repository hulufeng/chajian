// Phase D · 产品工厂 5 个 AI 工具（对齐参考基线 propose_criteria / propose_shape / propose_bom /
// record_evidence / build_package）。以数组形式挂到 window，由 app.js 追加进 TOOL_DEFS。
// 关键约束：只认磁盘文件与证据，禁止「对话里说完成」被当作阶段完成。
(function () {
  function pf() { return window.ProductFactory; }
  async function readJson(rel, fallback) {
    const P = pf(); if (!P) return fallback;
    try {
      const r = await P.readFile(rel);
      if (!r || !r.success || !r.content) return fallback;
      return JSON.parse(r.content);
    } catch (e) { return fallback; }
  }
  async function writeJson(rel, obj) {
    const P = pf(); if (!P) return { success: false, error: '产品工厂未就绪' };
    return P.writeFile(rel, JSON.stringify(obj, null, 2));
  }
  function ensure() {
    const s = pf() && pf().snapshot;
    if (!s || !s.isProduct) return '当前不是产品项目。请先新建或打开产品项目，再用产品工具。';
    return null;
  }

  const defs = [
    {
      name: 'propose_criteria',
      category: 'create',
      description: '【产品工厂·创意阶段】提出或更新需求验收条件，写入 spec.json / spec.md。参数 criteria 为 [{id,text,verify}]。设置 confirmed=true 才会把创意阶段判定为完成。',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '需求正文（写入 spec.md）' },
          criteria: {
            type: 'array', description: '验收条件列表',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: '稳定唯一 id，如 C1' },
                text: { type: 'string', description: '可验证的条件描述' },
                verify: { type: 'string', description: '验证方法' }
              },
              required: ['id', 'text']
            }
          },
          confirmed: { type: 'boolean', description: '需求是否已与用户确认' }
        },
        required: ['criteria']
      },
      execute: async (a) => {
        const err = ensure(); if (err) return err;
        const list = (Array.isArray(a.criteria) ? a.criteria : []).filter(c => c && c.id && c.text)
          .map(c => ({ id: String(c.id).slice(0, 32), text: String(c.text).slice(0, 500), verify: String(c.verify || '').slice(0, 300) }));
        const ids = new Set();
        list.forEach(c => { if (ids.has(c.id)) return '验收条件 id 重复: ' + c.id; ids.add(c.id); });
        if (a.summary) await pf().writeFile('spec.md', String(a.summary));
        const r = await writeJson('spec.json', { confirmed: a.confirmed === true, criteria: list });
        if (!r.success) return '写入 spec.json 失败: ' + r.error;
        return '已写入 ' + list.length + ' 条验收条件' + (a.confirmed === true ? '（已确认，创意阶段完成）' : '（待用户确认）');
      }
    },
    {
      name: 'propose_shape',
      category: 'create',
      description: '【产品工厂·造型阶段】提出结构方案，写入 design/shape.json。需提供 model/mesh 及至少一张 2D 视图，confirmed=true 才会判定完成。',
      parameters: {
        type: 'object',
        properties: {
          unit: { type: 'string', description: '单位，默认 mm' },
          dims: { type: 'object', description: '{w,h,d} 尺寸' },
          model: { type: 'string', description: '3D 模型文件名' },
          mesh: { type: 'string', description: '网格文件路径或标识' },
          views: { type: 'array', items: { type: 'object' }, description: '2D 视图列表 [{kind,file,label}]' },
          confirmed: { type: 'boolean' }
        },
        required: ['model', 'mesh']
      },
      execute: async (a) => {
        const err = ensure(); if (err) return err;
        const shape = {
          unit: String(a.unit || 'mm'), dims: a.dims || null,
          model: String(a.model), mesh: String(a.mesh),
          views: Array.isArray(a.views) ? a.views : [],
          confirmed: a.confirmed === true
        };
        const r = await writeJson('design/shape.json', shape);
        if (!r.success) return '写入失败: ' + r.error;
        return '结构已写入。' + (shape.views.length ? shape.views.length + ' 张视图' : '仍缺 2D 视图') +
          (shape.confirmed ? '，已确认' : '，待用户确认');
      }
    },
    {
      name: 'propose_bom',
      category: 'create',
      description: '【产品工厂·硬件阶段】提出 BOM 选型，写入 bom.json。每项必须有 source.url，且 status=confirmed 才会判定完成。',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array', description: '器件列表',
            items: {
              type: 'object',
              properties: {
                role: { type: 'string' }, part: { type: 'string' }, qty: { type: 'number' },
                status: { type: 'string', description: 'confirmed / proposed' },
                source: { type: 'object', description: '{type,url}' }
              },
              required: ['role', 'part', 'source']
            }
          },
          constraints: { type: 'object', description: '可选：电源/引脚/总线约束，写入 constraints.json' }
        },
        required: ['items']
      },
      execute: async (a) => {
        const err = ensure(); if (err) return err;
        const items = (Array.isArray(a.items) ? a.items : []).map(it => ({
          role: String(it.role || ''), part: String(it.part || ''), qty: Number(it.qty) || 1,
          status: String(it.status || 'proposed'),
          source: { type: String(it.source && it.source.type || 'link'), url: String(it.source && it.source.url || '') }
        }));
        const noUrl = items.filter(it => !it.source.url);
        const r = await writeJson('bom.json', { items: items });
        if (!r.success) return '写入 bom.json 失败: ' + r.error;
        if (a.constraints) await writeJson('constraints.json', a.constraints);
        return 'BOM 已写入 ' + items.length + ' 项。' + (noUrl.length ? '⚠ ' + noUrl.length + ' 项缺来源链接，硬件阶段将被阻塞。' : '全部有来源。');
      }
    },
    {
      name: 'record_evidence',
      category: 'create',
      description: '【产品工厂·软件/联调阶段】向 evidence.jsonl 追加一条验证证据。只有 result=pass 才能覆盖验收条件；result=fail 会阻塞联调阶段。covers 必须引用 spec.json 中已存在的 criterion id。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '证据唯一 id' },
          stage: { type: 'string', description: 'idea|shape|hardware|software|integration' },
          claim: { type: 'string', description: '验证声明' },
          result: { type: 'string', description: 'pass 或 fail' },
          covers: { type: 'array', items: { type: 'string' }, description: '覆盖的验收条件 id 列表' },
          does_not_cover: { type: 'array', items: { type: 'string' } },
          invalidates: { type: 'array', items: { type: 'string' }, description: '作废的旧证据 id' },
          by: { type: 'string' }
        },
        required: ['id', 'stage', 'claim', 'result']
      },
      execute: async (a) => {
        const err = ensure(); if (err) return err;
        const STAGES = ['idea', 'shape', 'hardware', 'software', 'integration'];
        const stage = STAGES.indexOf(a.stage) >= 0 ? a.stage : 'integration';
        const result = String(a.result).toLowerCase() === 'pass' ? 'pass' : 'fail';
        const spec = await readJson('spec.json', { criteria: [] });
        const valid = new Set((spec.criteria || []).map(c => c.id));
        const covers = (Array.isArray(a.covers) ? a.covers : []).filter(c => valid.has(c));
        const invalidCovers = (Array.isArray(a.covers) ? a.covers : []).filter(c => !valid.has(c));
        const row = {
          id: String(a.id).slice(0, 64), at: Date.now(), stage, claim: String(a.claim).slice(0, 500),
          result, covers, does_not_cover: Array.isArray(a.does_not_cover) ? a.does_not_cover : [],
          invalidates: Array.isArray(a.invalidates) ? a.invalidates : [],
          by: String(a.by || 'ai')
        };
        const P = pf();
        const cur = await P.readFile('evidence.jsonl');
        const existing = cur && cur.success ? String(cur.content || '').replace(/\s+$/, '') : '';
        const content = (existing ? existing + '\n' : '') + JSON.stringify(row);
        const r = await P.writeFile('evidence.jsonl', content + '\n');
        if (!r.success) return '写入 evidence.jsonl 失败: ' + r.error;
        return '证据 ' + row.id + '（' + result + '）已记录，覆盖 ' + covers.length + ' 项条件。' +
          (invalidCovers.length ? '⚠ 忽略不存在的条件 id: ' + invalidCovers.join(', ') : '');
      }
    },
    {
      name: 'build_package',
      category: 'create',
      description: '【产品工厂·导出】生成产品包到 hardware-package/（requirements.md / bom.csv / evidence.md / README.md / .manifest.json），并用输入指纹标记是否需要重新生成。',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        const err = ensure(); if (err) return err;
        const P = pf();
        if (!window.BubaiCode || !window.BubaiCode.product) return '仅桌面版支持导出';
        const r = await window.BubaiCode.product.package({ root: P.root() });
        if (!r.success) return '导出失败: ' + r.error;
        await P.refresh(true);
        return '产品包已生成：' + r.files.join(', ') + '（指纹 ' + r.inputsHash + '）';
      }
    }
  ];

  window.ProductAITools = { defs: defs };
})();
