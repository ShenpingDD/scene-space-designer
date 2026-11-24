/**
 * columns.js —— 矩形结构柱（P1 内核，纯函数）
 *
 * 契约见 设计决策记录 §二：
 *   state.columns = [{ id, x, z, w, d }]，位于 walls 之后、items 之前；
 *   x/z 是柱脚中心，w 沿 X、d 沿 Z，单位米，存储 1 mm；高度不存，跟随 layout.h。
 *
 * 柱是**独立结构对象**，不是墙：不进入 rooms.js 的派生，也不进入 wall.openings。
 * 柱与墙允许重叠/嵌墙；柱与柱、设备、门窗洞口不允许相交。
 *
 * 本模块刻意只依赖 params/geometry/wall —— `openings.js` 会反过来做
 * `column-in-opening`，所以这里不能 import openings，避免循环。
 */

import { cfg } from './params.js';
import { pointInPoly, roundMm } from './geometry.js';
import { holeName, openingsOf, wallSeg } from './wall.js';
import { openFacesOf, roomsOf } from './rooms.js';

/** 柱判据的容差：1e-6 m。不要复用 `space.overlapTolM` 的 5 mm。 */
export const COLUMN_EPS = 1e-6;

/** 当前生效的柱参数（始终读活引用，配置改了立即生效）。 */
export function columnCfg() {
  return cfg.column;
}

/** 统一原因码（与 设计决策记录对齐；跨语言只认这些字符串） */
export const COLUMN_REASON = Object.freeze({
  BAD_COLUMN: 'bad-column',
  DUPLICATE_ID: 'duplicate-column-id',
  OUT_OF_SCENE: 'column-out-of-scene',
  TOO_SMALL: 'column-too-small',
  TOO_LARGE: 'column-too-large',
  OVERLAP: 'column-overlap',
  ON_ITEM: 'column-on-item',
  BLOCKS_OPENING: 'column-blocks-opening',
  TOO_MANY: 'too-many-columns',
  LIMIT: 'column-limit',
});

/**
 * 提示文案。与 be-dev 逐字约定，交互 toast 与导入共用同一句（尺寸/上限里的数字用
 * 当前参数值拼，默认配置下与 Java 常量测试一致）。
 */
export const COLUMN_MESSAGE = {
  get BAD_COLUMN() { return '柱数据不合法（每条柱需要 id 与 x/z/w/d）'; },
  get DUPLICATE_ID() { return '柱编号重复'; },
  get OUT_OF_SCENE() { return '柱必须完整在场景内'; },
  get TOO_SMALL() { return `柱边长小于下限（${columnCfg().minSideM} m）`; },
  get TOO_LARGE() { return `柱边长超过上限（${columnCfg().maxSideM.toFixed(2)} m）`; },
  get TOO_MANY() { return `柱数量超过上限（${columnCfg().maxCount} 根）`; },
  get LIMIT() { return this.TOO_MANY; },
  OVERLAP(id) { return `与柱 #${id} 重叠；柱与柱不能相交`; },
  ON_ITEM(id) { return `压到设备 #${id}；请先挪开设备`; },
  BLOCKS_OPENING(wallIndex, kind) {
    return `压住了墙 #${wallIndex + 1} 的${holeName(kind)}；柱不能进入洞口区间`;
  },
  IN_OPENING(id) { return `洞口压到柱 #${id}；请先挪开柱`; },
};

/** 布局里的柱清单：缺省恒为空数组（旧方案没有这个字段）。 */
export function columnsOf(layout) {
  return Array.isArray(layout && layout.columns) ? layout.columns : [];
}

/** 一根柱的**写入形状**：只保留 id → x → z → w → d，顺序固定。 */
export function cloneColumn(c) {
  return { id: c.id, x: c.x, z: c.z, w: c.w, d: c.d };
}

/**
 * 读一根柱（导入边界）：结构不合法返回 `null`；合法值按 1 mm 归一化。
 * 关系合法性不在这里判 —— 由 {@link checkColumn} 负责。
 *
 * @returns {{id:number,x:number,z:number,w:number,d:number}|null}
 */
export function readColumn(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { id, x, z, w, d } = raw;
  if (!Number.isInteger(id) || id < 1) return null;
  if (![x, z, w, d].every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  return { id, x: roundMm(x), z: roundMm(z), w: roundMm(w), d: roundMm(d) };
}

/** 柱的轴对齐包围盒（米）。 */
export function columnRect(c) {
  const hw = c.w / 2;
  const hd = c.d / 2;
  return {
    x0: c.x - hw,
    z0: c.z - hd,
    x1: c.x + hw,
    z1: c.z + hd,
    cx: c.x,
    cz: c.z,
    w: c.w,
    d: c.d,
  };
}

/** 四角，顺序：左下 → 右下 → 右上 → 左上（[x,z]）。 */
export function columnCorners(c) {
  const r = columnRect(c);
  return [[r.x0, r.z0], [r.x1, r.z0], [r.x1, r.z1], [r.x0, r.z1]];
}

/** 柱脚面积（m²）。 */
export function columnArea(c) {
  return c.w * c.d;
}

/** 柱脚面积总和；接受 layout 或 columns 数组。 */
export function columnAreaTotal(layoutOrColumns) {
  const list = Array.isArray(layoutOrColumns) ? layoutOrColumns : columnsOf(layoutOrColumns);
  return list.reduce((sum, c) => sum + columnArea(c), 0);
}

/** 下一根柱的 id：`max(columns.id)+1`，不建独立计数器。 */
export function columnNextId(layout) {
  return columnsOf(layout).reduce((max, c) => Math.max(max, c.id), 0) + 1;
}

/** 点是否落在某根柱的脚印内（含边界）。 */
export function columnAt(layout, x, z) {
  for (const c of columnsOf(layout)) {
    const r = columnRect(c);
    if (x >= r.x0 - COLUMN_EPS && x <= r.x1 + COLUMN_EPS
      && z >= r.z0 - COLUMN_EPS && z <= r.z1 + COLUMN_EPS) return c;
  }
  return null;
}

/** 与矩形 `{x0,z0,x1,z1}` 相交的柱（用于框选/范围查询）。 */
export function columnsInRect(layout, rect) {
  const r = normalizeRect(rect);
  return columnsOf(layout).filter((c) => rectsOverlap(columnRect(c), r, 0));
}

/** 平移一组柱（扩/缩场景用），保持 1 mm 精度。 */
export function shiftColumns(columns, dx, dz) {
  return columns.map((c) => ({
    id: c.id,
    x: roundMm(c.x + dx),
    z: roundMm(c.z + dz),
    w: c.w,
    d: c.d,
  }));
}

/** 越界柱清单（0 基 index + id），给扩/缩场景的错误信息用。 */
export function columnsOutOfBounds(layoutOrColumns, w, d) {
  const list = Array.isArray(layoutOrColumns) ? layoutOrColumns : columnsOf(layoutOrColumns);
  const width = w === undefined ? (layoutOrColumns && layoutOrColumns.w) : w;
  const depth = d === undefined ? (layoutOrColumns && layoutOrColumns.d) : d;
  const out = [];
  if (!Number.isFinite(width) || !Number.isFinite(depth)) return out;
  list.forEach((c, index) => {
    const r = columnRect(c);
    if (r.x0 < -COLUMN_EPS || r.z0 < -COLUMN_EPS
      || r.x1 > width + COLUMN_EPS || r.z1 > depth + COLUMN_EPS) {
      out.push({ index, id: c.id });
    }
  });
  return out;
}

/**
 * 柱合法性：边界 / 尺寸 / 数量 / 柱-柱 / 柱-设备 / 柱-洞口。
 * 柱-墙**允许**，这里不产生任何 `wall` 冲突。
 *
 * @param {object} layout 现有布局（w/d/columns/walls/items）
 * @param {object} raw 待检查柱
 * @param {{ignoreId?:number|null, getProduct?:Function|null, relations?:boolean}} [opts]
 * @returns {{ok:true,column:object}|{ok:false,reason:string,message:string}}
 */
export function checkColumn(layout, raw, opts = {}) {
  const col = readColumn(raw);
  if (!col) return fail(COLUMN_REASON.BAD_COLUMN, COLUMN_MESSAGE.BAD_COLUMN);
  if (!layout || typeof layout !== 'object') return fail(COLUMN_REASON.OUT_OF_SCENE, COLUMN_MESSAGE.OUT_OF_SCENE);

  const cfgC = columnCfg();
  const existing = columnsOf(layout);
  const ignoreId = opts.ignoreId === undefined ? null : opts.ignoreId;
  const isExisting = existing.some((c) => c.id === col.id && c.id !== ignoreId);

  if (isExisting) return fail(COLUMN_REASON.DUPLICATE_ID, COLUMN_MESSAGE.DUPLICATE_ID);
  if (!isExisting && existing.length >= cfgC.maxCount) {
    return fail(COLUMN_REASON.LIMIT, COLUMN_MESSAGE.LIMIT);
  }

  if (col.w < cfgC.minSideM - COLUMN_EPS || col.d < cfgC.minSideM - COLUMN_EPS) {
    return fail(COLUMN_REASON.TOO_SMALL, COLUMN_MESSAGE.TOO_SMALL);
  }
  if (col.w > cfgC.maxSideM + COLUMN_EPS || col.d > cfgC.maxSideM + COLUMN_EPS) {
    return fail(COLUMN_REASON.TOO_LARGE, COLUMN_MESSAGE.TOO_LARGE);
  }

  const rect = columnRect(col);
  const w = Number(layout.w);
  const d = Number(layout.d);
  if (rect.x0 < -COLUMN_EPS || rect.z0 < -COLUMN_EPS
    || rect.x1 > w + COLUMN_EPS || rect.z1 > d + COLUMN_EPS) {
    return fail(COLUMN_REASON.OUT_OF_SCENE, COLUMN_MESSAGE.OUT_OF_SCENE);
  }

  if (opts.relations === false) return { ok: true, column: col };

  for (const other of existing) {
    if (other.id === col.id || other.id === ignoreId) continue;
    if (rectsOverlap(rect, columnRect(other), COLUMN_EPS)) {
      return fail(COLUMN_REASON.OVERLAP, COLUMN_MESSAGE.OVERLAP(other.id));
    }
  }

  const getProduct = opts.getProduct;
  if (typeof getProduct === 'function' && Array.isArray(layout.items)) {
    for (const item of layout.items) {
      const product = getProduct(item.p);
      if (!product) continue;
      if (convexOverlap(rectCorners(rect), itemCorners(item, product), COLUMN_EPS)) {
        return fail(COLUMN_REASON.ON_ITEM, COLUMN_MESSAGE.ON_ITEM(item.id));
      }
    }
  }

  if (Array.isArray(layout.walls)) {
    for (let wi = 0; wi < layout.walls.length; wi += 1) {
      const wall = layout.walls[wi];
      for (const opening of openingsOf(wall)) {
        if (convexOverlap(rectCorners(rect), openingCorners(wall, opening), COLUMN_EPS)) {
          return fail(
            COLUMN_REASON.BLOCKS_OPENING,
            COLUMN_MESSAGE.BLOCKS_OPENING(wi, opening.kind),
          );
        }
      }
    }
  }

  return { ok: true, column: col };
}

/**
 * 某面墙上的一个洞口压到了哪些柱（门窗新增/改宽的反向检查）。
 * 放在 columns.js 的叶子层，`openings.js` 可以 import 它而不会形成循环。
 *
 * @returns {Array<{id:number,x:number,z:number,w:number,d:number}>}
 */
export function columnsAtOpening(layout, wall, opening) {
  if (!wall || !opening || !Number.isFinite(opening.at) || !Number.isFinite(opening.w)) return [];
  const box = openingCorners(wall, opening);
  return columnsOf(layout).filter((c) => convexOverlap(columnCorners(c), box, COLUMN_EPS));
}

/**
 * 读 `state.columns`（导入边界）：**结构/边界/尺寸/编号**不合法就整份拒绝；
 * 柱-柱/设备/洞口关系冲突**宽容**（设计决策记录：导入不因关系冲突打不开）。
 *
 * @returns {{ok:true,columns:Array}|{ok:false,reason:string,message:string}}
 */
export function readColumns(raw, { w, d, getProduct = null } = {}) {
  if (raw === undefined || raw === null) return { ok: true, columns: [] };
  if (!Array.isArray(raw)) return fail(COLUMN_REASON.BAD_COLUMN, COLUMN_MESSAGE.BAD_COLUMN);
  if (raw.length > columnCfg().maxCount) return fail(COLUMN_REASON.TOO_MANY, COLUMN_MESSAGE.TOO_MANY);

  const out = [];
  const seen = new Set();
  for (const value of raw) {
    const col = readColumn(value);
    if (!col) return fail(COLUMN_REASON.BAD_COLUMN, COLUMN_MESSAGE.BAD_COLUMN);
    if (seen.has(col.id)) return fail(COLUMN_REASON.DUPLICATE_ID, COLUMN_MESSAGE.DUPLICATE_ID);
    const probe = {
      w, d,
      walls: [],
      items: [],
      columns: out,
    };
    const checked = checkColumn(probe, col, { relations: false, getProduct });
    if (!checked.ok) return checked;
    seen.add(col.id);
    out.push(col);
  }
  return { ok: true, columns: out };
}

/**
 * 面积：房间面积不变，只扣「整个脚印都落在同一房间面内」的柱。
 *
 * 不能只看四角：L 形凹口、带洞（嵌套房间/开放面）时，四角可能都在面内而边/洞穿过去。
 * 这里做三件事：四角在面内、柱边与面边界**没有真正穿越**、与 holes 不相交。
 *
 * @param {{poly:Array,area?:number, holes?:Array}} room
 * @param {Array} columns
 */
export function usableAreaOf(room, columns) {
  const area = Number.isFinite(room.area) ? room.area : Math.abs(polyArea(room.poly || []));
  let deducted = 0;
  for (const c of columns || []) {
    if (!rectInsidePoly(columnCorners(c), room.poly || [], room.holes || [])) continue;
    deducted += columnArea(c);
  }
  return Math.max(0, area - deducted);
}

/**
 * 全场景面积读数：房间面积不变，`usableArea` 另算；跨墙/跨面/叠洞的柱单列到 onBoundary。
 *
 * `roomsOf` 只公开外圈 `poly`，内部 holes 不公开 —— 所以这里用**面积更小的嵌套面**
 * （房间/开放面）反推 holes，再交给 `usableAreaOf`。这样不需要改 rooms.js 的公开形状。
 */
export function usableAreaSummary(layout) {
  const cols = columnsOf(layout);
  const rooms = roomsOf(layout).map((r, i) => ({
    kind: 'room', id: r.id, key: `room:${r.id}:${i}`, poly: r.poly,
    area: r.area, centroid: r.centroid, labelAt: r.labelAt,
  }));
  const opens = openFacesOf(layout).map((f, i) => ({
    kind: 'open', id: `open-${i + 1}`, key: `open:${i}`, poly: f.poly,
    area: f.area, centroid: f.centroid, labelAt: f.labelAt,
  }));
  const all = [...rooms, ...opens];

  const entries = all.map((face) => {
    // 只把“完全落在本面内、面积更小”的面当洞；相邻面形心不会落在本面内。
    const holes = all
      .filter((other) => other.key !== face.key
        && other.area < face.area - COLUMN_EPS
        && pointInPoly(face.poly, other.centroid || other.poly[0], COLUMN_EPS * 10))
      .map((other) => other.poly);
    const inside = cols.filter((c) => rectInsidePoly(columnCorners(c), face.poly, holes));
    const deductedArea = inside.reduce((sum, c) => sum + columnArea(c), 0);
    return {
      kind: face.kind, id: face.id,
      area: face.area,
      usableArea: Math.max(0, face.area - deductedArea),
      deductedArea,
      columnIds: inside.map((c) => c.id),
    };
  });

  const columnTotal = columnAreaTotal(cols);
  const roomEntries = entries.filter((e) => e.kind === 'room');
  const openEntries = entries.filter((e) => e.kind === 'open');
  const inRooms = roomEntries.reduce((s, e) => s + e.deductedArea, 0);
  const inOpen = openEntries.reduce((s, e) => s + e.deductedArea, 0);
  const onBoundary = Math.max(0, columnTotal - inRooms - inOpen);
  return {
    rooms: roomEntries,
    open: openEntries,
    columnAreaTotal: columnTotal,
    columnAreaInRooms: inRooms,
    columnAreaInOpen: inOpen,
    columnAreaOnBoundary: onBoundary,
  };
}

/** `usableArea` 的语义别名（给调用方更短的入口；返回的是整份 summary）。 */
export function usableArea(layout) {
  return usableAreaSummary(layout);
}

/** 跨墙/跨面/跨洞的柱面积（设计决策记录的守恒项）。 */
export function columnAreaOnBoundary(layout) {
  return usableAreaSummary(layout).columnAreaOnBoundary;
}

/** 2D 几何：柱层只吃这一份，模板不自己算矩形。 */
export function columns2d(layout) {
  return columnsOf(layout).map((c) => {
    const r = columnRect(c);
    const dPath = `M${fmt(r.x0)} ${fmt(r.z0)} L${fmt(r.x1)} ${fmt(r.z0)} L${fmt(r.x1)} ${fmt(r.z1)} L${fmt(r.x0)} ${fmt(r.z1)} Z`;
    return {
      id: c.id, x: c.x, z: c.z, w: c.w, d: c.d,
      x0: r.x0, z0: r.z0, x1: r.x1, z1: r.z1,
      cx: r.cx, cz: r.cz, dPath,
    };
  });
}

function fail(reason, message) {
  return { ok: false, reason, message };
}

function normalizeRect(r) {
  return {
    x0: Math.min(r.x0, r.x1),
    z0: Math.min(r.z0, r.z1),
    x1: Math.max(r.x0, r.x1),
    z1: Math.max(r.z0, r.z1),
  };
}

/** 闭矩形相交；间隙 0 视为不相交（容差内的接触合法）。 */
function rectsOverlap(a, b, tol) {
  return a.x0 < b.x1 - tol && b.x0 < a.x1 - tol
    && a.z0 < b.z1 - tol && b.z0 < a.z1 - tol;
}

function rectCorners(r) {
  return [[r.x0, r.z0], [r.x1, r.z0], [r.x1, r.z1], [r.x0, r.z1]];
}

/** 设备 OBB 四角（设备角度是度，与 geometry.corners 同口径）。 */
function itemCorners(item, product) {
  const hw = product.w / 2;
  const hd = product.d / 2;
  const rad = (Number(item.r) || 0) * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([x, z]) => [
    item.x + x * cos - z * sin,
    item.z + x * sin + z * cos,
  ]);
}

/** 门/窗洞口在墙厚方向上的矩形四角。 */
function openingCorners(wall, opening) {
  const [ax, az, bx, bz] = wallSeg(wall);
  const len = Math.hypot(bx - ax, bz - az);
  if (len < COLUMN_EPS) return [[ax, az], [ax, az], [ax, az], [ax, az]];
  const ux = (bx - ax) / len;
  const uz = (bz - az) / len;
  const nx = -uz;
  const nz = ux;
  const halfW = opening.w / 2;
  const halfT = (cfg.space.wallThicknessM || 0.12) / 2;
  const cx = ax + ux * opening.at;
  const cz = az + uz * opening.at;
  const corners = [
    [cx - ux * halfW - nx * halfT, cz - uz * halfW - nz * halfT],
    [cx + ux * halfW - nx * halfT, cz + uz * halfW - nz * halfT],
    [cx + ux * halfW + nx * halfT, cz + uz * halfW + nz * halfT],
    [cx - ux * halfW + nx * halfT, cz - uz * halfW + nz * halfT],
  ];
  return corners;
}

/**
 * 两个凸多边形是否相交（SAT）；接触/间隙 0 不算相交。
 * 只用于柱-设备/柱-洞口，不依赖 geometry.overlap 的 5 mm 设备容差。
 */
function convexOverlap(a, b, tol) {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i += 1) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      const nx = q[1] - p[1];
      const nz = p[0] - q[0];
      let minA = Infinity; let maxA = -Infinity;
      let minB = Infinity; let maxB = -Infinity;
      for (const [x, z] of a) { const v = x * nx + z * nz; if (v < minA) minA = v; if (v > maxA) maxA = v; }
      for (const [x, z] of b) { const v = x * nx + z * nz; if (v < minB) minB = v; if (v > maxB) maxB = v; }
      if (maxA <= minB + tol || maxB <= minA + tol) return false;
    }
  }
  return true;
}

function rectCornersInside(corners, poly, holes) {
  if (!poly.length) return false;
  for (const p of corners) if (!pointInPoly(poly, p, COLUMN_EPS)) return false;
  return holes.length === 0;
}

/** 完整判据：四角在面内 + 柱边不穿越面边界 + 不与 holes 相交。 */
function rectInsidePoly(corners, poly, holes) {
  if (!poly.length) return false;
  for (const p of corners) if (!pointInPoly(poly, p, COLUMN_EPS)) return false;
  for (let i = 0; i < 4; i += 1) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    for (let j = 0; j < poly.length; j += 1) {
      const c = poly[j];
      const e = poly[(j + 1) % poly.length];
      if (properCross(a[0], a[1], b[0], b[1], c[0], c[1], e[0], e[1])) return false;
    }
  }
  for (const hole of holes || []) {
    if (rectTouchesPoly(corners, hole)) return false;
  }
  return true;
}

/** 柱边与多边形边是否有“真正穿越”（端点/共线不算；四角在面内负责端点情形）。 */
function properCross(ax, az, bx, bz, cx, cz, dx, dz) {
  const o = (px, pz, qx, qz, rx, rz) => (qx - px) * (rz - pz) - (qz - pz) * (rx - px);
  const o1 = o(ax, az, bx, bz, cx, cz);
  const o2 = o(ax, az, bx, bz, dx, dz);
  const o3 = o(cx, cz, dx, dz, ax, az);
  const o4 = o(cx, cz, dx, dz, bx, bz);
  return ((o1 > COLUMN_EPS && o2 < -COLUMN_EPS) || (o1 < -COLUMN_EPS && o2 > COLUMN_EPS))
    && ((o3 > COLUMN_EPS && o4 < -COLUMN_EPS) || (o3 < -COLUMN_EPS && o4 > COLUMN_EPS));
}

function pointInRect(p, r) {
  return p[0] >= r.x0 - COLUMN_EPS && p[0] <= r.x1 + COLUMN_EPS
    && p[1] >= r.z0 - COLUMN_EPS && p[1] <= r.z1 + COLUMN_EPS;
}

function rectTouchesPoly(corners, poly) {
  const r = {
    x0: Math.min(...corners.map((p) => p[0])),
    z0: Math.min(...corners.map((p) => p[1])),
    x1: Math.max(...corners.map((p) => p[0])),
    z1: Math.max(...corners.map((p) => p[1])),
  };
  for (const p of poly) if (pointInRect(p, r)) return true;
  for (const p of corners) if (pointInPoly(poly, p, COLUMN_EPS)) return true;
  for (let i = 0; i < 4; i += 1) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    for (let j = 0; j < poly.length; j += 1) {
      const c = poly[j];
      const d = poly[(j + 1) % poly.length];
      if (properCross(a[0], a[1], b[0], b[1], c[0], c[1], d[0], d[1])) return true;
    }
  }
  return false;
}

function polyArea(poly) {
  let s = 0;
  for (let i = 0; i < poly.length; i += 1) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a[0] * b[1] - b[0] * a[1];
  }
  return s / 2;
}

function fmt(n) {
  return Number(n.toFixed(6)).toString();
}
