/**
 * 规则 1/2 断言集（FIX-24 的第一批）
 *
 * 基准来源：R1 在真实页面上跑出来的 A/B 实测结果（见 设计决策记录），
 * 因此这些断言不只是"我自己写的期望值"，而是**与原应用行为对齐**的证据。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { corners, overlap, wallBox, extents, round1, roundMm } from '../src/geometry.js';
import { boundaryWalls, isBoundaryWall, applyRoomSize, createLayout, validateRoomSize } from '../src/room.js';
import { checkItem, isValid, checkAll, statusText, REASON } from '../src/validate.js';
import { mkWallSeg, wallSeg } from '../src/wall.js';
/** 墙对象工厂（W1 起墙是对象；测试里写坐标更直观） */
const W = (x, z, xx, zz) => mkWallSeg(x, z, xx, zz);
const seg = (w) => wallSeg(w);

/** 真实型号（取自原型 products 数组；w/d 为占地包络，米） */
const CATALOG = new Map([
  ['demo-cabinet-800', { id: 'demo-cabinet-800', w: 1.15192501, d: 1.09483496, h: 1.98669948 }],
  ['demo-freezer-dual', { id: 'demo-freezer-dual', w: 0.99, d: 0.8712, h: 1.98 }],
]);
const get = (id) => CATALOG.get(id);
const item = (id, x, z, r = 0) => ({ id: 1, p: id, x, z, r, doorAmount: 0 });

test('几何：旋转 90° 后外接尺寸交换', () => {
  const e = extents(1.2, 0.8, 90);
  assert.ok(Math.abs(e.w - 0.8) < 1e-9);
  assert.ok(Math.abs(e.d - 1.2) < 1e-9);
});

test('几何：5 mm 容差内的接触不算重叠（对齐原型 .005）', () => {
  const a = corners(0, 0, 1, 1, 0);
  const b = corners(1.004, 0, 1, 1, 0); // 间隔 4 mm
  assert.equal(overlap(a, b), false);
  const c = corners(0.998, 0, 1, 1, 0); // 真实重叠 2 mm，但落在容差内
  assert.equal(overlap(a, c), false);
  const d = corners(0.98, 0, 1, 1, 0); // 重叠 20 mm，应判重叠
  assert.equal(overlap(a, d), true);
});

test('FIX-04：贴墙摆放合法（原型此处误报"碰墙"）', () => {
  const layout = createLayout({ w: 8, d: 6 });
  // demo-cabinet-800 半宽 0.575962505 → 左外沿落在 x≈0.00004，仍在房间内
  const it = item('demo-cabinet-800', 0.576, 0.576);
  assert.equal(checkItem(layout, it, get), REASON.OK);
  assert.equal(statusText(layout, get), '布局已就绪 · 未发现设备重叠');
});

test('FIX-04 反向校验：探出墙外仍必须报错（校验未被削弱）', () => {
  const layout = createLayout({ w: 8, d: 6 });
  const it = item('demo-cabinet-800', 0.1, 0.5);
  assert.equal(checkItem(layout, it, get), REASON.OUT_OF_ROOM);
});

test('设备间距足够则互不干扰；不足则判重叠并给出对象', () => {
  const layout = createLayout({ w: 8, d: 6 });
  layout.items.push(item('demo-cabinet-800', 0.7, 0.7));
  layout.items[0].id = 1;
  const ok = { ...item('demo-freezer-dual', 1.9, 0.7), id: 2 };
  assert.equal(checkItem(layout, ok, get), REASON.OK);
  const bad = { ...item('demo-cabinet-800', 1.6, 0.7), id: 3 };
  assert.equal(checkItem(layout, bad, get), `${REASON.OVERLAP_ITEM}#1`);
});

test('内墙是障碍物：压在内墙上判 hit-wall', () => {
  const layout = createLayout({ w: 8, d: 6 });
  layout.walls.push(W(2, 2, 2, 5)); // 竖向内墙 x=2，z 2→5
  const it = item('demo-cabinet-800', 2, 3.5);
  assert.equal(checkItem(layout, it, get), REASON.HIT_WALL);
});

test('外墙不是障碍物（FIX-04 的规则本体）', () => {
  const layout = createLayout({ w: 8, d: 6 });
  assert.equal(isBoundaryWall(layout, W(0, 0, 8, 0)), true);
  assert.equal(isBoundaryWall(layout, W(2, 2, 2, 5)), false);
  const box = wallBox(W(0, 0, 8, 0)); // 若被当作障碍，贴墙必红
  assert.equal(overlap(corners(0.576, 0.576, 1.15192501, 1.09483496, 0), box), true);
});

test('FIX-03：改空间尺寸保留内墙（原型静默删除）', () => {
  const layout = createLayout({ w: 12, d: 9 });
  layout.walls.push(W(2, 2, 2, 7));
  const r = applyRoomSize(layout, { w: 14, d: 11, h: 2.8 });
  assert.equal(r.ok, true);
  assert.equal(r.kept, 1);
  assert.equal(r.removed, 0);
  assert.equal(r.layout.walls.length, 5);
  assert.deepEqual(r.layout.walls[0], W(0, 0, 14, 0)); // 新外墙按新尺寸
  assert.deepEqual(r.layout.walls[4], W(2, 2, 2, 7)); // 内墙仍在
});

test('FIX-03：超出新范围的内墙被移除并如实计数', () => {
  const layout = createLayout({ w: 20, d: 20 });
  layout.walls.push(W(15, 15, 15, 19));
  const r = applyRoomSize(layout, { w: 8, d: 6, h: 2.8 });
  assert.equal(r.kept, 0);
  assert.equal(r.removed, 1);
  assert.equal(r.layout.walls.length, 4);
  assert.equal(statusText({ ...r.layout, items: [item('demo-cabinet-800', 15, 15)] }, get), '1 台设备存在重叠、碰墙或超出空间');
});

test('尺寸边界：3–20 m / 2–5 m 之外必须被拒', () => {
  assert.equal(validateRoomSize(25, 6, 2.8), '长宽范围 3–20 m，墙高 2–5 m');
  assert.equal(validateRoomSize(8, 6, 6), '长宽范围 3–20 m，墙高 2–5 m');
  assert.equal(validateRoomSize(8, 6, 2.8), null);
  assert.equal(applyRoomSize(createLayout(), { w: NaN, d: 6, h: 2.8 }).ok, false);
});

test('外墙口径与原型 defaultWalls 完全一致', () => {
  assert.deepEqual(boundaryWalls(8, 6), [W(0, 0, 8, 0), W(8, 0, 8, 6), W(8, 6, 0, 6), W(0, 6, 0, 0)]);
});

test('拖动吸附口径仍是 0.1 m（round1）—— 与输入精度 roundMm 是两条路', () => {
  assert.equal(round1(0.576), 0.6);
  assert.equal(round1(1.94999), 1.9);
  // 输入口用的是这条：毫米，原样保留
  assert.equal(roundMm(0.576), 0.576);
});