<script setup>
/**
 * SystemPanel —— 维护端 · 系统状态（R6-1 Step4）
 *
 * ## 这一页要回答一个问题：「这套东西现在是什么状态」
 * 所以上面每一个数都必须是**能被核对**的（不是"感觉还行"）：各有多少对象、占多少盘、
 * LOD 出齐没有、迁移到哪一版了。**数错了比页面难看严重得多** —— 这一页是拿来下判断的。
 *
 * ## 它已经挣回自己一次
 * 第一版跑出来就报「4 个模型里只有 2 个出齐 3 层」—— 之前没人知道这件事。
 * 所以下面 LOD 那一块**不只报总数，还要点名**（哪几个型号缺层），否则管理员只知道"有问题"
 * 却不知道"该动谁"。
 *
 * ## 两个如实
 * ① 缩略图占用是 **0 B** —— 不是漏了，是真还没有服务端真图（前台靠现渲染兜底）。
 *    显示成 0 B 比编一个好看的数字有用。
 * ② 参数行 34 条已经住在库里的 `app_config`，但**编辑界面还没有**（R6-4）——
 *    写清楚"已有什么/还没有什么"，比让人以为这就能改要诚实。
 */
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.js';
import { formatBytes, lodCoverage, migrationLabel } from './format.js';

const phase = ref('loading');     // loading | ok | fail
const system = ref(null);
const trouble = ref('');

const counts = computed(() => (system.value && system.value.counts) || {});
const disk = computed(() => (system.value && system.value.disk) || {});
const lod = computed(() => lodCoverage(system.value && system.value.lod));
const migrations = computed(() => {
  const m = system.value && system.value.migrations;
  return Array.isArray(m) ? m.slice().reverse() : [];   // 最近的排最前
});

/** 计数面板：每格都写清"这个数是什么口径"（含不含停用、单位是什么） */
const tiles = computed(() => {
  const c = counts.value;
  return [
    { k: '产品', v: c.products, hint: '含停用 —— 维护端一条都不滤（前台目录只给启用的）' },
    { k: '其中已停用', v: c.products_disabled, hint: c.products_active + ' 款启用中' },
    { k: '模型变体', v: c.models, hint: (c.models_with_file || 0) + ' 个有 GLB 文件' },
    { k: '方案', v: c.schemes, hint: '未删 ' + (c.schemes_live || 0) + ' 个' },
    { k: '方案版本记录', v: c.revisions, hint: '每次保存留一版（可回溯）' },
    { k: '产品说明条目', v: c.notes, hint: 'product_note，前台型号卡下面那几行' },
    { k: '参数行', v: c.config_rows, hint: 'app_config —— 已入库，编辑界面是 R6-4' },
    { k: '用户', v: c.users, hint: '单租户：本机一行（认证未接，见 G1）' },
  ];
});

/** 迁移行：把"可重复迁移没有版本号"这件事在界面上解释掉，而不是让人以为数据坏了 */
function migVersion(m) {
  const v = m && m.version;
  return v === null || v === undefined || String(v).trim() === '' ? 'R__' : 'V' + v;
}
const isRepeatable = (m) => {
  const v = m && m.version;
  return v === null || v === undefined || String(v).trim() === '';
};

const usage = ref(null);          // 型号使用情况（R6-5 验收判据③：从未被使用的型号要查得出来）
const usageTrouble = ref('');

async function fetchSystem() {
  phase.value = 'loading';
  trouble.value = '';
  try {
    system.value = await api.adminSystem();
    phase.value = 'ok';
  } catch (e) {
    phase.value = 'fail';
    trouble.value = (e && e.reason ? e.reason + '：' : '') + (e && e.message ? e.message : '未知原因');
  }
}

/**
 * 型号使用情况单独拉、单独报错。
 *
 * **不并进 `fetchSystem()`**：它是两张不同的表（系统状态 vs 目录使用），
 * 合并的话，其中一边读不出来会把另一边一起变成"整页失败"—— 而它们本来互不相干。
 */
async function fetchUsage() {
  usageTrouble.value = '';
  try {
    usage.value = await api.adminProductUsage();
  } catch (e) {
    usageTrouble.value = (e && e.reason ? e.reason + '：' : '') + (e && e.message ? e.message : '未知原因');
  }
}

onMounted(fetchSystem);
onMounted(fetchUsage);
</script>

<template>
  <div class="sys">
    <p v-if="phase === 'loading'" class="pl__msg">正在取系统状态…</p>
    <p v-else-if="phase === 'fail'" class="pl__msg pl__msg--bad">
      取不到系统状态：<span class="adm__mono">{{ trouble }}</span>
      <button class="adm__btn" @click="fetchSystem">重试</button>
    </p>

    <template v-else-if="system && system.available === false">
      <p class="pl__msg pl__msg--bad">{{ system.hint }}</p>
    </template>

    <template v-else>
      <h3 class="sys__h">对象计数</h3>
      <div class="sys__grid">
        <div v-for="t in tiles" :key="t.k" class="tile" :title="t.hint">
          <span class="tile__k">{{ t.k }}</span>
          <b class="tile__v">{{ t.v }}</b>
          <span class="tile__h">{{ t.hint }}</span>
        </div>
      </div>

      <h3 class="sys__h">磁盘占用</h3>
      <div class="sys__row">
        <span>模型文件</span><b>{{ formatBytes(disk.model_bytes) }}</b>
        <span class="sys__sep">·</span>
        <span>缩略图</span><b>{{ formatBytes(disk.thumb_bytes) }}</b>
        <span class="sys__note">
          {{ disk.thumb_bytes ? '' : '缩略图 0 B 是如实：还没有服务端真图，前台靠现渲染兜底（不乱报一个好看的数字）' }}
        </span>
      </div>

      <h3 class="sys__h">
        LOD 层数
        <span class="sys__pill" :class="lod.ok ? 'is-ok' : 'is-warn'">
          {{ lod.ok ? (lod.byDesign ? '全部达标（含按设计少出）' : '全部出齐 3 层') : '有模型缺层' }}
        </span>
      </h3>
      <div class="sys__row">
        <span>模型</span><b>{{ lod.models }}</b>
        <span class="sys__sep">·</span>
        <span>达标</span><b>{{ lod.full }}</b>
        <template v-if="lod.byDesign">
          <span class="sys__sep">·</span>
          <span>其中按设计少出</span><b>{{ lod.byDesign }}</b>
        </template>
        <!-- 插值里放标签不会生效（会被当文本），所以这里只用纯文字 -->
        <span class="sys__note">
          {{ lod.byDesign
            ? '「按设计少出」不是毛病：压缩到模型自身的三角形下限后，再粗化得到的是同一个文件，管线故意不出这一级（免得白送一个重复文件）。判据（等效于哪一级 + 多少面）已连同模型一起入库，可核对'
            : '少一层 LOD 在老机器上会明显卡 —— 所以要出齐，不只是「能跑」' }}
        </span>
      </div>
      <ul v-if="lod.thin.length" class="sys__list">
        <li v-for="t in lod.thin" :key="t.product_id + ':' + t.variant">
          <b class="adm__mono">{{ t.model_no }}</b>
          <span class="sys__dim">{{ t.name }}</span>
          <span class="sys__bad">缺 {{ t.missing }} 级（文件 {{ t.level_count }} + 按设计跳过 {{ t.skipped_count }}）</span>
        </li>
      </ul>

      <h3 class="sys__h">数据库迁移</h3>
      <div class="sys__row">
        <span>当前版本</span><b class="adm__mono">{{ migrationLabel(system) }}</b>
      </div>
      <ul class="sys__list sys__list--mig">
        <li v-for="(m, i) in migrations" :key="i">
          <b class="adm__mono sys__ver">{{ migVersion(m) }}</b>
          <span class="adm__mono sys__dim">{{ m.description }}</span>
          <span v-if="isRepeatable(m)" class="sys__tag" title="可重复迁移：每次启动/内容变化都会重跑，所以它没有版本号，也总排在最后">可重复</span>
          <span class="sys__ok" :class="{ 'is-bad': !m.success }">{{ m.success ? '成功' : '失败' }}</span>
        </li>
      </ul>
      <h3 class="sys__h">型号使用情况</h3>
      <p v-if="usageTrouble" class="pl__msg pl__msg--bad">读使用情况失败：{{ usageTrouble }}</p>
      <template v-else-if="usage">
        <div class="sys__row">
          <span>目录里共</span><b>{{ usage.total }}</b>
          <span class="sys__dim">款（目录来源：{{ usage.catalogOrigin }}）</span>
        </div>
        <p v-if="usage.neverUsed.length" class="sys__dim">
          下面 {{ usage.neverUsed.length }} 款**从来没有被摆进过任何方案** —— 要么补文案与示例，要么下架（这一列才是这张表存在的理由）：
        </p>
        <p v-else class="sys__dim">目录里的每一款都至少被用过一次。</p>
        <ul class="sys__list">
          <li v-for="m in usage.neverUsed" :key="'n' + m.id">
            <b class="adm__mono">{{ m.model || m.id }}</b>
            <span class="sys__dim">{{ m.name }}</span>
            <span class="sys__bad">从未使用</span>
          </li>
          <li v-for="m in usage.models" :key="'u' + m.id">
            <b class="adm__mono">{{ m.model || m.id }}</b>
            <span class="sys__dim">{{ m.name }}</span>
            <span class="sys__ok">用过 {{ m.uses }} 次</span>
            <span v-if="!m.inCatalog" class="sys__bad">（目录里已经没有这一款，方案里还在用）</span>
          </li>
        </ul>
      </template>
    </template>
  </div>
</template>
