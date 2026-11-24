<script setup>
/**
 * MySchemesPage —— 我的全部方案（`/project`，设计稿 设计决策记录 v2）
 *
 * ## 版面
 * 顶栏（品牌标 40 + 维护端入口 + 账号胶囊，**没有新建按钮**）→ 标题行（我的全部方案 22/600 +
 * 回收站低调入口 + 返回首页）→ 工具条（搜索 / 状态胶囊 / 型号 / 排序 / 清空条件）→
 * 卡片墙（第 1 格虚线新建大卡，其后每页 7 张方案卡）+ 分页（右对齐，移动端居中）。
 * 新建入口只有一个：第一格那张大卡（规格 §6.4、§7.3）。
 *
 * ## 数据只有一处来源
 * `api.mySchemes()`（`GET /api/schemes`）。归属过滤由**服务端**做 —— 界面自己按 owner 筛，
 * 会把「看不见别人的方案」变成「筛掉了别人的方案」，那是两件不同的事。
 *
 * ## 写动作不在这一页实现
 * 删除/恢复/复制/回滚与版本历史全部来自 `admin/schemeActions.js`（维护端方案库共用同一份），
 * 页面只提供「重新取数」这一个接口。两页的按钮行为必须一字不差。
 *
 * ## 筛选不静默
 * 工具条下方保留一行 `filterSummary`：显示几条 / 共几条 / 按什么条件。
 * 旧版那排「放不下 N / 门 N / 重取列表」统计胶囊按设计稿删掉了，**但筛选说明不是统计**，
 * 它是「你刚才筛掉了什么」的唯一解释，不能一起删。
 *
 * ## 空态四种说法分开
 * 取数中 / 取不到 / 一份都没有 / 筛没了 / 回收站是空的 —— 下一步动作完全不同，混成一句会把人指错方向。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { api } from '../api.js';
import { go } from '../router.js';
import { caps as sessionCaps, me } from '../session.js';
import AccountBox from '../components/AccountBox.vue';
import DesignSchemeCard from '../components/DesignSchemeCard.vue';
import { createSchemeActions, reasonText } from '../admin/schemeActions.js';
import {
  filterSchemes, filterSummary, modelOptions, sortSchemes, statusCounts, statusLabel,
  SORTS, SORT_ORDER, SORT_LABEL,
} from '../admin/schemes.js';
import brandMark from '../assets/brand/brand-mark.png';
import './my-schemes.css';

/**
 * 能不能改方案。能力表读不到（`caps === null`：例如 `/api/admin/me` 那一趟没成）时**不装作禁止** ——
 * 按钮不禁用，写操作仍由服务端判。灰按钮只是提示，不是边界。
 */
const canWrite = computed(() => !sessionCaps.value || !!sessionCaps.value.writeSchemes);
const canAdmin = computed(() => !!(sessionCaps.value && sessionCaps.value.enterAdmin));
const role = computed(() => (me.value && me.value.roleCode) || '');

/** 每页方案数：新建卡占第 1 格，7 + 1 = 8 格；4 列下正好两行、末行不剩单卡（规格 §6.5） */
const PAGE_SCHEMES = 7;

const phase = ref('loading');
const rows = ref([]);
const trouble = ref('');

/** 要哪一半：方案库 | 回收站。没有回收站这一半，「恢复」就没有入口 */
const view = ref('library');
const trashCount = ref(null);
const filter = ref({ q: '', status: '', model: '' });
const sort = ref(SORTS.UPDATED);
const page = ref(1);

const statusTabs = computed(() => {
  const tabs = [{ code: '', label: '全部', count: rows.value.length, why: '全部方案：不分状态' }];
  for (const t of statusCounts(rows.value)) {
    tabs.push({ code: t.code, label: tabLabel(t.code), count: t.count, why: tabWhy(t.code) });
  }
  return tabs;
});
const models = computed(() => modelOptions(rows.value));
const shown = computed(() => filterSchemes(sortSchemes(rows.value, sort.value), filter.value));
const summaryText = computed(() => filterSummary(shown.value.length, rows.value.length, filter.value));
const filtering = computed(() => {
  const f = filter.value;
  return !!(String(f.q).trim() || String(f.status).trim() || String(f.model).trim());
});

const pageCount = computed(() => Math.max(1, Math.ceil(shown.value.length / PAGE_SCHEMES)));
const pageRows = computed(() => shown.value.slice((page.value - 1) * PAGE_SCHEMES, page.value * PAGE_SCHEMES));

/**
 * 页码窗口：真实库有 447 条回收站数据，若把 pageCount 全铺开会渲染 64 个按钮，
 * 把标题行和工具条挤到看不见。只在页数 > 7 时折叠：首尾 + 当前页左右各一页，中间用省略号；
 * 页码仍是真实页数，不伪造页数下限（规格要求每页 8 格，但没要求把所有页码都画出来）。
 */
const pageItems = computed(() => {
  const total = pageCount.value;
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const cur = page.value;
  const nums = new Set([1, total, cur - 1, cur, cur + 1]);
  if (cur <= 3) [2, 3, 4].forEach((n) => nums.add(n));
  if (cur >= total - 2) [total - 1, total - 2, total - 3].forEach((n) => nums.add(n));
  const sorted = [...nums].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
  const out = [];
  let prev = 0;
  for (const n of sorted) {
    if (prev && n - prev > 1) out.push('…');
    out.push(n);
    prev = n;
  }
  return out;
});

/**
 * 状态胶囊的**界面说法**按设计稿：draft → 未完成、delivered → 已完成。
 * 词表仍以 `admin/schemes.js` 的 `statusLabel` 为准；这里只做设计稿这一层的映射，
 * 未知状态不吞掉（照 `statusLabel` 的「未知（xxx）」显示），并把真实状态码写进 title。
 */
function tabLabel(code) {
  if (code === 'draft') return '未完成';
  if (code === 'delivered') return '已完成';
  return statusLabel(code);
}
function tabWhy(code) {
  if (code === 'draft') return '状态码 draft（' + statusLabel('draft') + '）：还没交付的方案';
  if (code === 'delivered') return '状态码 delivered（' + statusLabel('delivered') + '）：已交付的方案';
  return '状态码 ' + code + '（' + statusLabel(code) + '）';
}

function resetFilter() {
  filter.value = { q: '', status: '', model: '' };
}

function pickStatus(code) {
  filter.value.status = filter.value.status === code ? '' : code;
}

function gotoPage(p) {
  const n = Math.min(Math.max(1, Number(p) || 1), pageCount.value);
  page.value = n;
}

/** 筛选/排序变了就回第 1 页：留在第 3 页看一个只有 2 条的筛选结果，等于白屏 */
watch(() => [filter.value.q, filter.value.status, filter.value.model, sort.value], () => { page.value = 1; });
watch(pageCount, (n) => {
  if (page.value > n) page.value = n;
});

async function fetchList() {
  phase.value = 'loading';
  trouble.value = '';
  try {
    const list = await api.mySchemes(view.value === 'trash' ? { deleted: true } : undefined);
    rows.value = Array.isArray(list) ? list : [];
    phase.value = 'ok';
    page.value = 1;
  } catch (e) {
    phase.value = 'fail';
    trouble.value = reasonText(e);
  }
}

async function fetchTrashCount() {
  try {
    const t = await api.mySchemes({ deleted: true });
    trashCount.value = Array.isArray(t) ? t.length : null;
  } catch {
    trashCount.value = null;
  }
}

async function refresh() {
  await Promise.all([fetchList(), fetchTrashCount()]);
}

function switchView(next) {
  if (view.value === next) return;
  view.value = next;
  acts.resetTransient();
  refresh();
}

const acts = createSchemeActions(refresh);
const { busy, confirming, notice, drawer } = acts;

onMounted(refresh);
</script>

<template>
  <div class="my">
    <nav class="my__top">
      <!-- 品牌：整张横版组合标（图形与中英文名称都在图里），与首页/登录页同一张 -->
      <div class="my__brand">
        <img :src="brandMark" alt="场景空间设计器 · Scene Space Designer">
      </div>

      <div class="my__account">
        <!-- 维护端入口：与首页一致，只有能进维护端的账号才出现 -->
        <a v-if="canAdmin" class="my__admin" href="/admin" @click.prevent="go('/admin')">维护端</a>
        <AccountBox />
      </div>
    </nav>

    <main class="my__body">
      <div class="my__pane">
        <div class="my__head">
          <h1>我的全部方案</h1>
          <div class="my__head-ops">
            <button
              class="my__trash"
              type="button"
              :aria-pressed="view === 'trash'"
              :title="view === 'trash' ? '回到方案库（未删除的方案）' : '回收站：删过的方案都在这里，可以恢复'"
              @click="switchView(view === 'trash' ? 'library' : 'trash')"
            >
              <template v-if="view === 'trash'">← 返回方案库</template>
              <template v-else>回收站 <span v-if="trashCount !== null" class="my__trash-n">{{ trashCount }}</span></template>
            </button>
            <button class="my__back" type="button" @click="go('/index')">← 返回首页</button>
          </div>
        </div>

        <div v-if="phase === 'ok'" class="my__bar">
          <input
            v-model="filter.q"
            class="my__q"
            type="search"
            placeholder="搜方案名 / 型号 / 标签"
            aria-label="搜索方案名、型号或标签"
          >
          <button
            v-for="t in statusTabs"
            :key="t.code || 'all'"
            class="my__tab"
            :class="{ 'is-on': filter.status === t.code }"
            type="button"
            :aria-pressed="filter.status === t.code"
            :title="t.why"
            @click="pickStatus(t.code)"
          >{{ t.label }} <b>{{ t.count }}</b></button>

          <span class="my__spacer" />

          <label class="my__lab">型号
            <select v-model="filter.model" class="my__sel">
              <option value="">全部</option>
              <option v-for="m in models" :key="m" :value="m">{{ m }}</option>
            </select>
          </label>
          <label class="my__lab">排序
            <select v-model="sort" class="my__sel">
              <option v-for="k in SORT_ORDER" :key="k" :value="k">{{ SORT_LABEL[k] }}</option>
            </select>
          </label>
          <button v-if="filtering" class="my__clear" type="button" @click="resetFilter">清空条件</button>
        </div>

        <p v-if="phase === 'ok'" class="my__summary">{{ summaryText }}</p>

        <p v-if="view === 'trash'" class="my__note">
          这是<b>回收站</b>：这里的方案在方案库里<b>看不到</b>。唯一的动作是「恢复」。
        </p>

        <p v-if="notice" class="my__notice" :class="'my__notice--' + notice.kind">
          {{ notice.text }}
          <button class="my__notice-close" type="button" @click="notice = null">知道了</button>
        </p>

        <div class="my__grid">
          <!-- 第 1 格：新建大卡。回收站里不出现（那里不该有「新建」） -->
          <button v-if="view === 'library'" class="my__new" type="button" @click="go('/design/new')">
            <span class="my__plus" aria-hidden="true">+</span>
            <span class="my__new-text">新建场景空间设计方案</span>
          </button>

          <p v-if="phase === 'loading'" class="my__state">正在取方案列表…</p>
          <p v-else-if="phase === 'fail'" class="my__state my__state--bad">
            取不到方案列表：<span class="my__mono">{{ trouble }}</span>
            <button class="my__retry" type="button" @click="refresh">重试</button>
          </p>

          <p v-else-if="!rows.length && view === 'trash'" class="my__state">
            回收站是空的 —— 没有任何已删除的方案（删过的才会出现在这里）。
          </p>
          <p v-else-if="!rows.length" class="my__state">
            你还没有保存过方案 —— 点第一格那张卡开始。没有保存的改动只在这台浏览器里，不会出现在这一页。
          </p>
          <p v-else-if="!shown.length" class="my__state">
            这一组条件下没有方案（{{ summaryText }}）—— 换个条件看看。
          </p>

          <template v-else>
            <DesignSchemeCard
              v-for="r in pageRows"
              :key="r.id"
              :row="r"
              :view="view"
              :can-write="canWrite"
              :role="role"
              :busy="busy"
              :confirming="confirming"
              :drawer="drawer"
              @open="acts.openInDesigner"
              @ask-delete="acts.askDelete"
              @ask-rollback="acts.askRollback"
              @cancel="acts.cancelConfirm"
              @delete="acts.doDelete"
              @restore="acts.doRestore"
              @duplicate="acts.doDuplicate"
              @rollback="(p) => acts.doRollback(p.id, p.targetRev, p.expectRev)"
              @toggle-history="acts.toggleHistory"
            />
          </template>
        </div>

        <!-- 分页：只有一页时整条不显示（不足 8 格不显示分页） -->
        <nav v-if="phase === 'ok' && pageCount > 1" class="my__pager" aria-label="分页">
          <button class="my__pg" type="button" :disabled="page <= 1" @click="gotoPage(page - 1)">上一页</button>
          <template v-for="p in pageItems" :key="p">
            <span v-if="p === '…'" class="my__pg-gap" aria-hidden="true">…</span>
            <button
              v-else
              class="my__pg my__pg--num"
              :class="{ 'is-on': p === page }"
              type="button"
              :aria-current="p === page ? 'page' : null"
              :aria-label="'第 ' + p + ' 页'"
              @click="gotoPage(p)"
            >{{ p }}</button>
          </template>
          <button class="my__pg" type="button" :disabled="page >= pageCount" @click="gotoPage(page + 1)">下一页</button>
        </nav>
      </div>
    </main>
  </div>
</template>
