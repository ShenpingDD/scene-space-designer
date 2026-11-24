<script setup>
/**
 * HotspotBoard —— 产品 3D 标注看板（维护端 / 向导第 4 步共用）
 *
 * 边界：
 *  · 3D 只用真实 GLB（上传件走 up.path，已有产品走 content.model.file），编辑态使用 LOD0；
 *  · 锚点/坐标/法线全部 import `../hotspot.js`，本组件不写第二套矩阵；
 *  · 保存 = 一次点击：只 PUT /hotspots，随后 POST /publish；产品内容不在这里编辑；
 *    发布失败保留编辑态并明说“已保存、未生效”；
 *  · 失效锚点不画 3D 标记，但列表红标 + 计数 + 原因必须可见。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { api } from '../api.js';
import { doorsFromScene, isHingedDoorPart } from '../detail3d.js';
import { applyDoor, assetUrl, bindDoorNode, parseGlbBuffer, planSlideSigns } from '../gltf.js';
import {
  ACTION_KINDS, ACTION_KIND_LABEL, ACTION_MAX, actionsPayload, normalizeAction,
  validateActionRefs, validateActions,
} from '../actions.js';
import {
  anchorOf, doorStateVisible, normalizeCamera, preorder, reanchorStoredPosition,
  resolveNode, toStoredNormal, toStoredPosition, toWorldPosition,
} from '../hotspot.js';
import {
  ANCHOR_BLOCK_REASONS, HOTSPOT_LIMITS, DOOR_STATE_LABEL, INVALID_LABEL, anchorGate,
  anchorGateText, anchorIssueText, anchorProblem, blankCamera, cameraFromOrbit, canAdd,
  charCount, countsOf, hotspotsPayload, newHotspot, nodeOptionLabel, normalizeHotspot,
  orbitFromCamera, sortBySeq, validateDraft, validationOf,
} from './hotspot-edit.js';

const props = defineProps({
  productId: { type: [Number, String], required: true },
  productName: { type: String, default: '' },
  sourcePath: { type: String, default: '' },
  analysis: { type: Object, default: null },
  embedded: { type: Boolean, default: false },
});
const emit = defineEmits(['exit', 'back']);

const LIMITS = HOTSPOT_LIMITS;
const phase = ref('loading');            // loading | ok | fail
const trouble = ref('');
const saveState = ref('');               // '' | saved | unpublished | failed
const saveMessage = ref('');
const saveIssues = ref([]);
const saving = ref(false);
const dirty = ref(false);

const productLabel = ref(props.productName || ('#' + props.productId));
const rev = ref(0);
const publishedRev = ref(0);
const model = ref({ id: null, variant: 'default', file: '', checksum: '', unit: 'mm', hingeNodes: [] });
const hotspots = ref([]);
const actions = ref([]);
const selectedActionKey = ref(null);
const selectedId = ref(null);
const adding = ref(false);
const doorAmount = ref(0);
const doorOpen = computed(() => doorAmount.value >= 0.5);
const doorReady = ref(false);
const doorWarning = ref('');
const doorDisabled = computed(() => !doorReady.value || doorBindings.length === 0);

const stageEl = ref(null);
const canvasHost = ref(null);
const markersHost = ref(null);
const markerPositions = ref([]);
const nodeOptions = ref([]);
const modelError = ref('');
const cameraView = ref('');

const selected = computed(() => hotspots.value.find((h) => h.id === selectedId.value) || null);
const selectedAction = computed(() => actions.value.find((a) => a.key === selectedActionKey.value) || null);
const actionKindLabel = (k) => ACTION_KIND_LABEL[k] || k || '—';
const actionTargetKey = (a) => JSON.stringify([a?.target?.path ?? [], Number(a?.target?.index) || 0]);
const actionRefCount = (a) => hotspots.value.filter((h) => h.actionKey === a.key).length;
const counts = computed(() => countsOf(hotspots.value));
/** 选中的这条是不是「保存会被拦」的锚点失效（model-changed 不算：锚点还在，只复核位置） */
const selectedAnchorBlocked = computed(() => !!selected.value
  && ANCHOR_BLOCK_REASONS.includes(String(selected.value.invalidReason || '')));
/** 会被保存闸门拦下的条数（不含 model-changed：那是复核提示，不是坏锚点） */
const anchorBlockedCount = computed(() => hotspots.value
  .filter((h) => ANCHOR_BLOCK_REASONS.includes(String(h.invalidReason || ''))).length);
const anchorBreadcrumb = computed(() => {
  const h = selected.value;
  if (!h || !Array.isArray(h.nodePath) || !h.nodePath.length) return '还没有选择锚点';
  return h.nodePath.join(' › ') + (Number(h.nodeIndex) > 0 ? ' #' + Number(h.nodeIndex) : '');
});
const validMarkers = computed(() => hotspots.value.filter((h) => !h.invalidReason && doorStateVisible(h.doorState, doorAmount.value)));
const selectedTitleCount = computed(() => (selected.value ? charCount(selected.value.title) : 0));
const selectedBodyCount = computed(() => (selected.value ? charCount(selected.value.body) : 0));

let renderer = null;
let scene = null;
let camera = null;
let controls = null;
let modelRoot = null;
let doorBindings = [];
let resizeObserver = null;
let raycaster = null;
let lastMarkerAt = 0;
let drag = null;
let downAt = null;
let bbox = { min: [0, 0, 0], size: [1, 1, 1] };
let disposed = false;

const invalidReasonText = (h) => {
  // 锚点类原因只有一份标签表（hotspot-edit.js 的 INVALID_LABEL），这里只补编辑器特有/历史原因。
  const local = {
    'model-changed': '模型已更新，需复核位置',
    invalid: '服务端校验未通过',
  };
  return INVALID_LABEL[h.invalidReason] || local[h.invalidReason] || h.invalidReason || '';
};

const anchorKey = (h) => JSON.stringify([h.nodePath, h.nodeIndex]);

/* ---------------- 动作库（产品级，key 是身份） ---------------- */

function uniqueActionKey() {
  const used = new Set(actions.value.map((a) => a.key));
  let i = actions.value.length + 1;
  while (used.has('action-' + i)) i += 1;
  return 'action-' + i;
}

function addAction() {
  if (actions.value.length >= ACTION_MAX) return;
  const first = nodeOptions.value[0];
  const a = normalizeAction({
    key: uniqueActionKey(),
    name: '新动作',
    kind: 'rotate',
    target: { path: first?.path ?? [], index: Number(first?.index) || 0 },
    motion: { axis: 'y', angleDeg: 90, direction: '+', pivotMm: [0, 0, 0], durationMs: 600, toggle: true },
  });
  actions.value.push(a);
  selectedActionKey.value = a.key;
  dirty.value = true;
}

function deleteAction(a) {
  const refs = hotspots.value.filter((h) => h.actionKey === a.key);
  if (refs.length && !window.confirm(`动作「${a.name || a.key}」被 ${refs.length} 条热点引用；删除后这些热点只弹说明、不再执行动作。继续？`)) return;
  for (const h of refs) h.actionKey = null;
  actions.value = actions.value.filter((x) => x.key !== a.key);
  if (selectedActionKey.value === a.key) selectedActionKey.value = null;
  dirty.value = true;
}

function setActionKey(a, value) {
  const old = a.key;
  const next = String(value || '').trim();
  a.key = next;
  if (old && next && old !== next) {
    for (const h of hotspots.value) if (h.actionKey === old) h.actionKey = next;
    if (selectedActionKey.value === old) selectedActionKey.value = next;
  }
  dirty.value = true;
}

function setActionTarget(a, value) {
  try {
    const [path, index] = JSON.parse(value);
    a.target = { path: (path || []).map(String), index: Number(index) || 0 };
  } catch { /* 选单值坏掉就保持原目标，不猜 */ }
  dirty.value = true;
}

function resetKind(a) {
  if (a.kind === 'rotate') {
    Object.assign(a.motion, { axis: a.motion.axis || 'y', angleDeg: 90, direction: a.motion.direction || '+', durationMs: 600, toggle: true });
    if (!Array.isArray(a.motion.pivotMm)) a.motion.pivotMm = [0, 0, 0];
  } else if (a.kind === 'translate') {
    Object.assign(a.motion, { axis: a.motion.axis || 'y', distanceMm: 100, durationMs: 600, toggle: true });
  } else if (a.kind === 'visibility') {
    Object.assign(a.motion, { visible: false, toggle: true });
  } else if (a.kind === 'clip') {
    Object.assign(a.motion, { clipName: a.motion.clipName || '', toggle: false });
  }
  dirty.value = true;
}

function bindSelectedAction(value) {
  if (!selected.value) return;
  selected.value.actionKey = value || null;
  dirty.value = true;
}


function errorText(e) {
  const head = e && e.reason === 'conflict' ? '版本冲突：' : (e && e.reason === 'forbidden' ? '没有维护权限：' : '保存失败：');
  const issues = e && e.data && Array.isArray(e.data.issues) ? e.data.issues : [];
  return {
    text: head + (e && e.message ? e.message : '未知原因'),
    issues: issues.map((x) => (x.code ? x.code + '：' : '') + (x.message || '')),
  };
}

onMounted(async () => {
  await loadContent();
  if (disposed || phase.value === 'fail') return;
  await nextTick();
  if (disposed) return;
  try {
    await initScene();
    phase.value = 'ok';
  } catch (e) {
    phase.value = 'fail';
    trouble.value = e && e.message ? e.message : '3D 场景初始化失败';
  }
});

onBeforeUnmount(disposeScene);

async function loadContent() {
  phase.value = 'loading';
  trouble.value = '';
  modelError.value = '';
  try {
    let r = null;
    try {
      r = await api.adminProductContent(props.productId);
    } catch (e) {
      // 新产品第一次进入可能还没有内容行；只有 404 才走列表兜底，其它错误照实说
      if (!(e && (e.reason === 'not-found' || e.status === 404))) throw e;
    }
    if (r) applyContent(r);
    else await fallbackFromProductList();
    if (!model.value.file && props.sourcePath) model.value.file = props.sourcePath;
    phase.value = 'ok';
  } catch (e) {
    phase.value = 'fail';
    trouble.value = (e && e.message ? e.message : '读不到内容') + '（产品 #' + props.productId + '）';
  }
}

function applyContent(r) {
  productLabel.value = r.name || props.productName || r.catalogId || productLabel.value;
  // 产品内容（简介/卖点/参数）属于第 1 步；看板只读 rev 与热点，不再编辑产品信息。
  rev.value = Number(r.rev) || 0;
  publishedRev.value = Number(r.publishedRev) || 0;
  const m = r.model || {};
  model.value = {
    id: m.id ?? m.modelId ?? null,
    variant: m.variant || 'default',
    file: m.file || m.sourceFile || '',
    checksum: m.checksum || '',
    unit: m.unit || 'mm',
    bboxMm: m.bboxMm || null,
    // task-78 契约：后端把 product_model.hinge_nodes 原样给前端；空/坏 JSON 是 []。
    // 这里是维护端开门唯一依据；没有数据就禁用，不再靠节点名去猜。
    hingeNodes: Array.isArray(m.hingeNodes) ? m.hingeNodes : [],
  };
  hotspots.value = (Array.isArray(r.hotspots) ? r.hotspots : []).map((h) => normalizeHotspot(h));
  // 动作库是产品级数据：服务端回读什么就显示什么（动作没有 id，key 才是身份）。
  const keepActionKey = selectedActionKey.value;
  actions.value = (Array.isArray(r.actions) ? r.actions : []).map((a) => normalizeAction(a));
  if (!actions.value.some((a) => a.key === keepActionKey)) selectedActionKey.value = null;
  // 服务端 issues 里已标失效的，保留原因；没有模型时也仍然显示列表
  if (Array.isArray(r.issues)) {
    for (const h of hotspots.value) {
      const hit = r.issues.find((x) => Number(x.hotspotId) === Number(h.id));
      if (hit && !h.invalidReason) {
        // 服务端 warning 的 reason 是编辑器口径（anchor-missing / index-out-of-range …）；
        // out-of-bounds 只可能来自历史快照，新保存不再由服务端产生。
        // 不能一律写成 model-changed，否则红标原因与 3D 列表说的不是一件事。
        h.invalidReason = String(hit.reason || hit.code || 'invalid').replace(/^hotspot-/, '') || 'invalid';
        h.invalidDetail = hit.message || '';
      }
    }
  }
  if (!hotspots.value.length) selectedId.value = null;
  else if (!hotspots.value.some((h) => h.id === selectedId.value)) selectedId.value = hotspots.value[0].id;
}

async function fallbackFromProductList() {
  const r = await api.adminProducts();
  const p = ((r && r.products) || []).find((x) => String(x.id) === String(props.productId));
  if (!p) throw new Error('产品列表里找不到 #' + props.productId);
  productLabel.value = p.name || productLabel.value;
  const m = p.model || {};
  model.value = {
    id: m.id ?? m.modelId ?? null,
    variant: m.variant || 'default',
    file: m.file || m.sourceFile || props.sourcePath || '',
    checksum: m.checksum || '',
    unit: m.unit || 'mm',
    bboxMm: m.bboxMm || null,
    hingeNodes: Array.isArray(m.hingeNodes) ? m.hingeNodes : [],
  };
  hotspots.value = [];
  actions.value = [];
  selectedActionKey.value = null;
  rev.value = 0;
}

/** 新建/上传后可能还没有 model.id；先尽量从产品列表补一次（不猜，拿不到就明说） */
async function ensureModelId() {
  if (model.value.id != null) return true;
  try {
    const r = await api.adminProducts();
    const p = ((r && r.products) || []).find((x) => String(x.id) === String(props.productId));
    const id = p && p.model ? (p.model.id ?? p.model.modelId) : null;
    if (id != null) model.value.id = id;
  } catch { /* 下面统一报 */ }
  return model.value.id != null;
}

function modelFile() {
  return props.sourcePath || model.value.file || model.value.sourceFile || '';
}

async function initScene() {
  const host = canvasHost.value;
  if (!host) throw new Error('3D 容器没有挂载');
  const file = modelFile();
  if (!file) {
    modelError.value = '这一款没有 GLB 模型文件：热点无法标注；卖点/参数请回向导第 1 步维护。';
    setupEmptyScene(host);
    return;
  }
  let root = null;
  try {
    const res = await fetch(assetUrl(file));
    if (!res.ok) throw new Error('模型取不到：' + file + '（HTTP ' + res.status + '）');
    const buf = await res.arrayBuffer();
    root = await parseGlbBuffer(buf);
    normalizeModelToMeters(root);
    root.updateMatrixWorld(true);
  } catch (e) {
    // 模型坏了/被删了不等于整张看板坏了：内容与热点列表仍然可读可改，只是不能 3D 标定。
    modelError.value = '3D 预览不可用：' + (e && e.message ? e.message : '模型解析失败')
      + '。文字列表与内容编辑仍可用。';
    setupEmptyScene(host);
    return;
  }

  scene = new THREE.Scene();
  setupSceneLighting();
  scene.add(root);
  modelRoot = root;

  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  bbox = { min: [box.min.x, box.min.y, box.min.z], size: [size.x, size.y, size.z] };
  // 底面中心对齐 + 根节点保留名字（nodePath 不受平移影响）
  root.position.x -= box.min.x + size.x / 2;
  root.position.y -= box.min.y;
  root.position.z -= box.min.z + size.z / 2;
  root.updateMatrixWorld(true);
  const box2 = new THREE.Box3().setFromObject(root);
  const size2 = box2.getSize(new THREE.Vector3());
  bbox = { min: [box2.min.x, box2.min.y, box2.min.z], size: [size2.x, size2.y, size2.z] };

  nodeOptions.value = preorder(root).map((n) => ({
    path: n.path,
    index: n.index,
    label: nodeOptionLabel(n.path, n.index),
    crumb: n.path.join(' › ') + (n.index > 0 ? ' #' + n.index : ''),
    key: JSON.stringify([n.path, n.index]),
  }));

  setupDoors(root);
  setupRenderer(host);
  setupCamera();
  resolveAll();
}

function setupEmptyScene(host) {
  scene = new THREE.Scene();
  setupSceneLighting();
  setupRenderer(host);
  camera = new THREE.PerspectiveCamera(42, 1, 0.01, 100);
  camera.position.set(2, 1.4, 3);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0.8, 0);
  controls.update();
  nodeOptions.value = [];
  // 空模型没有可解析的门节点：明说并禁用，不播放假动画。
  doorBindings = [];
  doorReady.value = true;
  doorWarning.value = '3D 模型未就绪：没有可解析的门/上盖节点，开门按钮已禁用（不会播放假动画）。';
  renderer.setAnimationLoop(renderFrame);
}

/** 维护端看板统一浅色：与 detail3d.js 的 #f2f6f9 + 半球光 + 方向光 + 浅网格同口径。 */
function setupSceneLighting() {
  scene.background = new THREE.Color(0xf2f6f9);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x9fb3c0, 2.1));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(3, 5, 4);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.55);
  fill.position.set(-3, 2, -4);
  scene.add(fill);
  const grid = new THREE.GridHelper(6, 24, 0xb9cbd7, 0xe2ebf1);
  grid.position.y = 0.001;
  scene.add(grid);
}

function normalizeModelToMeters(root) {
  root.updateMatrixWorld(true);
  const raw = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
  let scale = 1;
  const a = props.analysis;
  const declared = (a && a.mm) || (model.value && model.value.bboxMm);
  if (declared && declared.w > 0 && raw.x > 0) {
    const phys = { w: declared.w / 1000, h: declared.h / 1000, d: declared.d / 1000 };
    const ratios = [phys.w / raw.x, phys.h / raw.y, phys.d / raw.z].filter((v) => Number.isFinite(v) && v > 0);
    if (ratios.length) scale = Math.min(...ratios);
  } else {
    const max = Math.max(raw.x, raw.y, raw.z);
    if (max > 100) scale = 0.001;
    else if (max > 20) scale = 0.01;
  }
  if (Number.isFinite(scale) && scale > 0 && Math.abs(scale - 1) > 1e-9) {
    root.scale.setScalar(scale);
    root.updateMatrixWorld(true);
  }
}

/**
 * task-79：门节点解析。
 * 优先级：服务端 `model.hingeNodes`（真实铰链数据）→ 旧 analysis.doors.found → 名字启发（仅兜底）。
 * `hingeNodes` 的一条可以带 `nodes[]`（同轴多扇门），要展开成多条绑定；
 * `openAngleDeg` 一律转弧度，axis 缺省 y；任一节点找不到就禁用并明说，不播放假动画。
 */
function expandHingeDefs() {
  const out = [];
  for (const h of (Array.isArray(model.value.hingeNodes) ? model.value.hingeNodes : [])) {
    if (!h || typeof h !== 'object') continue;
    const names = Array.isArray(h.nodes) && h.nodes.length
      ? h.nodes.filter((x) => typeof x === 'string' && x.trim())
      : [h.node].filter((x) => typeof x === 'string' && x.trim());
    for (const name of names) {
      out.push({
        node: name,
        nodePath: Array.isArray(h.nodePath) ? h.nodePath : null,
        nodeIndex: h.nodeIndex,
        axis: h.axis || 'y',
        openAngleDeg: h.openAngleDeg,
        // 352 这类模型把真实铰链写在 extras 里；随 hingeNodes 一起存下来后要在看板生效
        pivotMm: Array.isArray(h.pivotMm) && h.pivotMm.length === 3
          ? h.pivotMm.map(Number) : null,
        openDirection: h.openDirection === '-' || h.openDirection === '+' ? h.openDirection : null,
      });
    }
  }
  return out;
}

/** nodePath 优先；没有 path 才按 node 名做唯一候选（同名多节点时用 nodeIndex 消歧）。 */
function resolveDoorNode(root, def) {
  if (Array.isArray(def.nodePath) && def.nodePath.length) {
    const tries = [def.nodePath];
    // 有的后端给的是不含模型根名的相对路径；只在第一段不是根名时补一次，避免瞎猜。
    if (root.name && def.nodePath[0] !== root.name) tries.push([root.name, ...def.nodePath]);
    for (const path of tries) {
      const hit = resolveNode(root, path, def.nodeIndex ?? 0);
      if (hit) return hit;
    }
  }
  const name = def.node != null ? String(def.node) : '';
  if (!name) return null;
  const hits = preorder(root).filter((x) => (x.path[x.path.length - 1] || '') === name);
  if (!hits.length) return root.getObjectByName ? (root.getObjectByName(name) || null) : null;
  if (def.nodeIndex != null) {
    const exact = hits.find((x) => x.index === Number(def.nodeIndex));
    if (exact) return exact.node;
  }
  return hits[0].node;
}

function bindDoorDef(root, def) {
  const obj = resolveDoorNode(root, def);
  const axis = ['x', 'y', 'z'].includes(String(def.axis || 'y').toLowerCase())
    ? String(def.axis || 'y').toLowerCase()
    : 'y';
  const deg = Number(def.openAngleDeg);
  const openAngleRad = Number.isFinite(deg)
    ? (deg * Math.PI) / 180
    : (Number.isFinite(Number(def.openAngleRad)) ? Number(def.openAngleRad) : 1.85);
  return bindDoorNode(root, obj, {
    node: def.node,
    axis,
    openAngleRad,
    openDirection: def.openDirection,
    pivotMm: def.pivotMm,
    partType: def.partType,
    motion: def.motion,
    slideMm: def.slideMm,
    slideSign: def.slideSign,
  });
}

function setupDoors(root) {
  doorBindings = [];
  doorReady.value = true;
  doorWarning.value = '';
  doorAmount.value = 0;

  const rawHinges = Array.isArray(model.value.hingeNodes) ? model.value.hingeNodes : [];
  // 模型 extras 是“这个资产自己声明的事实”：475/478/481 在库里只有门节点名、没有 pivotMm，
  // 要靠它补 partType/openAngle，bindDoorNode 才能按 Box3 推铰链；473/480 库里根本没有门行。
  const sceneDoors = doorsFromScene(root).filter(isHingedDoorPart);
  const sceneByNode = new Map(sceneDoors.map((d) => [d.node, d]));
  const hinges = expandHingeDefs().map((h) => {
    const s = sceneByNode.get(h.node);
    return s ? {
      ...h,
      partType: h.partType ?? s.partType,
      motion: h.motion ?? s.motion,
      slideMm: h.slideMm ?? s.slideMm,
      openAngleRad: h.openAngleRad ?? s.openAngleRad,
      openDirection: h.openDirection ?? s.openDirection,
    } : h;
  });
  // 库里没有 hinge_nodes 时，先看模型自己的 extras（352 的 door/hingePoint、473 双滑门、480 sash）——
  // 这是模型声明的事实，不是按名字猜；379 没有这类 extras，仍会走到下面的禁用分支。
  const slidePlan = planSlideSigns(root, hinges.length ? hinges : sceneDoors);
  if (!hinges.length) {
    if (sceneDoors.length) {
      const bindings = sceneDoors.map((d) => bindDoorDef(root, { ...d, slideSign: slidePlan.get(d.node) }));
      const missing = bindings.filter((x) => !x.found).map((x) => x.node);
      if (missing.length) {
        doorBindings = [];
        doorWarning.value = '门节点找不到：' + missing.join('、') + '；开门按钮已禁用（不会播放假动画）。';
        return;
      }
      doorBindings = bindings;
      return;
    }
  }
  if (rawHinges.length && !hinges.length) {
    doorWarning.value = '服务端 hingeNodes 没有可解析的门节点；开门按钮已禁用（不会播放假动画）。';
    return;
  }
  if (hinges.length) {
    const bindings = hinges.map((d) => bindDoorDef(root, { ...d, slideSign: slidePlan.get(d.node) }));
    const missing = bindings.filter((b) => !b.found).map((b) => b.node);
    if (missing.length) {
      doorBindings = [];
      doorWarning.value = '门节点找不到：' + missing.join('、') + '；开门按钮已禁用（不会播放假动画）。';
      return;
    }
    doorBindings = bindings;
    return;
  }
}

function setupRenderer(host) {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(host.clientWidth || 640, host.clientHeight || 420);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.appendChild(renderer.domElement);
  resizeObserver = new ResizeObserver(() => {
    if (!renderer || !camera) return;
    const w = host.clientWidth || 1;
    const h = host.clientHeight || 1;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    updateMarkers();
  });
  resizeObserver.observe(host);
  renderer.setAnimationLoop(renderFrame);
}

function setupCamera() {
  const host = canvasHost.value;
  const aspect = host && host.clientHeight ? (host.clientWidth || 1) / host.clientHeight : 1;
  camera = new THREE.PerspectiveCamera(42, aspect, 0.01, 100);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 0.3;
  controls.maxDistance = 30;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.addEventListener('change', updateMarkers);
  applyCamera({
    azimuthDeg: 30, elevationDeg: 12, distFactor: 1.9,
    target: [0.5, 0.5, 0.5], fov: 42,
  });
}

function applyCamera(c) {
  if (!camera || !controls) return;
  const w = cameraFromOrbit(c, bbox);
  camera.position.set(w.position[0], w.position[1], w.position[2]);
  camera.fov = w.fov;
  camera.updateProjectionMatrix();
  controls.target.set(w.target[0], w.target[1], w.target[2]);
  controls.update();
  updateMarkers();
}

function currentCamera() {
  if (!camera || !controls) return blankCamera();
  return orbitFromCamera(camera.position.toArray(), controls.target.toArray(), bbox, camera.fov);
}

function renderFrame() {
  if (!renderer || !scene || !camera || disposed) return;
  if (controls) controls.update();
  renderer.render(scene, camera);
  const now = performance.now();
  if (now - lastMarkerAt > 50) {
    lastMarkerAt = now;
    updateMarkers();
    try { cameraView.value = JSON.stringify(currentCamera()); } catch { /* 相机还没就绪 */ }
  }
}

function updateMarkers() {
  if (!modelRoot || !camera || !stageEl.value) {
    markerPositions.value = [];
    return;
  }
  const host = markersHost.value;
  if (!host) return;
  // controls 只改了 camera.position，matrixWorld 可能还停在上一帧；先同步，否则
  // 拖拽旋转/滚轮缩放时标记会慢半帧，看起来像“没标在点上”。
  camera.updateMatrixWorld();
  modelRoot.updateMatrixWorld(true);
  // 投影以渲染 canvas 的 CSS 尺寸为准，再换算成 markersHost 内的坐标。
  // markersHost 与 canvas 可能差 0.5px（边框/小数高度），直接混用会在放大后放大成可见偏移。
  const canvasRect = renderer?.domElement?.getBoundingClientRect?.();
  const hostRect = host.getBoundingClientRect();
  const w = (canvasRect && canvasRect.width) || host.clientWidth || 1;
  const h = (canvasRect && canvasRect.height) || host.clientHeight || 1;
  const offsetX = canvasRect ? canvasRect.left - hostRect.left : 0;
  const offsetY = canvasRect ? canvasRect.top - hostRect.top : 0;
  const out = [];
  raycaster = raycaster || new THREE.Raycaster();
  for (const hs of validMarkers.value) {
    const node = resolveNode(modelRoot, hs.nodePath, hs.nodeIndex);
    if (!node) continue;
    const world = toWorldPosition(node, hs.position);
    if (!world) continue;
    const p = world.clone().project(camera);
    if (p.z > 1) continue;
    const x = offsetX + (p.x * 0.5 + 0.5) * w;
    const y = offsetY + (-p.y * 0.5 + 0.5) * h;
    // 视口外的热点不画。旧实现把它夹到 10px 边缘，放大后用户会以为标记“跑到别处”；
    // 看不见的标记应该消失，而不是画一个假的边缘位置。
    if (x < 0 || x > w || y < 0 || y > h) continue;
    let occluded = false;
    try {
      const dir = world.clone().sub(camera.position);
      const dist = dir.length();
      raycaster.set(camera.position, dir.normalize());
      raycaster.far = Math.max(0.01, dist - 0.02);
      const hit = raycaster.intersectObject(modelRoot, true)[0];
      occluded = !!hit;
    } catch { /* 遮挡只是提示，不阻断 */ }
    out.push({
      id: hs.id,
      title: hs.title || '未命名热点',
      x,
      y,
      occluded,
      selected: hs.id === selectedId.value,
    });
  }
  markerPositions.value = out;
}

function resolveAll() {
  if (!modelRoot) return;
  for (const h of hotspots.value) resolveOne(h);
}

function resolveOne(h) {
  const old = h.invalidReason;
  // 服务端/上一次解析给出的 invalidReason 是**权威结论**：即使节点名还能解析，也不许
  // 悄悄把它当成有效热点显示。用户改锚点/拖动后 invalidReason 会先被清掉，才重新判定。
  if (old) {
    h.invalidDetail = h.invalidDetail || invalidReasonText(h);
    return h;
  }
  if (!modelRoot) return h;
  const p = anchorProblem(h, modelRoot);
  if (p) {
    h.invalidReason = p.reason;
    h.invalidDetail = p.detail;
  }
  return h;
}

function select(id) {
  selectedId.value = id;
  if (id != null) adding.value = false;
}

/**
 * 点击添加时不要锚到无名 mesh：往父链找最近的**有名字**节点。
 * 这样热点跟着“门/层板/外壳”动，而不是跟一个每次导出都会改名的三角网格。
 */
function nearestNamedAnchor(obj) {
  let cur = obj;
  while (cur && cur !== modelRoot) {
    if (cur.name && String(cur.name).trim()) {
      const a = anchorOf(modelRoot, cur);
      return a ? { ...a, node: cur } : null;
    }
    cur = cur.parent;
  }
  const a = anchorOf(modelRoot, obj);
  return a ? { ...a, node: obj } : null;
}

function addAt(clientX, clientY) {
  if (!modelRoot || !camera || !stageEl.value) return;
  camera.updateMatrixWorld();
  modelRoot.updateMatrixWorld(true);
  if (!canAdd(hotspots.value)) {
    saveMessage.value = '已经到 ' + LIMITS.hotspots + ' 条上限，不能再加。';
    return;
  }
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster = raycaster || new THREE.Raycaster();
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObject(modelRoot, true);
  const hit = hits.find((x) => x.object && x.object.isMesh);
  if (!hit) {
    saveMessage.value = '点空了：请点在模型表面，背景不会生成热点。';
    return;
  }
  const a = nearestNamedAnchor(hit.object);
  if (!a) {
    saveMessage.value = '这个网格不在模型根链上，无法记录锚点。';
    return;
  }
  const pos = toStoredPosition(a.node, hit.point);
  if (!pos) {
    saveMessage.value = '锚点缩放不等比，不能记录坐标（unit-mismatch）。';
    return;
  }
  // 写进去的值必须能原路换回点击点；换不回来就是锚点/缩放不一致，宁可拦住也不留一个漂移的点。
  const back = toWorldPosition(a.node, pos);
  if (!back || back.distanceTo(hit.point) > 1e-4) {
    saveMessage.value = '坐标换算校验失败（锚点局部与世界坐标不一致），没有添加热点。';
    return;
  }
  let normal = { x: 0, y: 0, z: 1 };
  if (hit.face && hit.face.normal) {
    const n = hit.face.normal.clone().applyMatrix3(new THREE.Matrix3().getNormalMatrix(hit.object.matrixWorld)).normalize();
    normal = toStoredNormal(a.node, n) || normal;
  }
  const h = newHotspot(hotspots.value.length, {
    title: '热点 ' + (hotspots.value.length + 1),
    nodePath: a.path,
    nodeIndex: a.index,
    nodeName: a.path[a.path.length - 1],
    position: pos,
    normal,
    camera: currentCamera(),
  });
  hotspots.value = [...hotspots.value, h];
  selectedId.value = h.id;
  dirty.value = true;
  saveMessage.value = '已添加 1 条热点；在右侧改标题/正文，保存后对设计端可见。';
  nextTick(updateMarkers);
}

function onStagePointerDown(e) {
  if (e.button !== 0) return;
  if (e.target.closest('[data-hs-marker]')) return;
  downAt = { x: e.clientX, y: e.clientY, moved: false };
}
function onStagePointerUp(e) {
  if (!downAt || e.button !== 0) return;
  const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 4;
  const d = downAt;
  downAt = null;
  if (moved) return;
  if (e.target.closest('[data-hs-marker]') || e.target.closest('button')) return;
  select(null);
  addAt(e.clientX, e.clientY);
}

function onMarkerDown(e, h) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  select(h.id);
  drag = { id: h.id, startX: e.clientX, startY: e.clientY, moved: false };
  try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }
  window.addEventListener('pointermove', onMarkerMove);
  window.addEventListener('pointerup', onMarkerUp, { once: true });
}

function onMarkerMove(e) {
  if (!drag || !modelRoot || !camera) return;
  if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 4) return;
  drag.moved = true;
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1,
  );
  raycaster = raycaster || new THREE.Raycaster();
  raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObject(modelRoot, true).find((x) => x.object && x.object.isMesh);
  if (!hit) return;
  const h = hotspots.value.find((x) => x.id === drag.id);
  if (!h) return;
  camera.updateMatrixWorld();
  modelRoot.updateMatrixWorld(true);
  // 与点选添加保持同一套锚点规则：拖到门/层板等零件上时，落到最近的命名节点，
  // 而不是每次导出都可能改名的无名三角网格。
  const a = nearestNamedAnchor(hit.object);
  if (!a) return;
  const pos = toStoredPosition(a.node, hit.point);
  if (!pos) {
    h.invalidReason = 'unit-mismatch';
    h.invalidDetail = '拖动落点锚点缩放不等比';
    return;
  }
  const back = toWorldPosition(a.node, pos);
  if (!back || back.distanceTo(hit.point) > 1e-4) {
    h.invalidReason = 'unit-mismatch';
    h.invalidDetail = '拖动落点坐标换算校验失败';
    return;
  }
  h.nodePath = a.path;
  h.nodeIndex = a.index;
  h.nodeName = a.path[a.path.length - 1];
  h.position = pos;
  h.invalidReason = '';
  h.invalidDetail = '';
  dirty.value = true;
  updateMarkers();
}

function onMarkerUp() {
  window.removeEventListener('pointermove', onMarkerMove);
  if (drag) {
    const h = hotspots.value.find((x) => x.id === drag.id);
    if (h) resolveOne(h);
    // 拖动结束也要防“点击又加一条”：给一次短暂闩
    downAt = null;
  }
  drag = null;
}

function setAnchorFromSelect(value) {
  if (!selected.value || !modelRoot) return;
  let opt = null;
  try { opt = JSON.parse(value); } catch { opt = null; }
  if (!Array.isArray(opt) || opt.length !== 2) return;
  const node = resolveNode(modelRoot, opt[0], opt[1]);
  if (!node) {
    saveMessage.value = '这个节点在当前模型里找不到，锚点未改动。';
    return;
  }
  const h = selected.value;
  // 换锚点必须用**旧锚点**先把存储值还原成世界点，再用新锚点写回；
  // 直接拿新锚点解释旧局部值会让热点整体平移一个锚点原点差（验收-3 / #479 的数值签名）。
  const oldNode = resolveNode(modelRoot, h.nodePath, h.nodeIndex);
  let stored = null;
  let repairedFromDead = false;
  if (oldNode) {
    stored = reanchorStoredPosition(oldNode, node, h.position);
    if (!stored) {
      saveMessage.value = '换锚点失败：新旧锚点无法换算（缩放不等比或坐标校验失败），锚点未改动。';
      return;
    }
  } else {
    // 旧锚点已经不在当前模型里：没有可换算的世界点，硬算只会把热点丢到别处。
    // 把落点重置到新锚点原点，用户保存前拖一次即可微调 —— 这样「失效项」还能被修好，
    // 而不是只剩删除一条路。
    stored = { x: 0, y: 0, z: 0 };
    repairedFromDead = true;
  }
  h.nodePath = opt[0];
  h.nodeIndex = Number(opt[1]) || 0;
  h.nodeName = h.nodePath[h.nodePath.length - 1] || '';
  h.position = stored;
  h.invalidReason = '';
  h.invalidDetail = '';
  resolveOne(h);
  dirty.value = true;
  if (repairedFromDead) {
    saveMessage.value = '旧锚点已失效：落点已重置到新锚点原点，保存前可在模型上拖一次微调。';
  }
}

function saveCurrentView() {
  if (!selected.value || !camera) return;
  selected.value.camera = normalizeCamera(currentCamera());
  dirty.value = true;
  saveMessage.value = '已保存当前视角到这条热点（仅归一化参数，不存绝对机位）。';
}

function applyHotspotView() {
  if (!selected.value || !selected.value.camera) return;
  applyCamera(selected.value.camera);
}

function toggleDoor() {
  if (doorDisabled.value) {
    saveMessage.value = doorWarning.value || '门节点未就绪，不能开门。';
    return;
  }
  doorAmount.value = doorAmount.value >= 0.5 ? 0 : 1;
  for (const b of doorBindings) applyDoor(b, doorAmount.value);
  modelRoot?.updateMatrixWorld(true);
  updateMarkers();
}

function deleteSelected() {
  const h = selected.value;
  if (!h) return;
  if (typeof window !== 'undefined' && !window.confirm('删除「' + (h.title || '未命名热点') + '」？删除后需保存才生效。')) return;
  hotspots.value = hotspots.value.filter((x) => x.id !== h.id);
  selectedId.value = hotspots.value[0]?.id ?? null;
  dirty.value = true;
  saveMessage.value = '已删除 1 条热点；保存后生效。';
}

function onKey(e) {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  if (e.key === 'Escape') {
    if (selectedId.value != null) select(null);
    return;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId.value != null) {
    e.preventDefault();
    deleteSelected();
  }
}

async function save() {
  if (saving.value) return;
  saveIssues.value = [];
  saveMessage.value = '';
  saveState.value = '';
  // 看板只校验/保存热点与动作库；卖点与参数已在产品向导第 1 步保存。
  const issues = [
    ...validateDraft(hotspots.value, {}),
    ...validateActions(actions.value),
    ...validateActionRefs(hotspots.value, actions.value),
  ];
  if (issues.length) {
    saveIssues.value = issues.map((x) => x.message);
    saveState.value = 'failed';
    saveMessage.value = '保存被拦：' + issues.length + ' 条结构问题（未提交，编辑内容还在）';
    return;
  }
  // 保存/发布前必须用**当前模型**逐条解析锚点。失效锚点允许继续编辑/删除（validateHotspot
  // 故意不把它当结构错误），但绝不能被静默发布：设计端只会把它列进「需复核」，3D 里永远
  // 看不到 —— 2026-11-24「铭牌 #0/#4/DEMO-FZ-040/... 找不到」就是这么上线的事故形态。
  const gate = anchorGate(sortBySeq(hotspots.value), modelRoot);
  if (!gate.ok) {
    saveIssues.value = gate.blocked.map(anchorIssueText);
    saveState.value = 'failed';
    saveMessage.value = anchorGateText(gate.blocked.length)
      + (modelRoot ? '' : '（3D 模型未就绪，无法校验锚点）')
      + '；请重新选锚点或删除这些条目后再保存（未提交、未发布）。';
    return;
  }
  // 0 热点不依赖模型行：人工代录/模型还没就绪的产品也要能保存内容与空看板。
  // 有热点时必须有 modelId，否则服务端无法把锚点落到默认模型上。
  if (hotspots.value.length && !(await ensureModelId())) {
    saveState.value = 'failed';
    saveMessage.value = '保存被拦：模型行还没就绪（modelId 为空）。等 LOD 完成或刷新后重试。';
    return;
  }
  saving.value = true;
  try {
    let rv = rev.value;
    // 保存只写热点。产品内容由向导第 1 步负责，看板不再 PUT /content 改产品信息。
    const hb = await api.adminSaveProductHotspots(props.productId, {
      modelId: model.value.id,
      hotspots: hotspotsPayload(hotspots.value),
      // 动作库与热点一起提交；服务端按 (product_id, action_key) 整体替换。
      actions: actionsPayload(actions.value),
      validation: validationOf(hotspots.value, model.value),
      expectedRev: rv,
    });
    if (hb && Number.isFinite(Number(hb.rev))) rv = Number(hb.rev);
    else rv += 1;
    // 先把服务端分配的 number id 贴回本地，这样即使随后重读失败，下一次保存也不会
    // 把同一批热点当成“新行”重复插入。
    const ids = hb && Array.isArray(hb.hotspotIds) ? hb.hotspotIds : null;
    if (ids) {
      const ordered = hotspots.value.slice().sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
      ordered.forEach((h, i) => { if (ids[i] != null) h.id = Number(ids[i]); });
    }
    // 编辑态到这里已经落库：发布是第二步。发布失败时不能再把“保存”说成失败，
    // 否则用户重按一次会用旧 rev 撞 409；但也不能说“已生效”。
    dirty.value = false;
    rev.value = rv;
    let pub = null;
    try {
      pub = await api.adminPublishProductContent(props.productId, { expectedRev: rv });
    } catch (e) {
      const x = errorText(e);
      saveState.value = 'unpublished';
      saveMessage.value = '编辑态已保存，但发布没成功：' + x.text.replace(/^保存失败：/, '')
        + '；设计端仍是上一版，可稍后重试或点「重新载入」核对。';
      saveIssues.value = x.issues;
      return;
    }
    if (pub && Number.isFinite(Number(pub.rev))) rev.value = Number(pub.rev);
    if (pub && pub.published === false) {
      saveState.value = 'unpublished';
      saveMessage.value = '编辑态已保存，但未生效：' + ((pub.publishError && pub.publishError.message) || '发布步骤失败；设计端仍是上一版');
    } else {
      saveState.value = 'saved';
      publishedRev.value = pub && pub.publishedRev != null ? Number(pub.publishedRev) : rv;
      const warns = (pub && Array.isArray(pub.warnings)) ? pub.warnings : [];
      const bad = counts.value.invalid;
      saveMessage.value = '已保存并发布 · ' + counts.value.total + ' 条热点'
        + (bad ? '，其中 ' + bad + ' 条仍标需复核（锚点可用，设计端会列出复核原因）' : '')
        + (warns.length ? '；' + warns.slice(0, 2).map((w) => w.code || w.message || '').join('；') : '');
    }
    const back = await reloadAfterSave();
    // 动作库数量以服务端回读为准；保存响应若带 actions/actionKeys 也认，但绝不自己编号。
    const fromSave = Array.isArray(hb?.actions) ? hb.actions
      : (Array.isArray(hb?.actionKeys) ? hb.actionKeys : null);
    const fromRead = Array.isArray(back?.actions) ? back.actions : fromSave;
    if (fromRead) saveMessage.value += ' · 动作库 ' + fromRead.length + ' 个（服务端回读）';
  } catch (e) {
    const x = errorText(e);
    saveState.value = 'failed';
    saveMessage.value = x.text;
    saveIssues.value = x.issues;
    if (e && e.reason === 'conflict') saveMessage.value += '；请点「重新载入」后再改，未自动覆盖。';
  } finally {
    saving.value = false;
  }
}

async function reloadAfterSave() {
  try {
    const r = await api.adminProductContent(props.productId);
    const keepSeq = selected.value ? selected.value.seq : null;
    applyContent(r);
    if (keepSeq != null) {
      const hit = hotspots.value.find((h) => h.seq === keepSeq);
      if (hit) selectedId.value = hit.id;
    }
    resolveAll();
    updateMarkers();
    return r;
  } catch {
    // 保存已经成功；重取失败不把保存说成失败
    saveMessage.value += '（内容已保存，但重新读取失败；刷新页面可核对）';
    return null;
  }
}

async function reloadConfirmed() {
  await loadContent();
  // 用户点“重新载入”是为了摆脱冲突/失败态；旧错误不许继续挂在底栏冒充当前状态。
  saveState.value = '';
  saveMessage.value = '';
  saveIssues.value = [];
  resolveAll();
  updateMarkers();
}

function disposeScene() {
  disposed = true;
  if (renderer) {
    renderer.setAnimationLoop(null);
    try { renderer.forceContextLoss(); } catch { /* ignore */ }
    renderer.dispose();
    if (renderer.domElement && renderer.domElement.parentNode) renderer.domElement.parentNode.removeChild(renderer.domElement);
  }
  if (controls) controls.dispose();
  if (resizeObserver) resizeObserver.disconnect();
  if (modelRoot) {
    modelRoot.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (m.map) m.map.dispose();
          m.dispose();
        }
      }
    });
  }
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('pointermove', onMarkerMove);
  window.removeEventListener('pointerup', onMarkerUp);
  renderer = null; scene = null; camera = null; controls = null; modelRoot = null;
}

onMounted(() => window.addEventListener('keydown', onKey));
</script>

<template>
  <div class="hsb" data-hotspot-board
    data-hotspot-step="3"
    data-hotspot-theme="light"
    :data-hotspot-product-id="productId"
    :data-hotspot-limit="LIMITS.hotspots"
    :data-hotspot-count="counts.total"
    :data-hotspot-invalid-count="counts.invalid"
    :data-hotspot-anchor-blocked="anchorBlockedCount"
    :data-hotspot-mode="adding ? 'add' : 'browse'"
    :data-hotspot-door-state="doorOpen ? 'open' : 'closed'"
    :data-hotspot-selected-id="selectedId == null ? '' : selectedId"
    :data-hotspot-max-reached="hotspots.length >= LIMITS.hotspots ? 'true' : 'false'"
    :data-hotspot-view="cameraView"
    :data-hotspot-status="saveState === 'unpublished' || saveState === 'failed' ? 'failed' : (saveState === 'saved' ? 'published' : 'none')"
    :data-hotspot-publish-error="saveState === 'unpublished' || saveState === 'failed' ? saveMessage : null">
    <header class="hsb__head">
      <div class="hsb__title">
        <b>标注看板</b>
        <span>{{ productLabel }} · 产品 #{{ productId }}</span>
      </div>
      <span class="adm__spacer" />
      <span class="hsb__count" :data-hotspot-count="counts.total" :data-hotspot-count-total="counts.total"
        :data-hotspot-count-invalid="counts.invalid">
        <b>{{ counts.total }}</b>/{{ LIMITS.hotspots }} 个热点
        <em v-if="counts.invalid" class="hsb__bad" data-hotspot-invalid-count>{{ counts.invalid }} 需复核</em>
      </span>
      <button class="adm__btn adm__btn--tiny" type="button" data-door-toggle
        :data-door-state="doorOpen ? 'open' : 'closed'"
        :disabled="doorDisabled"
        :aria-label="'门：' + (doorOpen ? '已开' : '已关') + (doorDisabled ? '（节点不可用）' : '，点击切换')"
        :title="doorWarning || '切换门/上盖预览'"
        @click="toggleDoor">
        门：{{ doorOpen ? '已开' : '已关' }}
      </button>
    </header>

    <p v-if="phase === 'loading'" class="hsb__phase">正在读取内容与模型…</p>
    <div v-else-if="phase === 'fail'" class="hsb__phase hsb__phase--bad">
      <b>看板打不开：</b>{{ trouble }}
      <button class="adm__btn adm__btn--tiny" type="button" @click="reloadConfirmed">重试</button>
      <button class="adm__btn adm__btn--tiny" type="button" @click="emit('exit')">回产品列表</button>
    </div>

    <div v-else class="hsb__body">
      <aside class="hsb__list" aria-label="热点列表" data-hotspot-list>
        <div class="hsb__list-head">
          <b>热点</b>
          <span>{{ counts.total }}/{{ LIMITS.hotspots }}</span>
          <button class="adm__btn adm__btn--tiny" type="button" data-editor-add
            :disabled="!canAdd(hotspots)" :title="'上限 ' + LIMITS.hotspots + ' 条'"
            @click="adding = !adding; saveMessage = adding ? '点模型表面添加热点' : ''">
            {{ adding ? '点模型…' : '＋ 添加' }}
          </button>
        </div>
        <p v-if="!hotspots.length" class="hsb__empty">
          还没有热点。点模型表面添加第一条；0 热点也能保存。
        </p>
        <!-- 验收-2：产品信息（简介/系列/卖点/参数）不是热点，别在 3D 看板里改；
             这里给一句常驻指路，避免用户以为“产品内容凭空没了”。 -->
        <p class="hsb__hint-products" data-board-content-note>
          产品简介 / 系列 / 卖点 / 参数都在<b>第 1 步</b>维护；这个看板只标注模型热点。
          已有产品请点卡片上的「编辑产品信息」补录。
        </p>

        <details class="hsb__actions" data-action-library open>
          <summary>
            <b>动作库</b>
            <span class="hsb__mono">{{ actions.length }}/{{ ACTION_MAX }}</span>
            <button class="adm__btn adm__btn--tiny" type="button" data-action-add
              :disabled="actions.length >= ACTION_MAX" @click.prevent="addAction">＋ 动作</button>
          </summary>
          <p class="hsb__hint">
            产品级动作：热点用 key 引用。没有动作库数据时不会伪造动画。
          </p>
          <p v-if="!actions.length" class="hsb__empty" data-action-empty>
            还没有动作。点「＋ 动作」新建，或在下方给热点绑定已有动作。
          </p>
          <button v-for="a in actions" :key="a.key" type="button" class="hsb__row hsb__row--action"
            :class="{ 'is-on': a.key === selectedActionKey }"
            data-action-row :data-action-key="a.key"
            :data-action-selected="a.key === selectedActionKey ? 'true' : 'false'"
            @click="selectedActionKey = a.key">
            <span class="hsb__row-top"><b>{{ a.key }}</b><span>{{ a.name || '未命名动作' }}</span></span>
            <small>{{ actionKindLabel(a.kind) }} · {{ actionRefCount(a) }} 处引用</small>
          </button>
        </details>
        <button v-for="(h, i) in hotspots" :key="h.id" type="button" class="hsb__row"
          :class="{ 'is-on': h.id === selectedId, 'is-invalid': !!h.invalidReason }"
          :data-hotspot-id="h.id"
          data-hs-row
          :data-hs-id="h.id"
          :data-hs-node-path="JSON.stringify(h.nodePath)"
          :data-hs-node-index="h.nodeIndex"
          :data-hs-visible-when="h.doorState"
          :data-hs-selected="h.id === selectedId ? 'true' : 'false'"
          :data-hotspot-status="h.invalidReason ? 'invalid' : 'valid'"
          :data-hotspot-invalid="h.invalidReason ? h.invalidReason : null"
          :data-hs-invalid="h.invalidReason ? h.invalidReason : null"
          :data-reason="h.invalidReason || null"
          @click="select(h.id)">
          <span class="hsb__row-top"><b>#{{ String(i + 1).padStart(2, '0') }}</b><span>{{ h.title || '未命名热点' }}</span></span>
          <small>{{ h.nodeName || '（锚点）' }} · {{ DOOR_STATE_LABEL[h.doorState] || h.doorState }}</small>
          <small v-if="h.invalidReason" class="hsb__row-bad">需复核：{{ invalidReasonText(h) }}</small>
        </button>
        <p v-if="counts.invalid" class="hsb__warn" data-hotspot-invalid-summary>
          {{ counts.invalid }} 条热点需复核：列表保留，3D 不画标记；原因在行内。
        </p>
      </aside>

      <section class="hsb__stage" aria-label="3D 标注舞台">
        <div ref="stageEl" class="hsb__canvas-wrap" @pointerdown="onStagePointerDown" @pointerup="onStagePointerUp">
          <div ref="canvasHost" class="hsb__canvas" data-editor-canvas />
          <div ref="markersHost" class="hsb__markers">
            <button v-for="m in markerPositions" :key="m.id" type="button" class="hsb__marker"
              :class="{ 'is-on': m.selected, 'is-occluded': m.occluded }"
              :style="{ left: m.x + 'px', top: m.y + 'px' }"
              :data-hs-marker="m.id" :data-hs-id="m.id" :data-hotspot-id="m.id"
              :data-hs-selected="m.selected ? 'true' : 'false'"
              :data-hs-occluded="m.occluded ? '1' : '0'"
              :data-hotspot-occluded="m.occluded ? '1' : '0'"
              :aria-label="'热点：' + m.title"
              :title="m.title"
              @pointerdown="onMarkerDown($event, { id: m.id })"
              @click.stop="select(m.id)">
              <i />
            </button>
          </div>
          <div v-if="modelError" class="hsb__modelerr">
            <b>3D 预览不可用</b>
            <p>{{ modelError }}</p>
          </div>
        </div>
        <div class="hsb__stage-foot">
          <span>拖动旋转 · 滚轮缩放 · 点表面添加；选中后可拖拽微调</span>
          <span v-if="model.checksum" class="hsb__mono">模型 {{ model.variant }} · {{ String(model.checksum).slice(0, 8) }}</span>
          <span v-else class="hsb__mono">模型 {{ model.variant }}</span>
        </div>
      </section>

      <aside class="hsb__side" aria-label="热点与内容编辑" data-hotspot-editor>
        <template v-if="selectedAction">
          <div class="hsb__side-head" data-action-editor>
            <b>编辑动作</b>
            <button class="adm__btn adm__btn--tiny hsb__danger" type="button" data-action-delete
              @click="deleteAction(selectedAction)">删除</button>
          </div>
          <label class="hsb__f">
            <span>key <em>产品内唯一</em></span>
            <input :value="selectedAction.key" maxlength="64" placeholder="小写字母/数字/-_"
              data-action-field="key" @change="setActionKey(selectedAction, $event.target.value)">
          </label>
          <label class="hsb__f">
            <span>名称</span>
            <input v-model="selectedAction.name" maxlength="80" placeholder="给维护人员看的名字"
              data-action-field="name" @input="dirty = true">
          </label>
          <label class="hsb__f">
            <span>类型</span>
            <select v-model="selectedAction.kind" data-action-field="kind" @change="resetKind(selectedAction)">
              <option v-for="k in ACTION_KINDS" :key="k" :value="k">{{ actionKindLabel(k) }}（{{ k }}）</option>
            </select>
          </label>
          <label class="hsb__f">
            <span>目标节点</span>
            <select :value="actionTargetKey(selectedAction)" data-action-field="target"
              @change="setActionTarget(selectedAction, $event.target.value)">
              <option v-if="!nodeOptions.length" value="">模型载入后才能选目标</option>
              <option v-for="n in nodeOptions" :key="n.key" :value="n.key">{{ n.crumb }}</option>
            </select>
          </label>
          <p class="hsb__hint hsb__mono" data-action-target-path>
            {{ (selectedAction.target.path || []).join(' › ') || '（未选）' }} · index {{ selectedAction.target.index }}
          </p>

          <template v-if="selectedAction.kind === 'rotate'">
            <div class="hsb__toolrow">
              <label class="hsb__f hsb__f--inline"><span>轴</span>
                <select v-model="selectedAction.motion.axis" data-action-field="axis" @change="dirty = true">
                  <option v-for="v in ['x', 'y', 'z']" :key="v" :value="v">{{ v }}</option>
                </select>
              </label>
              <label class="hsb__f hsb__f--inline"><span>方向</span>
                <select v-model="selectedAction.motion.direction" data-action-field="direction" @change="dirty = true">
                  <option value="+">+</option><option value="-">−</option>
                </select>
              </label>
            </div>
            <label class="hsb__f"><span>角度（度）</span>
              <input v-model.number="selectedAction.motion.angleDeg" type="number" min="-360" max="360" step="1"
                data-action-field="angleDeg" @input="dirty = true">
            </label>
            <label class="hsb__f"><span>铰链点 pivotMm（模型根局部 mm，三轴）</span>
              <span class="hsb__triple">
                <input v-model.number="selectedAction.motion.pivotMm[0]" type="number" step="0.01" aria-label="pivot x" data-action-field="pivotX">
                <input v-model.number="selectedAction.motion.pivotMm[1]" type="number" step="0.01" aria-label="pivot y" data-action-field="pivotY">
                <input v-model.number="selectedAction.motion.pivotMm[2]" type="number" step="0.01" aria-label="pivot z" data-action-field="pivotZ">
              </span>
            </label>
            <p class="hsb__hint">必须填模型根局部毫米（例如 352 门 [287.71, 70, 363]）；填成米或节点局部会转错。</p>
          </template>

          <template v-if="selectedAction.kind === 'translate'">
            <div class="hsb__toolrow">
              <label class="hsb__f hsb__f--inline"><span>轴</span>
                <select v-model="selectedAction.motion.axis" data-action-field="axis" @change="dirty = true">
                  <option v-for="v in ['x', 'y', 'z']" :key="v" :value="v">{{ v }}</option>
                </select>
              </label>
              <label class="hsb__f hsb__f--inline"><span>距离（mm）</span>
                <input v-model.number="selectedAction.motion.distanceMm" type="number" step="1" data-action-field="distanceMm" @input="dirty = true">
              </label>
            </div>
          </template>

          <label v-if="selectedAction.kind === 'visibility'" class="hsb__f hsb__f--check">
            <span>目标状态</span>
            <span><input v-model="selectedAction.motion.visible" type="checkbox" data-action-field="visible" @change="dirty = true"> 显示</span>
          </label>

          <label v-if="selectedAction.kind === 'clip'" class="hsb__f">
            <span>动画片段名</span>
            <input v-model="selectedAction.motion.clipName" maxlength="80" placeholder="GLB 内置 clip 名称"
              data-action-field="clipName" @input="dirty = true">
          </label>

          <div class="hsb__toolrow">
            <label class="hsb__f hsb__f--inline"><span>时长 ms</span>
              <input v-model.number="selectedAction.motion.durationMs" type="number" min="100" max="5000" step="50"
                data-action-field="durationMs" @input="dirty = true">
            </label>
            <label class="hsb__f hsb__f--check"><span>再点反向</span>
              <span><input v-model="selectedAction.motion.toggle" type="checkbox" data-action-field="toggle" @change="dirty = true"> toggle</span>
            </label>
          </div>
          <p class="hsb__hint">保存后到设计端详情点绑定的热点即可执行；服务端会再校验一次。</p>
        </template>

        <hr v-if="selectedAction && selected" class="hsb__sep">

        <template v-if="selected">
          <div class="hsb__side-head">
            <b>编辑热点</b>
            <span class="hsb__mono">#{{ String(selected.seq + 1).padStart(2, '0') }}</span>
          </div>
          <label class="hsb__f">
            <span>标题 <em :class="{ 'is-bad': selectedTitleCount > LIMITS.title }">{{ selectedTitleCount }}/{{ LIMITS.title }}</em></span>
            <input v-model="selected.title" maxlength="40" placeholder="必填，1–40 字" data-hs-field="title" @input="dirty = true">
          </label>
          <label class="hsb__f">
            <span>正文 <em :class="{ 'is-bad': selectedBodyCount > LIMITS.body }">{{ selectedBodyCount }}/{{ LIMITS.body }}</em></span>
            <textarea v-model="selected.body" rows="4" maxlength="300" placeholder="必填，1–300 字，纯文本" data-hs-field="body" @input="dirty = true" />
          </label>
          <label class="hsb__f">
            <span>显示门状态</span>
            <select v-model="selected.doorState" data-hs-field="doorState" :data-hs-visible-when="selected.doorState" @change="dirty = true">
              <option v-for="s in ['any', 'open', 'closed']" :key="s" :value="s">{{ DOOR_STATE_LABEL[s] }}</option>
            </select>
          </label>
          <label class="hsb__f">
            <span>绑定动作 <em>可选</em></span>
            <select :value="selected.actionKey || ''" data-hs-field="actionKey"
              @change="bindSelectedAction($event.target.value)">
              <option value="">无（只弹说明，不执行动作）</option>
              <option v-if="selected.actionKey && !actions.some((a) => a.key === selected.actionKey)"
                :value="selected.actionKey">已失效：{{ selected.actionKey }}</option>
              <option v-for="a in actions" :key="a.key" :value="a.key">{{ a.name || a.key }}（{{ a.key }}）</option>
            </select>
          </label>
          <p v-if="selected.actionKey" class="hsb__hint">
            设计端点这条热点会先执行「{{ selected.actionKey }}」，再打开说明弹层。
          </p>
          <label class="hsb__f">
            <span>挂在哪个零件上</span>
            <select :value="anchorKey(selected)" data-hs-field="anchor" @change="setAnchorFromSelect($event.target.value)">
              <option v-for="n in nodeOptions" :key="n.key" :value="n.key">{{ n.crumb }}</option>
            </select>
          </label>
          <p class="hsb__anchor-current" data-anchor-current data-hotspot-anchor-breadcrumb>
            当前锚点：<b>{{ anchorBreadcrumb }}</b>
          </p>
          <details class="hsb__anchor-raw" data-anchor-raw data-hotspot-anchor-path>
            <summary>查看原始节点路径与序号</summary>
            <small class="hsb__mono" data-anchor-path>{{ selected.nodePath.join('/') }} · index {{ selected.nodeIndex }}</small>
            <small class="hsb__mono" data-hotspot-coord>{{ selected.position.x.toFixed(3) }}, {{ selected.position.y.toFixed(3) }}, {{ selected.position.z.toFixed(3) }} m · 节点局部</small>
          </details>
          <div class="hsb__anchor-help" data-anchor-help data-hotspot-anchor-help>
            <b>锚点怎么选（3 条）</b>
            <ol>
              <li>点模型上要跟着动的零件表面（门、抽屉、层板）；系统会自动取最近的命名节点。</li>
              <li>选零件本身，不要选整机根节点——热点会跟着锚点节点一起动。</li>
              <li>加完可拖拽微调落点；换模型后失效的锚点会标红，重新点一次即可。</li>
            </ol>
          </div>
          <p v-if="selected.invalidReason" class="hsb__warn hsb__warn--bad" data-hs-invalid
            :data-hs-anchor-blocked="selectedAnchorBlocked ? 'true' : 'false'">
            需复核：{{ invalidReasonText(selected) }}。
            <template v-if="selectedAnchorBlocked">保存/发布前必须先修好：重新选锚点，或删除这条。</template>
            <template v-else>锚点仍可用，保存不会丢这条；设计端会列出复核原因。</template>
          </p>
          <div class="hsb__toolrow">
            <button class="adm__btn adm__btn--tiny" type="button" @click="saveCurrentView">保存当前视角</button>
            <button class="adm__btn adm__btn--tiny" type="button" :disabled="!selected.camera" @click="applyHotspotView">应用视角</button>
            <button class="adm__btn adm__btn--tiny hsb__danger" type="button" @click="deleteSelected">删除</button>
          </div>
          <p v-if="selected.camera" class="hsb__hint hsb__mono" data-hs-camera>
            视角 {{ Number(selected.camera.azimuthDeg).toFixed(0) }}° / {{ Number(selected.camera.elevationDeg).toFixed(0) }}° · ×{{ Number(selected.camera.distFactor).toFixed(2) }} · fov {{ Math.round(Number(selected.camera.fov)) }}
          </p>
          <p class="hsb__hint">视角只存方位/仰角/距离系数/目标/fov，不存绝对机位。</p>
        </template>
        <p v-else class="hsb__empty hsb__side-empty">点 3D 标记或左侧列表选中一条热点；也可以直接点模型添加。</p>

      </aside>
    </div>

    <footer v-if="phase === 'ok'" class="hsb__foot">
      <button class="adm__btn adm__btn--ghost" type="button" data-board-back
        @click="embedded ? emit('back') : emit('exit')">← 上一步</button>
      <!-- 向导第 3 步没有独立“完成页”，必须给一个明确的出口；否则用户保存后只能在
           看板和第 2 步之间来回，回不到产品列表。 -->
      <button v-if="embedded" class="adm__btn" type="button" data-board-finish
        @click="emit('exit')">完成，回产品列表</button>
      <p v-if="doorWarning" class="hsb__door-warn" data-door-warning>{{ doorWarning }}</p>
      <p v-if="saveMessage" class="hsb__save" :class="'is-' + saveState"
        data-hs-save-message
        :data-hotspot-publish-error="saveState === 'unpublished' || saveState === 'failed' ? saveMessage : null">{{ saveMessage }}</p>
      <ul v-if="saveIssues.length" class="hsb__issues">
        <li v-for="x in saveIssues" :key="x">{{ x }}</li>
      </ul>
      <span class="adm__spacer" />
      <!-- v1 底栏只有「上一步 / 保存」；「重新载入」只在保存/冲突失败时出现，不占常态工具条 -->
      <button v-if="saveState === 'failed'" class="adm__btn" type="button" :disabled="saving" @click="reloadConfirmed">重新载入</button>
      <button class="adm__btn adm__btn--primary" type="button" data-hotspot-save data-editor-save :disabled="saving" @click="save">
        {{ saving ? '保存中…' : '保存' }}
      </button>
    </footer>
  </div>
</template>
