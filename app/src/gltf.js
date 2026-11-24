/**
 * gltf.js —— 模型资产加载与校准（3D 的"数据层"）
 *
 * 职责边界：这里只管**把文件变成可用的物件**，不管相机、不管渲染、不管界面。
 *   加载：静态 GLB（含 meshopt 压缩 + 量化）→ three.js 场景
 *   校准：按验收报告的口径把模型摆正（底面中心、等比缩放进声明包络）
 *   绑门：按目录里的门节点名找到节点，算出"开角 × 开度"的转动量
 *
 * 三个必须踩实的口径（都来自 docs/07 与 R5 验收器，不是这里现编的）：
 *   ① 量化：POSITION 存成 int16 normalized，反量化由节点 TRS 承担 → three.js 原生处理，
 *      但**读取尺寸必须用 Box3 实测**（不能读 accessor.min/max，那是原始整数）。
 *   ② 缩放：`1:1` 模型（实测包围盒 = 声明包络）**不缩放**；`fit` 模型用
 *      `s = min(w/sx, h/sy, d/sz)`（与原型 makeProduct 一致），并报告各轴比例失真。
 *   ③ 原点：模型必须"底面中心在原点"。做不到就**校正 + 如实报偏差**，
 *      不能默默挪一下当没事（否则供应商模型的合规性就永远查不出来）。
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { pivotMmToRootLocal } from './hotspot.js';

const URL_BASE = '/assets/';
export const MANIFEST_URL = `${URL_BASE}optimized/lod.manifest.json`;
export const PRODUCTS_URL = `${URL_BASE}catalog/products.json`;
export const VERIFIED_URL = `${URL_BASE}catalog/models.verified.json`;

/**
 * 存储里的路径 → 可 fetch 的 URL。
 *
 * 库里存的是**仓库内相对路径**（`assets/optimized/xxx.glb`，离线管线写进去的），
 * vite 的 `/assets` 直接能取。但**上传件不在 `assets/` 下** —— 上传目录是
 * `assets/uploads/`（刻意不放进 app/public，那是构建产物目录，sync-assets 会覆盖），
 * 由后端的 `/api/assets/{name}` 下发（经 vite 代理）。
 *
 * 所以这里**同时认绝对路径**（以 `/` 开头）。写死一种拼法的话，
 * "运行期新增的产品"就永远取不到模型 —— 而那正是 R6-2 的全部意义。
 */
export function assetUrl(file) {
  if (!file) return null;
  if (file.startsWith('/')) return file;                 // 已是绝对 URL（上传件走这条）
  return `${URL_BASE}${file.replace(/^assets\//, '')}`;  // 仓库内相对路径（离线资产走这条）
}

/** 关掉内置缓存，我们自己按 (assetId:level) 缓存解析结果 */
const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);

let catalogs = null;
const sceneCache = new Map();   // `${assetId}:${level}` → Promise<{scene, level, bytes}>
const bytesCache = new Map();   // `${assetId}:${level}` → 已下载字节数（用于体检报告）

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`取不到 ${url}（HTTP ${res.status}）`);
  return res.json();
}

/**
 * 目录 + 验收报告 + LOD 清单合成一份"加载用视图"。
 * 三份数据的分工：products.json 是**规格**（声明包络、门、配方），
 * models.verified.json 是**实测**（真实包围盒、铰链位置、扫掠半径），
 * lod.manifest.json 是**可用文件清单**（哪一级真的存在）。
 */
export async function loadCatalogs() {
  if (catalogs) return catalogs;
  const [products, verified, manifest] = await Promise.all([
    getJson(PRODUCTS_URL), getJson(VERIFIED_URL), getJson(MANIFEST_URL),
  ]);
  const vByAsset = new Map(verified.models.map((m) => [m.assetId, m]));
  const mByAsset = new Map(manifest.models.map((m) => [m.assetId, m]));

  const entries = products.products.map((p) => {
    const v = vByAsset.get(p.assetId) ?? null;
    const m = mByAsset.get(p.assetId) ?? null;
    // 只保留**真的存在文件**的级别；被标成"与上一级等效"的级别自动回退到那一级
    const lods = [];
    for (const lod of m?.lods ?? []) {
      if (lod.skipped) lods.push({ level: lod.level, file: null, aliasOf: lod.equivalentTo, triangles: lod.triangles });
      else lods.push({ level: lod.level, file: lod.file, bytes: lod.bytes, triangles: lod.triangles });
    }
    return {
      id: p.id,
      modelCode: p.modelCode,
      name: p.name,
      declared: { w: p.w / 1000, h: p.h / 1000, d: p.d / 1000 },   // 目录是毫米，场景用米
      unit: p.unit ?? 'mm',
      declaredSource: p.sizeNote,
      envelopeMode: v?.envelopeMode ?? 'fit',
      measured: v ? { w: v.bboxMm.w / 1000, h: v.bboxMm.h / 1000, d: v.bboxMm.d / 1000 } : null,
      doors: (p.doors ?? []).map((door, i) => ({
        ...door,
        // 验收器实测的铰链位置（毫米）与扫掠半径 —— 2D 扇形与 3D 校验都用它
        pivotMm: v?.doors?.[i]?.pivotMm ?? door.pivot ?? null,
        swingRadiusMm: v?.doors?.[i]?.swingRadiusMm ?? null,
        status: v?.doors?.[i]?.status ?? null,
      })),
      lods,
      assetFile: p.asset?.file ?? null,
      assetBytes: p.asset?.bytes ?? 0,
      assetTriangles: p.asset?.triangles ?? 0,
      generator: p.asset?.generator ?? '',
    };
  });

  catalogs = { entries, byId: new Map(entries.map((e) => [e.id, e])), manifest, verified, products };
  return catalogs;
}

export function entryOf(productId) {
  return catalogs?.byId.get(productId) ?? null;
}

/** 该资产真的存在的级别（跳过被标记为等效的） */
export function levelsOf(assetId) {
  const e = catalogs?.entries.find((x) => x.id === assetId);
  return (e?.lods ?? []).filter((l) => l.file).map((l) => l.level);
}

/**
 * 选级策略：**按场景设备数量**定；显式指定则用指定的。
 * 距离细分（近景提级/远景降级）留到有实测帧率的机器上再调 —— 本环境 rAF 暂停，
 * 调出来的参数没有意义，所以不假装支持：按台数是确定的、可复现的。
 */
export function chooseLevel(avail, { count = 0, force = null } = {}) {
  const levels = Array.isArray(avail) ? avail : [];
  if (!levels.length) return null;
  if (force) {
    if (levels.includes(force)) return force;
    // 指定了不存在的级别（例：demo-freezer-chest 的 lod1 被标为"与 lod0 等效"）→
    // 找**档位最接近**的那一级（并列时偏向更细的），而不是一律回退到最粗。
    const order = ['lod0', 'lod1', 'lod2'];
    const wantIdx = order.indexOf(force);
    return levels
      .slice()
      .sort((a, b) => {
        const da = Math.abs(order.indexOf(a) - wantIdx);
        const db = Math.abs(order.indexOf(b) - wantIdx);
        return da - db || order.indexOf(a) - order.indexOf(b);
      })[0];
  }
  const want = count <= 6 ? 'lod0' : count <= 20 ? 'lod1' : 'lod2';
  if (levels.includes(want)) return want;
  return want === 'lod2' ? levels[levels.length - 1] : levels[0];
}

export function pickLevel(productId, { count = 0, force = null } = {}) {
  return chooseLevel(levelsOf(productId), { count, force });
}

/**
 * 动态目录产品（数据库里的 352/379/demo-*）→ 最小可用 entry。
 *
 * 静态 manifest 只登记了 4 款种子；DB 产品没有 lods，但 `/api/catalog` 给了
 * `assetFile`（`assets/optimized/xxx.lod0.glb`）与声明尺寸（米）。这里只把**已有事实**
 * 拼成单级 entry，不伪造 LOD、不伪造门。`doors` 沿用目录返回值（没有就是 []）。
 */
export const SINGLE_LEVEL = 'single';

export function dynamicEntryOf(product) {
  if (!product || !product.id) return null;
  const file = product.assetFile || product.asset?.file || null;
  if (!file) return null;
  const declared = {
    w: Number(product.w) || Number(product.bboxMm?.w) / 1000 || 0,
    h: Number(product.h) || Number(product.bboxMm?.h) / 1000 || 0,
    d: Number(product.d) || Number(product.bboxMm?.d) / 1000 || 0,
  };
  return {
    id: product.id,
    modelCode: product.model || product.id,
    name: product.name || product.id,
    declared,
    unit: 'mm',
    declaredSource: product.sizeNote || 'DB catalog',
    envelopeMode: product.envelopeMode || 'fit',
    measured: null,
    doors: Array.isArray(product.doors) ? product.doors : [],
    lods: [{ level: SINGLE_LEVEL, file, bytes: 0, triangles: 0 }],
    assetFile: file,
    assetBytes: 0,
    assetTriangles: 0,
    generator: '',
    dynamic: true,
  };
}

/**
 * 选资产：**静态 manifest 优先**；没有静态 entry 才回退 DB 的 assetFile 单级 entry。
 * 两者都没有才返回 null —— 这时才是真的“目录里没有可用模型”。
 */
export function resolveAssetPlan(productId, { count = 0, force = null, product = null, staticEntry } = {}) {
  const entry = staticEntry === undefined ? entryOf(productId) : staticEntry;
  if (entry) {
    const avail = (entry.lods ?? []).filter((l) => l.file).map((l) => l.level);
    const level = chooseLevel(avail, { count, force });
    return level ? { entry, level, dynamic: false } : null;
  }
  const dyn = dynamicEntryOf(product);
  return dyn ? { entry: dyn, level: SINGLE_LEVEL, dynamic: true } : null;
}

/** 按 DB 给的 file 直接加载（动态产品）；解析/归一化与静态 LOD 同一条路。 */
export async function loadAssetFile(file, entry) {
  if (!file) throw new Error('没有模型文件');
  const key = `file:${file}`;
  if (!sceneCache.has(key)) {
    sceneCache.set(key, (async () => {
      const res = await fetch(assetUrl(file));
      if (!res.ok) throw new Error(`取不到模型 ${file}（HTTP ${res.status}）`);
      const buf = await res.arrayBuffer();
      bytesCache.set(key, buf.byteLength);
      const root = await parseGlbBuffer(buf);
      root.name = `${entry?.modelCode || entry?.id || 'model'}:${SINGLE_LEVEL}`;
      const lod = { level: SINGLE_LEVEL, file, bytes: buf.byteLength, triangles: 0 };
      return { root, level: SINGLE_LEVEL, lod, entry, sourceUnit: root.userData?.modelUnit?.sourceUnit ?? 'unknown' };
    })());
  }
  return sceneCache.get(key);
}

/** 加载一级（带缓存）。同一级只解析一次，多台设备共享几何与材质。 */
export async function loadAsset(productId, level) {
  const entry = entryOf(productId);
  const lod = entry?.lods.find((l) => l.level === level && l.file);
  if (!lod) throw new Error(`${productId} 没有 ${level} 这一级`);
  const key = `${entry.modelCode}:${level}`;
  if (!sceneCache.has(key)) {
    sceneCache.set(key, (async () => {
      const res = await fetch(assetUrl(lod.file));
      if (!res.ok) throw new Error(`取不到模型 ${lod.file}（HTTP ${res.status}）`);
      const buf = await res.arrayBuffer();
      bytesCache.set(key, buf.byteLength);
      const gltf = await loader.parseAsync(buf, '');
      const root = gltf.scene;
      root.name = `${entry.modelCode}:${level}`;
      // docs/07 §10.1：历史 mm LOD 也在这里归一化；4 个存量模型是 m，scale 保持 1
      const unit = normalizeToMeters(root);
      // 官方模型带一个 DW86_Rig 父节点（缩放 0.1），模型的整体变换要保留
      return { root, level, lod, entry, sourceUnit: unit.sourceUnit };
    })());
  }
  return sceneCache.get(key);
}

/**
 * docs/07 §10.1：GLB 数值单位是 **m**；历史文件可能是 mm，读取时必须显式 ×0.001。
 *
 * 真相不靠"看起来差不多"：真实柜体 ~2 m，文件里最长边 > 100 个单位就按 mm 处理
 * （否则就是 100 m 以上的模型，不是本产品对象）。转换只做一次，结果写进 userData，
 * 上游（分析器/加载器/校准）都读同一个来源，不会一边×1000一边×0.001。
 */
export const UNIT_MM_THRESHOLD = 100;

export function detectSourceUnit(obj, { mmThreshold = UNIT_MM_THRESHOLD } = {}) {
  if (!obj) return { sourceUnit: 'unknown', scale: 1, rawLongest: 0 };
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const rawLongest = Math.max(size.x, size.y, size.z);
  const isMm = Number.isFinite(rawLongest) && rawLongest > mmThreshold;
  return { sourceUnit: isMm ? 'mm' : 'm', scale: isMm ? 0.001 : 1, rawLongest };
}

/** 显式归一化到米；幂等（同一棵树重复调用不会二次缩放）。 */
export function normalizeToMeters(obj, opts = {}) {
  if (!obj) return { sourceUnit: 'unknown', scale: 1, rawLongest: 0, normalized: false };
  const done = obj.userData && obj.userData.modelUnit;
  if (done && typeof done === 'object' && done.sourceUnit) return done;
  const info = detectSourceUnit(obj, opts);
  if (info.scale !== 1) obj.scale.multiplyScalar(info.scale);
  obj.updateMatrixWorld(true);
  const out = { ...info, normalized: true };
  obj.userData = obj.userData || {};
  obj.userData.modelUnit = out;
  return out;
}

/**
 * 解析**上传来的字节**（不走 URL）。维护端上传 GLB 时用这条路径 ——
 * 与 loadAsset 共用同一个 loader（含 meshopt 解码器），所以"预览能看"和"入库能收"
 * 不会因为两套解析器而出现分歧。
 *
 * ⚠️ 这里就把 mm 历史件归一化到 m；`analyzeGlb` 读 `root.userData.modelUnit` 回报 sourceUnit。
 */
export async function parseGlbBuffer(buf) {
  const gltf = await loader.parseAsync(buf, '');
  // 动作库的 clip 类型要用它；挂 userData 而不是另开返回形状，clone(true) 会带上这份引用。
  gltf.scene.userData.animations = Array.isArray(gltf.animations) ? gltf.animations : [];
  normalizeToMeters(gltf.scene);
  return gltf.scene;
}

/* ---------------- 几何测量与校准 ---------------- */

export function measure(obj) {
  obj.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  return {
    size, center, min: box.min.clone(), max: box.max.clone(),
    mm: { w: size.x * 1000, h: size.y * 1000, d: size.z * 1000 },
  };
}

export function countTriangles(obj) {
  let tris = 0;
  obj.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const g = o.geometry;
    tris += (g.index ? g.index.count : g.attributes.position?.count ?? 0) / 3;
  });
  return Math.round(tris);
}

/**
 * 把一份模型克隆摆正：底面中心对齐原点 + 缩放进声明包络。
 * 返回**偏差报告**（原点偏了多少、各轴比例被扭了多少），供体检与目录回填。
 */
export function fitClone(clone, entry) {
  // 两条路都可能把单位带错：历史 LOD 是 mm；目录/声明的 w/d/h 可能是 m 或 mm。
  // 先把模型归一化到米，再把声明值按同一口径归一化 —— 只在这里做一次，后面的相机
  // （`cameraPose` 以米为世界单位）才不会拿到“1339 m 的柜体”。
  normalizeToMeters(clone);
  const m = measure(clone);
  const declared = entry.declared;
  const declaredScale = Math.max(declared.w, declared.h, declared.d) > 100 ? 0.001 : 1;
  const w = declared.w * declaredScale;
  const h = declared.h * declaredScale;
  const d = declared.d * declaredScale;
  const oneToOne = entry.envelopeMode === '1:1';
  const raw = Math.min(w / m.size.x, h / m.size.y, d / m.size.z);
  const scale = oneToOne ? 1 : (Number.isFinite(raw) && raw > 0 ? raw : 1);
  // 各轴比例失真：缩放后每个方向相对声明值差多少
  const fits = [m.size.x * scale / w, m.size.y * scale / h, m.size.z * scale / d];
  const anisotropyPct = (Math.max(...fits) - Math.min(...fits)) * 100;

  // 不能 setScalar：normalizeToMeters 可能已经给 root 乘了 0.001；在这里直接覆盖会把
  // 归一化丢掉（测试：mm 网格仍会变成 1339 m）。乘在现有 scale 上，只叠加 fit 这一层。
  clone.scale.multiplyScalar(scale);
  // three.js 的矩阵是 T·R·S，所以位移不能再乘一次 scale 之外的东西：
  // 顶点 v → s·v + 位移，要让"几何中心"落到原点、"最低点"落到 0
  clone.position.set(-scale * m.center.x, -scale * m.min.y, -scale * m.center.z);

  return {
    scale,
    mode: entry.envelopeMode,
    // ⚠️ 这里**只报测量**，不下判断（"几何是纯函数"）。原来这里写死 `anisotropyOk:
    //    Math.abs(anisotropyPct) <= 2` —— 那是第三份阈值（参数表里那份才是唯一的，
    //    见 analyze.js 的 anisoWarnRatio）。判据归**消费者**：scene3d 的体检与维护端向导。
    anisotropyRatio: Math.round((Math.max(...fits) / Math.min(...fits)) * 1000) / 1000,
    // 原点合规性：模型本来就"底面中心在原点"的话，这两个补偿量应该接近 0
    recenterMm: {
      x: -m.center.x * 1000,
      y: -m.min.y * 1000,
      z: -m.center.z * 1000,
    },
    recentered: Math.max(Math.abs(m.center.x), Math.abs(m.min.y), Math.abs(m.center.z)) * 1000 > 2,
    sizeMm: m.mm,
    anisotropyPct: Math.round(anisotropyPct * 100) / 100,
  };
}

/* ---------------- 门 ---------------- */

/** 把节点包围盒换到模型根局部坐标（根内单位可能是 mm，也可能是 m）。 */
function boxInRootLocal(root, object) {
  if (!root || !object) return null;
  root.updateMatrixWorld(true);
  const world = new THREE.Box3().setFromObject(object);
  if (world.isEmpty()) return null;
  const pts = [];
  for (const x of [world.min.x, world.max.x]) {
    for (const y of [world.min.y, world.max.y]) {
      for (const z of [world.min.z, world.max.z]) {
        pts.push(root.worldToLocal(new THREE.Vector3(x, y, z)));
      }
    }
  }
  return new THREE.Box3().setFromPoints(pts);
}

/** 根的局部单位 → mm 的倍数（Blender 米制件根内是米，历史 mm 件根内是 mm）。 */
function localToMmFactor(root) {
  return root?.userData?.modelUnit?.sourceUnit === 'm' ? 1000 : 1;
}

function axisOfDoor(door) {
  const a = String(door.axis || 'y').toLowerCase();
  return ['x', 'y', 'z'].includes(a) ? a : 'y';
}

/**
 * 缺 `hingePoint` 时从**节点几何**推铰链线，不猜固定坐标、也不把节点原点当铰链。
 * 规则（Captain t23 口径 + 摆动几何校验）：
 *  - 单门/双门：y 轴，铰链在门宽外侧边（door_L/`-` 取 min.x，door_R/`+` 取 max.x），
 *    z 取门面外侧，y 取门底；摆动符号由「铰链边 × 门面相对柜体中心」推，保证朝外开。
 *  - 顶盖：x 轴，y 取上沿，x 取中心；z 取后侧边（由 extras 的摆动符号反推，保证向上抬）。
 * @returns {{pivotMm:number[],sign:number,source:string}|null}
 */
export function deriveDoorPivot(root, node, door) {
  const box = boxInRootLocal(root, node);
  const rootBox = boxInRootLocal(root, root);
  if (!box || !rootBox) return null;
  const type = String(door.partType || '').toLowerCase();
  const name = String(door.node || node.name || '').toLowerCase();
  const dirSign = door.openDirection === '-' ? -1 : 1;
  const k = localToMmFactor(root);
  const cx = (box.min.x + box.max.x) / 2;
  const cz = (box.min.z + box.max.z) / 2;
  if (/lid/.test(type)) {
    // 绕 x 轴：要让盖体向上抬，铰链边必须在盖体重心的反方向。
    const pivotZ = dirSign > 0 ? box.max.z : box.min.z;
    return {
      pivotMm: [cx * k, box.max.y * k, pivotZ * k],
      sign: dirSign,
      source: 'box3-lid',
    };
  }
  if (!/door/.test(type)) return null;
  const hingeAtMax = /(_r\b|right)/.test(name)
    ? true
    : (/(_l\b|left)/.test(name) ? false : door.openDirection !== '-');
  const rootCz = (rootBox.min.z + rootBox.max.z) / 2;
  const frontSign = cz >= rootCz ? 1 : -1;
  const sign = (hingeAtMax ? 1 : -1) * frontSign;
  const pivotX = hingeAtMax ? box.max.x : box.min.x;
  const pivotZ = frontSign > 0 ? box.max.z : box.min.z;
  return {
    pivotMm: [pivotX * k, box.min.y * k, pivotZ * k],
    sign,
    source: 'box3-door',
  };
}

/**
 * 双滑门按门名分侧：door_L 向左、door_R 向右，各滑自己的 700mm；单 sash 仍听 openDirection。
 * 这里集中成一处，bindDoors 与维护端 setupDoors 必须用同一份方向，不能各自按名字猜。
 */
export function planSlideSigns(clone, doors) {
  const out = new Map();
  for (const d of Array.isArray(doors) ? doors : []) {
    const mm = Number(d && (d.slideMm ?? d.slideDistanceMm));
    const slide = d && (d.motion === 'translate'
      || (Number.isFinite(mm) && mm > 0 && !(Number(d.openAngleRad) > 0.001)));
    if (!slide) continue;
    const nm = String(d.node || '').toLowerCase();
    const sign = /(_l\b|left)/.test(nm) ? -1
      : (/(_r\b|right)/.test(nm) ? 1 : (d.openDirection === '-' ? -1 : 1));
    out.set(d.node, sign);
  }
  return out;
}

/**
 * 绑一扇门/盖/滑门。`bindDoors` 按名字找节点；维护端已有 nodePath 解析结果时直接传 node，
 * 避免同名节点绑错。
 */
export function bindDoorNode(clone, node, door) {
  const axis = axisOfDoor(door);
  const slideMm = Number(door.slideMm ?? door.slideDistanceMm);
  const isSlide = door.motion === 'translate'
    || (Number.isFinite(slideMm) && slideMm > 0 && !(Number(door.openAngleRad) > 0.001));
  const rawDir = door.openDirection === '-' ? -1 : 1;
  const derived = node && !isSlide
    && !(Array.isArray(door.pivotMm) && door.pivotMm.length === 3)
    ? deriveDoorPivot(clone, node, door)
    : null;
  const sign = derived ? derived.sign : rawDir;
  const pivotMm = derived ? derived.pivotMm : (door.pivotMm ?? null);
  const b = {
    node: door.node,
    nodeRef: node,
    found: !!node,
    obj: node,
    axis,
    // +1 / -1：最终摆动符号。缺 hingePoint 的 demo 门按几何重算，避免 extras 方向写反时朝柜内开。
    sign,
    openDirection: sign < 0 ? '-' : '+',
    openDirectionRaw: door.openDirection ?? null,
    openAngleRad: (door.openAngleRad ?? 1.85) * (isSlide ? 0 : sign),
    rest: node ? node.rotation[axis] : 0,
    pivotMm,
    pivotSource: isSlide ? 'slide-rail' : (derived ? derived.source : (door.pivotMm ? 'declared' : 'node-origin')),
    swingRadiusMm: door.swingRadiusMm ?? null,
    // 没有 pivotMm 且无法从几何推的旧门退回「绕节点原点转」，显式标 null，不能冒充已校准
    pivotOk: null,
    pivot: null,
    motion: isSlide ? 'translate' : 'rotate',
    slideMm: Number.isFinite(slideMm) && slideMm > 0 ? slideMm : null,
  };
  if (!node) return b;
  clone.updateMatrixWorld(true);
  if (isSlide) {
    const k = localToMmFactor(clone) === 1000 ? 0.001 : 1;
    // 双滑门（door_L/door_R）必须各自向外侧滑：按名字定方向，不能照 extras 的 +/-，
    // 否则两扇会同时滑向中间、叠在一起，等于没开。单 sash 仍听 openDirection。
    const nm = String(door.node || node.name || '').toLowerCase();
    const planned = Number(door.slideSign);
    const slideSign = Number.isFinite(planned) ? planned
      : /(_l\b|left)/.test(nm) ? -1 : (/(_r\b|right)/.test(nm) ? 1 : sign);
    b.restPosition = node.position.clone();
    b.slideLocal = (b.slideMm || 0) * k * slideSign;
    b.sign = slideSign;
    b.openDirection = slideSign < 0 ? '-' : '+';
    b.pivotOk = true;
    b.pivotSource = 'slide-rail';
  } else if (Array.isArray(b.pivotMm) && b.pivotMm.length === 3
    && b.pivotMm.every((v) => Number.isFinite(Number(v)))) {
    // 门节点原点在门中心 —— 直接转门会绕中心转错。pivotMm 给的是模型根局部 mm 的真实铰链点：
    // 在门父节点下建 pivot Group，把门挂进去，之后转 pivot。局部坐标由世界点反算，兼容缩放/平移。
    const world = clone.localToWorld(pivotMmToRootLocal(clone, b.pivotMm));
    const parent = node.parent;
    if (parent) {
      const pivot = new THREE.Group();
      pivot.name = `${door.node}:pivot`;
      // 动作系统若也指向这扇门，应复用这个 pivot（否则会叠成 210°）；标记归属与关门 rest。
      pivot.userData.doorPivot = door.node;
      pivot.userData.doorRest = 0;
      pivot.position.copy(parent.worldToLocal(world.clone()));
      pivot.updateMatrixWorld(true);
      b.nodeRest = node.rotation[axis];
      parent.add(pivot);
      pivot.updateMatrixWorld(true);
      pivot.attach(node);
      b.pivot = pivot;
      b.obj = pivot;
      // rest 仍是「关门状态」的转角；改的是 pivot，所以取 pivot 初始角（通常 0）
      b.rest = pivot.rotation[axis];
    }
  }
  clone.updateMatrixWorld(true);
  const p = new THREE.Vector3();
  (b.pivot ?? node).getWorldPosition(p);
  b.hingeWorldMm = { x: p.x * 1000, y: p.y * 1000, z: p.z * 1000 };
  if (b.pivotMm) {
    b.pivotDeltaMm = {
      x: Math.round((b.hingeWorldMm.x - b.pivotMm[0]) * 100) / 100,
      y: Math.round((b.hingeWorldMm.y - b.pivotMm[1]) * 100) / 100,
      z: Math.round((b.hingeWorldMm.z - b.pivotMm[2]) * 100) / 100,
    };
    if (b.pivot) {
      b.pivotOk = Math.max(
        Math.abs(b.pivotDeltaMm.x), Math.abs(b.pivotDeltaMm.y), Math.abs(b.pivotDeltaMm.z),
      ) <= 2;
    }
  }
  return b;
}

/** 门节点名必须能在模型里找到 —— 找不到就报出来，不要静默当没门 */
export function bindDoors(clone, entry) {
  const plan = planSlideSigns(clone, entry.doors);
  return entry.doors.map((door) => bindDoorNode(clone, clone.getObjectByName(door.node) ?? null, {
    ...door,
    slideSign: plan.has(door.node) ? plan.get(door.node) : door.slideSign,
  }));
}

/** 开度 0..1 → 门绕轴转角（有 pivot 转 pivot；旧门仍绕节点原点，语义未变） */
export function applyDoor(bound, amount) {
  if (!bound.obj) return 0;
  const a = Math.max(0, Math.min(1, amount ?? 0));
  if (bound.motion === 'translate' && bound.restPosition) {
    // 滑门/ sash：沿轨道平移，不做 0° 旋转冒充开合。
    const p = bound.restPosition;
    bound.obj.position.set(
      p.x + (bound.axis === 'x' ? bound.slideLocal * a : 0),
      p.y + (bound.axis === 'y' ? bound.slideLocal * a : 0),
      p.z + (bound.axis === 'z' ? bound.slideLocal * a : 0),
    );
    bound.obj.updateMatrix();
    return bound.slideLocal * a;
  }
  bound.obj.rotation[bound.axis] = bound.rest + bound.openAngleRad * a;
  bound.obj.updateMatrix();
  return bound.obj.rotation[bound.axis];
}