<script setup>
/**
 * RoomList —— 房间列表（M1），设计端右栏第 3 块（docs/84 §六.3）
 *
 * 用户 2026-10-09 四条硬要求里这一块对应两条：
 *   ③ **房间缩略图 显示/隐藏** —— 工具条与这里各一个 1 步可达的开关（还有快捷键 T）
 *   ④ 房间之间墙体编辑一致 —— 列表只是读数，它**不下场改墙**（墙只在平面图上改，只有一份）
 *
 * 用户拍板的名称口径：没起名的显示 **「未命名房间」**（不是编号）；名称可以就地改。
 * 缩略图是 **2D 简图**（用户明确说"不需要真 3D 渲染"）：几何来自内核 `roomThumb()`，
 * 界面只负责把点连起来 —— 界面不自己算几何。
 *
 * docs/84 之后：整块装进 `RailFold`（可折叠、折叠状态本机记住）。卡头内容没变 ——
 * 「房间 N 间」在左，缩略图开关在右，只是那颗「N」与开关搬进了折叠卡头的 `#head` 插槽。
 *
 * 第二轮 验收 #2（docs/89）：行尾那两颗文字按钮撤掉，房间卡只剩
 * 「缩略图 + 名称（悬浮/聚焦时露出铅笔）+ 面积/设备读数」，三类手势各归各位：
 *   · 点名称（或铅笔）→ 就地改名，同时选中这一间；
 *   · 点缩略图 / 读数行（行内其余地方）→ 只选中；
 *   · 双击缩略图 / 读数行 → 选中并让相机聚焦这一间。
 * 行高固定 62 px：改名前后、名称长短、缩略图开关都不让行跳动。
 */
import { computed, nextTick, ref } from 'vue';
import { cfg } from '@core/params.js';
import { fmtArea } from '../fmt.js';
import { rooms as roomsKernel } from '../kernel.js';
import { designer as d } from '../designer.js';
import RailFold from './RailFold.vue';

const layout = computed(() => d.layout.value);
/** 每间房 + 它缩略图的几何（内核给的归一化点阵） */
const rows = computed(() => d.roomList.value.map((r) => ({ ...r, thumb: roomsKernel.roomThumb(layout.value, r, 64) })));
const waiting = computed(() => d.waitingNames.value);
const editing = ref(null);      // 正在改名的房间 id
const draft = ref('');

/** 进入改名：点名称与点铅笔走同一条路（同时选中这一间，右栏别的块跟着换对象） */
function startEdit(r) {
  editing.value = r.id;
  draft.value = r.name;
  d.selectRoom(r.id);
  // 等输入框真的进 DOM 再聚焦并全选。用 data 属性查，不用模板 ref：
  // v-for 里的字符串 ref 拿到的是数组，`inputRef.value.focus` 根本不存在。
  nextTick(() => {
    const el = document.querySelector(`[data-room-name-input="${r.id}"]`);
    el?.focus();
    el?.select();
  });
}

function commit(r) {
  if (editing.value !== r.id) return;
  const name = draft.value;
  editing.value = null;
  d.setRoomName(r.id, name);
}

/** Esc：取消这次改名（不写回）。blur 会随后触发 commit，但那时 editing 已清空，commit 直接返回 */
function cancel() {
  editing.value = null;
}

/** 读屏用的房间描述：在 script 里拼好，模板那行只留一个表达式
 *  （多行 `:aria-label="` 会在行首/行尾各留一个半角引号，`check-quotes.py` 如实判红） */
function ariaLabel(r) {
  return `选中房间 ${r.displayName}，${r.area.toFixed(2)} 平方米，${r.items} 台设备${r.sliver ? '，窄缝' : ''}`;
}

/** 点缩略图 / 读数行 = 只选中；改名中不抢焦点（点行内空白不该把输入框挤掉） */
function pick(r) {
  if (editing.value === r.id) return;
  d.selectRoom(r.id);
}

/** 双击缩略图 / 读数行 = 选中并聚焦（用户拍板：2D 简图 + 点一下聚焦足够了） */
function zoom(r) {
  if (editing.value === r.id) return;
  d.selectRoom(r.id);
  d.focusRoom(r.id);
}
</script>

<template>
  <RailFold id="rooms" title="房间" data-rooms>
    <!-- 卡头右侧：计数（探针按 data-room-count 取）与缩略图开关，与折叠按钮同排 -->
    <template #head>
      <span class="rooms__count"><b data-room-count>{{ d.roomCount.value }}</b> 间</span>
      <button
        class="btn btn--mini"
        data-tool="rooms-thumbs"
        :aria-pressed="d.roomThumbs.value"
        :disabled="!d.roomCount.value"
        :title="d.roomCount.value ? '显示/隐藏房间缩略图（快捷键 T）' : '还没有房间，缩略图暂时没有可显示的内容'"
        @click="d.toggleRoomThumbs()"
      >{{ d.roomThumbs.value ? '缩略图：开' : '缩略图：关' }}</button>
    </template>

    <!-- 名字"在等房间"：墙改过形状、暂时对不上任何一间。如实说 —— 名字没丢，形状改回去就回来 -->
    <!-- 开放面积是**只读派生量**：不可命名、不可逐块列；0 时不占一行。 -->
    <div v-if="d.openArea.value > 1e-9" class="rooms__open" data-open-area>
      <span class="rooms__open-label">开放场景</span>
      <b class="rooms__open-area">{{ fmtArea(d.openArea.value) }} ㎡</b>
      <span class="hint">不可命名</span>
    </div>

    <p v-if="waiting.length" class="hint hint--warn" data-room-waiting>
      另有 {{ waiting.length }} 个房间名暂时没有对应的房间（{{ waiting.join('、') }}）—— 墙改回去就回来
      <template v-if="d.openArea.value > 1e-9">；这一块现在是开放场景，名字先留着</template>
    </p>

    <ul class="rooms">
      <li
        v-for="r in rows"
        :key="r.id"
        class="rooms__row"
        :class="{ 'is-selected': d.selectedRoom.value === r.id, 'is-editing': editing === r.id, 'no-thumb': !d.roomThumbs.value }"
      >
        <!-- 行底那颗按钮负责「选中 / 双击聚焦」：缩略图与读数压在它上面但不吃点击（pointer-events 透传），
             名称与铅笔是它上面的真按钮 —— 点名称只会进改名，不会漏成"选中"。键盘用户 Tab 到的也是它。 -->
        <button
          type="button"
          class="rooms__pick"
          :data-room-pick="r.id"
          :aria-label="ariaLabel(r)"
          :tabindex="editing === r.id ? -1 : 0"
          @click="pick(r)"
          @dblclick="zoom(r)"
        />

        <!-- 缩略图：2D 简图（房面 + 落在房里的墙线）。关掉时整块不渲染，列表**不因此少一行** -->
        <svg
          v-if="d.roomThumbs.value"
          class="rooms__thumb"
          :viewBox="`0 0 ${r.thumb.size} ${r.thumb.size}`"
          aria-hidden="true"
          :data-room-thumb="r.id"
        >
          <polygon class="rooms__thumb-fill" :points="r.thumb.points.map((p) => p.join(' ')).join(' ')" />
          <line v-for="(s, i) in r.thumb.segs" :key="i" class="rooms__thumb-wall" :x1="s[0][0]" :y1="s[0][1]" :x2="s[1][0]" :y2="s[1][1]" />
        </svg>

        <span class="rooms__text">
          <span class="rooms__name" :title="r.displayName">
            <input
              v-if="editing === r.id"
              v-model="draft"
              class="rooms__input"
              :maxlength="cfg.room.nameMaxChars"
              :aria-label="`重命名房间 ${r.displayName}`"
              :data-room-name-input="r.id"
              @click.stop
              @dblclick.stop
              @keydown.enter.prevent="commit(r)"
              @keydown.esc.prevent="cancel()"
              @blur="commit(r)"
            >
            <template v-else>
              <!-- 名称本身就是改名入口；长名单行省略，全名挂 title -->
              <button type="button" class="rooms__name-btn" :title="r.displayName" @click="startEdit(r)">
                <span class="rooms__name-text">{{ r.displayName }}</span>
              </button>
              <span v-if="r.sliver" class="chip chip--warn" title="两面墙贴得太近挤出来的一条缝">窄缝</span>
              <!-- 铅笔只是"名称可改"的可见提示：默认藏起来，行 hover / 行内有焦点时露出来 -->
              <button
                type="button"
                class="rooms__pencil"
                :data-room-rename="r.id"
                :aria-label="`重命名房间 ${r.displayName}`"
                title="重命名这一间"
                @click="startEdit(r)"
              >
                <svg class="rooms__pencil-icon" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
                  <path d="M4 20h4.2L19.5 8.7a2.1 2.1 0 0 0 0-3L18.3 4.5a2.1 2.1 0 0 0-3 0L4 15.8Z" fill="currentColor" />
                  <path d="M13.8 6.3l3.9 3.9" stroke="#fff" stroke-width="1.2" stroke-linecap="round" />
                </svg>
              </button>
            </template>
          </span>
          <span class="rooms__meta">
            {{ r.area.toFixed(2) }} ㎡ · 设备 {{ r.items }} 台<span v-if="r.openings"> · 门洞 {{ r.openings }}</span>
          </span>
        </span>
      </li>
    </ul>

    <p v-if="!rows.length && d.openArea.value > 1e-9" class="hint" data-open-room-empty>
      还没有闭合的房间（当前开放场景 {{ fmtArea(d.openArea.value) }} ㎡）。画一圈墙就成房间，开口的部分仍是开放场景。
    </p>
    <p v-else-if="!rows.length" class="hint">还没有闭合的房间；画一圈墙就成房间，开口的部分是开放场景。</p>
    <p v-else class="hint">
      点名称改名 · 点缩略图或读数选中 · 双击聚焦 · 取消/重做会带回房间名
    </p>
  </RailFold>
</template>

<style scoped>
/* 卡头里的计数与开关：跟卡头字号同色，不抢标题的视线 */
.rooms__count { font-weight: 400; color: var(--ink-2); white-space: nowrap; }
.rooms__count b { font-family: var(--mono); color: var(--ink); }

.rooms { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }

/* 行高固定 62 px（验收2-2）：改名前后、名称长短、缩略图开关都不让行跳动。
   列只有两列：缩略图 48 + 名称/读数 1fr；行尾不再有第二列按钮。 */
.rooms__row {
  position: relative;
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr);
  align-items: center;
  gap: 8px;
  height: 62px;
  padding: 4px 6px;
  border: 1px solid transparent;
  border-radius: 8px;
}
.rooms__row.is-selected { border-color: var(--brand); background: color-mix(in srgb, var(--brand) 8%, transparent); }
/* 缩略图关掉时只剩名称一列：名称/输入框仍占满整行（不然 48 px 的固定列会空在那里） */
.rooms__row.no-thumb { grid-template-columns: minmax(0, 1fr); }

/* 选中/双击用的透明按钮：铺满整行，压在内容下面。它不是"点一下选中"的唯一入口 ——
   键盘用户 Tab 到它、读屏会念 aria-label（房间名 + 面积 + 设备数 + 窄缝）。 */
.rooms__pick {
  position: absolute;
  inset: 0;
  z-index: 0;
  width: 100%;
  height: 100%;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: none;
  cursor: pointer;
}
.rooms__pick:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }

/* 缩略图：2D 简图（房面 + 墙线）—— 尺寸固定，列表行不会因为房间大小而跳动。
   它不吃点击：点在它身上应该落到下面那颗按钮 = 选中。 */
.rooms__thumb {
  width: 48px;
  height: 48px;
  flex: none;
  pointer-events: none;
  background: var(--bg-2);
  border-radius: 6px;
}
.rooms__thumb-fill { fill: var(--wall-2d); fill-opacity: calc(var(--wall-2d-op, 1) * 0.25); stroke: none; }
.rooms__thumb-wall { stroke: var(--ink-2); stroke-width: 2; stroke-linecap: round; }

.rooms__text {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  pointer-events: none;   /* 读数整片透传给行底按钮；名称/铅笔/输入框自己再打开 */
}

.rooms__name {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  line-height: 22px;
  white-space: nowrap;
}
.rooms__name-btn {
  flex: 0 1 auto;
  min-width: 0;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: none;
  color: inherit;
  font: inherit;
  font-weight: inherit;
  line-height: inherit;
  text-align: left;
  white-space: nowrap;
  cursor: text;
  pointer-events: auto;
}
.rooms__name-btn:focus-visible { outline: 2px solid var(--brand); outline-offset: 1px; }
/* 单行省略：长名称不许把行撑宽、也不许挤掉铅笔 */
.rooms__name-text { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.rooms__name .chip { flex: none; }

/* 铅笔：14 px 图标 + 20 px 命中区，默认不可见（也不吃点击），行 hover / 行内有焦点时出现 */
.rooms__pencil {
  flex: none;
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 5px;
  background: none;
  color: var(--ink-3);
  cursor: pointer;
  opacity: 0;
  pointer-events: none;
  transition: opacity .12s ease, color .12s ease, background .12s ease;
}
.rooms__row:hover .rooms__pencil,
.rooms__row:focus-within .rooms__pencil { opacity: 1; pointer-events: auto; }
.rooms__pencil:hover { color: var(--brand-dark); background: var(--brand-soft); }
.rooms__pencil:focus-visible { opacity: 1; outline: 2px solid var(--brand); outline-offset: 1px; }

.rooms__meta {
  font-size: 11px;
  color: var(--ink-3);
  line-height: 17px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 编辑态：输入框就长在名称那一格（缩略图还在左），同字号同高度；长名在框内横向滚动，不换行 */
.rooms__input {
  width: 100%;
  min-width: 0;
  height: 22px;
  margin: 0;
  padding: 0 6px;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  line-height: 20px;
  color: var(--ink);
  background: #fff;
  border: 1px solid var(--brand);
  border-radius: 6px;
  pointer-events: auto;
}

/* 开放场景只读行：与房间行同宽、同底色语汇，但不可点、不可改名 */
.rooms__open {
  display: flex; align-items: baseline; gap: 6px;
  padding: 6px 8px; margin-bottom: 6px;
  border: 1px dashed var(--line); border-radius: 7px;
  color: var(--ink-2); font-size: 12px;
}
.rooms__open-label { font-weight: 600; }
.rooms__open-area { font-family: var(--mono); color: var(--ink); }
</style>
