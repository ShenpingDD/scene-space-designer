/**
 * route-bounds.test.js —— P1 场景平移 / 缩场景拒绝
 *
 * 判据（设计决策记录 §六）：
 *  - 左/上扩场景时 anchors 与墙、设备一起 +dx/+dz，且输入 layout 不改；
 *  - 缩场景时 anchors 越界 → routes-out-of-bounds，返回 routeIndex/pointIndex，layout 不变；
 *  - 不静默夹取、不删动线。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resetParams } from '../src/params.js';
import {
  boundaryWalls, createLayout, expandSceneKeepWalls, expandToInclude, planSceneSize,
} from '../src/room.js';
import { routesOutOfBounds, translateRoutes } from '../src/route.js';

const route = () => ({ id: 1, name: '参观动线', points: [[1, 1], [2, 2]] });
const withRoute = (extra = {}) => ({
  ...createLayout({ w: 8, d: 6, h: 2.8 }),
  ...extra,
  routes: [route()],
});

test('translateRoutes：只平移 points，不改输入、保留 id/name', () => {
  resetParams();
  const routes = [route()];
  const before = JSON.stringify(routes);
  const out = translateRoutes(routes, 1, -0.5);
  assert.deepEqual(out[0].points, [[2, 0.5], [3, 1.5]]);
  assert.equal(out[0].id, 1);
  assert.equal(out[0].name, '参观动线');
  assert.equal(JSON.stringify(routes), before, '输入不能被改');
  assert.deepEqual(translateRoutes(undefined, 1, 1), []);
});

test('routesOutOfBounds：返回 0 基 routeIndex/pointIndex，含非法坐标', () => {
  resetParams();
  const routes = [
    { id: 1, points: [[1, 1], [2, 2]] },
    { id: 2, points: [[2, 2], [7, 5]] },
  ];
  assert.deepEqual(routesOutOfBounds(routes, 8, 6), []);
  assert.deepEqual(routesOutOfBounds(routes, 4, 6), [{ routeIndex: 1, pointIndex: 1 }]);
  assert.deepEqual(routesOutOfBounds([{ id: 1, points: [[1, 1], ['x', 2]] }], 8, 6), [{ routeIndex: 0, pointIndex: 1 }]);
});

test('expandSceneKeepWalls：向左/上扩时 routes 与墙、设备同 +dx/+dz', () => {
  resetParams();
  const l = withRoute();
  const before = JSON.stringify(l.routes);
  const out = expandSceneKeepWalls(l, { x0: -1, z0: -1, x1: 3, z1: 3 });
  assert.equal(out.ok, true);
  assert.equal(out.dx, 1);
  assert.equal(out.dz, 1);
  assert.equal(out.layout.w, 9);
  assert.equal(out.layout.d, 7);
  assert.deepEqual(out.layout.routes[0].points, [[2, 2], [3, 3]]);
  assert.equal(JSON.stringify(l.routes), before, '输入 layout 不变');
});

test('expandToInclude（旧语义）：同样平移 routes', () => {
  resetParams();
  const l = { ...withRoute(), roomSemantics: 'legacy' };
  const out = expandToInclude(l, { x0: -1, z0: -1, x1: 3, z1: 3 });
  assert.equal(out.ok, true);
  assert.deepEqual(out.layout.routes[0].points, [[2, 2], [3, 3]]);
});

test('planSceneSize 缩场景：routes 越界拒绝，layout 引用/内容不变，报点和序号', () => {
  resetParams();
  const l = { w: 8, d: 6, h: 2.8, walls: [], items: [], routes: [{ id: 1, points: [[7, 5], [2, 2]] }] };
  const before = JSON.stringify(l);
  const out = planSceneSize(l, { w: 4, d: 6, h: 2.8 });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'routes-out-of-bounds');
  assert.equal(out.code, 'routes-out-of-bounds');
  assert.equal(out.routeIndex, 0);
  assert.equal(out.pointIndex, 0);
  assert.deepEqual(out.routePoints, [{ routeIndex: 0, pointIndex: 0 }]);
  assert.equal(JSON.stringify(l), before, '拒绝时 layout 一个字都不改');
  assert.match(out.message, /动线/);
});

test('planSceneSize 旧语义（legacy）也先查 routes，不重建、不丢动线', () => {
  resetParams();
  const l = {
    w: 8, d: 6, h: 2.8, walls: boundaryWalls(8, 6), items: [],
    roomSemantics: 'legacy', routes: [{ id: 1, points: [[7, 5], [2, 2]] }],
  };
  const before = JSON.stringify(l);
  const out = planSceneSize(l, { w: 4, d: 6, h: 2.8 });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'routes-out-of-bounds');
  assert.equal(JSON.stringify(l), before);
});

test('planSceneSize 成功放大/缩小且 routes 全在界内：原样保留 anchors', () => {
  resetParams();
  const l = { w: 8, d: 6, h: 2.8, walls: [], items: [], routes: [{ id: 1, points: [[1, 1], [2, 2]] }] };
  const out = planSceneSize(l, { w: 10, d: 8, h: 2.8 });
  assert.equal(out.ok, true);
  assert.deepEqual(out.layout.routes, l.routes);
  assert.equal(out.layout.w, 10);
});
