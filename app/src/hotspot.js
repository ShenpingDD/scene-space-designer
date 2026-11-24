/**
 * hotspot.js —— 热点锚点/坐标的纯函数（编辑器与详情查看器共用）
 *
 * 为什么单独抽出来：热点最怕“看起来在同一个点，换个人/换个 LOD 就漂了”。
 * 三件事必须有唯一实现，而且能在 node 里单测：
 *   ① 锚点身份：`nodePath[]`（含模型根名）+ `nodeIndex`（同一 path 的先序序号）；
 *   ② 坐标：存「锚点节点局部米」= 节点局部坐标 × 锚点世界等比缩放；
 *   ③ 法线：存节点局部方向（不乘缩放），读端用同一套逆变换。
 *
 * 三条硬约定（对应 设计决策记录 §五、设计决策记录）：
 *   - 不用 `getObjectByName` 解析（重名节点只返回第一个，静默错位）；
 *   - `nodeName` 只做显示，不参与唯一键；
 *   - 世界缩放三轴不等比 → 返回 null，由调用方报 `unit-mismatch`，不硬算。
 */
import * as THREE from 'three';

const EPS = 1e-4;

/** 根到节点的名字链（含根名；空名用 `#` + 同级序号兜底，保证路径可读）。 */
export function nodePathOf(node) {
  const chain = [];
  let cur = node;
  while (cur) {
    chain.push(cur.name || `#${siblingIndex(cur)}`);
    cur = cur.parent;
  }
  return chain.reverse();
}

function siblingIndex(node) {
  const p = node.parent;
  if (!p) return 0;
  return p.children.indexOf(node);
}

/** 先序遍历（three.js traverse 顺序），返回 {node,path,index} 列表。 */
export function preorder(root) {
  const out = [];
  const seen = new Map();
  root.traverse((node) => {
    const path = nodePathOf(node);
    const key = path.join('\u0000');
    const n = seen.get(key) || 0;
    seen.set(key, n + 1);
    out.push({ node, path, index: n });
  });
  return out;
}

/** 按 `nodePath + nodeIndex` 定位；失败返回 null（绝不按名字兜底）。
 *
 * 门/盖被 `bindDoors` 包进 `${name}:pivot` 后，实际路径会多一段运行时包装；
 * 数据里的 `nodePath` 是模型作者路径，不含这层包装。这里只清理 `:pivot`
 * 合成段，其余路径段仍逐字匹配——不是按名字兜底。
 */
export function resolveNode(root, path, index = 0) {
  if (!root || !Array.isArray(path)) return null;
  const clean = (p) => p.filter((s) => !/:pivot$/.test(String(s)));
  const want = clean(path.map((s) => String(s)));
  const hit = preorder(root).find((x) => x.index === Number(index)
    && clean(x.path).length === want.length
    && clean(x.path).every((v, i) => v === want[i]));
  return hit ? hit.node : null;
}

/** 给一个节点算 `{path,index}`；找不到根链时 index 仍按同级路径计数。 */
export function anchorOf(root, node) {
  const hit = preorder(root).find((x) => x.node === node);
  return hit ? { path: hit.path, index: hit.index } : null;
}

/** 锚点世界缩放（标量）。三轴不等比或无效 → null，调用方报 `unit-mismatch`。 */
export function uniformWorldScale(node) {
  if (!node) return null;
  node.updateWorldMatrix(true, false);
  const s = new THREE.Vector3().setFromMatrixScale(node.matrixWorld);
  if (![s.x, s.y, s.z].every((v) => Number.isFinite(v) && v > 0)) return null;
  if (Math.max(s.x, s.y, s.z) / Math.min(s.x, s.y, s.z) > 1 + EPS) return null;
  return s.x;
}

/**
 * 世界点 → 存储坐标（锚点节点局部米）。
 * @returns {{x:number,y:number,z:number}|null} 非等比缩放时 null
 */
export function toStoredPosition(node, worldPoint) {
  const scale = uniformWorldScale(node);
  if (scale == null || !worldPoint) return null;
  const local = node.worldToLocal(worldPoint.clone());
  return { x: local.x * scale, y: local.y * scale, z: local.z * scale };
}

/** 存储坐标 → 世界点（读端）。非等比缩放仍返回 null，不猜。 */
export function toWorldPosition(node, stored) {
  const scale = uniformWorldScale(node);
  if (scale == null || !stored) return null;
  const local = new THREE.Vector3(Number(stored.x) / scale, Number(stored.y) / scale, Number(stored.z) / scale);
  if (![local.x, local.y, local.z].every(Number.isFinite)) return null;
  return node.localToWorld(local);
}

/**
 * 铰链点 `pivotMm`（契约单位：mm）→ 模型根 local 坐标。
 *
 * 为什么不能直接 `localToWorld(pivotMm)`：`normalizeToMeters()` 只给根加缩放，
 * 不改根内部的坐标单位。352 这类历史 mm 件根内就是 mm，0.001 缩放会把它变米；
 * 而 Blender 导出的米制件根内已经是米，extras 里的铰链点却仍按 mm 写。
 * 直接传会把 260mm 当成 260m，门一开就飞出视野（464 的真实故障）。
 * 只认 `parseGlbBuffer` 记下的唯一来源 `userData.modelUnit.sourceUnit`，不猜别的。
 */
export function pivotMmToRootLocal(root, pivotMm) {
  if (!root || !Array.isArray(pivotMm) || pivotMm.length !== 3) return null;
  const nums = pivotMm.map(Number);
  if (!nums.every(Number.isFinite)) return null;
  const v = new THREE.Vector3(nums[0], nums[1], nums[2]);
  if (root.userData && root.userData.modelUnit && root.userData.modelUnit.sourceUnit === 'm') {
    v.multiplyScalar(0.001);
  }
  return v;
}

/**
 * 换锚点：把旧锚点下的存储坐标换成新锚点下的存储坐标，世界位置保持不变。
 * 换锚点最常见的错误是「拿新锚点解释旧局部值」，那会让热点整体平移一个锚点原点差。
 * @returns {{x:number,y:number,z:number}|null} 旧/新锚点不可换算或往返校验失败时 null
 */
export function reanchorStoredPosition(fromNode, toNode, stored) {
  if (!fromNode || !toNode) return null;
  const world = toWorldPosition(fromNode, stored);
  if (!world) return null;
  const next = toStoredPosition(toNode, world);
  if (!next) return null;
  const back = toWorldPosition(toNode, next);
  if (!back || back.distanceTo(world) > EPS) return null;
  return next;
}

/**
 * 世界法线 → 存储法线（锚点节点局部方向，归一化、不乘缩放）。
 * 用 normalMatrix 的逆转置，避免非等比缩放把方向拉歪；等比时与直接变换等价。
 */
export function toStoredNormal(node, worldNormal) {
  if (!node || !worldNormal) return null;
  node.updateWorldMatrix(true, false);
  const n = worldNormal.clone().normalize();
  const normalMatrix = new THREE.Matrix3().getNormalMatrix(node.matrixWorld);
  const local = n.applyMatrix3(normalMatrix).normalize();
  return { x: local.x, y: local.y, z: local.z };
}

/** 存储法线 → 世界方向（读端）。 */
export function toWorldNormal(node, stored) {
  if (!node || !stored) return null;
  node.updateWorldMatrix(true, false);
  const n = new THREE.Vector3(Number(stored.x), Number(stored.y), Number(stored.z));
  if (![n.x, n.y, n.z].every(Number.isFinite) || n.lengthSq() < 1e-12) return null;
  n.normalize().transformDirection(node.matrixWorld).normalize();
  return n;
}

/** 门状态是否显示：v1 所有门共用一个 doorAmount（0=关，1=开）。 */
export function doorStateVisible(doorState, doorAmount) {
  if (doorState === 'open') return Number(doorAmount) >= 0.5;
  if (doorState === 'closed') return Number(doorAmount) < 0.5;
  return true;
}

/** 归一化相机 → 合法范围（存进快照前调用）。 */
export function normalizeCamera(camera) {
  const c = camera || {};
  const clamp = (v, lo, hi, d) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
  };
  const target = Array.isArray(c.target) ? c.target : [0.5, 0.5, 0.5];
  return {
    azimuthDeg: clamp(c.azimuthDeg, -180, 180, 30),
    elevationDeg: clamp(c.elevationDeg, -5, 85, 12),
    distFactor: clamp(c.distFactor, 0.8, 4, 1.8),
    target: [0, 1, 2].map((i) => clamp(target[i], 0, 1, 0.5)),
    fov: clamp(c.fov, 20, 70, 42),
  };
}
