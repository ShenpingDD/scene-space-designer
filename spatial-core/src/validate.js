/**
 * validate.js —— 规则 1：这台设备摆在这个位置合法吗（纯函数）
 *
 * 来源：原型 `invalid()`（含 R1 的 FIX-04：外墙不再是障碍物）。
 * 这是全项目最核心的一条规则：原型的 2D 面板校验、漫游碰撞、导入校验各写了一份，
 * 三份互相打架 —— R2 起**只有这一份**，前端/服务端都调它。
 *
 * 与原型唯一的差异（纯增强，不改变判定结果）：
 *   原型只返回 true/false；这里返回 **原因码**，供 UI 精准提示与 FIX-21 的错误分型。
 */

import { corners, overlap, wallBox } from './geometry.js';
import { columnCorners, columnsOf, COLUMN_EPS } from './columns.js';
import { wallRole } from './room.js';
import { wallSeg, EXTERIOR } from './wall.js';

/** 原因码 */
export const REASON = {
  OK: null,
  UNKNOWN_PRODUCT: 'unknown-product',
  OUT_OF_ROOM: 'out-of-room',
  OVERLAP_ITEM: 'overlap-item',
  HIT_WALL: 'hit-wall',
  HIT_COLUMN: 'hit-column',
};

/** 墙的原因码（B19）。墙不是设备，所以单开一组 —— 混进 REASON 里会让"某台设备为什么放不下"多出几种不可能的原因 */
export const WALL_REASON = {
  OK: null,
  WALL_OUT_OF_ROOM: 'wall-out-of-room',
};

/**
 * 单台设备的合法性检查。
 * @param {object} layout {w,d,h,walls,items}
 * @param {object} item {id,p,x,z,r,doorAmount}
 * @param {(id:string)=>object|undefined} getProduct 型号目录查找（w/d 为**占地包络**，米）
 * @returns {null|string} null = 合法；否则原因码（OVERLAP_ITEM 会带 `#<对方id>`）
 */
export function checkItem(layout, item, getProduct) {
  const p = getProduct(item.p);
  if (!p) return REASON.UNKNOWN_PRODUCT;

  const a = corners(item.x, item.z, p.w, p.d, item.r);

  // ① 四角必须都在房间内（越界由这条兜住；外墙因此无需再当障碍物 —— FIX-04）
  if (a.some(([x, z]) => x < 0 || x > layout.w || z < 0 || z > layout.d)) return REASON.OUT_OF_ROOM;

  // ② 与其它设备重叠（标准品按占地矩形做 OBB 相交）
  for (const j of layout.items) {
    if (j.id === item.id) continue;
    const q = getProduct(j.p);
    if (!q) continue;
    if (overlap(a, corners(j.x, j.z, q.w, q.d, j.r))) return `${REASON.OVERLAP_ITEM}#${j.id}`;
  }

  // ③ 碰内墙（外墙跳过：它界定场景边界，不是障碍物 —— FIX-04；P1 起按**角色**判，不按几何猜）
  for (const wall of layout.walls) {
    if (wallRole(layout, wall) === EXTERIOR) continue;
    if (overlap(a, wallBox(wall))) return REASON.HIT_WALL;
  }

  // ④ 压结构柱（硬障碍；柱-墙允许，柱-设备不允许）。1e-6 容差：贴边合法，不沿用 5 mm 设备容差。
  for (const c of columnsOf(layout)) {
    if (overlap(a, columnCorners(c), COLUMN_EPS)) return `${REASON.HIT_COLUMN}#${c.id}`;
  }

  return REASON.OK;
}

/** 是否合法（原型的 invalid() 取反） */
export function isValid(layout, item, getProduct) {
  return checkItem(layout, item, getProduct) === REASON.OK;
}

/** 原型的 invalid()：true = 非法 */
export function isInvalid(layout, item, getProduct) {
  return checkItem(layout, item, getProduct) !== REASON.OK;
}

/**
 * 全量体检：返回非法设备清单及原因。
 * 原型只有计数（`state.items.filter(invalid).length`），这里带上原因码，供新 UI 精准提示。
 */
export function checkAll(layout, getProduct) {
  const bad = [];
  for (const item of layout.items) {
    const reason = checkItem(layout, item, getProduct);
    if (reason) bad.push({ id: item.id, product: item.p, reason });
  }
  return bad;
}

/**
 * 一面墙的合法性：**两个端点都必须落在整栋范围内**（B19）。
 *
 * 外墙与内墙走**同一条判据**，区别只有一个几何容差：
 *  · 外墙的坐标本来就**恰好**是 0 / w / d，浮点会让它差 1e-16 → 给它 1e-6 的容差；
 *  · 内墙不留容差（`< 0 || > w`）：贴边合法，探出去不合法。
 *
 * ⚠️ 2026-10-09（M1a）**就地改正**：原来外墙是**整条跳过**的，于是"贴着外墙那条线、
 * 但一头戳出整栋"的墙会被判合法 —— 而导出文件再导入时，读取端（`wallOut`）会拒它，
 * 正好是 FIX-05 的形状（写读两套规则）。现在写端与读端调的是**同一个函数**。
 * 起因是一条判据变红（`rooms.test.js`「合法外墙不许误报」），不是"顺手改的"。
 * @returns {null|string} null = 合法
 */
export function checkWall(layout, wall) {
  const tol = wallRole(layout, wall) === EXTERIOR ? 1e-6 : 0;
  const out = (v, hi) => v < -tol || v > hi + tol;
  const [x, z, xx, zz] = wallSeg(wall);
  return (out(x, layout.w) || out(z, layout.d) || out(xx, layout.w) || out(zz, layout.d))
    ? WALL_REASON.WALL_OUT_OF_ROOM
    : WALL_REASON.OK;
}

/** 全量墙体检。返回 `{index, reason}` 清单 —— 墙没有 id，用**序号**（与 2D/3D 的 data-wall-index 同一套编号） */
export function checkAllWalls(layout) {
  const bad = [];
  layout.walls.forEach((wall, index) => {
    const reason = checkWall(layout, wall);
    if (reason) bad.push({ index, reason });
  });
  return bad;
}

/** 状态栏文案（口径与原型一致：有非法设备则报数量，否则"布局已就绪"） */
export function statusText(layout, getProduct) {
  const bad = checkAll(layout, getProduct);
  return bad.length
    ? `${bad.length} 台设备存在重叠、碰墙或超出空间`
    : '布局已就绪 · 未发现设备重叠';
}