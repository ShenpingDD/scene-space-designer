/**
 * route-plan.test.js —— P1 自动寻路（0.10 m 栅格 A* + 门洞 portal + 精确复核）
 *
 * 关键判据不是“看图形对不对”，而是：
 *  - 路径每一段都能被 segmentWalkable 复核（不穿墙/窗/设备）；
 *  - 0.60 m 门中线可过、0.55 m 门报 door-too-narrow；
 *  - 同输入同输出；缓存开/关结果一致；
 *  - 锚点在墙/设备/场外时明确报错，不静默吸附。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cfg, resetParams } from '../src/params.js';
import { boundaryWalls } from '../src/room.js';
import { mkWallSeg } from '../src/wall.js';
import {
  planRoute, planRoutes, routeLength, routeSegments, segmentWalkable,
} from '../src/route.js';

const W = (x, z, xx, zz, openings) => mkWallSeg(x, z, xx, zz, openings || []);
const box = (extra = [], items = []) => ({
  w: 8, d: 6, h: 2.8,
  walls: [...boundaryWalls(8, 6), ...extra],
  items,
});
const divider = (opening) => W(4, 0, 4, 6, opening ? [opening] : []);
const door = (w) => ({ at: 3, w, h: 2.1 });
const win = { at: 3, w: 1.2, h: 1.5, kind: 'window', sill: 0.9 };
const CAT = { 'demo-freezer-dual': { id: 'demo-freezer-dual', w: 0.99, d: 0.87, h: 1.98 } };
const getProduct = (id) => CAT[id];

function assertEveryLegWalkable(layout, plan, opts = {}) {
  assert.equal(plan.ok, true);
  for (const leg of plan.legs) {
    for (let i = 0; i + 1 < leg.points.length; i += 1) {
      assert.equal(segmentWalkable(layout, leg.points[i], leg.points[i + 1], opts), true,
        `第 ${leg.fromIndex}→${leg.toIndex} 段第 ${i} 小段必须合法`);
    }
  }
}

function crossingZ(points, x = 4) {
  for (let i = 0; i + 1 < points.length; i += 1) {
    const [ax, az] = points[i];
    const [bx, bz] = points[i + 1];
    if ((ax - x) * (bx - x) <= 0 && Math.abs(bx - ax) > 1e-9) {
      const t = (x - ax) / (bx - ax);
      if (t >= -1e-9 && t <= 1 + 1e-9) return az + t * (bz - az);
    }
  }
  return null;
}

function assertNoBadSegments(layout, plan, opts = {}) {
  for (const leg of plan.legs) {
    for (let i = 0; i + 1 < leg.points.length; i += 1) {
      assert.equal(segmentWalkable(layout, leg.points[i], leg.points[i + 1], opts), true,
        `路径第 ${i} 段穿墙/穿设备：${JSON.stringify([leg.points[i], leg.points[i + 1]])}`);
    }
  }
}

test('无门墙：A/B 不可达；绝不返回穿墙的假路', () => {
  resetParams();
  const l = box([divider()]);
  const r = planRoute(l, { id: 1, points: [[2, 3], [6, 3]] }, { getProduct });
  assert.equal(r.ok, false);
  assert.equal(r.status, 'blocked');
  assert.equal(r.reason, 'unreachable');
  assert.deepEqual(r.legs, []);
  assert.equal(r.length, 0);
  assert.equal(r.points[0][0], 2, '失败不改锚点');
});

test('加 0.9 m 门：可达，且路径穿墙点落在门洞区间内', () => {
  resetParams();
  const l = box([divider(door(0.9))]);
  const r = planRoute(l, { id: 1, points: [[2, 3], [6, 3]] }, { getProduct });
  assertEveryLegWalkable(l, r, { getProduct });
  assert.equal(r.ok, true);
  const z = crossingZ(r.legs[0].points);
  assert.ok(z != null && z >= 2.55 - 1e-6 && z <= 3.45 + 1e-6, `穿门点 z=${z} 应在 [2.55,3.45]`);
});

test('门被设备堵住：door-blocked（不误报 unreachable，也不硬挤）', () => {
  resetParams();
  const l = box([divider(door(0.9))], [{ id: 1, p: 'demo-freezer-dual', x: 4, z: 3, r: 0 }]);
  const r = planRoute(l, { id: 1, points: [[2, 3], [6, 3]] }, { getProduct });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'door-blocked');
});

test('只加窗：仍不可达（窗不可穿）', () => {
  resetParams();
  const l = box([divider(win)]);
  const r = planRoute(l, { id: 1, points: [[2, 3], [6, 3]] }, { getProduct });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unreachable');
});

test('门宽三档：0.55 m 报 door-too-narrow，0.60 / 0.90 m 可过', () => {
  resetParams();
  const l55 = box([divider(door(0.55))]);
  const r55 = planRoute(l55, { id: 1, points: [[2, 3], [6, 3]] }, { getProduct });
  assert.equal(r55.ok, false);
  assert.equal(r55.reason, 'door-too-narrow');
  assert.match(r55.message, /0.55/);
  assert.match(r55.message, /0.60/);

  for (const width of [0.6, 0.9]) {
    const l = box([divider(door(width))]);
    const r = planRoute(l, { id: 1, points: [[2, 2.2], [6, 4]] }, { getProduct });
    assertEveryLegWalkable(l, r, { getProduct });
    const z = crossingZ(r.legs[0].points);
    assert.ok(z != null && Math.abs(z - 3) < 0.4, `${width} m 门：穿门点 z=${z} 应在门洞内`);
  }
});

test('0.60 m 门：直线偏离门中线时由 portal 折回门中心，而不是穿墙', () => {
  resetParams();
  const l = box([divider(door(0.6))]);
  const r = planRoute(l, { id: 1, points: [[2, 2.2], [6, 4]] }, { getProduct });
  assertEveryLegWalkable(l, r, { getProduct });
  const z = crossingZ(r.legs[0].points);
  assert.ok(z != null && Math.abs(z - 3) < 0.02, `必须从门中线过：z=${z}`);
});

test('设备挡路：绕行且每段到 OBB ≥ 半径；移走设备后长度回到接近直线', () => {
  resetParams();
  const l = box([], [{ id: 1, p: 'demo-freezer-dual', x: 4, z: 3, r: 0 }]);
  const r = planRoute(l, { id: 1, points: [[1, 3], [7, 3]] }, { getProduct });
  assertEveryLegWalkable(l, r, { getProduct });
  assert.ok(r.length > 6.05, `绕行长度应大于直线 6 m，实际 ${r.length}`);
  assertNoBadSegments(l, r, { getProduct });

  const clear = box([]);
  const r2 = planRoute(clear, { id: 1, points: [[1, 3], [7, 3]] }, { getProduct });
  assert.ok(r2.length < 6.01, `移走设备后应接近直线：${r2.length}`);
});

test('锚点异常：墙里/设备里 = anchor-blocked；场外 = route-point-out-of-scene；不静默挪点', () => {
  resetParams();
  const wallLayout = box([divider()]);
  const rWall = planRoute(wallLayout, { id: 1, points: [[2, 3], [4, 3]] }, { getProduct });
  assert.equal(rWall.ok, false);
  assert.equal(rWall.reason, 'anchor-blocked');
  assert.equal(rWall.anchorIndex, 1);
  assert.deepEqual(rWall.points, [[2, 3], [4, 3]], '锚点原样返回');

  const itemLayout = box([], [{ id: 1, p: 'demo-freezer-dual', x: 4, z: 3, r: 0 }]);
  const rItem = planRoute(itemLayout, { id: 1, points: [[4, 3], [6, 3]] }, { getProduct });
  assert.equal(rItem.reason, 'anchor-blocked');
  assert.equal(rItem.anchorIndex, 0);

  const rOut = planRoute(box(), { id: 1, points: [[2, 3], [9, 3]] }, { getProduct });
  assert.equal(rOut.ok, false);
  assert.equal(rOut.reason, 'route-point-out-of-scene');
  assert.equal(rOut.pointIndex, 1);
});

test('route-too-long：路径超过 maxLengthM 时明确报错，不静默截断', () => {
  resetParams();
  const l = box();
  const route = { id: 1, points: [[1, 3], [7, 3]] };
  try {
    cfg.route.maxLengthM = 5;
    const r = planRoute(l, route, { getProduct });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'route-too-long');
    assert.match(r.message, /5 m/);
  } finally {
    resetParams();
  }
});

test('形状与上限：少于 2 点 / 超过 20 点 / 重复点 一律 bad-route', () => {
  resetParams();
  const l = box();
  assert.equal(planRoute(l, { id: 1, points: [[2, 2]] }).reason, 'bad-route');
  const many = Array.from({ length: 21 }, (_, i) => [1 + i * 0.1, 2]);
  assert.equal(planRoute(l, { id: 1, points: many }).reason, 'bad-route');
  assert.equal(planRoute(l, { id: 1, points: [[2, 2], [2, 2]] }).reason, 'bad-route');
});

test('planRoutes / routeLength：6 条 × 20 点上限内正常工作', () => {
  resetParams();
  const routes = Array.from({ length: cfg.route.maxRoutes }, (_, i) => ({
    id: i + 1,
    points: [[1, 1 + i * 0.5], [7, 1 + i * 0.5]],
  }));
  const l = { ...box(), routes };
  const results = planRoutes(l, { getProduct });
  assert.equal(results.length, 6);
  assert.ok(results.every((r) => r.ok && r.status === 'ok'));
  assert.ok(results.every((r) => typeof routeLength(l, r, { getProduct }) === 'number'));

  const tooMany = { ...l, routes: [...routes, { id: 7, points: [[1, 5], [7, 5]] }] };
  const manyResults = planRoutes(tooMany, { getProduct });
  assert.equal(manyResults.length, 7);
  assert.equal(manyResults[6].ok, false);
  assert.equal(manyResults[6].reason, 'bad-route');
  assert.match(manyResults[6].message, /最多 6 条/);

  const one = planRoute(l, routes[0], { getProduct });
  assert.equal(routeSegments(routes[0]).length, 1);
  assert.equal(routeLength(l, routes[0], { getProduct }), one.length);
});

test('确定性：同输入同路径；缓存关/开结果完全一致', () => {
  resetParams();
  const l = box([divider(door(0.9))]);
  const route = { id: 1, points: [[1.5, 1.5], [3.5, 1.5], [4.5, 4.5], [6.5, 4.5]] };
  const a = planRoute(l, route, { getProduct });
  const b = planRoute(l, route, { getProduct });
  const c = planRoute(l, route, { getProduct, cache: false });
  assert.equal(a.ok, true);
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
});

test('性能：常规 8×6、4 个用户点的寻路 < 30 ms（本机实测记录）', () => {
  resetParams();
  const l = box([divider(door(0.9))]);
  const route = { id: 1, points: [[1.5, 1.5], [3.5, 1.5], [4.5, 4.5], [6.5, 4.5]] };
  planRoute(l, route, { getProduct }); // 预热（含建图/缓存）
  const t0 = performance.now();
  const r = planRoute(l, route, { getProduct, cache: false });
  const elapsed = performance.now() - t0;
  assert.equal(r.ok, true);
  assert.ok(elapsed < 30, `寻路 ${elapsed.toFixed(1)} ms 超过 30 ms`);
  console.log(`[route] 4 点寻路实测 ${elapsed.toFixed(2)} ms，路径 ${r.length.toFixed(2)} m`);
});

test('nav-too-large：栅格过大时明确拒绝，不偷偷降精度', () => {
  resetParams();
  const l = { ...box(), w: 20, d: 20, walls: boundaryWalls(20, 20) };
  try {
    cfg.route.gridM = 0.05; // 400×400 = 160k > 100k 防御上限
    const r = planRoute(l, { id: 1, points: [[1, 1], [19, 19]] }, { getProduct });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'nav-too-large');
  } finally {
    resetParams();
  }
});
