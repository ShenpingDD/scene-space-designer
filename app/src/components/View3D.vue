<script setup>
/**
 * View3D.vue —— 三维视图 + 第一人称漫游
 *
 * 与别的组件一样：**这里零业务判断**。位置/角度/开度都来自 layout，合法性由内核判过。
 * 组件只做三件事：挂画布、转发用户操作、把体检结果如实显示出来。
 *
 * 两个刻意的选择：
 *   ① 按需渲染（不是每帧循环）—— 后台标签页不烧 GPU，本环境 rAF 暂停也照样能出帧。
 *   ② 资产缺失时**给出可执行的下一步**（把那行命令打在界面上），不是转圈或白屏。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { designer as d } from '../designer.js';
import { view3d } from '../scene3d.js';
import { setWalking } from '../walkMode.js';

const cv = ref(null);
const host = ref(null);
const view = ref('orbit');
const level = ref('auto');
const info = ref(null);
const fatal = ref('');
/**
 * 动线（P3）：「站到 A 点」只对**能走通**的路线开放（失效路线不画假线，也不给假起点）。
 * 选中哪条只影响高亮；默认第一条有效的 —— 与 2D 的图例选中互不依赖（P2 接手后再同步）。
 */
const routePick = ref('');
const validRoutes = computed(() => (info.value?.routes?.statuses ?? []).filter((r) => r.status === 'ok'));
let alive = true;
let queued = false;
/**
 * 第一人称是**连续运动**：walkMove 每步只改相机/碰撞，不经过 Vue 生命周期。
 * 所以漫游期间按 200ms 轮询 `view3d.probe()` 回灌——只读读数，不重建场景、不碰碰撞。
 * 回鸟瞰 / unmount 必须清掉；`startWalkTimer` 先 stop，反复进出不会叠加。
 */
let walkTimer = null;
const WALK_REFRESH_MS = 200;
function stopWalkTimer() {
  if (walkTimer !== null) {
    clearInterval(walkTimer);
    walkTimer = null;
  }
}
function startWalkTimer() {
  stopWalkTimer();
  walkTimer = setInterval(refresh, WALK_REFRESH_MS);
}

function refresh() {
  if (!alive) return;
  const p = view3d.probe();
  info.value = p;
  if (p.errors?.length && !fatal.value) fatal.value = p.errors[0];
}

/** 拖拽/旋钮会高频改布局，合并到一次微任务里，避免每次 pointermove 都重建场景 */
function scheduleSync() {
  if (queued) return;
  queued = true;
  Promise.resolve().then(async () => {
    queued = false;
    if (!alive) return;
    await view3d.setLayout(d.layout.value);
    refresh();
  });
}

onMounted(async () => {
  view3d.attach(cv.value);
  view3d.onSelect = (id) => { if (id == null) d.clearSelection(); else d.selectItem(id); };
  // 场景**真的搭完**时重读（缺陷 D54）：顶栏那句「正在载入模型…（n/m）」以前也只算一次，
  // 模型到位后它还挂着 —— 与面客模式是同一个毛病，同一个回调一起修。
  view3d.onSceneSettled = refresh;
  // 场景自己也会改视角（第一人称里 Esc 回鸟瞰）—— 回灌给界面，走同一条 pickView 路径
  view3d.onExitWalk = () => pickView('orbit');
  try {
    await view3d.setLayout(d.layout.value);
    view3d.setSelected(d.selectedId.value);
    view3d.setSelectedColumn(currentColumn());
    view3d.setView(view.value);
  } catch (err) {
    fatal.value = err.message;
  }
  refresh();
});

onUnmounted(() => {
  alive = false;
  stopWalkTimer();
  view3d.onSelect = () => {};
  view3d.onExitWalk = null;
  view3d.onSceneSettled = null;
  view3d.dispose();
  // ⚠️ 一定要收尾：不然切回平面图后顶栏永远 `inert`（点不动、Tab 也进不去）——
  //    “漫游中”是一个**会残留的状态**，凡残留都要有明确的收尾点。
  setWalking(false);
});

watch(() => d.layout.value, scheduleSync, { deep: true });
watch(() => d.selectedId.value, (id) => { view3d.setSelected(id); refresh(); });

/**
 * 柱的选中通道（P4·设计决策记录 §三.3 / §五.8）：**3D 不点选**，只读 2D 那份选中态
 * （与 2D 画布、「柱」卡共用一个真源 `d.selectedColumn`），驱动 3D 高亮 0/1。
 * 两边还没接上时它可能是 `undefined` —— 当"没选中"处理，不报错、不猜。
 */
function currentColumn() {
  const v = d.selectedColumn;
  return v && typeof v === 'object' && 'value' in v ? v.value : (v ?? null);
}
watch(currentColumn, (id) => { view3d.setSelectedColumn(id); refresh(); });

/**
 * 相机聚焦请求（3D 那一半）：听的是**同一个** `d.focusWish`（2D/3D 各管各的数学）。
 * 「走进去」也走这条：先指明站位（`wantSpawn`），再切第一人称 —— 两者必须走同一条路，
 * 否则"点走进去"和"点第一人称"会站到两个地方。
 */
watch(() => d.focusWish.value, (wish) => {
  if (!wish) return;
  // item 级聚焦是 2D 画布的事（设备没有 3D 相机目标）；别让 3D 顺手 frameAll 改掉用户视角。
  if (wish.kind === 'item') return;
  const room = wish.id ? d.roomById.value.get(wish.id) : null;
  if (room) view3d.focusRoom(room.poly);
  else view3d.frameAll();
  if (wish.walk && room) {
    view3d.wantSpawn(room.labelAt[0], room.labelAt[1]);
    pickView('walk');
    d.toast(`已走进「${room.displayName}」（Esc 回鸟瞰）`);
  }
  refresh();
});
// ⭐ 漫游状态要**说出去**：`App` 靠它决定快捷键让不让路（FIX-15 那张老账，
//    重核时发现新界面把它原样复现了 —— 漫游里按 Ctrl+Z 照样改动画布）。
watch(view, (v) => {
  setWalking(v === 'walk');
  if (v === 'walk') startWalkTimer();
  else stopWalkTimer();
}, { immediate: true });

async function pickView(v) {
  // 0 间房 = 开放场景：`scene3d` 已把人放到场景中心；这里把「站在哪」说出来，
  // 否则用户只看到画面一变，不知道自己在场地中央（设计决策记录 / §11 E23）。
  if (v === 'walk' && d.roomCount.value === 0) d.toast('已在场景中央开始漫游（Esc 回鸟瞰）');
  view.value = v;
  view3d.setView(v);
  refresh();
}
async function pickLevel(l) {
  level.value = l;
  await view3d.setLevel(l);
  refresh();
}
function reframe() { view3d.frameAll(); refresh(); }

/**
 * 「站到 A 点」：可选起点，不是导航。
 * 复用 `wantSpawn`（与「走进去」同一条路）只把相机放到 A、朝向 B；**不自动沿线走、不锁定方向**。
 */
function standAtA() {
  const pose = view3d.standAtRoute(routePick.value);
  if (!pose?.ok) {
    d.toast('这条动线当前走不通（墙/门/设备挡住了），先修布局再站到 A 点');
    return;
  }
  pickView('walk');
  d.toast('已站到 A 点、面朝 B —— 自由走动即可，地面动线只是引导（Esc 回鸟瞰）');
}

// 读数变化后，把「站到 A 点」的默认路线收拢到第一条有效路线
watch(validRoutes, (list) => {
  if (!list.some((r) => String(r.id) === String(routePick.value))) routePick.value = list[0]?.id ?? '';
}, { immediate: true });

const kTri = (n) => (n >= 1000 ? `${(n / 1000).toFixed(0)}k` : String(n ?? 0));
const srcReady = () => info.value?.scene?.meshes === d.count.value && d.count.value > 0;

/** 底栏统计：完整文案同时进 `title`，窄屏省略号只影响视觉，不影响可读性 */
const meterText = computed(() => {
  const p = info.value;
  if (!p?.render) return '';
  return `${d.count.value} 台 · 模型 ${kTri(p.scene?.totalTriangles)} 面 · 本帧 ${kTri(p.render.triangles)} 面 · ${p.render.calls} 次绘制 · ${p.render.textures} 贴图`;
});
/** 底栏提示：鸟瞰/第一人称两套口径；stuck 警告并入同一条，不再单独占块 */
const hintTitle = computed(() => {
  if (view.value !== 'walk') {
    return '鸟瞰 · 左键拖动旋转 · 右键拖动平移 · 滚轮缩放 · 双击设备聚焦';
  }
  const stuck = info.value?.camera?.stuck
    ? '⚠️ 你正站在设备或墙体里面：碰撞已临时关闭，走开一点就会恢复 · '
    : '';
  const yaw = info.value?.camera?.yawDeg ?? 0;
  const eye = info.value?.camera?.pos?.[1] ?? 1.6;
  return `${stuck}W A S D / ↑←↓→ 走动 · Shift 快走 · Esc 解锁鼠标（没锁定时再按一次 = 回鸟瞰）· 视角 ${yaw}° / 眼高 ${eye} m`;
});
</script>

<template>
  <div ref="host" class="v3d">
    <canvas ref="cv" class="v3d__canvas" />

    <div class="v3d__bar">
      <div class="seg" role="group" aria-label="视角">
        <button :aria-pressed="view === 'orbit'" @click="pickView('orbit')">鸟瞰</button>
        <button :aria-pressed="view === 'walk'" @click="pickView('walk')">第一人称</button>
      </div>
      <label class="v3d__lod">
        <span>细节</span>
        <select :value="level" @change="pickLevel($event.target.value)">
          <option value="auto">自动（按台数）</option>
          <option value="lod0">lod0 · 近景</option>
          <option value="lod1">lod1 · 常规</option>
          <option value="lod2">lod2 · 远景</option>
        </select>
      </label>
      <button class="btn btn--ghost" @click="reframe()">重新取景</button>
      <!-- 动线（P3）：只读展示 + 可选「站到 A 点」；没有有效路线时这两个控件不出现 -->
      <template v-if="validRoutes.length">
        <label class="v3d__route">
          <span>动线</span>
          <select v-model="routePick" aria-label="选择要站到起点的动线">
            <option v-for="r in validRoutes" :key="r.id" :value="r.id">{{ r.name }}</option>
          </select>
        </label>
        <button
          class="btn btn--ghost"
          title="只把相机放到 A 点、朝向 B；不自动沿线路走、不锁定方向"
          @click="standAtA()"
        >站到 A 点</button>
      </template>
    </div>

    <div v-if="fatal" class="v3d__note v3d__note--bad">
      <b>模型资产没就绪：</b>{{ fatal }}
      <div class="mono">先确认 assets/optimized/ 下有 GLB（`npm --prefix app run assets` 会同步到 app/public/assets），再刷新页面</div>
    </div>

    <div v-else-if="!d.count.value" class="v3d__note">
      <b>空方案</b> · 从左侧型号栏放入设备即可看到三维效果（点设备可选中，拖拽旋转照旧）。
    </div>

    <div v-else-if="!srcReady()" class="v3d__note">
      <b>正在载入模型…</b>（{{ info?.scene?.meshes ?? 0 }}/{{ d.count.value }}）
    </div>

    <!-- 第一人称的"出路"。必须常驻可见：指针锁定期间鼠标被画布独占，上面那排工具按钮**点不到**，
         所以 ① Esc（scene3d 里显式处理，不指望内嵌浏览器）② 这块浮层（解锁后第一下就点得到）。 -->
    <div v-if="view === 'walk' && !fatal" class="v3d__walkbar">
      <b>第一人称</b>
      <span v-if="info?.camera?.pointerLocked" class="v3d__lock">鼠标已锁定 · 按 <span class="mono">Esc</span> 解锁</span>
      <span v-else-if="info?.camera?.pointerLockFailed" class="v3d__lock v3d__lock--bad">
        这个浏览器不给锁定鼠标 —— <b>按住左键拖动</b>也能环视
      </span>
      <span v-else class="v3d__lock">点画面锁定鼠标环视（也可以按住左键拖动）</span>
      <button class="btn btn--ghost" @click="pickView('orbit')">退出第一人称（回鸟瞰）</button>
    </div>

    <!-- 底部状态条：与 PlanView 的 `.plan-views` 同一层级/同一风格（40px）。
         提示只占一行、超出省略；完整文案进 title。统计也从顶栏搬到这里，顶栏才不会再挤。 -->
    <div class="v3d__views" role="status" aria-live="polite">
      <div
        class="v3d__hint"
        :class="{ 'v3d__hint--stuck': view === 'walk' && info?.camera?.stuck }"
        :title="hintTitle"
      >
        <template v-if="view === 'walk'">
          <span v-if="info?.camera?.stuck">⚠️ 你正站在设备或墙体里面：碰撞已临时关闭，走开一点就会恢复 · </span>
          <span class="mono">W A S D / ↑←↓→</span> 走动 · <span class="mono">Shift</span> 快走 ·
          <span class="mono">Esc</span> 解锁鼠标（没锁定时再按一次 = 回鸟瞰）·
          视角 {{ info?.camera?.yawDeg ?? 0 }}° / 眼高 {{ info?.camera?.pos?.[1] ?? 1.6 }} m
        </template>
        <template v-else>
          <b>鸟瞰</b> · 左键拖动<b>旋转</b> · <b>右键拖动平移</b> · 滚轮缩放 · <b>双击设备</b>聚焦
        </template>
      </div>
      <span v-if="info?.render" class="v3d__meter mono" :title="meterText">{{ meterText }}</span>
    </div>

    <div v-if="info?.errors?.length" class="v3d__note v3d__note--bad">
      有 {{ info.errors.length }} 款模型没能载入：<span class="mono">{{ info.errors.join('；') }}</span>
    </div>
  </div>
</template>

<style scoped>
.v3d { position: relative; width: 100%; height: 100%; background: #eef2f5; overflow: hidden; }
.v3d__canvas { display: block; width: 100%; height: 100%; }
.v3d__walkbar {
  position: absolute; left: 50%; transform: translateX(-50%); top: 10px;
  z-index: 3; display: flex; align-items: center; gap: 10px;
  padding: 6px 10px; border-radius: 999px; white-space: nowrap;
  background: rgba(15, 23, 42, 0.84); color: #e2e8f0; font-size: 12px;
}
.v3d__lock { color: #cbd5e1; }
.v3d__lock--bad { color: #fca5a5; }
.v3d__walkbar .btn { padding: 3px 9px; font-size: 12px; }
.v3d__bar {
  position: absolute; inset: 0 0 auto 0; display: flex; align-items: center; gap: 10px;
  flex-wrap: nowrap; white-space: nowrap; overflow-x: auto; overflow-y: hidden;
  padding: 8px 10px; background: rgba(255, 255, 255, .82); backdrop-filter: blur(6px);
  border-bottom: 1px solid #dbe3e8; font-size: 12px;
}
/* seg 是「视角」两个按钮，绝不能参与 flex 收缩：曾被统计文本挤到 2px 宽。
   所有直接子项统一 28px 高 —— 否则「同一行」肉眼成立、offsetTop 却因高度/内边距不同而不等。 */
.v3d__bar > * { flex: none; height: 28px; box-sizing: border-box; }
.seg { flex: none; }
.v3d__lod { display: inline-flex; align-items: center; gap: 6px; color: #4a5b66; }
.v3d__lod select { font: inherit; padding: 2px 4px; border: 1px solid #cfd8de; border-radius: 6px; background: #fff; }
.v3d__route { display: inline-flex; align-items: center; gap: 6px; color: #4a5b66; }
.v3d__route select { font: inherit; padding: 2px 4px; border: 1px solid #cfd8de; border-radius: 6px; background: #fff; max-width: 160px; }
.v3d__views {
  position: absolute; left: 0; right: 0; bottom: 0; z-index: 2;
  height: 40px; display: flex; align-items: center; gap: 8px;
  padding: 0 12px; background: #fbfdfe;
  border-top: 1px solid var(--line-2, #dbe3e8); font-size: 12px;
}
.v3d__hint {
  flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: #4a5b66;
}
.v3d__hint--stuck { color: var(--bad-ink, #b42318); }
.v3d__meter { flex: none; white-space: nowrap; color: #5b6b76; padding-left: 8px; }
.v3d__note {
  position: absolute; left: 50%; bottom: 54px; transform: translateX(-50%);
  max-width: 88%; padding: 8px 12px; border-radius: 8px; font-size: 12px;
  background: rgba(255, 255, 255, .92); border: 1px solid #dbe3e8; color: #3d4d58;
}
.v3d__note--bad { background: #fff4f2; border-color: #f0b8ad; color: #9c3a22; }
.v3d__note .mono { display: block; margin-top: 4px; color: #7a5b52; }
.v3d__hint .mono { font-variant-numeric: tabular-nums; }
</style>