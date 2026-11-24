/**
 * clearance.js —— 规则 7：开门净空（纯函数）
 *
 * 来源：`docs/13-p1-seam-decisions.md` 的接缝 A 决策 = **A3**：
 *   算出"实际可开角度"、分两级提示、**不阻断放置**。
 *
 * 为什么单独一条规则：`validate.checkItem()` 判的是**放不放得下**（越界 / 占地重叠 / 压内墙），
 * 而设计器真正要回答客户的问题是**这么摆能不能用** —— 门打不开的柜子等于不能用的柜子。
 * 所以这里**不动 invalid()**，只并列算"每台设备最多能开多少度"（见 docs/13 §定完之后）。
 *
 * 数据来源：门几何全部是**实测**的（R3-7：铰链位置 / 扫掠半径 / 门板轮廓，
 * `app/src/data/doors.measured.js` ← `tools/models/verify-models.py`）；R4 起由 `product_model` 表供数。
 * 门板绕铰链自转扫掠（绕 +Y，与 three.js 同一约定 —— R3-7 已用三维节点世界坐标逐位验证，0 mm）。
 * 上盖（`axis !== 'y'`）不参与平面净空：它往**竖直**方向扫，平面上本来就不占地方 → level `n/a`。
 *
 * ⚠️ 扫掠分辨率 1°：`freeDeg` 是整数度。**Java 侧必须用同一个步长**，否则两边数字对不上。
 */

import { cfg } from './params.js';
import { corners, overlap, wallBox, segmentDistance, DEG } from './geometry.js';
import { isBoundaryWall } from './room.js';
import { mkWallSeg } from './wall.js';
import { wallSolidSegments } from './openings.js';

// 参数见 params.js（原常量 OPEN_OK_DEG）：cfg.door.openOkDeg
// 参数见 params.js（原常量 OPEN_BAD_DEG）：cfg.door.openWarnDeg
// 参数见 params.js（原常量 SWEEP_STEP_DEG）：cfg.door.sweepStepDeg
// 参数见 params.js（原常量 FREE_TOL_DEG）：cfg.door.freeTolDeg

/**
 * 门板在**房间坐标系**下的 4 个角点。
 * ① 先绕铰链自转 openDeg（three.js 绕 +Y：局部 (x,z) → (x·cosθ + z·sinθ, −x·sinθ + z·cosθ)）
 * ② 再按设备朝向转到房间（与 `geometry.corners()` 同一方向，R3-7 与三维对账过）
 * @param {{x:number,z:number,r:number}} item 设备（房间坐标，米）
 * @param {{hinge:{x:number,z:number}, leaf:{x0:number,x1:number,z0:number,z1:number}}} door 门（设备本地，米）
 * @param {number} openDeg 开角（度，带符号）
 */
export function doorPlateAt(item, door, openDeg) {
  const a = openDeg * DEG;
  const ca = Math.cos(a);
  const sa = Math.sin(a);
  const R = item.r * DEG;
  const cr = Math.cos(R);
  const sr = Math.sin(R);
  const { x0, x1, z0, z1 } = door.leaf;
  const hx = door.hinge.x;
  const hz = door.hinge.z;
  return [
    [x0, z0],
    [x1, z0],
    [x1, z1],
    [x0, z1],
  ].map(([x, z]) => {
    const dx = x - hx;
    const dz = z - hz;
    const bx = hx + dx * ca + dz * sa;
    const bz = hz - dx * sa + dz * ca;
    return [item.x + bx * cr - bz * sr, item.z + bx * sr + bz * cr];
  });
}

/** 门板是否出房间（外墙也在这个口径里，和 validate 一致） */
function outOfRoom(plate, room) {
  return plate.some(([x, z]) => x < 0 || z < 0 || x > room.w || z > room.d);
}

/**
 * 某个开角下门板撞到了谁。
 * @returns {null|{kind:'room'|'item'|'wall', id:number|null}}
 */
/**
 * 点到**旋转后的设备占地矩形**的距离（0 = 在矩形内）。粗筛用。
 * 做法：把点反旋转到设备本地坐标（与 corners() 的 +r 互为逆），再按轴对齐矩形算。
 */
export function pointToItem(px, pz, item, product) {
  const dx = px - item.x;
  const dz = pz - item.z;
  const r = item.r * DEG;
  const lx = dx * Math.cos(r) + dz * Math.sin(r);
  const lz = -dx * Math.sin(r) + dz * Math.cos(r);
  const ex = Math.max(Math.abs(lx) - product.w / 2, 0);
  const ez = Math.max(Math.abs(lz) - product.d / 2, 0);
  return Math.hypot(ex, ez);
}

/** 门的铰链在**房间坐标系**下的位置（与 doorPlateAt 同一套变换） */
export function doorHingeAt(item, door) {
  const R = item.r * DEG;
  const cr = Math.cos(R);
  const sr = Math.sin(R);
  const { x: hx, z: hz } = door.hinge;
  return [item.x + hx * cr - hz * sr, item.z + hx * sr + hz * cr];
}

/**
 * 挡不挡。`near` 是**粗筛**结果（可省）：门板上每个点到铰链的距离都不超过 swing，
 * 所以离铰链比 swing + 容差更远的设备/墙，无论门转到哪个角度都碰不到 —— 提前剔掉。
 * 结果与逐台全测**完全一致**（少算的全是不可能命中的），但 100 台时从 2.9 秒降到几十毫秒。
 */
export function plateBlocker(plate, layout, selfId, getProduct, near = null) {
  if (outOfRoom(plate, layout)) return { kind: 'room', id: null };

  for (const other of near?.items ?? layout.items) {
    if (other.id === selfId) continue;
    const p = getProduct(other.p);
    if (!p) continue;
    if (overlap(plate, corners(other.x, other.z, p.w, p.d, other.r))) return { kind: 'item', id: other.id };
  }

  for (const w of near?.walls ?? layout.walls) {
    if (isBoundaryWall(layout, w)) continue; // 外墙 = 房间边界，已由 outOfRoom 覆盖
    // W1 门洞：把"门板扫到墙"拆成**实心子段** —— 扫到洞口（门开着的位置）不算撞墙，
    // 扫到洞口旁边的墙身才算（与漫游碰撞同一口径：成对判据）。
    // 没有门洞的墙 `wallSolidSegments` 返回整段 —— 行为与以前逐字一致。
    for (const s of wallSolidSegments(w)) {
      if (overlap(plate, wallBox(mkWallSeg(s[0], s[1], s[2], s[3])))) return { kind: 'wall', id: null };
    }
  }
  return null;
}

/**
 * 一扇门能不能参与**平面**净空。
 *
 * `axis !== 'y'`（上盖）不是缺陷，是规则边界 → 返回 null（不参与，也不算“缺数据”）。
 * `axis === 'y'` 但缺铰链/门板/扫掠半径/开角，是**门数据不完整** → 返回原因码。
 * 这类门必须排除出扫掠计算：拿 `undefined` 当铰链会抛 TypeError，把整台设备的净空
 * 甚至整个方案的净空全打断。**不补 0、不猜坐标**。
 *
 * @returns {null|'missing-hinge'|'missing-leaf'|'missing-swing'|'missing-angle'}
 */
export function planDoorProblem(door) {
  if (!door || door.axis !== 'y') return null;
  const num = (v) => typeof v === 'number' && Number.isFinite(v);
  if (!door.hinge || !num(door.hinge.x) || !num(door.hinge.z)) return 'missing-hinge';
  if (!door.leaf || !num(door.leaf.x0) || !num(door.leaf.x1) || !num(door.leaf.z0) || !num(door.leaf.z1)) {
    return 'missing-leaf';
  }
  if (!num(door.swing) || door.swing <= 0) return 'missing-swing';
  if (!num(door.openAngleDeg) || door.openAngleDeg === 0) return 'missing-angle';
  return null;
}

/**
 * 一台设备最多能把门开到多少度。
 * @returns {{freeDeg:number|null, maxDeg:number|null, door:string|null, blockedBy:object|null,
 *            unobstructed:boolean, doors:number, skippedDoors:number, skipReason:string|null}}
 *          `freeDeg=null` 表示没有**可参与平面净空**的门（如上盖/无门），或门的实测数据不完整；
 *          `skippedDoors/skipReason` 把“有门但算不了”和“本来就没有门”分开，不静默吞掉。
 */
export function doorFreeAngle(layout, item, getProduct) {
  const product = getProduct(item.p);
  const declared = (product?.doors ?? []).filter((d) => d?.axis === 'y');
  const skipped = declared
    .map((door) => ({ door, reason: planDoorProblem(door) }))
    .filter((x) => x.reason);
  const doors = declared.filter((d) => !planDoorProblem(d));
  const skippedDoors = skipped.length;
  const skipReason = skipped[0]?.reason ?? null;
  if (!doors.length) {
    return {
      freeDeg: null, maxDeg: null, door: null, blockedBy: null,
      unobstructed: false, doors: 0, skippedDoors, skipReason,
    };
  }

  let worst = null;
  for (const door of doors) {
    const maxDeg = Math.abs(door.openAngleDeg);
    const sign = Math.sign(door.openAngleDeg) || 1;
    let freeDeg = 0;
    let blocker = null;

    // ── 粗筛 ──
    // 逐度扫掠是 O(台数² × 度数)：100 台时要 2.9 秒，而平面图每次改动都要重算（要按分级着色），
    // 那就是"看着能用、一上手卡死"。但门板够不着的设备根本不可能被撞到 —— 先剔掉。
    // 判据：门板上每个点到铰链 ≤ swing，所以"到铰链距离 > swing + 容差"的设备一定碰不到。
    const [hx, hz] = doorHingeAt(item, door);
    const reach = door.swing + cfg.space.overlapTolM;
    const near = {
      items: layout.items.filter((o) => {
        if (o.id === item.id) return false;
        const op = getProduct(o.p);
        return op ? pointToItem(hx, hz, o, op) <= reach : false;
      }),
      walls: layout.walls.filter((w) => !isBoundaryWall(layout, w)
        && wallSolidSegments(w).some((s) => segmentDistance(hx, hz, s[0], s[1], s[2], s[3]) <= reach + cfg.space.wallThicknessM)),
    };

    // 从关门位开始往开的方向扫；第一步就被挡 = 0°（连关着都撞，属于摆放问题）
    for (let t = cfg.door.sweepStepDeg; t <= maxDeg + 1e-9; t += cfg.door.sweepStepDeg) {
      const hit = plateBlocker(doorPlateAt(item, door, sign * t), layout, item.id, getProduct, near);
      if (hit) {
        blocker = hit;
        break;
      }
      freeDeg = t;
    }

    const cand = {
      freeDeg, maxDeg, door: door.node, blockedBy: blocker,
      unobstructed: freeDeg >= maxDeg - cfg.door.freeTolDeg,
      doors: doors.length, skippedDoors, skipReason,
    };
    if (!worst || cand.freeDeg < worst.freeDeg) worst = cand;
  }
  return worst;
}

/** 分级：绿灯 ≥90° / 黄灯 60~90° / 红灯 <60°（阈值取自 docs/13 的决策） */
export function clearanceLevel(freeDeg) {
  if (freeDeg === null || freeDeg === undefined) return 'n/a';
  if (freeDeg >= cfg.door.openOkDeg) return 'ok';
  if (freeDeg >= cfg.door.openWarnDeg) return 'warn';
  return 'bad';
}

/** 全屋体检：逐台设备给可开角度（与 validate.checkAll 并列，互不阻断） */
export function clearanceReport(layout, getProduct) {
  return layout.items
    .map((item) => {
      const r = doorFreeAngle(layout, item, getProduct);
      return { id: item.id, product: item.p, ...r, level: clearanceLevel(r.freeDeg) };
    })
    // 无门 / 上盖（本来就不参与）不进体检；**有门但数据不完整**要留一行 n/a，
    // 这样界面能解释“为什么这台没有净空结论”，而不是静默消失。
    .filter((r) => r.freeDeg !== null || r.skippedDoors > 0);
}

/** 界面/导出用的一句话（内核持有用户可见文案，和 REASON / MSG 同一处风格） */
export function clearanceText(row, getProduct) {
  if (!row || row.freeDeg === null) return '';
  const who = row.blockedBy?.kind === 'item' ? `#${row.blockedBy.id}` : row.blockedBy?.kind === 'wall' ? '内墙' : '墙体';
  if (row.freeDeg <= 0) return `柜门被${who}挡住，打不开`;
  if (row.unobstructed) return `柜门可开到 ${row.freeDeg}°（不受阻）`;
  // 文案必须与分级一致：50° 判红（开不到黄灯阈值），就不能说成"能开但会挡"——
  // 那样用户会以为"凑合能用"。三级三句话。
  if (row.freeDeg >= cfg.door.openWarnDeg) return `柜门最多开 ${row.freeDeg}°，能开但开不到底（被${who}挡住）`;
  return `柜门最多开 ${row.freeDeg}°，基本用不上（被${who}挡住）`;
}

/**
 * “有门，但门数据不完整，所以没算净空”的可解释文案。
 * 与 `clearanceText` 分开：后者只在**算出了角度**时说话，不能拿空串冒充“没问题”。
 */
export function clearanceSkipText(row) {
  if (!row || !row.skippedDoors) return '';
  const why = {
    'missing-hinge': '缺铰链位置',
    'missing-leaf': '缺门板轮廓',
    'missing-swing': '缺扫掠半径',
    'missing-angle': '缺开门角度',
  }[row.skipReason] ?? '门数据不完整';
  const n = row.skippedDoors === 1 ? '1 扇门' : `${row.skippedDoors} 扇门`;
  // 混有完整门时，别的门仍算出了角度；不能把整台说成“没算”。
  return `${n}${why}，${row.freeDeg === null ? '未计算机械净空' : '该门未参与净空计算'}`;
}

/**
 * 自动摆放之后该跟用户说的那一句话 —— 接缝 A（docs/13）里"纯提示、不阻断"的那一半。
 *
 * 返回 `''` 表示无话可说（门都开得到底）→ 界面照旧只说"已放入…"，**行为一个字不变**。
 *
 * 判据直接用 `level`，不在这里重新比大小：阈值住在 `cfg` 里（黄灯 90°），
 * 要改就改参数表一处 —— 否则"90"会被写死在两个地方（R4-0.5 的一份驱动四处）。
 *
 * @param {Array} rows `clearanceReport()` 的结果
 * @param {number} placedId 刚放进去那台的编号（用来把话说得具体）
 */
export function doorTroubleClause(rows, placedId) {
  const troubled = rows.filter((r) => r.level !== 'ok' && r.level !== 'n/a');
  if (!troubled.length) return '';
  const worst = troubled.reduce((a, b) => (b.freeDeg < a.freeDeg ? b : a));
  const who = worst.id === placedId ? '刚放的这台' : `#${worst.id}`;
  // ⚠️ 说"柜门"：W1 起"门洞"是另一个东西（墙上的洞口），不限定词就会混
  return `其中 ${troubled.length} 台的柜门开不到 ${cfg.door.openOkDeg}°（${who} 最多 ${worst.freeDeg}°）`;
}

/** 门净空不成立时给用户的建议动作（导出/体检用） */
export function clearanceHint(row) {
  if (!row || row.freeDeg === null || row.unobstructed) return '';
  const who = row.blockedBy?.kind === 'item' ? `#${row.blockedBy.id}` : '墙';
  return `把设备转个方向或与${who}拉开距离，柜门才用得上`;
}