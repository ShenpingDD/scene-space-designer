/**
 * placement.js —— 规则 3：自动摆位与增删移转（纯函数）
 * 来源：原型 `add()` 的空位扫描 + 拖拽夹取 + 旋转吸附。
 * 含 R1 修复：FIX-05（写入端上限/坐标夹取，保证导出必可回导）、FIX-06（空位校验）。
 */

import { cfg } from './params.js';
import { round1, roundMm } from './geometry.js';
import { clampToRoom, expandSceneKeepWalls, classifyWallRole } from './room.js';
import { isValid, checkWall, WALL_REASON } from './validate.js';
import { mkWall, mkWallSeg, wallSeg, wallLen, openingsOf, cloneOpening, roleOf } from './wall.js';

// 参数见 params.js（原常量 MAX_ITEMS）：cfg.layout.maxItems
// 参数见 params.js（原常量 MAX_WALLS）：cfg.layout.maxWalls

// 参数见 params.js（原常量 AUTO）：cfg.layout.autoZ0, cfg.layout.autoDz, cfg.layout.autoX0, cfg.layout.autoDx, cfg.layout.autoMargin

/** 原型文案（UI 直接复用，避免"两处写不同的话"） */
export const MSG = {
  get limit() { return `最多放置 ${cfg.layout.maxItems} 台设备，请先移除部分设备`; },
  unknown: '未知型号，无法加入',
  noSpace: '空间不足，无法再放置；可先扩大空间或移除部分设备',
  get wallLimit() { return `墙体数量已达上限（${cfg.layout.maxWalls} 面）`; },
  get wallTooShort() { return `墙体太短：请拖动出至少 ${cfg.scheme.minWallLengthM.toFixed(2)} m`; },
  badPoint: '墙体坐标不合法（坐标必须是有限数字）',
  zeroLength: '墙的长度是 0（起点与终点重合）',
  duplicate: '这段已经有墙了',
};

/** 下一个可用 id（导入后的恢复口径，也是 FIX-25 的兜底） */
export function nextIdFor(layout) {
  return Math.max(0, ...layout.items.map((i) => i.id)) + 1;
}

/** 原型 add() 的空位扫描：Z 由小到大、X 由小到大，逐格试放 */
export function findFreeSpot(layout, item, getProduct) {
  const probe = { ...item };
  for (let z = cfg.layout.autoZ0; z < layout.d - cfg.layout.autoMargin; z += cfg.layout.autoDz) {
    for (let x = cfg.layout.autoX0; x < layout.w - cfg.layout.autoMargin; x += cfg.layout.autoDx) {
      probe.x = round1(x);
      probe.z = round1(z);
      if (isValid(layout, probe, getProduct)) return { x: probe.x, z: probe.z };
    }
  }
  return null;
}

/**
 * 加入一台设备（原型 `add()`，含 FIX-05/06）。
 * 顺序严格对齐原型：上限 → 型号存在 → 位置（夹取或自动找空位）→ 空位失败则**不新增**。
 * @returns {{ok:false,reason:string,message:string}|{ok:true,layout:object,item:object}}
 */
export function addItem(layout, productId, { getProduct, pos = null, id = null } = {}) {
  if (layout.items.length >= cfg.layout.maxItems) return { ok: false, reason: 'limit', message: MSG.limit };
  const product = getProduct(productId);
  if (!product) return { ok: false, reason: 'unknown-product', message: MSG.unknown };

  const item = {
    id: id ?? nextIdFor(layout),
    p: productId,
    x: pos ? round1(clampToRoom(layout, pos.x, pos.z).x) : round1(layout.w / 2),
    z: pos ? round1(clampToRoom(layout, pos.x, pos.z).z) : round1(layout.d / 2),
    r: 0,
    doorAmount: 0, // FIX-05：结构从一开始就与导入端一致，导出才可逐字节往返
  };

  if (!pos) {
    const spot = findFreeSpot(layout, item, getProduct);
    if (!spot) return { ok: false, reason: 'no-space', message: MSG.noSpace };
    item.x = spot.x;
    item.z = spot.z;
  }

  return { ok: true, layout: { ...layout, items: [...layout.items, item] }, item };
}

/** 移除设备 */
export function removeItem(layout, id) {
  return { ...layout, items: layout.items.filter((i) => i.id !== id) };
}

/** 拖动落位（原型 pointermove 的夹取：0.1 m 取整，范围 [0,w]×[0,d] —— FIX-05 收严） */
export function moveItem(layout, id, x, z) {
  if (!layout.items.some((i) => i.id === id)) {
    // **不哄人**：id 不在布局里，说明调用方拿的是旧快照（或时序错）。
    // 静默无操作会让界面看起来"拖了没反应" —— 那种问题查起来最费时间，所以这里必须出声。
    console.warn(`[core] moveItem: 布局里没有 #${id}，这次移动被丢弃（是拿到旧快照了吗？）`);
    return layout;
  }
  const c = clampToRoom(layout, x, z);
  return {
    ...layout,
    // 先按毫米取整、再夹进房间：反过来的话，夹取到边界的小数（如 w=7.9995）会被取整"顶"到
    // 房间外面 0.5 mm，判定立刻报 out-of-room —— 顺序不是风格问题。
    items: layout.items.map((i) =>
      i.id === id
        ? (() => { const q = clampToRoom(layout, roundMm(x), roundMm(z)); return { ...i, x: q.x, z: q.z }; })()
        : i),
  };
}

/** 旋转到任意角度（原型持把手拖动的吸附公式：5° 吸附 + 归一到 [0,360)） */
export function snapAngle(deg) {
  return (Math.round(deg / cfg.space.rotateStepDeg) * cfg.space.rotateStepDeg + 360) % 360;
}

/** 由"指针相对设备中心的方位"算出目标角度（原型 pointermove 旋转分支，逐行对齐） */
export function angleFromPointer(centerX, centerZ, px, pz) {
  const raw = (Math.atan2(pz - centerZ, px - centerX) * 180) / Math.PI + 90;
  return snapAngle(raw);
}

/**
 * 旋转手柄离设备中心的距离：半个进深 + 0.32 m 的空隙。
 *
 * ⚠️ 手柄**画在哪儿**和**角度怎么算**必须是同一套约定 —— 这正是用户报的那条 bug：
 *    手柄原来画在 `(−sin r, +cos r)`，也就是内核角度的**反面**（设备 0° 时手柄画在 180° 的位置），
 *    而 `angleFromPointer` 对同一个点算出来的正好是 `r + 180` → 一按一拖，模型**瞬间翻 180°**。
 *    两处各写一套、谁都不报错，是这个项目最怕的失败模式，所以现在两处都住在内核里，并有单测互证。
 */
export const HANDLE_GAP_M = 0.32;

/** 手柄中心到设备中心的距离（米） */
export function handleDistOf(product) {
  const d = Number(product && product.d);
  return (Number.isFinite(d) ? d / 2 : 0) + HANDLE_GAP_M;
}

/**
 * 旋转手柄的位置（画布坐标，米）。
 *
 * 与 `angleFromPointer` **互逆**：`angleFromPointer(x, z, handlePoint(x, z, r, dist)) === snapAngle(r)`。
 * 0° 参考方向是 **−z（屏幕上方）** —— 与 `angleFromPointer` 的 `+90` 偏移是同一个约定
 * （内核自测也写着「正上 = 0」）。
 */
export function handlePoint(x, z, rDeg, dist) {
  const cx = Number(x);
  const cz = Number(z);
  const a = ((Number(rDeg) || 0) * Math.PI) / 180;
  const r = Number.isFinite(Number(dist)) ? Number(dist) : 0;
  if (!Number.isFinite(cx) || !Number.isFinite(cz)) return null;
  return { x: cx + r * Math.sin(a), z: cz - r * Math.cos(a) };
}

/** 旋转设备（旋转按钮 = +90） */
export function rotateItem(layout, id, deg) {
  return {
    ...layout,
    items: layout.items.map((i) => (i.id === id ? { ...i, r: snapAngle(deg) } : i)),
  };
}

/** 画墙：轴对齐吸附 + 最短长度 0.1 + 上限 100（原型 pointerdown 画墙分支） */
/**
 * 点归一化：墙体端点允许 `[x, z]` 或 `{ x, z }` 两种写法。
 *
 * 这个函数是一次真事故的产物：界面按数组传，内核按 `{x,z}` 取字段 →
 * 四个字段全 undefined → `Math.abs(NaN) > NaN` 为 false → 长度守卫 `NaN <= 0.1` 也为 false
 * → **NaN 墙被默默写入布局**，而 NaN 多边形的重叠判定恒为相交，
 * 于是整个房间的设备全部被报“碰墙”。入口处不接受非有限数，这类事故就不可能发生。
 */
export function toPoint(v) {
  const p = Array.isArray(v) ? { x: v[0], z: v[1] } : v;
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) return null;
  return { x: p.x, z: p.z };
}

/** 画墙的角度吸附档：15°。与旋转的 5° 分开 —— 墙是「结构」，档位粗一点更好用 */
export const WALL_SNAP_DEG = 15;

/**
 * 「快贴上了」的判定距离（米）。0.15 = 网格 0.1 m 的一格半：
 * 手感上就是"我明明瞄着墙拖过去的"，但不会把普通位置也吸过去。
 */
export const WALL_JOIN_M = 0.15;

/**
 * 贴边 / 贴墙吸附（**内核**判，界面不掺和）。
 *
 * 为什么必须有它：画墙统一按 0.1 m 网格吸（`space.snapM`），可房间尺寸**已经是毫米口径**
 * —— 房间宽 4.05 m 时，内墙会停在 4.0 m，**与外墙差 5 cm**。2D 上是一条缝、3D 上对不齐，
 * 用户只能靠手工微调（而手工也调不出来：网格就是 0.1 m）。
 *
 * 三类候选一起比，**谁离得近谁生效**（不搞优先级 —— 优先级会出现"我明明瞄着墙线，
 * 它却吸到 5 cm 外的角上"这种说不清的行为）：
 *   · 已有墙的**端点** —— 两根墙真正接上（同一个点，不是"差几毫米"）
 *   · 已有墙的**线** —— T 形接头：投影到那一段上（只在线段之内才算）
 *   · 房间的**四条边界** —— 各轴独立：贴左/右只动 x，贴上/下只动 z（另一轴保持用户拖到的位置）
 *
 * @returns {{x:number,z:number,kind:'none'|'wall-end'|'wall-line'|'boundary',dist:number}}
 *          `kind` 是有意返回的：界面要说"吸到哪儿了"，单测也要能断言"是哪条规则生效"。
 */
export function joinPoint(layout, point, { join = WALL_JOIN_M } = {}) {
  const p = toPoint(point);
  if (!p) return null;
  const tol = Number.isFinite(join) ? join : WALL_JOIN_M;
  let best = { x: p.x, z: p.z, kind: 'none', dist: Infinity };
  const consider = (x, z, kind, dist) => {
    if (dist <= tol && dist < best.dist) best = { x, z, kind, dist };
  };

  const walls = Array.isArray(layout?.walls) ? layout.walls : [];
  for (const w of walls) {
    if (!w) continue;
    const [x, z, xx, zz] = wallSeg(w);
    // ① 端点
    consider(x, z, 'wall-end', Math.hypot(p.x - x, p.z - z));
    consider(xx, zz, 'wall-end', Math.hypot(p.x - xx, p.z - zz));
    // ② 线（投影；只在那一段之内才算）
    const dx = xx - x;
    const dz = zz - z;
    const L2 = dx * dx + dz * dz;
    if (L2 > 1e-12) {
      const t = ((p.x - x) * dx + (p.z - z) * dz) / L2;
      if (t > 0 && t < 1) {
        const px = x + dx * t;
        const pz = z + dz * t;
        consider(px, pz, 'wall-line', Math.hypot(p.x - px, p.z - pz));
      }
    }
  }

  // ③ 边界（各轴独立：只把够近的那条轴拉过去，另一轴保持用户拖到的位置）
  const w0 = Number(layout?.w);
  const d0 = Number(layout?.d);
  if (Number.isFinite(w0)) {
    consider(0, p.z, 'boundary', Math.abs(p.x));
    consider(w0, p.z, 'boundary', Math.abs(p.x - w0));
  }
  if (Number.isFinite(d0)) {
    consider(p.x, 0, 'boundary', Math.abs(p.z - 0));
    consider(p.x, d0, 'boundary', Math.abs(p.z - d0));
  }

  // 边界那条要按"两轴都要近"来算？不：上面已经逐轴独立，够近就单独拉某一轴。
  // （贴左墙时 z 不动 —— 那不是"吸附粗糙"，那是"我只要贴这一面"。）
  return best;
}

/**
 * 画墙终点吸附（**预览与落笔共用这一份**，否则看到的位置和存下来的不一样）：
 *  - 默认吸到 15° 档（0 / 15 / 30 … 90，所以「大致水平」就真的是水平）；
 *  - `free`（按住 Shift）= 一点都不吸，用户说了算；
 *  - 长度不变：只转方向，不缩不放 —— 用户拖到哪儿就是哪儿。
 * @returns {{x:number,z:number}|null}
 */
export function snapWallEnd(start, end, { free = false } = {}) {
  const s = toPoint(start);
  const e = toPoint(end);
  if (!s || !e) return null;
  if (free) return { x: e.x, z: e.z };
  const dx = e.x - s.x;
  const dz = e.z - s.z;
  const len = Math.hypot(dx, dz);
  if (!(len > 1e-9)) return { x: e.x, z: e.z };
  const step = (WALL_SNAP_DEG * Math.PI) / 180;
  const a = Math.round(Math.atan2(dz, dx) / step) * step;
  return { x: s.x + Math.cos(a) * len, z: s.z + Math.sin(a) * len };
}

export function addWall(layout, start, end, { free = false } = {}) {
  const s0 = toPoint(start);
  const t = toPoint(end);
  if (!s0 || !t) return { ok: false, reason: 'bad-point', message: MSG.badPoint };
  if (layout.walls.length >= cfg.layout.maxWalls) return { ok: false, reason: 'wall-limit', message: MSG.wallLimit };
  // 起点先贴边/贴墙（用户是**瞄着外墙拖出内墙**的，起点当然也要接上），
  // 再拿这个起点去算方向的 15° 吸附 —— 顺序不能反：先吸角度的话，起点一挪方向就歪了。
  // Shift（free）= 一点都不吸：角度不吸、贴边也不吸（"自由"就该是自由，不要半吸不吸）。
  const sj = free ? s0 : joinPoint(layout, s0);
  const sc = clampToRoom(layout, sj.x, sj.z);
  const s = { x: roundMm(sc.x), z: roundMm(sc.z) };
  // 斜墙也允许（用户实测需求：只考虑两点之间的**直**墙，不考虑曲面）。
  // 旧实现把终点投影到主轴 → 永远横平竖直；现在只做 15° 吸附（Shift = 不吸）。
  const snapped = snapWallEnd(s, t, { free }) ?? t;
  // 角度吸完再贴边/贴墙（贴边在后：接得上比"正好 15°"更重要，代价是方向最多偏 0.15 m 对应的角）
  const ej = free ? snapped : joinPoint(layout, snapped);
  // 吸附可能把端点推出房间（贴边画的时候），夹回来 —— 否则这份文件**导入会被拒**
  // （B19 的 wall-out-of-room），等于自己生成了一份自己读不了的文件。
  const c = clampToRoom(layout, ej.x, ej.z);
  const e = { x: roundMm(c.x), z: roundMm(c.z) };
  if (Math.hypot(e.x - s.x, e.z - s.z) <= 0.1) return { ok: false, reason: 'too-short', message: MSG.wallTooShort };
  return { ok: true, layout: { ...layout, walls: [...layout.walls, mkWallSeg(s.x, s.z, e.x, e.z)] } };
}

/** 判"贴边 / 共线"的几何容差（与 `classifyWallRole` / `checkWall` 的外墙容差同口径） */
const EDGE_TOL = 1e-6;

/**
 * 新墙是否被**某一条**已有墙完全覆盖（同一直线、覆盖 ≥ 全长）。
 * @returns {{duplicate:number|null,covered:number}} `duplicate` = 完全覆盖它的墙序号（0 基），没有则 null
 */
function coverInfo(walls, A, B) {
  const dx = B[0] - A[0];
  const dz = B[1] - A[1];
  const L = Math.hypot(dx, dz);
  let duplicate = null;
  let covered = 0;
  walls.forEach((wl, index) => {
    const [x, z, xx, zz] = wallSeg(wl);
    const wx = xx - x;
    const wz = zz - z;
    const wl2 = wx * wx + wz * wz;
    if (!(wl2 > 1e-12)) return;
    const wlen = Math.sqrt(wl2);
    // 两个端点都落在同一条直线上（到墙线的垂距 ≤ 容差）
    const dA = Math.abs((A[0] - x) * wz - (A[1] - z) * wx) / wlen;
    const dB = Math.abs((B[0] - x) * wz - (B[1] - z) * wx) / wlen;
    if (dA > EDGE_TOL || dB > EDGE_TOL) return;
    const tA = ((A[0] - x) * wx + (A[1] - z) * wz) / wl2;
    const tB = ((B[0] - x) * wx + (B[1] - z) * wz) / wl2;
    const lo = Math.max(0, Math.min(tA, tB));
    const hi = Math.min(1, Math.max(tA, tB));
    const seg = Math.max(0, hi - lo) * wlen;
    if (seg > covered) covered = seg;
    if (seg >= L - EDGE_TOL && duplicate === null) duplicate = index;
  });
  return { duplicate, covered };
}

/**
 * 两根线段的交点参数。
 * @returns {{t:number,u:number,x:number,z:number}|null} `t` 在 AB 上、`u` 在 CD 上；平行/共线返回 null
 */
function segIntersection(A, B, C, D) {
  const rx = B[0] - A[0];
  const rz = B[1] - A[1];
  const sx = D[0] - C[0];
  const sz = D[1] - C[1];
  const den = rx * sz - rz * sx;
  if (Math.abs(den) < 1e-12) return null; // 平行/共线：不在这里拆（重合另有 coverInfo 判）
  const qx = C[0] - A[0];
  const qz = C[1] - A[1];
  const t = (qx * sz - qz * sx) / den;
  const u = (qx * rz - qz * rx) / den;
  if (t < -EDGE_TOL || t > 1 + EDGE_TOL || u < -EDGE_TOL || u > 1 + EDGE_TOL) return null;
  return { t, u, x: A[0] + rx * t, z: A[1] + rz * t };
}

/** 把一面墙在 `at`（自 a 起的弧长）处断开；洞口跨过切点时拒绝，绝不把门/窗切一半。 */
function splitWallRecord(wall, at) {
  const [x, z, xx, zz] = wallSeg(wall);
  const len = Math.hypot(xx - x, zz - z);
  // 只断“中间”：端点上没有可删的一段，也不该制造零长墙
  if (!(len > EDGE_TOL) || at <= EDGE_TOL || at >= len - EDGE_TOL) return null;
  const t = at / len;
  const px = x + (xx - x) * t;
  const pz = z + (zz - z) * t;
  // 端点对齐到毫米网格：与画墙端点的取整口径一致，落笔后的两段能真正接上
  const cut = [roundMm(px), roundMm(pz)];
  const cutAt = Math.hypot(cut[0] - x, cut[1] - z);
  if (!(cutAt > EDGE_TOL) || cutAt >= len - EDGE_TOL) return null;

  const left = [];
  const right = [];
  for (const o of openingsOf(wall)) {
    const oAt = Number(o?.at);
    const ow = Number(o?.w);
    if (!Number.isFinite(oAt) || !Number.isFinite(ow) || ow <= 0) {
      return { ok: false, reason: 'opening-invalid' };
    }
    const s0 = oAt - ow / 2;
    const s1 = oAt + ow / 2;
    if (s1 <= cutAt + EDGE_TOL) left.push(cloneOpening(o));
    else if (s0 >= cutAt - EDGE_TOL) right.push({ ...cloneOpening(o), at: oAt - cutAt });
    else return { ok: false, reason: 'opening-crosses-split' };
  }
  const role = roleOf(wall);
  return {
    ok: true,
    left: mkWall([x, z], cut, left, role),
    right: mkWall(cut, [xx, zz], right, role),
    cut,
    at: cutAt,
  };
}

/**
 * 新墙落进墙池前，把被它**碰到中间**的旧墙在接头处断开。
 *
 * 用户场景：先画一整面长墙，再从中间接一段出去；这时旧墙应该变成两段，
 * 才能单独删掉其中一段（否则只能整面删）。只处理“真正接上”的接头：
 * 新墙的端点落在旧墙内部（T 形），或新墙从旧墙内部穿过（X 形）；端点对端点不拆。
 *
 * 洞口跨过切点时**不拆这一面**并回报，交给界面说清楚；绝不把门/窗切成两半。
 * @returns {{walls:Array, count:number, items:Array, skipped:Array}}
 */
function splitWallsAtJoints(walls, A, B) {
  const out = [];
  const items = [];
  const skipped = [];
  for (const wall of walls) {
    const [x, z, xx, zz] = wallSeg(wall);
    const hit = segIntersection(A, B, [x, z], [xx, zz]);
    // 交点必须在**旧墙内部**；新墙端点/交点在新墙端点也允许（T 形起笔）
    if (!hit || hit.u <= EDGE_TOL || hit.u >= 1 - EDGE_TOL) { out.push(wall); continue; }
    const len = Math.hypot(xx - x, zz - z);
    const sp = splitWallRecord(wall, hit.u * len);
    if (!sp) { out.push(wall); continue; }
    if (sp.ok === false) {
      out.push(wall);
      skipped.push({ at: [hit.x, hit.z], reason: sp.reason });
      continue;
    }
    out.push(sp.left, sp.right);
    items.push({ at: sp.cut, reason: 'joint' });
  }
  return { walls: out, count: items.length, items, skipped };
}

/**
 * 画墙的**唯一入口**（预览与落笔共用，`docs/93` §5.3）：一次算出「扩不扩场景、扩到多少、
 * 墙落在哪、角色是什么」，返回新 layout。
 *
 * 与 `addWall` 的关键差别：**场外端点不夹取**（`addWall` 会 clamp 回 `[0,w]×[0,d]` ——
 * 那正是"只能画内墙"这条 bug 的根因）。场外时先 `expandSceneKeepWalls` 把场景扩到包含墙，
 * 墙端点保持用户拖到的位置。
 *
 * 流程（顺序不能变）：
 *  1. 点归一化 + 有限数校验 → `bad-point`；墙数上限 → `wall-limit`；
 *  2. 起点吸附（贴墙/贴边）→ 15° 方向吸附 → 终点吸附 → 毫米取整（与 `addWall` 同一条手感，
 *     `free` = 全不吸，Shift 语义）；
 *  3. 零长 → `zero-length`；短于 `minWallLengthM` → `too-short`（都在扩场景**之前**判，
 *     不为一条 5 cm 的墙扩场景）；
 *  4. 两端点包围盒 → `expandSceneKeepWalls`；超范围 → `room-too-large`（带真实 w/d，不落墙）；
 *  5. 落墙前判「完全重合」→ `duplicate`；角色用 `classifyWallRole`（扩场景后的新坐标）；
 *  6. 新墙追加到墙池**末尾**（`wallIndex` = 旧墙数），返回扩场景说明与改判清单。
 *
 * @param {object} layout
 * @param {[number,number]|{x:number,z:number}} start 原始指针点（不必先吸附/夹取）
 * @param {[number,number]|{x:number,z:number}} end
 * @param {{free?:boolean}} [opts] `free` = 不吸角度/不贴边（按住 Shift）
 * @returns {{ok:false,reason:string,code:string,message:string,length?:number,w?:number,d?:number}
 *          |{ok:true,layout:object,wall:object,wallIndex:number,role:'exterior'|'interior',
 *            expanded:null|{from:[number,number],to:[number,number],dx:number,dz:number,
 *              rect:object,reclassified:Array},overlapM:number,
 *            split:{count:number,items:Array,skipped:Array}}}
 */
export function planDrawWall(layout, start, end, { free = false } = {}) {
  const rawStart = toPoint(start);
  const rawEnd = toPoint(end);
  if (!rawStart || !rawEnd) {
    return { ok: false, reason: 'bad-point', code: 'bad-point', message: MSG.badPoint };
  }
  if (layout.walls.length >= cfg.layout.maxWalls) {
    return { ok: false, reason: 'wall-limit', code: 'wall-limit', message: MSG.wallLimit };
  }

  // ① 起点吸附 → 取整。**不 clamp**：场外起笔原样保留（"能画到场外"由此成立）
  const sj = free ? rawStart : joinPoint(layout, rawStart) ?? rawStart;
  const s = { x: roundMm(sj.x), z: roundMm(sj.z) };
  // ② 方向吸附（以吸附后的起点为基准）→ 终点吸附 → 取整
  const snapped = snapWallEnd(s, rawEnd, { free }) ?? rawEnd;
  const ej = free ? snapped : joinPoint(layout, snapped) ?? snapped;
  const e = { x: roundMm(ej.x), z: roundMm(ej.z) };

  const len = Math.hypot(e.x - s.x, e.z - s.z);
  if (!(len > 1e-9)) {
    return { ok: false, reason: 'zero-length', code: 'zero-length', message: MSG.zeroLength, length: 0 };
  }
  if (len < cfg.scheme.minWallLengthM) {
    return { ok: false, reason: 'too-short', code: 'too-short', message: MSG.wallTooShort, length: len };
  }

  // ③ 扩场景（只扩到恰好包含吸附后的两个端点；right/down 只加范围，left/up 整体平移）
  const rect = {
    x0: Math.min(s.x, e.x),
    z0: Math.min(s.z, e.z),
    x1: Math.max(s.x, e.x),
    z1: Math.max(s.z, e.z),
  };
  const exp = expandSceneKeepWalls(layout, rect);
  if (!exp.ok) {
    return {
      ok: false,
      reason: exp.code,
      code: exp.code,
      message: exp.error,
      ...(exp.code === 'room-too-large' ? { w: exp.w, d: exp.d } : {}),
    };
  }
  const next = exp.layout;
  const A = [s.x + exp.dx, s.z + exp.dz];
  const B = [e.x + exp.dx, e.z + exp.dz];

  // ④ 重合（完全覆盖）拒绝；部分重叠只报出来，不自动裁（UI 显示黄色提示）
  const cover = coverInfo(next.walls, A, B);
  if (cover.duplicate !== null) {
    return { ok: false, reason: 'duplicate', code: 'duplicate', message: MSG.duplicate };
  }

  // ⑤ 角色：起笔在**原场景**外 → 外墙；否则看扩场景后是否贴同一条新边缘
  const fromOutside = rawStart.x < -EDGE_TOL || rawStart.x > layout.w + EDGE_TOL
    || rawStart.z < -EDGE_TOL || rawStart.z > layout.d + EDGE_TOL;
  const role = classifyWallRole(next, { a: A, b: B }, { fromOutside });

  const wall = mkWallSeg(A[0], A[1], B[0], B[1], [], role);
  const outOfRoom = checkWall(next, wall);
  if (outOfRoom === WALL_REASON.WALL_OUT_OF_ROOM) {
    // 理论上到不了（扩场景已包含两端）；到了说明几何有洞 —— 宁可失败也不写一份导不回来的方案
    return { ok: false, reason: outOfRoom, code: outOfRoom, message: '墙超出了场景范围（内核几何异常）' };
  }

  // ⑥ 接头拆分：新墙碰到旧墙中间 → 旧墙在接头处变成两段（可分别删），而不是整面留着。
  const split = splitWallsAtJoints(next.walls, A, B);
  if (split.walls.length + 1 > cfg.layout.maxWalls) {
    return { ok: false, reason: 'wall-limit', code: 'wall-limit', message: MSG.wallLimit };
  }
  const wallIndex = split.walls.length;
  return {
    ok: true,
    layout: { ...next, walls: [...split.walls, wall] },
    wall,
    wallIndex,
    role,
    split: { count: split.count, items: split.items, skipped: split.skipped },
    expanded: exp.changed
      ? {
        from: [layout.w, layout.d],
        to: [next.w, next.d],
        dx: exp.dx,
        dz: exp.dz,
        rect: exp.rect,
        reclassified: exp.reclassified,
      }
      : null,
    overlapM: cover.covered,
  };
}

/**
 * 指针位置 → 最近一面墙上的**弧长 `s`**（自该墙 `a` 端点起，米）。
 *
 * 为什么住在 placement.js：这是**指针到几何的投影**，与 `handlePoint` / `angleFromPointer`
 * 是同一类东西（都是"指针在屏幕上的位置 ↔ 模型里的一个数"），住在一起才不会两处各写一套
 *（本项目在"手柄画在一侧、角度算在另一侧"上付过学费，`handlePoint` 的注释里记着）。
 *
 * 门洞的 `at` 就是这个 `s` —— 所以放门时"看到的位置"与"存下来的 `at`"用的是同一个数。
 * @param {object} layout
 * @param {{x:number,z:number}} point
 * @param {{maxDist?:number, free?:boolean}} [opts] `maxDist` 超过它就不认（米）；默认不限制
 * @returns {{wallIndex:number, s:number, dist:number, x:number, z:number}|null}
 *          `x/z` 是投影点（墙中心线上的那个点，世界坐标）
 */
export function projectOnWall(layout, point, { maxDist = Infinity, free = false } = {}) {
  const p = toPoint(point);
  if (!p || !Array.isArray(layout?.walls) || !layout.walls.length) return null;
  let best = null;
  layout.walls.forEach((wall, wallIndex) => {
    const [x, z, xx, zz] = wallSeg(wall);
    const dx = xx - x;
    const dz = zz - z;
    const len2 = dx * dx + dz * dz;
    if (!(len2 > 1e-12)) return;
    let t = ((p.x - x) * dx + (p.z - z) * dz) / len2;
    // 不夹到 [0,1]：**投影点可以落在墙的延长线上** —— "指针在墙外一点点"也要能算出
    // 一个弧长来，否则贴墙点门时会突然返回 null（手感上就是"点不动"）。
    // 超出端点多少由 `fitOpening` 夹回来（它才是管边界的地方）。
    if (!free) t = Math.max(0, Math.min(1, t));
    const px = x + dx * t;
    const pz = z + dz * t;
    const dist = Math.hypot(p.x - px, p.z - pz);
    if (dist > maxDist) return;
    const s = Math.hypot(dx, dz) * t;
    if (!best || dist < best.dist) best = { wallIndex, s, dist, x: px, z: pz };
  });
  return best;
}

/**
 * 把弧长夹回墙上（给"点击点门"用：指针可能落在墙外，`s` 会超出 [0,len]）。
 * 只夹到墙身内，**不管门洞间隙** —— 间隙是 `fitOpening` 的事（一处管一件事）。
 */
export function projectClampS(wall, s) {
  const len = wallLen(wall);
  return Math.max(0, Math.min(len, s));
}