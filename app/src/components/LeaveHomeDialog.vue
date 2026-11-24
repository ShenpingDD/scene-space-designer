<script setup>
/**
 * LeaveHomeDialog —— 点左上角房子回首页时，**有未保存改动**才弹的那个居中模态。
 *
 * 三条原则（第二轮 验收 定下来的）：
 *   1. **只在真的会丢东西时弹**：没有任何未保存改动就直接回首页（判断在 App.vue，
 *      因为只有它同时知道"方案库里的 dirty"与"草稿/名字动过没有"这两件事）；
 *   2. **不替用户决定**：保存并返回 / 不保存返回 / 取消三条路，取消是默认焦点（最安全）；
 *   3. **保存失败不假装成功**：这一层只发事件、不导航；`saveForLeave` 回 ok 之后
 *      才由 App 跳转，失败的原因显示在这里的 `error` 上，人留在当前页。
 *
 * 无障碍：`role="dialog"` + `aria-modal`，打开时焦点进窗、关闭时还给触发它的按钮；
 * Esc = 取消；Tab 在窗内循环；**点遮罩不关**（误点一下不该把"要不要保存"这个决定吞掉）。
 */
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';

const props = defineProps({
  open: { type: Boolean, default: false },
  /** 方案名（只用于把话说具体；新方案可能为空） */
  name: { type: String, default: '' },
  /** 这份还没落过库（新方案）—— 两条路的说明文字不一样 */
  isNew: { type: Boolean, default: false },
  /** 正在保存（按钮全灰、Esc 不生效，避免"没保存完就跳走/关窗"） */
  busy: { type: Boolean, default: false },
  /** 保存失败的原因（409 / 连不上后端 / 没名字…），由 App 填 */
  error: { type: String, default: '' },
});

const emit = defineEmits(['save', 'discard', 'cancel']);

const box = ref(null);
const cancelBtn = ref(null);
/** 打开之前焦点在谁身上：关闭时还回去（否则焦点掉到 body，键盘用户找不到自己在哪） */
let lastFocus = null;

function closeable() {
  return props.open && !props.busy;
}

/** 窗内可聚焦元素（Tab 循环用；禁用的不算） */
function focusables() {
  if (!box.value) return [];
  const nodes = box.value.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
  return Array.from(nodes).filter((el) => !el.disabled && el.offsetParent !== null);
}

function onKey(e) {
  if (!props.open) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    if (closeable()) emit('cancel');
    return;
  }
  if (e.key !== 'Tab') return;
  const list = focusables();
  if (!list.length) return;
  const first = list[0];
  const last = list[list.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || !box.value.contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !box.value.contains(active))) {
    e.preventDefault();
    first.focus();
  }
}

watch(() => props.open, async (v) => {
  if (v) {
    lastFocus = document.activeElement;
    document.addEventListener('keydown', onKey);
    await nextTick();
    // 默认焦点给「取消」：这个窗问的是"要不要丢掉改动"，最安全的默认是不丢
    cancelBtn.value?.focus?.();
  } else {
    document.removeEventListener('keydown', onKey);
    if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
    lastFocus = null;
  }
}, { immediate: true });

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey);
});
</script>

<template>
  <Teleport to="body">
    <!-- 遮罩不吃点击关闭：这一层是一个**决定**，不该被一次误点吞掉 -->
    <div v-if="open" class="lv__mask">
      <div ref="box" class="lv" role="dialog" aria-modal="true" aria-labelledby="lv-title" aria-describedby="lv-desc">
        <h2 id="lv-title" class="lv__title">返回首页前，先处理没保存的改动</h2>
        <p id="lv-desc" class="lv__desc">
          <template v-if="isNew">
            这是一份<b>还没保存过</b>的新方案<template v-if="name">「<b>{{ name }}</b>」</template> ——
            离开这一页，画布上的改动就只剩这台浏览器里的草稿（登录同一账号还能拿回来）。
          </template>
          <template v-else>
            「<b>{{ name || '这份方案' }}</b>」有<b>还没保存</b>的改动 —— 离开这一页，它们就没有了。
          </template>
        </p>

        <p v-if="error" class="lv__err" role="alert">{{ error }}</p>

        <div class="lv__actions">
          <button ref="cancelBtn" type="button" class="btn" :disabled="busy" @click="emit('cancel')">
            取消
          </button>
          <button type="button" class="btn btn--danger" :disabled="busy" @click="emit('discard')">
            不保存返回
          </button>
          <button type="button" class="btn btn--primary" :disabled="busy" @click="emit('save')">
            {{ busy ? '正在保存…' : '保存并返回' }}
          </button>
        </div>

        <p class="lv__hint">
          保存失败会留在这台页面上，不会假装已经存好。
        </p>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.lv__mask {
  position: fixed; inset: 0; z-index: 70;
  background: rgb(16 26 32 / 46%);
  display: flex; align-items: center; justify-content: center;
  padding: 16px;
}
.lv {
  width: min(460px, 94vw);
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 18px 20px 14px;
}
.lv__title { margin: 0; font-size: 16px; line-height: 1.4; }
.lv__desc { margin: 10px 0 0; font-size: 13px; line-height: 1.7; color: var(--ink-2); }
.lv__err {
  margin: 12px 0 0; padding: 8px 10px; border-radius: 6px;
  background: var(--bad-soft); color: var(--bad-ink); font-size: 13px; line-height: 1.6;
}
.lv__actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.lv__hint { margin: 10px 0 0; font-size: 12px; color: var(--ink-3); }
</style>
