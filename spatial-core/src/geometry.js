/**
 * geometry.js —— 2D 几何基元（纯函数：无框架 / 无 DOM / 无 Three.js）
 *
 * 来源：忠实搬运 `r1/src/scripts/01_main-module.js` 的 corners() / overlap() / ext()。
 * R2 是"抽取"不是"重写"：行为逐条对齐，容差常数原样保留（见下方具名常量）。
 * ⚠️ 改这里必须同步改 test/ 断言 —— 它是 Java 侧实现的验收基准。
 */
import { cfg } from './params.js';
import { wallSeg } from './wall.js';

export const DEG = Math.PI / 180;

/** 退化线段阈值（原型 len < 1e-8） */
export const EPS = 1e-8;

// 参数见 params.js：cfg.space.overlapTolM

// 参数见 params.js：cfg.space.wallThicknessM

// 参数见 params.js：cfg.space.snapM

// 参数见 params.js：cfg.space.rotateStepDeg

/** 与原型 toFixed(1) 等价（返回数值而非字符串） */
export const round1 = (v) => Math.round(v * 10) / 10;

/**
 * 位置精度：**毫米**（3 位小数）。模型包围盒是 mm 口径（`1236.0 mm`），位置只到 dm(0.1 m)
 * 就永远贴不到墙面 —— 用户实测反馈「只能输一位小数」。
 *
 * 谁用哪个：
 *  - `roundMm` = **用户输入/落库**的精度（精确值）；
 *  - `round1` = **拖动/自动找位**的粗吸附（配合 `space.snapM`，拖动仍是 0.1 m 一档）。
 * 两者不同不是笔误：拖动是粗活，输入是细活；用同一个精度会让拖动变难用。
 */
export const roundMm = (v) => Math.round(v * 1000) / 1000;

/** 旋转矩形的 4 个角（围绕中心就地旋转；与原型 corners() 逐行一致） */
export function corners(x, z, w, d, rDeg) {
  const c = Math.cos(rDeg * DEG);
  const s = Math.sin(rDeg * DEG);
  return [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]]
    .map(([a, b]) => [x + a * c - b * s, z + a * s + b * c]);
}

/** 旋转后的轴对齐外接尺寸（原型 ext()） */
export function extents(w, d, rDeg) {
  const r = rDeg * DEG;
  return {
    w: Math.abs(w * Math.cos(r)) + Math.abs(d * Math.sin(r)),
    d: Math.abs(w * Math.sin(r)) + Math.abs(d * Math.cos(r)),
  };
}

/**
 * 两凸多边形是否重叠（分离轴定理 SAT；与原型 overlap() 逐行一致）。
 * 依次取两个多边形的前两条边（对矩形即两个互相垂直的轴）投影，
 * 任一轴上"投影不交叠（含 5 mm 容差）"即判定分离。
 */
export function overlap(a, b, tol = cfg.space.overlapTolM) {
  for (const v of [a, b]) {
    for (let k = 0; k < 2; k++) {
      const dx = v[k + 1][0] - v[k][0];
      const dz = v[k + 1][1] - v[k][1];
      const len = Math.hypot(dx, dz);
      if (len < EPS) continue;
      const ax = -dz / len;
      const az = dx / len;
      const pa = a.map((p) => p[0] * ax + p[1] * az);
      const pb = b.map((p) => p[0] * ax + p[1] * az);
      if (Math.max(...pa) <= Math.min(...pb) + tol) return false;
      if (Math.max(...pb) <= Math.min(...pa) + tol) return false;
    }
  }
  return true;
}

/** 线段 → 以中点为心的"墙矩形"四角（内墙碰撞用；原型内联在 invalid() 里） */
export function wallBox(wall) {
  const [x, z, xx, zz] = wallSeg(wall);
  return corners(
    (x + xx) / 2,
    (z + zz) / 2,
    Math.hypot(xx - x, zz - z),
    cfg.space.wallThicknessM,
    Math.atan2(zz - z, xx - x) / DEG,
  );
}

/** 点是否落在矩形内（含边界） */
export function pointInRect(px, pz, x, z, w, d) {
  return px >= x && px <= x + w && pz >= z && pz <= z + d;
}

/**
 * 去掉重合点（裁切会产生 1e-16 级的重复点，会让"点在内"测试变糊）。
 *
 * ⚠️ 原来住在 `wallpieces.js` 里，W1（门洞）把它和 `clipHalfPlane` 一起搬到这里：
 * 门洞要把带洞的墙切成"左段 / 右段 / 过梁"，用的是**同一把刀**。
 * 两处各写一把裁刀，迟早一边改了另一边没改（本项目最贵的教训就是"同一样东西写两遍"）。
 */
export function dedupePoints(poly) {
  const out = [];
  for (const p of poly) {
    const q = out[out.length - 1];
    if (q && Math.abs(p[0] - q[0]) < 1e-7 && Math.abs(p[1] - q[1]) < 1e-7) continue;
    out.push(p);
  }
  if (out.length > 1) {
    const a = out[0];
    const b = out[out.length - 1];
    if (Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7) out.pop();
  }
  return out;
}

/**
 * 按**符号距离函数**裁凸多边形（Sutherland–Hodgman）：保留 `s(p) ≤ limit` 的一侧。
 * 凸多边形被半平面裁完还是凸的 —— 这一条是"带洞的墙可以分解成几块凸棱柱"的全部依据。
 * @param {Array<[number,number]>} poly
 * @param {(p:[number,number])=>number} s 符号距离（≤ limit 的一侧保留）
 */
export function clipHalfPlane(poly, s, limit = 0) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const sa = s(a);
    const sb = s(b);
    if (sa <= limit) out.push(a);
    if ((sa < limit && sb > limit) || (sa > limit && sb < limit)) {
      const tt = (limit - sa) / (sb - sa);
      out.push([a[0] + (b[0] - a[0]) * tt, a[1] + (b[1] - a[1]) * tt]);
    }
  }
  return dedupePoints(out);
}

/**
 * 多边形**有符号**面积（鞋带公式）。
 *
 * 符号就是环绕方向：本项目平面坐标是 (x, z)，逆时针（数学正向）为正、顺时针为负。
 * M1 多房间拿它当**面遍历的验收线**：内部面的和必须恰好等于整栋 w×d，
 * 外侧那个面无界、符号相反 —— 一个符号就分开了"面"与"外面"。
 *
 * 重复顶点 / 原路折返（墙戳进房间又退出来形成的"尖刺"）都对面积**零贡献** ——
 * 所以自由端的内墙不会把房间切坏，这是派生房间能容错的关键一条。
 */
export function polyArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

/**
 * 多边形形心（面积加权）。零面积的多边形返回顶点平均（退化时也要给个位置，不返回 null ——
 * 调用方拿它当"这一块在哪儿"的锚，返回 null 会逼着每处都写兜底）。
 */
export function polyCentroid(poly) {
  const a = polyArea(poly);
  if (Math.abs(a) < 1e-12) {
    const n = poly.length || 1;
    return [poly.reduce((s, p) => s + p[0], 0) / n, poly.reduce((s, p) => s + p[1], 0) / n];
  }
  let cx = 0;
  let cz = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    const f = p[0] * q[1] - q[0] * p[1];
    cx += (p[0] + q[0]) * f;
    cz += (p[1] + q[1]) * f;
  }
  return [cx / (6 * a), cz / (6 * a)];
}

/**
 * 点是否在多边形内（奇偶规则，含边界视为在内）。
 *
 * ⚠️ 边界那条用 `onSeg` 先判一次：奇偶规则对"正好落在边上"的点是**未定义**的
 *（射线法会随顶点顺序给出不同答案）。房间是零宽的中心线剖分，用户点到墙上、点在地板缝上
 * 都会踩到这条 —— 不显式判边界，就会出现"同一间房点两下答案不一样"这种最招人骂的抖动。
 * @param {[number,number]} p 点（[x, z]）
 * @param {number} [tol] 判"落在边上"的容差（米）
 */
export function pointInPoly(poly, p, tol = 1e-9) {
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    if (segmentDistance(p[0], p[1], a[0], a[1], b[0], b[1]) <= tol) return true;
  }
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if ((a[1] > p[1]) !== (b[1] > p[1])) {
      const t = (p[1] - a[1]) / (b[1] - a[1]);
      if (p[0] < a[0] + t * (b[0] - a[0])) inside = !inside;
    }
  }
  return inside;
}

/** 点到线段的距离（漫游碰撞用；R2 后续从 02_walkthrough.js 搬运） */
export function segmentDistance(px, pz, x1, z1, x2, z2) {
  const dx = x2 - x1;
  const dz = z2 - z1;
  const len2 = dx * dx + dz * dz;
  if (len2 < EPS) return Math.hypot(px - x1, pz - z1);
  let t = ((px - x1) * dx + (pz - z1) * dz) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), pz - (z1 + t * dz));
}