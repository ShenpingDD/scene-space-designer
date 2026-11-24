/**
 * actions.js —— 产品级动作库的纯数据/运行时层
 *
 * 边界：这里只做**动作契约**（校验、规范化、payload）与**可单测的 three 运行时**
 * （目标解析、pivot 外包、按开度写变换）；相机、渲染、界面状态在 detail3d / 组件里。
 *
 * 坐标硬约定（与 `gltf.bindDoors` 完全一致，别再写第二套）：
 *   `motion.pivotMm` 是**模型根 local 的毫米**。先 `root.localToWorld(Vector3(pivotMm))`，
 *   再 `node.parent.worldToLocal()` 放进父节点坐标系；**不许**当成目标节点 local，
 *   **不许**再 /1000（root 的 0.001 缩放会把它变成米）。
 */
import * as THREE from 'three';
import { nodePathOf, pivotMmToRootLocal, preorder } from './hotspot.js';

export const ACTION_KINDS = ['rotate', 'translate', 'visibility', 'clip'];
export const ACTION_KIND_LABEL = {
  rotate: '旋转', translate: '平移', visibility: '显隐', clip: '动画片段',
};
export const ACTION_KEY_RE = /^[a-z0-9_-]+$/;
export const ACTION_MAX = 48;

const finite = (v) => Number.isFinite(Number(v));
const str = (v) => String(v == null ? '' : v).trim();

/** 把接口/编辑器来的动作补齐成稳定形状；不丢未知键，但只认契约字段。 */
export function normalizeAction(raw) {
  const a = raw || {};
  const target = a.target || {};
  const motion = a.motion || {};
  const path = Array.isArray(target.path) ? target.path.map(String).filter(Boolean) : [];
  const index = Number(target.index);
  const outMotion = {};
  if (motion.axis != null && motion.axis !== '') outMotion.axis = String(motion.axis).toLowerCase();
  if (finite(motion.angleDeg)) outMotion.angleDeg = Number(motion.angleDeg);
  if (motion.direction === '+' || motion.direction === '-') outMotion.direction = motion.direction;
  if (Array.isArray(motion.pivotMm) && motion.pivotMm.length === 3) {
    const p = motion.pivotMm.map(Number);
    if (p.every(Number.isFinite)) outMotion.pivotMm = p;
  }
  if (finite(motion.distanceMm)) outMotion.distanceMm = Number(motion.distanceMm);
  if (typeof motion.visible === 'boolean') outMotion.visible = motion.visible;
  if (str(motion.clipName)) outMotion.clipName = str(motion.clipName);
  if (finite(motion.durationMs)) outMotion.durationMs = Number(motion.durationMs);
  if (typeof motion.toggle === 'boolean') outMotion.toggle = motion.toggle;
  return {
    key: str(a.key),
    name: str(a.name),
    kind: str(a.kind),
    target: { path, index: Number.isFinite(index) && index >= 0 ? Math.trunc(index) : 0 },
    motion: outMotion,
  };
}

/** 一条动作的结构校验；界面先拦，服务端仍会再判。 */
export function validateAction(action, ctx = {}) {
  const a = normalizeAction(action);
  const issues = [];
  const push = (code, message) => issues.push({ level: 'bad', code, message });
  if (!a.key) push('action-key-required', '动作 key 必填');
  else if (!ACTION_KEY_RE.test(a.key)) push('action-key-invalid', '动作 key 只能用小写字母、数字、下划线、连字符');
  if (!a.name) push('action-name-required', '动作名称必填');
  else if (a.name.length > 80) push('action-name-too-long', '动作名称超过 80 字');
  if (!ACTION_KINDS.includes(a.kind)) push('action-kind-invalid', '动作类型只能是 rotate/translate/visibility/clip');
  if (!a.target.path.length) push('action-target-required', '动作目标节点必填');
  else if (a.target.path.length > 16) push('action-target-too-deep', '动作目标路径最多 16 层');
  if (!Number.isInteger(a.target.index) || a.target.index < 0 || a.target.index > 10000) {
    push('action-target-index', '目标节点序号必须是 0..10000 的整数');
  }
  if (a.kind === 'rotate') {
    if (!['x', 'y', 'z'].includes(a.motion.axis)) push('action-axis', '旋转需要 axis=x/y/z');
    if (!finite(a.motion.angleDeg) || Math.abs(a.motion.angleDeg) <= 0 || Math.abs(a.motion.angleDeg) > 360) {
      push('action-angle', '旋转需要 0 < |angleDeg| ≤ 360');
    }
    if (a.motion.direction !== '+' && a.motion.direction !== '-') push('action-direction', '旋转需要 direction=+/-');
    if (!Array.isArray(a.motion.pivotMm) || a.motion.pivotMm.length !== 3
      || !a.motion.pivotMm.every(Number.isFinite)) {
      push('action-pivot', '旋转需要 pivotMm 三个有限数（模型根局部 mm）');
    }
  }
  if (a.kind === 'translate') {
    if (!['x', 'y', 'z'].includes(a.motion.axis)) push('action-axis', '平移需要 axis=x/y/z');
    if (!finite(a.motion.distanceMm) || Math.abs(a.motion.distanceMm) <= 0) {
      push('action-distance', '平移需要非零 distanceMm');
    }
  }
  if (a.kind === 'visibility' && typeof a.motion.visible !== 'boolean') {
    push('action-visible', '显隐需要布尔 visible');
  }
  if (a.kind === 'clip') {
    if (!a.motion.clipName) push('action-clip', '动画片段需要 clipName');
    else if (a.motion.clipName.length > 80) push('action-clip-too-long', 'clipName 超过 80 字');
  }
  if (a.motion.durationMs != null
    && (!finite(a.motion.durationMs) || a.motion.durationMs < 100 || a.motion.durationMs > 5000)) {
    push('action-duration', 'durationMs 必须在 100..5000');
  }
  if (a.motion.toggle != null && typeof a.motion.toggle !== 'boolean') {
    push('action-toggle', 'toggle 必须是布尔');
  }
  if (ctx.keys && ctx.keys.has(a.key)) push('action-duplicate-key', '动作 key 重复：' + a.key);
  if (ctx.keys) ctx.keys.add(a.key);
  return issues;
}

export function validateActions(actions = []) {
  const list = Array.isArray(actions) ? actions : [];
  const issues = [];
  if (list.length > ACTION_MAX) issues.push({ level: 'bad', code: 'action-too-many', message: '动作最多 ' + ACTION_MAX + ' 个' });
  const keys = new Set();
  list.forEach((a, i) => {
    for (const x of validateAction(a, { keys })) {
      issues.push({ ...x, index: i, message: '动作 ' + String(i + 1).padStart(2, '0') + '：' + x.message });
    }
  });
  return issues;
}

/** 热点只能引用动作库里真实存在的 key（服务端也会 422，这里先拦）。 */
export function validateActionRefs(hotspots = [], actions = []) {
  const keys = new Set((Array.isArray(actions) ? actions : []).map((a) => str(a && a.key)));
  const issues = [];
  (Array.isArray(hotspots) ? hotspots : []).forEach((h, i) => {
    const key = str(h && h.actionKey);
    if (!key) return;
    if (!keys.has(key)) {
      issues.push({
        level: 'bad', code: 'hotspot-action-unknown', index: i,
        message: '热点 ' + String(i + 1).padStart(2, '0') + ' 绑定的动作不存在：' + key,
      });
    }
  });
  return issues;
}

/** 提交给 PUT /hotspots 的 actions：只保留契约字段、按界面顺序。 */
export function actionsPayload(actions = []) {
  return (Array.isArray(actions) ? actions : []).map(normalizeAction).map((a) => ({
    key: a.key,
    name: a.name,
    kind: a.kind,
    target: { path: a.target.path, index: a.target.index },
    motion: { ...a.motion },
  }));
}

export function actionsByKey(actions = []) {
  const map = new Map();
  for (const a of Array.isArray(actions) ? actions : []) {
    if (a && a.key) map.set(a.key, a);
  }
  return map;
}

/**
 * 解析动作目标。与热点使用同一套路径语义：
 *   · 记录里可能带 `#0` / 场景根 / 加载器包装层前缀；
 *   · `bindDoors` 会在门外面套一层 `door:pivot`（t4 的真实铰链），这层是运行时 artifact，
 *     不是模型节点名 —— 匹配时去掉 `:pivot` 段，否则动作永远找不到门。
 * 只做前缀/包装层对齐，截断后仍要**逐段相等**，不按名字猜。
 */
export function resolveActionTarget(root, target) {
  if (!root || !target) return null;
  const wantPath = Array.isArray(target.path) ? target.path.map(String) : [];
  if (!wantPath.length) return null;
  const wantIndex = Number.isFinite(Number(target.index)) ? Math.max(0, Math.trunc(Number(target.index))) : 0;
  const align = (path) => {
    const p = path.map(String);
    const i = p.indexOf(root.name);
    if (i > 0) return p.slice(i);
    if (i === 0) return p;
    if (p.length && /:((lod[0-9])|single)$/.test(p[0])) return p.slice(1);
    return p;
  };
  const clean = (path) => path.filter((s) => !/:pivot$/.test(s));
  const want = align(wantPath);
  const hits = [];
  for (const x of preorder(root)) {
    // 详情查看器把 root 挂进 scene 后，nodePathOf 会多出 `#0` 包装层；两边都从 root.name 起算。
    if (clean(align(x.path)).join('\u0000') === clean(want).join('\u0000')) hits.push(x);
  }
  const hit = hits[wantIndex] ?? hits[0] ?? null;
  return hit ? hit.node : null;
}

/**
 * 把动作绑到真实节点上，并建**外包变换 Group**（不直接改目标节点，避免与门开度/其他动作
 * 抢同一份 rotation/position）。返回的 bound 交给 `applyAction`。
 *
 * rotate：Group 放在 `pivotMm` 处（root local mm → 世界 → 父 local），`Group.attach(node)`；
 * translate：Group 放在父节点原点；visibility/clip：不包 Group。
 */
export function bindAction(root, action) {
  const a = normalizeAction(action);
  const target = resolveActionTarget(root, a.target);
  const out = {
    key: a.key, kind: a.kind, action: a, target, found: !!target, ok: false, reason: '',
  };
  if (!target) {
    out.reason = 'target-missing';
    out.rootName = root.name;
    out.samplePaths = preorder(root).slice(0, 8).map((x) => x.path);
    return out;
  }
  if (a.kind === 'visibility') {
    out.obj = target;
    out.fromVisible = target.visible !== false;
    out.toVisible = a.motion.visible !== false;
    out.ok = true;
    return out;
  }
  if (a.kind === 'clip') {
    out.obj = target;
    out.ok = true;
    return out;
  }
  const axis = ['x', 'y', 'z'].includes(a.motion.axis) ? a.motion.axis : 'y';
  if (a.kind === 'rotate') {
    const p = a.motion.pivotMm;
    if (!Array.isArray(p) || p.length !== 3 || !p.every(Number.isFinite)) {
      out.reason = 'pivot-required';
      return out;
    }
    root.updateMatrixWorld(true);
    const parent = target.parent;
    if (!parent) {
      out.reason = 'target-no-parent';
      return out;
    }
    // 这扇门已经被 bindDoors 包过一层 `door:pivot`：复用同一 pivot。
    // 否则门控件开 105° + 热点动作再开 105° = 210°，会转穿柜体。
    if (parent.userData && parent.userData.doorPivot === target.name) {
      out.obj = parent;
      out.pivot = parent;
      out.axis = axis;
      out.rest = Number(parent.userData.doorRest) || 0;
      out.reusedDoorPivot = true;
      const sign = a.motion.direction === '-' ? -1 : 1;
      out.angleRad = (Number(a.motion.angleDeg) * Math.PI / 180) * sign;
      const at = parent.getWorldPosition(new THREE.Vector3()).multiplyScalar(1000);
      out.hingeWorldMm = { x: at.x, y: at.y, z: at.z };
      out.pivotDeltaMm = { x: at.x - p[0], y: at.y - p[1], z: at.z - p[2] };
      out.pivotOk = Math.max(
        Math.abs(out.pivotDeltaMm.x), Math.abs(out.pivotDeltaMm.y), Math.abs(out.pivotDeltaMm.z),
      ) <= 2;
      out.ok = true;
      return out;
    }
    const world = root.localToWorld(pivotMmToRootLocal(root, p));
    const pivot = new THREE.Group();
    pivot.name = `${target.name || 'target'}:action:${a.key}:pivot`;
    pivot.position.copy(parent.worldToLocal(world.clone()));
    parent.add(pivot);
    pivot.updateMatrixWorld(true);
    pivot.attach(target);
    root.updateMatrixWorld(true);
    out.obj = pivot;
    out.pivot = pivot;
    out.axis = axis;
    out.rest = Number(pivot.rotation[axis]) || 0;
    const sign = a.motion.direction === '-' ? -1 : 1;
    out.angleRad = (Number(a.motion.angleDeg) * Math.PI / 180) * sign;
    const at = pivot.getWorldPosition(new THREE.Vector3()).multiplyScalar(1000);
    out.hingeWorldMm = { x: at.x, y: at.y, z: at.z };
    out.pivotDeltaMm = {
      x: at.x - p[0], y: at.y - p[1], z: at.z - p[2],
    };
    out.pivotOk = Math.max(Math.abs(out.pivotDeltaMm.x), Math.abs(out.pivotDeltaMm.y), Math.abs(out.pivotDeltaMm.z)) <= 2;
    out.ok = true;
    return out;
  }
  if (a.kind === 'translate') {
    root.updateMatrixWorld(true);
    const parent = target.parent;
    if (!parent) {
      out.reason = 'target-no-parent';
      return out;
    }
    const group = new THREE.Group();
    group.name = `${target.name || 'target'}:action:${a.key}:shift`;
    parent.add(group);
    group.updateMatrixWorld(true);
    group.attach(target);
    root.updateMatrixWorld(true);
    out.obj = group;
    out.axis = axis;
    out.rest = 0;
    out.distanceM = Number(a.motion.distanceMm) / 1000;
    out.ok = true;
    return out;
  }
  out.reason = 'kind-unsupported';
  return out;
}

/** 把动作开度 0..1 写进 bound（rotate/translate 用外包 Group；visibility 二值切换）。 */
export function applyAction(bound, amount) {
  if (!bound || !bound.ok) return;
  const t = Math.min(1, Math.max(0, Number(amount) || 0));
  if (bound.kind === 'rotate') {
    bound.obj.rotation[bound.axis] = bound.rest + bound.angleRad * t;
    bound.obj.updateMatrix();
  } else if (bound.kind === 'translate') {
    bound.obj.position[bound.axis] = bound.rest + bound.distanceM * t;
    bound.obj.updateMatrix();
  } else if (bound.kind === 'visibility') {
    bound.obj.visible = t >= 0.5 ? bound.toVisible : bound.fromVisible;
  }
}

/** 动画片段只对 root 上挂的 clip 列表有效；找不到要如实返回 false，不假播。 */
export function findClip(root, name) {
  const clips = root && root.userData && Array.isArray(root.userData.animations)
    ? root.userData.animations : [];
  const wanted = str(name);
  return clips.find((c) => c && (c.name === wanted || String(c.name) === wanted)) || null;
}

/** 供测试/探针：动作目标相对模型根的局部路径（去掉 `:pivot` 包装层）。 */
export function actionTargetPath(node) {
  return node ? nodePathOf(node).filter((s) => !/:pivot$/.test(s)) : [];
}
