/**
 * windows.test.js —— W2 矩形窗：数据形状 / 几何（窗下墙）/ **不可通行** / 校验 / 夹取 / 兼容
 *
 * 每条判据都写清**变异点**（怎么改代码会让它变红）—— 本项目的规矩：
 * 「永远绿的用例比没有用例更坏」。
 *
 * ⭐ 本批最要紧的两条（都按**成对**写，只留一条就能被蒙过去）：
 *   ① **窗不能走人**：门洞里能走、**窗洞里走不过去**（`wallSolidSegments` 只按门切）；
 *   ② **2D 只有门断墙身**：窗在平面图上不断墙（断了就在说「这儿能过去」）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cfg, configure, resetParams } from '../src/params.js';
import { mkWallSeg, openingsOf, kindOf, sillOf } from '../src/wall.js';
import { createLayout, applyRoomSize } from '../src/room.js';
import { wallPieces, polyArea } from '../src/wallpieces.js';
import { blocked } from '../src/collision.js';
import { exportScheme, importScheme } from '../src/scheme.js';
import {
  placeOpening, removeOpening, updateOpening, fitOpening, openingSpans, wallSolidSegments, solidBlocks,
  checkWallOpenings, inspectOpening, openingMarks, openingLabel,
  doorOpenings, windowOpenings, OPENING_REASON, MSG,
} from '../src/openings.js';

const get = (id) => (id === 'demo-cabinet-800' ? { w: 1.2, d: 1.1, h: 1.99, model: 'demo-cabinet-800', doors: [] } : undefined);
/** 8×6 的房间 + 一面内墙（墙序号 4）：内墙 (4,0.5)→(4,5.5)，`at=2.5` → 世界坐标 z=3.0 */
const INNER = 4;
const roomWithInner = () => {
  const l = createLayout({ w: 8, d: 6, h: 2.8 });
  return { ...l, walls: [...l.walls, mkWallSeg(4, 0.5, 4, 5.5)] };
};
/** 同一面内墙上放一个洞口（门或窗），其余参数默认 */
const withHole = (want) => {
  const r = placeOpening(roomWithInner(), INNER, want);
  assert.equal(r.ok, true, r.message);
  return r.layout;
};
const piece = (l) => wallPieces(l).pieces.find((q) => q.index === INNER);

/* ---------------- 数据形状（写法冻结） ---------------- */

test('门**不写** `kind`/`sill`（老方案的字节逐字不变）；窗写，且顺序是 at/w/h/kind/sill', () => {
  resetParams();
  const door = withHole({ at: 2.5, w: 0.9, h: 2.1 });
  assert.deepEqual(Object.keys(openingsOf(door.walls[INNER])[0]), ['at', 'w', 'h'],
    '门的键一个都不能多 —— `kind` 只在窗上写（零回归的前提）');
  const win = withHole({ at: 2.5, w: 1.2, h: 1.5, sill: 0.9, kind: 'window' });
  assert.deepEqual(Object.keys(openingsOf(win.walls[INNER])[0]), ['at', 'w', 'h', 'kind', 'sill'],
    '键顺序也是逐字节比对的一部分（与 Java `Scheme.wallJson` 必须同序）');
});

test('缺省即门 / 认不得的 kind 也当门（与 wallstyle 的「认不得的档位当没写」同规矩）', () => {
  assert.equal(kindOf({ at: 1, w: 1, h: 1 }), 'door');
  assert.equal(kindOf({ at: 1, w: 1, h: 1, kind: 'skylight' }), 'door', '不报错、不猜、不回就近值');
  assert.equal(kindOf({ at: 1, w: 1, h: 1, kind: 'window' }), 'window');
  assert.equal(sillOf({ at: 1, w: 1, h: 1 }), 0, '门恒 0（哪怕身上挂着一个多余的 sill）');
  assert.equal(sillOf({ at: 1, w: 1, h: 1, kind: 'window', sill: 1.1 }), 1.1);
});

test('⭐ 改房间尺寸**不许把窗降级成落地洞**（设计决策记录第 4 处窄门，最难发现的一处）', () => {
  resetParams();
  // ⚠️ 必须**两条路径各测一次** —— 它们修的不是同一个地方（第一次只测了内墙，
  //    变异验证当场把它证伪了：内墙走 `cloneWall`，那条路本来就没病）：
  //    · **外墙**走 `boundaryWithOpenings`（就是那处手抄 `{at,w,h}` 的窄门）
  //    · 内墙走 `cloneWall`
  const l0 = createLayout({ w: 12, d: 9, h: 2.8 });
  const r0 = placeOpening(l0, 0, { at: 3, w: 1.2, h: 1.5, sill: 0.9, kind: 'window' });   // 底边外墙
  assert.equal(r0.ok, true, r0.message);
  const r = applyRoomSize(r0.layout, { w: 14, d: 9, h: 2.8 });
  assert.equal(r.ok, true, r.error);
  const o = openingsOf(r.layout.walls[0])[0];
  // 变异点：`room.js` 里 `keep.map(cloneOpening)` 改回手抄 `{at,w,h}` → 这两条立刻红
  assert.equal(kindOf(o), 'window', '窗被降级成门也算丢数据 —— 洞口**个数还是 1**，肉眼看不出来');
  assert.equal(sillOf(o), 0.9);

  const l1 = withHole({ at: 2.5, w: 1.2, h: 1.5, sill: 0.9, kind: 'window' });
  const r1 = applyRoomSize(l1, { w: 10, d: 7, h: 2.8 });
  assert.equal(r1.ok, true, r1.error);
  const o1 = openingsOf(r1.layout.walls[INNER])[0];
  assert.equal(kindOf(o1), 'window', '内墙那条路径（cloneWall）也不许丢');
  assert.equal(sillOf(o1), 0.9);
});

/* ---------------- 几何：窗下墙 ---------------- */

test('窗下墙：窗产出一块 `kind:"sill"`（base 0 / 高 = 离地）；门不产', () => {
  resetParams();
  const p = piece(withHole({ at: 2.5, w: 1.2, h: 1.5, sill: 0.9, kind: 'window' }));
  const sill = solidBlocks(p, openingsOf(p.wall)).filter((b) => b.kind === 'sill');
  assert.equal(sill.length, 1, '洞正下方那一截墙必须真的建出来（不建就是「窗底下是空的」）');
  assert.equal(sill[0].base, 0);
  assert.equal(sill[0].height, 0.9);
  const doorP = piece(withHole({ at: 2.5, w: 0.9, h: 2.1 }));
  assert.equal(solidBlocks(doorP, openingsOf(doorP.wall)).filter((b) => b.kind === 'sill').length, 0,
    '门没有窗下墙（sill 恒 0 → 零高块本来就被 `push` 丢掉）');
});

test('⭐ 竖直守恒：窗下墙 + 洞高 + 过梁 == 墙高（分割不重不漏）', () => {
  resetParams();
  const l = withHole({ at: 2.5, w: 1.2, h: 1.5, sill: 0.9, kind: 'window' });
  const p = piece(l);
  const o = openingsOf(l.walls[INNER])[0];
  const s = solidBlocks(p, openingsOf(p.wall));
  const sill = s.find((b) => b.kind === 'sill');
  const lintel = s.find((b) => b.kind === 'lintel');
  const sum = sill.height + o.h + lintel.height;
  // 变异点：过梁的 base 忘改（仍用洞高）→ 洞高那一截被算两次，这里立刻红
  assert.ok(Math.abs(sum - p.h) < 1e-9,
    `窗下墙 ${sill.height} + 洞高 ${o.h} + 过梁 ${lintel.height} = ${sum}，墙高 ${p.h}`);
});

test('过梁的 base = 离地 + 洞高（门的就是洞高 —— 零回归）', () => {
  resetParams();
  const wp = piece(withHole({ at: 2.5, w: 1.2, h: 1.5, sill: 0.9, kind: 'window' }));
  const lintel = solidBlocks(wp, openingsOf(wp.wall)).find((b) => b.kind === 'lintel');
  assert.equal(lintel.base, 2.4);
  assert.ok(Math.abs(lintel.height - (2.8 - 2.4)) < 1e-9);
  const dp = piece(withHole({ at: 2.5, w: 0.9, h: 2.1 }));
  assert.equal(solidBlocks(dp, openingsOf(dp.wall)).find((b) => b.kind === 'lintel').base, 2.1);
});

test('贴顶的窗**不产**零高过梁（NaN 会被 merge 吞进去，现场表现为「墙没了」）', () => {
  resetParams();
  const l = withHole({ at: 2.5, w: 1.2, h: 1.3, sill: 1.5, kind: 'window' });   // 1.5 + 1.3 = 2.8
  const p = piece(l);
  const s = solidBlocks(p, openingsOf(p.wall));
  assert.equal(s.filter((b) => b.kind === 'lintel').length, 0);
  assert.ok(s.every((b) => b.height > 1e-9), '一块零高的都不许有');
  assert.equal(s.filter((b) => b.kind === 'sill')[0].height, 1.5);
});

test('水平守恒照旧：实心段面积 + 洞的面积 == 构件面积（窗也一样）', () => {
  resetParams();
  const l = withHole({ at: 2.5, w: 1.2, h: 1.5, sill: 0.9, kind: 'window' });
  const p = piece(l);
  const t = cfg.space.wallThicknessM;
  const blocks = solidBlocks(p, openingsOf(p.wall), { lintel: false });
  // ⚠️ 窗比门多一块：`{lintel:false}` 只去掉过梁，**窗下墙仍然产**（它就是洞口那一条带）
  assert.equal(blocks.length, 3, '左右两段 + 一块窗下墙');
  assert.equal(blocks.filter((b) => b.kind === 'sill').length, 1);
  // 口径与门那条判据逐字相同：**左边两段 + 洞口那一条带 == 整块构件**（面积都取绝对值）
  const side = blocks.filter((b) => b.openingIndex < 0).reduce((n, b) => n + Math.abs(polyArea(b.poly)), 0);
  const hole = 1.2 * t;   // 洞在平面上是一条 1.2 × 墙厚 的矩形
  assert.ok(Math.abs(side + hole - Math.abs(polyArea(p.poly))) < 1e-9, '实心 + 洞 ≠ 构件');
  // 另一条等价的说法：把窗下墙算进去，三块就正好铺满构件（不重不漏）
  const all = blocks.reduce((n, b) => n + Math.abs(polyArea(b.poly)), 0);
  assert.ok(Math.abs(all - Math.abs(polyArea(p.poly))) < 1e-9, '三块铺满 ≠ 构件面积');
});

/* ---------------- ⭐ 不可通行（成对） ---------------- */

test('⭐ 窗**不能走人**：窗洞正中照旧挡人（同一面墙、同一点位，门是能走的）', () => {
  resetParams();
  const win = withHole({ at: 2.5, w: 1.2, h: 1.5, sill: 0.9, kind: 'window' });
  const door = withHole({ at: 2.5, w: 0.9, h: 2.1 });
  // 洞口正中：世界坐标 (4, 3.0)（内墙沿 z，a 端在 z=0.5，at=2.5）
  // 变异点：`wallSolidSegments` 用 `openingSpans` 而不是 `doorSpans` → 第一条立刻红
  assert.equal(blocked(4, 3, win, get), true, '窗那一块墙是**实心**的 —— 人不能从窗里出去');
  assert.equal(blocked(4, 3, door, get), false, '成对的另一半：门洞那儿是能过去的');
});

test('窗不影响墙的实心子段：只有窗的墙 return **整段**一条', () => {
  resetParams();
  const win = withHole({ at: 2.5, w: 1.2, h: 1.5, sill: 0.9, kind: 'window' });
  const segs = wallSolidSegments(win.walls[INNER]);
  assert.equal(segs.length, 1, '窗不挖墙 → 整段一条（门是两条）');
  const door = withHole({ at: 2.5, w: 0.9, h: 2.1 });
  assert.equal(wallSolidSegments(door.walls[INNER]).length, 2);
});

test('门与窗的访问器各认各的（几何层靠它分流）', () => {
  resetParams();
  let l = withHole({ at: 2.5, w: 0.9, h: 2.1 });
  l = placeOpening(l, INNER, { at: 4.2, w: 1.2, h: 1.5, sill: 0.9, kind: 'window' }).layout;
  assert.equal(doorOpenings(l.walls[INNER]).length, 1);
  assert.equal(windowOpenings(l.walls[INNER]).length, 1);
});

/* ---------------- 2D：只有门断墙身 ---------------- */

test('⭐ 2D 只有门断墙身：只传门洞时，带窗的墙照旧是**一整块**', () => {
  resetParams();
  const win = withHole({ at: 2.5, w: 1.2, h: 1.5, sill: 0.9, kind: 'window' });
  const p = piece(win);
  const blocks = solidBlocks(p, doorOpenings(win.walls[INNER]), { lintel: false });
  // 变异点：`scene2d.js` 改回传 `openingsOf(wall)`/全部洞口 → 这里变成两块，立刻红
  assert.equal(blocks.length, 1, '窗在顶视图里不断墙 —— 断开的墙＝「这儿能过去」');
  assert.equal(blocks[0].openingIndex, -1);
});

test('2D 标记：窗有**第三线**（窗线）且读数带离地；门没有、读数只有净宽', () => {
  resetParams();
  const win = withHole({ at: 2.5, w: 1.2, h: 1.5, sill: 0.9, kind: 'window' });
  const wm = openingMarks(win.walls[INNER])[0];
  assert.equal(wm.kind, 'window');
  assert.equal(wm.sash.length, 2, '建筑制图的三线画法：第三线是沿墙中线那一条');
  assert.equal(wm.sill, 0.9);
  assert.match(openingLabel(wm.opening), /离地 0\.90 m/);
  const door = withHole({ at: 2.5, w: 0.9, h: 2.1 });
  const dm = openingMarks(door.walls[INNER])[0];
  assert.equal(dm.sash, null, '门没有第三条线');
  assert.equal(openingLabel(dm.opening), '门洞 净宽 0.90 m · 净高 2.10 m', '门的文案与 W1 逐字相同');
});

/* ---------------- 校验（结构 / 策略两级） ---------------- */

test('结构：离地不是有限数 / 是负数 → 拒绝；离地 + 净高 > 墙高 → 拒绝', () => {
  resetParams();
  const w = mkWallSeg(4, 0.5, 4, 5.5);
  const base = { at: 2.5, w: 1.2, h: 1.5, kind: 'window' };
  assert.equal(checkWallOpenings({ ...w, openings: [{ ...base, sill: NaN }] }, 2.8).reason, OPENING_REASON.BAD_SILL);
  assert.equal(checkWallOpenings({ ...w, openings: [{ ...base, sill: -0.1 }] }, 2.8).reason, OPENING_REASON.BAD_SILL);
  assert.equal(checkWallOpenings({ ...w, openings: [{ ...base, sill: 1.5 }] }, 2.8).reason, OPENING_REASON.TOO_TALL,
    '1.5 + 1.5 = 3.0 > 2.8：洞顶穿出墙顶');
  assert.equal(checkWallOpenings({ ...w, openings: [{ ...base, sill: 1.3 }] }, 2.8), null, '1.3 + 1.5 = 2.8 恰好贴顶 → 合法');
});

test('结构：门与窗**互相**重叠也拒绝（同一个位置不能既是门又是窗）', () => {
  resetParams();
  const r = placeOpening(withHole({ at: 2.5, w: 0.9, h: 2.1 }), INNER, { at: 2.5, w: 1.2, h: 1.5, sill: 0.9, kind: 'window' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'overlap');
  assert.equal(r.message, MSG.overlap());
});

test('策略：离地越界 → **夹取 + 出声**（静默改数是这个项目最不能接受的一类 bug）', () => {
  resetParams();
  const low = placeOpening(roomWithInner(), INNER, { at: 2.5, w: 1.2, h: 1.5, sill: 0.05, kind: 'window' });
  assert.equal(low.ok, true);
  assert.equal(low.opening.sill, cfg.window.minSillM, '0.05 → 夹到下限');
  assert.ok(low.clamps.includes(MSG.clippedSillLow));
  const high = placeOpening(roomWithInner(), INNER, { at: 2.5, w: 1.2, h: 0.5, sill: 3.0, kind: 'window' });
  assert.equal(high.opening.sill, cfg.window.maxSillM);
  assert.ok(high.clamps.includes(MSG.clippedSillHigh));
});

test('墙高不够（离地已经贴到墙顶）→ **拒绝**，绝不夹成一条 0.05 m 的缝', () => {
  resetParams();
  // 先把离地上限放到"比墙还高"（3.5 是它的合法上限）—— 否则 2.9 会先被**策略**夹到 2.5，
  // 走的就不是"墙高不够"这条结构路径了（两条路径要分得开）
  configure({ window: { maxSillM: 3.5 } });
  try {
    const r = placeOpening(roomWithInner(), INNER, { at: 2.5, w: 1.2, h: 1.5, sill: 2.9, kind: 'window' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'cannot-fit');
    assert.match(r.message, /墙高不够/);
  } finally {
    resetParams();
  }
});

test('每墙上限**按类别各算各的**：3 门 + 3 窗 允许；第 4 个窗才被拒', () => {
  resetParams();
  // 六个洞要放得下：换成 12×12 的房间 + 一面 10 m 长的内墙（默认 8×6 的墙只有 5 m，装不下）
  let l = (() => {
    const base = createLayout({ w: 12, d: 12, h: 2.8 });
    return { ...base, walls: [...base.walls, mkWallSeg(4, 0.5, 4, 10.5)] };
  })();
  for (const at of [1.0, 2.0, 3.0]) {
    const r = placeOpening(l, INNER, { at, w: 0.9, h: 2.1 });
    assert.equal(r.ok, true, r.message);
    l = r.layout;
  }
  for (const at of [4.2, 5.2, 6.2]) {
    const r = placeOpening(l, INNER, { at, w: 0.9, h: 1.0, sill: 1.2, kind: 'window' });
    assert.equal(r.ok, true, `第 ${at} 扇窗应当放得下：${r.message}`);
    l = r.layout;
  }
  const over = placeOpening(l, INNER, { at: 7.2, w: 0.9, h: 1.0, sill: 1.2, kind: 'window' });
  assert.equal(over.ok, false);
  assert.equal(over.reason, 'too-many');
  assert.match(over.message, /窗/, '上限文案要说窗（内核出话、界面原样转述）');
});

test('改离地走的是同一条夹取路径（界面不许自己算几何）', () => {
  resetParams();
  const l = withHole({ at: 2.5, w: 1.2, h: 1.5, sill: 0.9, kind: 'window' });
  const r = updateOpening(l, INNER, 0, { sill: 0.5 });
  assert.equal(r.ok, true, r.message);
  assert.equal(sillOf(r.opening), 0.5);
  assert.equal(kindOf(r.opening), 'window', '改离地不许把窗改没了');
});

/* ---------------- 参数只对新放的生效 ---------------- */

test('默认尺寸来自参数表（不是硬编码）：改默认离地 → 新放的窗跟着变，历史窗**不被回溯改写**', () => {
  resetParams();
  const before = withHole({ at: 2.5, w: 1.2, h: 1.5, sill: 0.9, kind: 'window' });
  configure({ window: { defaultSillM: 1.2, defaultWidthM: 1.5 } });
  try {
    const fresh = placeOpening(roomWithInner(), INNER, { at: 2.5, kind: 'window' });
    assert.equal(fresh.ok, true, fresh.message);
    assert.equal(fresh.opening.w, 1.5, '新放的用新默认值');
    assert.equal(sillOf(fresh.opening), 1.2);
    assert.equal(sillOf(openingsOf(before.walls[INNER])[0]), 0.9, '历史方案里的窗一个字都不许改');
  } finally {
    resetParams();
  }
});

test('命名隔离照旧：`cfg.window.*` 与 `cfg.opening.*` 零交叉（两个洞口的参数不许混）', () => {
  resetParams();
  assert.equal(cfg.window.defaultSillM, 0.9);
  assert.equal(cfg.opening.defaultWidthM, 0.9);
  assert.notEqual(Object.keys(cfg.window).length, 0);
  // 共用的那一个物理量只有一份：离墙角间隙（禁止双真源）
  assert.equal(cfg.window.wallEdgeGapM, undefined, '窗不许另立 wallEdgeGapM —— 复用 opening.wallEdgeGapM');
});

/* ---------------- 兼容与格式 ---------------- */

test('⭐ 带窗方案：导出→导入→再导出**逐字节一致**，窗一个都不许丢、也不许变成门', () => {
  resetParams();
  const l = withHole({ at: 2.5, w: 1.2, h: 1.5, sill: 0.9, kind: 'window' });
  const a = exportScheme(l);
  assert.match(a, /"kind": "window"/, '新标识这一代，窗必须把 kind 写出来');
  assert.match(a, /"sill": 0\.9/);
  const r = importScheme(a, { getProduct: get });
  assert.equal(r.ok, true, r.reason);
  assert.equal(exportScheme(r.layout), a, '同代往返必须逐字节稳定');
  assert.equal(kindOf(openingsOf(r.layout.walls[INNER])[0]), 'window');
});

test('格式标识换代：新写的用新标识；旧标识（含只有门的那一代）**一律仍可导入**', () => {
  resetParams();
  const win = exportScheme(withHole({ at: 2.5, w: 1.2, h: 1.5, sill: 0.9, kind: 'window' }));
  assert.match(win, /"format": "scene-space-designer-scene-routes-columns"/);
  const legacy = {
    format: 'scene-space-designer-openings',
    state: { w: 8, d: 6, h: 2.8, walls: [{ a: [0, 0], b: [8, 0], openings: [{ at: 4, w: 1.2, h: 2.1 }] }], items: [] },
  };
  const r = importScheme(legacy, { getProduct: get });
  assert.equal(r.ok, true, r.reason);
  assert.equal(kindOf(openingsOf(r.layout.walls[0])[0]), 'door', '老文件（没有 kind）读进来就是门');
});

test('门身上挂着一个多余的 `sill` 当没写（读取端宽容、写入端唯一）', () => {
  resetParams();
  const odd = {
    format: 'scene-space-designer-scene-routes',
    state: { w: 8, d: 6, h: 2.8, walls: [{ a: [0, 0], b: [8, 0], openings: [{ at: 4, w: 1.2, h: 2.1, sill: 0.9 }] }], items: [] },
  };
  const r = importScheme(odd, { getProduct: get });
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(openingsOf(r.layout.walls[0])[0], { at: 4, w: 1.2, h: 2.1 }, '那个没主的 sill 被擦掉了');
  assert.equal(exportScheme(r.layout).includes('"sill"'), false);
});

test('删一个窗与删一个门走同一条路径', () => {
  resetParams();
  const l = withHole({ at: 2.5, w: 1.2, h: 1.5, sill: 0.9, kind: 'window' });
  const r = removeOpening(l, INNER, 0);
  assert.equal(r.ok, true);
  assert.equal(openingsOf(r.layout.walls[INNER]).length, 0);
  assert.equal(windowOpenings(r.layout.walls[INNER]).length, 0);
});

test('fitOpening 是纯函数：同一输入同一输出，且不改调用者的对象', () => {
  resetParams();
  const w = mkWallSeg(4, 0.5, 4, 5.5);
  const want = { at: 2.5, w: 1.2, h: 1.5, sill: 0.9, kind: 'window' };
  const a = fitOpening(w, want, { roomH: 2.8 });
  const b = fitOpening(w, want, { roomH: 2.8 });
  assert.deepEqual(a.opening, b.opening);
  assert.deepEqual(want, { at: 2.5, w: 1.2, h: 1.5, sill: 0.9, kind: 'window' }, 'want 一个字段都不许被改');
  assert.equal(openingSpans(w).length, 0);
});

test('一趟下来：窗、门、撤销、改尺寸都不丢东西（端到端串一遍）', () => {
  resetParams();
  let l = withHole({ at: 2.5, w: 1.2, h: 1.5, sill: 0.9, kind: 'window' });
  l = placeOpening(l, INNER, { at: 4.3, w: 0.9, h: 2.1 }).layout;
  assert.equal(openingsOf(l.walls[INNER]).length, 2);
  l = updateOpening(l, INNER, 0, { w: 1.5 }).layout;
  const r = applyRoomSize(l, { w: 9, d: 7, h: 2.8 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.openingsKept, 2, '两个洞口都该跟着墙走');
  assert.equal(r.openingsDropped, 0);
  const kinds = openingsOf(r.layout.walls[INNER]).map(kindOf).sort();
  assert.deepEqual(kinds, ['door', 'window'], '一改尺寸就少一个 / 类型变了，都算丢数据');
});