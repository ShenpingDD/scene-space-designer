<script setup>
/**
 * ParamsNotice —— 规则参数**自动跟新**时的提示条（R6-4 B4b）
 *
 * ## 为什么这条提示不是"锦上添花"，是必须
 * 后台改了参数（比如门开度阈值 90 → 85），已经打开的页面在 5 秒内**自己**换成新参数。
 * 从用户这一侧看：**什么都没点，判定标准就变了** —— 「这台门刚才还说不受阻，现在怎么变了？」
 * 静默换参数的后果与"静默筛选"是同一个家族的错：界面变了却不说为什么。
 * 所以每换一次都要说一句：**后台改了什么、现在按哪一版算、是它自己跟上的**。
 *
 * ## 两种提示的语气不一样，这是刻意的
 * - 跟上了（`updated`）：说清 + **15 秒后自己收**（它只是通知，不需要用户做什么）；
 * - 没装上（`failed`）：**不自动收**（这是个问题，要留到有人看见），并且明确说
 *   "现在还在按上一版算" —— 不许让用户以为已经生效了。
 *
 * 这一层**不自己拼句子**：文案来自 `paramsText.autoLine`（整句只有一个出处）。
 */
import { onMounted, onUnmounted, ref } from 'vue';
import { onParamsChange, WATCH_MS } from '../liveParams.js';
import { autoLine } from '../paramsText.js';

const msg = ref('');
const kind = ref('updated');
let off = null;
let hideTimer = null;

onMounted(() => {
  off = onParamsChange((ev) => {
    kind.value = ev && ev.kind === 'updated' ? 'updated' : 'failed';
    msg.value = autoLine(ev, WATCH_MS);
    if (hideTimer) clearTimeout(hideTimer);
    // 成功了就让它自己走；失败了留着（它是个待解释的现象）
    if (kind.value === 'updated') {
      hideTimer = setTimeout(() => { msg.value = ''; }, 15000);
    }
  });
});

onUnmounted(() => {
  if (off) off();
  if (hideTimer) clearTimeout(hideTimer);
});
</script>

<template>
  <div v-if="msg" class="pnotice" :class="'pnotice--' + kind" role="status" aria-live="polite">
    <span class="pnotice__text">{{ msg }}</span>
    <button class="pnotice__x" title="知道了" @click="msg = ''">✕</button>
  </div>
</template>