/**
 * viewport.test.js —— 视口数学的断言
 *
 * 这些东西"跑起来才知道对不对"的概率极高（差一个系数、差一个符号，界面只表现为"图在乱跑"），
 * 所以先把结论钉死：100% 的定义、锚点不动、下限=适配、平移方向。
 * 运行：npm --prefix app test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PX_PER_M, MARGIN_M, ZOOM_MAX, fitView, fitZoom, viewBoxOf, roomAt, zoomAt, panBy, focusZoom, clampZoom } from '../src/viewport.js';

const SIZE = { w: 640, d: 480 };
const ROOM = { w: 4, d: 3 };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test('① 100% 就是 1 m = 64 px：zoom=1 时 viewBox 与容器等大', () => {
  const vb = viewBoxOf({ view: { zoom: 1, cx: 2, cz: 1.5 }, size: SIZE });
  assert.equal(vb.w, 640);
  assert.equal(vb.d, 480);
  assert.equal(vb.x, 2 * PX_PER_M - 320);
});

test('② viewBox 宽高比恒等于容器宽高比 —— 所以 meet 的系数正好是 zoom，没有留白、没有二次缩放', () => {
  for (const zoom of [0.3, 1, 2.5, 8]) {
    const vb = viewBoxOf({ view: { zoom, cx: 2, cz: 1.5 }, size: SIZE });
    assert.ok(near(vb.w / vb.d, SIZE.w / SIZE.d, 1e-12), '宽高比 zoom=' + zoom);
    assert.ok(near(SIZE.w / vb.w, zoom, 1e-12), 'k === zoom，zoom=' + zoom);
  }
});

test('③ 适配：整间房 + 四周留白都装得下，而且房间正中落在视口正中', () => {
  const v = fitView({ room: ROOM, size: SIZE });
  const vb = viewBoxOf({ view: v, size: SIZE });
  assert.ok(vb.x <= -MARGIN_M * PX_PER_M + 1e-9);
  assert.ok(vb.y <= -MARGIN_M * PX_PER_M + 1e-9);
  assert.ok(vb.x + vb.w >= (ROOM.w + MARGIN_M) * PX_PER_M - 1e-9);
  assert.ok(vb.y + vb.d >= (ROOM.d + MARGIN_M) * PX_PER_M - 1e-9);
  const c = roomAt({ view: v, size: SIZE, fx: 0.5, fz: 0.5 });
  assert.ok(near(c.x, 2) && near(c.z, 1.5), '居中');
});

test('④ 滚轮缩放：锚点下面的房间点一动不动（这是唯一的正确性要求）', () => {
  const v0 = fitView({ room: ROOM, size: SIZE });
  const before = roomAt({ view: v0, size: SIZE, fx: 0.2, fz: 0.8 });
  for (const f of [1.2, 1.2, 0.5, 1.7]) {
    const v1 = zoomAt({ view: v0, size: SIZE, fx: 0.2, fz: 0.8, factor: f, min: 0 });
    const after = roomAt({ view: v1, size: SIZE, fx: 0.2, fz: 0.8 });
    assert.ok(near(after.x, before.x, 1e-9) && near(after.z, before.z, 1e-9), 'factor=' + f);
  }
});

test('⑤ zoom 夹取：下限就是适配（不许比"看得见全貌"更小），上限 ZOOM_MAX', () => {
  const v0 = fitView({ room: ROOM, size: SIZE });
  const min = fitZoom({ room: ROOM, size: SIZE });
  assert.equal(zoomAt({ view: v0, size: SIZE, fx: 0.5, fz: 0.5, factor: 0.01, min }).zoom, min);
  assert.equal(zoomAt({ view: v0, size: SIZE, fx: 0.5, fz: 0.5, factor: 1e6, min }).zoom, ZOOM_MAX);
  assert.equal(clampZoom(999), ZOOM_MAX);
});

test('⑥ 平移方向：向右拖，图跟着手走（中心往左），位移量与 zoom 成反比', () => {
  const v = panBy({ view: { zoom: 1, cx: 2, cz: 1.5 }, dx: 64, dz: -32 });
  assert.ok(near(v.cx, 1) && near(v.cz, 2));
  const v2 = panBy({ view: { zoom: 2, cx: 2, cz: 1.5 }, dx: 64, dz: 0 });
  assert.ok(near(v2.cx, 1.5), '放大两倍 → 同样的手指位移，图上走得少一半');
});

test('⑦ 聚焦：小箱子和大家伙占屏幕的"主角感"一致，且不越界', () => {
  const small = focusZoom({ rect: { w: 0.5, d: 0.6 }, size: SIZE });
  const large = focusZoom({ rect: { w: 1.2, d: 1.0 }, size: SIZE });
  assert.ok(small > large, '小的要放得更大');
  assert.ok(near(small, Math.min(SIZE.w, SIZE.d) / 3 / (0.6 * PX_PER_M)));
  assert.ok(focusZoom({ rect: { w: 50, d: 50 }, size: SIZE }) > 0);
});

test('⑧ 容器还没量到尺寸时不许返回 0 / NaN（否则 viewBox 会变成 "0 0 NaN NaN" 整屏空白）', () => {
  assert.equal(fitZoom({ room: ROOM, size: { w: 0, d: 0 } }), 1);
  assert.equal(focusZoom({ rect: { w: 1, d: 1 }, size: { w: 0, d: 0 } }), 1);
});
