/**
 * hotspot-edit.js —— 维护端热点编辑器的纯计算层
 *
 * 这里只做**能单测的判断与拼装**：上限、校验、payload、归一化视角、内容草稿。
 * 矩阵/节点解析/坐标换算一律走 `app/src/hotspot.js`，这里不复制第二套 ——
 * 本项目已经因为「同一件事两处实现」踩过多次（热点坐标尤其不能）。
 */
import {
  normalizeCamera, resolveNode, toWorldPosition, uniformWorldScale,
} from '../hotspot.js';

export const HOTSPOT_LIMITS = {
  hotspots: 50,
  title: 40,
  body: 300,
  sellingPoints: 8,
  sellingPointChars: 200,
  params: 50,
  paramKey: 40,
  paramValue: 200,
  paramUnit: 16,
  paramGroup: 40,
};

export const DOOR_STATES = ['any', 'open', 'closed'];
export const DOOR_STATE_LABEL = { any: '任何门状态', open: '仅开门', closed: '仅关门' };
export const INVALID_LABEL = {
  'anchor-missing': '锚点节点在当前模型里找不到',
  'index-out-of-range': '同名节点序号超出当前模型',
  'unit-mismatch': '锚点节点缩放不等比，无法换算坐标',
  'model-not-ready': '模型未就绪，无法校验锚点',
  // 历史兼容：验收-3 起服务端不再用全局 bbox 判局部坐标；新保存不会产生这个 reason。
  'out-of-bounds': '坐标超出模型包围盒',
};

/**
 * 保存闸门要拦的锚点原因：这几类在**当前模型**里根本定位不到（或换算不出坐标），
 * 发布出去设计端只会把它列进「需复核」、3D 里永远看不到 —— 也就是 2026-11-24 那条
 * 「铭牌 #0/#4/DEMO-FZ-040/... 找不到」的事故形态。
 *
 * 刻意**不拦** `model-changed`：锚点还在，只是模型换了要复核位置；拦它等于每次模型
 * 重新导出都把全部热点锁死，那是另一种坏味道。`out-of-bounds` 是历史 reason，
 * 只要当前模型里解析得到、坐标换得回去，就允许保存。
 */
export const ANCHOR_BLOCK_REASONS = ['anchor-missing', 'index-out-of-range', 'unit-mismatch'];

/** 保存被拦时的那一句（要求原样出现「有 N 条热点锚点无效，未保存」） */
export function anchorGateText(n) {
  return '有 ' + (Number(n) || 0) + ' 条热点锚点无效，未保存';
}

/** 单条被拦项的说明：序号 + 标题 + 原因 + 原始路径（用户据此决定重选还是删除） */
export function anchorIssueText(b) {
  const x = b || {};
  const seq = Number(x.index) || 1;
  const reason = INVALID_LABEL[String(x.reason || '')] || String(x.reason || '锚点无效');
  return '#' + String(seq).padStart(2, '0') + ' ' + (x.title || '未命名热点') + '：' + reason
    + (x.detail ? '（' + x.detail + '）' : '');
}

/**
 * 单条热点锚点问题（只做几何解析，不看服务端历史结论）。
 * 返回 null = 当前模型里能定位；否则 `{ reason, detail }`。
 * `modelRoot` 为空时给 `model-not-ready` —— 没有模型就没有「能定位」可言。
 */
export function anchorProblem(h, modelRoot) {
  const x = h || {};
  if (!modelRoot) return { reason: 'model-not-ready', detail: '3D 模型未就绪' };
  const node = resolveNode(modelRoot, x.nodePath, x.nodeIndex);
  if (!node) {
    const path = Array.isArray(x.nodePath) ? x.nodePath.join('/') : '';
    return { reason: 'anchor-missing', detail: path || '（空路径）' };
  }
  if (uniformWorldScale(node) == null) {
    return { reason: 'unit-mismatch', detail: '锚点世界矩阵三轴缩放不等比' };
  }
  if (!toWorldPosition(node, x.position)) {
    return { reason: 'unit-mismatch', detail: '锚点坐标无法换算' };
  }
  return null;
}

/**
 * 保存/发布前的整表锚点闸门。
 * 返回 `{ ok, total, blocked: [{ index, id, title, nodePath, nodeIndex, reason, detail }] }`。
 *
 * 规则：
 *  1. 服务端/上次解析给出的锚点失效（`invalidReason`）是权威结论 —— 用户必须**明确重选**
 *     一次锚点（重选会清掉 invalidReason）才能保存，不让旧结论被悄悄覆盖；
 *  2. 其余按当前模型实时解析；
 *  3. 模型未就绪时，有热点就整表拦下（无法校验就不发布）。
 *
 * 传入顺序最好先 `sortBySeq`：`index` 是按传入顺序的 1 基序号，用来对上界面上的 #NN。
 */
export function anchorGate(list, modelRoot) {
  const items = Array.isArray(list) ? list : [];
  const blocked = [];
  for (let i = 0; i < items.length; i += 1) {
    const x = items[i] || {};
    const stored = String(x.invalidReason || '').trim();
    const p = ANCHOR_BLOCK_REASONS.includes(stored)
      ? { reason: stored, detail: x.invalidDetail || (Array.isArray(x.nodePath) ? x.nodePath.join('/') : '') }
      : anchorProblem(x, modelRoot);
    if (!p) continue;
    blocked.push({
      index: i + 1,
      id: x.id == null ? null : x.id,
      title: String(x.title == null ? '' : x.title),
      nodePath: Array.isArray(x.nodePath) ? x.nodePath.slice() : [],
      nodeIndex: x.nodeIndex,
      reason: p.reason,
      detail: p.detail,
    });
  }
  return { ok: blocked.length === 0, total: items.length, blocked };
}

export function blankCamera() {
  return normalizeCamera({ azimuthDeg: 28, elevationDeg: 12, distFactor: 1.8, target: [0.5, 0.5, 0.5], fov: 42 });
}

/** 新建一条本地热点（id 用 string 临时键；落库前由服务端分配 number） */
export function newHotspot(seq, opts = {}) {
  const o = opts || {};
  return normalizeHotspot({
    id: 'new-' + (o.key || Date.now() + '-' + seq),
    seq,
    title: o.title || '热点 ' + (seq + 1),
    body: o.body || '',
    nodePath: o.nodePath || [],
    nodeIndex: o.nodeIndex || 0,
    nodeName: o.nodeName || '',
    position: o.position || { x: 0, y: 0, z: 0 },
    normal: o.normal || { x: 0, y: 0, z: 1 },
    camera: o.camera || blankCamera(),
    doorState: 'any',
  });
}

/** 把接口/种子来的行补齐成编辑器认的形状；**不丢 invalidReason** */
export function normalizeHotspot(h) {
  const x = h || {};
  const path = Array.isArray(x.nodePath) ? x.nodePath.map((v) => String(v)) : [];
  const pos = x.position || {};
  const normal = x.normal || {};
  const state = DOOR_STATES.includes(x.doorState) ? x.doorState : 'any';
  return {
    id: x.id,
    seq: Number.isFinite(Number(x.seq)) ? Number(x.seq) : 0,
    title: String(x.title == null ? '' : x.title),
    body: String(x.body == null ? '' : x.body),
    nodePath: path,
    nodeIndex: Number.isFinite(Number(x.nodeIndex)) ? Number(x.nodeIndex) : 0,
    nodeName: String(x.nodeName || path[path.length - 1] || ''),
    position: {
      x: Number(pos.x) || 0,
      y: Number(pos.y) || 0,
      z: Number(pos.z) || 0,
    },
    normal: {
      x: Number(normal.x) || 0,
      y: Number(normal.y) || 0,
      z: Number(normal.z) || 1,
    },
    camera: normalizeCamera(x.camera || blankCamera()),
    doorState: state,
    // 产品级动作库的 key（不是 id）：空表示这个热点只弹说明、不执行动作。
    actionKey: x.actionKey == null || x.actionKey === '' ? null : String(x.actionKey),
    // 仅编辑器内存：用于红标与 warnings，不提交到 hotspots[]
    invalidReason: x.invalidReason || '',
    invalidDetail: x.invalidDetail || '',
  };
}

export function sortBySeq(list) {
  return (Array.isArray(list) ? list : [])
    .slice()
    .sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
}

export function countsOf(list) {
  const arr = Array.isArray(list) ? list : [];
  const invalid = arr.filter((h) => !!h.invalidReason).length;
  return { total: arr.length, valid: arr.length - invalid, invalid };
}

export function canAdd(list, limits = HOTSPOT_LIMITS) {
  return (Array.isArray(list) ? list.length : 0) < Number(limits.hotspots || 50);
}

/** 字符数按 Unicode 码点算，避免 emoji 被算成两个 */
export function charCount(s) {
  return Array.from(String(s == null ? '' : s)).length;
}

export function limitText(s, max) {
  const arr = Array.from(String(s == null ? '' : s));
  return arr.slice(0, Math.max(0, Number(max) || 0)).join('');
}

/** 单条热点结构校验：失效锚点**不在这里拦**（它是 warning，不是结构错误） */
export function validateHotspot(h) {
  const issues = [];
  const x = h || {};
  if (!String(x.title || '').trim()) issues.push({ level: 'bad', code: 'title-required', message: '标题不能为空' });
  if (charCount(x.title) > HOTSPOT_LIMITS.title) {
    issues.push({ level: 'bad', code: 'title-too-long', message: '标题超过 ' + HOTSPOT_LIMITS.title + ' 字' });
  }
  if (!String(x.body || '').trim()) {
    issues.push({ level: 'bad', code: 'body-required', message: '正文不能为空' });
  }
  if (charCount(x.body) > HOTSPOT_LIMITS.body) {
    issues.push({ level: 'bad', code: 'body-too-long', message: '正文超过 ' + HOTSPOT_LIMITS.body + ' 字' });
  }
  // 锚点失效（anchor-missing / index-out-of-range / model-changed）是**允许保存**的复核项：
  // 服务端已经给出 invalidReason 时不再把空路径当结构错误；用户改锚点/拖动会清掉它，
  // 那时才按“新热点必须有锚点”拦。否则失效热点永远改不动，只能删除后重建。
  const invalidAnchor = !!String(x.invalidReason || '').trim();
  if (!invalidAnchor && (!Array.isArray(x.nodePath) || !x.nodePath.length)) {
    issues.push({ level: 'bad', code: 'anchor-required', message: '还没有锚点节点' });
  }
  if (!invalidAnchor && (!Number.isInteger(Number(x.nodeIndex)) || Number(x.nodeIndex) < 0)) {
    issues.push({ level: 'bad', code: 'anchor-index-invalid', message: '锚点序号必须是非负整数' });
  }
  for (const k of ['x', 'y', 'z']) {
    if (!Number.isFinite(Number(x.position && x.position[k]))) {
      issues.push({ level: 'bad', code: 'position-invalid', message: '坐标不是有限数：' + k });
    }
  }
  if (!DOOR_STATES.includes(x.doorState)) {
    issues.push({ level: 'bad', code: 'door-state-invalid', message: '显示状态只能是 any/open/closed' });
  }
  return issues;
}

/** 整份草稿的结构校验（一次报全部；失效锚点由调用方放 warning） */
export function validateDraft(hotspots, content = {}) {
  const list = Array.isArray(hotspots) ? hotspots : [];
  const issues = [];
  if (list.length > HOTSPOT_LIMITS.hotspots) {
    issues.push({ level: 'bad', code: 'hotspot-too-many', message: '热点超过 ' + HOTSPOT_LIMITS.hotspots + ' 条上限' });
  }
  list.forEach((h, i) => {
    for (const x of validateHotspot(h)) {
      issues.push({ ...x, index: i, message: '#' + String(i + 1).padStart(2, '0') + ' ' + x.message });
    }
  });
  for (const x of validateContent(content)) issues.push(x);
  return issues;
}

/** 卖点/参数校验（与 105 §7.1 同口径；界面先拦，服务端仍会再判） */
export function validateContent(content = {}) {
  const c = content || {};
  const sp = Array.isArray(c.sellingPoints) ? c.sellingPoints : [];
  const params = Array.isArray(c.params) ? c.params : [];
  const issues = [];
  if (sp.length > HOTSPOT_LIMITS.sellingPoints) {
    issues.push({ level: 'bad', code: 'selling-too-many', message: '卖点最多 ' + HOTSPOT_LIMITS.sellingPoints + ' 条' });
  }
  sp.forEach((s, i) => {
    if (!String(s || '').trim()) issues.push({ level: 'bad', code: 'selling-empty', message: '卖点 ' + (i + 1) + ' 为空' });
    if (charCount(s) > HOTSPOT_LIMITS.sellingPointChars) {
      issues.push({ level: 'bad', code: 'selling-too-long', message: '卖点 ' + (i + 1) + ' 超过 ' + HOTSPOT_LIMITS.sellingPointChars + ' 字' });
    }
  });
  if (params.length > HOTSPOT_LIMITS.params) {
    issues.push({ level: 'bad', code: 'param-too-many', message: '参数最多 ' + HOTSPOT_LIMITS.params + ' 条' });
  }
  const keys = new Set();
  params.forEach((p, i) => {
    const key = String((p && p.key) || '').trim();
    if (!key) issues.push({ level: 'bad', code: 'param-key-required', message: '参数 ' + (i + 1) + ' 的 key 不能为空' });
    if (key.length > HOTSPOT_LIMITS.paramKey) issues.push({ level: 'bad', code: 'param-key-too-long', message: '参数 key 超过 ' + HOTSPOT_LIMITS.paramKey + ' 字' });
    if (keys.has(key)) issues.push({ level: 'bad', code: 'param-duplicate', message: '参数 key 重复：' + key });
    keys.add(key);
    if (String((p && p.value) || '').length > HOTSPOT_LIMITS.paramValue) {
      issues.push({ level: 'bad', code: 'param-value-too-long', message: '参数 ' + (i + 1) + ' 的值超过 ' + HOTSPOT_LIMITS.paramValue + ' 字' });
    }
    if (String((p && p.unit) || '').length > HOTSPOT_LIMITS.paramUnit) {
      issues.push({ level: 'bad', code: 'param-unit-too-long', message: '参数 ' + (i + 1) + ' 的单位超过 ' + HOTSPOT_LIMITS.paramUnit + ' 字' });
    }
    if (String((p && p.group) || '').length > HOTSPOT_LIMITS.paramGroup) {
      issues.push({ level: 'bad', code: 'param-group-too-long', message: '参数 ' + (i + 1) + ' 的分组超过 ' + HOTSPOT_LIMITS.paramGroup + ' 字' });
    }
  });
  return issues;
}

/** 提交给 PUT /hotspots 的整份数组：只保留契约字段，临时 id 不带上去 */
export function hotspotsPayload(list) {
  return sortBySeq(list).map((h, i) => {
    const x = normalizeHotspot(h);
    const out = {
      seq: i,
      title: x.title.trim(),
      body: x.body,
      nodePath: x.nodePath,
      nodeIndex: x.nodeIndex,
      nodeName: x.nodeName || x.nodePath[x.nodePath.length - 1] || '',
      position: { x: x.position.x, y: x.position.y, z: x.position.z },
      normal: { x: x.normal.x, y: x.normal.y, z: x.normal.z },
      camera: normalizeCamera(x.camera),
      doorState: x.doorState,
    };
    // 服务端给过的 number id 原样带回去；本地 new-* 不提交
    if (typeof x.id === 'number' || /^\d+$/.test(String(x.id || ''))) out.id = Number(x.id);
    // 空 actionKey 不写键（服务端按“未绑定”处理），避免旧数据被无意义地改成空串。
    if (x.actionKey) out.actionKey = x.actionKey;
    return out;
  });
}

/** 产品级 validation 快照（只含编辑器能算的三类；model-changed 归服务端） */
export function validationOf(list, model = {}) {
  const invalid = [];
  for (const h of Array.isArray(list) ? list : []) {
    if (!h || !h.invalidReason) continue;
    if (typeof h.id !== 'number' && !/^\d+$/.test(String(h.id || ''))) continue;
    invalid.push({
      hotspotId: Number(h.id),
      reason: h.invalidReason,
      detail: h.invalidDetail || '',
    });
  }
  const m = model || {};
  return {
    checkedAt: new Date().toISOString(),
    modelFingerprint: m.checksum ? String(m.variant || 'default') + ':' + String(m.checksum) : '',
    unit: m.unit || 'mm',
    invalid,
  };
}

/** 落库内容：卖点去空白、参数去空行；**简介不在里面**（复用 product.description） */
export function contentPayload(content = {}) {
  const c = content || {};
  return {
    sellingPoints: (Array.isArray(c.sellingPoints) ? c.sellingPoints : []).map((s) => String(s || '').trim()).filter(Boolean),
    params: (Array.isArray(c.params) ? c.params : [])
      .map((p) => ({
        key: String((p && p.key) || '').trim(),
        value: String((p && p.value) == null ? '' : p.value).trim(),
        unit: String((p && p.unit) || '').trim(),
        group: String((p && p.group) || '').trim(),
      }))
      .filter((p) => p.key),
  };
}

/** 归一化相机 → 世界位置/目标。纯数学，供编辑器 restore；不碰 three。 */
export function cameraFromOrbit(cam, bbox) {
  const c = normalizeCamera(cam);
  const b = bbox || {};
  const size = b.size || [1, 1, 1];
  const min = b.min || [0, 0, 0];
  const target = c.target.map((v, i) => Number(min[i] || 0) + v * Number(size[i] || 1));
  const diag = Math.hypot(Number(size[0]) || 0, Number(size[1]) || 0, Number(size[2]) || 0) || 1;
  const dist = c.distFactor * diag;
  const az = (c.azimuthDeg * Math.PI) / 180;
  const el = (c.elevationDeg * Math.PI) / 180;
  return {
    target,
    position: [
      target[0] + Math.sin(az) * Math.cos(el) * dist,
      target[1] + Math.sin(el) * dist,
      target[2] + Math.cos(az) * Math.cos(el) * dist,
    ],
    fov: c.fov,
  };
}

/** 世界位置/目标 → 归一化相机（与 cameraFromOrbit 互逆） */
export function orbitFromCamera(position, target, bbox, fov = 42) {
  const b = bbox || {};
  const size = b.size || [1, 1, 1];
  const min = b.min || [0, 0, 0];
  const dx = Number(position[0]) - Number(target[0]);
  const dy = Number(position[1]) - Number(target[1]);
  const dz = Number(position[2]) - Number(target[2]);
  const dist = Math.hypot(dx, dy, dz) || 1;
  const diag = Math.hypot(Number(size[0]) || 0, Number(size[1]) || 0, Number(size[2]) || 0) || 1;
  const target01 = [0, 1, 2].map((i) => {
    const s = Number(size[i]) || 1;
    return Math.min(1, Math.max(0, (Number(target[i]) - Number(min[i] || 0)) / s));
  });
  return normalizeCamera({
    azimuthDeg: (Math.atan2(dx, dz) * 180) / Math.PI,
    elevationDeg: (Math.asin(Math.max(-1, Math.min(1, dy / dist))) * 180) / Math.PI,
    distFactor: dist / diag,
    target: target01,
    fov,
  });
}

/** 节点下拉标签：末段名 + 同名序号；不把整条路径塞进 select */
export function nodeOptionLabel(path, index) {
  const p = Array.isArray(path) ? path : [];
  const last = p[p.length - 1] || '(未命名)';
  return last + (Number(index) > 0 ? ' #' + Number(index) : '');
}

export function formatCount(n, max) {
  return String(Number(n) || 0) + '/' + String(Number(max) || 0);
}
