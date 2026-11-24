/**
 * 墙构件断言 —— "墙角咬合"这件事只有两条判据，而且**两条都必须与实现无关**：
 *
 *  ① **无缺口**：该被实体盖住的地方，画出来的多边形都盖得住。
 *     "该被盖住" = 每面墙自己的矩形 ∪ 每个交汇点"两面墙都盖得住、又都在两端面之后"的那片
 *     （就是两墙斜着交汇时那块平行四边形的缺口）。
 *  ② **不多盖**：画出来的每一点都得落在**某一面墙身**里（到中心线距离 ≤ 半厚 + 咬入）。
 *     这条抓的是"方补丁"—— 轴对齐的接角块戳到墙身外面的那四个角。
 *
 * 判据是**定义**（到中心线的距离、在不在端面之后），不是"照我的实现再写一遍"：
 * 所以它既能在退回旧实现时变红（变异验证），也不会把我自己的算法当成标准。
 *
 * 上一轮踩过的两个坑（写在这里免得后人再踩）：
 *   · 只沿墙中心线采样 → 缺口恰好在**两面墙的端头之外**，采样轨迹一个点都碰不到 → 假绿；
 *   · 用"到中心线 ≤ 半厚"当"该被盖住"→ 自由端是方头不是圆头，那半个圆盘本来就不该被盖 → 假红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { wallPieces, pieceCorners, pointInQuad, polyArea, JOINT_BITE_M } from '../src/wallpieces.js';
import { boundaryWalls } from '../src/room.js';
import { mkWallSeg, wallSeg } from '../src/wall.js';
/** 墙对象工厂（W1 起墙是对象；测试里写坐标更直观） */
const W = (x, z, xx, zz) => mkWallSeg(x, z, xx, zz);
const seg = (w) => wallSeg(w);

const T = 0.12;
const HALF = T / 2;
const room = (w, d, h = 2.8) => ({ w, d, h, walls: boundaryWalls(w, d), items: [] });
const perp = (x, z) => [-z, x];
const distToLine = (px, pz, ax, az, dx, dz) => Math.abs((px - ax) * -dz + (pz - az) * dx);
/** 点在这条边的**端面之后**吗（d 是"从端点指向墙里"的方向） */
const behind = (px, pz, ex, ez, dx, dz) => (px - ex) * dx + (pz - ez) * dz <= 0;

const segs = (walls) => walls.map((w) => {
  const [x, z, xx, zz] = wallSeg(w);
  const len = Math.hypot(xx - x, zz - z);
  return { w, len, d: [(xx - x) / len, (zz - z) / len], a: [x, z], b: [xx, zz] };
});

/** 缺口最远那个角 = 两面墙身"远端两条边"的交点（哪一对交点在两个端面之后，就是它） */
function jointCorner(P, d1, d2, half) {
  const n1 = perp(d1[0], d1[1]);
  const n2 = perp(d2[0], d2[1]);
  for (const s1 of [1, -1]) {
    for (const s2 of [1, -1]) {
      // P + s1·half·n1 + t·d1 = P + s2·half·n2 + u·d2
      const rx = s2 * half * n2[0] - s1 * half * n1[0];
      const rz = s2 * half * n2[1] - s1 * half * n1[1];
      const det = d1[0] * -d2[1] - -d2[0] * d1[1];
      if (Math.abs(det) < 1e-12) continue;
      const tt = (rx * -d2[1] - -d2[0] * rz) / det;
      const px = P[0] + s1 * half * n1[0] + tt * d1[0];
      const pz = P[1] + s1 * half * n1[1] + tt * d1[1];
      if (behind(px, pz, P[0], P[1], d1[0], d1[1]) && behind(px, pz, P[0], P[1], d2[0], d2[1])) {
        return [px, pz];
      }
    }
  }
  return null;
}

/** 收头在同一坐标上的墙端（≥2 个才算接头） */
function jointsOf(walls) {
  const key = (x, z) => `${Math.round(x * 1000)}:${Math.round(z * 1000)}`;
  const m = new Map();
  for (const s of segs(walls)) {
    for (const end of [0, 1]) {
      const P = end ? s.b : s.a;
      const d = end ? [-s.d[0], -s.d[1]] : s.d;       // 从端点指向墙里
      const k = key(P[0], P[1]);
      const list = m.get(k) ?? [];
      list.push({ P, d });
      m.set(k, list);
    }
  }
  return [...m.values()].filter((l) => l.length >= 2);
}

/**
 * 两条判据都在这里量：
 *  - `covered`：先判"这个点该不该被盖住"，该盖就必须盖住；
 *  - `outside`：画出来的多边形里，每一点都必须贴着某面墙身。
 */
function audit(walls, result, { step = 0.004, jointStep = 0.004, tol = JOINT_BITE_M + 0.001 } = {}) {
  const S = segs(walls);
  const jointsAll = jointsOf(walls);
  // "画出来的东西" = 构件 + 补角（三岔口以上才可能有补角）
  const polys = [...result.pieces.map(pieceCorners), ...result.fills.map((f) => f.poly)];
  const inside = (px, pz) => polys.some((q) => pointInQuad(px, pz, q));
  /**
   * 参考实体 = 每面墙自己的矩形 ∪ 每一对墙的补角区（都放宽 tol）。
   * ⚠️ 只判"到某面墙的中心线 ≤ 半厚"是不够的：轴对齐的接角块，四个角里总有一两个
   *    正好贴在**另一面墙**的墙身上（距离正好半厚），于是"方补丁"能蒙混过关
   *    —— 变异验证第 A 版就是这么没红的。必须判"在不在实体里"。
   */
  const inRect = (px, pz) => S.some((s) => {
    const dx = px - s.a[0];
    const dz = pz - s.a[1];
    const along = dx * s.d[0] + dz * s.d[1];
    const across = dx * -s.d[1] + dz * s.d[0];
    return along >= -tol && along <= s.len + tol && Math.abs(across) <= HALF + tol;
  });
  const inPair = (px, pz) => jointsAll.some((list) => {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const p = list[i];
        const q = list[j];
        // ⚠️ jointsOf 给的是 {P:[x,z], d}；写成 p.x/p.z 会得到 undefined → 距离算成 NaN →
        //    四条 continue 一条都不生效 → 恒真 → "多盖"永远为 0（变异验证 A 版就是这么假绿的）
        if (distToLine(px, pz, p.P[0], p.P[1], p.d[0], p.d[1]) > HALF + tol) continue;
        if (distToLine(px, pz, q.P[0], q.P[1], q.d[0], q.d[1]) > HALF + tol) continue;
        if ((px - p.P[0]) * p.d[0] + (pz - p.P[1]) * p.d[1] > tol) continue;
        if ((px - q.P[0]) * q.d[0] + (pz - q.P[1]) * q.d[1] > tol) continue;
        return true;
      }
    }
    return false;
  });
  const inRef = (px, pz) => inRect(px, pz) || inPair(px, pz);
  let missed = 0;
  let missedArea = 0;
  let overshoot = 0;
  let checked = 0;

  // ① 每面墙自己的矩形（自由端是方头：沿线段方向不许超、横向半厚）
  //    ⚠️ 一定要**沿墙自己的轴**采样：按包围盒采样的话，水平墙的"包围盒高度"是 0，
  //    内层循环一次都不跑 —— 采样数看着不少，其实横墙一个点都没量（第一版就是这个坑）。
  for (const s of S) {
    const n = perp(s.d[0], s.d[1]);
    for (let u = 0.001; u <= s.len - 0.001; u += step) {
      for (let v = -(HALF - 0.001); v <= HALF - 0.001; v += step) {
        const x = s.a[0] + s.d[0] * u + n[0] * v;
        const z = s.a[1] + s.d[1] * u + n[1] * v;
        checked++;
        if (!inside(x, z)) missed++;
      }
    }
  }

  // ② 每个接头的缺口（"两面墙都盖得住 + 都在两端面之后"）
  for (const list of jointsOf(walls)) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const p = list[i];
        const q = list[j];
        const dotv = p.d[0] * q.d[0] + p.d[1] * q.d[1];
        const cro = p.d[0] * q.d[1] - p.d[1] * q.d[0];
        const alpha = (Math.atan2(Math.abs(cro), dotv) * 180) / Math.PI;
        if (alpha < 1.5 || 180 - alpha < 1.5) continue;        // 同向/反向：没有缺口
        const far = jointCorner(p.P, p.d, q.d, HALF);
        if (!far) continue;
        const x0 = Math.min(p.P[0], far[0]) - HALF - 0.002;
        const x1 = Math.max(p.P[0], far[0]) + HALF + 0.002;
        const z0 = Math.min(p.P[1], far[1]) - HALF - 0.002;
        const z1 = Math.max(p.P[1], far[1]) + HALF + 0.002;
        for (let x = x0; x <= x1; x += jointStep) {
          for (let z = z0; z <= z1; z += jointStep) {
            const near1 = distToLine(x, z, p.P[0], p.P[1], p.d[0], p.d[1]);
            const near2 = distToLine(x, z, q.P[0], q.P[1], q.d[0], q.d[1]);
            // 判"该被盖住"：两面墙身都盖得住，且都在两个端面之后（各让 1 mm，躲开边界抖动）
            if (near1 > HALF - 0.001 || near2 > HALF - 0.001) continue;
            if (!behind(x, z, p.P[0], p.P[1], p.d[0], p.d[1]) || !behind(x, z, q.P[0], q.P[1], q.d[0], q.d[1])) continue;
            if ((x - p.P[0]) * p.d[0] + (z - p.P[1]) * p.d[1] > -0.001) continue;
            if ((x - q.P[0]) * q.d[0] + (z - q.P[1]) * q.d[1] > -0.001) continue;
            checked++;
            if (!inside(x, z)) { missed++; missedArea += jointStep * jointStep; }
          }
        }
      }
    }
  }

  // ③ 不多盖：把每个多边形的包围盒扫一遍，落在里面的点必须落在**参考实体**里
  // （墙自己的矩形 ∪ 两墙的补角区）—— 光看"贴着某面墙"挡不住方补丁（见 `inRef` 的注释）
  for (const poly of polys) {
    let bx0 = Infinity;
    let bx1 = -Infinity;
    let bz0 = Infinity;
    let bz1 = -Infinity;
    for (const [x, z] of poly) {
      bx0 = Math.min(bx0, x); bx1 = Math.max(bx1, x);
      bz0 = Math.min(bz0, z); bz1 = Math.max(bz1, z);
    }
    for (let x = bx0; x <= bx1; x += step) {
      for (let z = bz0; z <= bz1; z += step) {
        if (!pointInQuad(x, z, poly)) continue;
        if (!inRef(x, z)) overshoot++;
      }
    }
  }
  return { checked, missed, missedMm2: Math.round(missedArea * 1e6), overshoot };
}

test('四面外墙 → 4 个构件、4 个接头（角上各一对斜接裁切）', () => {
  const r = wallPieces(room(8, 6), { thickness: T });
  assert.equal(r.pieces.length, 4);
  assert.equal(r.joints.length, 4, '四个角都是"两根墙收头"的接头');
  assert.equal(r.joints.filter((j) => j.cuts === 2).length, 4, '每个角一对斜接（两根墙各被裁一刀）');
  for (const p of r.pieces) assert.equal(p.cls, 'boundary');
  for (const p of r.pieces) assert.equal(p.mitred, true, '房间四角必须是斜接裁过的');
});

test('⭐ 无缺口：每面墙自己的矩形 + 四个角，全都盖得住', () => {
  const walls = boundaryWalls(8, 6);
  const r = wallPieces(room(8, 6), { thickness: T });
  const a = audit(walls, r, { step: 0.01 });
  assert.ok(a.checked > 2000, `采样点太少（${a.checked}）就说明不了问题`);
  assert.equal(a.missed, 0, `有缺口：${a.missed} 个采样点没被盖住（${a.missedMm2} mm²）`);
});

test('⭐ 不多盖：房间四角的斜接不许戳出墙身之外', () => {
  const r = wallPieces(room(8, 6), { thickness: T });
  const a = audit(boundaryWalls(8, 6), r, { step: 0.01 });
  assert.equal(a.overshoot, 0, `有 ${a.overshoot} 个采样点跑到墙身外面去了`);
});

test('自由端不缩不伸：内墙画到哪儿就是哪儿', () => {
  const layout = room(8, 6);
  layout.walls = [...layout.walls, W(2, 3, 6, 3)];
  const r = wallPieces(layout, { thickness: T });
  const inner = r.pieces.find((p) => p.cls === 'interior');
  assert.ok(inner, '内墙构件应该在');
  assert.equal(inner.extA, 0);
  assert.equal(inner.extB, 0);
  assert.equal(inner.mitred, false);
  assert.equal(r.joints.length, 4, '只有四个房间角是接头');
});

test('T 形接头：落在别人身段上的那头，端面**平行于那面墙**（垂直/斜着都要齐平）', () => {
  const layout = room(8, 6);
  layout.walls = [...layout.walls, W(0, 3, 6, 3)];        // 一端落在西墙身段上
  const r = wallPieces(layout, { thickness: T });
  const inner = r.pieces.find((p) => p.cls === 'interior');
  const poly = pieceCorners(inner);
  // 找出"最靠西"的那条边（就是端面），它必须与西墙（竖直，方向 (0,1)）平行
  let best = null;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if (!best || (a[0] + b[0]) / 2 < (best.a[0] + best.b[0]) / 2) best = { a, b };
  }
  const ex = best.b[0] - best.a[0];
  const ez = best.b[1] - best.a[1];
  const l = Math.hypot(ex, ez);
  assert.ok(Math.abs(ex / l) < 1e-9, `端面必须平行于西墙（竖直）：方向 (${(ex / l).toFixed(6)}, ${(ez / l).toFixed(6)})`);
  assert.equal(r.joints.filter((j) => j.ends === 1).length, 1, 'T 形接头：一根收头 + 一根路过');
});

test('⭐ 斜着对接 T 形接头也一样齐平（30°）', () => {
  const layout = room(8, 6);
  // 一面斜墙从西墙身段上出发（30°），端点落在西墙上
  layout.walls = [...layout.walls, W(0, 3, 6 * Math.cos(Math.PI / 6), 3 + 6 * Math.sin(Math.PI / 6))];
  const r = wallPieces(layout, { thickness: T });
  const inner = r.pieces.find((p) => p.cls === 'interior');
  const poly = pieceCorners(inner);
  let best = null;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if (!best || (a[0] + b[0]) / 2 < (best.a[0] + best.b[0]) / 2) best = { a, b };
  }
  const ex = best.b[0] - best.a[0];
  const l = Math.hypot(ex, best.b[1] - best.a[1]);
  assert.ok(Math.abs(ex / l) < 1e-9, `斜墙的端面也要平行于西墙（竖直）：${(ex / l).toFixed(6)}`);
  const a = audit(layout.walls, r, { step: 0.01 });
  assert.equal(a.missed, 0, `斜 T 形接头有缺口：${a.missedMm2} mm²`);
  assert.equal(a.overshoot, 0, `斜 T 形接头多盖了 ${a.overshoot} 个点`);
});

test('斜墙照样沿自己的朝向建构件（不再取 AABB）', () => {
  const layout = room(8, 6);
  layout.walls = [...layout.walls, W(1, 1, 5, 4)];
  const r = wallPieces(layout, { thickness: T });
  const inner = r.pieces.find((p) => p.cls === 'interior');
  // 两端都悬空 → 一点都不缩不伸：斜边长就是 hypot(4,3) = 5
  assert.ok(Math.abs(inner.len - Math.hypot(4, 3)) < 1e-9, `斜墙长度就是斜边：${inner.len}`);
  assert.equal(inner.extA, 0);
  assert.equal(inner.extB, 0);
  // 四角必须贴着墙身（不能跑到中心线半厚以外）
  for (const [x, z] of pieceCorners(inner)) {
    assert.ok(distToLine(x, z, 1, 1, 0.8, 0.6) <= HALF + 1e-9, `斜墙的角跑出墙身：(${x.toFixed(3)}, ${z.toFixed(3)})`);
  }
});

test('比墙厚还短的墙不至于被缩成负数 / 被裁没', () => {
  const layout = room(8, 6);
  layout.walls = [...layout.walls, W(0, 1, 0.05, 1)];      // 5 cm 的小墙
  const r = wallPieces(layout, { thickness: T });
  for (const p of r.pieces) {
    assert.ok(pieceCorners(p).length >= 3, '构件至少要有 3 个角');
    assert.ok(Math.abs(polyArea(pieceCorners(p))) > 0, '构件面积必须为正');
  }
});

test('构件带着它在 layout.walls 里的序号（平面图要靠它跟「哪面墙」对上）', () => {
  const layout = room(8, 6);
  layout.walls = [...layout.walls, W(2, 3, 6, 3)];
  const r = wallPieces(layout, { thickness: T });
  assert.equal(r.pieces.length, 5);
  for (const p of r.pieces) assert.equal(layout.walls[p.index], p.wall, '构件的序号必须指回它那面墙（数组同一份）');
});

/* ------------------------------------------------------------------ *
 * 斜接（mitre）—— 本轮的正主
 * ------------------------------------------------------------------ */

/** 一面墙从 P 出发，方向由角度给定；两面墙在 P 收头，夹角 alpha */
const hinge = (alphaDeg, len = 2) => {
  const a = (alphaDeg * Math.PI) / 180;
  return [
    W(0, 0, len, 0),
    W(0, 0, len * Math.cos(a), len * Math.sin(a)),
  ];
};

test('⭐ 斜接 · 角度扫一遍：10°..170°，每 5° 都不许有缺口、也不许多盖', () => {
  const bad = [];
  for (let alpha = 10; alpha <= 170; alpha += 5) {
    const walls = hinge(alpha);
    const r = wallPieces({ w: 2, d: 2, h: 2.6, walls }, { thickness: T });
    const a = audit(walls, r, { step: 0.005, jointStep: 0.003 });
    if (a.missed || a.overshoot) bad.push({ alpha, missed: a.missedMm2, overshoot: a.overshoot });
  }
  assert.deepEqual(bad, [], `这些角度上有缺口/多盖：${JSON.stringify(bad)}`);
});

test('⭐ 斜接 · 45° 的构件是**沿着角平分线**对接的（两根墙同一条斜线）', () => {
  const walls = hinge(45);
  const r = wallPieces({ w: 2, d: 2, h: 2.6, walls }, { thickness: T });
  assert.equal(r.pieces.length, 2);
  assert.equal(r.joints.length, 1);
  assert.equal(r.joints[0].cuts, 2);
  for (const p of r.pieces) assert.equal(p.mitred, true);
  // 角平分线方向（45°/2 = 22.5°）上，两个构件的端面必须都贴着这条线
  // （各被"咬入"推出去 0.5 mm，所以容差取咬入量）
  const u = [Math.cos(Math.PI / 8), Math.sin(Math.PI / 8)];
  for (const p of r.pieces) {
    const poly = pieceCorners(p);
    // 找一条"两端点都贴在角平分线上"的边
    const onLine = poly.map(([x, z]) => Math.abs(x * -u[1] + z * u[0]));
    let found = false;
    for (let i = 0; i < poly.length; i++) {
      const j = (i + 1) % poly.length;
      if (onLine[i] < JOINT_BITE_M + 1e-6 && onLine[j] < JOINT_BITE_M + 1e-6) found = true;
    }
    assert.ok(found, `每个构件都要有一条边贴在角平分线上（这就是"斜接"）：${JSON.stringify(poly)}`);
  }
});

test('⭐ 斜接 · 两个构件只在咬入那一层重叠（其余地方不许穿模）', () => {
  const walls = hinge(45);
  const r = wallPieces({ w: 2, d: 2, h: 2.6, walls }, { thickness: T });
  const polys = r.pieces.map(pieceCorners);
  // 在接点附近细采样：被两个构件同时盖住的面积必须只有咬入那一点点
  let both = 0;
  const step = 0.001;
  let n = 0;
  for (let x = -0.2; x <= 0.2; x += step) {
    for (let z = -0.2; z <= 0.2; z += step) {
      n++;
      if (polys.every((q) => pointInQuad(x, z, q))) both++;
    }
  }
  const bothAreat = both * step * step;
  assert.ok(bothAreat < 8 * JOINT_BITE_M * T, `两个构件重叠太多：${(bothAreat * 1e6).toFixed(1)} mm²（只允许咬入那一层）`);
  assert.ok(n > 100000, '采样够密才算数');
});

test('同向（一堵墙拆成两段接着画）：对接，不裁 —— 也不许有缝', () => {
  const walls = [W(0, 0, 2, 0), W(2, 0, 4, 0)];
  const r = wallPieces({ w: 4, d: 2, h: 2.6, walls }, { thickness: T });
  assert.equal(r.pieces.length, 2);
  assert.equal(r.joints[0].cuts, 0, '直线接着画不需要裁切线');
  for (const p of r.pieces) assert.equal(p.mitred, false);
  const a = audit(walls, r, { step: 0.005 });
  assert.equal(a.missed, 0, `对接处有缝：${a.missedMm2} mm²`);
  assert.equal(a.overshoot, 0, '对接处多盖了');
});

test('折回来（夹角 ≈ 0°）不炸：仍然出构件，也不许抛异常', () => {
  const walls = hinge(0.5);
  const r = wallPieces({ w: 2, d: 2, h: 2.6, walls }, { thickness: T });
  assert.equal(r.pieces.length, 2);
  for (const p of r.pieces) {
    assert.ok(pieceCorners(p).length >= 3);
    assert.ok(Number.isFinite(p.extA) && Number.isFinite(p.extB));
  }
});

test('⭐ 三根墙在一个点收头（T 的三岔口）：一圈铺满，不留缝也不多盖', () => {
  const walls = [
    W(0, 0, 2, 0),                                  // 向东
    W(0, 0, 2 * Math.cos(Math.PI / 3), 2 * Math.sin(Math.PI / 3)),   // 60°
    W(0, 0, 2 * Math.cos(-Math.PI / 3), 2 * Math.sin(-Math.PI / 3)), // −60°
  ];
  const r = wallPieces({ w: 2, d: 2, h: 2.6, walls }, { thickness: T });
  assert.equal(r.pieces.length, 3);
  assert.equal(r.joints.length, 1);
  assert.equal(r.joints[0].ends, 3);
  const a = audit(walls, r, { step: 0.005, jointStep: 0.003 });
  assert.equal(a.missed, 0, `三岔口有缺口：${a.missedMm2} mm²`);
  assert.equal(a.overshoot, 0, '三岔口多盖了');
});

test('⭐ 四根墙在一个点收头（十字口）：同样铺满', () => {
  const walls = [
    W(0, 0, 2, 0),
    W(0, 0, 0, 2),
    W(0, 0, -2, 0),
    W(0, 0, 0, -2),
    W(2, 0, 2, 2),                                   // 顺带一个直角，混着来
  ];
  const r = wallPieces({ w: 2, d: 2, h: 2.6, walls }, { thickness: T });
  const a = audit(walls, r, { step: 0.005, jointStep: 0.003 });
  assert.equal(a.missed, 0, `十字口有缺口：${a.missedMm2} mm²`);
  assert.equal(a.overshoot, 0, '十字口多盖了');
});

test('接头的台账能对上：谁跟谁在哪儿接头、裁了几刀', () => {
  const layout = room(8, 6);
  layout.walls = [...layout.walls, W(1, 1, 3, 1), W(3, 1, 4.4, 2.4)];   // 一根水平 + 一根 45° 斜墙
  const r = wallPieces(layout, { thickness: T });
  assert.equal(r.joints.length, 4 + 1, '四个房间角 + 内墙那个角');
  const inner = r.joints.find((j) => Math.abs(j.x - 3) < 1e-9 && Math.abs(j.z - 1) < 1e-9);
  assert.ok(inner, '内角 (3,1) 应该在台账里');
  assert.equal(inner.ends, 2);
  assert.equal(inner.cls, 'interior');
});