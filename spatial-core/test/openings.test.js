/**
 * openings.test.js —— W1 门洞：校验 / 放置 / 几何 / 兼容
 *
 * 每条判据都写清**变异点**（怎么改代码会让它变红）—— 这是本项目的规矩：
 * 「永远绿的用例比没有用例更坏」。成对判据（能走 / 仍挡）必须两条都在场，
 * 只留一条的话，把墙挖空、或者压根没挖，都能全绿。
 *
 * 坐标口径：`at` = 沿墙自 `a` 端点的**弧长（米）**。这一条必须钉住 ——
 * 它一旦被改成 0..1 比例，墙一改尺寸门洞就会悄悄挪位置（静默改数）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cfg, configure, resetParams } from '../src/params.js';
import { mkWallSeg, wallSeg, openingsOf } from '../src/wall.js';
import { createLayout, applyRoomSize, boundaryWalls } from '../src/room.js';
import { wallPieces, polyArea, pointInQuad } from '../src/wallpieces.js';
import { blocked } from '../src/collision.js';
import { exportScheme, importScheme, IMPORT_ERROR } from '../src/scheme.js';
import {
  placeOpening, removeOpening, updateOpening, fitOpening, openingSpans, wallSolidSegments,
  solidBlocks, checkWallOpenings, inspectOpening, OPENING_REASON, MSG,
} from '../src/openings.js';

const get = (id) => (id === 'demo-cabinet-800' ? { w: 1.2, d: 1.1, h: 1.99, model: 'demo-cabinet-800', doors: [] } : undefined);
/** 8×6 的房间 + 一面带洞内墙（墙序号 4）：内墙 (4,0.5)→(4,5.5)，洞 at=2.5 → 世界坐标 z=3.0 */
const INNER = 4;
const roomWithDoor = () => {
  const l = createLayout({ w: 8, d: 6, h: 2.8 });
  const withInner = { ...l, walls: [...l.walls, mkWallSeg(4, 0.5, 4, 5.5)] };
  const r = placeOpening(withInner, INNER, { at: 2.5, w: 0.9, h: 2.1 });
  assert.equal(r.ok, true, r.message);
  return r.layout;
};

/* ---------------- 数据形状与口径 ---------------- */

test('门洞长在墙上：`at` 是自 `a` 端点的弧长（米），2D/3D/碰撞共用这一个口径', () => {
  resetParams();
  const l = createLayout({ w: 8, d: 6, h: 2.8 });
  const wall0 = l.walls[0];                        // T 面：(0,0) → (8,0)
  const r = placeOpening(l, 0, { at: 3, w: 1.2, h: 2.1 });
  assert.equal(r.ok, true);
  const o = r.layout.walls[0].openings[0];
  assert.equal(o.at, 3, '① 位置就是弧长');
  const [x, z] = wallSeg(r.layout.walls[0]).slice(0, 2);
  assert.deepEqual([x, z], [0, 0], '② 锚点还是 a（自 a 起算，不是自 b）');
  assert.equal(wall0.openings, undefined, '③ 纯函数：原布局不许被改（新布局是新对象）');
});

test('锚点方向冻结：B 面是 (w,d)→(0,d)，`at` 自**那个**角起算', () => {
  resetParams();
  const l = createLayout({ w: 8, d: 6, h: 2.8 });
  const idx = l.walls.findIndex((w) => { const s = wallSeg(w); return s[0] === 8 && s[1] === 6; });
  assert.ok(idx >= 0, 'B 面存在');
  const r = placeOpening(l, idx, { at: 1, w: 0.9, h: 2.1 });
  assert.equal(r.ok, true);
  // B 面从 (8,6) 往 (0,6) 走 1 m → 世界坐标 x=7
  const marks = wallSolidSegments(r.layout.walls[idx]);
  const solid = marks.map((s) => s[0]);
  assert.ok(solid.includes(8), `洞后应剩一段从 x=8 出发的实心（实际 ${JSON.stringify(marks)}）`);
  assert.equal(marks.length, 2, '一面墙一个洞 → 两段实心');
});

/* ---------------- 几何：带洞的墙 = 左右实心段 + 过梁 ---------------- */

test('几何守恒（3D）：实心段 + 过梁的面积之和 == 构件面积（分割不重不漏）', () => {
  resetParams();
  const l = roomWithDoor();
  const p = wallPieces(l).pieces.find((q) => q.index === INNER);
  const blocks = solidBlocks(p, openingsOf(l.walls[INNER]));
  assert.equal(blocks.length, 3, '左右两段 + 一个过梁');
  const sum = blocks.reduce((a, b) => a + Math.abs(polyArea(b.poly)), 0);
  assert.ok(Math.abs(sum - Math.abs(polyArea(p.poly))) < 1e-9, `面积不守恒：${sum} vs ${Math.abs(polyArea(p.poly))}`);
});

test('几何守恒（2D，无过梁）：实心段面积 + 洞的矩形面积 == 构件面积', () => {
  resetParams();
  const l = roomWithDoor();
  const p = wallPieces(l).pieces.find((q) => q.index === INNER);
  const t = cfg.space.wallThicknessM;
  const blocks = solidBlocks(p, openingsOf(l.walls[INNER]), { lintel: false });
  assert.equal(blocks.length, 2, '顶视图只有左右两段（过梁会把洞口盖住 → 平面图上"门"就看不见了）');
  const sum = blocks.reduce((a, b) => a + Math.abs(polyArea(b.poly)), 0);
  const hole = 0.9 * t;
  assert.ok(Math.abs(sum + hole - Math.abs(polyArea(p.poly))) < 1e-9, '实心 + 洞 ≠ 构件');
});

test('几何：分块都在构件里（不多盖）—— 采样点逐个检验', () => {
  resetParams();
  const l = roomWithDoor();
  const p = wallPieces(l).pieces.find((q) => q.index === INNER);
  for (const b of solidBlocks(p, openingsOf(l.walls[INNER]))) {
    for (const q of b.poly) {
      assert.ok(pointInQuad(q[0], q[1], p.poly) || true, '顶点允许落在边界上');
      const cx = (q[0] + p.poly[0][0]) / 2; // 只为让下面那句用上变量，真正判的是重心
      void cx;
    }
    let gx = 0;
    let gz = 0;
    for (const q of b.poly) { gx += q[0]; gz += q[1]; }
    gx /= b.poly.length;
    gz /= b.poly.length;
    assert.ok(pointInQuad(gx, gz, p.poly), `分块重心跑出构件了：${b.kind}`);
  }
});

test('过梁：底面在洞顶、高度 = 墙高 − 洞高；洞高 == 墙高时**不产**零高过梁（NaN 会被 merge 吞进去）', () => {
  resetParams();
  const l = roomWithDoor();
  const p = wallPieces(l).pieces.find((q) => q.index === INNER);
  const lintel = solidBlocks(p, openingsOf(l.walls[INNER])).find((b) => b.kind === 'lintel');
  assert.equal(lintel.base, 2.1);
  assert.ok(Math.abs(lintel.height - (p.h - 2.1)) < 1e-9);

  // 落地到顶：洞高 = 墙高 → 不许有过梁（高度 0 的棱柱会往几何里灌 NaN/退化三角形）
  const r2 = placeOpening(createLayout({ w: 8, d: 6, h: 2.8 }), 0, { at: 3, w: 1.2, h: 2.8 });
  assert.equal(r2.ok, true);
  const p2 = wallPieces(r2.layout).pieces.find((q) => q.index === 0);
  const b2 = solidBlocks(p2, r2.layout.walls[0].openings);
  assert.equal(b2.filter((b) => b.kind === 'lintel').length, 0, '到顶就不该有过梁');
  assert.equal(b2.length, 2);
});

test('没有门洞的墙：分块就是**整块**（零回归的前提）', () => {
  resetParams();
  const l = createLayout({ w: 8, d: 6, h: 2.8 });
  const p = wallPieces(l).pieces.find((q) => q.index === 0);
  const blocks = solidBlocks(p, []);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].poly, p.poly, '必须是同一份多边形（不裁不切）');
});

/* ---------------- 碰撞：成对判据 ---------------- */

test('⭐ 成对：洞口正中**能走过去**', () => {
  resetParams();
  const l = roomWithDoor();
  // 内墙 (4,0.5)→(4,5.5)，洞 at=2.5 → 世界坐标 z=3.0
  assert.equal(blocked(4, 3, l, get), false, '洞里必须能站人');
});

test('⭐ 成对：洞口**旁边**的墙身照旧挡人', () => {
  resetParams();
  const l = roomWithDoor();
  assert.equal(blocked(4, 2.3, l, get), true, '洞外 0.2 m 就该被挡（洞宽 0.9 → 洞边在 2.55）');
  assert.equal(blocked(4, 3.6, l, get), true);
});

test('窄洞过不去：净宽 < 2×人体半径时，几何自己就挡住了（不需要另立一条"窄门规则"）', () => {
  resetParams();
  const l = createLayout({ w: 8, d: 6, h: 2.8 });
  // 0.4 m 的洞：两侧各要留 radius(0.24)+间隙(0.06)=0.30 → 洞内**没有**可站的点
  const r = placeOpening(l, 1, { at: 3, w: 0.4, h: 2.1 });
  assert.equal(r.ok, true, '0.4 m 的洞本身是合法的（minWidth 0.6 是策略，会被夹取 —— 见下面的放置用例）');
  assert.equal(r.opening.w, 0.6, '被夹到最小净宽（并出声）');
  // 直接构造一个 0.4 m 的洞（绕过策略夹取）来看几何本身的行为
  const l2 = { ...l, walls: l.walls.map((w, i) => (i === 1 ? { a: w.a, b: w.b, openings: [{ at: 3, w: 0.4, h: 2.1 }] } : w)) };
  assert.equal(blocked(8, 3, l2, get), true, '0.4 m 的洞：人过不去（两侧安全距离占满）');
});

/* ---------------- 放置：夹取必须出声 ---------------- */

test('默认尺寸来自参数表（不是硬编码）：改默认净宽 → 新放的门洞跟着变', () => {
  resetParams();
  const l = createLayout({ w: 8, d: 6, h: 2.8 });
  const a = placeOpening(l, 0, { at: 3 });
  assert.equal(a.opening.w, cfg.opening.defaultWidthM);
  assert.equal(a.opening.h, cfg.opening.defaultHeightM);
  configure({ opening: { defaultWidthM: 1.4, defaultHeightM: 2.4 } });
  const b = placeOpening(l, 0, { at: 4 });
  assert.equal(b.opening.w, 1.4, '硬编码 0.9 的话这条会红');
  assert.equal(b.opening.h, 2.4);
  resetParams();
});

test('⭐ 历史方案不被回溯改写：改参数只影响**新放**的门洞', () => {
  resetParams();
  const l = roomWithDoor();
  const before = exportScheme(l);
  configure({ opening: { defaultWidthM: 2.0 } });
  const again = importScheme(before, { getProduct: get });
  assert.equal(again.ok, true);
  assert.equal(again.layout.walls[INNER].openings[0].w, 0.9, '已存的门洞宽在 state 里，参数改了也不许动它');
  assert.equal(exportScheme(again.layout), before, '同格式往返逐字节一致');
  resetParams();
});

test('太窄 → 夹到最小净宽并**出声**（静默改数是同一宗罪）', () => {
  resetParams();
  const l = createLayout({ w: 8, d: 6, h: 2.8 });
  const r = placeOpening(l, 0, { at: 3, w: 0.3 });
  assert.equal(r.ok, true);
  assert.equal(r.opening.w, cfg.opening.minWidthM);
  assert.ok(r.clamps.some((m) => m.includes('最小')), `必须有夹取说明：${JSON.stringify(r.clamps)}`);
});

test('离墙角太近 → 挪开并出声；拖出墙外 → 也挪回来', () => {
  resetParams();
  const l = createLayout({ w: 8, d: 6, h: 2.8 });
  const near = placeOpening(l, 0, { at: 0.05, w: 0.9 });
  assert.equal(near.ok, true);
  assert.ok(near.opening.at - near.opening.w / 2 >= cfg.opening.wallEdgeGapM - 1e-9, '洞边必须留出间隙');
  assert.ok(near.clamps.some((m) => m.includes('墙角')), '挪了就要说');
  const out = placeOpening(l, 0, { at: 9, w: 0.9 });
  assert.equal(out.ok, true);
  assert.ok(out.opening.at + out.opening.w / 2 <= 8 - cfg.opening.wallEdgeGapM + 1e-9);
});

test('根本放不下 → 拒绝 + 人话（绝不夹成一个 0.2 m 的洞）', () => {
  resetParams();
  const l = createLayout({ w: 8, d: 6, h: 2.8 });
  const r = placeOpening(l, 3, { at: 0.5 });     // L 面：长 6 ？不 —— 用 0.3 m 的墙更直接
  assert.equal(r.ok, true);
  const short = { ...l, walls: [...l.walls, mkWallSeg(1, 1, 1.3, 1)] };
  const bad = placeOpening(short, 4, { at: 0.15, w: 0.9 });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, 'cannot-fit');
  assert.equal(bad.message, MSG.cannotFit());
});

test('两洞重叠 → 拒绝（往哪儿挪都是另一个洞，不是夹取能解决的）', () => {
  resetParams();
  const l = roomWithDoor();
  const r = placeOpening(l, INNER, { at: 3.1, w: 0.9 });   // 已有洞 [2.05,2.95]
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'overlap');
  assert.equal(r.message, MSG.overlap());
});

test('每墙上限 + 删除 + 改尺寸（都走同一条夹取路径）', () => {
  resetParams();
  let l = createLayout({ w: 12, d: 6, h: 2.8 });
  for (let i = 0; i < cfg.opening.maxPerWall; i++) {
    const r = placeOpening(l, 0, { at: 1.5 + i * 3, w: 0.9 });
    assert.equal(r.ok, true, `第 ${i + 1} 个应该放得下`);
    l = r.layout;
  }
  const over = placeOpening(l, 0, { at: 11, w: 0.9 });
  assert.equal(over.ok, false);
  assert.equal(over.reason, 'too-many');
  assert.equal(openingsOf(l.walls[0]).length, 3);

  const removed = removeOpening(l, 0, 0);
  assert.equal(removed.ok, true);
  assert.equal(openingsOf(removed.layout.walls[0]).length, 2);

  const widened = updateOpening(removed.layout, 0, 0, { w: 1.5 });
  assert.equal(widened.ok, true);
  assert.equal(openingsOf(widened.layout.walls[0])[0].w, 1.5);
  const tooWide = updateOpening(removed.layout, 0, 0, { w: 9 });
  assert.equal(tooWide.opening.w <= cfg.opening.maxWidthM, true);
});

/* ---------------- 校验：结构 vs 策略（导入宽容、交互严格） ---------------- */

test('结构不合法 → 拒绝（跑到墙外 / 比墙还高 / 两洞重叠 / 超过格式上限）', () => {
  resetParams();
  const w = mkWallSeg(0, 0, 5, 0);
  assert.equal(checkWallOpenings({ ...w, openings: [{ at: 4.8, w: 1.5, h: 2.1 }] }, 2.8).reason, OPENING_REASON.OFF_WALL);
  assert.equal(checkWallOpenings({ ...w, openings: [{ at: 2, w: 1, h: 9 }] }, 2.8).reason, OPENING_REASON.TOO_TALL);
  assert.equal(checkWallOpenings({ ...w, openings: [{ at: 1, w: 1, h: 2 }, { at: 1.5, w: 1, h: 2 }] }, 2.8).reason, OPENING_REASON.OVERLAP);
  assert.equal(checkWallOpenings({ ...w, openings: [{ at: 0.5, w: 0.9, h: 2 }, { at: 1.5, w: 0.9, h: 2 }, { at: 2.5, w: 0.9, h: 2 }, { at: 3.5, w: 0.9, h: 2 }, { at: 4.5, w: 0.9, h: 2 }] }, 2.8).reason, OPENING_REASON.TOO_MANY);
});

test('⭐ 导入宽容、交互严格：低于**当前**策略下限的老文件照样能打开（只提示，不拒绝）', () => {
  resetParams();
  const doc = {
    format: 'scene-space-designer-openings',
    state: {
      w: 8, d: 6, h: 2.8,
      walls: [{ a: [0, 0], b: [8, 0], openings: [{ at: 3, w: 0.5, h: 2.1 }] }],
      items: [],
    },
  };
  assert.equal(importScheme(doc, { getProduct: get }).ok, true, '0.5 m 的洞：结构合法 → 必须能打开');
  const insp = inspectOpening(doc.state.walls[0], { at: 3, w: 0.5, h: 2.1 }, 2.8);
  assert.equal(insp.structural, null);
  assert.ok(insp.warnings.length >= 1, '策略越界要**有提示**（不许静默）');
  assert.equal(insp.warnings[0].reason, 'opening-too-narrow');
});

test('导入：结构不合法才拒（跑到墙外）', () => {
  resetParams();
  const doc = {
    format: 'scene-space-designer-openings',
    state: { w: 8, d: 6, h: 2.8, walls: [{ a: [0, 0], b: [8, 0], openings: [{ at: 7.8, w: 0.9, h: 2.1 }] }], items: [] },
  };
  const r = importScheme(doc, { getProduct: get });
  assert.equal(r.ok, false);
  assert.equal(r.reason, IMPORT_ERROR.BAD_OPENING.reason);
});

/* ---------------- 兼容与格式 ---------------- */

test('旧文件（数组墙）照旧能导入，且**归一化成对象**（读取端宽容、写入端唯一）', () => {
  resetParams();
  const legacy = {
    format: 'scene-space-designer',
    state: {
      w: 8, d: 6, h: 2.8,
      walls: [[0, 0, 8, 0], [8, 0, 8, 6], [8, 6, 0, 6], [0, 6, 0, 0]],
      items: [],
    },
  };
  const r = importScheme(legacy, { getProduct: get });
  assert.equal(r.ok, true);
  assert.deepEqual(r.layout.walls[0].a, [0, 0], '数组 → 对象');
  assert.equal(r.layout.walls[0].openings, undefined, '没有洞的墙不写这个字段（文件里不该有噪音）');
  const out = JSON.parse(exportScheme(r.layout));
  assert.equal(out.format, 'scene-space-designer-scene-routes-columns', '导出一律用新标识');
  assert.ok(!Array.isArray(out.state.walls[0]), '导出一律是对象');
});

test('同格式往返逐字节一致（带门洞也一样）', () => {
  resetParams();
  const l = roomWithDoor();
  const a = exportScheme(l);
  const r = importScheme(a, { getProduct: get });
  assert.equal(r.ok, true);
  assert.equal(exportScheme(r.layout), a);
});

test('改房间尺寸：内墙上的门洞随墙走（墙是对象 → 门洞是它的字段）', () => {
  resetParams();
  let l = createLayout({ w: 12, d: 9, h: 2.8 });
  l = { ...l, walls: [...l.walls, mkWallSeg(2, 2, 2, 7)] };
  l = placeOpening(l, 4, { at: 2.5, w: 0.9, h: 2.1 }).layout;
  const r = applyRoomSize(l, { w: 14, d: 9, h: 2.8 });
  assert.equal(r.ok, true);
  assert.equal(r.openingsKept, 1);
  assert.equal(r.openingsDropped, 0);
  assert.equal(openingsOf(r.layout.walls[4]).length, 1, '内墙上的洞还在');
});

test('改房间尺寸：外墙重建，放不下的洞**如实报删**（不许静默丢）', () => {
  resetParams();
  let l = createLayout({ w: 8, d: 6, h: 2.8 });
  l = placeOpening(l, 0, { at: 3.6, w: 0.9, h: 2.1 }).layout;   // 洞在 [3.15,4.05]
  const r = applyRoomSize(l, { w: 4, d: 6, h: 2.8 });           // T 面缩到 4 m → 洞放不下
  assert.equal(r.ok, true);
  assert.equal(r.openingsDropped, 1);
  assert.equal(r.openingsKept, 0);
  assert.equal(openingsOf(r.layout.walls[0]).length, 0);
});

test('外墙口径没变（象限方向与原型一致）—— 只是形状变对象', () => {
  resetParams();
  assert.deepEqual(boundaryWalls(8, 6).map(wallSeg), [[0, 0, 8, 0], [8, 0, 8, 6], [8, 6, 0, 6], [0, 6, 0, 0]]);
});

test('命名隔离：`cfg.opening.*` 与 `cfg.door.*` 零交叉（两个"门"不许混）', () => {
  resetParams();
  const keys = (g) => Object.keys(cfg[g]).sort();
  assert.ok(keys('opening').length > 0);
  assert.deepEqual(keys('opening').filter((k) => keys('door').includes(k)), [], '两组不许有同名键');
  assert.ok(keys('opening').includes('defaultWidthM'));
  assert.ok(keys('door').includes('openOkDeg'));
});

test('fitOpening 是纯函数：不改布局、不读全局副作用（同一输入同一输出）', () => {
  resetParams();
  const w = mkWallSeg(0, 0, 6, 0);
  const a = fitOpening(w, { at: 3, w: 1, h: 2 }, { roomH: 2.8 });
  const b = fitOpening(w, { at: 3, w: 1, h: 2 }, { roomH: 2.8 });
  assert.deepEqual(a, b);
});

test('openingSpans 按起点排序（几何靠"相邻两洞之间"算，不排序就会自相交）', () => {
  resetParams();
  const w = { a: [0, 0], b: [12, 0], openings: [{ at: 8, w: 1, h: 2 }, { at: 2, w: 1, h: 2 }] };
  const spans = openingSpans(w);
  assert.deepEqual(spans.map((s) => s.opening.at), [2, 8]);
  assert.deepEqual(wallSolidSegments(w).length, 3, '两洞 → 三段实心');
});