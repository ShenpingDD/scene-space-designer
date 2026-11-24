/**
 * columns-seams.test.js —— 柱接入内核其他入口的成对判据
 *
 * 每个入口都成对：无柱合法/有柱拒绝；或柱挪动后缓存必须失效。
 * 这些测试故意不通过 columns.test.js 的语法糖，直接调用 app 会用的公开入口。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createLayout, expandToInclude, planSceneSize } from '../src/room.js';
import { mkWallSeg } from '../src/wall.js';
import { blocked, safeSpawn } from '../src/collision.js';
import {
  invalidateRouteCache, planRoute, pointWalkable, segmentWalkable,
} from '../src/route.js';
import { checkItem } from '../src/validate.js';
import { placeOpening, updateOpening } from '../src/openings.js';
import { exportScheme, importScheme } from '../src/scheme.js';
import { usableAreaOf, usableAreaSummary } from '../src/columns.js';

const col = (x, z, w = 0.5, d = 0.5, id = 1) => ({ id, x, z, w, d });
const getProduct = () => ({ w: 0.2, d: 0.2 });
const base = () => createLayout({ w: 8, d: 6, h: 2.8 });

test('checkItem：hit-wall 之后接 hit-column#id；无柱时照旧', () => {
  const l = { ...base(), columns: [col(4, 3)] };
  assert.equal(checkItem(l, { id: 2, p: 'p', x: 4, z: 3, r: 0 }, getProduct), 'hit-column#1');
  assert.equal(checkItem(l, { id: 2, p: 'p', x: 2, z: 2, r: 0 }, getProduct), null);
});

test('collision：blocked/safeSpawn 用 wall clearance，柱内与柱边不可站', () => {
  const l = { ...base(), columns: [col(4, 3, 1, 1)] };
  assert.equal(blocked(4, 3, l, getProduct), true, '柱中心被挡');
  assert.equal(blocked(4, 2.44, l, getProduct), true, '柱边 + radius/clearance 被挡');
  assert.equal(blocked(2, 2, l, getProduct), false);
  const spawn = safeSpawn(l, getProduct);
  assert.ok(spawn, '还要有可站出生点');
  assert.equal(blocked(spawn[0], spawn[1], l, getProduct), false);
});

test('route：pointWalkable/segmentWalkable 拒绝柱，路线绕开且每段可复核', () => {
  const l = { ...base(), columns: [col(4, 3, 1, 1)] };
  assert.equal(pointWalkable(l, [4, 3]), false);
  assert.equal(pointWalkable(l, [2, 2]), true);
  assert.equal(segmentWalkable(l, [1, 3], [7, 3]), false);
  assert.equal(segmentWalkable(l, [1, 1], [2, 1]), true);

  invalidateRouteCache();
  const r = planRoute(l, { id: 1, points: [[1, 3], [7, 3]] }, {});
  assert.equal(r.ok, true);
  for (const leg of r.legs) {
    for (let i = 0; i + 1 < leg.points.length; i += 1) {
      assert.equal(segmentWalkable(l, leg.points[i], leg.points[i + 1]), true);
    }
  }
});

test('route 缓存：先无柱规划、后在同一场景加柱，navKey 必须失效并重算', () => {
  const noCol = base();
  invalidateRouteCache();
  assert.equal(planRoute(noCol, { id: 1, points: [[1, 3], [7, 3]] }, {}).ok, true);
  const withCol = { ...noCol, columns: [col(4, 3, 1, 1)] };
  const r = planRoute(withCol, { id: 1, points: [[1, 3], [7, 3]] }, {});
  assert.equal(r.ok, true, '有柱时应绕行而不是复用无柱旧导航图');
  for (const leg of r.legs) {
    for (let i = 0; i + 1 < leg.points.length; i += 1) {
      assert.equal(segmentWalkable(withCol, leg.points[i], leg.points[i + 1]), true);
    }
  }
});

test('openings：门窗放置/改宽反向报 column-in-opening', () => {
  const l = { ...base(), columns: [col(4, 0.3)] };
  const placed = placeOpening(l, 0, { at: 4, w: 0.9, h: 2.1 });
  assert.equal(placed.ok, false);
  assert.equal(placed.reason, 'column-in-opening');
  assert.match(placed.message, /柱 #1/);

  // 已有洞口、柱也在洞口里（导入宽容态）：改宽也必须被拦
  const dirty = {
    ...base(),
    walls: [mkWallSeg(0, 0, 8, 0, [{ at: 4, w: 0.9, h: 2.1 }])],
    columns: [col(4, 0.3)],
  };
  const updated = updateOpening(dirty, 0, 0, { w: 1.2 });
  assert.equal(updated.ok, false);
  assert.equal(updated.reason, 'column-in-opening');
});

test('room：扩场景平移柱，缩场景越界阻断；expandToInclude 不动柱数', () => {
  const l = { ...base(), columns: [col(1, 1)] };
  const e = expandToInclude(l, { x0: -1, z0: 0, x1: 8, z1: 6 });
  assert.equal(e.ok, true);
  assert.equal(e.changed, true);
  assert.deepEqual(e.layout.columns, [col(2, 1)]);

  // 只留一根真正在新尺寸之外的柱，避免外墙先报 walls-out-of-bounds
  const shrink = planSceneSize({ ...l, walls: [], columns: [col(7, 5)] }, { w: 4, d: 4, h: 2.8 });
  assert.equal(shrink.ok, false);
  assert.equal(shrink.reason, 'columns-out-of-bounds');
  assert.deepEqual(shrink.columnIndexes, [0]);
});

test('面积：L 形/带洞只扣真正落在面内的柱', () => {
  const poly = [[0, 0], [8, 0], [8, 2], [4, 2], [4, 6], [0, 6]];
  // L 形：左下臂内的柱扣，右上凹口（面外）的柱不扣
  assert.equal(usableAreaOf({ poly, area: 32 }, [col(3, 3), col(5, 3)]), 32 - 0.25);

  // 带洞（小房间在父房间内）：父房间不扣、子房间扣
  const b = base();
  const nested = {
    ...b,
    walls: [
      ...b.walls,
      mkWallSeg(2, 2, 4, 2), mkWallSeg(4, 2, 4, 4),
      mkWallSeg(4, 4, 2, 4), mkWallSeg(2, 4, 2, 2),
    ],
    columns: [col(2.5, 2.5)],
  };
  const summary = usableAreaSummary(nested);
  const child = summary.rooms.find((r) => Math.abs(r.area - 4) < 1e-9);
  const parent = summary.rooms.find((r) => Math.abs(r.area - 44) < 1e-9);
  assert.equal(child.usableArea, 3.75);
  assert.equal(child.deductedArea, 0.25);
  assert.equal(parent.usableArea, 44);
  assert.equal(parent.columnIds.length, 0);
});

test('scheme：字段顺序 walls→columns→items，空柱不发射，含柱往返', () => {
  const l = { ...base(), columns: [col(4, 3), col(2, 2, 0.2, 0.3, 2)] };
  const text = exportScheme(l);
  const obj = JSON.parse(text);
  assert.deepEqual(Object.keys(obj.state), ['w', 'd', 'h', 'walls', 'columns', 'items']);
  assert.deepEqual(Object.keys(obj.state.columns[0]), ['id', 'x', 'z', 'w', 'd']);
  const r = importScheme(text);
  assert.equal(r.ok, true);
  assert.equal(r.nextColumnId, 3);
  assert.equal(exportScheme(r.layout), text);
  assert.equal(exportScheme(base()).includes('"columns"'), false);
});
