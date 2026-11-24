/**
 * detail3d.js —— 设计端「产品 3D 详情」的渲染层
 *
 * 为什么**另起一个实例**、而不是复用主画布那份 `scene3d.js`：
 *   · 主画布是"方案场景"（多台设备、可选中、可编辑、按需要渲染）；详情是"单台产品 + 热点"，
 *     两边的相机、门控、生命周期都不一样；
 *   · `scene3d.js` 是**模块级单例**（`view3d.attach()` 已挂会静默 return，`dispose()` 会丢上下文），
 *     详情里再挂一次就会跟主画布抢同一个渲染器 —— 关掉详情把主画布的 WebGL 上下文也丢了。
 * 所以这里自己建 renderer / camera / OrbitControls，只在**详情容器**里活；
 * 模型加载、校准、门绑定仍然复用 `gltf.js`，锚点解析复用 `hotspot.js` —— 不写第二套几何/坐标逻辑。
 *
 * 纯函数（`chooseDetailLevel` / `cameraPose` / `projectPoint` / `resolveHotspots` …）都单独导出，
 * 于是 `app/test/detail.test.js` 能在 node 里直接钉住"LOD 选级、锚点解析、投影、门状态门控"这几条判据。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  applyDoor, assetUrl, bindDoors, countTriangles, entryOf, fitClone, loadAsset, loadCatalogs,
  parseGlbBuffer,
} from './gltf.js';
import {
  doorStateVisible, normalizeCamera, resolveNode, toWorldPosition, uniformWorldScale,
} from './hotspot.js';
import { applyAction, bindAction, findClip } from './actions.js';

/** 详情固定用哪一级（设计决策记录：详情 LOD1，编辑器 LOD0） */
export const DETAIL_LEVEL = 'lod1';

/** 详情里最多同时算几个遮挡（设计决策记录：6–8 Hz 节流、每帧最多 8 个轮转） */
export const OCCLUSION_PER_TICK = 8;
export const OCCLUSION_MIN_MS = 120;

/**
 * 从"这一级真的存在"的列表里挑详情用的一级。
 * 优先级：lod1（准则）→ lod0（没有 lod1 时宁可清楚）→ 剩下的第一级。
 * 返回 null 表示没有可用级别（调用方要明说，不要假装加载成功）。
 */
export function chooseDetailLevel(levels = []) {
  const have = (levels ?? []).filter(Boolean);
  if (!have.length) return null;
  for (const want of ['lod1', 'lod0', 'lod2']) {
    if (have.includes(want)) return want;
  }
  return have[0];
}

/**
 * 把详情接口给的热点分成"能画"与"要显示原因"两类（不静默丢）。
 *
 * 接口返回的 `hotspots[]` 按 105 约定只有 valid；但**本地仍要再解析一遍**：
 * 模型文件与发布快照可能已经不是同一份（换模型/换 LOD），这时画出来的标记会飘到别的零件上。
 * 解析失败的原因代码与编辑器同表：`anchor-missing` / `unit-mismatch`（105 §7.1）。
 */
export function resolveHotspots(root, hotspots = []) {
  const resolved = [];
  const failed = [];
  for (const h of hotspots ?? []) {
    if (!h) continue;
    const { node, reason, detail } = resolveOne(root, h);
    if (node) resolved.push({ hotspot: h, node });
    else failed.push({ hotspot: h, reason, detail });
  }
  return { resolved, failed };
}

/**
 * 解析**一条**热点。三个坑都在这里收口：
 *   ① 路径前缀：记录里可能带场景根 / 加载器给的那层 `modelCode:level`（见 `pathWithin`）；
 *   ② 基准节点：`gltf.js` 的加载结果是一个"包装层"（名字被改成 `MODEL:lod1`），
 *      真正的模型根是它的子节点 —— 路径第一段指向谁，就以谁为基准；
 *   ③ 祖先干扰：three 的 `nodePathOf` 会一路走到场景根，所以解析的瞬间要把基准节点**摘下来**，
 *      否则路径里会多出一段（`#0` 或包装层名），逐段比较必然失败。
 */
function resolveOne(root, h) {
  const base = baseFor(root, h.nodePath);
  const path = pathWithin(base, h.nodePath);
  const parent = base.parent;
  const at = parent ? parent.children.indexOf(base) : -1;
  if (parent) parent.remove(base);
  let node = null;
  try {
    base.updateWorldMatrix(true, true);
    node = resolveNode(base, path, h.nodeIndex ?? 0);
  } finally {
    if (parent) {
      parent.add(base);
      if (at >= 0) {
        parent.children.splice(parent.children.indexOf(base), 1);
        parent.children.splice(at, 0, base);
      }
      base.updateWorldMatrix(true, true);
    }
  }
  if (!node) return { node: null, reason: 'anchor-missing', detail: (h.nodePath ?? []).join('/') };
  if (uniformWorldScale(node) == null) {
    return { node: null, reason: 'unit-mismatch', detail: '锚点世界缩放不等比' };
  }
  if (!toWorldPosition(node, h.position)) {
    return { node: null, reason: 'unit-mismatch', detail: '锚点局部坐标无法换算' };
  }
  return { node };
}

/** 路径第一段指向哪个节点，就以哪个节点为"模型根"（包装层不算模型根） */
export function baseFor(root, path) {
  if (!root) return root;
  const p = pathWithin(root, path);
  if (!p.length) return root;
  if (p[0] === root.name) return root;
  const child = (root.children ?? []).find((c) => c.name === p[0]);
  return child ?? root;
}

/**
 * `nodePath` 的语义是「**模型根 → 节点**」的名字链（105 §十三：含根名，`[]` = 模型根）。
 *
 * 但 three 的 `nodePathOf` 从节点一路走到**它当时所在的场景根**，多出来的前缀段
 * （`gltf.scene` 常常没有名字，于是是 `#0`）会出现在路径里。所以这里做一次**前缀对齐**：
 *   · 第一段就是模型根名 → 原样用；
 *   · 模型根名出现在后面某一段 → 从它开始截断（兼容"记录时把场景根也记进去了"的老数据）。
 * 这只是对齐前缀，**不猜节点**：截断之后的路径仍然要逐段相等、序号仍然要一致。
 */
export function pathWithin(root, path) {
  const p = (path ?? []).map(String);
  if (!p.length || !root) return p;
  if (p[0] === root.name) return p;
  const i = p.indexOf(root.name);
  if (i > 0) return p.slice(i);
  // 加载器把包装层命名成 `MODEL:lod1`（gltf.js:loadAsset）：这一段是**实现artifact**，
  // 不是 GLB 里的节点名。编辑器若照加载结果记录路径，第一段就会是它 —— 跨 LOD 必然对不上，
  // 而模型其实没变。所以带 `:lodN` / `:single` 后缀的第一段直接去掉。
  if (/:((lod[0-9])|single)$/.test(p[0])) return p.slice(1);
  return p;
}

/** 热点此刻该不该显示（只由 `doorState` 与当前门开度决定，`any` 恒显） */
export function visibleAtDoor(hotspot, doorAmount) {
  return doorStateVisible(hotspot?.doorState ?? 'any', doorAmount);
}

/**
 * 模型包围盒 → `{center, size}` 的纯数据（单位米，与 fitClone 同一套世界坐标）。
 * 相机算式只吃这两个数组，于是不用在测试里造 three 对象。
 */
export function boxOf(object) {
  const box = new THREE.Box3().setFromObject(object);
  const c = box.getCenter(new THREE.Vector3());
  const s = box.getSize(new THREE.Vector3());
  return { center: [c.x, c.y, c.z], size: [s.x, s.y, s.z] };
}

/**
 * 归一化相机 → 世界机位。**这是 `hotspot.normalizeCamera` 的读端**（存的是 0..1 的参数，
 * 换成实际坐标只在这里做一次）：同一款产品的不同变体尺寸不同，存绝对坐标必然钻模型或飞出画面。
 *
 * `distFactor` 的基准距离 = 让竖直方向刚好装下模型的透视距离（`radius / tan(fov/2)`），
 * 所以 `1.0` 永远是"贴着装下"，与模型尺寸无关。
 */
export function cameraPose(camera, box) {
  const c = normalizeCamera(camera);
  const size = box?.size ?? [1, 1, 1];
  const center = box?.center ?? [0, 0, 0];
  const radius = Math.max(size[0], size[1], size[2], 1e-6) * 0.5;
  const fovRad = (c.fov * Math.PI) / 180;
  const refDist = radius / Math.tan(fovRad / 2);
  const dist = refDist * c.distFactor;

  const az = (c.azimuthDeg * Math.PI) / 180;
  const el = (c.elevationDeg * Math.PI) / 180;
  const target = [
    center[0] + (c.target[0] - 0.5) * size[0],
    center[1] + (c.target[1] - 0.5) * size[1],
    center[2] + (c.target[2] - 0.5) * size[2],
  ];
  const position = [
    target[0] + dist * Math.cos(el) * Math.sin(az),
    target[1] + dist * Math.sin(el),
    target[2] + dist * Math.cos(el) * Math.cos(az),
  ];
  return { position, target, fov: c.fov };
}

/** 世界点 → 容器内的 CSS 像素坐标（左上原点）；`visible=false` 表示在相机背后/屏幕外 */
export function projectPoint(world, camera, width, height) {
  // 相机刚被 applyPose 摆放时，matrixWorld（及它的逆）可能还是上一帧的；先刷新再投影，
  // 否则热点会被算到“相机背后”（真实详情里表现为索引有、舞台一个标记都没有）。
  camera.updateMatrixWorld(true);
  camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
  const v = new THREE.Vector3(world[0], world[1], world[2]).project(camera);
  const behind = v.z > 1 || v.z < -1;
  const x = (v.x * 0.5 + 0.5) * width;
  const y = (-v.y * 0.5 + 0.5) * height;
  const inside = !behind && x >= -40 && x <= width + 40 && y >= -40 && y <= height + 40;
  return { x, y, depth: v.z, behind, inside, visible: inside };
}

/* ---------------- 详情接口的读端（形状归一 + 人话原因）----------------
 *
 * 105 的详情响应有两种来源：`published`（发布快照）与 `legacy-projection`（老产品的只读投影：
 * `product.description` + `product_note`）。两者形状**不一样**（投影的 params 是 `[[label,value]]`），
 * 归一化只在这里做一次 —— 界面不写 if 判断来源。
 */
export function contentOf(detail) {
  const c = detail?.content ?? {};
  return {
    description: String(c.description ?? '').trim(),
    // 三种形状都要认：发布快照 `{label,text}`、只读投影的 `[label, value]`、以及投影里
    // "名称：内容" 的整串（`product_note(feature)` 就是按这个口径拼的）
    sellingPoints: (c.sellingPoints ?? []).map((sp) => {
      if (Array.isArray(sp)) return { label: String(sp[0] ?? ''), text: String(sp[1] ?? '') };
      if (typeof sp === 'string') {
        const i = sp.indexOf('：');
        return i > 0
          ? { label: sp.slice(0, i), text: sp.slice(i + 1) }
          : { label: '', text: sp };
      }
      return { label: String(sp?.label ?? ''), text: String(sp?.text ?? sp?.value ?? '') };
    }).filter((sp) => sp.text),
    params: (c.params ?? []).map((it) => (Array.isArray(it)
      ? { key: String(it[0] ?? ''), value: String(it[1] ?? ''), unit: '', group: '' }
      : {
        key: String(it?.key ?? it?.label ?? ''),
        value: String(it?.value ?? ''),
        unit: String(it?.unit ?? ''),
        group: String(it?.group ?? ''),
      })).filter((it) => it.key || it.value),
  };
}

/** 失效原因 → 用户能读懂的一句话（界面不显示代码本身；代码进 `title`，便于对表排错） */
export const REASON_TEXT = {
  'anchor-missing': '锚点节点在当前模型里找不到',
  'index-out-of-range': '同名节点的序号越界（这一版模型里少了几个同名节点）',
  'unit-mismatch': '锚点所在节点的缩放不等比，坐标可能已失真',
  'model-changed': '模型已更新，标注位置需要复核',
};

export function reasonText(reason) {
  return REASON_TEXT[reason] ?? '标注需要复核（原因未知）';
}

/**
 * 失效清单：接口自己报的（`invalidReasons`，服务端按指纹算的 `model-changed` 等）
 * **加上**本地解析失败的（画不出来就是失效，哪怕接口说它是 valid）。
 * 两边都保留 —— 这是"不静默少显示"的落点：数量与原因都要能问出来。
 */
export function invalidRows(detail, localFailed = []) {
  const rows = [];
  const seen = new Set();
  for (const r of detail?.invalidReasons ?? []) {
    const id = r?.hotspotId ?? r?.id ?? null;
    const key = `${id}:${r?.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      id, reason: r?.reason ?? 'unknown', detail: r?.detail ?? '', title: r?.title ?? '',
    });
  }
  for (const f of localFailed) {
    const id = f?.hotspot?.id ?? null;
    const key = `${id}:${f?.reason}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      id, reason: f?.reason ?? 'unknown', detail: f?.detail ?? '', title: f?.hotspot?.title ?? '',
    });
  }
  return rows;
}

/** 产品标题上的角标（没热点 / 有失效 / 全部有效），文案由界面再翻译 */
export function hotspotStatus(detail, invalidCount) {
  const total = detail?.counts?.total ?? (detail?.hotspots ?? []).length;
  if (!total) return 'none';
  return invalidCount > 0 ? 'review' : 'ok';
}

/** 详情默认机位（与主画布 `SHOT_VIEWS` 同口径的归一化参数，不存绝对坐标） */
export const DEFAULT_CAMERA = {
  azimuthDeg: 32, elevationDeg: 14, distFactor: 1.9, target: [0.5, 0.52, 0.5], fov: 42,
};

/** 把一条门的开度写进 three 节点（复用 gltf 的 applyDoor：有 pivot 就转 pivot，不转门中心） */
function applyDoors(bound, amount) {
  for (const b of bound) applyDoor(b, amount);
}

/** hingeAxis / axis 可以是 [0,1,0] 或 "y"；返回主轴与分量正负。 */
function axisInfoOf(raw) {
  if (typeof raw === 'string') {
    const a = raw.trim().toLowerCase();
    return ['x', 'y', 'z'].includes(a) ? { axis: a, sign: 1 } : null;
  }
  if (Array.isArray(raw) && raw.length === 3) {
    const v = raw.map(Number);
    if (!v.every(Number.isFinite)) return null;
    const abs = v.map(Math.abs);
    const max = Math.max(...abs);
    if (!(max > 0)) return null;
    const i = abs.indexOf(max);
    return { axis: ['x', 'y', 'z'][i], sign: v[i] < 0 ? -1 : 1 };
  }
  if (raw && typeof raw === 'object' && typeof raw.axis === 'string') return axisInfoOf(raw.axis);
  return null;
}

/**
 * 从**已加载的模型节点 extras** 推导门表。
 *
 * 352（DEMO-SC-100）的门节点名叫 `door`，不在任何约定名单里；但它的 extras 明确写了
 * `partType:"door_single"`、`hingeAxis:[0,1,0]`、`hingePoint:[287.71,70,363]`、
 * `openAngleDeg:105`、`openDirection:"+"`。详情页不依赖 `product.hinges`（那是配方声明，
 * 352 为空），直接读模型自己的声明 —— 名称只是名字，零件类型才是事实。
 * 379 只有一个 `1200E` 节点、没有任何可动件 extras，因此返回空表（页面必须明说）。
 */
/** 只把真正的铰链门/上盖算进 `bindDoors`；抽屉是平移件，不能绕中心转。
 *  `doorsFromScene` 仍返回抽屉，供动作库选目标；调用 `bindDoors` 前必须过滤。 */
export function isHingedDoorPart(d) {
  const type = String(d && d.partType || '').toLowerCase();
  if (d && d.motion === 'translate') return true; // 滑门/sash：不是绕轴转，但确实可动
  if (!type) return true; // 目录里声明式门表没有 partType：按门处理
  if (/drawer/.test(type)) return false;
  return /door|lid|sash/.test(type);
}

export function doorsFromScene(root) {
  const out = [];
  if (!root || typeof root.traverse !== 'function') return out;
  root.traverse((o) => {
    if (!o.name) return;
    const u = o.userData || {};
    const nested = u.hinge && typeof u.hinge === 'object' ? u.hinge : null;
    const partType = typeof u.partType === 'string' ? u.partType : (nested && nested.partType);
    const type = String(partType || '').toLowerCase();
    const pivotRaw = Array.isArray(u.hingePoint) ? u.hingePoint : (nested && nested.pivotMm);
    const pivotMm = Array.isArray(pivotRaw) && pivotRaw.length === 3 ? pivotRaw.map(Number) : null;
    const hasPivot = !!pivotMm && pivotMm.every(Number.isFinite);
    const slideRaw = Number(u.slideDistanceMm);
    const slideMm = Number.isFinite(slideRaw) && slideRaw > 0 ? slideRaw : null;
    const motion = slideMm || /sliding/.test(String(u.part || '')) ? 'translate' : 'rotate';
    const movable = ((/door|lid|drawer|sash/.test(type) && type !== 'body') || !!nested || !!slideMm);
    if (!movable && !hasPivot) return;
    const axisInfo = axisInfoOf(u.hingeAxis) || axisInfoOf(nested && nested.axis);
    const slideAxis = ['x', 'y', 'z'].includes(String(u.slideAxis || '').toLowerCase())
      ? String(u.slideAxis).toLowerCase() : null;
    // sash 是前窗，沿 y 上滑；滑动门沿 x；模型显式给 slideAxis 时以模型为准。
    const axis = motion === 'translate'
      ? (slideAxis || (/sash/.test(type) ? 'y' : 'x'))
      : (axisInfo ? axisInfo.axis : (/lid|drawer/.test(type) ? 'x' : 'y'));
    const degRaw = typeof u.openAngleDeg !== 'undefined'
      ? Number(u.openAngleDeg)
      : (nested && typeof nested.angle === 'number' ? nested.angle * 180 / Math.PI : NaN);
    const dirRaw = typeof u.openDirection === 'string' ? u.openDirection : (nested && nested.dir);
    const dir = dirRaw === '-' || dirRaw === '+' ? dirRaw : null;
    const sign = (dir === '-' ? -1 : 1) * (axisInfo ? axisInfo.sign : 1);
    out.push({
      node: o.name,
      axis,
      // 这里只给**正的开角**；方向单独交给 openDirection，bindDoors 乘一次符号。
      // 两处都乘 = 负负得正（反向门会朝柜内开）。
      openAngleRad: motion === 'translate' ? 0 : (Number.isFinite(degRaw) ? (degRaw * Math.PI) / 180 : 1.85),
      pivotMm: hasPivot ? pivotMm : null,
      openDirection: dir == null ? null : (sign < 0 ? '-' : '+'),
      fromExtras: true,
      partType: partType || null,
      motion,
      slideMm,
    });
  });
  return out;
}

/** 声明的门表优先；声明里缺的铰链事实用模型 extras 补齐（不覆盖已有值）。 */
function mergeDoors(declared, derived) {
  const real = (derived || []).filter(isHingedDoorPart);
  if (!real.length) return declared;
  if (!declared.length) return real;
  const byNode = new Map(real.map((d) => [d.node, d]));
  return declared.map((d) => {
    const s = byNode.get(d.node);
    if (!s) return d;
    return {
      ...d,
      pivotMm: d.pivotMm ?? s.pivotMm,
      openDirection: d.openDirection ?? s.openDirection,
      openAngleRad: d.openAngleRad ?? s.openAngleRad,
      partType: d.partType ?? s.partType,
      motion: d.motion ?? s.motion,
      slideMm: d.slideMm ?? s.slideMm,
      axis: d.axis ?? s.axis,
    };
  });
}

/**
 * 建一个详情查看器。**用法**：
 *   const v = createDetailViewer({ onFrame }); v.attach(canvas); await v.load(product);
 *   v.setDoor(1); v.project(list); … v.dispose();
 *
 * `onFrame` 每次渲染后调一次（界面据此重新算标记位置）；**不传也不会坏**（纯渲染）。
 */
export function createDetailViewer({ onFrame, onStatus } = {}) {
  let renderer = null;
  let scene = null;
  let camera = null;
  let controls = null;
  let canvas = null;
  let root = null;
  let bound = [];
  let occlusion = [];
  let raycaster = null;
  let frameNo = 0;
  let dirty = false;
  let rafId = 0;
  let destroyed = false;
  let doorAmount = 0;
  let doorAnim = null;
  // 动作按 actionKey 各记一份状态：重复点击从当前开度接着走，换热点不会叠两段动画。
  const actionBounds = new Map();
  const actionAnims = new Map();   // key -> { raf, amount, bound, clip, mixer }
  const actionAmount = new Map();  // key -> 0..1
  let lastOcclusionAt = 0;
  let occlusionCursor = 0;
  let occluded = new Map();
  let probe = { level: null, triangles: 0, calls: 0, textures: 0, sizeMm: null };
  let lastPose = { ...DEFAULT_CAMERA };
  let requestedLevel = DETAIL_LEVEL;

  const reduceMotion = () => typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function requestRender() { dirty = true; schedule(); }

  function schedule() {
    if (rafId || destroyed) return;
    rafId = requestAnimationFrame(() => { rafId = 0; draw(); });
  }

  function draw() {
    if (destroyed || !renderer || !camera) return;
    if (!dirty && !controls?.enableDamping) return;
    dirty = false;
    const w = canvas?.clientWidth || 1;
    const h = canvas?.clientHeight || 1;
    if (canvas && (canvas.width !== Math.floor(w * renderer.getPixelRatio())
      || canvas.height !== Math.floor(h * renderer.getPixelRatio()))) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    renderer.render(scene, camera);
    frameNo += 1;
    probe.calls = renderer.info.render.calls;
    probe.textures = renderer.info.memory.textures;
    if (typeof onFrame === 'function') onFrame({ frame: frameNo });
  }

  function applyPose(pose) {
    if (!camera) return;
    camera.position.set(pose.position[0], pose.position[1], pose.position[2]);
    camera.fov = pose.fov;
    camera.updateProjectionMatrix();
    if (controls) {
      controls.target.set(pose.target[0], pose.target[1], pose.target[2]);
      controls.update();
    }
    // OrbitControls 的 update 依赖内部 spherical；显式 lookAt 一次，保证相机真的朝向 target。
    camera.lookAt(pose.target[0], pose.target[1], pose.target[2]);
    camera.updateMatrixWorld(true);
    camera.matrixWorldInverse.copy(camera.matrixWorld).invert();
    lastPose = { ...pose };
    requestRender();
  }

  /** 当前机位 → 归一化参数（只用于读数/探针；详情是只读，不回写任何东西） */
  function orbitState() {
    if (!camera) return { ...DEFAULT_CAMERA };
    const target = [controls?.target.x ?? 0, controls?.target.y ?? 0, controls?.target.z ?? 0];
    const pos = camera.position;
    const dx = pos.x - target[0];
    const dy = pos.y - target[1];
    const dz = pos.z - target[2];
    const dist = Math.max(Math.hypot(dx, dy, dz), 1e-6);
    const box = root ? boxOf(root) : { center: [0, 0, 0], size: [1, 1, 1] };
    const radius = Math.max(box.size[0], box.size[1], box.size[2], 1e-6) * 0.5;
    const refDist = radius / Math.tan((camera.fov * Math.PI) / 360);
    const size = box.size;
    return normalizeCamera({
      azimuthDeg: (Math.atan2(dx, dz) * 180) / Math.PI,
      elevationDeg: (Math.asin(Math.max(-1, Math.min(1, dy / dist))) * 180) / Math.PI,
      distFactor: dist / refDist,
      target: [
        size[0] ? (target[0] - box.center[0]) / size[0] + 0.5 : 0.5,
        size[1] ? (target[1] - box.center[1]) / size[1] + 0.5 : 0.5,
        size[2] ? (target[2] - box.center[2]) / size[2] + 0.5 : 0.5,
      ],
      fov: camera.fov,
    });
  }

  /** 遮挡：相机→热点射线，射程 = 距离 − 1cm（打到锚点自己不算） */
  function isOccluded(world, h) {
    if (!raycaster || !occlusion.length) return false;
    const origin = camera.position;
    const dir = new THREE.Vector3(world[0] - origin.x, world[1] - origin.y, world[2] - origin.z);
    const dist = dir.length();
    if (!(dist > 0.02)) return false;
    raycaster.set(origin, dir.normalize());
    raycaster.far = dist - 0.01;
    raycaster.near = 0.01;
    const hits = raycaster.intersectObjects(occlusion, false);
    if (!hits.length) return false;
    // 锚点自己所在的那一层网格被点到不算遮挡（热点就贴在上面）
    const own = h?.node;
    return hits.some((hit) => {
      let cur = hit.object;
      while (cur) { if (cur === own) return false; cur = cur.parent; }
      return true;
    });
  }

  return {
    attach(el) {
      canvas = el;
      renderer = new THREE.WebGLRenderer({ canvas: el, antialias: true });
      renderer.setPixelRatio(Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1));
      renderer.setClearColor(0xf2f6f9, 1);
      scene = new THREE.Scene();
      scene.add(new THREE.HemisphereLight(0xffffff, 0x9fb3c0, 2.1));
      const key = new THREE.DirectionalLight(0xffffff, 1.6);
      key.position.set(2.4, 3.6, 2.2);
      scene.add(key);
      const fill = new THREE.DirectionalLight(0xffffff, 0.55);
      fill.position.set(-2.2, 1.4, -2.6);
      scene.add(fill);
      camera = new THREE.PerspectiveCamera(DEFAULT_CAMERA.fov, 1, 0.02, 60);
      controls = new OrbitControls(camera, el);
      controls.enableDamping = false;   // 按需渲染：阻尼会持续要帧，本环境 rAF 还会被暂停
      controls.enablePan = true;
      controls.minDistance = 0.2;
      controls.maxDistance = 20;
      controls.maxPolarAngle = Math.PI * 0.98;
      controls.addEventListener('change', () => { dirty = true; schedule(); });
      raycaster = new THREE.Raycaster();
      applyPose(cameraPose(DEFAULT_CAMERA, { center: [0, 0, 0], size: [1, 1, 1] }));
      renderer.setSize(el.clientWidth || 1, el.clientHeight || 1, false);
      camera.aspect = (el.clientWidth || 1) / (el.clientHeight || 1);
      camera.updateProjectionMatrix();
      requestRender();
      return this;
    },

    /**
     * 载入一款产品的模型。两条路（静态离线资产 / 上传件），都在这里收口：
     *   · 静态型号：`gltf.loadAsset(id, lod1)` —— 走 lod.manifest 的清单，选级有据可查；
     *   · 上传件：目录里的 `assetFile` 是绝对路径（`/api/assets/...`），直接取字节再解析，
     *     没有 LOD 清单可选，因此 `level` 回报为 `single`（界面照实说，不假装是 lod1）。
     */
    async load(product, opts = {}) {
      if (!scene) throw new Error('viewer 还没 attach');
      this.clear();
      const catalogs = await loadCatalogs().catch(() => null);
      let level = null;
      let entry = entryOf(product?.id ?? '') ? entryOf(product.id) : null;
      let sourceRoot = null;

      if (entry) {
        const avail = entry.lods.filter((l) => l.file).map((l) => l.level);
        level = chooseDetailLevel(avail) ?? null;
        if (level) {
          requestedLevel = opts.level && avail.includes(opts.level) ? opts.level : level;
          const loaded = await loadAsset(product.id, requestedLevel);
          sourceRoot = loaded.root;
          level = loaded.level;
        }
      }
      if (!sourceRoot) {
        const file = product?.assetFile;
        if (!file) throw new Error('这一款没有模型文件');
        const url = assetUrl(file);
        const res = await fetch(url);
        if (!res.ok) throw new Error(`取不到模型 ${url}（HTTP ${res.status}）`);
        sourceRoot = await parseGlbBuffer(await res.arrayBuffer());
        level = 'single';
        entry = {
          declared: { w: product.w, h: product.h, d: product.d },
          envelopeMode: product.envelopeMode ?? 'fit',
          doors: doorsOf(product),
        };
      }
      if (!entry) throw new Error('这一款没有可用的模型清单');

      // 克隆一份再校准：`loadAsset` 的解析结果按 (assetId:level) 缓存、与主画布共享，
      // 直接改它的缩放/位移会顺手改掉主画布里的同一份模型。
      root = sourceRoot.clone(true);
      // ⚠️ **不许改名**：热点的 `nodePath[0]` 就是模型根节点名（编辑器标定时记下的那一份）。
      //    给克隆换个名字（例如 `detail:demo-freezer-dual`）会让每一条热点的第一段都对不上 —— 全体"锚点失效"，
      //    而模型明明就在眼前。要标记这一份属于详情，用 userData，不动 name。
      root.userData.detailOf = product?.id ?? null;
      const doors = mergeDoors(entry.doors ?? doorsOf(product), doorsFromScene(root));
      const fit = fitClone(root, { ...entry, doors });
      bound = bindDoors(root, { ...entry, doors });
      applyDoors(bound, doorAmount);
      scene.add(root);

      occlusion = [];
      root.traverse((o) => { if (o.isMesh && o.visible) occlusion.push(o); });
      probe = {
        level,
        triangles: countTriangles(root),
        calls: 0,
        textures: 0,
        sizeMm: fit.sizeMm,
        scale: fit.scale,
        mode: fit.mode,
        doors: bound.map((b) => ({
          node: b.node,
          found: b.found,
          pivotMm: b.pivotMm,
          pivotOk: b.pivotOk,
          openDirection: b.openDirection,
        })),
      };
      this.frame();
      if (typeof onStatus === 'function') onStatus({ level, ...probe });
      return probe;
    },

    /** 用**当前这份模型**解析热点锚点（返回 `{resolved, failed}`；failed 要给界面看） */
    resolve(hotspots = []) {
      if (!root) return { resolved: [], failed: [] };
      return resolveHotspots(root, hotspots);
    },

    /** 重新取景（默认机位；不看热点） */
    frame() {
      if (!root) return;
      root.updateMatrixWorld(true);
      applyPose(cameraPose(DEFAULT_CAMERA, boxOf(root)));
    },

    /** 把相机移到某个热点记录的视角（没有 camera 就不动，绝不猜） */
    focusCamera(normalized, { animate = true } = {}) {
      if (!root || !normalized) return false;
      const pose = cameraPose(normalized, boxOf(root));
      if (!animate || reduceMotion()) { applyPose(pose); return true; }
      const from = {
        position: camera.position.toArray(),
        target: [controls.target.x, controls.target.y, controls.target.z],
        fov: camera.fov,
      };
      const t0 = performance.now();
      const DUR = 450;
      if (doorAnim) cancelAnimationFrame(doorAnim);
      const step = () => {
        if (destroyed) return;
        const k = Math.min(1, (performance.now() - t0) / DUR);
        const e = k < 0.5 ? 2 * k * k : 1 - 2 * (1 - k) * (1 - k);
        const lerp = (a, b) => a + (b - a) * e;
        camera.position.set(
          lerp(from.position[0], pose.position[0]),
          lerp(from.position[1], pose.position[1]),
          lerp(from.position[2], pose.position[2]),
        );
        controls.target.set(
          lerp(from.target[0], pose.target[0]),
          lerp(from.target[1], pose.target[1]),
          lerp(from.target[2], pose.target[2]),
        );
        controls.update();
        dirty = true; draw();
        if (k < 1) doorAnim = requestAnimationFrame(step);
        else doorAnim = null;
      };
      step();
      return true;
    },

    /** 门开度 0..1（详情默认关门，与方案里 `doorAmount=0` 一致） */
    setDoor(amount, { animate = true } = {}) {
      const to = Math.max(0, Math.min(1, Number(amount) || 0));
      if (!animate || reduceMotion() || Math.abs(to - doorAmount) < 1e-3) {
        doorAmount = to;
        applyDoors(bound, doorAmount);
        requestRender();
        return doorAmount;
      }
      const from = doorAmount;
      const t0 = performance.now();
      const DUR = 450;
      if (doorAnim) cancelAnimationFrame(doorAnim);
      const step = () => {
        if (destroyed) return;
        const k = Math.min(1, (performance.now() - t0) / DUR);
        doorAmount = from + (to - from) * k;
        applyDoors(bound, doorAmount);
        dirty = true; draw();
        if (k < 1) doorAnim = requestAnimationFrame(step);
        else { doorAnim = null; doorAmount = to; applyDoors(bound, to); requestRender(); }
      };
      step();
      return doorAmount;
    },

    doorAmount: () => doorAmount,

    /**
     * 执行一条产品级动作（详情页热点点击调用）。
     *
     * 同一 `action.key` 只有一份运行时：重复点击先取消上一段 rAF，从**当前开度**接着走；
     * toggle=true 时到 1 后再点回 0，绝不累加角度/位移。不同 key 可以同时跑。
     * 返回 `{ok, key, kind, to}`；找不到目标/片段时 `ok:false` + reason，界面要如实提示。
     */
    runAction(action) {
      if (!root || !action || !action.key) return { ok: false, reason: 'no-action' };
      const key = String(action.key);
      const bound = actionBounds.get(key) ?? bindAction(root, action);
      actionBounds.set(key, bound);
      if (!bound.ok) return { ok: false, key, kind: action.kind, reason: bound.reason, rootName: bound.rootName, samplePaths: bound.samplePaths };

      const prev = actionAnims.get(key);
      if (prev?.raf) cancelAnimationFrame(prev.raf);
      const from = prev ? prev.amount : (actionAmount.get(key) ?? 0);
      const toggle = action.motion?.toggle === true;

      if (bound.kind === 'clip') {
        const clip = findClip(root, action.motion?.clipName);
        if (!clip) return { ok: false, key, kind: 'clip', reason: 'clip-missing' };
        if (toggle && prev?.mixer) {
          try { prev.mixer.stopAllAction(); } catch { /* 已停就算了 */ }
          actionAnims.delete(key);
          actionAmount.set(key, 0);
          requestRender();
          return { ok: true, key, kind: 'clip', to: 0 };
        }
        try { prev?.mixer?.stopAllAction(); } catch { /* 同上 */ }
        const mixer = new THREE.AnimationMixer(root);
        const act = mixer.clipAction(clip);
        act.reset();
        act.setLoop(THREE.LoopOnce, 1);
        act.clampWhenFinished = true;
        const dur = Math.max(100, Number(action.motion?.durationMs) || clip.duration * 1000 || 600);
        act.timeScale = clip.duration > 0 ? (clip.duration * 1000) / dur : 1;
        act.play();
        const t0 = performance.now();
        let last = t0;
        const state = { amount: 0, bound, mixer, raf: 0 };
        const step = () => {
          if (destroyed) return;
          const now = performance.now();
          mixer.update(Math.min(0.1, (now - last) / 1000));
          last = now;
          const k = Math.min(1, (now - t0) / dur);
          state.amount = k;
          actionAmount.set(key, k);
          dirty = true; draw();
          if (k < 1) state.raf = requestAnimationFrame(step);
          else {
            act.stop();
            state.raf = 0;
            actionAnims.delete(key);
            actionAmount.set(key, 1);
            requestRender();
          }
        };
        actionAnims.set(key, state);
        step();
        return { ok: true, key, kind: 'clip', to: 1 };
      }

      const to = toggle ? (from >= 0.5 ? 0 : 1) : 1;
      // 复用门的 pivot 时，动作开度就是门开度：同步内部状态，之后 setDoor/toggle 不会从 0 重来。
      if (bound.reusedDoorPivot) doorAmount = to;
      const dur = Math.max(0, Math.min(5000, Number(action.motion?.durationMs) || 0));
      if (!dur || reduceMotion() || Math.abs(to - from) < 1e-4) {
        applyAction(bound, to);
        actionAmount.set(key, to);
        actionAnims.set(key, { amount: to, bound, raf: 0 });
        requestRender();
        return { ok: true, key, kind: bound.kind, to, door: !!bound.reusedDoorPivot };
      }
      const t0 = performance.now();
      const state = { amount: from, bound, raf: 0 };
      const step = () => {
        if (destroyed) return;
        const k = Math.min(1, (performance.now() - t0) / dur);
        const e = k < 0.5 ? 2 * k * k : 1 - 2 * (1 - k) * (1 - k);
        const amount = from + (to - from) * e;
        state.amount = amount;
        applyAction(bound, amount);
        if (bound.reusedDoorPivot) doorAmount = amount;
        actionAmount.set(key, amount);
        dirty = true; draw();
        if (k < 1) state.raf = requestAnimationFrame(step);
        else {
          state.raf = 0;
          state.amount = to;
          applyAction(bound, to);
          actionAmount.set(key, to);
          actionAnims.delete(key);
          requestRender();
        }
      };
      actionAnims.set(key, state);
      step();
      return { ok: true, key, kind: bound.kind, to, door: !!bound.reusedDoorPivot };
    },

    actionState(key) {
      return { amount: actionAmount.get(String(key)) ?? 0, bound: actionBounds.get(String(key)) ?? null };
    },

    /**
     * 把热点投影到容器坐标。**每条都带 `visibleByDoor` / `occluded`**，
     * 界面据此决定"画不画、淡不淡"——但**绝不因为看不见就从列表里删掉**。
     */
    project(list = []) {
      const out = [];
      if (!camera || !root) return out;
      root.updateMatrixWorld(true);
      const w = canvas?.clientWidth || 1;
      const h = canvas?.clientHeight || 1;
      const now = Date.now();
      const canOcclude = now - lastOcclusionAt >= OCCLUSION_MIN_MS;
      if (canOcclude) lastOcclusionAt = now;
      const budget = canOcclude ? OCCLUSION_PER_TICK : 0;
      let used = 0;
      for (const item of list) {
        const hs = item.hotspot ?? item;
        const node = item.node ?? null;
        const world = node ? toWorldPosition(node, hs.position) : null;
        if (!world) {
          out.push({ id: hs.id, visible: false, reason: 'anchor-missing' });
          continue;
        }
        const p = projectPoint([world.x, world.y, world.z], camera, w, h);
        const byDoor = visibleAtDoor(hs, doorAmount);
        let occ = occluded.get(hs.id) ?? false;
        if (byDoor && p.visible && budget && used < budget) {
          used += 1;
          occlusionCursor = (occlusionCursor + 1) % Math.max(1, list.length);
          occ = isOccluded([world.x, world.y, world.z], item);
          occluded.set(hs.id, occ);
        }
        out.push({
          id: hs.id,
          x: p.x,
          y: p.y,
          visible: p.visible && byDoor,
          visibleByDoor: byDoor,
          occluded: byDoor && occ,
          behind: p.behind,
        });
      }
      return out;
    },

    orbit: orbitState,

    probe() {
      return {
        ...probe,
        doorAmount: Math.round(doorAmount * 1000) / 1000,
        frames: frameNo,
        camera: orbitState(),
        rawCamera: camera ? {
          position: camera.position.toArray(),
          target: controls ? [controls.target.x, controls.target.y, controls.target.z] : null,
          fov: camera.fov,
          matrixWorldInverse: camera.matrixWorldInverse.elements.slice(),
        } : null,
        rawRoot: root ? { name: root.name, box: boxOf(root), lastPose } : null,
        occluded: occluded.size,
        actions: [...actionAmount.entries()].map(([key, amount]) => ({ key, amount })),
      };
    },

    /**
     * 只把这份克隆从场景里摘掉，**不 dispose 它的几何与材质**。
     *
     * 原因：`loadAsset` 的结果按 `(modelCode:level)` 缓存、与主画布**共享同一份**；
     * `clone(true)` 复制的只是节点树，geometry/material 仍是缓存里那一份。
     * 在这里 dispose 掉，等于顺手把主画布里的模型拆了 —— 现象是"关掉详情后主画布模型变黑/消失"。
     * 真的该释放的是渲染器与上下文（`dispose()` 里做），不是别人的资源。
     */
    clear() {
      if (!scene) return;
      for (const s of actionAnims.values()) {
        if (s.raf) cancelAnimationFrame(s.raf);
        try { s.mixer?.stopAllAction(); } catch { /* 已停就算了 */ }
      }
      actionAnims.clear();
      actionBounds.clear();
      actionAmount.clear();
      if (root) scene.remove(root);
      root = null;
      bound = [];
      occlusion = [];
      occluded = new Map();
      probe = { level: null, triangles: 0, calls: 0, textures: 0, sizeMm: null };
      requestRender();
    },

    dispose() {
      destroyed = true;
      if (rafId) cancelAnimationFrame(rafId);
      if (doorAnim) cancelAnimationFrame(doorAnim);
      rafId = 0;
      doorAnim = null;
      try { this.clear(); } catch { /* 清不动也要继续收尾 */ }
      try { controls?.dispose(); } catch { /* 同上 */ }
      controls = null;
      try { renderer?.dispose(); } catch { /* 同上 */ }
      // 显式丢上下文：详情反复开关 20 次后不该还在攒 WebGL 上下文（浏览器上限 8~16 个）
      try { renderer?.forceContextLoss?.(); } catch { /* 旧实现没有这个方法 */ }
      renderer = null;
      scene = null;
      camera = null;
      canvas = null;
    },
  };
}

/**
 * 目录行 → `bindDoors` 需要的门表。
 *
 * 两个来源必须分清（AGENTS §4）：`hinges` 是**配方声明的门**（`openAngle` 是弧度），
 * `doors` 是**实测/目录门**（`openAngleDeg` 是角度）。声明优先 —— 与主画布同一口径。
 */
export function doorsOf(product) {
  const hinges = product?.hinges ?? [];
  if (hinges.length) {
    return hinges.map((h) => ({ node: h.name, axis: h.axis || 'y', openAngleRad: h.openAngle ?? 1.85 }));
  }
  return (product?.doors ?? []).map((d) => ({
    node: d.node,
    axis: d.axis || 'y',
    openAngleRad: d.openAngleRad ?? ((d.openAngleDeg ?? 106) * Math.PI) / 180,
  }));
}
