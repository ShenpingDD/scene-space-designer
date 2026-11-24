/**
 * rooms.js —— M1 多房间：**房间是算出来的**（纯函数：无框架 / 无 DOM / 无 Three.js）
 *
 * 设计口径见 设计决策记录（五路头脑风暴合成）；用户 2026-10-09 拍板四条，实施见 设计决策记录。
 *
 * ## 一句话
 * 真源**只有墙**。房间是墙把整栋平面**剖分出来的面** —— `roomsOf(layout)`。
 * 所以：隔墙永远是**同一条记录**（改一处没有"两处"可漂，硬要求④免费成立）·
 * 旧的单房间文件**零迁移**（没有内墙时恰好算出 1 个整屋面）· 房间不进 `state`、不进库、不进分享包。
 *
 * ## 为什么这份实现长这样（三条，都是"错了会静默"的地方）
 *  1. **顶点必须先归并再走面。** 墙的端点是浮点，同一堵墙的两头在别的墙里收头时，
 *     坐标可能差 1e-9。差一点点就会被当成两个顶点 → 面遍历在那里断掉 → 房间里少一块，
 *     而**面积对不上只有一个总数**、不深究看不出来。所以顶点一律先量化到 **1 mm** 再建图。
 *  2. **T 形要拆点。** 一条内墙戳在另一条墙的中间（这是最常用的画法）时，
 *     被戳的那条必须**在那个点断开**，否则面遍历会从它身上直接穿过去。
 *  3. **面遍历取"顺时针最近的那条出边"。** 走出来的每个面都是"面在左手边"，
 *     于是有符号面积天然把**内部面**（正）和**外侧那个无界的面**（负）分开 ——
 *     不需要任何"哪条是外墙"的先验知识（那正是本项目最容易写错的东西）。
 *
 * ## 判据（`设计决策记录 §三`，每条都能变异变红）
 *  · 面覆盖守恒：Σ 房面面积 == 整栋 w×d（半边走漏一侧就立刻对不上）
 *  · 房间 id 不因为"从哪个点开始走"而变（id = 顶点集合散列，**与顺序/方向无关**）
 *  · 墙的双侧归属来自**面遍历**（不是"拿墙中点猜"—— 那样 T 形与斜墙会错）
 *  · 导出与往返里**永不出现** `rooms` 字段（派生量不许混进真源）
 */

import { cfg } from './params.js';
import { EPS, dedupePoints, polyArea, polyCentroid, pointInPoly, segmentDistance } from './geometry.js';
import { wallSeg, roleOf } from './wall.js';

/** 没起名字的房间界面上显示这个（用户 2026-10-09 拍板：默认名就是它，不是编号） */
export const DEFAULT_ROOM_NAME = '未命名房间';

/** 顶点归并容差：**1 mm**。墙吸附在 0.1 m 网格上，1 mm 只会并掉浮点噪声，并不掉真特征 */
export const JOIN_TOL_M = 0.001;
/** "这个点落在那条线段上"的容差：2 mm（比墙厚 0.1 m 小两个量级） */
export const ON_TOL_M = 0.002;
/** 「已有墙能不能当新画的边用」的容差：读参数表的吸附步长（0.1 m 的四分之一）—— 不另写死数字 */
const coverTolM = () => cfg.space.snapM / 4;

/* ---------------- 房间语义（P1 开放场景）：**内存内部字段，不进 state** ---------------- */

/**
 * 两套房间资格（设计决策记录 §4.1）：
 *  - `legacy`：旧标识导入的旧方案。`w×d` 外框参与闭合、**正面积面都算房间** ——
 *    保证旧方案房间数/房名/设备位置不变（C1）；
 *  - `walls`：新方案/新标识。面边界**全部来自墙**才是房间；含外框兜底边的是**开放面**。
 *
 * 存在 `layout.roomSemantics` 上（随内存布局进撤销快照）；`exportScheme` 的字段白名单
 * **不会发射它** —— 它由导入端的格式标识重新推导（旧标识 → legacy，新标识 → walls）。
 */
export const ROOM_SEMANTICS = { LEGACY: 'legacy', WALLS: 'walls' };

/**
 * 读布局的语义：**缺省 = legacy**。
 * 缺省必须是 legacy —— 所有旧布局/手写测试夹具都没这个字段，改成 walls 会让旧方案
 * 在没有任何提示的情况下少房间（客户级回归）。新方案由 `createLayout` 显式写 walls。
 */
export function roomSemanticsOf(layout) {
  return layout?.roomSemantics === ROOM_SEMANTICS.WALLS ? ROOM_SEMANTICS.WALLS : ROOM_SEMANTICS.LEGACY;
}

const mm = (v) => Math.round(v * 1000) / 1000;
const nodeKey = (x, z) => `${Math.round(x / JOIN_TOL_M)}|${Math.round(z / JOIN_TOL_M)}`;

/**
 * 顶点环 → 房间 id：**与"从哪个点开始走"、"往哪个方向绕"都无关**（顶点集合排序后散列）。
 * 这是"房间名跟着房间走"的地基：插一面墙不能让别的房间改名。
 */
export function ringId(poly) {
  const keys = poly.map(([x, z]) => `${Math.round(x * 1000)},${Math.round(z * 1000)}`).sort();
  let h = 2166136261;
  const s = keys.join(';');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/** 点 p 落在线段 a→b 的**内部**（不含两端）时返回参数 t（0..1），否则 null */
function tOnSeg(a, b, p) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len = Math.hypot(dx, dz);
  if (len < EPS) return null;
  const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / (len * len);
  const qx = a[0] + t * dx;
  const qz = a[1] + t * dz;
  if (Math.hypot(p[0] - qx, p[1] - qz) > ON_TOL_M) return null;
  const s = t * len;
  if (s <= JOIN_TOL_M || s >= len - JOIN_TOL_M) return null;
  return t;
}

/** 两条线段的**真交叉**参数（平行/共线返回 null —— 那种情况交给"端点落线上"处理） */
function tCross(a, b, c, d) {
  const r = [b[0] - a[0], b[1] - a[1]];
  const s = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
  const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
  const la = Math.hypot(r[0], r[1]);
  const ls = Math.hypot(s[0], s[1]);
  if (t * la <= JOIN_TOL_M || t * la >= la - JOIN_TOL_M) return null;
  if (u * ls <= JOIN_TOL_M || u * ls >= ls - JOIN_TOL_M) return null;
  return t;
}

/**
 * 建平面图：顶点归并 → T 形/十字拆点 → 无向边（同一条边只留一条，**墙优先于外框**）。
 * 导出它是为了让判据能直接盯"图建对了没有"（面遍历的输入错，后面全错）。
 */
export function buildPlanGraph(layout) {
  const pts = [];
  const idx = new Map();
  const addPt = (x, z) => {
    const k = nodeKey(x, z);
    let i = idx.get(k);
    if (i === undefined) { i = pts.length; pts.push([x, z]); idx.set(k, i); }
    return i;
  };

  // ① 线段集合：墙（带墙号）+ 整栋外框四条边（墙号 -1，只是兜底边界）
  const segs = [];
  layout.walls.forEach((wl, wi) => {
    const [x, z, xx, zz] = wallSeg(wl);
    if (Math.hypot(xx - x, zz - z) < EPS) return;      // 零长墙：不参与剖分（它也没有面）
    segs.push({ wi, a: [x, z], b: [xx, zz] });
  });
  const { w, d } = layout;
  for (const [x, z, xx, zz] of [[0, 0, w, 0], [w, 0, w, d], [w, d, 0, d], [0, d, 0, 0]]) {
    segs.push({ wi: -1, a: [x, z], b: [xx, zz] });
  }

  // ② 每条线段要被打断的参数
  const cuts = segs.map(() => []);
  for (let i = 0; i < segs.length; i++) {
    for (let j = 0; j < segs.length; j++) {
      if (i === j) continue;
      const s = segs[i];
      const o = segs[j];
      if (s.wi === -1 && o.wi === -1) continue;        // 外框四条边之间只有角点，已经是端点
      for (const p of [o.a, o.b]) {
        const t = tOnSeg(s.a, s.b, p);
        if (t !== null) cuts[i].push(t);
      }
      // 十字（两墙真的交叉）也要拆 —— 漏了它，"一横一竖"画出来的十字就只算一间房。
      // ⚠️ 第一版这里写了 `if (s.wi === -1 || o.wi === -1)`（只查墙↔外框），于是十字交叉不拆点，
      //    探针里"十字 = 4 间"拿到 1 间。这种错**面积还是对的**（面数少但铺满），只有间数判据能抓。
      const t = tCross(s.a, s.b, o.a, o.b);
      if (t !== null) cuts[i].push(t);
    }
  }

  // ③ 切成子边
  const edges = [];
  const edgeAt = new Map();
  const adj = new Map();
  const pushEdge = (u, v, wi) => {
    if (u === v) return;
    const k = u < v ? `${u}|${v}` : `${v}|${u}`;
    const found = edgeAt.get(k);
    if (found !== undefined) {
      // 同一条边有两个来源（最典型：用户画的外墙正好压在外框上）→ **留墙号**，外框那份丢掉
      if (edges[found].wi === -1 && wi >= 0) edges[found].wi = wi;
      return;
    }
    const ei = edges.length;
    edges.push({ u, v, wi });
    edgeAt.set(k, ei);
    for (const [from, to] of [[u, v], [v, u]]) {
      const A = pts[from];
      const B = pts[to];
      const ang = Math.atan2(B[1] - A[1], B[0] - A[0]);
      const list = adj.get(from) ?? [];
      list.push({ ei, to, ang: (ang + Math.PI * 2) % (Math.PI * 2) });
      adj.set(from, list);
    }
  };
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const ts = [0, ...cuts[i], 1].sort((a, b) => a - b);
    let prev = null;
    for (const t of ts) {
      const n = addPt(s.a[0] + (s.b[0] - s.a[0]) * t, s.a[1] + (s.b[1] - s.a[1]) * t);
      if (prev !== null) pushEdge(prev, n, s.wi);
      prev = n;
    }
  }
  return { pts, edges, adj };
}

/**
 * 面遍历（半边走）：每条**有向边**恰好属于一个面。
 * 规则：从 `u→v` 走到 `v` 之后，取"以 `v→u` 的反方向为基准、顺时针最近的那条出边"——
 * 这样走出来的每一个面，内部都在左手边，于是有符号面积把内（正）/ 外（负）分开。
 * 自由端的内墙会被**原路走回来**（形成零面积的尖刺）—— 面积不受影响，这是本算法容错的关键。
 *
 * P1：每个面多一个 `kind`（设计决策记录 §5）：
 *  - `'room'`：`legacy` 语义下所有正面积面；`walls` 语义下**全部边都来自真实墙**（`wi >= 0`）的面；
 *  - `'open'`：`walls` 语义下含外框兜底边（`wi === -1`）的正面积面 —— 开放场景，不可命名；
 *  - `'outside'`：外侧那个无界面（负面积），永远不是房间。
 * 房间资格只在**这一处**判 —— `roomsOf` / `wallAdjacency` / `openAreaTotal` 都读它，不许各判一套。
 */
export function planFaces(layout) {
  const { pts, edges, adj } = buildPlanGraph(layout);
  const other = (ei, u) => (edges[ei].u === u ? edges[ei].v : edges[ei].u);
  const used = new Set();
  const faces = [];
  const floorArea = Math.max(1e-9, layout.w * layout.d * 1e-9);
  const legacy = roomSemanticsOf(layout) === ROOM_SEMANTICS.LEGACY;
  for (let u = 0; u < pts.length; u++) {
    for (const e0 of adj.get(u) ?? []) {
      if (used.has(`${u}|${e0.ei}`)) continue;
      const ring = [];
      const dirs = [];
      let from = u;
      let ei = e0.ei;
      for (;;) {
        used.add(`${from}|${ei}`);
        ring.push(from);
        dirs.push({ from, ei });
        const to = other(ei, from);
        const back = (Math.atan2(pts[from][1] - pts[to][1], pts[from][0] - pts[to][0]) + Math.PI * 2) % (Math.PI * 2);
        const outs = adj.get(to) ?? [];
        let pick = null;
        for (const o of outs) if (o.ang < back - 1e-12 && (!pick || o.ang > pick.ang)) pick = o;
        if (!pick) for (const o of outs) if (!pick || o.ang > pick.ang) pick = o;
        from = to;
        ei = pick.ei;
        if (from === u && ei === e0.ei) break;
        if (ring.length > edges.length * 2 + 8) throw new Error('rooms: 面遍历没有收敛（图建错了）');
      }
      const area = polyArea(ring.map((i) => pts[i]));
      const allFromWalls = dirs.every((d) => edges[d.ei].wi >= 0);
      const kind = area <= floorArea ? 'outside' : (legacy || allFromWalls ? 'room' : 'open');
      faces.push({ ring, dirs, area, kind });
    }
  }
  // 有向边 → 它左手边的那个面（面序号）；外侧那个无界的面也会被登记（它面积是负的）
  const faceOf = new Map();
  faces.forEach((f, fi) => { for (const dir of f.dirs) faceOf.set(`${dir.from}|${dir.ei}`, fi); });
  return { pts, edges, faces, faceOf };
}

/** 房间派生口径的版本号：判据换代时 +1（缓存键含它，旧口径的结果不会跨版本复用） */
export const ROOMS_DERIVE_VERSION = 3;

/** 缓存：几何纯函数 + 一张"上次的图"（2D 渲染 / 房间列表 / 三维重建都会问同一份） */
let cache = { key: null, rooms: null, openFaces: null };
const layoutKey = (layout) => [
  ROOMS_DERIVE_VERSION,
  roomSemanticsOf(layout),             // legacy / walls：同一份墙，房间资格不同 → 必须进键
  layout.w, layout.d, cfg.room.minAreaM2,
  // 角色也进键：改角色会改变消费语义（样式/碰撞），派生读数不许拿旧缓存冒充新结论
  ...layout.walls.map((wl) => `${wallSeg(wl).map(mm).join(',')}:${roleOf(wl) ?? '-'}`),
  // 设备位置进键：`rooms[].items` 是派生读数（放/移设备时墙没变，缓存必须失效）
  ...layout.items.map((it) => `${it.id}:${it.x},${it.z}`),
].join('|');

/**
 * 名字/代表点画在哪儿：形心在内就用形心；凹口形（L 形房间）形心可能落在房间外 →
 * 退到"离墙最远的内部取样点"。
 *
 * `holes` = 直接子面（嵌套闭合房）：外圈房间把内圈挖掉之后是"甜甜圈"，
 * 形心恰好落在洞里很常见（8×6 大厅里 3×3 机房），所以代表点必须**同时不在洞里**。
 */
function labelPoint(poly, holes = []) {
  const inRoom = (p) => pointInPoly(poly, p) && !holes.some((h) => pointInPoly(h, p));
  const c = polyCentroid(poly);
  if (inRoom(c)) return c;
  const xs = poly.map((p) => p[0]);
  const zs = poly.map((p) => p[1]);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [z0, z1] = [Math.min(...zs), Math.max(...zs)];
  const N = 12;
  let best = null;
  let bestD = -1;
  for (let i = 1; i < N; i++) {
    for (let j = 1; j < N; j++) {
      const p = [x0 + ((x1 - x0) * i) / N, z0 + ((z1 - z0) * j) / N];
      if (!inRoom(p)) continue;
      let dm = Infinity;
      for (let k = 0; k < poly.length; k++) {
        const a = poly[k];
        const b = poly[(k + 1) % poly.length];
        dm = Math.min(dm, segmentDistance(p[0], p[1], a[0], a[1], b[0], b[1]));
      }
      if (dm > bestD) { bestD = dm; best = p; }
    }
  }
  return best ?? c;
}

/**
 * 派生一份（房间 + 开放面 + 深度）—— **一次面遍历 + 一次包含关系**，所有读数共用；
 * 缓存键含 `roomSemantics` / `role` / 口径版本（见 `layoutKey`）。
 *
 * ## 嵌套闭合房为什么要扣洞（task-38）
 *
 * 面遍历按**连通分量**走：屋里再画一圈闭合的机房，内外两圈是断开的两个分量，
 * 外圈面的顶点环只到外边界，`polyArea` 把机房那块也算进外圈（48 + 9 = 57 > 48）。
 * 这不是"面遍历漏一侧"，而是"面多边形不带洞"的表达能力缺口。
 *
 * 处置：按**包含关系**把直接子面的**毛面积**从父面扣掉（多层只减直接子面 —— 子面自己
 * 再扣它的孩子，逐层相减后总和恰好回到 w×d）。`area` 是扣洞后的有效面积（对外读数），
 * `areaGross` 只作诊断（面遍历原始面积，别拿它求和）。
 *
 * 守据（**不许静默夹 0**）：扣完仍 `Σ房间 > w×d + 1e-6` 或 `Σ房间 + Σ开放 ≠ w×d` →
 * 抛错（这是内核不变量被破坏，不是用户输入问题）。
 */
function derive(layout) {
  const key = layoutKey(layout);
  if (cache.key === key && cache.rooms) return cache;

  const { pts, edges, faces } = planFaces(layout);
  const items = layout.items;
  const positives = [];
  for (const f of faces) {
    if (f.kind !== 'room' && f.kind !== 'open') continue;   // 外侧无界面（负面积）
    const poly = facePoly(pts, f.ring);
    positives.push({
      f,
      kind: f.kind,
      poly,
      gross: f.area,
      point: labelPoint(poly),
      children: [],
    });
  }

  // 直接父面 = 包含本面代表点、且毛面积最小的那个正面积面（面积严格更大，不可能成环）
  for (const a of positives) {
    let parent = null;
    for (const b of positives) {
      if (a === b || b.gross <= a.gross + 1e-9) continue;
      if (!pointInPoly(b.poly, a.point)) continue;
      if (!parent || b.gross < parent.gross) parent = b;
    }
    a.parent = parent;
    if (parent) parent.children.push(a);
  }
  for (const a of positives) {
    a.holes = a.children.map((c) => c.poly);
    a.depth = 0;
    for (let p = a.parent, guard = positives.length + 1; p && guard > 0; p = p.parent, guard -= 1) a.depth += 1;
    a.area = Math.max(0, a.gross - a.children.reduce((n, c) => n + c.gross, 0));
  }

  const rooms = [];
  const openFaces = [];
  const depths = new Map();
  for (const a of positives) {
    const { f, poly, kind } = a;
    if (kind === 'open') {
      openFaces.push({
        poly,
        area: a.area,
        areaGross: a.gross,
        centroid: polyCentroid(poly),
        labelAt: labelPoint(poly, a.holes),
      });
      continue;
    }
    const walls = [];
    for (const dir of f.dirs) {
      const wi = edges[dir.ei].wi;
      if (wi >= 0 && !walls.includes(wi)) walls.push(wi);
    }
    walls.sort((x, y) => x - y);
    const id = ringId(poly);
    depths.set(id, a.depth);
    rooms.push({
      id,
      poly,
      area: a.area,
      areaGross: a.gross,          // 诊断用：面遍历原始面积（含被内圈重复算进的部分）
      centroid: polyCentroid(poly),
      labelAt: labelPoint(poly, a.holes),
      walls,
      openings: walls.reduce((n, wi) => n + (layout.walls[wi]?.openings?.length ?? 0), 0),
      // 设备只算**有效区域**（不在直接子面里），否则大厅会把机房的设备再数一遍
      items: items.filter((i) => pointInPoly(poly, [i.x, i.z])
        && !a.holes.some((h) => pointInPoly(h, [i.x, i.z]))).length,
      // 「窄缝」不是隐藏，是**标出来**：两面墙贴得太近会挤出一条 5 cm 的"房间"，
      // 界面要如实说，不许悄悄从列表里抹掉（静默过滤 = 同一个宗罪）。
      sliver: a.area < cfg.room.minAreaM2,
    });
  }
  rooms.sort((a, b) => (Math.abs(a.centroid[1] - b.centroid[1]) > 0.5
    ? a.centroid[1] - b.centroid[1]
    : a.centroid[0] - b.centroid[0]));

  // 守据：扣洞之后总面积必须回到场景面积；仍超 = 内核错，**大声失败**，不 max(0) 掩盖
  const sceneArea = layout.w * layout.d;
  const roomArea = rooms.reduce((n, r) => n + r.area, 0);
  const openArea = openFaces.reduce((n, r) => n + r.area, 0);
  if (roomArea > sceneArea + 1e-6) {
    throw new Error(`rooms: 房间面积 ${roomArea.toFixed(3)} 超过场景 ${sceneArea.toFixed(3)} m²（面扣洞失效）`);
  }
  if (Math.abs(roomArea + openArea - sceneArea) > 1e-6) {
    throw new Error(`rooms: 面积不守恒（房间 ${roomArea.toFixed(3)} + 开放 ${openArea.toFixed(3)} ≠ ${sceneArea.toFixed(3)} m²）`);
  }

  cache = { key, rooms, openFaces, depths };
  return cache;
}

/**
 * 房间清单（派生视图，**不进 state**）。`walls` 语义下**只返回房间**：
 * 含外框兜底边的面是开放场景，不是房间；`legacy` 语义下与旧实现逐字一致（正面积面都算）。
 * @returns {Array<{id,poly,area,centroid,labelAt,walls,openings,items,sliver}>}
 *          排序：先上后下、先左后右（读图顺序，稳定 —— 列表不会因为遍历顺序每次不同而跳）
 */
export function roomsOf(layout) {
  return derive(layout).rooms;
}

/** 开放面清单（派生视图；`legacy` 语义恒为空数组）。开放面没有 id、不命名、不进导出。 */
export function openFacesOf(layout) {
  return derive(layout).openFaces;
}

/**
 * 开放面积（米²）—— 场景范围内**未被任何房间占用**的部分（"剩余量"，不是实体）。
 * `legacy` 语义恒为 0（旧口径下正面积面都算房间）；`walls` 语义 = Σ 开放面的**有效面积**
 * （扣掉落在开放场地里的闭合房间，task-38；与 `roomAreaTotal` 共用同一份扣洞结果）。
 *
 * 守恒判据（`derive` 里守着）：`roomAreaTotal(layout) + openAreaTotal(layout) ≈ w*d`。
 */
export function openAreaTotal(layout) {
  return derive(layout).openFaces.reduce((s, f) => s + f.area, 0);
}

/** 所有**房间**面积之和。`legacy` 语义下仍恰好等于整栋 `w×d`；`walls` 语义下另有开放面积 */
export function roomAreaTotal(layout) {
  return roomsOf(layout).reduce((s, r) => s + r.area, 0);
}

/**
 * 这个点在**哪一间**？落在墙厚里、或整栋之外 → null（如实说"不在任何房间"，不硬塞一间）。
 * @returns {object|null}
 */
export function roomAt(layout, x, z) {
  if (inWall(layout, x, z) >= 0) return null;                        // 在墙里（墙厚之内）
  if (x < 0 || x > layout.w || z < 0 || z > layout.d) return null;   // 在整栋外
  const { rooms, depths } = derive(layout);
  let hit = null;
  let best = -1;
  for (const r of rooms) {
    if (!pointInPoly(r.poly, [x, z], ON_TOL_M)) continue;
    // 嵌套时外圈面也"包含"这个点；取**最深**的那间（机房里的设备归机房，不归大厅）
    const d = depths.get(r.id) ?? 0;
    if (d > best) { hit = r; best = d; }
  }
  return hit;
}

/** 这个点在不在哪面墙的厚度里？是 → 返回墙序号；不是 → -1。`roomAt` 与「切分」的提示共用 */
export function inWall(layout, x, z) {
  const half = cfg.space.wallThicknessM / 2;
  for (let i = 0; i < layout.walls.length; i++) {
    const [ax, az, bx, bz] = wallSeg(layout.walls[i]);
    if (segmentDistance(x, z, ax, az, bx, bz) <= half) return i;
  }
  return -1;
}

/** 设备归属哪一间（按**中心点**）—— 交付清单分组用它；落在墙上如实返回 null（"未分房间"） */
export function roomOfItem(layout, item) {
  return roomAt(layout, item.x, item.z);
}

/**
 * `roomAt` 的**别名**：规格与探针里写的是 `roomAtPoint`，内核只有一份实现。
 * （`app/src/devkit.js` 早就这么叫了；别名是为了让 QA/前端不用猜，不是为了多一套算法。）
 */
export const roomAtPoint = roomAt;

/** 面 → 顶点环（`roomsOf` 与 `wallAdjacency` **共用这一份**，否则两处的 id 算不到一起） */
function facePoly(pts, ring) {
  return dedupePoints(ring.map((i) => pts[i].slice()));
}

/** 一面墙两侧的房（**来自面遍历**，不是"拿中点猜"—— 猜法在 T 形与斜墙上是错的） */
export function wallAdjacency(layout) {
  const { pts, edges, faces, faceOf } = planFaces(layout);
  // 只有**房间**面才有 id；开放面（walls 语义下含外框边的面）不参与"墙两侧是哪间房"——
  // 否则一面围合房间的墙会被算成"两侧都有房"（双身份 N5 会红成 party）。
  const idOfFace = faces.map((f) => (f.kind === 'room' ? ringId(facePoly(pts, f.ring)) : null));
  const per = layout.walls.map(() => ({ side: [new Set(), new Set()] }));
  edges.forEach((e, ei) => {
    if (e.wi < 0 || !per[e.wi]) return;
    // ⚠️ 键里必须是**边序号**（`faceOf` 的键是 `顶点|边序号`）。第一版写的 `e.ei`
    //    —— 边记录上没有 `ei` 这个字段（`ei` 只存在于邻接表里）—— 于是每面墙两侧都查到
    //    `undefined`、全被判成外墙。**判据“每条隔墙恰返两侧房”当场抓住了它**。
    per[e.wi].side[0].add(idOfFace[faceOf.get(`${e.u}|${ei}`)] ?? null);
    per[e.wi].side[1].add(idOfFace[faceOf.get(`${e.v}|${ei}`)] ?? null);
  });
  return per.map((p, index) => {
    const a = [...p.side[0]].filter(Boolean);
    const b = [...p.side[1]].filter(Boolean);
    const bothSides = a.length > 0 && b.length > 0;
    const all = new Set([...a, ...b]);
    // 分类（设计决策记录 §3.2 的三值）：外墙（有一侧在整栋外）/ 隔墙（两侧是不同的房）/ 房内隔断（两侧同一间）。
    // ⚠️ 与设计文档的偏离：设计说"7 个消费点必须一起改"。实施时逐个核过 —— 它们的实际语义是
    //    "这面墙是不是在**整栋外框**上"，多房间下这个语义**仍然正确**（隔墙照样是障碍物、
    //    照样不该被当成房间边界跳过）。所以一个消费点都没改（改反而是悄悄换语义），
    //    三值只作为**新增的派生量**给新功能用。理由与证据见 `设计决策记录 §二`。
    const cls = !bothSides ? 'boundary' : (all.size > 1 ? 'party' : 'interior');
    // 一条墙被完全去重（别人身上已经有了同一条边）时它没有任何子边 → 退回几何判定
    const deg = per[index].side[0].size + per[index].side[1].size;
    return deg === 0 ? { index, cls: 'interior', rooms: [] } : { index, cls, rooms: [...all] };
  });
}

/** 每面墙的分类（`boundary` | `party` | `interior`）—— 界面/探针读数用 */
export function wallClasses(layout) {
  return wallAdjacency(layout).map((a) => a.cls);
}

/** 读数的名字：探针与界面不要各写一套 */
export const WALL_CLASS_LABEL = { boundary: '外墙', party: '隔墙', interior: '房内隔断' };

/**
 * 给房间挂名字（`roomLabels` 是**可选**字段：键 = 房间 id）。
 * 缺名字的房间界面上显示 **「未命名房间」**（用户 2026-10-09 拍板：默认名就是这个，不是编号）。
 */
export function roomSummary(layout, labels = {}) {
  return roomsOf(layout).map((r) => ({
    ...r,
    name: typeof labels?.[r.id] === 'string' ? labels[r.id] : '',
    displayName: (typeof labels?.[r.id] === 'string' && labels[r.id]) || DEFAULT_ROOM_NAME,
  }));
}

/**
 * 缩略图（**2D 简图** —— 用户拍板：不做逐间真三维渲染）：把房面归一化进 size×size 的方框。
 * 返回的是纯数字（点阵 + 变换），界面只负责画 —— 界面不自己算几何。
 */
export function roomThumb(layout, room, size = 96, pad = 7) {
  const xs = room.poly.map((p) => p[0]);
  const zs = room.poly.map((p) => p[1]);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [z0, z1] = [Math.min(...zs), Math.max(...zs)];
  const k = Math.min((size - pad * 2) / Math.max(1e-6, x1 - x0), (size - pad * 2) / Math.max(1e-6, z1 - z0));
  const ox = (size - (x1 - x0) * k) / 2 - x0 * k;
  const oz = (size - (z1 - z0) * k) / 2 - z0 * k;
  const at = ([x, z]) => [x * k + ox, z * k + oz];
  return {
    size,
    points: room.poly.map(at),
    // 这间房的墙线（含门洞断开后的实心段）—— 缩略图里能看到"哪面是隔墙"
    segs: room.walls.flatMap((wi) => {
      const wl = layout.walls[wi];
      if (!wl) return [];
      // 只画落在这间房包围盒里的墙：跑到房外的半截在缩略图里会画到框外
      const [ax, az, bx, bz] = wallSeg(wl);
      const inside = ([x, z]) => x >= x0 - 1e-6 && x <= x1 + 1e-6 && z >= z0 - 1e-6 && z <= z1 + 1e-6;
      if (!inside([ax, az]) || !inside([bx, bz])) return [];
      return [[at([ax, az]), at([bx, bz])]];
    }),
  };
}

/**
 * 「画房间」：拖一个矩形 → 要新增哪几条墙（**已经存在的边不重复画**）。
 * 硬要求④与判据 10 全靠这一条：两间房共享的那面墙**只有一条记录**。
 * @param {{x0:number,z0:number,x1:number,z1:number}} rect 轴对齐矩形（界面已经吸附过）
 * @returns {{walls:object[], reused:number[], overlaps:number[], total:number}}
 */
export function roomOutlineWalls(layout, rect) {
  const { x0, z0, x1, z1 } = rect;
  const c = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
  const edges = [[c[0], c[1]], [c[1], c[2]], [c[2], c[3]], [c[3], c[0]]];
  const tol = coverTolM();
  const walls = [];
  const reused = [];
  const overlaps = [];
  for (const [a, b] of edges) {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (L < 1e-9) continue;
    const ux = (b[0] - a[0]) / L;
    const uz = (b[1] - a[1]) / L;
    const proj = (p) => (p[0] - a[0]) * ux + (p[1] - a[1]) * uz;
    const off = (p) => Math.abs(-(p[0] - a[0]) * uz + (p[1] - a[1]) * ux);
    let covered = -1;
    layout.walls.forEach((wl, wi) => {
      const [x, z, xx, zz] = wallSeg(wl);
      if (off([x, z]) > tol || off([xx, zz]) > tol) return;            // 不共线
      const lo = Math.min(proj([x, z]), proj([xx, zz]));
      const hi = Math.max(proj([x, z]), proj([xx, zz]));
      if (lo <= tol && hi >= L - tol) { if (covered < 0) covered = wi; return; }   // 已有一条墙正好覆盖这条边
      if (hi > tol && lo < L - tol) overlaps.push(wi);                 // 部分重叠：不动它，但**报出来**
    });
    if (covered >= 0) reused.push(covered);
    else walls.push({ a: [...a], b: [...b], openings: [] });
  }
  return { walls, reused, overlaps: [...new Set(overlaps)], total: layout.walls.length + walls.length };
}

/**
 * 从 p 沿 dir 走到**第一面墙**的距离（0 = 本来就贴在墙上）。
 * 候选里**包含整栋外框**：房间是外框 + 内墙一起剖出来的，所以"接到墙上"当然也包括接到外框上
 *（用户把墙删光只剩一间房时，切分仍然得能用）。
 */
function hitAlong(layout, p, dir, maxExtend = Infinity) {
  let best = 0;
  const segs = layout.walls.map(wallSeg);
  const { w, d } = layout;
  segs.push([0, 0, w, 0], [w, 0, w, d], [w, d, 0, d], [0, d, 0, 0]);
  for (const [x, z, xx, zz] of segs) {
    const ex = xx - x;
    const ez = zz - z;
    const den = dir[0] * ez - dir[1] * ex;
    if (Math.abs(den) < 1e-12) continue;
    const t = ((x - p[0]) * ez - (z - p[1]) * ex) / den;
    const u = ((x - p[0]) * dir[1] - (z - p[1]) * dir[0]) / den;
    if (t <= ON_TOL_M || t > maxExtend) continue;
    if (u < -1e-9 || u > 1 + 1e-9) continue;
    if (best === 0 || t < best) best = t;
  }
  return best;
}

/**
 * 「切分房间」：拖一条线 → 把两端接到墙上（接得上才接，接不上如实说），
 * 再**真的算一遍面**：算出来多了一间才算成功。
 *
 * 为什么不"拖到哪画到哪"：用户拖歪了 10 cm 就得到"画了一条线但房间没分开"，
 * 那种失败最招人骂（看着做了事、什么也没发生）。这里宁可多伸一点并**说清楚**伸了多少。
 * @returns {{ok:true, wall, extendedA:number, extendedB:number, roomsBefore:number, roomsAfter:number}
 *          | {ok:false, reason:string, message:string}}
 */
export function planSplit(layout, seg) {
  const { a, b } = seg;
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (!(L > 1e-9)) return { ok: false, reason: 'zero', message: '这条线太短了，拖长一点' };
  if (layout.walls.length >= cfg.layout.maxWalls) {
    return { ok: false, reason: 'too-many-walls', message: `墙的数量已到上限（${cfg.layout.maxWalls} 面），先删一面再画` };
  }
  const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  if (inWall(layout, mid[0], mid[1]) >= 0) {
    return { ok: false, reason: 'on-wall', message: '这条线压在墙上 —— 往房间中间拖一点' };
  }
  if (!roomAt(layout, mid[0], mid[1])) {
    return { ok: false, reason: 'not-in-room', message: '这条线不在任何房间里 —— 请在房间里拖' };
  }
  const ux = (b[0] - a[0]) / L;
  const uz = (b[1] - a[1]) / L;
  // 「往两边接到墙上」**不设人为上限**：射线取的是**第一个**交点，所以它天然被这间房自己的墙挡住，
  // 不可能"伸到隔壁房间去"。设一个 1 m 的帽子反而会让"在房中间拖一条短线"切不开房
  //（用户只做了 2 步，却得到"没切开"），与硬要求②直接冲突。伸长量如实返回给界面报出来。
  const ea = hitAlong(layout, a, [-ux, -uz], Infinity);
  const eb = hitAlong(layout, b, [ux, uz], Infinity);
  const A = [a[0] - ux * ea, a[1] - uz * ea];
  const B = [b[0] + ux * eb, b[1] + uz * eb];
  const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
  if (len < cfg.scheme.minWallLengthM) {
    return { ok: false, reason: 'too-short', message: `这条线太短（不足 ${cfg.scheme.minWallLengthM} m），拖长一点` };
  }
  const wall = { a: A, b: B, openings: [] };
  const before = roomsOf(layout).length;
  // 真的算一遍：算出来多一间才算"切开了"
  const after = roomsOf({ ...layout, walls: [...layout.walls, wall] }).length;
  if (after <= before) {
    // **后置条件守卫**："把这个房间切成两间"是向用户承诺的事，所以这里再算一遍面来核对。
    // 正常情况下到不了这里（射线取的是第一个交点，加一条新墙必然多一个面）——
    // 它防的是几何退化（重合墙、退化的窄房）那类"看起来做了、其实什么也没发生"。
    return {
      ok: false,
      reason: 'not-splitting',
      message: '这条线还没把房间切成两间 —— 两端要接到墙上（或穿过整间房）',
    };
  }
  return { ok: true, wall, extendedA: ea, extendedB: eb, roomsBefore: before, roomsAfter: after };
}

/**
 * 改名搬家：墙一改形状，房间 id 会变，但**用户起的名字不该凭空消失**。
 * 规则：按旧房间的**形心**找它现在落在哪一间 → 名字跟过去；两间并成一间时**面积大的那间名字活下来**，
 * 被并掉的**报出来**（不静默选一个）。名字真的没地方可去 → `dropped` 里如实列出。
 *
 * @returns {{labels:object, carried:Array, dropped:Array, unnamed:number}}
 */
export function carryLabels(oldRooms, labels, newRooms) {
  const keep = new Map();
  const carried = [];
  const dropped = [];
  const taken = new Set();
  const olds = [...oldRooms].sort((a, b) => b.area - a.area);
  for (const r of olds) {
    const name = typeof labels?.[r.id] === 'string' ? labels[r.id] : '';
    if (!name) continue;
    const hit = newRooms.filter((n) => pointInPoly(n.poly, r.centroid, ON_TOL_M));
    const target = hit.find((n) => !taken.has(n.id)) ?? hit[0] ?? null;
    if (!target) { dropped.push({ name, reason: 'gone' }); continue; }
    if (keep.has(target.id)) { dropped.push({ name, reason: 'merged', into: keep.get(target.id) }); continue; }
    keep.set(target.id, name);
    taken.add(target.id);
    if (target.id !== r.id) carried.push({ name, from: r.id, to: target.id });
  }
  const unnamed = newRooms.filter((n) => !keep.has(n.id)).length;
  return { labels: Object.fromEntries(keep), carried, dropped, unnamed };
}

/** 名字合法化（**界面输入**走这里）：去空白、截到参数上限；空串 = 不命名（不是"改名为空"） */
export function cleanRoomName(name) {
  const s = String(name ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.slice(0, cfg.room.nameMaxChars);
}

/**
 * 名字合法化（**读文件**走这里）：只去空白，**不截断**。
 *
 * 两个函数不是重复：导入时的任务是"这份文件说了什么就收下什么"，
 * 拿今天的 `room.nameMaxChars` 去截一份昨天导出的文件，就是在制造 FIX-05 的反面。
 * 界面要显示不下的名字用 CSS 收尾，**不改数据**。
 */
export function readRoomLabel(v) {
  if (typeof v !== 'string') return '';
  return v.replace(/\s+/g, ' ').trim();
}

/**
 * 房间名表规范化（导出/导入共用）：只留**字符串键 + 字符串值**，空名字丢掉。
 * 顺序 = 名字表**自己的**顺序（导出逐字节稳定：同一份 state 永远导出同一个字节序列）。
 *
 * ⚠️ **不按"房间现在存不存在"过滤**（刻意）：
 *   ① 名字跟着几何 id 走，墙改回去名字就回来 —— 这是撤销能恢复房间名的全部依据；
 *      存在但暂时对不上的名字由界面如实提示（"在等房间"），不在这里静默删。
 *   ② Java 侧（没有面遍历）要能**逐字节镜像**这份导出 —— 规则一旦依赖房间算出来的面，
 *      两边就会分叉（服务端只能照文件里的顺序写回去）。所以这里**不看 rooms**。
 * @param {object} labels 房间名表
 */
export function cleanRoomLabels(labels) {
  if (!labels || typeof labels !== 'object') return {};
  const out = {};
  for (const k of Object.keys(labels)) {
    const name = readRoomLabel(labels[k]);
    if (name) out[k] = name;
  }
  return out;
}

export { polyArea, pointInPoly };