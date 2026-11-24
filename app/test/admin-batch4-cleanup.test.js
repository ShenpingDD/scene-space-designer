// 批 4 · 代码卫生的三条判据（req-6 · req-7 · dev-10）
//
// 这三条的共同点：**都不会报错**。
//   · 同一列两种显示法 → 页面照常渲染，只是读的人以为在说两件事；
//   · 面板上挂着过期的条数说法 → 少说的那几项"再也改不了，而界面看着是完整的"；
//   · 恒 undefined 的死字段 → 传下去没人用，删不删都不报错。
// 所以它们要靠判据钉住，而不是靠"下次记得改"。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { formRows } from '../src/admin/params.js';
import { actorLabel } from '../src/admin/schemes.js';

// 从 app/test/ 出发：'../../' 才是仓根（少一层就到 app/ 下面去了 —— 实测 ENOENT 踩过）
const read = (p) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const SCHEMA = JSON.parse(read('server/src/main/resources/params-schema.json'));

test('req-6：「最近谁改的」只有一种口径 —— 产品卡片也走 actorLabel', () => {
  const pc = read('app/src/admin/ProductCards.vue');
  assert.match(pc, /import \{ actorLabel \} from '\.\/schemes\.js'/,
    '产品卡片要共用方案侧那一个函数（一处定义）');
  assert.match(pc, /actorLabel\(p\.updatedBy\)/, '显示要走 actorLabel');
  assert.doesNotMatch(pc, /\{\{\s*p\.updatedBy\s*\}\}/,
    '不许再直接印原始值 —— 单用户档下那会显示成「1」，而方案卡片显示「本机用户」');

  // 口径本身：空的不补人名、认得才翻、不认识的原样带 #（绝不猜）
  assert.equal(actorLabel('1'), '#1',
    'id 1 曾特判成「本机用户」（单用户档的遗留）；U1 起它只是普通账号之一，归属按 ownerName 显示');
  assert.equal(actorLabel(''), '—');
  assert.equal(actorLabel(null), '—');
  assert.equal(actorLabel('7'), '#7');
});

test('req-7：面板写的条数 = 真源条数（而且表单真的盖住每一项）', () => {
  const rows = formRows(SCHEMA, SCHEMA.defaults);
  const panel = read('app/src/admin/ParamsPanel.vue');
  const m = (panel.match(/(\d+)\s*组\s*(\d+)\s*项/) || []);
  assert.ok(m.length === 3, '面板里那句话说法的形状变了，判据要跟着改');
  assert.equal(Number(m[2]), rows.length,
    '面板写着 ' + m[2] + ' 项，真源有 ' + rows.length + ' 项 —— 少说的那几项会被读成"不存在"');
  assert.equal(rows.length, SCHEMA.flat.length, '表单行数必须盖住规格里的每一项');
});

test('dev-10：formRows 不许再有恒 undefined 的 key 字段', () => {
  const rows = formRows(SCHEMA, SCHEMA.defaults);
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => !('key' in r)),
    '`key: e.key` 恒为 undefined（导出器的结果里没有 key），全仓零读取方 —— 删掉，别再长回来');
  assert.ok(rows.every((r) => typeof r.path === 'string' && r.path.includes('.')),
    '要认一项只能用 path');
});