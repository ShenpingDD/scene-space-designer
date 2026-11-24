<script setup>
/**
 * InteriorWallCard —— 右栏第 4 块「墙体」（docs/84 §六.4，P2 起分组）
 *
 * 内容从原左栏第三张**原样搬来**：这里只有列表与两个动作（选中 / 删除），
 * 方向与长度都是内核给的读数（`d.scene` 的 WallView），界面不自己算角度与长度。
 *
 * 开放场景之后墙分两种**持久化角色**：外墙 / 内墙。分组只是把 role 读出来，
 * 不按几何猜（旧墙的 role 回退已由 scene2d/内核完成）。两面都可以选中、删除；
 * 类型切换在「选中」卡里（一步、可撤销，且非贴边设外墙会被内核拒绝）。
 */
import { computed } from 'vue';
import { designer as d } from '../designer.js';
import { LIMITS } from '../kernel.js';
import { fmtLen } from '../fmt.js';
import RailFold from './RailFold.vue';

const walls = computed(() => d.scene.value.walls);
const exteriorWalls = computed(() => walls.value.filter((w) => w.role === 'exterior'));
const interiorWalls = computed(() => walls.value.filter((w) => w.role !== 'exterior'));

/** 方向文案：对齐 15° 档报「水平 / 垂直 / 45°」这种一眼能懂的说法 */
function dirText(deg) {
  const a = ((deg % 180) + 180) % 180;
  if (a < 0.5 || a > 179.5) return '水平';
  if (Math.abs(a - 90) < 0.5) return '垂直';
  return `${a.toFixed(1)}°`;
}
</script>

<template>
  <RailFold id="walls" title="墙体">
    <template #head>
      <span class="hint" data-wall-counts>
        外墙 <b data-wall-ext-count>{{ exteriorWalls.length }}</b> · 内墙 <b data-wall-int-count>{{ interiorWalls.length }}</b> / 上限 {{ LIMITS.walls }} 面
      </span>
    </template>

    <template v-if="walls.length">
      <section v-if="exteriorWalls.length" class="wall-group" data-wall-group="exterior">
        <h4 class="wall-group__head">外墙 <span class="hint">贴场景边缘</span></h4>
        <ul class="wall-list">
          <li
            v-for="w in exteriorWalls"
            :key="w.index"
            :class="{ 'is-selected': d.selectedWall.value === w.index }"
            :data-wall-row="w.index"
            @click="d.selectWall(w.index)"
          >
            <span class="mono">#{{ w.index }}</span>
            <span><span class="chip chip--role">外墙</span> {{ dirText(w.angleDeg) }} {{ fmtLen(w.length) }} m</span>
            <span class="mono pos">{{ fmtLen(w.mid[0]) }}, {{ fmtLen(w.mid[1]) }}</span>
            <button class="btn btn--icon btn--danger" title="移除这面墙" @click.stop="d.removeWall(w.index)">×</button>
          </li>
        </ul>
      </section>

      <section v-if="interiorWalls.length" class="wall-group" data-wall-group="interior">
        <h4 class="wall-group__head">内墙</h4>
        <ul class="wall-list">
          <li
            v-for="w in interiorWalls"
            :key="w.index"
            :class="{ 'is-selected': d.selectedWall.value === w.index }"
            :data-wall-row="w.index"
            @click="d.selectWall(w.index)"
          >
            <span class="mono">#{{ w.index }}</span>
            <span><span class="chip">内墙</span> {{ dirText(w.angleDeg) }} {{ fmtLen(w.length) }} m</span>
            <span class="mono pos">{{ fmtLen(w.mid[0]) }}, {{ fmtLen(w.mid[1]) }}</span>
            <button class="btn btn--icon btn--danger" title="移除这面墙" @click.stop="d.removeWall(w.index)">×</button>
          </li>
        </ul>
      </section>
    </template>
    <p v-else class="hint">还没有墙（画墙模式里拖一笔就有一面）。</p>
  </RailFold>
</template>

<style scoped>
.wall-group + .wall-group { margin-top: 8px; }
.wall-group__head {
  margin: 0 0 4px; font-size: 12px; font-weight: 600; color: var(--ink-2);
  display: flex; align-items: baseline; gap: 6px;
}
.wall-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.wall-list li {
  display: grid;
  grid-template-columns: 30px 1fr auto auto;
  gap: 8px;
  align-items: center;
  padding: 6px 8px;
  border: 1px solid var(--line-2);
  border-radius: 7px;
  font-size: 12px;
  cursor: pointer;
}
.wall-list li:hover { border-color: var(--brand); }
/* 选中的那面墙在平面图与这里同时高亮 —— 同一个选中状态，不许两边各说各的 */
.wall-list li.is-selected { border-color: var(--brand); background: var(--brand-soft); }
.wall-list .pos { color: var(--ink-3); }
.wall-list .btn { width: 24px; height: 24px; padding: 0; line-height: 1; }
.mono { font-family: var(--mono); }
.chip--role { color: var(--brand-dark); border-color: var(--brand); }
</style>
