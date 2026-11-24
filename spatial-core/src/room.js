/**
 * room.js —— 规则 2：空间与墙（纯函数）
 *
 * 来源：`defaultWalls()` / `wallSides()` / `isBoundaryWall()` / `$('applyRoom').onclick`
 * 含 R1 的 FIX-03（改尺寸保留内墙、且边界墙必须在**旧**房间口径下判定）。
 */

import { cfg } from './params.js';
import { EPS, corners, pointInPoly } from './geometry.js';
import {
  mkWallSeg, mkWall, wallSeg, cloneWall, openingsOf, cloneOpening,
  EXTERIOR, INTERIOR, isWallRole, roleOf,
} from './wall.js';
import { checkOpeningShape, OPENING_HARD_LIMIT } from './openings.js';
import { translateRoutes, routesOutOfBounds } from './route.js';
// 房名搬家要用「房间是算出来的」那一份（rooms.js 不反过来依赖本模块，没有循环）
import { roomsOf, roomSemanticsOf, ROOM_SEMANTICS, ON_TOL_M } from './rooms.js';
import { shiftColumns, columnsOutOfBounds } from './columns.js';

/** 原型硬性范围：长宽 3–20 m、墙高 2–5 m */
/** 房间尺寸范围（读参数表：改配置不用改代码） */
export function roomLimits() {
  return { w: [cfg.room.minW, cfg.room.maxW], d: [cfg.room.minD, cfg.room.maxD], h: [cfg.room.minH, cfg.room.maxH] };
}

/** 范围文案 —— **唯一一份**：报错、导入校验、界面提示都说这一句。改配置时文案自动跟着变，不会说谎 */
export function roomRangeText() {
  const r = roomLimits();
  return `长宽范围 ${r.w[0]}–${r.w[1]} m，墙高 ${r.h[0]}–${r.h[1]} m`;
}

/** 四面外墙（原型 defaultWalls）—— 记录形状是**墙对象**（见 wall.js） */
export function boundaryWalls(w, d) {
  return [
    mkWallSeg(0, 0, w, 0),
    mkWallSeg(w, 0, w, d),
    mkWallSeg(w, d, 0, d),
    mkWallSeg(0, d, 0, 0),
  ];
}

/**
 * 外墙贴在哪条边界线上（L/R/T/B；`wallSides` 的四个名字）。
 * 外墙的**端点所指的方向是固定的**：T 面从 (0,0) 向 (w,0)、R 面从 (w,0) 向 (w,d)、
 * B 面从 (w,d) 向 (0,d)、L 面从 (0,d) 向 (0,0) —— 所以"门洞在这面墙上的弧长 `at`"
 * 在房间变大变小之后**指的是同一个锚角**，可以原样带走（见 `applyRoomSize`）。
 * @returns {'L'|'R'|'T'|'B'|null}
 */
export function boundarySide(room, wall) {
  const [x, z, xx, zz] = wallSeg(wall);
  const a = wallSides(room, x, z);
  const b = wallSides(room, xx, zz);
  return a.find((s) => b.includes(s)) ?? null;
}

/** 点落在房间哪几条边界线上：L/R/T/B（原型 wallSides，容差 1e-6） */
export function wallSides(room, x, z, e = 1e-6) {
  const s = [];
  if (Math.abs(x) < e) s.push('L');
  if (Math.abs(x - room.w) < e) s.push('R');
  if (Math.abs(z) < e) s.push('T');
  if (Math.abs(z - room.d) < e) s.push('B');
  return s;
}

/**
 * 墙的**角色**：`'exterior'`（外墙）或 `'interior'`（内墙）—— 全仓唯一语义出口。
 *
 * 口径（`docs/93` §5.1）：
 *  1. 墙上有合法的 `role` → 原样返回（**语义优先**；扩场景时的改判写回墙里）；
 *  2. 没有/非法 → **几何回退**：两端点贴在同一条 `0/w/0/d` 外缘线上 → 外墙，否则内墙。
 *
 * 为什么不是「贴边就是外墙」：扩完场景，原来贴边的墙会留在中间。若继续按几何猜，
 * 碰撞（`checkItem` 跳过外墙）与显示会各说一套。角色落盘之后，7+ 个消费点读的是同一个事实；
 * 旧文件缺 `role` 才走回退 —— 旧方案因此不用迁移。
 */
export function wallRole(room, wall) {
  const explicit = roleOf(wall);
  if (explicit) return explicit;
  return onSameSceneEdge(room, wall) ? EXTERIOR : INTERIOR;
}

/**
 * 两端点是否同时贴在同一条场景外缘线上（**纯几何**，容差 1e-6）。
 * 这是旧 `isBoundaryWall` 的判据，也是 `wallRole` 的回退口径 —— 与旧方案逐字节一致。
 *
 * ⚠️ 必须是「同一条边」：一条从左边拉到上边的**斜墙**两端各在不同边上，
 * 它并不沿场景外缘走（中间穿过场地内部），判成外墙会让设备错误穿过它。
 */
function onSameSceneEdge(room, wall, e = 1e-6) {
  const [x, z, xx, zz] = wallSeg(wall);
  const a = wallSides(room, x, z, e);
  const b = wallSides(room, xx, zz, e);
  return a.length > 0 && b.length > 0 && a.some((s) => b.includes(s));
}

/** 该墙是否为外墙 —— `wallRole` 的**薄封装**（保持 7 处旧消费点的调用形状不变） */
export function isBoundaryWall(room, wall) {
  return wallRole(room, wall) === EXTERIOR;
}

/**
 * 落笔时的角色判定（**做一次、存下来**；`docs/93` §5.3、`docs/92` §2.2）：
 *  - 起笔在场景外（`fromOutside`）→ 外墙；
 *  - 两端点都贴**同一条**当前场景外缘线（1e-6）→ 外墙；
 *  - 其余 → 内墙（含"两端各贴一条边"的斜墙：它不沿外缘走）。
 *
 * 注意边界：从场内拖到新边缘的墙是**内墙**（只有一端贴边，且起笔在场内）—— 这是刻意的，
 * 预览必须显示角色徽标，用户可在右栏一步改。
 *
 * `layout` 必须是**扩场景之后**的 layout（端点已在新坐标系里）。
 * @param {object} seg 墙对象（`{a,b}`）
 * @returns {'exterior'|'interior'}
 */
export function classifyWallRole(layout, seg, { fromOutside = false } = {}) {
  if (fromOutside) return EXTERIOR;
  return onSameSceneEdge(layout, seg) ? EXTERIOR : INTERIOR;
}

/* ---------------- 角色切换（P2 右栏「外墙 / 内墙」） ---------------- */

/**
 * 改一面墙的角色（只写 `role`，**不改几何**；一步可撤销由调用方 `beginEdit()` 保证）。
 *
 * 只允许把**当前贴场景外缘**的墙设为 `exterior`（`docs/93` §5.1 / T6）：
 * 中间墙若被标成外墙，`checkItem` 会跳过它 —— 用户看到「外墙」却挡不住设备，两套事实打架。
 * 设为 `interior` 永远允许；`role = null` = 清掉显式角色、回几何回退（给「恢复默认」留口子）。
 *
 * @param {object} layout
 * @param {number} wallIndex 0 基（与 2D `data-wall-index` 同一套编号）
 * @param {'exterior'|'interior'|null} role
 * @returns {{ok:false,reason:'bad-wall'|'bad-role'|'wall-not-on-edge',code:string,message:string}
 *          |{ok:true,layout:object,wall:object,changed:boolean}}
 */
export function setWallRole(layout, wallIndex, role) {
  const i = Number(wallIndex);
  if (!Number.isInteger(i) || i < 0 || i >= (layout?.walls?.length ?? 0)) {
    return { ok: false, reason: 'bad-wall', code: 'bad-wall', message: `墙序号 ${wallIndex} 不存在` };
  }
  if (role !== null && !isWallRole(role)) {
    return { ok: false, reason: 'bad-role', code: 'bad-role', message: `墙的类型只能是外墙或内墙（收到 ${String(role)}）` };
  }
  const wall = layout.walls[i];
  if (role === EXTERIOR && !onSameSceneEdge(layout, wall)) {
    return {
      ok: false,
      reason: 'wall-not-on-edge',
      code: 'wall-not-on-edge',
      message: '只有贴着场景边缘的墙可以设为外墙',
    };
  }
  const walls = layout.walls.map((wl, j) => {
    if (j !== i) return wl;
    const next = cloneWall(wl);
    delete next.role;
    if (role) next.role = role;          // 有值才写；null = 清掉、回几何回退
    return next;
  });
  const changed = role !== roleOf(wall);
  return { ok: true, layout: { ...layout, walls }, wall: walls[i], changed };
}


/** 尺寸校验：返回中文错误信息或 null（原型 applyRoom 的范围提示原样保留） */
export function validateRoomSize(w, d, h) {
  const L = roomLimits();
  if (![w, d, h].every(Number.isFinite)) return roomRangeText();
  if (w < L.w[0] || w > L.w[1]) return roomRangeText();
  if (d < L.d[0] || d > L.d[1]) return roomRangeText();
  if (h < L.h[0] || h > L.h[1]) return roomRangeText();
  return null;
}

/**
 * 改空间尺寸（FIX-03）：重建四面外墙 + **保留仍在新范围内的内墙**。
 *
 * 两个易错点（R1 实测踩过）：
 *  1. `isBoundaryWall` 必须用**旧**房间尺寸判定，否则旧外墙会被误认为内墙而留下/丢弃；
 *  2. 原型此步会静默删除内墙，toast 却说"可撤销恢复" —— 这里如实返回 kept/removed 供 UI 提示。
 *
 * 保留即原型的过滤式（`x>=0 && z>=0 && xx>=0 && xx<=w && zz>=0 && zz<=d`）。
 * 注：因墙均为轴对齐，该式对另一坐标的越界（如 x>w 的横墙）不敏感 —— 属原型既有宽松点，
 *     与 FIX-21「导入墙越界」同一处，R2 保持行为对齐，收严留给 R3（有断言护航）。
 *
 * W1（门洞）：内墙**连门洞一起**带走（墙是对象，门洞是它的字段，天然跟着）。
 * 外墙是**重建**的，但四个面的锚角方向是固定的（见 `boundarySide`），所以外墙上的门洞
 * 按"同一个锚角 + 同一个弧长"搬过去；搬过去放不下的（墙变短了）**丢掉并报出来**
 *（`openingsDropped`）—— 静默丢数据是这个项目最不能接受的一类 bug。
 *
 * @returns {{ok:false,error:string} | {ok:true,layout:object,kept:number,removed:number,openingsKept:number,openingsDropped:number}}
 */
export function applyRoomSize(layout, { w, d, h }) {
  const error = validateRoomSize(w, d, h);
  if (error) return { ok: false, error };
  const columnsOut = columnsOutOfBounds(layout, w, d);
  if (columnsOut.length) {
    return {
      ok: false,
      error: `场景缩到 ${fmtM(w)} × ${fmtM(d)} m 会让柱 ${columnsOut.map((c) => `#${c.id}`).join('、')} 跑到场景外 —— 先挪开或删掉它们`,
      columnIndexes: columnsOut.map((c) => c.index),
    };
  }

  const inner = layout.walls.filter((wl) => !isBoundaryWall(layout, wl));
  // 四个坐标**全部**比一遍：原型只比了 x/z 的下界与 xx/zz 的上界，斜墙与「另一头越界」都能漏过去
  const inside = (v, hi) => v >= 0 && v <= hi;
  const kept = inner.filter((wl) => {
    const [x, z, xx, zz] = wallSeg(wl);
    return inside(x, w) && inside(z, d) && inside(xx, w) && inside(zz, d);
  });

  // 外墙上的门洞：按"面"搬家（弧长指的还是同一个锚角）
  const oldBySide = new Map();
  for (const wl of layout.walls) {
    if (!isBoundaryWall(layout, wl)) continue;
    const side = boundarySide(layout, wl);
    if (side && !oldBySide.has(side)) oldBySide.set(side, wl);
  }
  const nextBoundary = boundaryWalls(w, d);
  const nextLayout = { ...layout, w, d, h };
  let openingsKept = kept.reduce((n, wl) => n + openingsOf(wl).length, 0);
  let openingsDropped = 0;
  const boundaryWithOpenings = nextBoundary.map((wl) => {
    const side = boundarySide(nextLayout, wl);
    const old = side ? oldBySide.get(side) : null;
    const list = old ? openingsOf(old) : [];
    // 角色跟着"那一面"走（重建不等于换身份）：旧外墙显式写了 exterior 就继续写
    const oldRole = old ? roleOf(old) : null;
    if (!list.length) return mkWall(wl.a, wl.b, [], oldRole);
    const keep = list.filter((o) => !checkOpeningShape(wl, o, h));
    openingsKept += keep.length;
    openingsDropped += list.length - keep.length;
    // ⚠️ 走 `cloneOpening`（形状的唯一定义）：手抄 `{at,w,h}` 会把**窗降级成落地洞** ——
    //    而且只在「改房间尺寸」这一条路径上发生，平时测不出来（W2，docs/78 §2.3 第 4 处）
    return mkWall(wl.a, wl.b, keep, oldRole);
  });

  const next = {
    ...nextLayout,
    walls: [...boundaryWithOpenings, ...kept.map((wl) => cloneWall(wl))],
  };
  return { ok: true, layout: next, kept: kept.length, removed: inner.length - kept.length, openingsKept, openingsDropped };
}

/* ---------------- 扩空间：房间画到空间外就把整栋扩到包含它 ---------------- */

/**
 * 一个矩形整个落在 `[0,w]×[0,d]` 里（含贴边）时返回 true。
 * 容差用 `EPS`（1e-8 m）：吸附网格是 0.1 m，这个量级只会吸掉浮点噪声
 *（`30*0.1 = 3.0000000000000004` 那种），不会把"真的画到外面"误判成没越界。
 */
const insideRoom = (layout, x0, z0, x1, z1) => x0 >= -EPS && z0 >= -EPS
  && x1 <= layout.w + EPS && z1 <= layout.d + EPS;

/** 只在浮点噪声级夹取（返回的 rect 必须落在新 envelope 里，否则调用方会画出越界墙） */
const clampNum = (v, hi) => Math.max(0, Math.min(hi, v));

/** 报错文案里的数字：两位小数就够（范围本身是参数表里的数） */
const fmtM = (v) => String(Math.round(v * 100) / 100);
/** 界面文案表（docs/92 §7.1）里的尺寸是一位小数：`21.0 × 6.0 m` */
const fmtM1 = (v) => v.toFixed(1);

/**
 * 房名搬家（扩空间版）：`roomLabels` 的键是房间的**几何 id**，整体一平移 id 就全变了。
 *
 * 规则与 `rooms.carryLabels` 同一条口径：名字跟着房间走（找"平移后的那个房间"），
 * 几间并成一间时**面积大的那间名字活下来**。两点刻意不同：
 *  ① 用 `labelAt`（名字画在哪儿，**保证在房内**）而不是形心 —— 凹口房的形心会落在房外，
 *    拿它去找新房间会找不到、名字就被静默丢了；
 *  ② 被并掉 / 找不到房间的名字**不删**，留在旧 id 上等房间回来 —— 与 `cleanRoomLabels`
 *    「暂时对不上的名字由界面提示『在等房间』」是同一条口径，撤销之后名字自动回来。
 *
 * @returns {object|null} 新名字表；旧布局没名字时返回 null（调用方就不写这个字段）
 */
function carryRoomNames(oldLayout, newLayout, dx, dz) {
  const oldLabels = oldLayout.roomLabels;
  if (!oldLabels || typeof oldLabels !== 'object') return null;
  const named = Object.entries(oldLabels).filter(([, v]) => typeof v === 'string' && v.trim());
  if (!named.length) return null;

  const oldRooms = roomsOf(oldLayout);
  const newRooms = roomsOf(newLayout);
  const oldById = new Map(oldRooms.map((r) => [r.id, r]));

  const out = {};
  const taken = new Set();
  // 对不上任何旧房间的名字（历史遗留 / 撤销前的 id）原样留着：扩空间不该顺手删别人的名字
  for (const [id, name] of named) if (!oldById.has(id)) out[id] = name;

  // 旧房间按面积从大到小处理 —— 几间并成一间时面积大的那间名字活下来（与 carryLabels 一致）
  for (const old of [...oldRooms].sort((a, b) => b.area - a.area)) {
    const name = oldLabels[old.id];
    if (typeof name !== 'string' || !name.trim()) continue;
    const p = old.labelAt ?? old.centroid;
    const target = newRooms.find((n) => !taken.has(n.id)
      && pointInPoly(n.poly, [p[0] + dx, p[1] + dz], ON_TOL_M));
    if (!target) { out[old.id] = name; continue; }   // 没地方可去 → 留在旧 id 上等房间回来
    out[target.id] = name;
    taken.add(target.id);
  }
  return Object.keys(out).length ? out : null;
}

/**
 * 把整栋空间**扩大到包含 rect**（用户在现有空间外画一间房时用；纯函数，不改入参）。
 *
 * ## 为什么需要它
 *
 * 画房间的手势只加墙、不动 `layout.w/d`，于是画到空间外的房间会带出
 * `wall-out-of-room`（服务端导入/保存时拒绝）。用户已拍板：房间画到外面时
 * **自动把整栋扩到包含它**，向左/上扩时整体平移墙和设备，房名跟着迁移。
 *
 * ## 口径（`task-26` 逐条）
 *
 *  1. 矩形已在 `[0,w]×[0,d]` 内 → `{ok:true, changed:false, layout, rect}`：**原样返回同一个
 *     layout 对象**（不复制不改），调用方不必判断 changed 就能继续。
 *  2. union：`minX=min(0,x0)`、`minZ=min(0,z0)`、`maxX=max(w,x1)`、`maxZ=max(d,z1)`；
 *     `dx=-minX`、`dz=-minZ`；新 `w=maxX-minX`、`d=maxZ-minZ`。**不夹取**：新尺寸过不了
 *     `roomLimits()` 就如实报错（静默夹取会让用户画出来的房间和提示对不上）。
 *  3. 内墙与设备整体平移 `(dx,dz)`；旧外墙**不留在墙池里**（它现在在房间中间了，
 *     留着就会变成一面凭空出现的隔墙），按新 `w/d` 用 `boundaryWalls()` 重建四面。
 *  4. 旧外墙上的门/窗：洞口中心先跟着房子**平移**、再投影到新的那面外墙算 `at`
 *     —— 于是"这儿有一扇门"扩前扩后指着**同一个物理位置**，不会因为左/上扩而跳进
 *     新扩出来的那条空带里。放不下的（旧数据本身就戳出墙外、或两条共线旧外墙各带一个
 *     重叠的洞）**丢掉并计入 `openingsDropped`**，不许静默丢。
 *  5. 房名见 {@link carryRoomNames}。新房未命名。
 *
 * ## 已知的几何后果（不是 bug，界面转述时要知道）
 *
 * 与扩张轴**平行**的内墙会与新外墙脱开一个缺口（例如向右扩时，横隔墙还停在旧 `w`，
 * 新扩出来的那条带子把它两侧连通），`roomsOf` 会据此把它们算成一间 —— 这是
 * 「旧外墙剔除 + 内墙整体平移」的必然结果。房名按面积大者继承，被并掉的名字留在旧 id。
 *
 * @param {object} layout 旧布局 `{w,d,h,walls,items,roomLabels?}`
 * @param {{x0:number,z0:number,x1:number,z1:number}} rect 要包含进来的矩形（已规范化 min/max）
 * @returns {{ok:false,code:string,error:string}
 *          |{ok:true,changed:false,layout:object,rect:object}
 *          |{ok:true,changed:true,layout:object,rect:object,dx:number,dz:number,w:number,d:number,
 *            keptWalls:number,openingsKept:number,openingsDropped:number}}
 */
export function expandToInclude(layout, rect) {
  const nums = [rect?.x0, rect?.z0, rect?.x1, rect?.z1];
  if (!nums.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    return { ok: false, code: 'bad-rect', error: '画房间的矩形不合法（四个坐标必须是有限数字）' };
  }
  const x0 = Math.min(rect.x0, rect.x1);
  const x1 = Math.max(rect.x0, rect.x1);
  const z0 = Math.min(rect.z0, rect.z1);
  const z1 = Math.max(rect.z0, rect.z1);

  // ① 已经在里面 → no-op（同一个对象、同一个 rect，调用方可以放心往上叠墙）
  if (insideRoom(layout, x0, z0, x1, z1)) return { ok: true, changed: false, layout, rect };

  // ② union（容差内的"越界"按贴边处理，避免为 1e-9 m 重建整栋）
  const minX = x0 < -EPS ? x0 : 0;
  const minZ = z0 < -EPS ? z0 : 0;
  const maxX = x1 > layout.w + EPS ? x1 : layout.w;
  const maxZ = z1 > layout.d + EPS ? z1 : layout.d;
  const w = maxX - minX;
  const d = maxZ - minZ;
  // 写成三元而不是 `-minX`：minX 为 0 时 `-0` 会让调用方/判据里的 `dx === 0` 变红（且看不出为什么）
  const dx = minX < 0 ? -minX : 0;
  const dz = minZ < 0 ? -minZ : 0;

  // ③ 范围：超了就报错，**不夹取**（夹取等于悄悄改了用户画的空间）
  const L = roomLimits();
  if (w < L.w[0] || w > L.w[1] || d < L.d[0] || d > L.d[1]) {
    return {
      ok: false,
      code: 'room-too-large',
      w,
      d,
      error: `空间要扩到 ${fmtM(w)} × ${fmtM(d)} m，超出范围（${roomRangeText()}）—— 把房间画小一点再试`,
    };
  }

  // ④ 旧墙分两堆：外墙剔除重建，内墙连洞口一起平移
  const oldBoundary = [];
  const inner = [];
  for (const wl of layout.walls) (isBoundaryWall(layout, wl) ? oldBoundary : inner).push(wl);

  const movedInner = inner.map((wl) => {
    const [ax, az, bx, bz] = wallSeg(wl);
    const out = cloneWall(wl);        // 洞口形状只有 wall.js 那份定义（手抄 {at,w,h} 会把窗降级）
    out.a = [ax + dx, az + dz];
    out.b = [bx + dx, bz + dz];
    return out;
  });

  const nextBoundary = boundaryWalls(w, d);
  const newRoom = { w, d };                       // boundarySide 只读 w/d
  const boundaryBySide = new Map();
  for (const wl of nextBoundary) {
    const side = boundarySide(newRoom, wl);
    if (side) boundaryBySide.set(side, wl);
  }

  // ⑤ 旧外墙上的洞口：中心跟着平移 → 投影到新外墙（同一个物理位置）
  const wanted = new Map();                        // side → 洞口数组（at 已是新墙弧长）
  const roleBySide = new Map();                    // side → 显式角色（重建不许把 exterior 弄丢）
  for (const wl of oldBoundary) {
    const side = boundarySide(layout, wl);
    const target = side ? boundaryBySide.get(side) : null;
    if (!target) continue;                         // isBoundaryWall 为真时不会发生（防御）
    if (!roleBySide.has(side) && roleOf(wl)) roleBySide.set(side, roleOf(wl));
    const [ax, az, bx, bz] = wallSeg(wl);
    const len = Math.hypot(bx - ax, bz - az);
    const [nax, naz, nbx, nbz] = wallSeg(target);
    const nlen = Math.hypot(nbx - nax, nbz - naz);
    for (const o of openingsOf(wl)) {
      const t = len > EPS ? Number(o.at) / len : 0;
      const px = ax + (bx - ax) * t + dx;
      const pz = az + (bz - az) * t + dz;
      const at = nlen > EPS
        ? ((px - nax) * (nbx - nax) + (pz - naz) * (nbz - naz)) / nlen
        : 0;
      const copy = cloneOpening(o);
      copy.at = at;
      if (!wanted.has(side)) wanted.set(side, []);
      wanted.get(side).push(copy);
    }
  }

  // 内墙上的洞口天然跟着墙走（at 是相对墙的弧长），先计入"保留"
  let openingsKept = movedInner.reduce((n, wl) => n + openingsOf(wl).length, 0);
  let openingsDropped = 0;
  const nextBoundaryWalls = nextBoundary.map((wl) => {
    const side = boundarySide(newRoom, wl);
    const list = [...(side ? wanted.get(side) ?? [] : [])].sort((a, b) => a.at - b.at);
    const keep = [];
    let end = -Infinity;
    for (const o of list) {
      // 结构上放不下（旧数据本身就戳出墙外 / 比墙还高）→ 丢掉，但**计数**（不静默）
      if (checkOpeningShape(wl, o, layout.h)) { openingsDropped += 1; continue; }
      // 两条共线的旧外墙各带一个洞时才会重叠：留前一个，后面的丢掉并计数
      if (o.at - o.w / 2 < end - 1e-9) { openingsDropped += 1; continue; }
      // 格式硬上限（多条共线旧外墙并到同一面时才会撞上）：超了绝不能写出去 ——
      // 导出端与导入端共用这条上限，写出去就是"自己导不回来"（FIX-05）
      if (keep.length >= OPENING_HARD_LIMIT) { openingsDropped += 1; continue; }
      keep.push(o);
      end = o.at + o.w / 2;
      openingsKept += 1;
    }
    // 没洞口时 mkWall 不写 openings 字段；角色跟着"那一面"走（重建 ≠ 换身份）
    return mkWall(wl.a, wl.b, keep, side ? roleBySide.get(side) ?? null : null);
  });

  const next = {
    ...layout,
    w,
    d,
    walls: [...nextBoundaryWalls, ...movedInner],
    items: layout.items.map((it) => ({ ...it, x: it.x + dx, z: it.z + dz })),
    // 结构柱跟着图一起平移（与设备/动线同一撤销步；漏了柱会相对房间漂移）
    ...(Array.isArray(layout.columns) ? { columns: shiftColumns(layout.columns, dx, dz) } : {}),
    // 动线跟着图一起平移（docs/97 §六：同一撤销步；漏了就是动线相对房间漂移）
    ...(Array.isArray(layout.routes) ? { routes: translateRoutes(layout.routes, dx, dz) } : {}),
  };
  const labels = carryRoomNames(layout, next, dx, dz);
  if (labels) next.roomLabels = labels;
  else delete next.roomLabels;

  return {
    ok: true,
    changed: true,
    layout: next,
    // 画的那个矩形也跟着平移；再夹回新 envelope（只差浮点噪声级），免得调用方画出一面越界墙
    rect: {
      x0: clampNum(x0 + dx, w),
      z0: clampNum(z0 + dz, d),
      x1: clampNum(x1 + dx, w),
      z1: clampNum(z1 + dz, d),
    },
    dx,
    dz,
    w,
    d,
    keptWalls: movedInner.length,
    openingsKept,
    openingsDropped,
  };
}

/* ---------------- 扩场景（画墙版）：保留旧墙、旧贴边外墙改判 ---------------- */

/**
 * 把场景扩大到包含 `rect`，**保留所有既有墙**（不剔除、不重建任何一面）。
 *
 * 与 `expandToInclude` 的区别（必须并存，`docs/93` §5.2）：
 *  - `expandToInclude` 是「画房间」：旧外墙剔除、按新尺寸重建四面（房间画到外面时整栋跟着长）；
 *  - `expandSceneKeepWalls` 是「画墙」：墙是用户一根根画的，**扩场景不能替换任何旧墙** ——
 *    旧四面墙留在原地，变成场景内部/边缘的普通墙。
 *
 * 步骤：
 *  1. union + `roomLimits()` 校验（超了报真实尺寸，**不夹取**）；
 *  2. 左/上扩时所有墙（含门洞）、设备、房名整体平移 `(dx,dz)`；
 *  3. 旧 `exterior` 墙若不再同时贴**同一条**新外缘线 → 改判 `interior`
 *     （只写有显式角色的墙；旧文件没角色的墙靠几何回退自动变内墙，不凭空加字段）。
 *     从不把 `interior` 自动改成 `exterior`；
 *  4. 房名迁移与 `expandToInclude` 同一套规则（`carryRoomNames`）。
 *
 * @returns {{ok:false,code:'bad-rect'|'room-too-large',error:string,w?:number,d?:number}
 *          |{ok:true,changed:false,layout:object,rect:object,dx:0,dz:0,w:number,d:number,reclassified:Array}
 *          |{ok:true,changed:true,layout:object,rect:object,dx:number,dz:number,w:number,d:number,
 *            reclassified:Array<{index:number,from:'exterior',to:'interior',explicit:boolean}>}}
 */
export function expandSceneKeepWalls(layout, rect) {
  const nums = [rect?.x0, rect?.z0, rect?.x1, rect?.z1];
  if (!nums.every((v) => typeof v === 'number' && Number.isFinite(v))) {
    return { ok: false, code: 'bad-rect', error: '墙的端点不合法（四个坐标必须是有限数字）' };
  }
  const x0 = Math.min(rect.x0, rect.x1);
  const x1 = Math.max(rect.x0, rect.x1);
  const z0 = Math.min(rect.z0, rect.z1);
  const z1 = Math.max(rect.z0, rect.z1);

  if (insideRoom(layout, x0, z0, x1, z1)) {
    return { ok: true, changed: false, layout, rect, dx: 0, dz: 0, w: layout.w, d: layout.d, reclassified: [] };
  }

  const minX = x0 < -EPS ? x0 : 0;
  const minZ = z0 < -EPS ? z0 : 0;
  const maxX = x1 > layout.w + EPS ? x1 : layout.w;
  const maxZ = z1 > layout.d + EPS ? z1 : layout.d;
  const w = maxX - minX;
  const d = maxZ - minZ;
  const dx = minX < 0 ? -minX : 0;
  const dz = minZ < 0 ? -minZ : 0;

  const L = roomLimits();
  if (w < L.w[0] || w > L.w[1] || d < L.d[0] || d > L.d[1]) {
    return {
      ok: false,
      code: 'room-too-large',
      w,
      d,
      error: `场景要扩到 ${fmtM1(w)} × ${fmtM1(d)} m，超出范围（长宽 ${L.w[0]}–${L.w[1]} m）`,
    };
  }

  const next = { w, d };
  const reclassified = [];
  const walls = layout.walls.map((wl, index) => {
    const before = wallRole(layout, wl);          // 扩场景**前**的有效角色（语义优先、几何回退）
    const out = cloneWall(wl);                    // 洞口与角色一起拷（形状只有 wall.js 一份定义）
    out.a = [wl.a[0] + dx, wl.a[1] + dz];
    out.b = [wl.b[0] + dx, wl.b[1] + dz];
    // 只处理扩场景前就是外墙的墙；扩完还贴同一条新边缘 → 保持外墙
    if (before !== EXTERIOR) return out;
    if (onSameSceneEdge(next, out)) return out;
    const explicit = !!roleOf(wl);
    if (explicit) out.role = INTERIOR;            // 显式 exterior → 写回 interior（同一撤销步）
    // 旧文件没角色：不凭空写字段；几何回退已经会给出 interior —— 但改判事实要报给界面
    reclassified.push({ index, from: EXTERIOR, to: INTERIOR, explicit });
    return out;
  });

  const shifted = {
    ...layout,
    w,
    d,
    walls,
    items: layout.items.map((it) => ({ ...it, x: it.x + dx, z: it.z + dz })),
    // 结构柱跟着图一起平移（与设备/动线同一撤销步）
    ...(Array.isArray(layout.columns) ? { columns: shiftColumns(layout.columns, dx, dz) } : {}),
    // 动线跟着图一起平移（docs/97 §六：同一撤销步；漏了就是动线相对房间漂移）
    ...(Array.isArray(layout.routes) ? { routes: translateRoutes(layout.routes, dx, dz) } : {}),
  };
  const labels = carryRoomNames(layout, shifted, dx, dz);
  if (labels) shifted.roomLabels = labels;
  else delete shifted.roomLabels;

  return {
    ok: true,
    changed: true,
    layout: shifted,
    rect: {
      x0: clampNum(x0 + dx, w),
      z0: clampNum(z0 + dz, d),
      x1: clampNum(x1 + dx, w),
      z1: clampNum(z1 + dz, d),
    },
    dx,
    dz,
    w,
    d,
    reclassified,
  };
}

/* ---------------- 改场景尺寸（P4 尺寸面板）：新语义只校验不重建 ---------------- */

/** 缩场景时动线越界的统一失败形状（0 基序号；layout 不变） */
function columnBoundsFailure(layout, w, d) {
  const out = columnsOutOfBounds(layout, w, d);
  if (!out.length) return null;
  const label = out.map((c) => `#${c.id}（序号 ${c.index + 1}）`).join('、');
  return {
    ok: false,
    reason: 'columns-out-of-bounds',
    code: 'columns-out-of-bounds',
    message: `场景缩到 ${fmtM(w)} × ${fmtM(d)} m 会让柱 ${label} 跑到场景外 —— 先挪开或删掉它们`,
    columnIndexes: out.map((c) => c.index),
  };
}

function routeBoundsFailure(layout, w, d) {
  const points = routesOutOfBounds(layout.routes, w, d);
  if (!points.length) return null;
  const first = points[0];
  const label = points.map((p) => `动线 #${p.routeIndex + 1} 第 ${p.pointIndex + 1} 点`).join('、');
  return {
    ok: false,
    reason: 'routes-out-of-bounds',
    code: 'routes-out-of-bounds',
    message: `场景缩到 ${fmtM(w)} × ${fmtM(d)} m 会让 ${label} 跑到场景外 —— 先挪开动线`,
    routeIndex: first.routeIndex,
    pointIndex: first.pointIndex,
    routePoints: points,
  };
}

/**
 * 规划一次场景尺寸变更（**新语义不重建墙**，`docs/91` §6.7 / `docs/93` §5）：
 *  - 先校验范围（`roomLimits()`）与非有限数；
 *  - 缩小时检查是否会把墙/设备/动线拐点留在场景外 —— 有就**返回序号清单、layout 不变**
 *    （F3：不许静默删墙；动线也不许静默夹点/删线）；
 *  - 成功返回 `{ok:true, layout}`：新语义只改 `w/d/h`，墙原样保留（它们可能变成内部墙），
 *    房名按 `carryRoomNames` 迁到新房间 id；
 *  - **旧语义**（legacy）走 `applyRoomSize` 兼容分支（重建四面外墙、保留范围内内墙），
 *    返回值多 `rebuilt:true` 与 `kept/removed/openings*`。
 *
 * 序号都是 **0 基**（与 `layout.walls` / `2D data-wall-index` 一致）；文案里报给用户的墙号是 1 基。
 *
 * @param {object} layout
 * @param {{w:number,d:number,h:number}} size
 * @param {{getProduct?:Function}} [opts] 传了就按真实占地四角判设备越界，否则只判设备中心点
 * @returns {{ok:true,layout:object,changed:boolean,rebuilt:boolean,roomSemantics:string,
 *            kept?:number,removed?:number,openingsKept?:number,openingsDropped?:number}
 *          |{ok:false,reason:string,code:string,message:string,wallIndexes?:number[],itemIndexes?:number[],
 *            routeIndex?:number,pointIndex?:number,routePoints?:Array<{routeIndex:number,pointIndex:number}>}}
 */
export function planSceneSize(layout, size = {}, { getProduct = null } = {}) {
  const { w, d, h } = size;
  if (![w, d, h].every((v) => typeof v === 'number' && Number.isFinite(v) && v > 0)) {
    return { ok: false, reason: 'bad-size', code: 'bad-size', message: '场景尺寸不合法（长宽高必须是正数）' };
  }
  const error = validateRoomSize(w, d, h);
  if (error) {
    return { ok: false, reason: 'size-out-of-range', code: 'size-out-of-range', message: error };
  }

  if (roomSemanticsOf(layout) === ROOM_SEMANTICS.LEGACY) {
    const columnFail = columnBoundsFailure(layout, w, d);
    if (columnFail) return columnFail;
    const routeFail = routeBoundsFailure(layout, w, d);
    if (routeFail) return routeFail;
    const r = applyRoomSize(layout, { w, d, h });
    if (!r.ok) return { ok: false, reason: 'size-out-of-range', code: 'size-out-of-range', message: r.error };
    return {
      ok: true,
      layout: r.layout,
      changed: true,
      rebuilt: true,
      roomSemantics: ROOM_SEMANTICS.LEGACY,
      kept: r.kept,
      removed: r.removed,
      openingsKept: r.openingsKept,
      openingsDropped: r.openingsDropped,
    };
  }

  const same = w === layout.w && d === layout.d && h === layout.h;
  if (same) return { ok: true, layout, changed: false, rebuilt: false, roomSemantics: ROOM_SEMANTICS.WALLS };

  const wallIndexes = [];
  layout.walls.forEach((wl, index) => {
    const [x, z, xx, zz] = wallSeg(wl);
    if (x < -EPS || x > w + EPS || xx < -EPS || xx > w + EPS
      || z < -EPS || z > d + EPS || zz < -EPS || zz > d + EPS) wallIndexes.push(index);
  });
  const itemIndexes = [];
  layout.items.forEach((it, index) => {
    let out = it.x < -EPS || it.x > w + EPS || it.z < -EPS || it.z > d + EPS;
    const product = getProduct && getProduct(it.p);
    if (!out && product) {
      // 占地四角（与 validate.checkItem 同一套 corners）；这里不判重叠/碰墙，只判越界
      const cs = corners(it.x, it.z, product.w, product.d, it.r);
      out = cs.some(([px, pz]) => px < -EPS || px > w + EPS || pz < -EPS || pz > d + EPS);
    }
    if (out) itemIndexes.push(index);
  });

  const columnIndexes = columnsOutOfBounds(layout, w, d).map((c) => c.index);
  const routeFail = routeBoundsFailure(layout, w, d);
  if (routeFail) return routeFail;

  if (wallIndexes.length || itemIndexes.length || columnIndexes.length) {
    const reason = wallIndexes.length
      ? 'walls-out-of-bounds'
      : (itemIndexes.length ? 'items-out-of-bounds' : 'columns-out-of-bounds');
    const parts = [];
    if (wallIndexes.length) parts.push(`${wallIndexes.length} 面墙（墙 ${wallIndexes.map((i) => `#${i + 1}`).join('、')}）`);
    if (itemIndexes.length) parts.push(`${itemIndexes.length} 台设备`);
    if (columnIndexes.length) parts.push(`${columnIndexes.length} 根柱（柱 ${columnIndexes.map((i) => `#${i + 1}`).join('、')}）`);
    return {
      ok: false,
      reason,
      code: reason,
      message: `场景缩到 ${fmtM(w)} × ${fmtM(d)} m 会让 ${parts.join('、')}跑到场景外 —— 先挪开或删掉它们`,
      wallIndexes,
      itemIndexes,
      columnIndexes,
    };
  }

  const next = { ...layout, w, d, h };
  const labels = carryRoomNames(layout, next, 0, 0);
  if (labels) next.roomLabels = labels;
  else delete next.roomLabels;
  return { ok: true, layout: next, changed: true, rebuilt: false, roomSemantics: ROOM_SEMANTICS.WALLS };
}

/** 位置夹取到房间内（原型拖拽/输入夹取口径：0.1 m 取整在调用方做） */
export function clampToRoom(room, x, z) {
  return {
    x: Math.max(0, Math.min(room.w, x)),
    z: Math.max(0, Math.min(room.d, z)),
  };
}

/** 空布局（原型初始值 w8×d6×h2.8）。**新方案默认 `walls` 语义**（旧方案导入时显式设 legacy） */
export function createLayout({ w = 8, d = 6, h = 2.8 } = {}) {
  return { w, d, h, walls: boundaryWalls(w, d), items: [], roomSemantics: ROOM_SEMANTICS.WALLS };
}

export { EPS };