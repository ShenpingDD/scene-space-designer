/**
 * collision.js —— 规则 4 的通行部分：漫游碰撞与移动（纯函数）
 *
 * 来源：`02_walkthrough.js` 的 `blocked()` / `safeSpawn()` / `moveWithCollision()`。
 * 坐标一律是**房间本地坐标**（0..w / 0..d），与墙、设备同一坐标系 ——
 * 原型是靠 `colliders()` 里手动 translate(w/2,0,d/2) 转换的，这里不引入 Three.js，直接约定。
 *
 * ⚠️ 两条老账（FIX-16 / FIX-17）已经在 **B17 落地时改掉**，这里记下改法与理由：
 *   - FIX-16（门的隐形障碍）：把关口交给**调用方传进来的门叶包围盒** —— 渲染层给的是
 *     "门叶此刻的世界包围盒"，不是扫掠区；并且**关着的门（amount===0）不挡人**
 *     （`blocked()` 只管高度区间，跳过关闭态由调用方做，见 `app/src/scene3d.js` 的 `doorBoxesFor`）。
 *   - FIX-17（嵌进去就永久卡死）：新增 {@link walkStep} —— 发现"已陷在里面"就**放行**
 *     而不是拒绝。往外走一步就不再是嵌入态，下一帧恢复碰撞。
 *     （原先预留的 `escapeTowardCenter` 没有采用：它假设玩家想回房间中心，而嵌进去的人
 *      多半正想往外走；方向让玩家自己定，比替他决定好。那个函数已删除 —— 留着就是死代码。）
 */

import { cfg } from './params.js';
import { segmentDistance } from './geometry.js';
import { wallSolidSegments } from './openings.js';

// 参数见 params.js（原常量 WALK_RADIUS）：cfg.walk.radiusM
// 参数见 params.js（原常量 WALL_CLEARANCE）：cfg.walk.wallClearanceM
// 参数见 params.js（原常量 DOOR_Y）：cfg.walk.doorBarrierMinM, cfg.walk.doorBarrierMaxM
// 参数见 params.js（原常量 STEP_MAX）：cfg.walk.stepMaxM
// 参数见 params.js（原常量 SPAWN_STEP）：cfg.walk.spawnStepM

/**
 * 门障碍是否真挡住人（原型只按高度区间判断）。
 * @param {{minY:number,maxY:number}} box 门在房间本地坐标下的包围盒
 */
export function doorIsBlocking(box) {
  return box.minY < cfg.walk.doorBarrierMaxM && box.maxY > cfg.walk.doorBarrierMinM;
}

/**
 * 该点能否站人（原型 `blocked()`；返回 true = 被挡）。
 * @param {Array<{minX:number,minZ:number,maxX:number,maxZ:number,minY:number,maxY:number}>} doorBoxes
 *        门的世界包围盒（房间本地坐标）——由渲染层从铰链节点的网格算出后传入
 */
export function blocked(x, z, layout, getProduct, doorBoxes = [], radius = cfg.walk.radiusM) {
  // ① 房间边界内缩 radius
  if (x < radius || z < radius || x > layout.w - radius || z > layout.d - radius) return true;

  // ② 墙（含外墙；配合 ① 的有效安全距离因此是 radius + 0.06）
  //    ⭐ W1 门洞：墙不是一整段了 —— 有洞的地方是**实心子段**之间的缺口。
  //    不写"整墙判定 + 洞区间 if-else 放行"：那样 0.1 m 的缝也能钻过去；
  //    子段喂给同一个 segmentDistance() 才是对的几何（窄洞自然过不去，不需要另立规则）。
  for (const w of layout.walls) {
    for (const seg of wallSolidSegments(w)) {
      if (segmentDistance(x, z, seg[0], seg[1], seg[2], seg[3]) < radius + cfg.walk.wallClearanceM) return true;
    }
  }

  // ②b 结构柱：与墙同一把尺子（radius + wallClearance），柱是硬障碍（docs/101 §6.4）
  for (const c of (Array.isArray(layout.columns) ? layout.columns : [])) {
    const hw = c.w / 2;
    const hd = c.d / 2;
    const qx = Math.max(Math.abs(x - c.x) - hw, 0);
    const qz = Math.max(Math.abs(z - c.z) - hd, 0);
    if (Math.hypot(qx, qz) < radius + cfg.walk.wallClearanceM) return true;
  }

  // ③ 设备：把点变换到设备本地系，算到占地矩形的距离（原型做法，等价于圆-矩形相交）
  for (const i of layout.items) {
    const p = getProduct(i.p);
    if (!p) continue;
    const a = (i.r * Math.PI) / 180;
    const dx = x - i.x;
    const dz = z - i.z;
    const lx = Math.cos(a) * dx + Math.sin(a) * dz;
    const lz = -Math.sin(a) * dx + Math.cos(a) * dz;
    const qx = Math.max(Math.abs(lx) - p.w / 2, 0);
    const qz = Math.max(Math.abs(lz) - p.d / 2, 0);
    if (Math.hypot(qx, qz) < radius) return true;
  }

  // ④ 开着的门（原型口径：AABB + 高度区间）
  return doorBoxes.some((b) => doorIsBlocking(b)
    && x > b.minX - radius && x < b.maxX + radius
    && z > b.minZ - radius && z < b.maxZ + radius);
}

/** 玩家当前是否已被几何体嵌入（FIX-17 的判定入口；恒 true 时原型会永久卡死） */
export function isStuck(x, z, layout, getProduct, doorBoxes = [], radius = cfg.walk.radiusM) {
  return blocked(x, z, layout, getProduct, doorBoxes, radius);
}

/** 找一个能站人的出生点（原型 safeSpawn：先试房间中央两处，再 0.35 m 网格扫） */
export function safeSpawn(layout, getProduct, doorBoxes = []) {
  const candidates = [[layout.w / 2, layout.d * 0.75], [layout.w / 2, layout.d / 2]];
  for (let z = 0.4; z < layout.d; z += cfg.walk.spawnStepM) {
    for (let x = 0.4; x < layout.w; x += cfg.walk.spawnStepM) candidates.push([x, z]);
  }
  return candidates.find(([x, z]) => !blocked(x, z, layout, getProduct, doorBoxes)) ?? null;
}

/**
 * 走一步（B17）：**漫游唯一该调用的入口**。
 *
 * ① 正常情形 → {@link moveWithCollision}：分轴判定，撞墙时沿墙滑动而不是完全停住；
 * ② 已经被几何体嵌住（FIX-17）→ **放行这一步**，并回报 `stuck`。
 *
 * 为什么 ② 必须是"放行"而不是"拒绝"：拒绝的话，嵌进去的人**永远出不来** ——
 * 四个方向全被判定为挡（他本来就在障碍里），于是按键没反应，看起来像死机。
 * 放行只影响"已经嵌住"这一种情形：往外走一步就不再嵌着，下一帧立刻恢复碰撞。
 *
 * @returns {{x:number, z:number, stuck:boolean}} `stuck` 要**报给界面**（不许静默）
 */
export function walkStep(x, z, dx, dz, layout, getProduct, doorBoxes = [], radius = cfg.walk.radiusM) {
  if (isStuck(x, z, layout, getProduct, doorBoxes, radius)) {
    return { x: x + dx, z: z + dz, stuck: true };
  }
  const [nx, nz] = moveWithCollision(x, z, dx, dz,
    (tx, tz) => blocked(tx, tz, layout, getProduct, doorBoxes, radius));
  return { x: nx, z: nz, stuck: false };
}

/**
 * 带碰撞的移动（原型 moveWithCollision）：拆成 ≤0.06 m 的小步，
 * 每步分轴判定 —— 撞墙时"沿墙滑动"而不是完全停住。
 * @param {(x:number,z:number)=>boolean} test 返回 true 表示被挡
 */
export function moveWithCollision(x, z, dx, dz, test) {
  const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / cfg.walk.stepMaxM));
  for (let n = 0; n < steps; n++) {
    if (!test(x + dx / steps, z)) x += dx / steps;
    if (!test(x, z + dz / steps)) z += dz / steps;
  }
  return [x, z];
}

