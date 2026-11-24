/**
 * wallpieces.js —— 把"几面墙"变成"能真的斜接（mitre）的构件"（纯函数，不碰 three）
 *
 * ## 为什么有它
 *
 * 设计端先后提过三轮，根子是同一个：**同一样东西在几个地方各画了一遍**。
 *
 *  ① 转角处两个盒子互相穿模、顶面共面打架、半透明内墙排序错乱（"缝隙/面错位/破面"）；
 *  ② 平面图每面墙各画一个原始盒子 → 内角留一个 (t/2)×(t/2) 的方缺口（实测 18 000 mm²）；
 *  ③ **两墙斜着交汇**时，接角块是个**轴对齐**的 t×t 正方形 —— 咬合是闭合的，
 *     但它的四个角会戳到墙身外面去，看上去就是一块"方补丁"。
 *
 * 几何做法（不引 CSG，全是平面多边形裁切）：
 *
 *  - 墙构件是**沿墙朝向**的矩形（不再取 AABB，斜墙也照样对）；
 *  - 每根墙的两端各自算出"该往端点外面伸多少"（`extA` / `extB`）——
 *    伸出去的量由**裁切线**决定：伸到裁切线为止，多出来的部分会被裁掉；
 *  - 两墙在一个端点交汇时，裁切线 = 过端点、方向取**两墙身方向的角平分线**；
 *    两边各保留靠**自己身子**的那一侧 —— 于是两根构件沿着同一条斜线对接，
 *    合起来正好铺满那个平行四边形缺口，**谁都不多出一块**（这就是斜接 mitre）；
 *  - **≥3 根墙**在一点收头时，按角度排成一圈，逐对算裁切线，每根墙被自己两侧的
 *    两条裁切线夹住 —— 一圈铺满，不需要额外的角块；
 *  - **一根墙收头、另一根只是路过**（T 形接头）：裁在路过那根墙的**远端面**上
 *    （面平行于路过那根墙）—— 垂直时与"缩半个墙厚"等价，斜着时才是齐平的；
 *  - **同向/反向**（夹角 < 1.5° 或 > 178.5°，例如一堵墙拆成两段接着画）不裁，直接对接；
 *  - 所有贴合面都**故意咬进去 `JOINT_BITE_M`**（0.5 mm）：共面才是深度打架的根，
 *    让面错开一点点，"看不见的重叠"比"看得见的缝"便宜得多。
 *
 * ## 判据（都在测试里，且与实现无关）
 *
 *  - **无缺口**：每面墙自己的矩形、以及每个交汇点"两面墙身都盖得住且都在两端面之后"
 *    的那片区域，都必须被画出来的多边形覆盖；
 *  - **不多盖**：画出来的每一点都必须落在**某一面墙身**（到中心线距离 ≤ 半厚 + 咬入）里
 *    —— "方补丁"戳出去的那四个角就是这条判据抓出来的。
 *
 * 两条都做过变异验证：退回"轴对齐正方形接角块"→ 第二条红；只裁不伸 → 第一条红。
 */
import { cfg } from './params.js';
import { isBoundaryWall } from './room.js';
// 裁刀与去重点只有**一份**（W1 起住在 geometry.js）：门洞要把带洞的墙切成左段/右段/过梁，
// 用的是同一把刀。别名保持函数体里的旧名字，改动面就只剩这一行导入。
import { clipHalfPlane, dedupePoints as dedupe } from './geometry.js';
import { wallSeg } from './wall.js';

/** 贴合处的"故意咬入"：让贴合面错开，避免共面打架。0.5 mm */
export const JOINT_BITE_M = 0.0005;
/** 裁切线跑到这么远（米）就不认了 —— 夹角小于 1° 时斜接会拉出几米的尖刺 */
export const MITRE_MAX_M = 8;
/** 夹角小于它 = 几乎同向/反向，不做斜接（对接即可） */
const STRAIGHT_DEG = 1.5;
const EPS = 1e-9;

const keyOf = (x, z) => `${Math.round(x * 1000)}:${Math.round(z * 1000)}`;
/** 平面内逆时针 90°：n = (-z, x) */
const perp = (x, z) => [-z, x];

/** 点是否落在某根墙的**身段**上（含端点）—— 用来认 T 形接头 */
function pointOnWall(px, pz, wall, eps = 1e-6) {
  const [x, z, xx, zz] = wallSeg(wall);
  const dx = xx - x;
  const dz = zz - z;
  const len2 = dx * dx + dz * dz;
  if (len2 < 1e-18) return Math.hypot(px - x, pz - z) <= eps;
  let tt = ((px - x) * dx + (pz - z) * dz) / len2;
  tt = Math.max(0, Math.min(1, tt));
  return Math.hypot(px - (x + dx * tt), pz - (z + dz * tt)) <= eps;
}

/** 有向面积（平面，逆时针为正） */
export function polyArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

/**
 * 用一条**有向直线**裁：直线过 `(px,pz)`、方向 `(ux,uz)`，保留 `keep` 那一侧，
 * 但允许**咬过线 `limit`**（默认 0 —— 咬入就是为了让贴合面错开，不共面打架）。
 */
function clipByLine(poly, px, pz, ux, uz, keepX, keepZ, limit) {
  let nx = -uz;
  let nz = ux;
  if ((keepX - px) * nx + (keepZ - pz) * nz > 0) { nx = -nx; nz = -nz; } // n 指向"要去掉"的那一侧
  return clipHalfPlane(poly, (p) => (p[0] - px) * nx + (p[1] - pz) * nz, limit);
}

/** 保留 {p : (p − P)·n ≤ off} —— 用它表达"墙身两侧"和"端面之后" */
function clipByNormal(poly, P, n, off) {
  return clipHalfPlane(poly, (p) => (p[0] - P[0]) * n[0] + (p[1] - P[1]) * n[1], off);
}

/**
 * 两墙之间的**补角**：这块缺口本该由斜接铺满，但两根墙的扇形比墙身还宽时铺不满。
 *   {|p·n₁| ≤ half} ∩ {|p·n₂| ≤ half} ∩ {p·d₁ ≤ 0} ∩ {p·d₂ ≤ 0}
 * 四条约束全部来自**墙的定义**（到中心线的距离、在端面之后），
 * 所以它一定落在两面墙身里面 —— "不多盖"这条判据天然成立，不用额外补丁。
 */
function pairFill(P, a, b, half) {
  const sin = Math.abs(a.d[0] * b.d[1] - a.d[1] * b.d[0]);
  if (!(sin > 0.02)) return null;                    // 几乎同向/反向：补角会拉成无限长，不做
  const na = perp(a.d[0], a.d[1]);
  const nb = perp(b.d[0], b.d[1]);
  const R = (2 * half) / sin + 2 * half;
  let poly = [
    [P[0] - R, P[1] - R], [P[0] + R, P[1] - R], [P[0] + R, P[1] + R], [P[0] - R, P[1] + R],
  ];
  poly = clipByNormal(poly, P, na, half);
  poly = clipByNormal(poly, P, [-na[0], -na[1]], half);
  poly = clipByNormal(poly, P, nb, half);
  poly = clipByNormal(poly, P, [-nb[0], -nb[1]], half);
  poly = clipByNormal(poly, P, a.d, 0);
  poly = clipByNormal(poly, P, b.d, 0);
  if (poly.length < 3 || Math.abs(polyArea(poly)) < 1e-9) return null;
  return poly;
}

/**
 * "墙身在哪一侧"的见证点：取**这面墙的另一头**。
 * ⚠️ 不能取 "端点 + 半厚·方向"：那个点还挤在接头里（两墙交汇处它可能落在裁切线的**另一侧**），
 *    于是"保留墙身那一侧"会变成"保留接头那一侧"，整根墙被裁掉。
 */
function keepWitness(en) {
  const s = en.s;
  const far = en.end === 'a' ? s.b : s.a;
  return [far[0], far[1]];
}

/** 端点 + 它是哪一头 + 从端点指向墙里的方向 */
function endInfo(s, end) {
  const d = end === 'a' ? s.dir : [-s.dir[0], -s.dir[1]];
  const p = end === 'a' ? s.a : s.b;
  return { s, end, p, d };
}

/**
 * @param {object} layout  {w,d,h,walls}
 * @param {object} [opts]  thickness / bite（测试用；默认取参数表）
 * @returns {{pieces:Array, joints:Array, thickness:number, bite:number, h:number}}
 *   piece = {cls:'boundary'|'interior', index, wall, poly, len, thickness, h, extA, extB, clamped, mitred}
 *           `index` 是它在 `layout.walls` 里的序号 —— 平面图要靠它跟「哪面墙」对上
 *           `poly` 是**已经裁好的多边形**（斜接后可能是 5 边形），平面/三维/打印共用这一份
 *   joint = {x, z, cls, ends, passers, cuts} —— 只是台账（谁跟谁在哪儿接头、裁了几刀），没有几何
 */
export function wallPieces(layout, opts = {}) {
  const t = opts.thickness ?? cfg.space.wallThicknessM;
  const bite = opts.bite ?? JOINT_BITE_M;
  const h = layout.h;
  const half = t / 2;

  // ① 墙 → 线段（丢掉零长的）
  const segs = [];
  for (let wi = 0; wi < layout.walls.length; wi++) {
    const wall = layout.walls[wi];
    const [x, z, xx, zz] = wallSeg(wall);
    const len = Math.hypot(xx - x, zz - z);
    if (!(len > 1e-9)) continue;
    segs.push({
      wall,
      index: wi,
      len,
      a: [x, z],
      b: [xx, zz],
      dir: [(xx - x) / len, (zz - z) / len],
      boundary: isBoundaryWall(layout, wall),
    });
  }

  // ② 端点登记：谁在这里**收头**（enders）、谁只是**路过**（passers）
  const ends = new Map();
  for (const s of segs) {
    for (const end of ['a', 'b']) {
      const p = end === 'a' ? s.a : s.b;
      const k = keyOf(p[0], p[1]);
      let e = ends.get(k);
      if (!e) { e = { x: p[0], z: p[1], enders: [], passers: [] }; ends.set(k, e); }
      e.enders.push({ s, end });
    }
  }
  for (const e of ends.values()) {
    for (const s of segs) {
      if (e.enders.some((x) => x.s === s)) continue;      // 它自己也在这里收头 → 是 ender
      if (pointOnWall(e.x, e.z, s.wall)) e.passers.push(s);
    }
  }

  // ③ 每个接头算裁切线
  const cutsAt = new Map();          // `${segIndex}:${end}` → [{px,pz,ux,uz,keep,why}]
  const joints = [];
  const fills = [];                  // 三岔口以上的补角（见 `pairFill` 的说明）
  const addCut = (en, cut) => {
    const k = `${en.s.index}:${en.end}`;
    const list = cutsAt.get(k) ?? [];
    list.push(cut);
    cutsAt.set(k, list);
  };

  for (const e of ends.values()) {
    const nEnd = e.enders.length;
    if (!nEnd) continue;
    if (nEnd === 1 && e.passers.length === 0) continue;     // 自由端：没有任何约束
    let cutCount = 0;

    if (nEnd >= 2) {
      // 按"从端点指向墙里"的方向排成一圈
      const items = e.enders
        .map((en) => {
          const i = endInfo(en.s, en.end);
          // ⚠️ 这里必须是**度**：后面算扇形、排角度都用度（第一版排的是弧度、
          //    扇形又拿 360 去取模，于是裁切线全是随机的，全局报缺口）
          return { en, d: i.d, ang: (Math.atan2(i.d[1], i.d[0]) * 180) / Math.PI };
        })
        .sort((p, q) => p.ang - q.ang);
      // ⚠️ **三根以上收头时不做斜接裁切**：斜接要成立，得让每根墙的扇形落在它自己的墙身里；
      //    而 Y 形那种"扇形 150°、墙身只到 90°"的情形做不到 —— 硬裁的话，被裁掉的那块
      //    既不在邻墙的扇形里、也没人补，就是一个洞（实测 4005 mm²）。
      //    三岔口以上改成：每根墙**保留自己的整条矩形**，缺口交给 `pairFill()` 精确补上。
      for (let i = 0; i < items.length; i++) {
        if (items.length !== 2) break;
        if (i === 1) continue;                               // 两面墙只有一对，别算两遍
        const p = items[i];
        const q = items[(i + 1) % items.length];
        // ⚠️ 裁切线的方向必须是**这一圈里从 p 逆时针转到 q 的那段扇形的平分线**，
        //    不能写成 normalize(d_p + d_q)：三岔口那种"扇形超过 180°"的情形会算成
        //    对面的那条平分线（从第三根墙身上穿过去），于是留下一个三角缺口。
        const sector = (((q.ang - p.ang) % 360) + 360) % 360;
        if (sector < STRAIGHT_DEG || Math.abs(sector - 180) < STRAIGHT_DEG) continue; // 同向/反向 → 对接，不裁
        const uAng = ((p.ang + sector / 2) * Math.PI) / 180;
        const u = [Math.cos(uAng), Math.sin(uAng)];           // 扇形平分线方向
        // 同一把刀，两边各留靠**自己身子**的那一侧
        addCut(p.en, { px: e.x, pz: e.z, ux: u[0], uz: u[1], keep: keepWitness(p.en), why: 'mitre' });
        addCut(q.en, { px: e.x, pz: e.z, ux: u[0], uz: u[1], keep: keepWitness(q.en), why: 'mitre' });
        cutCount += 2;
      }
      if (items.length >= 3) {
        // 每一对都要有补角（补角一定在两面墙身里，"不多盖"天然成立）
        for (let i = 0; i < items.length; i++) {
          for (let j = i + 1; j < items.length; j++) {
            const poly = pairFill([e.x, e.z], items[i], items[j], half);
            if (poly) {
              fills.push({
                cls: items[i].en.s.boundary && items[j].en.s.boundary ? 'boundary' : 'interior',
                x: e.x,
                z: e.z,
                ends: nEnd,
                h,
                poly,
              });
            }
          }
        }
      }
    } else {
      // 只有一根收头、别的只是路过：裁在路过那根墙的**远端面**上（面平行于那根墙）
      const en = e.enders[0];
      const info = endInfo(en.s, en.end);
      for (const ps of e.passers) {
        const np = perp(ps.dir[0], ps.dir[1]);
        const sign = info.d[0] * np[0] + info.d[1] * np[1] >= 0 ? 1 : -1;
        addCut(en, {
          px: e.x + np[0] * half * sign,
          pz: e.z + np[1] * half * sign,
          ux: ps.dir[0],
          uz: ps.dir[1],
          // 保留**靠墙身**的那一侧 —— 也就是端面齐平在路过那根墙的远端面上。
          // （写成"保留 P 那一侧"是错的：那会把整根墙裁掉，只留端点旁边一小块。）
          keep: keepWitness(en),
          why: 'flush',
        });
        cutCount++;
      }
    }
    joints.push({
      x: e.x,
      z: e.z,
      cls: e.enders.some((x) => x.s.boundary) ? 'boundary' : 'interior',
      ends: nEnd,
      passers: e.passers.length,
      cuts: cutCount,
    });
  }

  // ④ 一根一根算构件
  const pieces = [];
  for (const s of segs) {
    const myCuts = [];
    const ext = { a: 0, b: 0 };
    let clamped = false;
    let mitred = false;
    for (const end of ['a', 'b']) {
      const info = endInfo(s, end);
      const cuts = cutsAt.get(`${s.index}:${end}`) ?? [];
      if (!cuts.length) { ext[end] = 0; continue; }          // 自由端：一点都不缩不伸
      let need = 0;
      for (const c of cuts) {
        if (c.why === 'mitre') mitred = true;
        const nd = perp(info.d[0], info.d[1]);
        const den = c.ux * nd[0] + c.uz * nd[1];
        if (Math.abs(den) < 1e-7) continue;                  // 裁切线与墙身平行 → 约束不到这一端
        const off = (c.px - info.p[0]) * nd[0] + (c.pz - info.p[1]) * nd[1];
        for (const sgn of [1, -1]) {
          const ss = (sgn * half - off) / den;               // 裁切线落在墙身两条边上的参数
          const tx = c.px + c.ux * ss - info.p[0];
          const tz = c.pz + c.uz * ss - info.p[1];
          need = Math.max(need, -(tx * info.d[0] + tz * info.d[1]));  // 往端点**外面**要伸多少
        }
      }
      if (need > MITRE_MAX_M) { need = MITRE_MAX_M; clamped = true; }
      ext[end] = Math.max(0, need) + bite;                   // 咬入：贴合面错开，不共面打架
      myCuts.push(...cuts);
    }

    // 端面中点：从端点沿"墙身反方向"退回 ext
    const ia = endInfo(s, 'a');
    const ib = endInfo(s, 'b');
    const ma = [ia.p[0] - ia.d[0] * ext.a, ia.p[1] - ia.d[1] * ext.a];
    const mb = [ib.p[0] - ib.d[0] * ext.b, ib.p[1] - ib.d[1] * ext.b];
    const ax = mb[0] - ma[0];
    const az = mb[1] - ma[1];
    const L = Math.hypot(ax, az);
    if (!(L > EPS)) continue;
    const ad = [ax / L, az / L];
    const an = perp(ad[0], ad[1]);
    let poly = [
      [ma[0] + an[0] * half, ma[1] + an[1] * half],
      [mb[0] + an[0] * half, mb[1] + an[1] * half],
      [mb[0] - an[0] * half, mb[1] - an[1] * half],
      [ma[0] - an[0] * half, ma[1] - an[1] * half],
    ];
    for (const c of myCuts) poly = clipByLine(poly, c.px, c.pz, c.ux, c.uz, c.keep[0], c.keep[1], bite);
    // 被裁没了（极短的墙 + 一堆裁切线）→ 退回**没裁没伸**的原矩形：
    // 宁可多一块看得见的重叠，也不要凭空少一截墙。
    if (poly.length < 3 || Math.abs(polyArea(poly)) < 1e-9) {
      const w0 = [
        [s.a[0] + perp(s.dir[0], s.dir[1])[0] * half, s.a[1] + perp(s.dir[0], s.dir[1])[1] * half],
        [s.b[0] + perp(s.dir[0], s.dir[1])[0] * half, s.b[1] + perp(s.dir[0], s.dir[1])[1] * half],
        [s.b[0] - perp(s.dir[0], s.dir[1])[0] * half, s.b[1] - perp(s.dir[0], s.dir[1])[1] * half],
        [s.a[0] - perp(s.dir[0], s.dir[1])[0] * half, s.a[1] - perp(s.dir[0], s.dir[1])[1] * half],
      ];
      pieces.push({
        cls: s.boundary ? 'boundary' : 'interior', index: s.index, wall: s.wall, poly: w0,
        cx: (s.a[0] + s.b[0]) / 2, cz: (s.a[1] + s.b[1]) / 2, len: s.len,
        thickness: t, angleDeg: (Math.atan2(s.dir[1], s.dir[0]) * 180) / Math.PI, h,
        extA: ext.a, extB: ext.b, clamped, mitred, degenerate: true,
      });
      continue;
    }
    pieces.push({
      cls: s.boundary ? 'boundary' : 'interior',
      index: s.index,
      wall: s.wall,
      poly,
      // `len` / `cx` / `cz` 说的是**这面墙自己**（缩掉的那截属于接头，不属于这面墙）——
      // 几何要看 `poly`，别拿这几个数去反推形状。
      cx: (s.a[0] + s.b[0]) / 2,
      cz: (s.a[1] + s.b[1]) / 2,
      len: s.len,
      thickness: t,
      angleDeg: (Math.atan2(s.dir[1], s.dir[0]) * 180) / Math.PI,
      h,
      extA: ext.a,
      extB: ext.b,
      clamped,
      mitred,
    });
  }

  return { pieces, joints, fills, thickness: t, bite, h };
}

/** 构件的多边形（平面坐标，按顺序）—— 斜接后可能是 5 边形，平面/三维/打印共用这一份 */
export function pieceCorners(piece) {
  return piece.poly;
}

/** 点是否在**凸**多边形里（用局部系判同侧；4 边形、5 边形通用） */
export function pointInQuad(px, pz, quad) {
  // 逐边判"点在边的同一侧"：对凸多边形等价于"在里面"
  let sign = 0;
  const n = quad.length;
  for (let i = 0; i < n; i++) {
    const a = quad[i];
    const b = quad[(i + 1) % n];
    const ex = b[0] - a[0];
    const ez = b[1] - a[1];
    const s = ex * (pz - a[1]) - ez * (px - a[0]);
    if (Math.abs(s) < 1e-12) continue;
    const cur = s > 0 ? 1 : -1;
    if (sign === 0) sign = cur;
    else if (cur !== sign) return false;
  }
  return true;
}