/**
 * 平面图墙体 —— 用户两轮反馈的判据，现在管三件事：
 *   甲、内墙与外墙**一模一样**（打印版不许再分内外墙两套样式）；
 *   乙、两个构件交汇处**不许有缺口**；
 *   丙、两墙**斜着**交汇时，接头是**斜接**，不是一块方补丁。
 *
 * 同一套判据要在**三处**都成立：内核 `spatial-core/test/wallpieces.test.js`、
 * 这里（平面图）、真机探针 `logs/cdp-walls-joint.mjs`。这里的定义式是**独立实现**的 ——
 * 复用内核公式就等于拿实现当标准，实现错了判据跟着错（这个坑本项目已经踩过两次）。
 *
 * 判据「墙身」的定义：到墙中心线距离 ≤ 半厚的点。它只取决于墙在哪、多厚，与怎么画无关。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { scene2d, walls2d, wallFills2d } from '../src/scene2d.js';
import { planSvg } from '../src/planSvg.js';
import { wallPieces, pieceCorners, pointInQuad, JOINT_BITE_M } from '@core/wallpieces.js';
import { boundaryWalls } from '@core/room.js';
import { mkWallSeg, wallSeg } from '@core/wall.js';

/** 墙对象工厂（W1 起墙是对象；测试里写坐标更直观） */
const W = (x, z, xx, zz) => mkWallSeg(x, z, xx, zz);
const seg = (w) => wallSeg(w);
import { wallBox } from '@core/geometry.js';
import { cfg } from '@core/params.js';

const T = cfg.space.wallThicknessM;
const HALF = T / 2;
const TOL = JOINT_BITE_M + 0.001;                 // 咬入 0.5 mm + 采样余量
const layout = (walls) => ({ w: 5, d: 4, h: 2.6, walls: [...boundaryWalls(5, 4), ...walls], items: [] });
const L = layout([W(1, 1, 3, 1), W(3, 1, 3, 2.5)]);     // 内墙之间的内角（用户报的那个）
const TJ = layout([W(0, 2, 4, 2), W(4, 2, 4, 3.4)]);     // 一根 T（西墙身段出发）+ 一根内角
/**
 * 两墙在 `at` 收头、夹角 alpha 的"合页"。
 * ⚠️ 一定要摆在房间**里面**：早先摆在 (0,0)，正好压住房间角 —— 接头从 2 个收头变成 4 个，
 *    测的就不是"两墙斜接"了（而且会让"两墙不该有补角"这条断言冤枉地红）。
 */
const hinge = (deg, len = 2, at = [2.5, 2]) => {
  const a = (deg * Math.PI) / 180;
  return [
    W(at[0], at[1], at[0] + len, at[1]),
    W(at[0], at[1], at[0] + len * Math.cos(a), at[1] + len * Math.sin(a)),
  ];
};
const hub = [2.5, 1.6];                                  // 三岔口/十字口的公共点
const spoke = (deg, len = 1.2) => hinge(deg, len, hub)[1];
const Y = layout([spoke(0), spoke(60), spoke(-60)]);
const X = layout([spoke(0), spoke(90), spoke(180), spoke(270)]);

/* ---------------- 判据原料（独立实现，不碰内核公式） ---------------- */

const segsOf = (walls) => walls.map((w) => {
  const [x, z, xx, zz] = seg(w);
  const len = Math.hypot(xx - x, zz - z);
  return { a: [x, z], len, d: [(xx - x) / len, (zz - z) / len] };
});

/** 每个坐标上"收头"的墙（≥2 面）—— 与内核同一条口径：端点落在同一个 mm 格子里 */
function jointsOf(walls) {
  const key = (x, z) => `${Math.round(x * 1000)}:${Math.round(z * 1000)}`;
  const m = new Map();
  for (const s of segsOf(walls)) {
    for (const end of [0, 1]) {
      const P = end ? [s.a[0] + s.d[0] * s.len, s.a[1] + s.d[1] * s.len] : s.a;
      const d = end ? [-s.d[0], -s.d[1]] : s.d;          // 从端点指向墙里
      const k = key(P[0], P[1]);
      const list = m.get(k) ?? [];
      list.push({ P, d });
      m.set(k, list);
    }
  }
  return [...m.values()].filter((l) => l.length >= 2);
}

const distToLine = (x, z, ax, az, dx, dz) => Math.abs((x - ax) * -dz + (z - az) * dx);

/**
 * 参考实体 = 每面墙自己的矩形 ∪ 每一对收头墙的**缺口区**。
 * 缺口区的定义式（与内核那份判据同一套说法）：
 *   两面墙身都盖得住（到两条中心线都在半厚内）**且**都在两个端面之后。
 * `margin` > 0 表示"收缩一点"（判"必须被盖住"时要躲开边界抖动），< 0 表示"放宽一点"（判"不多盖"时容咬入）。
 */
function refSolid(walls, margin) {
  const S = segsOf(walls);
  const joints = jointsOf(walls);
  const inRect = (x, z) => S.some((s) => {
    const dx = x - s.a[0];
    const dz = z - s.a[1];
    const along = dx * s.d[0] + dz * s.d[1];
    const across = dx * -s.d[1] + dz * s.d[0];
    return along >= margin && along <= s.len - margin && Math.abs(across) <= HALF - margin;
  });
  const inPair = (x, z) => joints.some((list) => {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const p = list[i];
        const q = list[j];
        const dotv = p.d[0] * q.d[0] + p.d[1] * q.d[1];
        const cro = p.d[0] * q.d[1] - p.d[1] * q.d[0];
        const alpha = (Math.atan2(Math.abs(cro), dotv) * 180) / Math.PI;
        if (alpha < 1.5 || 180 - alpha < 1.5) continue;                // 同向/反向：没有缺口
        if (distToLine(x, z, p.P[0], p.P[1], p.d[0], p.d[1]) > HALF - margin) continue;
        if (distToLine(x, z, q.P[0], q.P[1], q.d[0], q.d[1]) > HALF - margin) continue;
        if ((x - p.P[0]) * p.d[0] + (z - p.P[1]) * p.d[1] > -margin) continue;
        if ((x - q.P[0]) * q.d[0] + (z - q.P[1]) * q.d[1] > -margin) continue;
        return true;
      }
    }
    return false;
  });
  return (x, z) => inRect(x, z) || inPair(x, z);
}

/** 平面图**画出来**的全部多边形：构件 + 补角（只有三岔口以上才可能有补角） */
const drawnPolys = (l) => [...walls2d(l).map((w) => w.corners), ...wallFills2d(l).polys];
const covered = (polys, x, z) => polys.some((q) => pointInQuad(x, z, q));
const bbox = (walls, pad) => {
  const xs = walls.flatMap((w) => [seg(w)[0], seg(w)[2]]);
  const zs = walls.flatMap((w) => [seg(w)[1], seg(w)[3]]);
  return [Math.min(...xs) - pad, Math.max(...xs) + pad, Math.min(...zs) - pad, Math.max(...zs) + pad];
};

const CASES = [
  ['房间四角', layout([])],
  ['两根内墙的内角', L],
  ['T 形接头', TJ],
  ['斜接 30°', layout(hinge(30))],
  ['斜接 45°', layout(hinge(45))],
  ['斜接 60°', layout(hinge(60))],
  ['斜接 135°', layout(hinge(135))],
  ['三根墙收于一点（Y 形）', Y],
  ['四根墙收于一点（十字）', X],
];

/* ---------------- 甲：平面图与三维同源 ---------------- */

test('平面图用的是内核构件（交汇处按斜接缩），不是各画一个原始盒子', () => {
  const r = wallPieces(L);
  const byIndex = new Map(r.pieces.map((p) => [p.index, p]));
  for (const w of walls2d(L)) {
    const pc = byIndex.get(w.index);
    assert.ok(pc, `第 ${w.index} 面墙必须有构件`);
    assert.deepEqual(w.corners, pieceCorners(pc), '平面图的多边形必须就是内核构件的多边形');
  }
  // 墙的**定义**长度不变（缩的是构件，不是墙）：两面内墙分别是 2 m 与 1.5 m
  const inner = walls2d(L).filter((w) => !w.boundary);
  assert.deepEqual(inner.map((w) => w.length).sort(), [1.5, 2]);
  // 共用端点那一头：斜接要**伸到接缝上**（只裁不伸会留缝），所以构件不再等于原始盒子
  const first = byIndex.get(inner[0].index);
  assert.ok(first.mitred, '内角的接头必须是斜接');
  assert.ok(first.extA > 0 || first.extB > 0, '斜接那头必须伸到接缝上（只裁不伸会留缝）');
  // ⚠️ 别用"面积差"去证这件事：90° 内角上斜接是**一边切掉、一边补上**，面积几乎不变
  //    （实测 0.2401 vs 0.2400，差 100 mm²）——那样写出来的断言又脆又说不清事。
  //    直接说形状：接头那一头，原始盒子的直角被切掉了一个；构件是多边形，不是矩形。
  const corners = inner[0].corners;
  assert.ok(corners.length >= 5, `斜接之后构件是多边形（≥5 边），不是矩形（实际 ${corners.length} 边）`);
  const cut = wallBox(L.walls[4]).filter(([px, pz]) => !pointInQuad(px, pz, corners));
  assert.ok(cut.length >= 1, '斜接必须切掉原始盒子在接头那一头的角（实际一个都没切）');
});

/* ---------------- 乙：缺一不可的两条判据 ---------------- */

test('⭐ 该盖住的必须盖住：墙自己的矩形 + 每个接头的缺口区（含斜着交汇）', () => {
  const STEP = 0.006;
  for (const [name, l] of CASES) {
    const polys = drawnPolys(l);
    const strict = refSolid(l.walls, 0.001);
    const [x0, x1, z0, z1] = bbox(l.walls, HALF + 0.01);
    let checked = 0;
    for (let x = x0; x <= x1; x += STEP) {
      for (let z = z0; z <= z1; z += STEP) {
        if (!strict(x, z)) continue;
        checked++;
        assert.ok(covered(polys, x, z), `${name}：这里漏了 (${x.toFixed(3)}, ${z.toFixed(3)})`);
      }
    }
    assert.ok(checked > 1500, `${name}：采样点太少（${checked}）说明不了问题`);
  }
});

test('⭐ 不该冒的必须不冒：画出来的每一点都要落在参考实体里', () => {
  const STEP = 0.006;
  for (const [name, l] of CASES) {
    const loose = refSolid(l.walls, -TOL);
    for (const poly of drawnPolys(l)) {
      let bx0 = Infinity;
      let bx1 = -Infinity;
      let bz0 = Infinity;
      let bz1 = -Infinity;
      for (const [x, z] of poly) {
        bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x);
        bz0 = Math.min(bz0, z); bz1 = Math.max(bz1, z);
      }
      for (let x = bx0; x <= bx1; x += STEP) {
        for (let z = bz0; z <= bz1; z += STEP) {
          if (!pointInQuad(x, z, poly)) continue;
          assert.ok(loose(x, z), `${name}：多盖了 (${x.toFixed(3)}, ${z.toFixed(3)})`);
        }
      }
    }
  }
});

test('⭐ 斜接头不许是「方补丁」：轴对齐正方形的外侧两个角，一个都不许被画到', () => {
  // 老实现：每个接头补一块**轴对齐**的 t×t 正方形。两墙斜着交汇时，它的外侧角会从墙身里
  // 戳出去 —— 屏幕上就是用户说的「方补丁」。这里直接点名那两个角。
  let hits = 0;
  for (const deg of [30, 45, 60]) {
    const l = layout(hinge(deg, 2, hub));
    const polys = drawnPolys(l);
    const loose = refSolid(l.walls, -TOL);
    for (const corner of [[hub[0] - HALF, hub[1] + HALF], [hub[0] - HALF, hub[1] - HALF]]) {
      // 先在**定义**上确认这个角本来就在墙身之外（不然这条断言会变成空话）
      if (loose(corner[0], corner[1])) continue;
      hits++;
      assert.ok(!covered(polys, corner[0], corner[1]),
        `${deg}° 接头的方补丁角 ${JSON.stringify(corner)} 被画出来了`);
    }
  }
  assert.ok(hits >= 3, `至少要真的点中 3 个角（实际 ${hits}）`);
});

test('三岔口以上才有补角：场地里 0 块，Y 形接头上补得严丝合缝', () => {
  assert.equal(wallFills2d(layout([])).count, 0, '房间四角全是斜接，不该有补角');
  assert.equal(wallFills2d(layout(hinge(45))).count, 0, '两墙斜接，不该有补角');
  const y = wallFills2d(Y);
  assert.ok(y.count >= 1, `Y 形接头必须有补角（实际 ${y.count}）`);
  // 补角也必须"不多盖"：每个顶点都在墙身里（到两条中心线都在半厚内、且在端面之后）
  const loose = refSolid(Y.walls, -TOL);
  for (const poly of y.polys) {
    for (const [x, z] of poly) assert.ok(loose(x, z), `补角顶点冒出去了：(${x.toFixed(3)}, ${z.toFixed(3)})`);
  }
});

/* ---------------- 丙：样式只有一个出处 / 模板接线 ---------------- */

test('打印版只有一套墙体样式（内外墙一模一样），并且带上补角', () => {
  const svg = planSvg(L, { name: '测试', at: '2026-10-07', by: '测试', paramsRev: 1 });
  assert.ok(!svg.includes('.wall-int'), '打印版不许再分内外墙两套样式（用户要求一模一样）');
  assert.ok(!svg.includes('wall wall-int'), '墙体的 class 不许再带 wall-int');
  const wallPaths = (svg.match(/class="wall"/g) || []).length;
  const s = scene2d(L);
  assert.equal(wallPaths, s.walls.length, '墙体 path 数 = 构件数（这个场地没有补角）');

  const ySvg = planSvg(Y, { name: '测试', at: '2026-10-07', by: '测试', paramsRev: 1 });
  const yPaths = (ySvg.match(/class="wall"/g) || []).length;
  const sy = scene2d(Y);
  assert.equal(yPaths, sy.walls.length + 1, '有补角时：构件数 + 1 条补角');
  assert.ok(sy.fills.count >= 1);
});

test('scene2d 暴露的是 fills（旧的接角块概念没了）', () => {
  const s = scene2d(L);
  assert.equal(s.fills.count, 0);
  assert.equal(s.fills.d, '');
  assert.equal(s.posts, undefined, 'posts 这个键必须已经改名，不能留着旧的');
});