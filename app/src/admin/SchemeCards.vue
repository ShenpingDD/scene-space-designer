<script setup>
/**
 * SchemeCards —— 维护端 · 场景方案库（R6-3 3d 只读列表 → 3e 加四个写动作 → U1 改取数口径）
 *
 * ## 这一层管什么
 * 工具条、筛选、汇总、空态、二次确认与版本历史；卡片模板在 `components/SchemeCard.vue`
 * （「我的方案」页读同一份 —— 同一份方案在两处显示成两个样子，读的人会以为在看两份东西）。
 *
 * ## U1 改了什么：取数换成「全部账号的」
 * 这一页现在读 `GET /api/admin/schemes`（`api.adminSchemes`，门 `canMaintain`），
 * 卡片上多一列归属人。`GET /api/schemes` 从 U1 起只回**自己的**方案 ——
 * 维护端再读它就只看得见自己建的，而"谁建的"这一列也就无从谈起。
 *
 * ## 四个硬规矩（3d 就有，一个都不能松）
 * ① **数据从哪来要说出来**：后端不通时不许显示成「没有方案」（判据 5「怕安静」）；
 *    还要说清这一页是**方案库**还是**回收站** —— 两半是两件事。
 * ② **筛选绝不静默**：常驻「显示 N / 共 M 份（条件：…）」—— 一次说全所有条件。
 * ③ **角标要能问**：`title` 里必须有「为什么判它是这样」。
 * ④ **缺数据不补**：封面 / 人名 / 台数 / 型号在老数据上就是空的 → 占位与「—」，不假渲不补名。
 *
 * ## 3e 起的两条
 * ⑤ **写库的动作不许安静**：成功也要说话，而且要说清**做了什么**（复制要说清它来自哪一份哪一版；
 *    回滚要说清「回滚前那一版是本来就有、还是刚补存的」—— 后者是用户拍板的 A1，不说他就不道）。
 * ⑥ **不可逆的动作要二次确认，并在确认里把后果说出来**：删除会进回收站，
 *    回滚会把内容换成旧版本（但会先自动留存）。
 */
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.js';
import SchemeCard from '../components/SchemeCard.vue';
import { createSchemeActions, reasonText } from './schemeActions.js';
import { storeLabel } from './view.js';
import {
  filterSchemes, filterSummary, modelOptions, sortSchemes, statusCounts,
  summarizeCards, cardOf, SORTS, SORT_ORDER, SORT_LABEL,
} from './schemes.js';

const props = defineProps({
  /**
   * 数据来源档位（来自 AdminApp 已经问过的 `adminMe()`）。
   * 为什么不自己再问一次：同一个问题问两遍，两处迟早会给出不一样的说法。
   */
  store: { type: String, default: '' },
  /** `/api/admin/me` 发下来的能力表（R6-4 B4e）—— 写动作的可用状态跟着它走 */
  caps: { type: Object, default: () => ({}) },
  /** 角色码，只说人话用 */
  role: { type: String, default: '' },
});

/** 能不能改方案（后端 `AdminGate.canWriteSchemes` 的结果）。**灰按钮 + 说明为什么**，不隐藏 */
const canWrite = computed(() => !!props.caps.writeSchemes);

/** loading | ok | fail —— 三态都要有话说 */
const phase = ref('loading');
const rows = ref([]);
const trouble = ref('');

/** 要哪一半：`library`（方案库）| `trash`（回收站）。两半是同一件事的两半（同一端点、同一参数） */
const view = ref('library');
/** 回收站里有多少份。null = 问不到（那就不显示数字，不拿 0 冒充「空」） */
const trashCount = ref(null);
/** 筛选条件（空 = 不筛）。**排序与筛选分开**：排序与筛选混在一起，说明文字会撒谎 */
const filter = ref({ q: '', status: '', model: '' });
const sort = ref(SORTS.UPDATED);

const stats = computed(() => summarizeCards(rows.value.map(cardOf)));
const statusTabs = computed(() => statusCounts(rows.value));
const models = computed(() => modelOptions(rows.value));

/** 排序在筛选**之前**：先按用户选的维度排好，再筛 —— 筛只让结果少几张，不改顺序 */
const shown = computed(() => filterSchemes(sortSchemes(rows.value, sort.value), filter.value));
const summaryText = computed(() => filterSummary(shown.value.length, rows.value.length, filter.value));

/** 有没有在筛（决定"空"的两种说法要不要分开） */
const filtering = computed(() => {
  const f = filter.value;
  return !!(String(f.q).trim() || String(f.status).trim() || String(f.model).trim());
});

function resetFilter() {
  filter.value = { q: '', status: '', model: '' };
}

async function fetchList() {
  phase.value = 'loading';
  trouble.value = '';
  try {
    // 要哪一半由**数据参数**说，不由「我在哪个标签页」推断（见 view 的注释）
    const list = await api.adminSchemes(view.value === 'trash' ? { deleted: true } : undefined);
    rows.value = Array.isArray(list) ? list : [];
    phase.value = 'ok';
  } catch (e) {
    phase.value = 'fail';
    trouble.value = reasonText(e);
  }
}

/**
 * 回收站里有几份 —— 单独问一次。
 *
 * 为什么值得多一次请求：进回收站之前，用户真正想知道的是「里面有没有东西」。
 * 问不到就显示不出来（`null`），**不拿 0 冒充空** —— 跟「缺数据不补」是同一条。
 */
async function fetchTrashCount() {
  try {
    const t = await api.adminSchemes({ deleted: true });
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
  // 换半边时要收掉与"某一份"绑定的临时界面：确认框和展开的历史都属于上一半里的某一份
  acts.resetTransient();
  refresh();
}

const acts = createSchemeActions(refresh);
const { busy, confirming, notice, drawer } = acts;

onMounted(refresh);
</script>

<template>
  <div class="sl">
    <!-- 汇总：每条数字都写单位「份」—— 方案份数与体检角标数是两种东西，混着写一定会被误读 -->
    <div class="pl__sum">
      <!-- 这两半的说法必须不同：把回收站里的份数写成「共 N 份方案」会让人以为方案库变多了 -->
      <span class="pl__total">
        <template v-if="view === 'trash'">回收站 <b>{{ stats.total }}</b> 份（已删除）</template>
        <template v-else>共 <b>{{ stats.total }}</b> 份方案（全部账号）</template>
      </span>
      <span class="pl__k pl__k--bad" title="有设备放不下（越界 / 占地重叠 / 压内墙）">放不下 {{ stats.bad }} 份</span>
      <span class="pl__k pl__k--warn" title="门开不到 90° —— 摆得下，但用起来别扭">门 {{ stats.warn }} 份</span>
      <span class="pl__spacer" />
      <span class="pl__src">{{ storeLabel(props.store) }}</span>
      <nav class="sl__view">
        <button :aria-pressed="view === 'library'" @click="switchView('library')">方案库</button>
        <button :aria-pressed="view === 'trash'" @click="switchView('trash')">
          回收站<template v-if="trashCount !== null"> <span class="pl__n">{{ trashCount }}</span></template>
        </button>
      </nav>
      <button class="adm__btn" :disabled="phase === 'loading'" @click="refresh">
        {{ phase === 'loading' ? '取数中…' : '重取列表' }}
      </button>
    </div>

    <p v-if="view === 'trash'" class="sl__note sl__note--view">
      这是<b>回收站</b>：这里的方案在前台与方案库里<b>都看不到</b>。唯一的动作是「恢复」。
      <b>彻底删除不在本批</b>（回收站里的东西不会自己消失）—— 说清边界，免得有人找不到删除键而乱猜。
    </p>

    <p v-if="phase === 'loading'" class="pl__msg">正在取方案列表…</p>
    <p v-else-if="phase === 'fail'" class="pl__msg pl__msg--bad">
      取不到方案列表：<span class="adm__mono">{{ trouble }}</span>
      <button class="adm__btn" @click="refresh">重试</button>
    </p>

    <template v-else>
      <nav class="pl__filter sl__bar">
        <!-- 文本：搜什么必须写出来（"搜不到"要能问出为什么）—— 刻意不搜 id，见 schemes.js -->
        <input
          v-model="filter.q"
          class="sl__q"
          type="search"
          placeholder="搜方案名 / 型号 / 标签"
          aria-label="搜索方案名、型号或标签"
        >
        <button
          v-for="t in statusTabs"
          :key="t.code"
          :aria-pressed="filter.status === t.code"
          @click="filter.status = filter.status === t.code ? '' : t.code"
        >{{ t.label }} <span class="pl__n">{{ t.count }}</span></button>
        <span class="pl__spacer" />
        <label class="sl__lab">含型号
          <select v-model="filter.model" class="sl__sel">
            <option value="">全部</option>
            <option v-for="m in models" :key="m" :value="m">{{ m }}</option>
          </select>
        </label>
        <label class="sl__lab">排序
          <select v-model="sort" class="sl__sel">
            <option v-for="k in SORT_ORDER" :key="k" :value="k">{{ SORT_LABEL[k] }}</option>
          </select>
        </label>
        <button v-if="filtering" class="adm__btn adm__btn--ghost" @click="resetFilter">清空条件</button>
      </nav>

      <!-- 筛选绝不静默：常驻「显示 N / 共 M 份（条件：…）」，一次说全所有条件 -->
      <p class="sl__summary adm__mono">{{ summaryText }}</p>

      <!-- 上一次动作的结果。**成功也留着**（用户可能刚点完就去接电话了，回来看得见发生了什么） -->
      <p v-if="notice" class="sl__notice" :class="'sl__notice--' + notice.kind">
        {{ notice.text }}
        <button class="adm__btn adm__btn--ghost" @click="notice = null">知道了</button>
      </p>

      <!-- 「一份都没有」和「筛没了」是两件事 —— 分开说，否则用户会去改数据库 -->
      <p v-if="!rows.length && view === 'library'" class="pl__msg">
        库里一份方案都没有（现在没有任何条件在筛）。
      </p>
      <p v-else-if="!rows.length" class="pl__msg">
        回收站是空的 —— 没有任何已删除的方案（删过的才会出现在这里）。
      </p>
      <p v-else-if="!shown.length" class="pl__msg">
        这一组条件下没有方案（<span class="adm__mono">{{ summaryText }}</span>）—— 换个条件看看。
      </p>

      <div v-else class="sl__grid">
        <SchemeCard
          v-for="r in shown"
          :key="r.id"
          :row="r"
          :view="view"
          :can-write="canWrite"
          :role="props.role"
          :busy="busy"
          :confirming="confirming"
          :drawer="drawer"
          show-owner
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
      </div>

      <!-- 说清这一批的边界：哪些能做、哪些**还**不能做（说了边界，人就不用猜也不用试） -->
      <p class="sl__note">
        这一批能做：<b>删除</b>（进回收站）/ <b>恢复</b> / <b>复制一份</b> / <b>版本回滚</b>。
        还不在这一批：<b>彻底删除</b>、<b>导出</b>与<b>只读分享</b>（归 R6-5）、封面（3f）。
        版本回滚按拍板 A1 执行：<b>回滚前会先把当前那一版自动留存一版</b>，所以回滚是可以反悔的。
      </p>
    </template>
  </div>
</template>
