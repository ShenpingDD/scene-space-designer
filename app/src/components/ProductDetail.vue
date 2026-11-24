<script setup>
/**
 * ProductDetail —— 设计端「产品 3D 详情」模态（设计决策记录 §四、设计决策记录）
 *
 * 定位：**只读浏览**。这里不写方案、不改选中、不移动设备、也没有「放入布局」——
 * 加设备仍然走左侧卡片右上角那个「＋」。把两件事混在一个按钮里，最典型的坏结果是
 * "点开看看讲解，结果家里多了一台冰箱"。
 *
 * 与主画布的关系：**完全独立的一份渲染器**（`detail3d.js` 自己建 canvas/renderer/camera）。
 * 主画布那份 `scene3d.js` 是模块级单例，在这里再 `attach()` 一次会把它的上下文抢走。
 *
 * 三条"必须吵"的判据（都是本项目的老账，见 AGENTS §5）：
 *   ① 失效热点**不画标记**，但必须在界面上出现「N 个热点需复核」+ 逐条原因 —— 静默少画等于撒谎；
 *   ② 模型取不到时，文字内容与热点索引照常显示（能读的照样能读），并给出重试；
 *   ③ 没有热点 ≠ 加载失败：两种空态文案分开写。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { api } from '../api.js';
import {
  DEFAULT_CAMERA, contentOf, createDetailViewer, hotspotStatus, invalidRows, reasonText,
} from '../detail3d.js';
import { catalogState } from '../catalog.js';

const props = defineProps({
  open: { type: Boolean, default: false },
  /** 目录行（catalog.js 的适配形状）；为空时详情不打开 */
  product: { type: Object, default: null },
  /**
   * 触发打开的那张缩略图。关详情时焦点要还给它 —— 只靠 `document.activeElement` 不够：
   * 程序化点击（探针/键盘 Enter）不会先移动焦点，那时 activeElement 可能还是 body。
   */
  returnFocus: { type: Object, default: null },
});

const emit = defineEmits(['close']);

const box = ref(null);
const stage = ref(null);
const canvas = ref(null);
const closeBtn = ref(null);
const popCloseBtn = ref(null);

let viewer = null;
let lastFocus = null;

/* ---------------- 数据 ---------------- */

const detail = ref(null);
const detailError = ref('');      // 'content-not-published' | 'offline' | 其它
const loadingDetail = ref(false);
const modelError = ref('');
const loadingModel = ref(false);
const level = ref('');
const doorAmount = ref(0);
const lastAction = ref("");
const activeId = ref(null);
const readIds = ref(new Set());
const markers = ref([]);
const invalidOpen = ref(false);
const probe = ref(null);

const content = computed(() => contentOf(detail.value));
const limits = computed(() => detail.value?.limits ?? { hotspots: 50 });
const counts = computed(() => {
  const d = detail.value;
  const total = d?.counts?.total ?? (d?.hotspots ?? []).length;
  const valid = markers.value.filter((m) => m.node).length;
  const invalid = invalidRows(d, failedHotspots.value).length;
  return { total, valid, invalid, declaredInvalid: d?.counts?.invalid ?? 0 };
});
const failedHotspots = ref([]);
const status = computed(() => hotspotStatus(detail.value, counts.value.invalid));
const reviewRows = computed(() => invalidRows(detail.value, failedHotspots.value));
/** 索引里只列**能定位**的热点：失效项统一进 reviewRows，不在这里重复出现（也不给假入口） */
const indexMarkers = computed(() => markers.value.filter((m) => m.node));
const readCount = computed(() => markers.value.filter((m) => m.read && m.node).length);

/** 目录来源是本地资产时，热点与最新内容注定不是最新的 —— 必须写在脸上 */
const staticSource = computed(() => catalogState.source !== 'server');

/** 门状态：详情里只切预览，不改方案 */
const doorState = computed(() => (doorAmount.value >= 0.5 ? 'open' : 'closed'));

/**
 * 可动件：只看**这份模型实际绑到的门**（`probe.doors` 来自 bindDoors），
 * 不看产品有没有声明门。379（demo-storage-cabinet）是单节点模型、没有任何可动件 extras ——
 * 页面必须明说"该模型无可动零件"，不能给一个点了没反应的开门按钮。
 */
const movableDoors = computed(() => (probe.value?.doors ?? []).filter((d) => d.found && d.node));
const hasMovableParts = computed(() => movableDoors.value.length > 0);
/** 加载完成前不冒充"没有门"：unknown 只在 probe 为空时出现 */
const doorFootState = computed(() => (probe.value ? (hasMovableParts.value ? doorState.value : 'none') : 'unknown'));
const doorFootText = computed(() => {
  if (!probe.value) return loadingModel.value ? '门：—（模型载入中）' : '门：—';
  if (!hasMovableParts.value) return '该模型无可动零件';
  return `门：${doorState.value === 'open' ? '开' : '关'}`;
});

const visibleMarkers = computed(() => markers.value.filter((m) => m.visible));
const active = computed(() => markers.value.find((m) => m.id === activeId.value) ?? null);

function mm(v) { return v == null ? '—' : Math.round(v * 1000); }

/* ---------------- 打开 / 关闭 ---------------- */

/**
 * 打开顺序：先挂查看器再取数据。
 * 反过来的话，数据到了、canvas 还没绑，第一帧就是黑的（而且 `project` 算不出来）。
 */
async function openFlow() {
  lastFocus = document.activeElement;
  document.addEventListener('keydown', onKey);
  await nextTick();
  closeBtn.value?.focus?.();
  await nextTick();
  try {
    if (canvas.value && stage.value) {
      viewer = createDetailViewer({
        onFrame: () => { if (props.open) refreshMarkers(); },
      });
      viewer.attach(canvas.value);
      resize();
    }
  } catch (e) {
    modelError.value = `3D 视图起不来：${e?.message ?? e}`;
  }
  await loadDetail();
  await loadModel();
}

function closeAll() {
  document.removeEventListener('keydown', onKey);
  teardown();
  emit('close');
  const el = props.returnFocus ?? lastFocus;
  lastFocus = null;
  if (el && typeof el.focus === 'function') nextTick(() => el.focus());
}

function teardown() {
  try { viewer?.dispose(); } catch { /* 已经丢了也要继续 */ }
  viewer = null;
  markers.value = [];
  activeId.value = null;
  readIds.value = new Set();
  detail.value = null;
  detailError.value = '';
  modelError.value = '';
  level.value = '';
  doorAmount.value = 0;
  probe.value = null;
  failedHotspots.value = [];
  invalidOpen.value = false;
}

/* ---------------- 取详情 ---------------- */

async function loadDetail() {
  const p = props.product;
  if (!p) return;
  loadingDetail.value = true;
  detailError.value = '';
  try {
    const raw = await api.catalogDetail(p.id);
    // 等接口的路上用户可能已经关掉（或换了一款）：旧结果不许写进新会话
    if (!props.open || props.product !== p) return;
    detail.value = raw ?? null;
  } catch (e) {
    if (!props.open || props.product !== p) return;
    const code = e?.reason ?? '';
    detailError.value = code === 'content-not-published' ? 'content-not-published'
      : (e?.status === 404 ? 'content-not-published' : (code === 'backend-down' ? 'offline' : (code || 'offline')));
    detail.value = null;
  } finally {
    loadingDetail.value = false;
  }
}

async function loadModel() {
  const p = props.product;
  if (!p || !viewer) return;
  loadingModel.value = true;
  modelError.value = '';
  const v = viewer;   // 捕获这一次的实例：等待期间被关掉/换掉，旧结果一律丢弃
  try {
    const pr = await v.load(p);
    if (!props.open || viewer !== v) return;
    probe.value = pr;
    level.value = pr?.level ?? '';
    // 解析必须在模型到位之后：锚点只在**真的这一份模型**里解析（跨 LOD 找不到就报失效，不按名字重挂）
    const { resolved, failed } = v.resolve(detail.value?.hotspots ?? []);
    resolveCache.clear();
    for (const r of resolved) resolveCache.set(r.hotspot.id, r.node);
    failedHotspots.value = failed;
    refreshMarkers();
  } catch (e) {
    if (props.open && viewer === v) modelError.value = e?.message ?? String(e);
  } finally {
    loadingModel.value = false;
  }
}

/**
 * 标记重新投影。**只画 valid**：解析失败的进 `failedHotspots`，由信息栏与黄条显示原因。
 * `read` 是本次会话的已读记忆（关掉详情不算丢 —— 它是"看过"这件事，不是数据）。
 */
function refreshMarkers() {
  if (!props.open) return;
  // 单条坏数据不许把整页打空：先滤掉空行，再按 id 解析。
  const rows = (detail.value?.hotspots ?? []).filter((x) => x && x.id !== null && x.id !== undefined);
  const list = rows.map((hotspot) => ({
    hotspot, node: resolveCache.get(hotspot.id) ?? null,
  }));
  // 模型没就绪 / 取不到时，`project` 一条都给不出坐标（`visible:false`），
  // 但**索引照旧要列出来** —— 104 §4.5：模型失败时文字与热点索引仍然可读。
  const projected = viewer ? viewer.project(list) : [];
  const byId = new Map(projected.map((x) => [x.id, x]));
  markers.value = list.map(({ hotspot, node }) => {
    const pr = byId.get(hotspot.id) ?? { visible: false };
    return {
      id: hotspot.id,
      seq: hotspot.seq ?? 0,
      title: hotspot.title ?? '',
      body: hotspot.body ?? '',
      doorState: hotspot.doorState ?? 'any',
      nodePath: (hotspot.nodePath ?? []).join('/'),
      actionKey: hotspot.actionKey ?? null,
      camera: hotspot.camera ?? null,
      x: pr.x ?? 0,
      y: pr.y ?? 0,
      visible: !!pr.visible,
      occluded: !!pr.occluded,
      read: readIds.value.has(hotspot.id),
      node,
    };
  });
}

/** 锚点解析缓存：只在模型载入后算一次（投影是每帧跑的，每帧都做 50 次先序遍历会拖慢拖动） */
const resolveCache = new Map();

/* ---------------- 门 / 取景 ---------------- */

function setDoor(v) {
  doorAmount.value = v;
  viewer?.setDoor(v);
  refreshMarkers();
  // 当前热点在门切换后不可见了 → 自动关闭弹层并播报（不是悄悄消失）
  const a = active.value;
  if (a && !a.visible) {
    activeId.value = null;
    announce.value = `该热点在${v >= 0.5 ? '开门' : '关门'}时不可见`;
  }
}

function toggleDoor() { setDoor(doorAmount.value >= 0.5 ? 0 : 1); }

function resetView() {
  viewer?.frame();
  refreshMarkers();
}

/* ---------------- 标记交互 ---------------- */

function runHotspotAction(m) {
  const key = m?.actionKey;
  if (!key) return null;
  const action = (detail.value?.actions ?? []).find((a) => a && a.key === key);
  if (!action) {
    announce.value = `热点引用的动作不在动作库：${key}`;
    return { ok: false, reason: 'action-missing' };
  }
  const r = viewer?.runAction(action);
  if (r && !r.ok) {
    announce.value = `动作「${action.name || key}」无法执行：${r.reason || '目标未找到'}`;
  }
  lastAction.value = r ? `${r.ok ? "ok" : "fail"}:${r.reason || r.kind}:door=${r.door ? 1 : 0}:to=${r.to}:root=${r.rootName || ""}:samples=${(r.samplePaths || []).map((p) => p.join("/")).join("|")}` : "null";
  if (r && r.ok && r.door) {
    // 动作复用了门 pivot：footer 与热点可见性要跟着动作开度走，不能还停在 0。
    doorAmount.value = r.to;
    refreshMarkers();
  }
  return r;
}

function pickMarker(m) {
  if (!m) return;
  if (activeId.value === m.id) {
    // 同一热点二次点击也要执行动作：352 的第一次点击只开弹层，用户再点一次才是“关门/切换”，
    // 旧实现只把 activeId 清空，导致要第三次点击才动。
    runHotspotAction(m);
    activeId.value = null;
    return;
  }
  runHotspotAction(m);
  activeId.value = m.id;
  readIds.value = new Set([...readIds.value, m.id]);
  if (m.camera) viewer?.focusCamera(m.camera);
  nextTick(() => popCloseBtn.value?.focus?.());
}

function openFromIndex(m) {
  if (!m) return;
  runHotspotAction(m);
  activeId.value = m.id;
  readIds.value = new Set([...readIds.value, m.id]);
  if (m.camera) viewer?.focusCamera(m.camera);
  refreshMarkers();
  nextTick(() => popCloseBtn.value?.focus?.());
}

function closePopover() {
  const id = activeId.value;
  activeId.value = null;
  nextTick(() => {
    // 焦点还给**那一条标记**；标记不在（被门状态藏了）就回关闭按钮，别让焦点掉到 body
    const el = id == null ? null : box.value?.querySelector(`[data-hs-id="${id}"]`);
    (el ?? closeBtn.value)?.focus?.();
  });
}

const announce = ref('');

/* ---------------- 键盘 ---------------- */

/**
 * Esc 的**两级退让**（104 §4.1）：先关热点弹层，再关详情。
 * 一级到位的话，用户按一次 Esc 就把整个详情关掉 —— 而他想关的可能只是那个小弹层。
 */
function onKey(e) {
  if (!props.open) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    if (activeId.value != null) { closePopover(); return; }
    closeAll();
    return;
  }
  if (e.key !== 'Tab') return;
  const focusables = focusablesIn();
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  const el = document.activeElement;
  if (e.shiftKey && (el === first || !box.value?.contains(el))) {
    e.preventDefault(); last.focus();
  } else if (!e.shiftKey && (el === last || !box.value?.contains(el))) {
    e.preventDefault(); first.focus();
  }
}

function focusablesIn() {
  if (!box.value) return [];
  const nodes = box.value.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
  return Array.from(nodes).filter((el) => !el.disabled && el.offsetParent !== null);
}

/* ---------------- 尺寸 ---------------- */

let ro = null;
function resize() {
  viewer?.resize?.();
  refreshMarkers();
}

watch(() => props.open, async (v) => {
  if (v) {
    await openFlow();
    if (typeof ResizeObserver !== 'undefined' && stage.value) {
      ro = new ResizeObserver(() => resize());
      ro.observe(stage.value);
    }
  } else {
    ro?.disconnect(); ro = null;
    document.removeEventListener('keydown', onKey);
    teardown();
  }
}, { immediate: true });

onBeforeUnmount(() => {
  ro?.disconnect();
  document.removeEventListener('keydown', onKey);
  teardown();
});
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="pd__mask" data-product-detail :data-detail-last-action="lastAction">
      <div
        ref="box"
        class="pd"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pd-title"
      >
        <header class="pd__head">
          <div class="pd__titles">
            <h2 id="pd-title" class="pd__name">{{ product?.name ?? '产品详情' }}</h2>
            <span class="pd__model mono">{{ product?.model ?? '' }}</span>
            <span
              v-if="status !== 'none'"
              class="pd__badge"
              :class="{ 'is-review': status === 'review' }"
              :title="status === 'review' ? `有 ${counts.invalid} 个热点在当前模型上解析不了` : '本款的热点都能在当前模型上定位'"
            >{{ status === 'review' ? `${counts.invalid} 个热点需复核` : '热点可用' }}</span>
          </div>
          <button ref="closeBtn" type="button" class="btn pd__close" data-product-detail-close @click="closeAll">
            关闭
          </button>
        </header>

        <!-- 计数钩子常驻：即使"热点索引"区块因为没内容而隐藏，探针与读屏也能读到 0 而不是读不到 -->
        <span
          class="pd__sr"
          :data-detail-invalid-count="counts.invalid"
          :data-detail-count-total="counts.total"
          :data-detail-count-valid="counts.valid"
          :data-detail-status="status"
        >{{ counts.invalid }}</span>

        <p v-if="staticSource" class="pd__strip">
          当前目录来自<b>本地资产</b>：热点与最新讲解内容可能不是最新的一份。
        </p>

        <!-- 需要复核的热点：计数常显，原因可展开（不许只给颜色/只给一个数） -->
        <div v-if="reviewRows.length" class="pd__review" data-detail-review :data-detail-review-count="reviewRows.length">
          <button
            type="button"
            class="pd__review-btn"
            :aria-expanded="invalidOpen"
            :title="reviewRows.map((r) => `${r.title || ('#' + r.id)}：${reasonText(r.reason)}${r.detail ? '（' + r.detail + '）' : ''}`).join('\n')"
            @click="invalidOpen = !invalidOpen"
          >
            <b>{{ reviewRows.length }} 个热点需复核</b>
            <span aria-hidden="true">{{ invalidOpen ? '收起原因' : '查看原因' }}</span>
          </button>
          <ul v-if="invalidOpen" class="pd__review-list">
            <li v-for="(r, i) in reviewRows" :key="`${r.id}-${r.reason}-${i}`">
              <b>{{ r.title || `热点 #${r.id}` }}</b> —— {{ reasonText(r.reason) }}
              <span v-if="r.detail" class="mono pd__review-detail">{{ r.detail }}</span>
              <span class="pd__code mono">{{ r.reason }}</span>
            </li>
          </ul>
        </div>

        <div class="pd__body">
          <section ref="stage" class="pd__stage" data-detail-stage>
            <canvas ref="canvas" class="pd__canvas" aria-label="产品三维预览（拖动旋转、滚轮缩放）" />
            <div class="pd__tools">
              <template v-if="hasMovableParts">
                <div class="seg" role="group" aria-label="门">
                  <button type="button" :aria-pressed="doorState === 'closed'" @click="setDoor(0)">关门</button>
                  <button type="button" :aria-pressed="doorState === 'open'" @click="setDoor(1)">开门</button>
                </div>
                <button type="button" class="btn btn--ghost" @click="toggleDoor" data-door-toggle>
                  {{ doorState === 'open' ? '关上看看' : '打开看看' }}
                </button>
              </template>
              <span v-else-if="probe && !loadingModel" class="pd__no-move" data-detail-nonmovable>该模型无可动零件</span>
              <button type="button" class="btn btn--ghost" @click="resetView">重置视角</button>
            </div>

            <!-- 标记层：只画 valid；失效的走上面的黄条 -->
            <div class="pd__markers" data-detail-markers>
              <button
                v-for="m in visibleMarkers"
                :key="m.id"
                type="button"
                class="pd__marker"
                :class="{ 'is-active': activeId === m.id, 'is-read': m.read, 'is-occluded': m.occluded }"
                :style="{ left: m.x + 'px', top: m.y + 'px' }"
                :data-hs-id="m.id"
                :data-hs-node-path="m.nodePath"
                :data-hs-action-key="m.actionKey || ''"
                :data-hs-occluded="m.occluded ? 'true' : 'false'"
                :data-hs-read="m.read ? 'true' : 'false'"
                :aria-label="`${m.title}${m.read ? '（已读）' : ''}${m.occluded ? '（被模型遮挡）' : ''}`"
                :title="m.occluded ? `${m.title}（被模型遮挡）` : m.title"
                @click="pickMarker(m)"
              >
                <span class="pd__dot" aria-hidden="true" />
                <span class="pd__num">{{ String((m.seq ?? 0) + 1).padStart(2, '0') }}</span>
              </button>
            </div>

            <p v-if="loadingModel" class="pd__note">正在载入模型…</p>
            <p v-else-if="modelError" class="pd__note pd__note--bad" role="alert">
              <b>模型取不到：</b>{{ modelError }}
              <button type="button" class="btn btn--mini" @click="loadModel">重试</button>
            </p>
            <p v-else-if="detailError && !counts.total" class="pd__note" data-detail-empty="no-content">
              读不到这一款的热点数据（右侧说明了原因）—— 模型本身照常可以看。
            </p>
            <p v-else-if="detail && counts.valid === 0 && counts.invalid > 0" class="pd__note" data-detail-empty="all-invalid">
              {{ counts.invalid }} 个热点在当前模型上暂不可用（原因见上方与右侧列表）。
            </p>

            <!-- 弹层：不遮关闭按钮与门控；Esc 关它而**不**关详情 -->
            <div
              v-if="active"
              class="pd__pop"
              role="dialog"
              aria-modal="false"
              :aria-label="active.title"
              data-detail-popover
            >
              <div class="pd__pop-head">
                <b class="pd__pop-title">{{ active.title }}</b>
                <button ref="popCloseBtn" type="button" class="btn btn--mini" @click="closePopover">关闭</button>
              </div>
              <p class="pd__pop-body">{{ active.body }}</p>
              <div class="pd__pop-meta">
                <span class="mono">{{ active.doorState === 'any' ? '任意门状态可见' : (active.doorState === 'open' ? '开门时可见' : '关门时可见') }}</span>
                <span v-if="active.read" class="pd__read-mark">✓ 已读</span>
              </div>
            </div>
          </section>

          <aside class="pd__info">
            <p v-if="detailError === 'content-not-published'" class="pd__empty" role="status">
              这一款还没有发布讲解内容。
            </p>
            <p v-else-if="detailError" class="pd__empty pd__empty--warn" role="status">
              读不到讲解内容（{{ detailError === 'offline' ? '后端没响应' : detailError }}）—— 模型与型号信息照常显示。
            </p>
            <p v-else-if="loadingDetail" class="pd__empty">正在读讲解内容…</p>

            <section v-if="content.description" class="pd__sec" data-detail-section="description">
              <h3>产品简介</h3>
              <p class="pd__text">{{ content.description }}</p>
            </section>

            <section v-if="content.sellingPoints.length" class="pd__sec" data-detail-section="selling">
              <h3>卖点介绍</h3>
              <dl class="pd__kv">
                <template v-for="(sp, i) in content.sellingPoints" :key="`sp-${i}`">
                  <dt>{{ sp.label || `卖点 ${i + 1}` }}</dt>
                  <dd>{{ sp.text }}</dd>
                </template>
              </dl>
            </section>

            <section v-if="content.params.length" class="pd__sec" data-detail-section="specs">
              <h3>技术参数</h3>
              <table class="pd__table">
                <tbody>
                  <tr v-for="(it, i) in content.params" :key="`p-${i}`">
                    <th scope="row">{{ it.key }}</th>
                    <td>{{ it.value }}<span v-if="it.unit" class="pd__unit">{{ it.unit }}</span></td>
                  </tr>
                </tbody>
              </table>
            </section>

            <section
              v-if="indexMarkers.length || reviewRows.length || (detail && counts.total === 0)"
              class="pd__sec"
              data-detail-section="hotspot-index"
              :data-detail-index-count="indexMarkers.length"
            >
              <h3>
                热点索引
                <span class="pd__count" :data-detail-invalid-count="counts.invalid">
                  {{ counts.valid }}/{{ counts.total }} 可看<template v-if="counts.invalid"> · {{ counts.invalid }} 需复核</template>
                </span>
              </h3>
              <!-- 0 热点是内容状态，不是加载失败：放在索引区，不盖住 canvas/模型。 -->
              <p v-if="detail && counts.total === 0" class="pd__empty" data-detail-empty="no-hotspot">
                该产品还没有 3D 标注（文字介绍照常可读）。
              </p>
              <!-- 有失效热点时索引照常列出**有效**项：失效项只在下面「需复核」里出现一次，
                   不给它一个点了没反应（或定位不到）的假入口。 -->
              <ul class="pd__index">
                <!-- 索引行也带钩子：探针要能数出"列表里有几条"，但**不复用** `data-hs-id`
                     免得和舞台上的标记一起被选中（两处语义不同：一个是投影点，一个是文本行） -->
                <li v-for="m in indexMarkers" :key="`idx-${m.id}`" :data-detail-index-id="m.id">
                  <button type="button" class="pd__index-btn" @click="openFromIndex(m)">
                    <span class="pd__idx-n mono">{{ String((m.seq ?? 0) + 1).padStart(2, '0') }}</span>
                    <span class="pd__idx-t">{{ m.title }}</span>
                    <span class="pd__idx-meta mono">{{ m.doorState === 'any' ? '任意' : (m.doorState === 'open' ? '开门' : '关门') }}</span>
                    <span v-if="m.read" class="pd__read-mark">✓</span>
                  </button>
                </li>
                <li
                  v-for="(r, i) in reviewRows"
                  :key="`bad-${i}`"
                  class="pd__index-bad"
                  :data-detail-index-id="r.id"
                  data-detail-index-bad
                >
                  <span class="pd__idx-t">{{ r.title || `热点 #${r.id}` }}</span>
                  <span class="pd__idx-meta">{{ reasonText(r.reason) }}</span>
                </li>
              </ul>
            </section>

            <p class="pd__meta mono">
              尺寸 {{ mm(product?.w) }} × {{ mm(product?.d) }} × {{ mm(product?.h) }} mm
              <template v-if="level"> · 模型 {{ level }}</template>
              <template v-if="probe?.triangles"> · {{ probe.triangles }} 面</template>
            </p>
          </aside>
        </div>

        <footer class="pd__foot">
          <span class="pd__foot-item" :data-detail-door-state="doorFootState">{{ doorFootText }}</span>
          <span class="pd__foot-item" :data-detail-read="readCount">已读 {{ readCount }}/{{ counts.valid }}</span>
          <span class="pd__foot-item">上限 {{ limits.hotspots }} 个</span>
          <span class="pd__foot-hint">拖动旋转 · 滚轮缩放 · 左键拖动空白处平移 · Esc 关闭</span>
        </footer>

        <p class="pd__live" role="status" aria-live="polite">{{ announce }}</p>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* 遮罩：比别处深一点 —— 详情里有一整块 3D 舞台，浅遮罩会让两层画面糊在一起 */
.pd__mask {
  position: fixed; inset: 0; z-index: 60;
  display: grid; place-items: center;
  background: rgba(17, 27, 34, .42);
}
.pd {
  width: min(1180px, 92vw);
  height: min(760px, 88vh);
  display: flex; flex-direction: column;
  background: #fff; border-radius: 14px; overflow: hidden;
  box-shadow: 0 24px 64px rgba(12, 24, 33, .28);
}
.pd__head {
  flex: none; display: flex; align-items: center; gap: 10px;
  padding: 12px 14px; border-bottom: 1px solid var(--line-2, #dbe3e8);
}
.pd__titles { display: flex; align-items: baseline; gap: 10px; min-width: 0; flex: 1 1 auto; }
.pd__name { margin: 0; font-size: 15px; color: var(--ink, #16212a); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pd__model { font-size: 12px; color: #5b6b76; }
.pd__badge {
  flex: none; font-size: 11px; padding: 2px 8px; border-radius: 999px;
  background: #eef6ee; color: #2c6b3f; border: 1px solid #cfe4d4;
}
.pd__badge.is-review { background: #fdf6e6; color: #8a5b12; border-color: #edd9a8; }
.pd__close { flex: none; min-width: 64px; height: 40px; }

.pd__strip {
  flex: none; margin: 0; padding: 7px 14px; font-size: 12px;
  background: #f6f8fa; border-bottom: 1px solid var(--line-2, #dbe3e8); color: #4a5b66;
}

.pd__review { flex: none; border-bottom: 1px solid #edd9a8; background: #fdf8ea; }
.pd__review-btn {
  width: 100%; display: flex; align-items: center; gap: 10px; padding: 8px 14px;
  border: 0; background: none; font: inherit; font-size: 12px; color: #8a5b12;
  cursor: pointer; text-align: left;
}
.pd__review-btn span { margin-left: auto; text-decoration: underline; }
.pd__review-list { margin: 0; padding: 0 14px 10px 30px; font-size: 12px; color: #6b4c14; }
.pd__review-list li { margin-top: 4px; }
.pd__review-detail { color: #8a6a2a; word-break: break-all; }
.pd__code { margin-left: 6px; color: #a08a5c; font-size: 11px; }

.pd__body { flex: 1 1 auto; min-height: 0; display: grid; grid-template-columns: 62% 38%; }
.pd__stage { position: relative; min-width: 0; background: #f2f6f9; overflow: hidden; }
.pd__canvas { display: block; width: 100%; height: 100%; touch-action: none; }

.pd__tools {
  position: absolute; left: 10px; top: 10px; display: flex; align-items: center; gap: 8px;
  padding: 6px 8px; border-radius: 10px; background: rgba(255, 255, 255, .9);
  border: 1px solid var(--line-2, #dbe3e8); font-size: 12px;
}
.pd__tools .btn { padding: 4px 9px; font-size: 12px; }
.pd__no-move { color: #6b7a85; }

.pd__markers { position: absolute; inset: 0; pointer-events: none; }
/* 28px 视觉 / 44px 命中：圆点是图层（`.pd__dot`），编号是文字层 —— 两层分开画，
   否则伪元素盖在文字上，编号在选中态就看不见了（视觉上像"没有编号"） */
.pd__marker {
  position: absolute; transform: translate(-50%, -50%);
  width: 44px; height: 44px; padding: 0; border: 0; border-radius: 50%;
  background: none; cursor: pointer; pointer-events: auto;
  display: grid; place-items: center;
  font: inherit; font-size: 11px; font-weight: 600; color: #fff;
}
.pd__dot {
  width: 28px; height: 28px; border-radius: 50%;
  background: var(--brand, #1f6fb2); border: 2px solid #fff;
  box-shadow: 0 1px 6px rgba(12, 24, 33, .35);
  transition: background .15s, transform .15s, opacity .15s;
  position: absolute;
}
.pd__num { position: relative; z-index: 1; }
.pd__marker.is-read .pd__dot { background: #fff; border-color: #7c8b96; }
.pd__marker.is-read { color: #3d4d58; }
.pd__marker.is-active .pd__dot {
  background: #14568c; box-shadow: 0 0 0 4px rgba(31, 111, 178, .28), 0 1px 6px rgba(12, 24, 33, .35);
  transform: scale(1.06);
}
.pd__marker.is-occluded .pd__dot { opacity: .38; border-style: dashed; background: #93a2ad; }
.pd__marker:hover .pd__dot { transform: scale(1.08); }
.pd__marker:focus-visible { outline: 2px solid #14568c; outline-offset: 2px; }

.pd__note {
  position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%);
  max-width: 84%; margin: 0; padding: 10px 14px; border-radius: 10px; font-size: 12px;
  background: rgba(255, 255, 255, .94); border: 1px solid var(--line-2, #dbe3e8); color: #3d4d58;
  text-align: center;
}
.pd__note--bad { background: #fff4f2; border-color: #f0b8ad; color: #9c3a22; }
.pd__note .btn { margin-left: 8px; }

.pd__pop {
  position: absolute; left: 12px; bottom: 12px; width: min(340px, 82%);
  padding: 10px 12px; border-radius: 10px; background: #fff;
  border: 1px solid #cfd8de; box-shadow: 0 10px 28px rgba(12, 24, 33, .2);
  font-size: 12px; color: #2f3d47;
}
.pd__pop-head { display: flex; align-items: center; gap: 8px; }
.pd__pop-title { flex: 1 1 auto; font-size: 13px; }
.pd__pop-body { margin: 6px 0; white-space: pre-wrap; line-height: 1.55; }
.pd__pop-meta { display: flex; align-items: center; gap: 10px; color: #5b6b76; }
.pd__read-mark { color: #2c6b3f; }

.pd__info {
  min-width: 0; overflow-y: auto; padding: 12px 14px 18px;
  border-left: 1px solid var(--line-2, #dbe3e8); background: #fff;
}
.pd__empty { margin: 4px 0 10px; font-size: 12px; color: #5b6b76; }
.pd__empty--warn { color: #8a5b12; }
.pd__sec { margin-bottom: 14px; }
.pd__sec h3 {
  display: flex; align-items: baseline; gap: 8px;
  margin: 0 0 6px; font-size: 12px; font-weight: 600; color: #16212a;
}
.pd__count { margin-left: auto; font-weight: 400; font-size: 11px; color: #5b6b76; }
.pd__text { margin: 0; font-size: 12px; line-height: 1.65; color: #3d4d58; white-space: pre-wrap; }
.pd__kv { margin: 0; font-size: 12px; }
.pd__kv dt { color: #16212a; font-weight: 600; margin-top: 6px; }
.pd__kv dd { margin: 2px 0 0; color: #3d4d58; line-height: 1.55; }
.pd__table { width: 100%; border-collapse: collapse; font-size: 12px; }
.pd__table th, .pd__table td { padding: 4px 0; border-bottom: 1px dashed #e3e9ee; text-align: left; vertical-align: top; }
.pd__table th { width: 42%; font-weight: 500; color: #5b6b76; }
.pd__table td { color: #2f3d47; }
.pd__unit { margin-left: 4px; color: #7c8b96; }
.pd__index { margin: 0; padding: 0; list-style: none; }
.pd__index-btn {
  width: 100%; display: flex; align-items: center; gap: 8px; padding: 5px 6px;
  border: 0; border-radius: 6px; background: none; font: inherit; font-size: 12px;
  color: #2f3d47; cursor: pointer; text-align: left;
}
.pd__index-btn:hover { background: #f2f6f9; }
.pd__index-btn:focus-visible { outline: 2px solid #14568c; outline-offset: 1px; }
.pd__idx-n { color: #7c8b96; }
.pd__idx-t { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pd__idx-meta { flex: none; font-size: 11px; color: #7c8b96; }
.pd__index-bad {
  display: flex; align-items: center; gap: 8px; padding: 5px 6px; font-size: 12px;
  color: #8a5b12; border-left: 2px solid #edd9a8;
}
.pd__meta { margin: 10px 0 0; font-size: 11px; color: #7c8b96; }

.pd__foot {
  flex: none; display: flex; align-items: center; gap: 14px;
  padding: 8px 14px; border-top: 1px solid var(--line-2, #dbe3e8);
  background: #fbfdfe; font-size: 12px; color: #4a5b66;
}
.pd__foot-hint { margin-left: auto; color: #7c8b96; }
.pd__live, .pd__sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }

@media (max-width: 900px) {
  .pd { width: 100vw; height: 100vh; border-radius: 0; }
  .pd__body { grid-template-columns: 1fr; grid-template-rows: 48% 52%; }
  .pd__info { border-left: 0; border-top: 1px solid var(--line-2, #dbe3e8); }
  .pd__pop { left: 8px; right: 8px; bottom: 8px; width: auto; }
}
</style>
