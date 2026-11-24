/**
 * analyze.js —— 浏览器端的**模型分析器**（R6-2 的核心假设先验）
 *
 * 主张（docs/32 §2）：**浏览器就是模型分析器**。
 * 上传时反正要加载模型做预览 —— 就顺手把该拾取的都拾取了，零新增组件。
 * 为什么不在后端：解析 glTF + 量包围盒要 three.js；后端只用已有的 Node/Python 工具
 * **对账**，不做实时 —— 否则就是两套几何代码，迟早打架。
 *
 * 三条铁律（都来自 docs/32，不是这里现编的）：
 *   ① **每个自动值都必须能被人工改掉** —— 自动化是默认值，不是最终值。
 *   ② **每个自动值都要带「依据 + 置信度」** —— 判据 5「怕安静」的正面用法。
 *      不给依据的自动值，用户只能选择不信（A 批的假角标就是反面教材）。
 *   ③ **拿不准就说拿不准** —— 正对面只给候选，不假装知道。
 *
 * 所有阈值**逐条来自 docs/07 §6**，不要在这里改数：改了就等于偷偷放宽交付标准。
 * 单位口径见 docs/07 §10.1：文件 m，声明/bbox mm；mm 历史件由 parseGlbBuffer 显式 ×0.001，
 * 这里只回报 `sourceUnit`，绝不重复换算。
 */
import * as THREE from 'three';
import { measure, countTriangles, parseGlbBuffer } from '../gltf.js';
import { cfg, envelopeTolMm } from '@core/params.js';

/* ── docs/07 §6 的硬指标（超过不收）──────────────────────────────────── */
export const LIMITS = {
  lod0Triangles: 60000,             // 单模型面数（LOD0）≤ 60,000
  lod0Bytes: 3 * 1024 * 1024,       // 单模型文件（LOD0）≤ 3 MB
  textureBytes: 8 * 1024 * 1024,    // 纹理总量 单模型 ≤ 8 MB
  originMm: 2,                      // 原点允许偏差（与 gltf.js fitClone 同一口径）
};

/**
 * 「各轴比例失真」的容差**只有一处**：参数表 `model.anisotropyWarn`（默认 1.02 = 2%）。
 *
 * 为什么原来不是一处（第 2 轮审查 dev-5）：`LIMITS.anisoPct = 2` 全仓**零读取方**，
 * 而真正生效的是 `gltf.js` 里写死的 `<= 2`，参数表里那份 `model.anisotropyWarn`
 * 谁也没读 —— 三份数字，改哪一份都不生效。现在判据一律问参数表（`cfg` 是活引用，
 * 所以**必须在函数里读**，见 spatial-core/src/params.js 的模块注释）。
 */
export function anisoWarnRatio() {
  const v = Number(cfg.model && cfg.model.anisotropyWarn);
  return Number.isFinite(v) && v > 1 ? v : 1.02;
}

/* ── docs/07 §3 的门节点约定（这是**约定**，不是猜）────────────────────── */
export const DOOR_NODES = [
  { part: 'double', node: 'door_upper', axis: 'y' },
  { part: 'double', node: 'door_lower', axis: 'y' },
  { part: 'single', node: 'door_single', axis: 'y' },
  { part: 'top', node: 'lid_top', axis: 'x' },
  { part: 'drawer', node: 'drawer_01', axis: 'x' },
];

/**
 * 实测到的**别名**（**逐条来自在用模型的实际节点名**，不是我编的）
 *
 * 为什么必须有它：`docs/07 §3` 的命名约定是给**以后的供应商**定的，
 * 而**现存的 4 个模型一个都没按它命名** ——
 *   demo-ct-scanner = `outer_door` ｜ demo-freezer-dual = `upper_door` + `lower_door`
 *   demo-freezer-upright = `single_door` ｜ demo-freezer-chest = `top_lid`
 * 只按约定找 → 一个门都找不到 → 门型全降级人工 —— 明明模型是好的。
 * **这条是"核心假设先验"验出来的**（拿 4 个真模型跑出来的结果），不是拍脑袋加的。
 *
 * 抽拉件也收（demo-freezer-dual 柜内有抽屉），但**门型优先级是 top > double > single > drawer**：
 * 有门的柜子即使柜内有抽屉，它也是"双门柜"，不是"抽屉柜"。
 */
export const DOOR_VARIANTS = [
  { part: 'double', node: 'upper_door', axis: 'y' },
  { part: 'double', node: 'lower_door', axis: 'y' },
  { part: 'single', node: 'single_door', axis: 'y' },
  { part: 'single', node: 'outer_door', axis: 'y' },
  { part: 'top', node: 'top_lid', axis: 'x' },
  { part: 'drawer', node: 'upper_drawer_1', axis: 'x' },
  { part: 'drawer', node: 'lower_drawer_1', axis: 'x' },
];

const r1 = (v) => Math.round(v * 10) / 10;

/**
 * 分析一个 GLB 字节流。
 *
 * @param {ArrayBuffer} buf   文件字节
 * @param {object} opts       { fileName, declared:{w,h,d}, declaredSource }
 * @returns 校验结论 + 自动拾取值（每个都带依据与置信度）
 */
export async function analyzeGlb(buf, opts = {}) {
  const declared = opts.declared || null;
  const root = await parseGlbBuffer(buf);
  root.updateMatrixWorld(true);

  const m = measure(root);
  const mm = { w: r1(m.mm.w), h: r1(m.mm.h), d: r1(m.mm.d) };
  const triangles = countTriangles(root);
  const textures = collectTextures(root);
  const doors = detectDoors(root, m);
  const sizeBytes = buf.byteLength;
  // parseGlbBuffer 已把 mm 历史件显式 ×0.001；这里只回报，不重复换算。
  const unitInfo = root.userData?.modelUnit || { sourceUnit: 'm', scale: 1, normalized: false };

  const checks = buildChecks({
    mm, triangles, textures, doors, sizeBytes, declared,
    originMm: originOf(m), sourceUnit: unitInfo.sourceUnit,
  });

  return {
    ok: !checks.some((c) => c.level === 'bad'),   // bad 才拦人；warn 只是提醒
    fileName: opts.fileName || '',
    sizeBytes,
    sourceUnit: unitInfo.sourceUnit,
    unitScale: unitInfo.scale,
    mm, triangles, textures, doors, originMm: originOf(m),
    unitHint: inferUnit(mm, declared),
    checks,
    picks: buildPicks(root, m, doors, declared, unitInfo),   // 见第 2 块（函数声明会提升）
  };
}

/** 相对「底面中心在原点」的偏差（mm）。非零是**正常**的（导出的原始模型常常不在原点），
 *  前台的 fitClone 会纠偏；但偏差量必须记下来（docs/07 §2）。 */
function originOf(m) {
  return { x: r1(-m.center.x * 1000), y: r1(-m.min.y * 1000), z: r1(-m.center.z * 1000) };
}

/* ── 两条模型判据（写入侧）：**与读出侧同一件事** ─────────────────────── */

/**
 * 把三轴比值收成一个数：最大/最小。1.0 = 三轴缩放完全一致。
 * 缺任何一轴（没实测或没声明）→ null（**不猜**）。
 */
function axisSpread(measured, declared) {
  const m = measured || {};
  const d = declared || {};
  const pairs = [['w', m.w, d.w], ['h', m.h, d.h], ['d', m.d, d.d]];
  const fits = [];
  for (const [, a, b] of pairs) {
    const x = Number(a);
    const y = Number(b);
    if (!Number.isFinite(x) || !Number.isFinite(y) || y <= 0) return [null, null];
    fits.push(x / y);
  }
  const max = Math.max(...fits);
  const min = Math.min(...fits);
  return [r1((max / min) * 1000) / 1000, fits];
}

/**
 * 「缩放不均匀」：`anisotropy_ok`。
 *
 * ⚠️ 它以前**从来没被提交过**（第 2 轮审查 dev-1）：`modelOf` 里没有这个字段，
 * 后端缺键取 1（等于替模型宣称"各轴缩放正常"）—— 设计端体检报 `shapeOk=false`，
 * 而维护端列表一个角标都不出。现在：算得出来就给 0/1，**算不出来给 null（未判）**。
 * 读出侧把 null 说成「缩放未判」，不说成「均匀」也不说成「不均匀」——三态才说得清。
 */
export function anisotropyOf(measured, declared) {
  const [ratio] = axisSpread(measured, declared);
  if (ratio === null) return { ratio: null, ok: null };
  return { ratio, ok: ratio <= anisoWarnRatio() ? 1 : 0 };
}

/**
 * 「尺寸对账」：`envelope_ok`。
 *
 * 口径**随 mode 变**——这就是它最容易错的地方（读出侧 `AdminBadges` 的角标文案写的就是这个）：
 *   mode='1:1' → **逐轴 |实测 − 声明| ≤ `model.envelopeTolMm`**（默认 1 mm）。1:1 的意思是"模型就是实物的尺寸"，
 *                差 20 mm 就是没对上账。容差只有一处出处（`envelopeTolMm()`）——
 *                这里原来写死 `<= 1`、而设计端 `scene3d.js` 写死 `<= 5`，同一个模型两处相反结论（第 3 轮审查 C-10）。
 *   mode='fit' → 量纲一致（逐轴 5%）：fit 本来就不做 1:1，这一列只记"单位没弄错"。
 *   其余/缺值   → null（未判）。
 *
 * 原来是写入侧 5%（单位容差）、读出侧 1 mm（对账），**两件事共用一个字段** ——
 * 于是"尺寸未对账"这个角标**永远不会出现**（第 2 轮审查 dev-2）。
 */
export function envelopeOkFor(mode, measured, declared) {
  const m = measured || {};
  const d = declared || {};
  if (mode === '1:1') {
    const axes = [[m.w, d.w], [m.h, d.h], [m.d, d.d]];
    for (const [a, b] of axes) {
      const x = Number(a);
      const y = Number(b);
      if (!Number.isFinite(x) || !Number.isFinite(y) || y <= 0) return null;   // 缺一轴 = 未判
    }
    return axes.every(([a, b]) => Math.abs(Number(a) - Number(b)) <= envelopeTolMm()) ? 1 : 0;
  }
  if (mode === 'fit') {
    // fit 的语义**保持不变**：这一列在 fit 下记的是「量纲没弄错」（缩放由 fitClone 的
    // min() 兜底，一定能放进声明包络）。所以只拦单位错误 —— 不改 fit 的既有含义，
    // 也正是别把两件事混成一个字段的做法：1:1 才是对账，fit 只是量纲。
    const u = inferUnit(m, d);
    if (u.code === 'unknown') return null;
    return u.code === 'm' || u.code === 'mm-in-m' || u.code === 'cm' ? 0 : 1;
  }
  return null;
}

/* ── 单位推断：**拿声明值当参照**，不猜"应该是 mm" ────────────────────── */
/** 尺寸猜错是历史第一大坑（docs/07 §2）——所以要量出比值并说出来。 */
export function inferUnit(mm, declared) {
  if (!declared) return { code: 'unknown', ratio: null, why: '没有声明尺寸可比 → 无法推断单位' };
  const axes = [['w', mm.w, declared.w], ['h', mm.h, declared.h], ['d', mm.d, declared.d]];
  const ratios = axes.map((a) => a[1] / a[2]).filter((x) => Number.isFinite(x) && x > 0);
  const ratio = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  const axisRatios = {};
  for (const a of axes) axisRatios[a[0]] = r1((a[1] / a[2]) * 1000) / 1000;
  // ⚠️ **必须逐轴判**，不能用平均比值。反例就是我自己的第一版：
  //    demo-freezer-upright 实测 709×972×782 vs 声明 700×1000×690 —— 宽 +1%、高 −3%、**深 +13%**，
  //    平均下来却"像" 1:1，于是判成 1:1（真值是 fit）。平均会把不齐的轴**平均掉**。
  const allNear = (target) => axes.every((a) => Math.abs(a[1] / a[2] - target) / target < 0.05);
  if (allNear(1)) return { code: 'same', ratio: r1(ratio * 1000) / 1000, axisRatios, why: '**逐轴**都在 5% 以内 → 单位一致，尺寸也对得上' };
  if (allNear(1000)) return { code: 'm', ratio, axisRatios, why: '实测**逐轴**都是声明的 1000 倍 → 模型用**米**，声明的**毫米**' };
  if (allNear(0.001)) return { code: 'mm-in-m', ratio, axisRatios, why: '实测**逐轴**都是声明的 1/1000 → 与声明量纲差 1000 倍' };
  if (allNear(10)) return { code: 'cm', ratio, axisRatios, why: '实测**逐轴**都是声明的 10 倍 → 模型可能用**厘米**' };
  const worst = axes.map((a) => ({ k: a[0], off: Math.abs(a[1] / a[2] - 1) })).sort((x, y) => y.off - x.off)[0];
  return {
    code: 'off', ratio: r1(ratio * 1000) / 1000, axisRatios,
    why: '逐轴比值 ' + axes.map((a) => a[0] + ' ' + axisRatios[a[0]]).join(' / ') +
      ' —— 差最多的是「' + worst.k + '」（' + Math.round(worst.off * 100) + '%）。' +
      '**不是单位问题**（单位错的话三轴会一起差 1000 倍），是模型与声明尺寸本身不同',
  };
}

/* ── 贴图统计（面数与显存都受它影响）──────────────────────────────────── */
function collectTextures(root) {
  const seen = new Map();
  root.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const mat of mats) {
      for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap', 'aoMap']) {
        const t = mat && mat[k];
        const img = t && t.image;
        if (!img || !img.width) continue;
        const id = img.uuid || (img.width + 'x' + img.height + ':' + (img.src || '').slice(-24));
        if (!seen.has(id)) seen.set(id, { w: img.width, h: img.height, bytes: estimateBytes(img) });
      }
    }
  });
  const list = [...seen.values()];
  return { count: list.length, bytes: list.reduce((a, t) => a + t.bytes, 0), list: list.slice(0, 8) };
}

function estimateBytes(img) {
  const w = img.width || 0, h = img.height || 0;
  if (!w || !h) return 0;
  const bpp = 4;                                   // 未压缩 RGBA 的显存占用（上传校验看的是这个）
  return Math.round(w * h * bpp * (4 / 3));        // 假设源是 JPEG/WebP 再叠 mipmap
}

/* ── 门／盖／抽屉：按约定找节点，并把铰链读出来 ───────────────────────── */

/** partType 是**模型自己声明的零件类型**（extras 扁平字段），不是名字猜测。 */
function partFromType(type) {
  const t = String(type || '').toLowerCase();
  if (!t || t === 'body') return null;
  if (t.indexOf('drawer') >= 0) return 'drawer';
  if (t.indexOf('lid') >= 0) return 'top';
  if (t.indexOf('door_upper') >= 0 || t.indexOf('door_lower') >= 0 || t.indexOf('double') >= 0) return 'double';
  if (t.indexOf('upper') >= 0 || t.indexOf('lower') >= 0) return 'double';
  if (t.indexOf('door') >= 0) return 'single';
  return null;
}

function axisOfType(part) {
  if (part === 'top' || part === 'drawer') return 'x';
  return 'y';
}

/** hingeAxis 可以是 [0,1,0]、"y" 或 {axis:"y"}；返回主轴 + 该轴分量的正负。 */
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

function finiteNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 门节点原点通常**不在铰链上**（352 的门原点在门中心）。模型 extras 里如果带了
 * `partType / hingeAxis / hingePoint / openAngleDeg / openDirection`，就按真实铰链识别，
 * 不再因为名字不在约定名单里而静默当成"没有门"。
 */
function extrasDoor(node, m, all) {
  const u = node.userData || {};
  const nested = u.hinge && typeof u.hinge === 'object' ? u.hinge : null;
  const partType = typeof u.partType === 'string' ? u.partType : (nested && nested.partType);
  const part = partFromType(partType) || (nested && partFromType(nested.part)) || null;
  const axisInfo = axisInfoOf(u.hingeAxis) || axisInfoOf(nested && nested.axis);
  const pivotRaw = Array.isArray(u.hingePoint) ? u.hingePoint : (nested && nested.pivotMm);
  const pivotMm = Array.isArray(pivotRaw) && pivotRaw.length === 3
    ? pivotRaw.map(Number) : null;
  const hasPivot = !!pivotMm && pivotMm.every(Number.isFinite);
  // 只有"像可动件"的节点才收：partType 指向门/盖/抽屉，或明确给了铰链数据
  if (!part && !axisInfo && !hasPivot && !nested) return null;
  const spec = all.find((x) => x.node === partType);
  const expectedAxis = spec ? spec.axis : axisOfType(part || 'single');
  const angleRaw = typeof u.openAngleDeg !== 'undefined'
    ? finiteNumber(u.openAngleDeg)
    : (nested && typeof nested.angle === 'number' ? r1((nested.angle * 180) / Math.PI) : null);
  const dirRaw = typeof u.openDirection === 'string' ? u.openDirection : (nested && nested.dir);
  const dir = dirRaw === '-' || dirRaw === '+' ? dirRaw : null;
  return {
    part: part || 'single',
    node: node.name,
    specCompliant: false,             // 名字不在约定名单里就是 false —— 这是事实，不粉饰
    expectAxis: expectedAxis,
    axisMatches: axisInfo ? axisInfo.axis === expectedAxis : null,
    angleDeg: angleRaw,
    dir,
    // 真实铰链：pivotMm 是**模型根局部 mm**（352 的 [287.71,70,363]）
    pivotMm: hasPivot ? pivotMm : null,
    openDirection: dir,
    axisSign: axisInfo ? axisInfo.sign : 1,
    fromExtras: true,
    partType: partType || null,
    ...doorPlacement(node, m),
  };
}

function detectDoors(root, m) {
  const all = DOOR_NODES.map((x) => Object.assign({ spec: true }, x))
    .concat(DOOR_VARIANTS.map((x) => Object.assign({ spec: false }, x)));
  const found = [];
  const seen = new Set();
  for (const spec of all) {
    const node = root.getObjectByName(spec.node);
    if (!node) continue;
    seen.add(spec.node);
    const h = (node.userData && node.userData.hinge) || null;
    found.push({
      part: spec.part, node: spec.node, specCompliant: spec.spec,
      expectAxis: spec.axis,
      axisMatches: h ? h.axis === spec.axis : null,
      angleDeg: h && typeof h.angle === 'number' ? r1((h.angle * 180) / Math.PI) : null,
      dir: h ? (h.dir || null) : null,
      ...doorPlacement(node, m),
    });
  }
  // 名单之外但模型 extras 明确声明了可动件的节点：必须识别，不许静默丢
  root.traverse((o) => {
    if (!o.name || seen.has(o.name)) return;
    const d = extrasDoor(o, m, all);
    if (!d) return;
    seen.add(o.name);
    found.push(d);
  });
  // 兜底：名字里带 door / lid 的都捞出来**只作事实汇报**，不据此定型。
  // 用处：出现全新命名时，人能看到"模型里到底有什么"，而不是被告知"没有门"。
  const loose = [];
  root.traverse((o) => {
    const n = (o.name || '').toLowerCase();
    if (!o.name) return;
    if (n.indexOf('door') >= 0 || n.indexOf('lid') >= 0 || n.indexOf('drawer') >= 0) loose.push(o.name);
  });
  const missing = DOOR_NODES.filter((s2) => !root.getObjectByName(s2.node)).map((s2) => s2.node);
  return { found, missing, loose, conventions: DOOR_NODES.length };
}

/** 这扇门在模型的哪个方向（用来推"正对面"）—— 只看水平面上的主方向。 */
/**
 * 门"在哪一侧"。
 *
 * ⚠️ 关键是**用哪个点**：门节点的原点通常是**铰链位置**（本来就偏心），
 * 拿它判方位等于拿门轴判门在哪 —— 实测 demo-freezer-dual 的 pivot 是 x 0.235 / z 0.234，
 * 横纵几乎等距，于是三台模型全被判成"抛硬币"。
 * 改用**门网格自己的包围盒中心**（那才是门的重心），并把距模型中心的毫米数当依据交出来。
 */
function doorPlacement(node, m) {
  const box = new THREE.Box3().setFromObject(node);
  const c = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
  const dx = c.x - m.center.x;
  const dz = c.z - m.center.z;
  const mx = Math.max(Math.abs(dx), Math.abs(dz));
  const margin = mx > 1e-6 ? r1(((mx - Math.min(Math.abs(dx), Math.abs(dz))) / mx) * 100) / 100 : -1;
  const mmx = r1(dx * 1000);
  const mmz = r1(dz * 1000);
  // 门在**模型正中**（偏移 < 5 mm）时，它**没有方位信息** —— 典型就是顶开式的顶盖。
  // 实测 demo-freezer-chest 的 top_lid 落在 x0/z0，第一版却据此给出「+x，置信 0.9」= **假确定性**。
  // 宁可说"不知道"，也不给一个看起来很像样的错答案。
  if (mx * 1000 < 5) {
    return {
      side: null, sideMargin: -1, doorOffsetMm: { x: mmx, z: mmz },
      why: '门心就在模型正中（偏移 ' + mmx + '/' + mmz + ' mm）→ **这个门没有方位信息**，不能用来推正对面',
    };
  }
  return {
    side: Math.abs(dx) >= Math.abs(dz) ? (dx >= 0 ? '+x' : '-x') : (dz >= 0 ? '+z' : '-z'),
    sideMargin: margin,
    doorOffsetMm: { x: r1(dx * 1000), z: r1(dz * 1000) },   // 依据：门心离模型中心多远（mm）
  };
}

/* ── 校验：每一条都写清「判据 + 不合格怎么办」──────────────────────────── */
function buildChecks(o) {
  const out = [];
  const add = (key, level, text, why) => out.push({ key, level, text, why });
  const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

  add('parse', 'ok', 'GLB 可解析',
    '已经用与前台**同一个** loader 解析成功（含 meshopt 解码）—— 不是另写一套解析器');

  // docs/07 §10.1：文件单位 m；旧 mm 文件已由 parseGlbBuffer 归一化，但必须回报出来
  add('modelUnit', o.sourceUnit === 'mm' ? 'warn' : 'ok',
    o.sourceUnit === 'mm' ? '源文件单位 mm（已 ×0.001 归一化）' : '源文件单位 m',
    o.sourceUnit === 'mm'
      ? '历史文件是毫米；本次分析已**显式**换算到米，bbox 不会再 ×1000。入库仍建议供应商按 docs/07 §10.1 交 m 文件'
      : '与 docs/07 §10.1 一致：1 unit = 1 m，读取尺寸不再乘 1000 当文件单位');

  // 源文件大是**正常的**：压缩在后头（LOD 异步跑）。这一条绝不拦人。
  add('file', 'ok', mb(o.sizeBytes) + '（源文件）',
    o.sizeBytes > LIMITS.lod0Bytes
      ? '交付口径是 LOD0 ≤ 3 MB，但那是**压缩后**的量。源文件大不是毛病 —— 跑完 LOD 再核这一条'
      : '源文件本身就已经在 3 MB 以内');

  if (o.triangles > LIMITS.lod0Triangles) {
    add('triangles', 'warn', o.triangles + ' 面（源）',
      '交付硬上限是 LOD0 ≤ 60,000 面（docs/07 §6）。优化器会降到目标；**若它到不了，本模型不能收** —— 所以跑完 LOD 要回来看这条');
  } else {
    add('triangles', 'ok', o.triangles + ' 面', '未超过 LOD0 的 60,000 面（docs/07 §6）');
  }

  const oMax = Math.max(Math.abs(o.originMm.x), Math.abs(o.originMm.y), Math.abs(o.originMm.z));
  if (oMax > LIMITS.originMm) {
    add('origin', 'warn', '原点偏 ' + r1(oMax) + ' mm',
      '规范要求「底面中心在原点」（docs/07 §2）。前台会**自动纠偏**，但偏差量必须记进 delta_vs_source_json —— 否则供应商模型的合规性永远查不出来');
  } else {
    add('origin', 'ok', '原点合规', '底面中心在原点（偏差 ' + r1(oMax) + ' mm，容差 ' + LIMITS.originMm + '）');
  }

  if (o.textures.bytes > LIMITS.textureBytes) {
    add('textures', 'warn', o.textures.count + ' 张贴图 ≈ ' + mb(o.textures.bytes),
      'docs/07 §6：单模型纹理 ≤ 8 MB。压缩会按 LOD 重采样到 1024/512/256；跑完看结果');
  } else {
    add('textures', 'ok', o.textures.count + ' 张贴图 ≈ ' + mb(o.textures.bytes), '未超过 8 MB');
  }

  const names = o.doors.found.map((d) => d.node);
  if (!names.length) {
    add('doorNodes', 'warn', '找不到任何约定门节点',
      '按 docs/07 §3 找了 ' + o.doors.conventions + ' 个约定名，一个都没有 → **门型降级为人工选**（设计里写死了：不是拒绝入库）。没有门节点就没有开门动画，开门净空体检也算不了');
  } else {
    add('doorNodes', 'ok', '门节点：' + names.join(' / '),
      '按 docs/07 §3 的约定名找到 ' + names.length + ' 个；铰链应写在节点 extras.hinge');
  }
  const nonSpec = o.doors.found.filter((d) => !d.specCompliant).map((d) => d.node);
  if (nonSpec.length) {
    add('doorNaming', 'warn', '门节点名不符合约定：' + nonSpec.join(' / '),
      'docs/07 §3 约定 door_upper / door_lower / door_single / lid_top —— 而实测**现存的 4 个模型一个都没按它命名**（outer_door / upper_door+lower_door / single_door / top_lid）。' +
      '**改名是安全的**（节点名只在模型内部用）；不改的代价是每上一个新型号都要**手工绑一次门**，开门角度也只能靠估');
  } else if (o.doors.found.length) {
    add('doorNaming', 'ok', '门节点名符合约定', '按 docs/07 §3 找到：' + o.doors.found.map((d) => d.node).join(' / '));
  }

  const noHinge = o.doors.found.filter((d) => d.axisMatches === null).map((d) => d.node);
  if (names.length && noHinge.length) {
    add('hinge', 'warn', '模型里没写铰链：' + noHinge.join(' / '),
      '节点缺 extras.hinge（axis/angle/dir）。**这不是"模型坏了"**：现存 4 个型号都靠目录里的 doors 补（products.json 带 openAngleRad 与 pivot）。' +
      '代价是每上一个新型号都要**人工绑一次**；若模型自带铰链，这一步就能全自动');
  } else if (names.length) {
    add('hinge', 'ok', '铰链已读到', '每扇门都带 extras.hinge（axis/angle/dir）');
  }

  if (o.declared) {
    const u = inferUnit(o.mm, o.declared);
    const d = o.declared;
    if (u.code === 'm' || u.code === 'mm-in-m' || u.code === 'cm') {
      add('declared', 'bad', '单位对不上：' + u.why,
        '先把量纲统一到 mm 再传 —— **尺寸猜错是历史第一大坑**（docs/07 §2）。这一条拦人，因为下游全部几何都建立在它上面');
    } else if (u.code === 'off') {
      // ⚠️ 不报 bad。**实测 ≠ 声明有两种完全不同的情况** —— 把它们混成一个错就是假警报：
      //   ① 模型本来就不是 1:1（按外观重建的）→ 交付走 fit：按声明包络等比缩放。
      //      **现有 4 个型号全都是这一类**（实测 525.5×990×517 vs 声明 990×1980×871），它们是好模型。
      //   ② 供应商声称"就是实物的 1:1"却对不上 → 那才是要他去对账。
      // 机器只报事实，**这一条要人判**。（同一个数字在不同模式下不是同一件事 —— 这是本项目第三次栽在这上面）
      add('declared', 'warn', '实测与声明不同：' + o.mm.w + '×' + o.mm.d + '×' + o.mm.h +
        ' vs 声明 ' + d.w + '×' + d.d + '×' + d.h,
        '**这不一定是错**：① 模型按外观重建、本就不是 1:1 → 走 fit（按声明包络等比缩放，渲染比例与实物不同，现有 4 个型号都是这类）；② 供应商声称尺寸一致却对不上 → 让他去对账。请在上方选 envelope_mode');
    } else {
      add('declared', 'ok', '尺寸与声明一致 → 可走 1:1（几何即实物比例）',
        '实测 ' + o.mm.w + '×' + o.mm.d + '×' + o.mm.h + ' mm vs 声明 ' + d.w + '×' + d.d + '×' + d.h + '（容差 5%）');
    }
  } else {
    add('declared', 'warn', '还没填声明尺寸',
      '没有声明值就没法对账、也没法推断单位 —— 而单位与尺寸是**少数必须人工录**的字段（其余都能拾取）');
  }
  return out;
}

/* ── 5 项自动拾取（每个都带 依据 + 置信度，且**都能被改掉**）────────────── */
function buildPicks(root, m, doors, declared, unitInfo = { sourceUnit: 'm', scale: 1 }) {
  const fromMm = unitInfo.sourceUnit === 'mm';
  return {
    thumb: pickThumb(root, m),
    size: {
      w: r1(m.mm.w), h: r1(m.mm.h), d: r1(m.mm.d), unit: 'mm',
      sourceUnit: unitInfo.sourceUnit,
      unitScale: unitInfo.scale,
      auto: true, confidence: 1,
      evidence: fromMm
        ? 'Box3 实测包围盒；源文件是 mm，已按 docs/07 §10.1 显式 ×0.001 归一化后再 ×1000 报 mm（不会出现 ×1000 的假数）'
        : 'Box3 实测包围盒（与前台同一口径：先 updateMatrixWorld，再读世界矩阵后的尺寸；源文件单位 m）',
      humanRequired: false,
    },
    topView: pickTopView(root, m),
    envelope: pickEnvelope(m, declared),
    front: pickFront(doors),
    door: pickDoor(doors),
  };
}

function pickThumb(root, m) {
  const url = renderModel(root, m, { size: 256, view: 'threeQuarter' });
  return {
    dataUrl: url, auto: !!url, confidence: url ? 1 : 0,
    evidence: '离屏 WebGL，3/4 视角、透明底（与前台型号卡同一套相机与灯光口径）',
    humanRequired: true,
  };
}

function pickTopView(root, m) {
  const url = renderModel(root, m, { size: 512, view: 'top' });
  return {
    dataUrl: url, auto: !!url, confidence: url ? 1 : 0,
    bboxMm: { w: r1(m.mm.w), d: r1(m.mm.d) },
    unit: 'mm',
    evidence: '正交俯视、透明底；长边归一化到画布，**占地尺寸另存 bbox** —— 平面图按它贴真实轮廓（不改内核几何判定）',
    humanRequired: true,
  };
}

/**
 * 正对面：**只给候选，不假装知道**（设计里这一项本来就写着"部分能，必须人工确认一次"）。
 * 最硬的信号是"门在哪一侧"；没有门就只能给低置信候选，甚至不给。
 */
/**
 * envelope_mode：这一项**决定了"渲染比例是不是实物比例"**，所以必须显式给出来、可改。
 * 判据只有一个：实测与声明是否一致（单位错的情形已在 checks 里拦下）。
 */
function pickEnvelope(m, declared) {
  if (!declared) {
    return { mode: null, auto: false, confidence: 0,
      evidence: '没有声明尺寸 → 判不了 1:1 还是 fit（这也是为什么声明尺寸必须人工录）', humanRequired: true };
  }
  const u = inferUnit(m.mm, declared);
  const same = u.code === 'same';
  return {
    mode: same ? '1:1' : 'fit', auto: true, confidence: same ? 1 : 0.7,
    evidence: same
      ? '实测与声明一致 → 可以 1:1（几何即实物比例，不缩放）'
      : '实测与声明不同（比值 ' + u.ratio + '）→ 走 fit：按声明包络等比缩放。**现有 4 个型号都是这一类**',
    humanRequired: true,
  };
}

function pickFront(doors) {
  const sides = doors.found.map((d) => d.side).filter(Boolean);   // 已在正中的门（side=null）自动被排除
  const centred = doors.found.filter((d) => !d.side).map((d) => d.node);
  if (sides.length) {
    const count = {};
    for (const s of sides) count[s] = (count[s] || 0) + 1;
    const best = Object.keys(count).sort((a, b) => count[b] - count[a])[0];
    const unanimous = count[best] === sides.length;
    // 门在 x / z 上几乎等距（比如 demo-freezer-dual 的门 pivot 是 x 0.235 / z 0.234）→ 方位是**抛硬币**。
    // 这种时候必须把置信度压下来并说出来，而不是给个 0.9 让人以为机器很确定。
    const margins = doors.found.map((d) => d.sideMargin).filter((x) => typeof x === 'number' && x >= 0);
    const minMargin = margins.length ? Math.min.apply(null, margins) : 1;
    const tied = minMargin < 0.25;
    return {
      candidates: Object.keys(count).map((s) => ({ side: s, score: count[s] })),
      picked: best, auto: true,
      tie: tied, sideMargin: minMargin,
      confidence: tied ? 0.45 : unanimous ? 0.9 : 0.6,
      evidence: '按门所在方向推的（' + sides.length + ' 扇门里 ' + count[best] + ' 扇在 ' + best + ' 侧' +
        (unanimous ? '，方向一致' : '，方向不一致') + '；门心偏移 ' +
        doors.found.filter((d) => d.doorOffsetMm).map((d) => d.node + ' ' + d.doorOffsetMm.x + '/' + d.doorOffsetMm.z + ' mm').join('、') + '）。' +
        (tied
          ? '⚠️ 但门到中心的**横向与纵向几乎等距**（差 ' + Math.round(minMargin * 100) + '%）→ 方位本身是**抛硬币**，请务必人工确认'
          : '**这是推断不是事实**，请确认一次'),
      humanRequired: true,
    };
  }
  return {
    candidates: [{ side: '-z', score: 0 }, { side: '+z', score: 0 }, { side: '-x', score: 0 }, { side: '+x', score: 0 }],
    picked: null, auto: false, confidence: 0,
    evidence: '模型里**没有能提供方位信息的门**（没找到门，或门在模型正中 —— 典型是顶开式顶盖）→ 失去最可靠的正面特征，机器**不敢猜**。请人工指定（行业默认：正面朝 -z，即朝向观察者）',
      centred: doors.found.filter((d) => !d.side).map((d) => d.node),
    humanRequired: true,
  };
}

/**
 * 开门类型：**靠约定，不靠猜**（docs/07 §3 把节点名与铰链轴定死了）。
 * 分清两件事：门型（柜门/双门/上盖/抽屉 = **产品事实**）与开门方式（侧开/顶开/抽拉 = 几何约定）。
 */
function pickDoor(doors) {
  const parts = doors.found.map((d) => d.part);
  const axis = doors.found.length ? doors.found[0].expectAxis : null;
  const open = axis === 'y' ? 'side' : axis === 'x' ? (parts.indexOf('drawer') >= 0 ? 'pull' : 'top') : null;
  // 优先级：顶开 > 双门 > 单门 > 抽屉。有门的柜子**即使柜内有抽屉**，它也是"双门柜"——
  // 抽屉是柜内的结构件，不是这个产品的门型（demo-freezer-dual 就是这种：有门，也有 6 层抽屉）。
  const part = parts.indexOf('top') >= 0 ? 'top'
    : parts.indexOf('double') >= 0 ? 'double'
      : parts.indexOf('single') >= 0 ? 'single'
        : parts.indexOf('drawer') >= 0 ? 'drawer' : null;
  return {
    doorPart: part, openType: open, axis,
    hingeDeg: doors.found.length ? doors.found[0].angleDeg : null,
    auto: !!part, confidence: part ? 0.95 : 0,
    evidence: part
      ? '找到门节点 ' + doors.found.map((d) => d.node).join(' / ') + '（' +
        (doors.found.every((d) => d.specCompliant) ? '符合 docs/07 §3 约定' : '**实测别名** —— 不符合约定，见「门节点名」那条体检') +
        '）→ 门型 ' + part +
        (open ? '、开门方式 ' + open + '（铰链轴 ' + axis + '）' : '')
      : '没有约定门节点 → 门型必须人工选（它不是"能猜出来的东西"，是产品事实）',
    humanRequired: true,
  };
}

/* ── 离屏渲染（缩略图 / 正交俯视）─────────────────────────────────────
 * 为什么这里自己建渲染器，而不复用 thumbs.js 的：那条路**已经在跑、且有 sessionStorage 缓存**
 * （96×96、缓存键带 STYLE）。为了不打扰它（尺寸/队列/已验证的行为），这里单开一个。
 * 代价是多几十行；收益是"前台缩略图那条路一个字都没动"。 */
function renderModel(root, m, opts) {
  const size = (opts && opts.size) || 256;
  const view = (opts && opts.view) || 'threeQuarter';
  let renderer = null;
  let scene = null;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(2);
    renderer.setSize(size, size, false);
    renderer.setClearAlpha(0);

    scene = new THREE.Scene();
    const maxDim = Math.max(m.size.x, m.size.y, m.size.z) || 1;
    let cam;
    if (view === 'top') {
      const half = (Math.max(m.size.x, m.size.z) * 1.06) / 2 || 1;
      cam = new THREE.OrthographicCamera(-half, half, half, -half, 0.01, maxDim * 12 + 10);
      cam.position.set(m.center.x, m.max.y + maxDim, m.center.z);
      cam.up.set(0, 0, -1);                    // 俯视图习惯：+x 向右、+z 向下
      cam.lookAt(m.center.x, m.center.y, m.center.z);
    } else {
      cam = new THREE.PerspectiveCamera(35, 1, maxDim / 100, maxDim * 100);
      const r = maxDim * 1.9;
      cam.position.set(m.center.x + r * 0.72, m.center.y + r * 0.55, m.center.z + r * 0.72);
      cam.lookAt(m.center.x, m.center.y, m.center.z);
    }
    const key = new THREE.DirectionalLight(0xffffff, 2.1);
    key.position.set(1.2, 2.0, 1.6);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.9);
    fill.position.set(-1.4, 0.8, -1.2);
    scene.add(fill);
    scene.add(new THREE.AmbientLight(0xffffff, 1.1));

    scene.add(root);
    renderer.render(scene, cam);
    return renderer.domElement.toDataURL('image/png');
  } catch (e) {
    console.warn('[analyze] 渲染失败（拾取继续，只是没有图）:', e && e.message);
    return null;
  } finally {
    if (scene && root.parent === scene) scene.remove(root);   // 别把物件留在临时场景里
    // ⭐ 归还 WebGL 上下文（和 `scene3d.js` 里 B18 那条同一个道理）：
    //    `dispose()` 只清自己手里的资源，**不会**把上下文还给浏览器。浏览器同时只允许有限个
    //    WebGL 上下文，超了会偷偷丢掉最早那个（画面变黑，而且不报错）—— 而这块核显的显存与
    //    系统内存是共用的，没归还的上下文一直占着，挤的是可用内存。
    //    这个函数**每渲染一张图就新建一个渲染器**（下面 `new THREE.WebGLRenderer`，
    //    还带 antialias / preserveDrawingBuffer），维护端翻一遍产品列表就能攒下一撑。
    renderer?.forceContextLoss();
    renderer?.dispose();
  }
}
