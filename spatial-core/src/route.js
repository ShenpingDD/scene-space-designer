/**
 * route.js —— 人员地面动线（P1 内核，纯函数）
 *
 * 契约（设计决策记录 §四冻结）：
 *  - state.routes = [{id, name?, points:[[x,z],...]}]；points 是**用户点出的站点/途经点**，
 *    2–20 个，最多 6 条；不存自动折线/长度/状态/颜色/closed。
 *  - 自动路径：0.10 m 栅格 A* + 门洞 portal + 精确线段复核 + string pulling。
 *  - 可通行空间与第一人称同一把尺子：场景边界内缩 walk.radiusM；墙用 wallSolidSegments
 *    （门洞挖空、窗洞仍是实心）；设备只用 walk.radiusM，**不额外加设备净空**。
 *
 * 本模块不 import DOM / Three.js / app；也不 import room.js（避免循环）。
 */
import { cfg } from './params.js';
import { EPS, roundMm, segmentDistance } from './geometry.js';
import { wallSeg } from './wall.js';
import { wallSolidSegments, doorOpenings } from './openings.js';
import { columnsOf } from './columns.js';

export const ROUTE_REASON = {
  BAD_ROUTE: 'bad-route',
  POINT_OUT_OF_SCENE: 'route-point-out-of-scene',
  ANCHOR_BLOCKED: 'anchor-blocked',
  UNREACHABLE: 'unreachable',
  DOOR_TOO_NARROW: 'door-too-narrow',
  DOOR_BLOCKED: 'door-blocked',
  NAV_TOO_LARGE: 'nav-too-large',
  ROUTE_TOO_LONG: 'route-too-long',
};

const MAX_GRID_CELLS = 100000;
const SAFETY_GRID_FACTOR = Math.SQRT1_2; // 相邻格心连线最多偏离格心 half-diagonal

function finite(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function radiusOf(opts) {
  const v = opts && opts.radius;
  return finite(v) && v > 0 ? v : cfg.walk.radiusM;
}

function wallClearanceOf(opts) {
  const v = opts && opts.wallClearance;
  return finite(v) && v >= 0 ? v : cfg.walk.wallClearanceM;
}

function getProductOf(opts) {
  return (opts && typeof opts.getProduct === 'function') ? opts.getProduct : () => undefined;
}

function pointOf(p) {
  return Array.isArray(p) && p.length >= 2 && finite(p[0]) && finite(p[1]);
}

function dist(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** 相邻用户点之间的线段（不闭合；v1 没有 closed） */
export function routeSegments(route) {
  const points = Array.isArray(route?.points) ? route.points : [];
  const out = [];
  for (let i = 0; i + 1 < points.length; i += 1) {
    if (!pointOf(points[i]) || !pointOf(points[i + 1])) continue;
    out.push({ fromIndex: i, toIndex: i + 1, a: points[i], b: points[i + 1] });
  }
  return out;
}

/** 坐标是否落在场景矩形 [0,w]×[0,d]（不是“可站”判据；可站见 pointWalkable） */
export function routePointInScene(layout, point) {
  if (!layout || !pointOf(point)) return false;
  return point[0] >= -EPS && point[1] >= -EPS
    && point[0] <= layout.w + EPS && point[1] <= layout.d + EPS;
}

/* ---------------- 精确几何：点 / 线段扫掠 ---------------- */

function segmentsIntersect(ax, az, bx, bz, cx, cz, dx, dz) {
  const orient = (px, pz, qx, qz, rx, rz) => (qx - px) * (rz - pz) - (qz - pz) * (rx - px);
  const o1 = orient(ax, az, bx, bz, cx, cz);
  const o2 = orient(ax, az, bx, bz, dx, dz);
  const o3 = orient(cx, cz, dx, dz, ax, az);
  const o4 = orient(cx, cz, dx, dz, bx, bz);
  if (((o1 > EPS && o2 < -EPS) || (o1 < -EPS && o2 > EPS))
    && ((o3 > EPS && o4 < -EPS) || (o3 < -EPS && o4 > EPS))) return true;
  const on = (px, pz, qx, qz, rx, rz) => Math.abs(orient(px, pz, qx, qz, rx, rz)) <= EPS
    && rx >= Math.min(px, qx) - EPS && rx <= Math.max(px, qx) + EPS
    && rz >= Math.min(pz, qz) - EPS && rz <= Math.max(pz, qz) + EPS;
  return on(ax, az, bx, bz, cx, cz) || on(ax, az, bx, bz, dx, dz)
    || on(cx, cz, dx, dz, ax, az) || on(cx, cz, dx, dz, bx, bz);
}

/** 两条线段的最小距离（相交 = 0） */
function segmentSegmentDistance(ax, az, bx, bz, cx, cz, dx, dz) {
  if (segmentsIntersect(ax, az, bx, bz, cx, cz, dx, dz)) return 0;
  return Math.min(
    segmentDistance(ax, az, cx, cz, dx, dz),
    segmentDistance(bx, bz, cx, cz, dx, dz),
    segmentDistance(cx, cz, ax, az, bx, bz),
    segmentDistance(dx, dz, ax, az, bx, bz),
  );
}

/** 线段到旋转矩形（设备 OBB）的最小距离；矩形用中心 + 宽深 + 角度表示 */
function segmentObbDistance(ax, az, bx, bz, item, product) {
  const a = (Number(item.r) || 0) * Math.PI / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const local = (x, z) => {
    const dx = x - item.x;
    const dz = z - item.z;
    return [c * dx + s * dz, -s * dx + c * dz];
  };
  const [axl, azl] = local(ax, az);
  const [bxl, bzl] = local(bx, bz);
  const hw = product.w / 2;
  const hd = product.d / 2;
  const inside = (x, z) => Math.abs(x) <= hw + EPS && Math.abs(z) <= hd + EPS;
  if (inside(axl, azl) || inside(bxl, bzl)) return 0;
  const edges = [
    [-hw, -hd, hw, -hd], [hw, -hd, hw, hd],
    [hw, hd, -hw, hd], [-hw, hd, -hw, -hd],
  ];
  let best = Infinity;
  for (const [x1, z1, x2, z2] of edges) {
    best = Math.min(best, segmentSegmentDistance(axl, azl, bxl, bzl, x1, z1, x2, z2));
  }
  return best;
}

/** 单点是否可站：场景内缩 radius、墙实心段外 radius+wallClearance、设备 OBB 外 radius */
export function pointWalkable(layout, point, opts = {}) {
  if (!layout || !pointOf(point)) return false;
  const radius = radiusOf(opts);
  const clearance = wallClearanceOf(opts);
  const x = point[0];
  const z = point[1];
  if (x < radius - EPS || z < radius - EPS
    || x > layout.w - radius + EPS || z > layout.d - radius + EPS) return false;
  const wallNeed = radius + clearance;
  for (const w of (layout.walls || [])) {
    for (const seg of wallSolidSegments(w)) {
      if (segmentDistance(x, z, seg[0], seg[1], seg[2], seg[3]) < wallNeed - EPS) return false;
    }
  }
  // 结构柱：与墙同口径 radius + wallClearance
  for (const c of columnsOf(layout)) {
    const qx = Math.max(Math.abs(x - c.x) - c.w / 2, 0);
    const qz = Math.max(Math.abs(z - c.z) - c.d / 2, 0);
    if (Math.hypot(qx, qz) < wallNeed - EPS) return false;
  }
  const getProduct = getProductOf(opts);
  for (const it of (layout.items || [])) {
    const p = getProduct(it.p);
    if (!p || !finite(p.w) || !finite(p.d)) continue;
    const a = (Number(it.r) || 0) * Math.PI / 180;
    const dx = x - it.x;
    const dz = z - it.z;
    const lx = Math.cos(a) * dx + Math.sin(a) * dz;
    const lz = -Math.sin(a) * dx + Math.cos(a) * dz;
    const qx = Math.max(Math.abs(lx) - p.w / 2, 0);
    const qz = Math.max(Math.abs(lz) - p.d / 2, 0);
    if (Math.hypot(qx, qz) < radius - EPS) return false;
  }
  return true;
}

/** 线段扫掠是否可走：与 pointWalkable 同一套半径/间隙；网格只负责找路，不负责判合法 */
export function segmentWalkable(layout, a, b, opts = {}) {
  if (!layout || !pointOf(a) || !pointOf(b)) return false;
  const radius = radiusOf(opts);
  const clearance = wallClearanceOf(opts);
  const minX = Math.min(a[0], b[0]);
  const maxX = Math.max(a[0], b[0]);
  const minZ = Math.min(a[1], b[1]);
  const maxZ = Math.max(a[1], b[1]);
  if (minX < radius - EPS || minZ < radius - EPS
    || maxX > layout.w - radius + EPS || maxZ > layout.d - radius + EPS) return false;
  const wallNeed = radius + clearance;
  for (const w of (layout.walls || [])) {
    for (const seg of wallSolidSegments(w)) {
      if (segmentSegmentDistance(a[0], a[1], b[0], b[1], seg[0], seg[1], seg[2], seg[3]) < wallNeed - EPS) return false;
    }
  }
  // 结构柱：线段扫掠与墙同口径（柱是硬障碍，不能从柱子边缘挤过去）
  for (const c of columnsOf(layout)) {
    const hit = segmentObbDistance(a[0], a[1], b[0], b[1],
      { x: c.x, z: c.z, r: 0 }, { w: c.w, d: c.d });
    if (hit < wallNeed - EPS) return false;
  }
  const getProduct = getProductOf(opts);
  for (const it of (layout.items || [])) {
    const p = getProduct(it.p);
    if (!p || !finite(p.w) || !finite(p.d)) continue;
    if (segmentObbDistance(a[0], a[1], b[0], b[1], it, p) < radius - EPS) return false;
  }
  return true;
}

/* ---------------- 导航栅格 ---------------- */

const NAV_CACHE = { key: null, nav: null };

export function invalidateRouteCache() {
  NAV_CACHE.key = null;
  NAV_CACHE.nav = null;
}

function cellIndex(nav, ix, iz) {
  return iz * nav.nx + ix;
}

function cellCenter(nav, id) {
  const ix = id % nav.nx;
  const iz = Math.floor(id / nav.nx);
  return [(ix + 0.5) * nav.gridM, (iz + 0.5) * nav.gridM];
}

function itemBoxCorners(it, p) {
  const a = (Number(it.r) || 0) * Math.PI / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [[-p.w / 2, -p.d / 2], [p.w / 2, -p.d / 2], [p.w / 2, p.d / 2], [-p.w / 2, p.d / 2]]
    .map(([x, z]) => [it.x + x * c - z * s, it.z + x * s + z * c]);
}

function markNearSegment(nav, seg, limit) {
  const [x1, z1, x2, z2] = seg;
  const minX = Math.min(x1, x2) - limit;
  const maxX = Math.max(x1, x2) + limit;
  const minZ = Math.min(z1, z2) - limit;
  const maxZ = Math.max(z1, z2) + limit;
  const ix0 = Math.max(0, Math.floor(minX / nav.gridM - 0.5));
  const ix1 = Math.min(nav.nx - 1, Math.ceil(maxX / nav.gridM - 0.5));
  const iz0 = Math.max(0, Math.floor(minZ / nav.gridM - 0.5));
  const iz1 = Math.min(nav.nz - 1, Math.ceil(maxZ / nav.gridM - 0.5));
  for (let iz = iz0; iz <= iz1; iz += 1) {
    const z = (iz + 0.5) * nav.gridM;
    for (let ix = ix0; ix <= ix1; ix += 1) {
      const id = cellIndex(nav, ix, iz);
      if (!nav.free[id]) continue;
      const x = (ix + 0.5) * nav.gridM;
      if (segmentDistance(x, z, x1, z1, x2, z2) < limit - EPS) nav.free[id] = 0;
    }
  }
}

function markNearItem(nav, it, product, limit) {
  const cs = itemBoxCorners(it, product);
  const minX = Math.min(...cs.map((p) => p[0])) - limit;
  const maxX = Math.max(...cs.map((p) => p[0])) + limit;
  const minZ = Math.min(...cs.map((p) => p[1])) - limit;
  const maxZ = Math.max(...cs.map((p) => p[1])) + limit;
  const ix0 = Math.max(0, Math.floor(minX / nav.gridM - 0.5));
  const ix1 = Math.min(nav.nx - 1, Math.ceil(maxX / nav.gridM - 0.5));
  const iz0 = Math.max(0, Math.floor(minZ / nav.gridM - 0.5));
  const iz1 = Math.min(nav.nz - 1, Math.ceil(maxZ / nav.gridM - 0.5));
  const a = (Number(it.r) || 0) * Math.PI / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  for (let iz = iz0; iz <= iz1; iz += 1) {
    const z = (iz + 0.5) * nav.gridM;
    for (let ix = ix0; ix <= ix1; ix += 1) {
      const id = cellIndex(nav, ix, iz);
      if (!nav.free[id]) continue;
      const x = (ix + 0.5) * nav.gridM;
      const dx = x - it.x;
      const dz = z - it.z;
      const lx = c * dx + s * dz;
      const lz = -s * dx + c * dz;
      const qx = Math.max(Math.abs(lx) - product.w / 2, 0);
      const qz = Math.max(Math.abs(lz) - product.d / 2, 0);
      if (Math.hypot(qx, qz) < limit - EPS) nav.free[id] = 0;
    }
  }
}

function navKey(layout, opts) {
  const radius = radiusOf(opts);
  const clearance = wallClearanceOf(opts);
  const gridM = cfg.route.gridM;
  const getProduct = getProductOf(opts);
  const walls = (layout.walls || []).map((w) => {
    const [ax, az, bx, bz] = wallSeg(w);
    const openings = (w.openings || []).map((o) => `${o.kind || 'door'}:${o.at}:${o.w}:${o.h}`).join(',');
    return `${ax},${az},${bx},${bz}[${openings}]`;
  }).join(';');
  const items = (layout.items || []).map((it) => {
    const p = getProduct(it.p);
    return `${it.p}:${it.x}:${it.z}:${it.r}:${p ? `${p.w}x${p.d}` : ''}`;
  }).join(';');
  // 柱必须进 key：只改柱不改墙/设备时，否则会命中旧导航图（柱挪了、路线不挪）
  const columns = columnsOf(layout).map((c) => `${c.id}:${c.x}:${c.z}:${c.w}:${c.d}`).join(';');
  return `${layout.w}x${layout.d}|${radius}|${clearance}|${gridM}|${walls}|${columns}|${items}`;
}

function buildNav(layout, opts) {
  const gridM = cfg.route.gridM;
  if (!finite(gridM) || gridM <= 0) {
    return { ok: false, reason: ROUTE_REASON.NAV_TOO_LARGE, message: '寻路栅格参数不合法' };
  }
  const nx = Math.max(1, Math.ceil(layout.w / gridM - 1e-9));
  const nz = Math.max(1, Math.ceil(layout.d / gridM - 1e-9));
  if (nx * nz > MAX_GRID_CELLS) {
    return { ok: false, reason: ROUTE_REASON.NAV_TOO_LARGE, message: `场景 ${layout.w}×${layout.d} m 的寻路网格太大` };
  }
  const nav = {
    ok: true, gridM, nx, nz, n: nx * nz, free: new Uint8Array(nx * nz),
    portals: [], portalReverse: [], narrowDoors: [], blockedDoors: [],
    radius: radiusOf(opts), wallClearance: wallClearanceOf(opts),
  };
  nav.portalReverse = Array.from({ length: nav.n }, () => []);
  nav.free.fill(1);
  const safety = gridM * SAFETY_GRID_FACTOR;
  const boundaryLimit = nav.radius + safety;
  for (let iz = 0; iz < nz; iz += 1) {
    const z = (iz + 0.5) * gridM;
    for (let ix = 0; ix < nx; ix += 1) {
      const x = (ix + 0.5) * gridM;
      if (x < boundaryLimit - EPS || z < boundaryLimit - EPS
        || x > layout.w - boundaryLimit + EPS || z > layout.d - boundaryLimit + EPS) {
        nav.free[cellIndex(nav, ix, iz)] = 0;
      }
    }
  }
  const wallLimit = nav.radius + nav.wallClearance + safety;
  for (const w of (layout.walls || [])) {
    for (const seg of wallSolidSegments(w)) markNearSegment(nav, seg, wallLimit);
  }
  // 结构柱：墙体同口径（radius + wallClearance + grid safety）
  for (const c of columnsOf(layout)) {
    markNearItem(nav, { x: c.x, z: c.z, r: 0 }, { w: c.w, d: c.d }, wallLimit);
  }
  const getProduct = getProductOf(opts);
  for (const it of (layout.items || [])) {
    const p = getProduct(it.p);
    if (!p || !finite(p.w) || !finite(p.d)) continue;
    markNearItem(nav, it, p, nav.radius + safety);
  }

  // 门洞 portal：0.60 m 门在“半径+间隙”下自由宽度为 0，必须显式给中线通道
  const need = 2 * (nav.radius + nav.wallClearance);
  const offset = Math.max(0.2, cfg.space.wallThicknessM / 2 + 2 * gridM);
  const doors = [];
  for (let wi = 0; wi < (layout.walls || []).length; wi += 1) {
    const w = layout.walls[wi];
    const [ax, az, bx, bz] = wallSeg(w);
    const len = Math.hypot(bx - ax, bz - az);
    if (!(len > EPS)) continue;
    const ux = (bx - ax) / len;
    const uz = (bz - az) / len;
    const nxv = -uz;
    const nzv = ux;
    const ds = doorOpenings(w);
    for (let oi = 0; oi < ds.length; oi += 1) {
      const o = ds[oi];
      const width = Number(o.w);
      if (!finite(width) || !(width > 0)) continue;
      const cx = ax + ux * o.at;
      const cz = az + uz * o.at;
      const sides = [
        [cx + nxv * offset, cz + nzv * offset],
        [cx - nxv * offset, cz - nzv * offset],
      ];
      if (width < need - 1e-6) {
        nav.narrowDoors.push({ wallIndex: wi, openingIndex: oi, width, need, sides, center: [cx, cz] });
        continue;
      }
      const bothInside = sides.every((p) => routePointInScene(layout, p));
      if (!bothInside) continue; // 外墙门：门洞本身不用于“跨到室外”
      if (!sides.every((p) => pointWalkable(layout, p, opts))) {
        nav.blockedDoors.push({ wallIndex: wi, openingIndex: oi, width, need, sides, center: [cx, cz] });
        continue;
      }
      if (!segmentWalkable(layout, sides[0], sides[1], opts)) {
        nav.blockedDoors.push({ wallIndex: wi, openingIndex: oi, width, need, sides, center: [cx, cz] });
        continue;
      }
      doors.push({ wallIndex: wi, openingIndex: oi, sides });
    }
  }
  for (const d of doors) {
    const base = nav.portals.length;
    nav.portals.push({ x: d.sides[0][0], z: d.sides[0][1], pair: base + 1, links: [], door: d });
    nav.portals.push({ x: d.sides[1][0], z: d.sides[1][1], pair: base, links: [], door: d });
  }
  for (let i = 0; i < nav.portals.length; i += 1) {
    const pt = nav.portals[i];
    const p = [pt.x, pt.z];
    const reach = Math.max(0.45, gridM * 4);
    const ix0 = Math.max(0, Math.floor((pt.x - reach) / gridM - 0.5));
    const ix1 = Math.min(nx - 1, Math.ceil((pt.x + reach) / gridM - 0.5));
    const iz0 = Math.max(0, Math.floor((pt.z - reach) / gridM - 0.5));
    const iz1 = Math.min(nz - 1, Math.ceil((pt.z + reach) / gridM - 0.5));
    for (let iz = iz0; iz <= iz1; iz += 1) {
      for (let ix = ix0; ix <= ix1; ix += 1) {
        const id = cellIndex(nav, ix, iz);
        if (!nav.free[id]) continue;
        const q = [(ix + 0.5) * gridM, (iz + 0.5) * gridM];
        if (!segmentWalkable(layout, p, q, opts)) continue;
        const link = { to: id, cost: dist(p, q) };
        pt.links.push(link);
        nav.portalReverse[id].push({ to: nav.n + i, cost: link.cost });
      }
    }
    const pair = nav.portals[pt.pair];
    if (pair) {
      const q = [pair.x, pair.z];
      if (segmentWalkable(layout, p, q, opts)) pt.links.push({ to: nav.n + pt.pair, cost: dist(p, q) });
      else if (!nav.blockedDoors.some((b) => b.wallIndex === pt.door.wallIndex && b.openingIndex === pt.door.openingIndex)) {
        nav.blockedDoors.push({ ...pt.door, width: NaN, need, sides: pt.door.sides, center: [pt.x, pt.z] });
      }
    }
    if (!pt.links.length) {
      nav.blockedDoors.push({ ...pt.door, width: NaN, need, sides: pt.door.sides, center: [pt.x, pt.z] });
    }
  }
  return nav;
}

function getNav(layout, opts) {
  const key = navKey(layout, opts);
  if (opts && opts.cache === false) return buildNav(layout, opts);
  if (NAV_CACHE.key === key && NAV_CACHE.nav) return NAV_CACHE.nav;
  const nav = buildNav(layout, opts);
  NAV_CACHE.key = key;
  NAV_CACHE.nav = nav;
  return nav;
}

/* ---------------- A* ---------------- */

class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(v) {
    const a = this.a;
    a.push(v);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (cmp(a[i], a[p]) >= 0) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length && last) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && cmp(a[l], a[m]) < 0) m = l;
        if (r < a.length && cmp(a[r], a[m]) < 0) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

function cmp(a, b) {
  if (a.f < b.f - 1e-12) return -1;
  if (a.f > b.f + 1e-12) return 1;
  if (a.h < b.h - 1e-12) return -1;
  if (a.h > b.h + 1e-12) return 1;
  return a.id - b.id;
}

function nodePos(nav, id) {
  if (id < nav.n) return cellCenter(nav, id);
  const p = nav.portals[id - nav.n];
  return [p.x, p.z];
}

function nodeNeighbors(nav, id) {
  if (id >= nav.n) return nav.portals[id - nav.n].links;
  const ix = id % nav.nx;
  const iz = Math.floor(id / nav.nx);
  const out = [];
  for (let dz = -1; dz <= 1; dz += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (!dx && !dz) continue;
      const x = ix + dx;
      const z = iz + dz;
      if (x < 0 || z < 0 || x >= nav.nx || z >= nav.nz) continue;
      const to = cellIndex(nav, x, z);
      if (!nav.free[to]) continue;
      if (dx && dz) {
        if (!nav.free[cellIndex(nav, ix + dx, iz)] || !nav.free[cellIndex(nav, ix, iz + dz)]) continue;
      }
      out.push({ to, cost: dx && dz ? nav.gridM * Math.SQRT2 : nav.gridM });
    }
  }
  for (const link of nav.portalReverse[id]) out.push(link);
  return out;
}

function nearestFreeCells(layout, nav, anchor, opts, limit = 12) {
  const reach = Math.max(0.8, nav.gridM * 8);
  const ix0 = Math.max(0, Math.floor((anchor[0] - reach) / nav.gridM - 0.5));
  const ix1 = Math.min(nav.nx - 1, Math.ceil((anchor[0] + reach) / nav.gridM - 0.5));
  const iz0 = Math.max(0, Math.floor((anchor[1] - reach) / nav.gridM - 0.5));
  const iz1 = Math.min(nav.nz - 1, Math.ceil((anchor[1] + reach) / nav.gridM - 0.5));
  const out = [];
  for (let iz = iz0; iz <= iz1; iz += 1) {
    for (let ix = ix0; ix <= ix1; ix += 1) {
      const id = cellIndex(nav, ix, iz);
      if (!nav.free[id]) continue;
      const q = [(ix + 0.5) * nav.gridM, (iz + 0.5) * nav.gridM];
      const d = dist(anchor, q);
      if (d > reach + EPS) continue;
      if (!segmentWalkable(layout, anchor, q, opts)) continue;
      out.push({ id, cost: d, q });
    }
  }
  out.sort((a, b) => (a.cost - b.cost) || (a.id - b.id));
  return out.slice(0, limit);
}

function bfsComponent(nav, sources) {
  const seen = new Uint8Array(nav.n);
  const q = [];
  for (const s of sources) {
    if (s.id < nav.n && nav.free[s.id] && !seen[s.id]) { seen[s.id] = 1; q.push(s.id); }
  }
  for (let head = 0; head < q.length; head += 1) {
    const id = q[head];
    const ix = id % nav.nx;
    const iz = Math.floor(id / nav.nx);
    for (let dz = -1; dz <= 1; dz += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (!dx && !dz) continue;
        const x = ix + dx;
        const z = iz + dz;
        if (x < 0 || z < 0 || x >= nav.nx || z >= nav.nz) continue;
        const to = cellIndex(nav, x, z);
        if (seen[to] || !nav.free[to]) continue;
        if (dx && dz) {
          if (!nav.free[cellIndex(nav, ix + dx, iz)] || !nav.free[cellIndex(nav, ix, iz + dz)]) continue;
        }
        seen[to] = 1;
        q.push(to);
      }
    }
  }
  return seen;
}

function nearestCellRaw(layout, nav, point, reach = 0.8) {
  const ix0 = Math.max(0, Math.floor((point[0] - reach) / nav.gridM - 0.5));
  const ix1 = Math.min(nav.nx - 1, Math.ceil((point[0] + reach) / nav.gridM - 0.5));
  const iz0 = Math.max(0, Math.floor((point[1] - reach) / nav.gridM - 0.5));
  const iz1 = Math.min(nav.nz - 1, Math.ceil((point[1] + reach) / nav.gridM - 0.5));
  let best = null;
  let bestD = Infinity;
  for (let iz = iz0; iz <= iz1; iz += 1) {
    for (let ix = ix0; ix <= ix1; ix += 1) {
      const id = cellIndex(nav, ix, iz);
      if (!nav.free[id]) continue;
      const q = [(ix + 0.5) * nav.gridM, (iz + 0.5) * nav.gridM];
      const d = dist(point, q);
      if (d < bestD) { bestD = d; best = id; }
    }
  }
  return best;
}

function doorFailure(layout, nav, sources) {
  const seen = bfsComponent(nav, sources);
  const causes = [
    ...nav.narrowDoors.map((d) => ({ ...d, reason: ROUTE_REASON.DOOR_TOO_NARROW })),
    ...nav.blockedDoors.map((d) => ({ ...d, reason: ROUTE_REASON.DOOR_BLOCKED })),
  ];
  for (const d of causes) {
    const a = nearestCellRaw(layout, nav, d.sides[0]);
    const b = nearestCellRaw(layout, nav, d.sides[1]);
    if (a == null || b == null) continue;
    if (!!seen[a] !== !!seen[b]) {
      return { reason: d.reason, door: d };
    }
  }
  return null;
}

function findLeg(layout, nav, from, to, opts) {
  if (segmentWalkable(layout, from, to, opts)) {
    return { ok: true, points: [from.slice(), to.slice()] };
  }
  const sources = nearestFreeCells(layout, nav, from, opts);
  if (!sources.length) return { ok: false, reason: ROUTE_REASON.ANCHOR_BLOCKED, anchorSide: 'from' };
  const targets = nearestFreeCells(layout, nav, to, opts);
  if (!targets.length) return { ok: false, reason: ROUTE_REASON.ANCHOR_BLOCKED, anchorSide: 'to' };
  const targetIds = new Set(targets.map((t) => t.id));
  const total = nav.n + nav.portals.length;
  const best = new Float64Array(total);
  best.fill(Infinity);
  const came = new Int32Array(total);
  came.fill(-1);
  const closed = new Uint8Array(total);
  const heap = new MinHeap();
  for (const s of sources) {
    if (s.cost < best[s.id]) {
      best[s.id] = s.cost;
      heap.push({ id: s.id, g: s.cost, h: dist(s.q, to), f: s.cost + dist(s.q, to) });
    }
  }
  let goalId = -1;
  while (heap.size) {
    const cur = heap.pop();
    if (closed[cur.id]) continue;
    closed[cur.id] = 1;
    if (targetIds.has(cur.id)) { goalId = cur.id; break; }
    const p = nodePos(nav, cur.id);
    for (const edge of nodeNeighbors(nav, cur.id)) {
      if (closed[edge.to]) continue;
      const ng = best[cur.id] + edge.cost;
      if (ng < best[edge.to] - 1e-12) {
        best[edge.to] = ng;
        came[edge.to] = cur.id;
        const q = nodePos(nav, edge.to);
        const h = dist(q, to);
        heap.push({ id: edge.to, g: ng, h, f: ng + h });
      }
    }
  }
  if (goalId < 0) {
    const cause = doorFailure(layout, nav, sources);
    if (cause) {
      const message = cause.reason === ROUTE_REASON.DOOR_TOO_NARROW
        ? `门净宽 ${cause.door.width.toFixed(2)} m，人（含余量）过不去；至少需要 ${cause.door.need.toFixed(2)} m`
        : '门两侧被墙/设备挡住了，动线过不去';
      return { ok: false, reason: cause.reason, message };
    }
    return { ok: false, reason: ROUTE_REASON.UNREACHABLE };
  }
  const chain = [];
  let cur = goalId;
  while (cur >= 0) {
    chain.push(cur);
    cur = came[cur];
  }
  chain.reverse();
  const pts = [from.slice(), ...chain.map((id) => nodePos(nav, id)), to.slice()];
  const deduped = [];
  for (const p of pts) {
    const last = deduped[deduped.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1e-9) deduped.push(p);
  }
  return { ok: true, points: deduped };
}

function smoothPath(layout, raw, opts) {
  if (raw.length <= 2) return raw;
  const out = [raw[0]];
  let i = 0;
  while (i < raw.length - 1) {
    let j = raw.length - 1;
    while (j > i + 1 && !segmentWalkable(layout, raw[i], raw[j], opts)) j -= 1;
    if (j === i + 1 && !segmentWalkable(layout, raw[i], raw[j], opts)) return raw;
    out.push(raw[j]);
    i = j;
  }
  for (let k = 0; k + 1 < out.length; k += 1) {
    if (!segmentWalkable(layout, out[k], out[k + 1], opts)) return raw;
  }
  return out;
}

function blocked(route, reason, message, extra = {}) {
  return {
    ok: false, status: 'blocked', routeId: route?.id ?? null,
    points: Array.isArray(route?.points) ? route.points.map((p) => (pointOf(p) ? p.slice() : p)) : [],
    legs: [], length: 0, reason, message, ...extra,
  };
}

function validAnchors(route, layout) {
  const points = Array.isArray(route?.points) ? route.points : null;
  if (!points) return { ok: false, reason: ROUTE_REASON.BAD_ROUTE, message: '动线缺少 points' };
  if (points.length < 2) return { ok: false, reason: ROUTE_REASON.BAD_ROUTE, message: '动线至少需要 2 个用户点' };
  if (points.length > cfg.route.maxPoints) {
    return { ok: false, reason: ROUTE_REASON.BAD_ROUTE, message: `动线最多 ${cfg.route.maxPoints} 个用户点（收到 ${points.length} 个）` };
  }
  if (!points.every(pointOf)) return { ok: false, reason: ROUTE_REASON.BAD_ROUTE, message: '动线坐标不合法（需要有限数字）' };
  for (let i = 0; i < points.length; i += 1) {
    if (!routePointInScene(layout, points[i])) {
      return { ok: false, reason: ROUTE_REASON.POINT_OUT_OF_SCENE, message: `动线第 ${i + 1} 个拐点跑到场景外了`, pointIndex: i };
    }
  }
  for (let i = 0; i + 1 < points.length; i += 1) {
    if (dist(points[i], points[i + 1]) < cfg.route.minAnchorGapM - EPS) {
      return { ok: false, reason: ROUTE_REASON.BAD_ROUTE, message: `动线第 ${i + 1}、${i + 2} 个拐点太近（< ${cfg.route.minAnchorGapM} m）` };
    }
  }
  return { ok: true, points };
}

/**
 * 规划一条动线。返回普通对象；失败时 status='blocked' 且**不返回半条假路**。
 * @returns {{ok:boolean,status:'ok'|'blocked',routeId:number|null,points:Array,
 *   legs:Array<{fromIndex:number,toIndex:number,points:Array,length:number}>,
 *   length:number,reason:string|null,message:string|null,legIndex?:number,anchorIndex?:number,pointIndex?:number}}
 */
export function planRoute(layout, route, opts = {}) {
  if (!layout || !Array.isArray(layout.walls) || !Array.isArray(layout.items)) {
    return blocked(route, ROUTE_REASON.BAD_ROUTE, '布局缺少 walls/items');
  }
  const valid = validAnchors(route, layout);
  if (!valid.ok) return blocked(route, valid.reason, valid.message, valid);
  const points = valid.points;
  for (let i = 0; i < points.length; i += 1) {
    if (!pointWalkable(layout, points[i], opts)) {
      return blocked(route, ROUTE_REASON.ANCHOR_BLOCKED, `动线第 ${i + 1} 个拐点在墙/设备里或贴边太近`, { anchorIndex: i });
    }
  }
  const nav = getNav(layout, opts);
  if (!nav.ok) return blocked(route, nav.reason, nav.message);
  const legs = [];
  let length = 0;
  for (let i = 0; i + 1 < points.length; i += 1) {
    const r = findLeg(layout, nav, points[i], points[i + 1], opts);
    if (!r.ok) {
      const extra = { legIndex: i };
      if (r.anchorSide) extra.anchorIndex = r.anchorSide === 'from' ? i : i + 1;
      return blocked(route, r.reason, r.message || '这两点之间走不通（被墙/设备挡住，或没有门）', extra);
    }
    const legPoints = smoothPath(layout, r.points, opts);
    let legLength = 0;
    for (let k = 0; k + 1 < legPoints.length; k += 1) legLength += dist(legPoints[k], legPoints[k + 1]);
    legs.push({ fromIndex: i, toIndex: i + 1, points: legPoints, length: legLength });
    length += legLength;
  }
  if (length > cfg.route.maxLengthM) {
    return blocked(route, ROUTE_REASON.ROUTE_TOO_LONG, `动线总长 ${length.toFixed(1)} m，超过 ${cfg.route.maxLengthM} m`, { length });
  }
  return {
    ok: true, status: 'ok', routeId: route?.id ?? null,
    points: points.map((p) => p.slice()), legs, length, reason: null, message: null,
  };
}

/** 规划 layout.routes 全部动线；返回与 routes 等长的结果数组（布局/规则缓存共享） */
export function planRoutes(layout, opts = {}) {
  const routes = Array.isArray(layout?.routes) ? layout.routes : [];
  const max = cfg.route.maxRoutes;
  return routes.map((r, i) => (i < max
    ? planRoute(layout, r, opts)
    : blocked(r, ROUTE_REASON.BAD_ROUTE, `一个方案最多 ${max} 条动线；第 ${i + 1} 条不参与规划`)));
}

/** 便捷读数：能走返回长度（m），走不通返回 null（要原因请用 planRoute） */
export function routeLength(layout, route, opts = {}) {
  const r = planRoute(layout, route, opts);
  return r.ok ? r.length : null;
}

/* ---------------- 场景平移 / 缩场景校验 ---------------- */

/** 场景左/上扩展时平移用户点；不改输入，坐标按毫米取整（与 state 精度一致） */
export function translateRoutes(routes, dx, dz) {
  if (!Array.isArray(routes)) return [];
  return routes.map((r) => ({
    ...r,
    points: Array.isArray(r?.points)
      ? r.points.map((p) => (pointOf(p) ? [roundMm(p[0] + dx), roundMm(p[1] + dz)] : p))
      : [],
  }));
}

/** 缩场景前检查：返回 [{routeIndex, pointIndex}]（0 基），不夹取、不改 layout */
export function routesOutOfBounds(routes, w, d) {
  const out = [];
  if (!Array.isArray(routes)) return out;
  routes.forEach((r, routeIndex) => {
    const points = Array.isArray(r?.points) ? r.points : [];
    points.forEach((p, pointIndex) => {
      if (!pointOf(p) || p[0] < -EPS || p[1] < -EPS || p[0] > w + EPS || p[1] > d + EPS) {
        out.push({ routeIndex, pointIndex });
      }
    });
  });
  return out;
}
