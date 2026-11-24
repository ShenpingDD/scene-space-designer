/**
 * route-geometry.test.js —— P1 动线可通行几何（真实 8×6 场景，不造假几何）
 *
 * 判据口径（docs/97 §5.1）：
 *  - 半径/离墙间隙只读 cfg.walk.*；设备只按人体半径，**不额外加净空**；
 *  - 墙用 wallSolidSegments：门洞挖空、窗仍实心；
 *  - 点与线段用同一套精确几何；0.60 m 门恰好中线可过，0.55 m 门不可过。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cfg, resetParams } from '../src/params.js';
import { boundaryWalls } from '../src/room.js';
import { mkWallSeg } from '../src/wall.js';
import { pointWalkable, segmentWalkable, routePointInScene } from '../src/route.js';

const W = (x, z, xx, zz, openings) => mkWallSeg(x, z, xx, zz, openings || []);
const box = (extra = [], items = []) => ({
  w: 8, d: 6, h: 2.8,
  walls: [...boundaryWalls(8, 6), ...extra],
  items,
});
const divider = (opening) => W(4, 0, 4, 6, opening ? [opening] : []);
const door = (w) => ({ at: 3, w, h: 2.1 });
const win = { at: 3, w: 1.2, h: 1.5, kind: 'window', sill: 0.9 };

/** demo-freezer-dual 的占地包络（与既有漫游夹具一致，不另造产品尺寸） */
const CAT = { 'demo-freezer-dual': { id: 'demo-freezer-dual', w: 0.99, d: 0.87, h: 1.98 } };
const getProduct = (id) => CAT[id];

test('P1 参数冻结：6 条 × 20 点、0.10 m 栅格、不新增第二套人体半径', () => {
  resetParams();
  assert.equal(cfg.route.maxRoutes, 6);
  assert.equal(cfg.route.maxPoints, 20);
  assert.equal(cfg.route.gridM, 0.1);
  assert.equal(cfg.route.arrowEveryM, 1.5);
  assert.equal(cfg.route.maxLengthM, 500);
  assert.equal(cfg.walk.radiusM, 0.24);
  assert.equal(cfg.walk.wallClearanceM, 0.06);
});

test('可站判据：空场景可站，墙/窗/设备中心不可站', () => {
  resetParams();
  const empty = box();
  assert.equal(pointWalkable(empty, [2, 2], { getProduct }), true);
  assert.equal(pointWalkable(empty, [0.1, 2], { getProduct }), false, '边界内缩半径');

  const withWall = box([divider()]);
  assert.equal(pointWalkable(withWall, [4, 3], { getProduct }), false, '隔墙中心');

  const withDoor = box([divider(door(0.9))]);
  assert.equal(pointWalkable(withDoor, [4, 3], { getProduct }), true, '0.9 m 门中心可站');

  const withWindow = box([divider(win)]);
  assert.equal(pointWalkable(withWindow, [4, 3], { getProduct }), false, '窗洞中心仍是实心');

  const withItem = box([], [{ id: 1, p: 'demo-freezer-dual', x: 4, z: 3, r: 0 }]);
  assert.equal(pointWalkable(withItem, [4, 3], { getProduct }), false, '设备中心');
  assert.equal(pointWalkable(withItem, [4, 3], {}), true, '没有目录时不认设备（与 blocked 同口径）');
});

test('线段扫掠：无门墙挡、0.9 m 门过、窗挡、设备只按半径', () => {
  resetParams();
  assert.equal(segmentWalkable(box([divider()]), [2, 3], [6, 3], { getProduct }), false, '无门墙');
  assert.equal(segmentWalkable(box([divider(door(0.9))]), [2, 3], [6, 3], { getProduct }), true, '0.9 m 门');
  assert.equal(segmentWalkable(box([divider(win)]), [2, 3], [6, 3], { getProduct }), false, '窗');

  // 精确切点：贴墙 0.30 m（半径 + 离墙间隙）允许；少 1 cm 拒绝
  const wall = box([divider()]);
  assert.equal(pointWalkable(wall, [3.7, 3], { getProduct }), true, '离墙 0.30 m 切点');
  assert.equal(pointWalkable(wall, [3.71, 3], { getProduct }), false, '离墙 0.29 m');
  assert.equal(segmentWalkable(wall, [3.7, 1], [3.7, 5], { getProduct }), true, '平行贴墙 0.30 m');
  assert.equal(segmentWalkable(wall, [3.71, 1], [3.69, 5], { getProduct }), false, '平行贴墙 0.29 m');
  // 边界内缩只看 radius；但真实场景四面外墙还有 +wallClearance，所以用“无墙”布局验证这一条
  const noWalls = { w: 8, d: 6, h: 2.8, walls: [], items: [] };
  assert.equal(pointWalkable(noWalls, [0.24, 3], { getProduct }), true, '边界内缩半径切点');
  assert.equal(pointWalkable(noWalls, [0.239, 3], { getProduct }), false, '边界更近 1 mm');

  const withItem = box([], [{ id: 1, p: 'demo-freezer-dual', x: 4, z: 3, r: 0 }]);
  assert.equal(segmentWalkable(withItem, [2, 3], [6, 3], { getProduct }), false, '设备挡住');
  // 刚好贴设备侧面：距离 = 半径时允许（切点），更近则不允许 —— 不额外加 0.10 m 净空
  const tangent = 0.87 / 2 + 0.24;
  assert.equal(segmentWalkable(withItem, [2, 3 + tangent], [6, 3 + tangent], { getProduct }), true, '切点允许');
  assert.equal(segmentWalkable(withItem, [2, 3 + tangent - 0.01], [6, 3 + tangent - 0.01], { getProduct }), false, '更近 1 cm 拒绝');
});

test('0.60 m 门：门中线可过；0.55 m 门：中线也不可过', () => {
  resetParams();
  const need = 2 * (cfg.walk.radiusM + cfg.walk.wallClearanceM);
  assert.equal(need, 0.6);

  const d60 = box([divider(door(0.6))]);
  assert.equal(pointWalkable(d60, [4, 3], { getProduct }), true, '0.60 m 门中线相切');
  assert.equal(segmentWalkable(d60, [2, 3], [6, 3], { getProduct }), true, '0.60 m 门中线可走');
  assert.equal(segmentWalkable(d60, [2, 3.2], [6, 3.2], { getProduct }), false, '偏 0.2 m 就过不去');
  assert.equal(segmentWalkable(d60, [2, 2.55], [6, 2.55], { getProduct }), false, '门边 0.45 m 处也过不去');

  const d55 = box([divider(door(0.55))]);
  assert.equal(pointWalkable(d55, [4, 3], { getProduct }), false, '0.55 m 门中线仍太窄');
  assert.equal(segmentWalkable(d55, [2, 3], [6, 3], { getProduct }), false);
});

test('routePointInScene：只判场景矩形，不判墙/设备（语义分开）', () => {
  resetParams();
  const l = box([divider()]);
  assert.equal(routePointInScene(l, [0, 0]), true);
  assert.equal(routePointInScene(l, [8, 6]), true);
  assert.equal(routePointInScene(l, [-0.001, 3]), false);
  assert.equal(routePointInScene(l, [8.001, 3]), false);
  assert.equal(routePointInScene(l, [4, 3]), true, '墙里仍在场景内 —— 由 pointWalkable 拒绝');
});
