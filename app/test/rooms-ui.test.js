/**
 * rooms-ui.test.js —— M1 多房间在**界面这一侧**的判据（纯函数可测的那部分）
 *
 * 这里只测"算得出来、能断言"的东西：2D 房间层、打印版平面图、交付清单的房间列、面客页的话。
 * 点击/拖拽那类手势由真机探针管（`logs/cdp-rooms.mjs`）—— 那是另一条线，不能互相代替。
 *
 * 规矩照旧：每条都写清**变异点**（怎么改会让它变红）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boundaryWalls } from '@core/room.js';
import { roomsOf, pointInPoly } from '@core/rooms.js';
import { rooms2d, scene2d } from '../src/scene2d.js';
import { planSvg } from '../src/planSvg.js';
import { roomMapOf, buildRequest } from '../src/delivery.js';
import { barText, roomHint } from '../src/present.js';

const W = (x, z, xx, zz) => ({ a: [x, z], b: [xx, zz], openings: [] });
const P = { w: 1.2, d: 1.1, h: 1.9, model: 'DEMO-1', name: '测试箱', color: '#336699' };
const layout = ({ extra = [], items = [], roomLabels } = {}) => ({
  w: 8, d: 6, h: 2.8,
  walls: [...boundaryWalls(8, 6), ...extra],
  items,
  ...(roomLabels ? { roomLabels } : {}),
});

/* ---------------- 2D 房间层 ---------------- */

test('2D 房间层：一间房时是 1 块面；一刀两间时是 2 块，名字与面积都来自内核', () => {
  const one = rooms2d(layout());
  assert.equal(one.length, 1);
  assert.equal(Math.round(one[0].area), 48);
  assert.equal(one[0].displayName, '未命名房间');
  assert.ok(one[0].d.startsWith('M'), '要有可画的路径');

  const two = rooms2d(layout({ extra: [W(4, 0, 4, 6)] }));
  assert.equal(two.length, 2);
  // 变异点：界面自己算面积/形心（不经内核）→ 与内核读数不一致，这条与内核用例一起红
  assert.deepEqual(two.map((r) => Math.round(r.area)), [24, 24]);
  for (const r of two) assert.ok(pointInPoly(r.poly, r.at), '名字要落在自己的房里（凹口形房间靠内核退让）');
});

test('2D 场景把房间层与墙面一起给出：房面路径非空、名字层可用', () => {
  const s = scene2d(layout({ extra: [W(4, 0, 4, 6)] }));
  assert.equal(s.rooms.length, 2);
  assert.equal(s.walls.length, 5);
  for (const r of s.rooms) assert.ok(r.d.length > 8);
});

test('房间名进 2D：命名了就显示名字，没命名显示「未命名房间」', () => {
  const base = layout({ extra: [W(4, 0, 4, 6)] });
  const id = roomsOf(base)[0].id;
  const named = rooms2d({ ...base, roomLabels: { [id]: '冰箱间' } });
  assert.equal(named[0].displayName, '冰箱间');
  assert.equal(named[1].displayName, '未命名房间');
});

/* ---------------- 打印版平面图 ---------------- */

test('打印版平面图：两间起才写房间名与「N 间房」；一间房时不写那些废话', () => {
  const one = planSvg(layout({ items: [] }), { name: '单间' });
  assert.ok(!one.includes('间房'), '一间房时不该写"1 间房"');
  assert.ok(!one.includes('未命名房间'), '一间房时不该把默认名铺在图上');

  const two = planSvg(layout({ extra: [W(4, 0, 4, 6)] }), { name: '两间' });
  // 变异点：忘了把 rooms 带进打印版 → 施工队手上的图纸上没有房间，这条红
  assert.ok(two.includes('2 间房'), '多房间要在标题块里报间数');
  assert.ok(two.includes('未命名房间'), '没命名的房间也要有名字（不是编号）');
  assert.ok(two.includes('整栋 8000 × 6000'), '整栋尺寸的口径要说清（不是某一间）');
});

test('打印版平面图：房间名里的 & 与 < 必须转义（不然整张图打不开）', () => {
  const base = layout({ extra: [W(4, 0, 4, 6)] });
  const id = roomsOf(base)[0].id;
  const svg = planSvg({ ...base, roomLabels: { [id]: 'A&B <测试>' } }, { name: 'X&Y' });
  assert.ok(svg.includes('A&amp;B &lt;测试&gt;'), '房名要转义');
  assert.ok(!/<测试>/.test(svg), '不许出现生标签');
  // 变异点：直接拼字符串不转义 → 上面两条立刻红（而且导出的 SVG 在浏览器里真的打不开）
});

/* ---------------- 交付清单（房间列） ---------------- */

test('交付清单的房间列：按中心点归属；落在墙上/房外如实写「未分房间」', () => {
  const base = layout({
    extra: [W(4, 0, 4, 6)],
    items: [
      { id: 1, p: 'dw', x: 1, z: 1, r: 0 },      // 左间
      { id: 2, p: 'dw', x: 6, z: 1, r: 0 },      // 右间
      { id: 3, p: 'dw', x: 4, z: 3, r: 0 },      // 正落在隔墙上
      { id: 4, p: 'dw', x: 20, z: 20, r: 0 },    // 整栋之外（手改文件才会这样）
    ],
  });
  const rooms = roomsOf(base);
  const map = roomMapOf({ ...base, roomLabels: { [rooms[0].id]: '冰箱间' } });
  assert.equal(map['1'], '冰箱间');
  assert.equal(map['2'], '未命名房间');
  assert.equal(map['3'], '未分房间', '落在墙上不挑一间硬塞');
  assert.equal(map['4'], '未分房间', '房外也不硬塞');
  // 变异点：把"归属不明"过滤掉（少一行）→ 交付清单会静默少一台设备，这条红
  assert.equal(Object.keys(map).length, base.items.length, '每台设备都要有一行');
});

test('交付请求带房间列（缺省也要给一个空对象，形状稳定）', () => {
  const req = buildRequest({
    rev: 3, items: ['json'], withAssets: false, note: '', planSvg: '<svg/>',
    shots: ['a', 'b', 'c'], rooms: { 1: '冰箱间' },
  });
  assert.deepEqual(req.rooms, { 1: '冰箱间' });
  const noRooms = buildRequest({
    rev: 3, items: ['json'], withAssets: false, note: '', planSvg: '<svg/>', shots: ['a', 'b', 'c'],
  });
  assert.deepEqual(noRooms.rooms, {});
});

/* ---------------- 面客页的话 ---------------- */

test('面客页信息条：一间房不报间数；多房间报间数；聚焦了就说明是哪一间', () => {
  const one = barText({ name: '冷藏库', count: 5, roomCount: 1 });
  assert.equal(one.countText, '5 台设备');
  assert.equal(one.focusedText, '');

  const two = barText({ name: '冷藏库', count: 5, roomCount: 3, focusedRoom: '冰箱间' });
  assert.equal(two.countText, '5 台设备 · 3 间房');
  assert.equal(two.focusedText, '已聚焦「冰箱间」');
});

test('面客页的点击提示：一间房不出现（没有第二间可切，那句话只会让人白点）', () => {
  assert.equal(roomHint(1), '');
  assert.equal(roomHint(0), '');
  const two = roomHint(2);
  assert.ok(two.includes('聚焦'), two);
  const focused = roomHint(2, { focused: '冰箱间' });
  assert.ok(focused.includes('第一人称'), '已经聚焦了就该告诉他"想去看看就进第一人称"');
  // 变异点：把提示写成工程师话（"支持房间切换"）→ 客户不知道点哪儿 —— 这句话必须说动作
  assert.ok(roomHint(2, { coarse: true }).startsWith('点一下房间'));
});