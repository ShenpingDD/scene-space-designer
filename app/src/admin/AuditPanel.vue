<template>
  <section class="ap">
    <header class="ap__head">
      <h2 class="ap__title">参数审计</h2>
      <p class="ap__why">
        参数一改，全场的判定标准就跟着变 —— 这一页回答「<b>谁、什么时候、把哪一项从多少改成多少、为什么</b>」。
        留痕由发布那一刻自动写下，改不了也删不掉。
      </p>
      <p v-if="trouble" class="ap__trouble">读不到留痕：{{ trouble }}</p>
      <p v-else-if="loading" class="ap__loading">正在读留痕…</p>
    </header>

    <!-- 条件区：**条件句常驻**（见 audit.js 的三条纪律） -->
    <div class="ap__filter">
      <label class="ap__f">
        <span>从</span>
        <input v-model="cond.from" type="date" class="ap__input" @change="refetch(0)" />
      </label>
      <label class="ap__f">
        <span>到</span>
        <input v-model="cond.to" type="date" class="ap__input" @change="refetch(0)" />
      </label>
      <label class="ap__f ap__f--wide">
        <span>项</span>
        <select v-model="cond.key" class="ap__input" @change="refetch(0)">
          <option value="">全部（{{ schema.flat ? schema.flat.length : 0 }} 项）</option>
          <option v-for="e in schema.flat" :key="e.path" :value="e.path">{{ e.label }}（{{ e.path }}）</option>
        </select>
      </label>
      <label class="ap__f">
        <span>人</span>
        <select v-model="cond.by" class="ap__input" @change="onPickBy">
          <option value="">全部</option>
          <option v-for="p in people" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select>
      </label>
      <button class="ap__btn" :disabled="loading" @click="refetch(0)">重取</button>
      <button class="ap__btn ap__btn--ghost" :disabled="loading || !filtered" @click="clearCond">清空条件</button>
    </div>

    <p class="ap__cond">
      {{ line }}
      <span v-if="filtered" class="ap__cond-hint">（筛掉的不在下面 —— 清空条件能看到全部）</span>
    </p>

    <!-- 表：一屏一行一条留痕 -->
    <div v-if="rows.length" class="ap__table">
      <div class="ap__thead">
        <span>什么时候</span><span>改的是哪一项</span><span>前后值</span><span>谁</span><span>为什么</span>
      </div>
      <button
        v-for="r in rows"
        :key="r.id"
        class="ap__row"
        :class="{ 'is-open': openId === r.id }"
        :aria-expanded="openId === r.id ? 'true' : 'false'"
        @click="toggle(r)"
      >
        <span class="ap__c-time">{{ timeText(r.changedAt) }}</span>
        <span class="ap__c-key">{{ keyLabel(r.key, index) }}</span>
        <span class="ap__c-val">{{ changeText(r, unitOf(r.key, index)) }}</span>
        <span class="ap__c-by">{{ byText(r) }}</span>
        <span class="ap__c-note" :class="{ 'is-empty': !r.note }">{{ noteText(r) }}</span>
      </button>
    </div>

    <p v-else-if="!loading && !trouble" class="ap__empty">{{ emptyLine }}</p>

    <!-- 翻页 -->
    <div v-if="total > PAGE" class="ap__pager">
      <button class="ap__btn ap__btn--ghost" :disabled="offset <= 0 || loading" @click="refetch(offset - PAGE)">
        上一页
      </button>
      <span class="ap__pages">{{ pageLine }}</span>
      <button
        class="ap__btn ap__btn--ghost"
        :disabled="offset + PAGE >= total || loading"
        @click="refetch(offset + PAGE)"
      >下一页</button>
    </div>

    <!-- 详情：**接口按条取**（列表不带那 34 项的全量快照） -->
    <section v-if="openId" class="ap__detail">
      <header class="ap__dhead">
        <h3 class="ap__dtitle">留痕 #{{ openId }} 的详情</h3>
        <button class="ap__btn ap__btn--ghost" @click="closeDetail">收起</button>
      </header>
      <p v-if="detailLoading" class="ap__loading">正在读这一条…</p>
      <p v-else-if="detailTrouble" class="ap__trouble">读不到这一条：{{ detailTrouble }}</p>
      <template v-else-if="detail">
        <p v-if="detail.found === false" class="ap__empty">
          这一条不在了（可能是另一个页面刚把它清掉了）。列表里还留着，是因为刚才读的是同一批数据。
        </p>
        <template v-else>
          <dl class="ap__dl">
            <dt>什么时候</dt><dd>{{ timeText(detail.changedAt) }}</dd>
            <dt>改的是哪一项</dt><dd>{{ keyLabel(detail.key, index) }}</dd>
            <dt>前后值</dt><dd>{{ changeText(detail, unitOf(detail.key, index)) }}</dd>
            <dt>谁</dt><dd>{{ byText(detail) }}</dd>
            <dt>为什么</dt><dd>{{ noteText(detail) }}</dd>
            <dt>改完之后的参数版本</dt><dd class="ap__mono">{{ detail.rev }}</dd>
          </dl>
          <p class="ap__snapnote">
            下面是<b>改完那一刻的全部 {{ snapRows.length }} 项</b>（简称"全量快照"）——
            已存方案要复现"当时是按哪版参数判的"，靠的就是它。高亮的那一行是这次改的。
          </p>
          <p v-for="bad in snapMismatch" :key="bad.path" class="ap__mismatch">
            ⚠️ 快照里 <b>{{ bad.label }}</b> 是 {{ bad.value }}，而留痕记的是 {{ bad.expected }} —— 两处对不上，
            说明写留痕与写快照的那段代码有问题（正常永远不该出现）。
          </p>
          <ul class="ap__snap">
            <li v-for="s in snapRows" :key="s.path" :class="{ 'is-changed': s.changed }">
              <span class="ap__s-label">{{ s.label }}</span>
              <span class="ap__s-value ap__mono">{{ s.value }}</span>
            </li>
          </ul>
        </template>
      </template>
    </section>
  </section>
</template>

<script setup>
import { computed, onMounted, reactive, ref } from 'vue';
import { api } from '../api.js';
import {
  byText, changeText, emptyText, filterLine, isFiltered, keyLabel, noteText,
  pageText, schemaIndex, snapshotRows, timeText, unitOf,
} from './audit.js';

/**
 * 一页几条。
 *
 * ⚠️ 名字必须和模板里用的**一模一样**：模板引用一个不存在的名字**不会报错**
 *    （求值成 undefined），只是那个  永远为假 —— 症状是「下一页」整块**根本不存在**，
 *    而界面看着一切正常。B4c 的探针就是这么抓到的（见 docs/39）。
 */
const PAGE = 20;

const loading = ref(false);
const trouble = ref('');
const rows = ref([]);
const total = ref(0);
const offset = ref(0);
const schema = ref({});
const people = ref([]);
const allTotal = ref(null);

const openId = ref(0);
const detail = ref(null);
const detailLoading = ref(false);
const detailTrouble = ref('');

/** 条件**只存字符串**（日期/项/人各一个），原样发给后端；后端读不懂会明确报 400 */
const cond = reactive({ from: '', to: '', key: '', by: '', byName: '' });

const index = computed(() => schemaIndex(schema.value));
const filtered = computed(() => isFiltered(cond));
const line = computed(() => filterLine(cond, rows.value.length, total.value, index.value));
const emptyLine = computed(() => emptyText(cond, allTotal.value));
const pageLine = computed(() => pageText(offset.value, PAGE, total.value));
const snapRows = computed(() => (detail.value ? snapshotRows(detail.value.snapshot, schema.value, detail.value) : []));
const snapMismatch = computed(() => snapRows.value.filter((s) => s.mismatch));

async function refetch(next) {
  loading.value = true;
  trouble.value = '';
  try {
    const q = { limit: PAGE, offset: Math.max(0, next) };
    if (cond.from) q.from = cond.from;
    if (cond.to) q.to = cond.to;
    if (cond.key) q.key = cond.key;
    if (cond.by) q.by = cond.by;
    const res = await api.paramsRevisions(q);
    rows.value = res.rows || [];
    total.value = typeof res.total === 'number' ? res.total : rows.value.length;
    offset.value = q.offset;
  } catch (e) {
    // 400（时间读不懂）也走这里：**把后端原话显示出来**，不吞掉
    trouble.value = (e && (e.reason ? e.message || e.reason : e.message)) || '未知原因';
  } finally {
    loading.value = false;      // 转圈必须有人关（成功、失败两条路都要关）
  }
}

/** 拉一次不带条件的（**只在首次**）：fill 条件下拉 + 记住"一共多少条"，给空态用 */
async function seed() {
  try {
    const res = await api.paramsRevisions({ limit: PAGE, offset: 0 });
    allTotal.value = typeof res.total === 'number' ? res.total : null;
    const seen = new Map();
    for (const r of res.rows || []) {
      const id = r.changedBy ? String(r.changedBy) : '';
      if (!id || seen.has(id)) continue;
      seen.set(id, { id, name: byText(r) });
    }
    people.value = [...seen.values()];
  } catch {
    // 种子没取到不影响正事：条件下拉空着、空态会说"去掉条件再看看"
  }
}

function onPickBy() {
  const hit = people.value.find((p) => p.id === cond.by);
  cond.byName = hit ? hit.name : '';
  refetch(0);
}

function clearCond() {
  cond.from = ''; cond.to = ''; cond.key = ''; cond.by = ''; cond.byName = '';
  refetch(0);
  seed();      // 条件清空 → 重新记一次"一共多少条"
}

async function toggle(r) {
  if (openId.value === r.id) {
    closeDetail();
    return;
  }
  openId.value = r.id;
  detail.value = null;
  detailTrouble.value = '';
  detailLoading.value = true;
  try {
    detail.value = await api.paramsRevision(r.id);
  } catch (e) {
    detailTrouble.value = (e && (e.reason || e.message)) || '未知原因';
  } finally {
    detailLoading.value = false;
  }
}

function closeDetail() {
  openId.value = 0;
  detail.value = null;
  detailTrouble.value = '';
}

onMounted(async () => {
  try {
    const p = await api.params();
    schema.value = p.schema || {};
  } catch {
    // 规格取不到 → 项就只能显示路径（`keyLabel` 认不出就原样给路径）。
    // **这里故意不报错**：审计本身还能看，而"项的名字"只是锦上添花。
  }
  await seed();
  await refetch(0);
});
</script>