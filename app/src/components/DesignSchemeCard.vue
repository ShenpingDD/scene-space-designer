<script setup>
/**
 * DesignSchemeCard —— 「我的全部方案」的设计稿卡片（设计决策记录 v2）
 *
 * ## 为什么不是改 SchemeCard
 * 维护端方案库与我的方案曾经共用 `SchemeCard.vue`，那一版是"信息密集"的表格式卡片
 * （尺寸/台数/型号/改动人/角标全在一行）。设计稿要求的是**封面优先**的相册式卡片，
 * 两者密度差一个数量级，硬塞进同一份模板会让维护端丢掉它需要的列。
 * 所以这一张是新的纯展示组件：只认 `cardOf()` 的投影，动作一律 emit 出去 ——
 * 写库的实现仍然只有 `admin/schemeActions.js` 一份（删除/恢复/复制/回滚的文案与状态都从那里来）。
 *
 * ## 三条硬规矩（跟着卡片走）
 * ① **缺数据不补**：没有封面就写「无封面」，没有名字就写「（未命名）」，不假渲；
 * ② **角标要能问**：`放不下` / `门` 只给短标签，`title` 里写明「为什么判它是这样」；
 * ③ **不能嵌套 button**：外层是 `<div role="button">`，里面的「继续编辑」「···」是真按钮，
 *    每个都 `@click.stop` —— 用 `<button>` 做外层会被浏览器隐式闭合，网格直接错乱（规格 §7.6）。
 *
 * ## 外层可点，但不是所有视图都可点
 * 回收站里的方案打不开（它已经软删了），所以那一半 `role/tabindex` 都不给，只留「恢复」。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { cardOf, historyNote } from '../admin/schemes.js';
import { denyText } from '../admin/roles.js';

const props = defineProps({
  /** 接口给的那一行原始数据（显示什么由 `cardOf` 汇总，不在模板里算） */
  row: { type: Object, required: true },
  /** `library`（方案库）| `trash`（回收站）—— 两半的动作不同 */
  view: { type: String, default: 'library' },
  /** 能不能改方案。灰按钮 + 说明为什么，不隐藏 */
  canWrite: { type: Boolean, default: false },
  /** 角色码，只说人话用 */
  role: { type: String, default: '' },
  /** 正在写库的动作 `<动作>:<id>` */
  busy: { type: String, default: '' },
  /** 二次确认：`{kind:'delete'|'rollback', id, ...}` */
  confirming: { type: Object, default: null },
  /** 展开的版本历史：`{id, phase, rows, currentRev, trouble}` */
  drawer: { type: Object, default: null },
});

const emit = defineEmits(['open', 'ask-delete', 'ask-rollback', 'cancel', 'delete', 'restore', 'duplicate', 'rollback', 'toggle-history']);

const c = computed(() => cardOf(props.row));

/** 回收站里的卡片不该点开设计器（那份方案已经软删了） */
const clickable = computed(() => props.view !== 'trash');
const writeWhy = computed(() => (props.canWrite ? '' : denyText('writeSchemes', props.role)));
const isBusy = (kind, id) => props.busy === kind + ':' + id;

/** 角标：设计稿只给短标签，数量在 title 里（角标必须能被问出来） */
const badge = computed(() => {
  const level = c.value.audit.level;
  if (level === 'bad') return { cls: 'bad', text: '放不下' };
  if (level === 'warn') return { cls: 'warn', text: '门' };
  return null;
});

const root = ref(null);
const menu = ref(false);

function toggleMenu() {
  menu.value = !menu.value;
}
function closeMenu() {
  menu.value = false;
}
function onDocPointer(e) {
  if (root.value && !root.value.contains(e.target)) closeMenu();
}
onMounted(() => document.addEventListener('pointerdown', onDocPointer));
onBeforeUnmount(() => document.removeEventListener('pointerdown', onDocPointer));

function open() {
  if (clickable.value) emit('open', c.value.id);
}
/** 菜单项：先收起菜单再发动作（菜单留着会挡住确认条） */
function pick(kind) {
  menu.value = false;
  emit(kind, c.value.id);
}
function openHistory() {
  menu.value = false;
  emit('toggle-history', c.value);
}
</script>

<template>
  <div
    ref="root"
    class="dscard"
    :class="{ 'is-deleted': c.deleted, 'is-readonly': !clickable }"
    :role="clickable ? 'button' : null"
    :tabindex="clickable ? 0 : null"
    :aria-label="clickable ? '继续编辑：' + (c.name || '未命名方案') : (c.name || '未命名方案')"
    @click="open"
    @keydown.enter.self.prevent="open"
    @keydown.space.self.prevent="open"
  >
    <!-- 封面：16:9。真图就显示，没有就写「无封面」，不假渲一张 -->
    <span class="dscard__thumb" :title="c.coverTitle">
      <img
        v-if="c.coverUrl"
        :src="c.coverUrl"
        :alt="'封面：' + (c.name || '未命名方案')"
        class="dscard__img"
        loading="lazy"
      >
      <span v-else class="dscard__ph">无封面</span>

      <span v-if="badge" class="dscard__badges">
        <span class="dscard__badge" :class="'dscard__badge--' + badge.cls" :title="c.audit.why">{{ badge.text }}</span>
      </span>
    </span>

    <span class="dscard__meta">
      <span class="dscard__name" :title="c.name || '（未命名）'">{{ c.name || '（未命名）' }}</span>
      <span class="dscard__time">更新于 {{ c.updatedText }}</span>

      <span class="dscard__ops">
        <template v-if="view === 'trash'">
          <button
            class="dscard__act"
            type="button"
            :disabled="isBusy('restore', c.id) || !canWrite"
            :title="writeWhy || '把这一份放回方案库（版本号不变 —— 恢复不是一次内容编辑）'"
            @click.stop="emit('restore', c.id)"
          >{{ isBusy('restore', c.id) ? '恢复中…' : '恢复' }}</button>
        </template>

        <template v-else>
          <button class="dscard__edit" type="button" title="在设计器里打开这一份继续编辑" @click.stop="open">
            继续编辑
          </button>

          <span class="dscard__more">
            <button
              class="dscard__more-btn"
              type="button"
              aria-haspopup="menu"
              :aria-expanded="menu"
              title="更多操作：复制一份 / 版本历史 / 放进回收站"
              @click.stop="toggleMenu"
            >···</button>

            <span v-if="menu" class="dscard__menu" role="menu" @click.stop>
              <button
                class="dscard__mi"
                type="button"
                role="menuitem"
                :disabled="isBusy('duplicate', c.id) || !canWrite"
                :title="writeWhy || '照这一份当前这一版拷一份新的（状态回到草稿、不带封面与标签）'"
                @click.stop="pick('duplicate')"
              >{{ isBusy('duplicate', c.id) ? '复制中…' : '复制一份' }}</button>
              <button class="dscard__mi" type="button" role="menuitem" title="看每一版长什么样，并选一版回滚" @click.stop="openHistory">
                版本历史
              </button>
              <button
                class="dscard__mi dscard__mi--danger"
                type="button"
                role="menuitem"
                :disabled="isBusy('delete', c.id) || !canWrite"
                :title="writeWhy || '放进回收站（软删，可恢复）'"
                @click.stop="pick('ask-delete')"
              >{{ isBusy('delete', c.id) ? '删除中…' : '放进回收站' }}</button>
            </span>
          </span>
        </template>
      </span>
    </span>

    <!-- 删除的二次确认：说清后果（进回收站、可恢复），只问一句「确定吗」等于没说 -->
    <div v-if="confirming && confirming.kind === 'delete' && confirming.id === c.id" class="dscard__confirm" @click.stop>
      <p class="dscard__confirm-text">
        把 <b>#{{ c.id }}</b> 放进回收站？它在前台与方案库里就不再出现了，但<b>没有真删掉</b>，在「回收站」里可以恢复。
      </p>
      <div class="dscard__confirm-ops">
        <button class="dscard__act dscard__act--danger" type="button" :disabled="isBusy('delete', c.id)" @click.stop="emit('delete', c.id)">
          {{ isBusy('delete', c.id) ? '删除中…' : '确认删除' }}
        </button>
        <button class="dscard__act" type="button" @click.stop="emit('cancel')">取消</button>
      </div>
    </div>

    <!-- 回滚的二次确认：把「变成什么样」与「当前那版会先留存」都说出来（拍板 A1） -->
    <div v-if="confirming && confirming.kind === 'rollback' && confirming.id === c.id" class="dscard__confirm" @click.stop>
      <p class="dscard__confirm-text">{{ confirming.text }}</p>
      <div class="dscard__confirm-ops">
        <button
          class="dscard__act"
          type="button"
          :disabled="isBusy('rollback', c.id)"
          @click.stop="emit('rollback', { id: confirming.id, targetRev: confirming.targetRev, expectRev: confirming.expectRev })"
        >{{ isBusy('rollback', c.id) ? '回滚中…' : '确认回滚' }}</button>
        <button class="dscard__act" type="button" @click.stop="emit('cancel')">取消</button>
      </div>
    </div>

    <!-- 版本历史：每一版都写清「它长什么样」——回滚是个必须做的选择，不能只有编号 -->
    <div v-if="drawer && drawer.id === c.id" class="dscard__revs" @click.stop>
      <p v-if="drawer.phase === 'loading'" class="dscard__revs-msg">正在取版本历史…</p>
      <p v-else-if="drawer.phase === 'fail'" class="dscard__revs-msg dscard__revs-msg--bad">
        取不到版本历史：<span class="dscard__mono">{{ drawer.trouble }}</span>
      </p>
      <template v-else>
        <p class="dscard__revs-note">{{ historyNote(drawer.rows, drawer.currentRev) }}</p>
        <ul class="dscard__revs-list">
          <li v-for="r in drawer.rows" :key="r.rev" class="dscard__rev" :class="{ 'is-current': r.isCurrent }">
            <span class="dscard__rev-no">第 {{ r.rev }} 版</span>
            <span class="dscard__rev-dim">{{ r.sizeText }}</span>
            <span class="dscard__rev-dim">{{ r.itemCount === null ? '台数 —' : r.itemCount + ' 台' }}</span>
            <span class="dscard__rev-dim">{{ r.modelCount === null ? '型号 —' : r.modelCount + ' 个型号' }}</span>
            <span class="dscard__rev-time">{{ r.createdText }}</span>
            <span class="dscard__rev-note" :title="r.note || '（没有版本说明）'">{{ r.note || '（没有版本说明）' }}</span>
            <span class="dscard__rev-spacer" />
            <span v-if="r.isCurrent" class="dscard__tag" title="这一版就是当前版本，没有需要回滚的东西">当前版本</span>
            <button
              v-else
              class="dscard__act"
              type="button"
              :disabled="isBusy('rollback', c.id)"
              title="把内容换成这一版（会先自动留存当前那一版，不会丢）"
              @click.stop="emit('ask-rollback', c, r)"
            >回滚到这一版</button>
          </li>
        </ul>
      </template>
    </div>
  </div>
</template>
