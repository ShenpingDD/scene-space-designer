/**
 * R1 修复的回归护栏 —— 专防"迁移时把已修的 bug 又带回来"
 *
 * 只收录最容易被重写吞掉的两条：
 *   FIX-09 等比缩放（原来三轴各算比例 → 开门动画剪切变形）
 *   FIX-25 撤销快照必须带 nextId（原来导入→撤销→新增会撞 id，撞完导出又导不回来）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { cfg } from '../src/params.js';
import { uniformScale, anisotropy, fitsFootprint, dimensionsNote } from '../src/model.js';
import { createHistory } from '../src/history.js';
import { createLayout } from '../src/room.js';
import { addItem, nextIdFor } from '../src/placement.js';
import { exportScheme, importScheme } from '../src/scheme.js';

/* ---------- FIX-09 ---------- */

/** demo-cabinet-800 真实数据：声明包络 1150×1986×1050 mm，实测包围盒 1151.9×1986.7×1094.8 mm */
const ENVELOPE = { w: 1.150, h: 1.986, d: 1.050 };
const BBOX = { w: 1.1519, h: 1.9867, d: 1.0948 };

test('FIX-09：缩放取三轴最小值且是单一系数（不再是三轴各算）', () => {
  const s = uniformScale(ENVELOPE, BBOX);
  assert.ok(Math.abs(s - 0.9591) < 0.0005, `实际 ${s}`); // 深度方向（把手凸出）是限制项
  assert.equal(BBOX.w * s <= ENVELOPE.w, true);
  assert.equal(BBOX.h * s <= ENVELOPE.h, true);
  assert.equal(BBOX.d * s <= ENVELOPE.d, true);
});

test('FIX-09：形状不被拉变形（各向异性 1.0，原型是三轴各算 → 剪切）', () => {
  const s = uniformScale(ENVELOPE, BBOX);
  const ratio = anisotropy({ w: BBOX.w * s, h: BBOX.h * s, d: BBOX.d * s }, BBOX);
  assert.ok(Math.abs(ratio - 1) < 1e-9, '等比缩放下各向异性必须为 1');
});

test('FIX-09：模型恒落在 2D 占地矩形内（把手不越界）', () => {
  assert.equal(fitsFootprint(ENVELOPE, BBOX), true);
});

test('FIX-09：口径不一致要能被发现（>2% 提示待核实），而不是静默变形', () => {
  assert.equal(anisotropy(ENVELOPE, BBOX) > cfg.model.anisotropyWarn, true);
  assert.equal(dimensionsNote(ENVELOPE, BBOX).verified, false);
  assert.equal(dimensionsNote(ENVELOPE, { w: 1.15, h: 1.986, d: 1.05 }).verified, true);
});

test('FIX-09：非法尺寸直接抛错，不产生 NaN 几何体（原型会静默污染包围盒）', () => {
  assert.throws(() => uniformScale(ENVELOPE, { w: 0, h: 1, d: 1 }), /不合法/);
  assert.throws(() => uniformScale(ENVELOPE, { w: NaN, h: 1, d: 1 }), /不合法/);
});

/* ---------- FIX-25 ---------- */

test('FIX-25：撤销恢复的是"布局 + nextId"整体', () => {
  const h = createHistory();
  const before = createLayout({ w: 8, d: 6 });
  h.push(before, 4);
  const after = { ...before, items: [{ id: 4, p: 'demo-cabinet-800', x: 1, z: 1, r: 0, doorAmount: 0 }] };
  const back = h.undo(after, 5);
  assert.equal(back.nextId, 4);
  assert.equal(back.layout.items.length, 0);
  const forward = h.redo(back.layout, back.nextId);
  assert.equal(forward.nextId, 5);
  assert.equal(forward.layout.items.length, 1);
});

test('FIX-25 回归场景：导入→撤销→新增 不再撞 id', () => {
  const get = (id) => (id === 'demo-freezer-dual' ? { id, w: 0.99, d: 0.8712, h: 1.98 } : undefined);
  const h = createHistory();

  // 当前文档：1 台设备，nextId=2
  let layout = addItem(createLayout({ w: 8, d: 6 }), 'demo-freezer-dual', { getProduct: get }).layout;
  let nextId = nextIdFor(layout);
  h.push(layout, nextId);

  // 导入一个 id 很大的方案（模拟真实场景：换了一台设备继续编辑）
  const imported = importScheme(exportScheme({
    w: 8, d: 6, h: 2.8,
    walls: createLayout({ w: 8, d: 6 }).walls,
    items: [{ id: 4, p: 'demo-freezer-dual', x: 1, z: 1, r: 0, doorAmount: 0 }, { id: 5, p: 'demo-freezer-dual', x: 4, z: 1, r: 0, doorAmount: 0 }],
  }), { getProduct: get });
  assert.equal(imported.ok, true);
  assert.equal(imported.nextId, 6);

  // 撤销：nextId 必须一起回退，否则下一步新增会撞上 id=4
  const back = h.undo(imported.layout, imported.nextId);
  assert.equal(back.nextId, 2);

  // 撤销后新增：id 必须是 2，且导出仍能回导（id 唯一性由导出文件承载）
  const step = addItem(back.layout, 'demo-freezer-dual', { getProduct: get, id: back.nextId });
  assert.equal(step.item.id, 2);
  const reimport = importScheme(exportScheme(step.layout), { getProduct: get });
  assert.equal(reimport.ok, true, '撤销后新增再导出，必须仍能导入');
});