/**
 * openings-ui.test.js —— W1 门洞在前端这一侧：平面图怎么画、动作怎么走
 *
 * 这一组的重点是**界面不许自己算几何**：
 *   · 平面图的缺口、门框线、净宽读数全部来自 `scene2d` 从内核拿的那一份；
 *   · 动作（放/删/改）只允许调 `designer`，夹取与提示由内核出话。
 * 3D 侧（过梁、合批、走穿）不在这里 —— 它要真的 WebGL，由真机探针管（见 docs/72）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { scene2d, walls2d } from '../src/scene2d.js';
import { boundaryWalls } from '@core/room.js';
import { mkWallSeg, openingsOf } from '@core/wall.js';
import { cfg } from '@core/params.js';
import { placeOpening } from '@core/openings.js';

const layoutWithDoor = () => {
  const inner = mkWallSeg(4, 0.5, 4, 5.5);
  const l = { w: 8, d: 6, h: 2.8, walls: [...boundaryWalls(8, 6), inner], items: [] };
  const r = placeOpening(l, 4, { at: 2.5, w: 0.9, h: 2.1 });
  assert.equal(r.ok, true, r.message);
  return r.layout;
};

test('平面图：有门洞的墙画成**两段**（缺口真的断开了，不是拿地板色盖上去的）', () => {
  const l = layoutWithDoor();
  const w = walls2d(l).find((x) => x.index === 4);
  assert.equal(w.blocks.length, 2, '两个实心段');
  assert.equal(w.openingCount, 1);
  // 路径里"起笔"的次数 = 子路径数（每段一个 M）
  assert.equal((w.d.match(/M/g) ?? []).length, 2, `路径应有两条子路径：${w.d}`);
  assert.equal(w.corners.length >= 4, true, 'corners 仍是整块构件（判据拿它比形状）');
});

test('平面图：门洞读数就是 state 里的净宽（同一个数，不是估算）', () => {
  const l = layoutWithDoor();
  const s = scene2d(l);
  assert.equal(s.openings.length, 1);
  const o = s.openings[0];
  assert.equal(o.width, l.walls[4].openings[0].w);
  assert.equal(o.wallIndex, 4);
  assert.equal(o.short, '0.90 m');
  assert.ok(o.quad.length === 4, '命中区是洞口那块矩形');
  assert.ok(o.text.includes('净宽') && o.text.includes('净高'), '读屏文案要说全');
});

test('平面图：洞口标记与 state 对得上（墙上几个洞就画几个）', () => {
  const l = layoutWithDoor();
  // 第二个洞放到外墙上（T 面，长 8 m）—— 外墙开门洞同样合法
  const again = placeOpening(l, 0, { at: 3, w: 1.2, h: 2.1 });
  assert.equal(again.ok, true, again.message);
  const s = scene2d(again.layout);
  assert.equal(s.openings.length, 2);
  const total = again.layout.walls.reduce((n, w) => n + openingsOf(w).length, 0);
  assert.equal(s.openings.length, total, '画出来的标记数必须等于墙上真有的门洞数');
});

test('平面图：没有门洞的墙照旧是**一整段**（零回归：路径与以前一样一个 M）', () => {
  const l = { w: 8, d: 6, h: 2.8, walls: boundaryWalls(8, 6), items: [] };
  const w = walls2d(l)[0];
  assert.equal(w.blocks.length, 1);
  assert.equal((w.d.match(/M/g) ?? []).length, 1);
  assert.equal(w.openingCount, 0);
  assert.deepEqual(w.openings, []);
});

/* ---------------- 窗（W2）：平面图画法（**走 scene2d 真路径**） ---------------- */

const layoutWithWindow = () => {
  const inner = mkWallSeg(4, 0.5, 4, 5.5);
  const l = { w: 8, d: 6, h: 2.8, walls: [...boundaryWalls(8, 6), inner], items: [] };
  const r = placeOpening(l, 4, { at: 2.5, w: 1.2, h: 1.5, sill: 0.9, kind: 'window' });
  assert.equal(r.ok, true, r.message);
  return r.layout;
};

test('⭐ 平面图：有**窗**的墙**不断**（一条子路径）+ 画三线符号', () => {
  const w = walls2d(layoutWithWindow()).find((x) => x.index === 4);
  // 变异点：`scene2d.js` 传 `openingsOf(wall)` 而不是 `doorOpenings(wall)` → 这里变 2 条，立刻红
  assert.equal(w.blocks.length, 1, '窗在顶视图里不断墙身 —— 断开的墙＝「这儿能过去」');
  assert.equal((w.d.match(/M/g) ?? []).length, 1, `路径应只有一条子路径：${w.d}`);
  const o = w.openings[0];
  assert.equal(o.kind, 'window');
  assert.ok(o.sashPath, '第三线（沿墙中线的窗线）必须在');
  assert.equal((o.sashPath.match(/M/g) ?? []).length, 1, '窗线是一条线段');
});

test('⭐ 成对：同一面墙、同一个 `at` —— 门**断**（两条子路径）、窗**不断**（一条）', () => {
  const dW = walls2d(layoutWithDoor()).find((x) => x.index === 4);
  const wW = walls2d(layoutWithWindow()).find((x) => x.index === 4);
  assert.equal((dW.d.match(/M/g) ?? []).length, 2, '门必须还是断的（另一条变异：把门也改成不断）');
  assert.equal((wW.d.match(/M/g) ?? []).length, 1);
  assert.equal(wW.corners.length, dW.corners.length, '两种情况下「整块构件」是同一份（判据拿它比形状）');
});

test('平面图：窗与门的 `short` **同一种格式**（只写净宽）；完整离地仍留在 openingLabel / Inspector', () => {
  const wW = walls2d(layoutWithWindow()).find((x) => x.index === 4).openings[0];
  const dW = walls2d(layoutWithDoor()).find((x) => x.index === 4).openings[0];
  // 用户第三轮 验收：放窗后平面图上的「0.90 m · 离地 1.20」太长 —— 放完之后只想知道宽度，
  // 所以可视标签只留净宽，和门逐字同一种格式。
  // 注释：完整离地信息仍在 openingLabel（`short` 的兄弟字段）与 Inspector 的离地编辑里，
  // 这一处改的只是平面图上那一行可视读数，不是删信息。旧断言 /离地 0\.90/ 已按新需求更新。
  assert.equal(wW.short, '1.20 m', '窗的读数只写净宽，不再拼离地');
  assert.equal(dW.short, '0.90 m');
  assert.doesNotMatch(wW.short, /离地/, '平面图可视标签里不该再有离地');
  // 信息没丢：读屏文案（= openingLabel）照旧带离地；门的文案与 W1 逐字相同
  assert.match(wW.text, /离地 0\.90 m/, '完整离地在 openingLabel 里');
  assert.match(wW.text, /^窗 /);
  assert.match(dW.text, /^门洞 /);
});

test('平面图：墙厚变了，门框线的跨度跟着变（几何来自参数表，界面不写死）', () => {
  const l = layoutWithDoor();
  const before = scene2d(l).openings[0].quad;
  const span = Math.hypot(before[1][0] - before[0][0], before[1][1] - before[0][1]);
  assert.ok(Math.abs(span - cfg.space.wallThicknessM) < 1e-9, `门框跨度应等于墙厚：${span}`);
});