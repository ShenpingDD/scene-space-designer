/**
 * room-preview.test.js —— 画房预览的纯逻辑判据（task-39）
 *
 * QA 真机缺陷：8×6 从 (8.4,1) 拖 3×3 越界画房，旧预览把新外墙直接拼到旧 layout 上，
 * 面面积 > w*d，`roomsOf` 的 task-38 守恒守卫每次 pointermove 抛 unhandledrejection。
 *
 * 这里直接测 `planRoomPreview`（PlanView 的 computed 调它）：
 *   ① 越界矩形先扩场景，不抛，roomsAfter 正确；
 *   ② 左/上扩时预览墙按 dx/dz 平移回当前坐标系；
 *   ③ 扩不了/坏矩形返回 ok:false，不抛；
 *   ④ 正常房内矩形也不抛，且结果复用落笔同一套 `roomOutlineWalls`。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { planRoomPreview } from '../src/designer.js';
import { createLayout } from '@core/room.js';

const base = () => createLayout({ w: 8, d: 6, h: 2.8 });

test('task-39：8×6 从 (8.4,1) 拖 3×3 —— 预览不抛，先扩场景，roomsAfter=2', () => {
  const p = planRoomPreview(base(), { x0: 8.4, z0: 1, x1: 11.4, z1: 4 });
  assert.equal(p.ok, true);
  assert.equal(p.roomsAfter, 2, '新旧两间：8.4×6 + 3×6');
  assert.ok(p.walls.length > 0, '越界画房要能预览出新墙');
  assert.equal(p.expanded.dx, 0);
  assert.equal(p.expanded.dz, 0);
  assert.deepEqual(p.expanded.to, [11.4, 6]);
});

test('task-39：左扩时新墙按 dx 平移回当前坐标系（预览不跳位）', () => {
  const p = planRoomPreview(base(), { x0: -2, z0: 1, x1: 1, z1: 4 });
  assert.equal(p.ok, true);
  assert.equal(p.expanded.dx, 2);
  assert.equal(p.expanded.dz, 0);
  assert.ok(p.walls.some(([a, b]) => Math.abs(a[0] + 2) < 1e-9 || Math.abs(b[0] + 2) < 1e-9),
    '新左墙在原坐标里应在 x=-2，而不是新坐标的 x=0');
  assert.equal(p.roomsAfter, 2);
});

test('task-39：扩不了（超范围）返回 ok:false，不 throw；坏矩形同样', () => {
  const tooBig = planRoomPreview(base(), { x0: 8.4, z0: 1, x1: 30, z1: 4 });
  assert.equal(tooBig.ok, false);
  assert.match(tooBig.message, /超出范围/);

  const bad = planRoomPreview(base(), { x0: NaN, z0: 1, x1: 2, z1: 3 });
  assert.equal(bad.ok, false);
  assert.match(bad.message, /矩形不合法/);
});

test('task-39：房内画一圈仍可预览，roomsAfter=2 而不是重复算面', () => {
  const p = planRoomPreview(base(), { x0: 1, z0: 1, x1: 4, z1: 4 });
  assert.equal(p.ok, true);
  assert.equal(p.roomsAfter, 2);
  assert.equal(p.walls.length, 4, '房内新矩形四条边都要画');
  assert.equal(p.reused, 0);
});
