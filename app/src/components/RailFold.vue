<script setup>
/**
 * RailFold —— 设计端右栏的一张可折叠卡片（设计决策记录 §六.7）
 *
 * ## 为什么把这张壳单独拿出来
 * 右栏六块（空间体检 / 空间尺寸 / 房间 / 内墙 / 外观 / 选中）都要「卡片头 + 折叠按钮 + 记住开合」。
 * 写六份就会出现"改一处漏五处"，而且**每一份的 aria 都能单独写错**（这类错不报错、也没人看得见）。
 * 所以折叠这件事只在这里定义一次。
 *
 * ## 接口（无事件：折叠是这一块自己的状态，不往外喊）
 *   id          折叠键，也用来拼 DOM id（`rail-fold-<id>` / `rail-body-<id>`，给 aria-controls 指）
 *   title       卡头文字（"空间体检""房间"……）
 *   summary     折叠态摘要；只有卡头没有其它状态信息时才需要传（空串就不显示）
 *   defaultOpen 这一块默认展开？默认 true（设计决策记录：默认全部展开，用户按自己的习惯收）
 *   默认插槽     卡体
 *   head 插槽    卡头右侧的附加内容（计数、缩略图开关、选中对象的型号等）——
 *               与折叠按钮同排、在按钮左边；里面的按钮点击不会连带折叠这一块
 *
 * ## 开合状态记在哪
 * `localStorage['spatial.designer.rail']` 里一个对象：`{ [id]: boolean }`。
 * 用**对象**而不是六个独立键：换账号、换方案都不该清（设计决策记录 §六.7），
 * 而"这一栏里哪几块收着"是一个整体偏好，收在一处才知道它是同一件事。
 * 只存用户按过的那些块；没存过的按 `defaultOpen` 算 —— 于是"新增一块"永远是展开的。
 */
import { ref } from 'vue';

const props = defineProps({
  id: { type: String, required: true },
  title: { type: String, default: '' },
  summary: { type: String, default: '' },
  defaultOpen: { type: Boolean, default: true },
});

/** 折叠偏好的存储键（本机、换账号不清） */
const KEY = 'spatial.designer.rail';

/** 整份偏好读出来；读不到/被写坏都当"没设置过"——一个坏 JSON 不该让整栏收不起来 */
function readAll() {
  try {
    const raw = localStorage.getItem(KEY);
    const all = raw ? JSON.parse(raw) : null;
    return all && typeof all === 'object' ? all : {};
  } catch {
    return {};
  }
}

const atBoot = readAll()[props.id];
const open = ref(typeof atBoot === 'boolean' ? atBoot : props.defaultOpen);

/** 卡体与按钮的关联 id：`aria-controls` 要指向**真的存在**的那个元素 */
const bodyId = 'rail-body-' + props.id;

function toggle() {
  open.value = !open.value;
  const all = readAll();
  all[props.id] = open.value;
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* 本机写不进去（无痕模式/配额满）：这一页照旧能收能开，只是刷新后回到默认 — 不拦用户 */
  }
}
</script>

<template>
  <section :id="'rail-fold-' + id" class="card rail-fold" :data-fold="id">
    <header>
      <!-- 折叠后卡头仍可点开：文字区是一次便捷点击，键盘路径是右边那颗真正的按钮 -->
      <span class="rail-fold__headtext" :title="open ? '收起这一块' : '展开这一块'" @click="toggle">
        <span class="rail-fold__title">{{ title }}</span>
        <span v-if="!open && summary" class="rail-fold__summary">{{ summary }}</span>
      </span>
      <span class="spacer" />
      <slot name="head" />
      <button
        type="button"
        class="rail-fold__toggle"
        :aria-expanded="open"
        :aria-controls="bodyId"
        :aria-label="(open ? '收起' : '展开') + title"
        :title="(open ? '收起' : '展开') + title"
        @click="toggle"
      >
        <span aria-hidden="true">{{ open ? '▾' : '▸' }}</span>
      </button>
    </header>
    <!-- 用 v-show 不用 v-if：`aria-controls` 指着的元素必须一直在文档里，
         否则读屏读到的是一条指向空气的引用（折叠态本身由 display:none 表达） -->
    <div v-show="open" :id="bodyId" class="card-body">
      <slot />
    </div>
  </section>
</template>

<style scoped>
/* 卡头的排版归这一块管：全局 `.card > header` 只管底色与内边距 */
.rail-fold > header { align-items: center; gap: 8px; min-height: 40px; }

.rail-fold__headtext {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  cursor: pointer;
}
.rail-fold__title { font-weight: 600; white-space: nowrap; }
.rail-fold__summary {
  color: var(--ink-3);
  font-weight: 400;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 命中区 32 × 32（设计决策记录 §六.7）：小到不抢视线，大到能一次点中 */
.rail-fold__toggle {
  flex: none;
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 1px solid var(--line-2);
  border-radius: 7px;
  background: #fff;
  color: var(--ink-2);
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
}
.rail-fold__toggle:hover { border-color: var(--brand); color: var(--brand-dark); background: var(--brand-soft); }
.rail-fold__toggle:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
</style>
