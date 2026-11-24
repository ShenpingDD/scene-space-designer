/**
 * 规则 3 断言集：自动摆位 / 上限 / 夹取 / 旋转吸附
 * 基准：R1 浏览器 A/B 实测（基线 101 次点击 → 103 台；R1 → 100 台并提示）
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { cfg } from '../src/params.js';
import { createLayout } from '../src/room.js';
import { addItem, nextIdFor, moveItem, rotateItem, snapAngle, angleFromPointer, findFreeSpot, addWall, toPoint, MSG } from '../src/placement.js';
import { checkItem } from '../src/validate.js';
import { mkWallSeg, wallSeg } from '../src/wall.js';
/** 墙对象工厂（W1 起墙是对象；测试里写坐标更直观） */
const W = (x, z, xx, zz) => mkWallSeg(x, z, xx, zz);
const seg = (w) => wallSeg(w);

const CATALOG = new Map([
  ['demo-cabinet-800', { id: 'demo-cabinet-800', w: 1.15192501, d: 1.09483496, h: 1.98669948 }],
  ['demo-freezer-dual', { id: 'demo-freezer-dual', w: 0.99, d: 0.8712, h: 1.98 }],
]);
const get = (id) => CATALOG.get(id);

test('FIX-06：无位置时自动摆位（Z 优先扫描，与原型同序）', () => {
  const layout = createLayout({ w: 8, d: 6 });
  const r = addItem(layout, 'demo-cabinet-800', { getProduct: get });
  assert.equal(r.ok, true);
  assert.equal(r.item.x, 0.7);
  assert.equal(r.item.z, 0.7);
  assert.equal(r.item.r, 0);
  assert.equal(r.item.doorAmount, 0);
  assert.equal(r.layout.items.length, 1);
});

test('FIX-05：new items 自带 doorAmount，导出结构与导入端一致', () => {
  const r = addItem(createLayout({ w: 8, d: 6 }), 'demo-freezer-dual', { getProduct: get });
  assert.deepEqual(Object.keys(r.item).sort(), ['doorAmount', 'id', 'p', 'r', 'x', 'z']);
});

test('FIX-06：上限 100，第 101 台被拒且不新增（基线会堆到 103）', () => {
  let layout = createLayout({ w: 20, d: 20 });
  for (let i = 0; i < cfg.layout.maxItems; i++) {
    const r = addItem(layout, 'demo-freezer-dual', { getProduct: get });
    assert.equal(r.ok, true, `第 ${i + 1} 台应成功`);
    layout = r.layout;
  }
  const over = addItem(layout, 'demo-freezer-dual', { getProduct: get });
  assert.equal(over.ok, false);
  assert.equal(over.reason, 'limit');
  assert.equal(over.message, MSG.limit);
  assert.equal(layout.items.length, cfg.layout.maxItems);
});

test('FIX-06：扫描不到空位时拒绝新增，且原布局不被改动', () => {
  // 2.6 m 见方的设备在 3×3 房间的任何一个扫描格上都出界 → 第一次就应被拒
  const catalog = new Map([...CATALOG, ['wide', { id: 'wide', w: 2.6, d: 2.6, h: 2 }]]);
  const layout = createLayout({ w: 3, d: 3 });
  const r = addItem(layout, 'wide', { getProduct: (id) => catalog.get(id) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-space');
  assert.equal(r.layout, undefined); // 失败不返回新布局 → 调用方无从创建"空操作撤销点"
  assert.equal(layout.items.length, 0);
});

test('未知型号被拒', () => {
  const r = addItem(createLayout(), 'nope', { getProduct: get });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'unknown-product');
});

test('FIX-05：给定位置被夹取到房间内（原型允许 -1..w+1）', () => {
  const r = addItem(createLayout({ w: 8, d: 6 }), 'demo-freezer-dual', { getProduct: get, pos: { x: 99, z: -5 } });
  assert.equal(r.ok, true);
  assert.equal(r.item.x, 8);
  assert.equal(r.item.z, 0);
});

test('拖动落位同样夹取到 [0,w]×[0,d]', () => {
  const r0 = addItem(createLayout({ w: 8, d: 6 }), 'demo-freezer-dual', { getProduct: get, pos: { x: 4, z: 3 } });
  const moved = moveItem(r0.layout, r0.item.id, 12, 9);
  assert.equal(moved.items[0].x, 8);
  assert.equal(moved.items[0].z, 6);
});

test('旋转吸附 5° 且归一到 [0,360)', () => {
  assert.equal(snapAngle(92), 90);
  assert.equal(snapAngle(-3), 355);
  assert.equal(snapAngle(360), 0);
  assert.equal(snapAngle(177), 175);
});

test('指针方位 -> 角度（原型公式 atan2 + 90°，逐行对齐）', () => {
  assert.equal(angleFromPointer(0, 0, 1, 0), 90); // 正右
  assert.equal(angleFromPointer(0, 0, 0, 1), 180); // 正下
  assert.equal(angleFromPointer(0, 0, -1, 0), 270); // 正左
});

test('nextIdFor 与导入后的恢复口径一致', () => {
  assert.equal(nextIdFor({ items: [] }), 1);
  assert.equal(nextIdFor({ items: [{ id: 4 }, { id: 6 }] }), 7);
});

test('findFreeSpot 在放不下时返回 null（不返回"最后一个试过的格子"）', () => {
  const layout = createLayout({ w: 3, d: 3 });
  layout.items = Array.from({ length: 4 }, (_, k) => ({ id: k + 1, p: 'demo-cabinet-800', x: 1.5, z: 1.5, r: 0, doorAmount: 0 }));
  assert.equal(findFreeSpot(layout, { id: 9, p: 'demo-cabinet-800', x: 0, z: 0, r: 0 }, get), null);
});

/* -------- 画墙：坐标形状与非法值（真事故的回归护栏） -------- */

test('addWall 接受 [x,z] 数组写法（界面用的就是这种）', () => {
  const r = addWall(createLayout({ w: 8, d: 6 }), [0.5, 4.2], [7.5, 4.2]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.layout.walls.at(-1), W(0.5, 4.2, 7.5, 4.2));
});

test('addWall 也接受 {x,z} 写法，两种写法结果一致', () => {
  const a = addWall(createLayout({ w: 8, d: 6 }), { x: 0.5, z: 4.2 }, { x: 7.5, z: 4.2 });
  const b = addWall(createLayout({ w: 8, d: 6 }), [0.5, 4.2], [7.5, 4.2]);
  assert.deepEqual(a.layout.walls, b.layout.walls);
});

test('坐标非法必须被拒 —— 绝不能写入 NaN 墙（否则整房间设备全被误报碰墙）', () => {
  const layout = createLayout({ w: 8, d: 6 });
  const bad = addWall(layout, [undefined, undefined], [undefined, undefined]);
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'bad-point');
  assert.equal(bad.layout, undefined);
  assert.equal(layout.walls.length, 4, '拒绝时不得改动布局');
  assert.equal(toPoint({ x: NaN, z: 1 }), null);
});

test('画墙按 15° 档吸附：大致水平就真的是水平，大致垂直就真的是垂直', () => {
  // 原实现是「投影到主轴」→ 永远横平竖直；现在是 15° 档（0/15/30…），所以
  // 「大致水平」仍然落到 0°，「大致垂直」落到 90° —— 手感没变，多了斜墙。
  const h = addWall(createLayout({ w: 8, d: 6 }), [1, 2], [6, 2.3]).layout.walls.at(-1);
  assert.equal(seg(h)[3], 2, '大致水平 → z 必须对齐');
  assert.ok(Math.abs(seg(h)[2] - 6) < 0.02, `只转方向，长度不变：${JSON.stringify(h)}`);
  const v = addWall(createLayout({ w: 8, d: 6 }), [1, 2], [1.2, 5]).layout.walls.at(-1);
  assert.equal(seg(v)[2], 1, '大致垂直 → x 必须对齐');
  assert.ok(Math.abs(seg(v)[3] - 5) < 0.02, `只转方向，长度不变：${JSON.stringify(v)}`);
});

test('⭐ 斜墙：两点之间的直墙就是直墙，不再被按回横平竖直', () => {
  const r = addWall(createLayout({ w: 8, d: 6 }), [1, 1], [5, 4]);
  assert.equal(r.ok, true);
  const w = r.layout.walls.at(-1);
  const [wx, wz, wxx, wzz] = seg(w);
  const deg = (Math.atan2(wzz - wz, wxx - wx) * 180) / Math.PI;
  // 端点按毫米取整 → 允许亚毫米级偏差（测的是规则，不是浮点位）
  const off = Math.min(Math.abs(deg % 15), 15 - Math.abs(deg % 15));
  assert.ok(off < 0.5, `方向必须落在 15° 档上：${deg}`);
  assert.ok(Math.abs(Math.hypot(wxx - wx, wzz - wz) - 5) < 0.002, '长度不变（只转方向）');
  assert.ok(Math.abs(wzz - wz) > 1, '斜墙的 z 必须变（否则又被按回水平了）');
});

test('⭐ Shift（free）：一点都不吸，用户说了算', () => {
  const free = addWall(createLayout({ w: 8, d: 6 }), [1, 1], [5, 3.7], { free: true });
  assert.deepEqual(free.layout.walls.at(-1), W(1, 1, 5, 3.7));
  const snapped = addWall(createLayout({ w: 8, d: 6 }), [1, 1], [5, 3.7]);
  assert.notDeepEqual(snapped.layout.walls.at(-1), W(1, 1, 5, 3.7), '不按 Shift 就该吸附');
});

test('吸附不会把墙端点推出房间（否则自己生成的文件自己读不了）', () => {
  const r = addWall(createLayout({ w: 8, d: 6 }), [4, 3], [8.4, 6.4]);
  const w = r.layout.walls.at(-1);
  assert.ok(seg(w)[2] >= 0 && seg(w)[2] <= 8 && seg(w)[3] >= 0 && seg(w)[3] <= 6, `端点出界：${JSON.stringify(w)}`);
});

test('太短的墙被拒，并给出可读文案', () => {
  const r = addWall(createLayout({ w: 8, d: 6 }), [1, 2], [1.05, 2]);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'too-short');
  assert.equal(r.message, MSG.wallTooShort);
});

test('真正的回归：一面远处的内墙不得影响远处设备', () => {
  const layout = addWall(createLayout({ w: 8, d: 6 }), [0.5, 4.2], [7.5, 4.2]).layout;
  const item = { id: 4, p: 'demo-cabinet-800', x: 0.7, z: 0.7, r: 0, doorAmount: 0 };
  assert.deepEqual(checkItem(layout, item, get), null, 'z=0.7 的设备不应被 z=4.2 的墙判碰墙');
});

test('⭐ 位置精度到毫米（用户反馈：只能输一位小数 = 差几厘米）', () => {
  const r0 = addItem(createLayout({ w: 8, d: 6 }), 'demo-freezer-dual', { getProduct: get, pos: { x: 4, z: 3 } });
  // 1.056 m = 1056 mm：必须**原样保留**，不许像以前那样取整成 1.1
  const moved = moveItem(r0.layout, r0.item.id, 1.056, 2.345);
  assert.equal(moved.items[0].x, 1.056);
  assert.equal(moved.items[0].z, 2.345);
  // 毫米以下（0.0004 m = 0.4 mm）才收 —— 收的是"看不见的浮点长尾"，不是用户能输入的量
  const sub = moveItem(r0.layout, r0.item.id, 1.0565, 1.0564);
  assert.equal(sub.items[0].x, 1.057, '超过半毫米进位');
  assert.equal(sub.items[0].z, 1.056, '不到半毫米舍去');
});

test('取整与夹取的顺序：先取整再夹，别把值"顶"到房间外面', () => {
  // 房间 7.9995 宽（毫米精度的小数尺寸）：先夹到 7.9995 再取整会变成 8.0 → 出界 0.5 mm
  const layout = createLayout({ w: 7.9995, d: 6 });
  const r0 = addItem(layout, 'demo-freezer-dual', { getProduct: get, pos: { x: 4, z: 3 } });
  const moved = moveItem(r0.layout, r0.item.id, 99, 3);
  // 只断"没被顶出房间"这一件事 —— 夹取是坐标夹取，不承诺"这一台摆得下"
  // （设备有占地尺寸，贴边时四角会出界，那是 validate 的活，不是 clamp 的活）。
  assert.ok(moved.items[0].x <= 7.9995, `夹取后不得超出房间：${moved.items[0].x}`);
  assert.equal(moved.items[0].z, 3);
});
