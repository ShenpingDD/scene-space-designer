<script setup>
/**
 * Inspector —— 右栏「画布编辑区」：六块卡片（设计决策记录 §六）
 *
 * 固定顺序：空间体检 → 空间尺寸 → 房间 → 内墙 → 外观 → 选中。
 * 每块都装进 `RailFold`（可折叠、开合状态本机记住），整栏自己滚（style.css 的 `.rail--right`）。
 *
 * 这里体现 R1 的一条教训（FIX-02）：**状态是随时可查的派生量，不是"渲染时顺手改的 DOM"**。
 * 原型的读数冻结，根因就是它把"改文字"和"改状态"绑在一次 render 里，提前 return 就再也不更新。
 * 现在 `status` / `issues` 都是 computed，状态一变必然一致 —— 不可能冻结。
 *
 * 「选中」一块内部按选中对象分设备 / 门洞 / 墙体三支；没选中时给一句引导，不留空。
 * 折叠「选中」只收参数，**不动选中状态本身**（设计决策记录 §六.6-3）。
 */
import { computed, nextTick, ref, watch } from 'vue';
import { cfg } from '@core/params.js';
import { designer as d } from '../designer.js';
import { canOpen, doorButtonLabel, doorStateText, reasonText } from '../kernel.js';
import { fmtArea, fmtLen } from '../fmt.js';
import { WALL_STYLES, WALL_STYLE_KEYS } from '@core/wallstyle.js';
import { wallSeg } from '@core/wall.js';
import RailFold from './RailFold.vue';
import RoomList from './RoomList.vue';
import RoomSizeCard from './RoomSizeCard.vue';
import InteriorWallCard from './InteriorWallCard.vue';

const wallEdit = ref({ index: -1, x: 0, z: 0, ex: 0, ez: 0 });

watch(
  () => d.selectedWall.value,
  (index) => {
    const w = d.layout.value.walls[index];
    if (!w) { wallEdit.value.index = -1; return; }
    const [x, z, ex, ez] = wallSeg(w);
    wallEdit.value = { index, x, z, ex, ez };
  },
  { immediate: true },
);

/** 选中的门洞（实际值 + 策略提示，都是内核算的，界面只显示） */
const openInfo = computed(() => d.selectedOpeningInfo.value);
/** 选中的是门洞还是窗（W2）：面板上的范围与文案跟着它走 —— 数仍然只有内核一处 */
const openWin = computed(() => !!openInfo.value && openInfo.value.opening?.kind === 'window');
/** 「恢复默认尺寸」要写回的尺寸 —— 门/窗各一套。写成一个 computed 而不是塞进模板里的三元：
 *  模板里跨行的 `@click` 会留下落单的半角引号，`check-quotes.py` 会把它当错（界面没错、检查器误报）。 */
const defaultSize = computed(() => (openWin.value
  ? { w: cfg.window.defaultWidthM, h: cfg.window.defaultHeightM, sill: cfg.window.defaultSillM }
  : { w: cfg.opening.defaultWidthM, h: cfg.opening.defaultHeightM }));

const doorAmount = computed(() => d.selected.value?.doorAmount ?? 0);
const doorSupported = computed(() => {
  const p = d.selectedProduct.value;
  if (!p) return false;
  // 只看真实铰链。绝不能用 recipeId/门型“补”一个假铰链：那会让没有门几何的
  // 模型也弹出开门按钮，点了只能转一个不存在的门。
  return canOpen({ hinges: Array.isArray(p.hinges) ? p.hinges : [] });
});

const wallLen = computed(() => {
  const e = wallEdit.value;
  return Math.hypot(e.ex - e.x, e.ez - e.z);
});
/** 选中墙的角色（来自 designer 的 role 读取，不在这里按端点猜） */
const wallRole = computed(() => d.wallRoleAt(wallEdit.value.index));
/** 选中设备的归属：房间名 / 开放场景 / 未分房间（新语义才可能出现「开放场景」） */
const selScope = computed(() => (sel.value ? d.itemScope(sel.value) : ''));

/** 改墙：直接给两端点（斜墙之后不再有"方向保持原样"这回事）；判据由内核说 */
function commitWall() {
  const e = wallEdit.value;
  const next = [Number(e.x), Number(e.z), Number(e.ex), Number(e.ez)];
  if (!next.every(Number.isFinite)) { d.toast('墙体坐标必须是数字'); return; }
  if (Math.hypot(next[2] - next[0], next[3] - next[1]) < 0.1) { d.toast('墙长至少 0.1 m'); return; }
  d.updateWall(e.index, next);
}

function mm(v) { return Math.round(v * 1000); }
const sel = computed(() => d.selected.value);
const selP = computed(() => d.selectedProduct.value);

/**
 * 规则 7：这台设备的门最多能开多少（接缝 A 的 A3 决策 —— 只提示，不阻断摆放）。
 * 文案与判级都来自内核（clearance.js），界面不自己造词，也不自己算角度。
 */
const selClear = computed(() => (sel.value ? d.clearanceById.value.get(sel.value.id) ?? null : null));

/* ---------------- 折叠态的摘要与卡头信息 ---------------- */

/** 空间体检折叠后的一句话（设计决策记录 §六.1）：无冲突项 / N 项冲突 */
const checkSummary = computed(() => (d.isClean.value ? '无冲突项' : `${d.issues.value.length} 项冲突`));

/** 外观折叠后的一句话：当前档位 */
const lookSummary = computed(() => {
  const k = d.layout.value.view?.wallOpacity ?? 'solid';
  return WALL_STYLES[k]?.label ?? '实心';
});

/** 「选中」的卡头：标题说"选中什么"，右侧说"哪一个"（合起来就是 设计决策记录 §六.6 的卡头） */
const selTitle = computed(() => {
  if (sel.value && selP.value) return '选中设备';
  if (openInfo.value) return openWin.value ? '选中窗' : '选中门洞';
  if (wallEdit.value.index >= 0) return wallRole.value === 'exterior' ? '选中外墙' : '选中内墙';
  return '选中';
});
const selHead = computed(() => {
  if (sel.value && selP.value) return `#${sel.value.id} · ${selP.value.model}`;
  if (openInfo.value) return `墙 #${openInfo.value.wallIndex} · 第 ${openInfo.value.index + 1} 个`;
  if (wallEdit.value.index >= 0) return `#${wallEdit.value.index} · ${fmtLen(wallLen.value)} m · ${wallRole.value === 'exterior' ? '外墙' : '内墙'}`;
  return '';
});

/**
 * 选中对象时把右栏滚到「选中」这一块（设计决策记录 §六.6-1：顺序不变，让手不用找）。
 * 用 `block: 'nearest'` 而不是 `'start'`：已经在视野里就**一点都不动** ——
 * 点一下画布上的设备，右栏不该自己跳一下（那种"帮倒忙"的滚动最烦人）。
 */
watch(
  () => [d.selectedId.value, d.selectedOpening.value, d.selectedWall.value],
  ([id, opening, wall]) => {
    if (id == null && opening == null && wall == null) return;   // 取消选中不回滚
    if (typeof document === 'undefined') return;                 // 单测/SSR 里没有 DOM
    const target = document.getElementById('rail-fold-sel');
    if (!target || typeof target.scrollIntoView !== 'function') return;
    // 等本轮渲染落地再滚：选中刚变时「选中」卡还没换成对应的参数
    nextTick(() => target.scrollIntoView({ block: 'nearest' }));
  },
);
</script>

<template>
  <aside class="rail rail--right">
    <!-- ① 空间体检（原「布局体检」改名；数据一行与冲突清单都在这一块） -->
    <RailFold id="check" title="空间体检" :summary="checkSummary">
      <div class="status">
        <span class="dot" :class="d.isClean.value ? '' : 'dot--bad'" />
        <span>{{ d.status.value }}</span>
      </div>
      <div class="kpis">
        <div class="kpi"><span>房间面积</span><b>{{ fmtArea(d.roomArea.value) }}</b> m²</div>
        <div class="kpi"><span>设备数量</span><b>{{ d.count.value }}</b> 台</div>
        <div class="kpi"><span>占地占比</span><b>{{ d.occupancy.value }}</b> %</div>
      </div>

      <!-- 房间与尺寸这一行从底栏搬来：属性名 `data-rooms-foot` 保持不动（探针按它读，设计决策记录 §十一-4） -->
      <p class="rooms-foot" data-rooms-foot>
        房间 <b>{{ d.roomCount.value }}</b> 间<template v-if="d.openArea.value > 1e-9"> · 开放 <b data-open-area>{{ fmtArea(d.openArea.value) }}</b> m²</template> · {{ fmtLen(d.layout.value.w) }} × {{ fmtLen(d.layout.value.d) }} × {{ fmtLen(d.layout.value.h) }} m
      </p>

      <ul v-if="d.issues.value.length" class="issue-list">
        <li v-for="x in d.issues.value" :key="x.item.id">
          <!-- 点编号：选中那台设备 —— 选中之后右栏自动滚到「选中」那一块（见上面的 watch） -->
          <button class="btn btn--icon" :data-issue-item="x.item.id" @click="d.focusItem(x.item.id)">#{{ x.item.id }}</button>
          <span>{{ reasonText(x.reason) }}</span>
          <button class="btn btn--icon btn--danger" @click="d.remove(x.item.id)">移除</button>
        </li>
      </ul>
      <p v-else class="hint">没有冲突项：无重叠、无碰墙、无越界。</p>

      <template v-if="d.doorTrouble.value.length">
        <div class="sub-head">
          柜门能不能用<span class="hint">（不影响摆放合法性，但影响能不能用）</span>
        </div>
        <ul class="issue-list">
          <li v-for="x in d.doorTrouble.value" :key="`c${x.id}`">
            <button class="btn btn--icon" :data-issue-item="x.id" @click="d.focusItem(x.id)">#{{ x.id }}</button>
            <span :class="`txt-${x.level}`">{{ x.text }}</span>
          </li>
        </ul>
      </template>
      <p v-else-if="d.count.value" class="hint">所有柜门都能开到底。</p>
    </RailFold>

    <!-- ② 空间尺寸（原左栏第一张） -->
    <RoomSizeCard />

    <!-- ③ 房间（原右栏最上） -->
    <RoomList />

    <!-- ④ 内墙（原左栏第三张） -->
    <InteriorWallCard />

    <!-- ⑤ 外观：常驻（不再只在没选中时出现），三档按钮与文案照旧 -->
    <RailFold id="look" title="外观" :summary="lookSummary">
      <p class="hint">墙体的显示方式（<b>平面图与三维一起变</b>；交付图仍按实心画 —— 纸上没有"透过去"这回事。这一项<b>存进方案</b>，所以同一次交付谁点导出都长一样）。</p>
      <div class="row row--3">
        <button
          v-for="k in WALL_STYLE_KEYS" :key="k" class="btn"
          :class="{ 'btn--primary': (d.layout.value.view?.wallOpacity ?? 'solid') === k }"
          :aria-pressed="(d.layout.value.view?.wallOpacity ?? 'solid') === k"
          @click="d.setWallStyle(k)"
        >{{ WALL_STYLES[k].label }}</button>
      </div>
    </RailFold>

    <!-- ⑥ 选中：位置固定，内部三分支；没选中时给引导 -->
    <RailFold id="sel" :title="selTitle">
      <template #head>
        <span v-if="selHead" class="hint sel-head">{{ selHead }}</span>
      </template>

      <!-- 设备：位置 / 旋转 / 柜门开度 / 净空 / 占地 -->
      <template v-if="sel && selP">
        <div class="status">
          <span class="dot" :class="d.issues.value.some((x) => x.item.id === sel.id) ? 'dot--bad' : ''" />
          <span>{{ reasonText(d.issues.value.find((x) => x.item.id === sel.id)?.reason) }}</span>
        </div>

        <div class="dim-readout" data-item-scope>
          <span>所属</span><b>{{ selScope }}</b>
        </div>

        <div class="row">
          <div class="field"><label>位置 X / m</label>
            <input :value="fmtLen(sel.x)" type="number" step="0.001" @change="d.setPosition(sel.id, +$event.target.value, sel.z)">
          </div>
          <div class="field"><label>位置 Z / m</label>
            <input :value="fmtLen(sel.z)" type="number" step="0.001" @change="d.setPosition(sel.id, sel.x, +$event.target.value)">
          </div>
        </div>

        <div class="field">
          <label>旋转 / °（{{ cfg.space.rotateStepDeg }}° 一档）</label>
          <div class="row row--3">
            <input :value="sel.r" type="number" step="5" @change="d.rotate(sel.id, +$event.target.value)">
            <button class="btn btn--icon" @click="d.rotateBy(sel.id, -cfg.space.rotateStepDeg)">◀</button>
            <button class="btn btn--icon" @click="d.rotateBy(sel.id, cfg.space.rotateStepDeg)">▶</button>
          </div>
        </div>

        <div v-if="doorSupported" class="field" data-inspector-door>
          <label>柜门开度 · {{ doorStateText(doorAmount) }}</label>
          <input
            :value="doorAmount" type="range" min="0" max="1" step="0.01"
            :disabled="!doorSupported"
            @input="d.setDoor(sel.id, +$event.target.value)"
          >
          <div class="row">
            <button class="btn" :disabled="!doorSupported" @click="d.setDoor(sel.id, doorAmount > 0 ? 0 : 1)">
              {{ doorButtonLabel(selP.doorPart, doorAmount) }}
            </button>
            <button class="btn" :disabled="!doorSupported" @click="d.setDoor(sel.id, 0.5)">半开</button>
          </div>
          <p class="hint">平面图上的扇形即开门扫掠区 —— 开门会占地方，摆位时要留出。</p>
        </div>
        <div v-else class="field" data-inspector-no-door>
          <label>柜门</label>
          <p class="hint">无可动门 / 未提供门几何；这个模型不显示开门按钮。</p>
        </div>

        <div v-if="selClear && selClear.freeDeg !== null" class="clearance" :class="`lv-${selClear.level}`">
          <div class="clearance-head">
            <i class="dot" />
            <b>{{ selClear.text }}</b>
          </div>
          <p v-if="selClear.hint" class="hint">{{ selClear.hint }}</p>
          <p v-if="selClear.skipText" class="hint" data-clearance-partial>{{ selClear.skipText }}</p>
        </div>
        <div v-else-if="selClear && selClear.skipText" class="clearance lv-na" data-clearance-skipped>
          <div class="clearance-head">
            <i class="dot" />
            <b>{{ selClear.skipText }}</b>
          </div>
          <p class="hint">不会用 0° 或估算值代替；需要先补门铰链/门板数据。</p>
        </div>

        <div class="dim-readout">
          <span>占地</span><b>{{ mm(selP.w) }} × {{ mm(selP.d) }} mm</b>
        </div>

        <button class="btn btn--block btn--danger" @click="d.remove(sel.id)">移除这台设备</button>
      </template>

      <!-- 洞口（W1 门洞 / W2 窗）：净宽/净高（窗还有离地）可改，都过内核夹取；方向键沿墙平移，Delete 删除。
           默认值来自参数表（不是写死的 0.9）——“恢复默认”按的就是当前参数值。 -->
      <template v-else-if="openInfo">
        <div class="row">
          <div class="field"><label>净宽 / m</label>
            <input
              :value="openInfo.opening.w" type="number" step="0.05"
              :min="openWin ? cfg.window.minWidthM : cfg.opening.minWidthM"
              :max="openWin ? cfg.window.maxWidthM : cfg.opening.maxWidthM"
              @change="d.updateOpening({ w: +$event.target.value })"
            >
          </div>
          <div class="field"><label>净高 / m</label>
            <input
              :value="openInfo.opening.h" type="number" step="0.05"
              :max="d.layout.value.h - (openWin ? openInfo.opening.sill : 0)"
              @change="d.updateOpening({ h: +$event.target.value })"
            >
          </div>
        </div>
        <!-- 离地高度（W2）：窗比门多出来的那**一个**数 —— 从地面量到洞口下沿（不是中心、不是上沿） -->
        <div v-if="openWin" class="field"><label>离地高度 / m（地面 → 洞口下沿）</label>
          <input
            :value="openInfo.opening.sill" type="number" step="0.05"
            :min="cfg.window.minSillM" :max="cfg.window.maxSillM"
            @change="d.updateOpening({ sill: +$event.target.value })"
          >
        </div>
        <div class="dim-readout">
          <span>沿墙位置</span><b>{{ fmtLen(openInfo.opening.at) }} m</b>
        </div>
        <p v-if="openInfo.bad" class="hint txt-bad">{{ openInfo.bad.message }}</p>
        <ul v-if="openInfo.warnings.length" class="issue-list">
          <li v-for="w in openInfo.warnings" :key="w.reason"><span class="txt-warn">{{ w.message }}</span></li>
        </ul>
        <button class="btn btn--block" @click="d.updateOpening(defaultSize)">
          恢复默认尺寸（{{ openWin
            ? `${cfg.window.defaultWidthM} × ${cfg.window.defaultHeightM} m · 离地 ${cfg.window.defaultSillM} m`
            : `${cfg.opening.defaultWidthM} × ${cfg.opening.defaultHeightM} m` }}）
        </button>
        <button class="btn btn--block btn--danger" @click="d.removeOpening()">删除这个{{ openWin ? '窗' : '门洞' }}</button>
        <p v-if="openWin" class="hint">窗是<b>墙上的矩形洞口 + 离地高度</b>：底边以下那截墙是<b>实心</b>的，所以<b>漫游里走不过去</b>（它不会把两间房并成一间）。离地高度低于 0.9 m 时按 GB 50096-2011 应有防护设施 —— 本工具只报数、不做合规判定。方向键沿墙平移 0.1 m。</p>
        <p v-else class="hint">门洞是<b>墙上的缺口</b>（不是设备柜门）：它在漫游里是能走过的位置，两面墙的交点/房间闭合判定都不看它。方向键沿墙平移 0.1 m。</p>
      </template>

      <!-- 墙体：两端点直接写坐标（斜墙也支持），长度只读 -->
      <template v-else-if="wallEdit.index >= 0">
        <div class="row row--3">
          <div class="field"><label>起点 X</label><input v-model.number="wallEdit.x" type="number" step="0.001"></div>
          <div class="field"><label>起点 Z</label><input v-model.number="wallEdit.z" type="number" step="0.001"></div>
          <div class="field"><label>终点 X</label><input v-model.number="wallEdit.ex" type="number" step="0.001"></div>
          <div class="field"><label>终点 Z</label><input v-model.number="wallEdit.ez" type="number" step="0.001"></div>
        </div>
        <div class="field" data-wall-role-switch>
          <label>类型（一步切换，可撤销）</label>
          <div class="row">
            <button
              class="btn"
              :class="{ 'btn--primary': wallRole === 'exterior' }"
              :aria-pressed="wallRole === 'exterior'"
              data-wall-role="exterior"
              @click="d.setWallRole(wallEdit.index, 'exterior')"
            >外墙</button>
            <button
              class="btn"
              :class="{ 'btn--primary': wallRole === 'interior' }"
              :aria-pressed="wallRole === 'interior'"
              data-wall-role="interior"
              @click="d.setWallRole(wallEdit.index, 'interior')"
            >内墙</button>
          </div>
          <p class="hint">只有贴当前场景边缘的墙能设为外墙；中间的墙设外墙会被拒绝（避免「显示外墙、实际挡不住设备」）。</p>
        </div>
        <button class="btn btn--primary btn--block" @click="commitWall">更新墙体</button>
        <button class="btn btn--block btn--danger" @click="d.removeWall(wallEdit.index)">移除这面墙</button>
        <p class="hint">长度 <b>{{ fmtLen(wallLen) }} m</b>（只读）· 方向 {{ (((Math.atan2(wallEdit.ez - wallEdit.z, wallEdit.ex - wallEdit.x) * 180 / Math.PI) + 360) % 360).toFixed(1) }}° —— 斜墙也支持，两端点直接写坐标。</p>
      </template>

      <!-- 没选中：给一句引导，不留空 -->
      <template v-else>
        <p class="hint">在画布上点一台设备、一个门洞或一面墙，这里就换成它的参数。</p>
        <p class="hint">按 <b>Q/E</b> 旋转 5°，方向键微调 0.1 m，<b>Delete</b> 删除选中对象。</p>
      </template>
    </RailFold>
  </aside>
</template>

<style scoped>
/* 右栏这一列自己的滚动与间距（设计决策记录 §六.7）：整栏纵向滚，卡片之间 12 px。
   写在这里而不是全局：右栏的版式只归右栏一个文件说，谁也不去动 style.css。 */
.rail--right {
  overflow-y: auto;
  gap: 12px;
}

/* 空间体检里的「房间 N 间 · W × D × H m」（原底栏那一行，探针按 data-rooms-foot 读） */
.rooms-foot {
  margin: 0;
  font-family: var(--mono);
  font-size: 12px;
  color: var(--ink-2);
}

/* 「选中」卡头右侧的那一句：型号可能很长（DEMO-FZ-25C），
   在 300 px 的右栏里必须省略号收尾，否则会把折叠按钮挤出卡头 */
.sel-head {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.dim-readout { display: flex; justify-content: space-between; font-size: 12px; color: var(--ink-3); }
.dim-readout b { font-family: var(--mono); color: var(--ink); }
</style>
