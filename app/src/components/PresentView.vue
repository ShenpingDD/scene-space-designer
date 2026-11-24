<script setup>
/**
 * PresentView —— 面客模式（`/view/<口令>`）：**只有三维 + 一条信息条**
 *
 * 打开这一页的人**没有身份**，身份就是他手里那条链接。所以这一页只有一句话的任务：
 * **让他看清楚这份方案长什么样**，并且一句话都不骗他。
 *
 * ## 三条纪律
 *
 * ① **只读隔离（这是本页最要紧的一条）**
 *    绝不 `import { designer }` —— 那是编辑器状态（含保存 / 撤销 / 轮询），把它挂上去
 *    等于在客户面前开了一个编辑态。本页只用 `view3d` 这个三维内核
 *    （`attach / setLayout / setView / setLevel / frameView / dispose`），
 *    **不接 `onSelect`**（点设备不选中）、不画任何编辑控件。
 *    三维装配逻辑在 `scene3d.js` 里**只有一份**，两个界面各写自己的外壳 —— 不是复制实现。
 *
 * ② **客户话（`present.js`）** —— 每一句都要能被客户执行（能做什么、找谁）。
 *    绝不出现 `cd tools/models && npm run extract` 这种给工程师的下一步。
 *
 * ③ **彻底只有 3D**（用户拍板，`docs/55` §12.4）：不做 ⓘ 抽屉；**2D 平面图 / 设备清单 /
 *    服务端当时的结论都不进这一页** —— 2D 是设计者画墙摆设备的视角，清单与结论也不是
 *    「看一份方案」该看的东西。
 *
 * ## 平板/手机（批 C）
 *
 * · **触摸屏第一人称 = 左下虚拟摇杆走动 + 拖动画面转头**（两种输入严格分流，见内核）；
 * · 触摸目标 ≥44 px 那条规矩挂在 **`@media (pointer: coarse)`** 上，**不是按宽度猜** ——
 *   1280 宽的触摸笔记本一样是手指在点；
 * · 手机竖屏（≤480）信息条分两行（88 px），下面各块重新排（实测两两不重叠，见真机探针）。
 *
 * ## 离开时必须 `dispose()`
 * 里面会 `forceContextLoss()`（B18）：WebGL 上下文是有限资源，平板来回切页面超了，
 * 浏览器会偷偷丢掉最早那个（画面变黑、还不报错）。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { api } from '../api.js';
import { view3d } from '../scene3d.js';
import { setWalking } from '../walkMode.js';
import { SHOT_VIEWS } from '../views3d.js';
import { importScheme, FORMAT } from '@core/scheme.js';
import { roomsOf, roomAt } from '@core/rooms.js';
import {
  barText, presentNote, viewHint, walkNote, shareErrorPage, isCoarsePointer,
  stickVector, STICK_RADIUS_PX, roomHint,
} from '../present.js';

const props = defineProps({ token: { type: String, default: '' } });

const cv = ref(null);
const host = ref(null);

const loading = ref(true);
const err = ref(null);            // {reason, message}
const data = ref(null);           // 服务端给的那份（只用来显示；不改不存）
const layout = ref(null);         // 过了内核校验的布局（三维要的就是它）
const stateBroken = ref('');      // state 读不动时**如实说**，不拿空白画布蒙过去

const view = ref('orbit');
const level = ref('auto');
const info = ref(null);
const sceneNote = ref(null);
const walkStuck = ref(false);
const fullscreen = ref(false);
const fullNote = ref('');
const coarse = ref(false);

/** 摇杆：`{fwd, right}` = 正在推的方向（没推 = null）—— 驱动由下面那个 rAF 循环做 */
const stick = ref(null);
/** 摇杆手柄的**视觉**位置（px，相对中心）—— 跟手，夹在圈内 */
const knob = ref({ x: 0, y: 0 });

let alive = true;
let stickId = null;       // 正在推这根杆的那根手指（多指时不许串）
let stickRect = null;
let rafId = 0;
let lastT = 0;

/**
 * 房间（M1）：面客页**不放缩略图**（`docs/60` §3.5：客户侧每多一排小图就多一层噪声）——
 * 客户侧切房间用「**点房间聚焦**」+「**在房里走**」。房间同样是**派生**的，
 * 这一页只读它、不听任何编辑动作（只读隔离）。
 */
const roomList = computed(() => (layout.value ? roomsOf(layout.value) : []));
const focusRoomId = ref('');
const focusRoomInfo = computed(() => roomList.value.find((r) => r.id === focusRoomId.value) ?? null);
const roomFocusHint = computed(() => roomHint(roomList.value.length, { coarse: coarse.value, focused: focusRoomInfo.value?.displayName ?? '' }));

const bar = computed(() => barText({
  name: data.value?.name,
  count: layout.value?.items?.length,
  roomCount: roomList.value.length,
  focusedRoom: focusRoomInfo.value?.displayName ?? '',
}));

/** 点击画布上的某间房 → 相机聚焦到它（**1 步**：点一下就够了） */
let clickAt = null;
function onFloorDown(evt) { clickAt = { x: evt.clientX, y: evt.clientY }; }
function onFloorUp(evt) {
  const at = clickAt;
  clickAt = null;
  if (!at || view.value !== 'orbit') return;
  // 拖动过就不是"点击"（旋转视角不该顺手把相机挪走）
  if (Math.hypot(evt.clientX - at.x, evt.clientY - at.y) > 4) return;
  const hit = view3d.pickFloor(evt.clientX, evt.clientY);
  if (!hit) return;
  const room = roomAt(layout.value, hit[0], hit[1]);
  if (!room) return;
  focusRoomId.value = room.id;
  view3d.focusRoom(room.poly);
  refresh();
}
/**
 * 链接不能用时怎么呈现（`present.js` 的纯函数说了算）：
 *   · 撤销 / 过期 → **全屏一句话**（`bare`：没有信息条、没有画布、没有小字）；
 *   · 口令对不上 / 读不到 → 标题 + 一行下一步。
 */
const errPage = computed(() => (err.value ? shareErrorPage(err.value.reason) : null));
/** `bare` 那条路：整页只剩一句话，其余东西一律不挂 */
const bare = computed(() => !!errPage.value?.bare);
const hint = computed(() => viewHint(view.value, { coarse: coarse.value }));
/** 摇杆只在**第一人称 + 触摸屏**出现：桌面上键盘才是主路径，多一个圈只是干扰 */
const showStick = computed(() => view.value === 'walk' && coarse.value && !!layout.value);

/**
 * 画布上要说的话（可以同时有两件，**各说各的**）：
 *   · 走不动（`stuck`）—— 眼前这一步的事；
 *   · 模型没做好 / 没加载出来 / 空方案 / 正在载入（`present.js`）。
 * 两件都成立就都显示：把「有 2 台设备模型没加载」压成一句话丢掉，客户就少知道一件事。
 */
/**
 * 动线（P3）：三维只画**能走通**的路线（失效路线不画假线）；看不见不能等于「没有」——
 * 有失效路线就在信息条说清楚。这一页只读，不提供任何编辑/重算入口。
 */
const routeNote = computed(() => {
  const r = info.value?.routes;
  if (!r || !r.count || !r.invalid) return null;
  const bad = (r.statuses || []).filter((x) => x.status !== 'ok');
  const why = bad.slice(0, 2).map((x) => x.message || x.reason || '走不通').join('；');
  const more = bad.length > 2 ? ' 等' : '';
  return { kind: 'warn', text: `有 ${r.invalid} 条动线在当前布局下走不通（${why}${more}）—— 三维只显示能走通的部分` };
});

const notes = computed(() => {
  const out = [];
  if (view.value === 'walk') {
    const w = walkNote(walkStuck.value);
    if (w) out.push(w);
  }
  if (sceneNote.value) out.push(sceneNote.value);
  if (routeNote.value) out.push(routeNote.value);
  // 房间提示（多房间才有）：客户不知道地板能点——这句话就是告诉他这件事的那一句
  const rh = roomFocusHint.value;
  if (rh && view.value === 'orbit') out.push({ kind: 'info', text: rh });
  return out;
});

const knobStyle = computed(() => ({ transform: `translate(${knob.value.x}px, ${knob.value.y}px)` }));

/** 三维读数（模型到齐没有、哪几款没载入、这一步走不走得动）—— 客户版的话全靠它 */
function refresh() {
  if (!alive) return;
  const p = view3d.probe();
  info.value = p;
  walkStuck.value = !!p?.camera?.stuck;
  sceneNote.value = presentNote({
    items: layout.value?.items?.length ?? 0,
    meshes: p?.scene?.meshes ?? 0,
    errors: p?.errors?.length ?? 0,
    missingAssets: p?.scene?.missingAssets ?? 0,
  });
}

/**
 * 读服务端 → 过内核校验 → 建三维。
 *
 * 为什么还要过一遍 `importScheme`：库里的 state 是**规范化过**的（服务端写过一遍），
 * 但"能读出来"与"能画出来"是两件事。过一遍内核校验，读不动时能拿着**分类原因**
 * 说一句真话，而不是拿一块空白画布蒙过去。
 */
async function load() {
  loading.value = true;
  err.value = null;
  stateBroken.value = '';
  try {
    const d = await api.shareRead(props.token);
    if (!alive) return;
    data.value = d;
    const built = importScheme({ format: d.format || FORMAT, state: d.state });
    if (!built.ok) {
      // 分类原因原话转述（`scheme.js` 的 IMPORT_ERROR），不自己编一句笼统的
      stateBroken.value = built.message || '这份方案的内容读不出来。';
      return;
    }
    layout.value = built.layout;
    await view3d.attach(cv.value, { maxPixelRatio: 1.5 });
    await view3d.setLayout(built.layout);
    if (!alive) return;
    view3d.setLevel(level.value);
    view3d.setView('orbit');
    // 初始机位 = 交付包三个机位里的 **front45**（复用 `views3d.js`，不新增第二套机位定义）：
    // 客户打开第一眼应该看到"正面斜 45°"，而不是随机角度。
    view3d.frameView(SHOT_VIEWS.find((v) => v.id === 'front45'));
    refresh();
  } catch (e) {
    if (!alive) return;
    // 服务端已经把"哪一种不能用"说清了（reason + message）—— 原话转述
    err.value = {
      reason: e?.data?.reason || 'error',
      message: e?.data?.message || e?.message || '读不到这份分享',
    };
  } finally {
    if (alive) loading.value = false;
  }
}

function pickView(v) {
  view.value = v;
  if (v !== 'walk') releaseStick();      // 一边推着杆一边切走 → 必须停（不然那个循环没人关）
  // 「在房里走」：已经聚焦了某一间就站在**那一间**里（不指明就还是原来的角落）
  if (v === 'walk' && focusRoomInfo.value) {
    const at = focusRoomInfo.value.labelAt;
    view3d.wantSpawn(at[0], at[1]);
  }
  view3d.setView(v);
  refresh();
}

async function pickLevel(l) {
  level.value = l;
  await view3d.setLevel(l);
  refresh();
}

/* ───────────────────────── 虚拟摇杆（第一人称 + 触摸屏） ───────────────────────── */

/**
 * 推着杆时**按帧**把「前/右」交给内核（`walkDrive(fwd, right, dt)`）。
 *
 * 为什么在这里而不是内核里起一个定时器：内核不知道"界面现在的每一帧"，
 * 它只该被喂一个 `dt`（按帧推进的单位归界面，方向与碰撞归内核）。
 * 停下只有两条路（放手 / 切视角）—— `releaseStick()` 一处收口，不许有第三条。
 */
function driveStep(t) {
  rafId = 0;
  if (!stick.value || view.value !== 'walk' || !alive) return;
  const dt = lastT ? (t - lastT) / 1000 : 0;
  lastT = t;
  if (dt > 0) view3d.walkDrive(stick.value.fwd, stick.value.right, dt);
  rafId = requestAnimationFrame(driveStep);
}

function applyStick(evt) {
  if (!stickRect) return;
  const cx = stickRect.left + stickRect.width / 2;
  const cy = stickRect.top + stickRect.height / 2;
  // 半径取"圈的实际一半再留 8 px"：手柄不许贴着边框，手指也不用正好压着边才知道推到顶
  const radius = Math.max(16, Math.min(stickRect.width, stickRect.height) / 2 - 8);
  const v = stickVector(evt.clientX - cx, evt.clientY - cy, radius);
  const held = v.mag > 0;
  stick.value = held ? { fwd: v.fwd, right: v.right } : null;
  knob.value = { x: v.right * radius, y: -v.fwd * radius };
  if (held && !rafId) { lastT = 0; rafId = requestAnimationFrame(driveStep); }
  if (!held && rafId) { cancelAnimationFrame(rafId); rafId = 0; lastT = 0; }
}

function onStickDown(evt) {
  if (view.value !== 'walk') return;
  stickRect = evt.currentTarget.getBoundingClientRect();
  stickId = evt.pointerId;
  // ⚠️ 合成/异常环境里 `setPointerCapture` 会抛（没有"活动指针"）—— 必须吞掉异常。
  //    不吞就是 C27：这条路会被一个无关的错误整条掐掉（那时判据看着还是绿的）。
  try { evt.currentTarget.setPointerCapture?.(evt.pointerId); } catch (e) { /* 见上 */ }
  evt.preventDefault?.();
  applyStick(evt);
}

function onStickMove(evt) {
  if (stickId === null || evt.pointerId !== stickId) return;
  evt.preventDefault?.();
  applyStick(evt);
}

/** 放手 / 切视角 / 页面离开 —— 三条路都走这里，摇杆状态与那个 rAF 循环一处收口 */
function releaseStick() {
  stickId = null;
  stickRect = null;
  stick.value = null;
  knob.value = { x: 0, y: 0 };
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  lastT = 0;
}

function onStickUp(evt) {
  if (stickId === null) return;
  if (evt && evt.pointerId !== stickId) return;    // 别的指头抬起来不算
  releaseStick();
  refresh();
}

/* ─────────────────────────────── 全屏 ─────────────────────────────── */

/**
 * 全屏。iOS Safari 的 iPhone 上没有这个能力（`requestFullscreen` 不存在），
 * 那就**给一条能走的路**（加主屏幕 / F11），而不是一个点了没反应的按钮。
 */
async function toggleFullscreen() {
  const el = host.value;
  fullNote.value = '';
  try {
    if (!document.fullscreenElement) {
      if (!el?.requestFullscreen) throw new Error('no-api');
      await el.requestFullscreen();
    } else {
      await document.exitFullscreen();
    }
  } catch (e) {
    fullNote.value = '这个浏览器不给网页全屏 —— 可以按 F11，或把这一页「加到主屏幕」再打开。';
  }
}

function onFullscreenChange() {
  fullscreen.value = !!document.fullscreenElement;
  // 画布尺寸跟着变（ResizeObserver 盯着父元素，但全屏切换的那一下要主动补一帧）
  view3d.renderOnce();
}

onMounted(() => {
  coarse.value = isCoarsePointer();
  document.addEventListener('fullscreenchange', onFullscreenChange);
  /**
   * ⭐ 内核按 `Esc` 退出第一人称时会回调这里。
   *
   * 不接会怎样（批 C 前就是这样）：内核回了鸟瞰，而这一页的 `view` 还写着 `walk` ——
   * 工具条上「第一人称」还是选中的、下面的第一人称条还挂着。**界面在说假话**。
   */
  view3d.onExitWalk = () => pickView('orbit');
  /**
   * ⭐ 场景**真的搭完**时重读一次（缺陷 **D54**）。
   *
   * 只靠 `await setLayout()` 之后那一次 `refresh()` 是不够的：那一刻 GLB 还在路上，
   * 读到的是 `meshes=0` —— 于是那句「正在载入模型…（0/18）」**在开始那一刻被算出来，之后再没人改**，
   * 模型明明好了它还挂着。真机实测：模型读数 3/3，那句话 10 秒不变；点一下「鸟瞰」它才消失。
   *
   * 所以"什么时候重读"不写在界面里猜（不许定几次轮询），而是由**知道这件事的人**说了算。
   */
  view3d.onSceneSettled = refresh;
  load();
});

/**
 * ⭐ 口令变了就**重新读一遍**（真机探针拓出来的缺陷）。
 *
 * 路由名（`share`）不变、只有口令变（比如从一条链接换到另一条）时，Vue **会复用这个组件实例** ——
 * 不去看 `props.token` 的话，页面停在上一份方案上：客户拿到的是一条**别人的**内容，
 * 而且全程不报错。这是典型的"界面说假话"，必须钉住。
 *
 * 先 `dispose()`：上一份的三维上下文要还回去（B18 —— 上下文是有限资源），
 * 然后再挂新的。不清的话 `attach()` 会因为"已经挂着"直接返回，画布上留着上一份的场景。
 */
watch(() => props.token, async () => {
  releaseStick();
  view3d.dispose();
  layout.value = null;
  data.value = null;
  info.value = null;
  sceneNote.value = null;
  walkStuck.value = false;
  view.value = 'orbit';
  level.value = 'auto';
  await load();
});

// 漫游状态是**共享**的（`walkMode.js`）：设计器那边靠它让全局快捷键让路。
// 面客模式现在只有这一个消费者，但状态必须是真的 —— 假的状态只等着哪天被人当真。
watch(view, (v) => setWalking(v === 'walk'), { immediate: true });

onUnmounted(() => {
  alive = false;
  releaseStick();
  setWalking(false);
  view3d.onExitWalk = null;
  view3d.onSceneSettled = null;
  document.removeEventListener('fullscreenchange', onFullscreenChange);
  // ⚠️ 一定要收尾（B18）：`renderer.dispose()` 不会把 WebGL 上下文还给浏览器。
  //    平板反复进出这一页时，上下文是有限资源 —— 超了会被浏览器偷偷丢掉最早那个。
  view3d.dispose();
});
</script>

<template>
  <div ref="host" class="pv" :class="{ 'pv--bare': bare }">
    <canvas
      ref="cv"
      class="pv__canvas"
      :class="{ 'pv__canvas--pick': view === 'orbit' && roomList.length > 1 }"
      @pointerdown="onFloorDown"
      @pointerup="onFloorUp"
    />

    <!-- 信息条：**这是什么 / 多少台 / 只读**（三件事必须一眼看到）。
         手机竖屏会折成两行（`.pv__brk` 是那个强制换行点），高度走 `--bar-h`。 -->
    <!-- 信息条里那句"已聚焦「XX」"就在 barText 的 focusedText 里（文案由 present.js 持有） -->
    <div v-if="!bare" class="pv__bar">
      <b class="pv__name" :title="bar.name">{{ bar.name }}</b>
      <span class="pv__sep">·</span>
      <span>{{ bar.countText }}</span>
      <span class="pv__sep">·</span>
      <span class="pv__ro">{{ bar.badge }}</span>
      <!-- 已经点过某一间 → 说一声"现在看的是这一间"（客户点了半天，界面上得有回应） -->
      <template v-if="bar.focusedText">
        <span class="pv__sep">·</span>
        <span data-room-focus>{{ bar.focusedText }}</span>
      </template>
      <span class="pv__brk" />
      <span class="pv__spacer" />
      <div class="seg" role="group" aria-label="视角">
        <button :aria-pressed="view === 'orbit'" :disabled="!layout" @click="pickView('orbit')">鸟瞰</button>
        <button :aria-pressed="view === 'walk'" :disabled="!layout" @click="pickView('walk')">第一人称</button>
      </div>
      <button class="btn btn--ghost pv__full" :aria-pressed="fullscreen" @click="toggleFullscreen()">
        {{ fullscreen ? '退出全屏' : '全屏' }}
      </button>
    </div>

    <!-- 只读这件事**保留在信息条上**（那个「只读」小标签），但**不再写成一整段说明**：
         2026-10-08 用户拍板去掉（原话："感觉不需要…可以去掉"）。
         那段里的"看到的是当前内容"挪到了**发链接的人**那一侧（`share.js` 的 `SEE_CURRENT_TEXT`）——
         该知道这事的是发链接的人，客户不必每次看一遍。 -->

    <!-- 操作提示：两种视角 × 两种输入（触摸屏上走动靠摇杆，话必须跟着变） -->
    <div v-if="layout && !bare" class="pv__hint">{{ hint }}</div>
    <div v-if="fullNote && !bare" class="pv__fullnote">{{ fullNote }}</div>

    <!-- 画布上该说的事（走不动 / 模型没做好 / 没加载出来 / 空方案 / 正在载入）—— 客户话 -->
    <div v-if="notes.length && !bare" class="pv__notes">
      <div v-for="(n, i) in notes" :key="i" class="pv__note" :class="{ 'pv__note--bad': n.kind === 'bad', 'pv__note--warn': n.kind === 'warn' }">
        {{ n.text }}
      </div>
    </div>

    <!-- 第一人称的"出路"：指针锁定期间工具条点不到，所以这块浮层必须常驻可点 -->
    <div v-if="view === 'walk' && !bare" class="pv__walkbar">
      <b>第一人称</b>
      <button class="btn btn--ghost" @click="pickView('orbit')">退出第一人称（回鸟瞰）</button>
    </div>

    <!-- 虚拟摇杆（**只在第一人称 + 触摸屏**）：推住不放才走，放手立刻停 -->
    <div
      v-if="showStick"
      class="pv__stick"
      data-stick="1"
      role="group"
      aria-label="走动摇杆：手指按住并朝要走的方向推"
      @pointerdown="onStickDown"
      @pointermove="onStickMove"
      @pointerup="onStickUp"
      @pointercancel="onStickUp"
      @lostpointercapture="onStickUp"
    >
      <span class="pv__stick-ring" />
      <span class="pv__stick-knob" :style="knobStyle" />
    </div>

    <!-- 撤销 / 过期：**全屏一句话**（用户 2026-10-08 拍板）——
         没有信息条、没有画布、没有小字说明：这两件事没什么可操作的，多说一句都是噪声。 -->
    <div v-if="bare" class="pv__bare" role="status">{{ errPage.title }}</div>

    <!-- 其它读不到 / 读不动：标题 + 一行下一步（口令对不上、读不到） -->
    <div v-else-if="err || stateBroken || loading || !token" class="pv__veil">
      <div class="pv__card">
        <p v-if="!token" class="pv__card-title">这个地址里没有口令片段</p>
        <p v-else-if="loading" class="pv__card-title">正在读取…</p>
        <template v-else-if="err">
          <p class="pv__card-title pv__card-title--bad">{{ errPage.title }}</p>
          <p v-if="errPage.showDetail" class="pv__card-msg">{{ err.message }}</p>
          <p v-for="(t, i) in errPage.lines" :key="i" class="pv__card-next">{{ t }}</p>
        </template>
        <template v-else>
          <p class="pv__card-title pv__card-title--bad">这份方案的内容读不出来</p>
          <p class="pv__card-msg">{{ stateBroken }}</p>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 只有 CSS 变量，不写死颜色（这是全项目唯一一套配色来源）。
   ⚠️ 单位说明：`100dvh` 是给手机浏览器的（地址栏收起时 `100vh` 会多出一截，画面被裁）。
   `--bar-h` 是信息条高度，**一处定义**（手指 60 / 手机竖屏 108），遮罩用同一个变量。 */
.pv {
  position: relative; width: 100vw; height: 100vh; height: 100dvh;
  background: var(--bg); overflow: hidden; --bar-h: 44px;
}
.pv__canvas { display: block; width: 100%; height: 100%; }

.pv__bar {
  position: absolute; inset: 0 0 auto 0; height: var(--bar-h);
  display: flex; align-items: center; gap: 8px; padding: 0 10px;
  background: rgb(255 255 255 / 88%); backdrop-filter: blur(6px);
  border-bottom: 1px solid var(--line); font-size: 13px; color: var(--ink);
}
.pv__name { max-width: 42vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pv__sep { color: var(--ink-3); }
.pv__ro {
  padding: 1px 7px; border-radius: 999px; font-size: 12px;
  background: var(--brand-soft); color: var(--brand-dark); border: 1px solid var(--line);
}
.pv__spacer { flex: 1; }
.pv__full { padding: 4px 10px; }
/* 手机竖屏那个强制换行点（平时不占位） */
.pv__brk { display: none; }

.pv--bare .pv__canvas { display: none; }
/* 撤销 / 过期：整页只剩中间一句话（用户要的就是这个观感：干净、没有别的可点） */
.pv__bare {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  padding: 24px; text-align: center; font-size: 17px; color: var(--ink);
  background: var(--bg);
}

.pv__hint {
  position: absolute; left: 10px; bottom: 10px; padding: 6px 10px; border-radius: 8px;
  font-size: 12px; background: var(--brand); color: #fff;
}
.pv__fullnote {
  position: absolute; right: 10px; bottom: 10px; max-width: 46vw; padding: 6px 10px;
  border-radius: 8px; font-size: 12px; background: rgb(255 255 255 / 92%);
  border: 1px solid var(--line); color: var(--warn-ink);
}
/* 多房间时地面可点（聚焦到那一间）—— 光标先说一声「这里能点」 */
.pv__canvas--pick { cursor: pointer; }

.pv__notes {
  position: absolute; left: 50%; bottom: 116px; transform: translateX(-50%);
  display: flex; flex-direction: column; gap: 4px; align-items: center;
  max-width: 88%;
}
.pv__note {
  padding: 8px 12px; border-radius: 8px; font-size: 12px;
  background: rgb(255 255 255 / 92%); border: 1px solid var(--line); color: var(--ink-2);
}
.pv__note--bad { background: var(--bad-soft); border-color: var(--bad); color: var(--bad-ink); }
/* 动线失效是「信息」不是「故障」：暖黄提示，不抢 bad 那一档 */
.pv__note--warn { background: var(--warn-soft); border-color: var(--warn); color: var(--warn-ink); }

.pv__walkbar {
  position: absolute; left: 50%; transform: translateX(-50%); top: 52px;
  display: flex; align-items: center; gap: 10px; padding: 6px 10px;
  border-radius: 999px; white-space: nowrap; font-size: 12px;
  background: rgb(22 35 44 / 84%); color: #eef2f5;
}
.pv__walkbar .btn { padding: 3px 9px; font-size: 12px; }

/* 摇杆：圈 + 手柄。`touch-action: none` 是必须的 —— 少了它浏览器会把推杆当成页面滚动/缩放 */
.pv__stick {
  position: absolute; left: 8px; bottom: calc(10px + env(safe-area-inset-bottom));
  width: 132px; height: 132px; border-radius: 50%;
  background: rgb(255 255 255 / 30%); border: 1px solid rgb(255 255 255 / 62%);
  box-shadow: 0 2px 10px rgb(0 0 0 / 18%); touch-action: none; user-select: none;
}
.pv__stick-ring {
  position: absolute; left: 50%; top: 50%; width: 104px; height: 104px; margin: -52px 0 0 -52px;
  border-radius: 50%; border: 1px dashed rgb(255 255 255 / 70%);
}
.pv__stick-knob {
  position: absolute; left: 50%; top: 50%; width: 44px; height: 44px; margin: -22px 0 0 -22px;
  border-radius: 50%; background: rgb(255 255 255 / 92%); border: 1px solid var(--line);
  box-shadow: 0 1px 6px rgb(0 0 0 / 22%);
}

.pv__veil {
  position: absolute; inset: var(--bar-h) 0 0 0; display: flex; align-items: center; justify-content: center;
  background: rgb(242 245 247 / 92%);
}
.pv__card {
  max-width: min(560px, 86vw); padding: 16px 18px; border-radius: var(--radius);
  background: var(--panel); border: 1px solid var(--line); box-shadow: var(--shadow);
}
.pv__card-title { margin: 0 0 6px; font-size: 17px; font-weight: 600; }
.pv__card-title--bad { color: var(--bad-ink); }
.pv__card-msg { margin: 0 0 8px; font-size: 13px; color: var(--ink-2); }
.pv__card-next { margin: 0; font-size: 13px; color: var(--ink-2); }

/* ─────────────────── 断点（**只加在面客模式**，不动设计器） ───────────────────
 *
 * 两条规矩，分别按**不同东西**判：
 *   ① 触摸目标 ≥44 px（WCAG 2.5.5）挂在 `(pointer: coarse)` 上 —— 手指才有这问题，
 *      1280 宽的触摸笔记本一样要 44 px。**按宽度猜是错的**；
 *   ② 布局重排（信息条折行、各浮层换位）按**宽度** —— 那才是"地方够不够"的问题。
 */
@media (max-width: 1366px) {
  .pv__bar .seg button, .pv__full { min-height: 38px; }
}

/* 手指：命中区 ≥44 px **并且**信息条要长得比按钮高 ——
   两者一样高的时候（按钮 44、条也 44）按钮就把整条"撑满"了，用户一眼就看出丑。
   所以把条长到 60（上下各 8 px 余量），按钮保持 44（手指的硬要求不改）。 */
@media (pointer: coarse) {
  .pv { --bar-h: 60px; }
  .pv__bar .seg button, .pv__full { min-height: 44px; padding: 0 12px; }
  /* ⚠️ 摇杆是**按手指**出现的（不按宽度）—— 所以"提示让开摇杆"也必须挂在这里。
     写在窄屏断点里的那一版，在 1280×800 的触摸平板上就漏了：提示正好压在摇杆上
     （真机探针 `cdp-present-tablet` 的第一人称那一屏量到重叠 130×31 px 抓出来的）。 */
  .pv__hint { left: 148px; right: 8px; bottom: calc(10px + env(safe-area-inset-bottom)); }
}

/* 手机竖屏：信息条 **108** 两行（第一行名字/台数/只读 ≈40，第二行视角+全屏 ≈56）——
   第二行比按钮（44）高，按钮不再顶满整行（用户 2026-10-08 拍板 88 → 108）。
   下面从左下角往上排：摇杆（132）→ 提示（右下）→ 第一人称条 → 状态话 → 全屏提示。
   实机量到两两不重叠（真机探针 `cdp-present-touch` 会在鸟瞰 / 第一人称两屏各量一遍）。 */
@media (max-width: 480px) {
  .pv { --bar-h: 108px; }
  .pv__bar { flex-wrap: wrap; align-content: center; row-gap: 4px; font-size: 12px; }
  .pv__brk { display: block; flex-basis: 100%; height: 0; }
  .pv__name { max-width: 30vw; }
  .pv__walkbar { top: auto; bottom: calc(178px + env(safe-area-inset-bottom)); }
  .pv__fullnote { right: 8px; bottom: calc(292px + env(safe-area-inset-bottom)); max-width: none; left: 8px; }
  .pv__notes { bottom: calc(238px + env(safe-area-inset-bottom)); max-width: calc(100vw - 16px); }
}
</style>