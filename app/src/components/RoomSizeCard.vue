<script setup>
/**
 * RoomSizeCard —— 右栏第 2 块「场景范围」（P4 改名，docs/93 §6.4；原「空间尺寸」）
 *
 * 内容从原左栏第一张**原样搬来**（见 ProductRail 的历史）：界面只负责"收数字"，
 * 合不合法、要不要重建外墙、越界墙是哪些，全部问内核（`room.planSceneSize` / `room.applyRoomSize`）——
 * 这里一条业务规则都不重算（docs/84 §五：画布渲染与规则判定不动）。
 *
 * 两条路（由**文件来源**决定，不是用户选项，读 `d.roomSemantics`）：
 *   · `walls`（新方案）：只改场景范围，**不重建任何墙**；墙/设备落在新范围外就拦下并列出序号。
 *   · `legacy`（旧方案）：沿用升级前的「重建四面外墙 + 保留范围内内墙 + 报 removed 计数」。
 * 卡头那行 `[data-size-mode]` 就是把"这次走的是哪条路"写在界面上，不让用户猜。
 * 失败时把**内核原话**留在卡里（`[data-size-blocked]`），不只靠 2.6 秒 toast；
 * 输入框回填成当前真实尺寸 —— 界面上不留一个"填了但没被采纳"的数。
 */
import { computed, reactive, ref, watch } from 'vue';
import { designer as d } from '../designer.js';
import { LIMITS } from '../kernel.js';
import { fmtLen } from '../fmt.js';
import { roundMm } from '@core/geometry.js';
import RailFold from './RailFold.vue';

const size = reactive({ w: 8, d: 6, h: 2.8 });

watch(
  () => d.layout.value,
  (l) => { size.w = l.w; size.d = l.d; size.h = l.h; },
  { immediate: true },
);

const presets = [
  { label: '8 × 6', w: 8, d: 6 },
  { label: '12 × 9', w: 12, d: 9 },
  { label: '20 × 20', w: 20, d: 20 },
];

/** 这次改尺寸走哪条路：新语义只校验、旧方案重建（两条路后果完全不同，必须写在界面上） */
const mode = computed(() => (d.roomSemantics.value === 'walls' ? 'walls' : 'legacy'));
const modeText = computed(() => (mode.value === 'walls'
  ? '改尺寸只改场景范围，不重建任何墙：墙与设备原样保留；有墙或设备落在新范围外会被拦下并列出序号。'
  : '这是旧方案（按矩形外框闭合）：改尺寸会重建四面外墙，范围内的内墙保留，超出的会被移除并报数。'));

/** 最近一次被拦下的原因（内核原话；下一次成功就清空） */
const blocked = ref('');

const limits = LIMITS.room;

/** 卡头右侧的状态行：收起来时也看得见"现在这间房多大" */
const dimsText = computed(() => fmtLen(size.w) + ' × ' + fmtLen(size.d) + ' × ' + fmtLen(size.h) + ' m');

function apply(patch = {}) {
  // 归一到**毫米**（原来是 0.1 m）：number 输入会带出 2.799999952316284 这种浮点噪声，
  // 毫米既收拾了噪声、又不丢用户真正能输入的精度（cm 级房间尺寸是常态）。
  // 而且**改了就报** —— 静默改数是这个项目最不能接受的一类 bug。
  const raw = { w: Number(size.w), d: Number(size.d), h: Number(size.h), ...patch };
  const next = { w: roundMm(raw.w), d: roundMm(raw.d), h: roundMm(raw.h) };
  Object.assign(size, next);
  const changed = ['w', 'd', 'h'].filter((k) => Number.isFinite(raw[k]) && Math.abs(raw[k] - next[k]) > 1e-9);
  if (changed.length) {
    d.toast(`场景范围按毫米取整：${changed.map((k) => `${k} ${raw[k]} → ${next[k]}`).join('，')} m`);
  }
  if (d.applyRoom(next)) {
    blocked.value = '';
    return;
  }
  // 没生效：输入框回填成**当前真实尺寸**（界面上不留没被采纳的数），原因用内核原话。
  // `d.message.value` 是 `applyRoom` 刚写进去的那句（同步读；2.6 秒后才清空）——
  // 越界墙/设备序号在它里面，界面**不重算**（docs/91 §6.7 的「不静默」就靠这一行）。
  const l = d.layout.value;
  size.w = l.w;
  size.d = l.d;
  size.h = l.h;
  blocked.value = d.message.value || '场景范围没有改成功';
}
</script>

<template>
  <RailFold id="size" title="场景范围">
    <template #head>
      <span class="hint">{{ dimsText }}</span>
    </template>

    <!-- 这次走哪条路（读 d.roomSemantics，界面不自己判）：探针读 data-size-mode -->
    <p class="hint hint--mode" :data-size-mode="mode">{{ modeText }}</p>

    <div class="row row--3">
      <div class="field"><label>长 X / m</label><input v-model.number="size.w" type="number" step="0.001" :min="limits.w[0]" :max="limits.w[1]"></div>
      <div class="field"><label>宽 Z / m</label><input v-model.number="size.d" type="number" step="0.001" :min="limits.d[0]" :max="limits.d[1]"></div>
      <div class="field"><label>层高 / m</label><input v-model.number="size.h" type="number" step="0.001" :min="limits.h[0]" :max="limits.h[1]"></div>
    </div>
    <button class="btn btn--primary btn--block" @click="apply()">应用尺寸</button>
    <div class="presets">
      <button v-for="p in presets" :key="p.label" class="btn" @click="apply({ w: p.w, d: p.d })">{{ p.label }}</button>
    </div>
    <p class="hint">可输入范围：长 {{ limits.w[0] }}–{{ limits.w[1] }} · 宽 {{ limits.d[0] }}–{{ limits.d[1] }} · 层高 {{ limits.h[0] }}–{{ limits.h[1] }} m</p>
    <!-- 被拦下的原因（内核原话，含越界墙/设备序号）；不静默、不只靠 toast -->
    <p v-if="blocked" class="hint hint--warn" data-size-blocked role="status">{{ blocked }}</p>
  </RailFold>
</template>

<style scoped>
.presets { display: flex; gap: 6px; }
.presets .btn { flex: 1; padding: 5px 0; font-size: 12px; }
/* 「走哪条路」那行是**说明**不是告警：用普通弱色，别和真正的拦截（.hint--warn）抢注意力 */
.hint--mode { line-height: 1.5; }
</style>
