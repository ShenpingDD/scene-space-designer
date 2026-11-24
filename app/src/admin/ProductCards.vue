<script setup>
/**
 * ProductCards —— 维护端 · 产品列表（R6-1 Step3，只读 + 角标分诊）
 *
 * ## 列表的价值是分诊，不是展示
 * 所以这张卡片上最重要的东西**不是**名字和图片，是右上角那几个角标：
 * 它回答"哪条该我动手"。数字在上方汇总，一条一行也不许漏。
 *
 * ## 三件必须说清楚的事
 * ① **数据从哪来**：后端不通 / memory 档时要说出来，不许显示成"没有产品"（判据 5「怕安静」）。
 * ② **筛选不许静默**：筛选时永远同时显示"显示 N / 共 M 款"，否则用户以为产品就这么几个。
 * ③ **角标要能问**：鼠标停在角标上必须能看到"为什么判它是这样"（why），
 *    否则管理员只能选择相信或不信 —— 而他会选择不信。
 *
 * ## 缩略图：复用前台那条已经验过的路
 * 用 thumbs.js 的 thumbFor（三级来源：服务端真图 → sessionStorage → 现渲染）。
 * 传进去的必须是**目录形状**的商品，所以用 recipeId 去 getProduct 取一次 ——
 * 维护端与前台看到的是**同一个模型、同一套灯光**（不然两边图片不一样会很难解释）。
 * 渲染照抄前台那道防串台闸：列表换了一轮，上一轮的图绝不能贴上来。
 */
import { computed, onMounted, ref } from 'vue';
import { api } from '../api.js';
import { getProduct } from '../catalog.js';
import { doorPartLabel } from '../kernel.js';
import { thumbFor } from '../thumbs.js';
import {
  FILTERS, summarize, visible, storeLabel,
  statusLabel, statusActionLabel, statusConfirmLines, nextStatus, STATUS,
} from './view.js';
import { denyText } from './roles.js';
import { go } from '../router.js';
// 「最近谁改的」这一列**只有一种口径**（req-6）：方案卡片一直用 `actorLabel`
// （空的显示「—」、认得的翻成人话、不认识的原样带 # 号），产品卡片过去直接印原始值 ——
// 同一列两种显示法，读的人会以为它们在说两件事。共用一个函数，只有一处定义。
import { actorLabel } from './schemes.js';

/**
 * 能力门（B4e/B4f）：能不能写由**服务端给的能力表**定，界面不抄对照表。
 * `caps` 为 null = 还没读到（后端不通）—— 那时**不禁用**但要把这句话说出来：
 * 真正的闸在服务端，界面装作禁止会让人以为功能坏了。
 */
const props = defineProps({
  caps: { type: Object, default: null },
  role: { type: String, default: '' },
});
const canMaintain = computed(() => (props.caps ? !!props.caps.maintain : null));
const noMaintainText = computed(() => (canMaintain.value === false ? denyText('maintain', props.role) : ''));

/** loading | ok | fail —— 三态都要有话说 */
const phase = ref('loading');
const products = ref([]);
const store = ref('');
const trouble = ref('');
const filter = ref(FILTERS.ALL);

const thumbs = ref({});
let thumbRun = 0;

/**
 * 停用 / 启用的就地确认（req-1）。
 *
 * 为什么不用弹窗：这一步要在**看清是哪一款**的前提下做，弹窗把列表盖住恰好让人看不清；
 * 而且这一档操作要的只是一次显式确认 + 后果说明（不是表单）。
 */
const confirming = ref(0);        // 正在等确认的产品 id（0 = 没有）
const changing = ref(0);          // 正在请求的产品 id
const notes = ref({});            // 每条一句话备注 → 进 audit_log
const actTrouble = ref({});       // 每条自己的失败原因（别把整张列表都说成坏了）
// 删除是**二次确认**后才发请求；deleteTrouble 与状态切换分开，避免一句失败把两件事混在一起。
const deleteConfirm = ref(0);
const deleting = ref(0);
const deleteTrouble = ref({});

const stats = computed(() => summarize(products.value));
const shown = computed(() => visible(products.value, filter.value));

const FILTER_TABS = [
  { key: FILTERS.ALL, label: '全部' },
  { key: FILTERS.BAD, label: '必须修' },
  { key: FILTERS.WARN, label: '该修' },
  { key: FILTERS.OFF, label: '已停用' },
];

const countOf = (key) => {
  if (key === FILTERS.ALL) return stats.value.total;
  if (key === FILTERS.BAD) return stats.value.bad;
  if (key === FILTERS.WARN) return stats.value.warn;
  return stats.value.off;
};

/** 标注看板状态：后端有 hotspotStatus/contentStatus 就用它，否则按 hasDetail 说人话 */
function hotspotState(p) {
  const raw = (p && (p.hotspotStatus || p.contentStatus)) || '';
  if (raw === 'published' || raw === 'active') return 'published';
  if (raw === 'failed' || raw === 'publish-failed') return 'failed';
  if (raw === 'draft' || raw === 'saved') return 'draft';
  // 后端显式给 none 时不许再用 hasDetail 猜成 published：老产品有简介但没标注，
  // 显示成“已发布”会让维护员以为热点已经存在。
  if (raw === 'none') return 'none';
  return (p && p.hasDetail) ? 'published' : 'none';
}
const HOTSPOT_LABEL = { published: '已发布', failed: '发布失败', draft: '未发布', none: '未标注' };
const hotspotLabel = (p) => HOTSPOT_LABEL[hotspotState(p)] || '未标注';
const hotspotCount = (p) => {
  const n = Number(p && (p.hotspotCount ?? p.hotspots));
  return Number.isFinite(n) ? n : null;
};

/**
 * 「＋ 加一个变体」按钮的提示语（B5）。放脚本里而不是模板里，有两个理由：
 *   ① 模板里那句要拼三截（含上一次的 LOD 失败原因）→ 拆行后**每一行都引号不成对**，
 *      而 `check-quotes.py` 是按行看的；
 *   ② 它是有内容的**判断**（“为什么值得加”“上一回为什么失败”），该与渲染分开。
 */
function variantHint(p) {
  if (noMaintainText.value) return noMaintainText.value;
  const bad = (p.variants || []).filter((v) => v.lodError);
  const base = '给这一款再加一份模型：产品字段一个都不改（型号/尺寸/门型是产品事实），已摆好的方案几何不受影响';
  if (!bad.length) return base;
  return base + '。上一次的 LOD 失败原因：' + bad.map((v) => v.variant + '：' + v.lodError).join('；');
}

/** 维护端卡片 → 目录形状（thumbFor 与门型标签都按目录 id 对齐） */
const catalogProduct = (p) => (p && p.recipeId ? getProduct(p.recipeId) : null);

/**
 * 卡片缩略图的第一优先来源：admin 卡片里的 `model.thumbFile`（draft 也带）。
 * 以前只靠 `thumbFor(catalog getProduct)`，结果数据库里补了图、前台目录还没换时，
 * 列表仍然看不到新图。相对路径要补 `/`，绝对路径（/api/...）原样保留。
 */
function serverThumb(p) {
  const raw = p && p.model && p.model.thumbFile;
  const s = raw == null ? '' : String(raw).trim();
  if (!s) return '';
  if (/^(https?:|data:|blob:)/.test(s)) return s;
  return s.startsWith('/') ? s : '/' + s;
}

const thumbOf = (p) => serverThumb(p) || thumbs.value[p.recipeId] || '';

function m2(mm) {
  const v = Number(mm);
  return Number.isFinite(v) && v > 0 ? (v / 1000).toFixed(2) : null;
}

// 空值如实说“未判断”，不能兜底成“柜门”（那会凭空造出一扇门）。none 由内核标签表翻成“无门”。
const doorText = (part) => doorPartLabel(part) || '未判断';

/** 时间戳：后端把 java.sql.Timestamp 交给 Jackson，形状不一定 —— 认得出才显示，认不出显示破折号 */
function day(v) {
  if (typeof v !== 'string') return null;
  const s = v.slice(0, 10);
  return s.indexOf('-') === 4 ? s : null;
}

async function fetchList() {
  phase.value = 'loading';
  trouble.value = '';
  try {
    const r = await api.adminProducts();
    products.value = Array.isArray(r.products) ? r.products : [];
    store.value = r.store || '';
    phase.value = 'ok';
    loadThumbs();
  } catch (e) {
    phase.value = 'fail';
    trouble.value = (e && e.reason ? e.reason + '：' : '') + (e && e.message ? e.message : '未知原因');
  }
}

async function loadThumbs() {
  const run = ++thumbRun;
  for (const p of products.value) {
    if (run !== thumbRun) return;                 // 列表已经换了一轮，停手
    if (serverThumb(p) || thumbs.value[p.recipeId]) continue;
    const src = catalogProduct(p);
    if (!src) continue;                           // 目录里没有这个型号 → 退回色块
    const url = await thumbFor(src);
    if (url && run === thumbRun) thumbs.value = { ...thumbs.value, [p.recipeId]: url };
  }
}

/** 切换一款产品的停用/启用状态 */
async function setStatus(p) {
  changing.value = p.id;
  actTrouble.value = { ...actTrouble.value, [p.id]: '' };
  try {
    const r = await api.adminSetProductStatus(p.id, nextStatus(p.status), notes.value[p.id] || '');
    // 用服务端回来的那一行**就地替换**（不再重取整张列表：重取会让人失去"我刚才改的是哪一条"）
    if (r && r.product) {
      products.value = products.value.map((x) => (x.id === r.product.id ? r.product : x));
    }
    confirming.value = 0;
    // 「本来就是启用的」——如实说，不假装改了。服务端把 from/status 都回来了。
    flash.value = r && r.changed === false
      ? '这一款本来就是' + statusLabel(r.status) + '，没有改动'
      : '已' + statusLabel(r.status) + '（目录 1 秒内生效）';
  } catch (e) {
    actTrouble.value = { ...actTrouble.value, [p.id]: (e && e.reason ? e.reason + '：' : '') + (e && e.message ? e.message : '未知原因') };
  } finally {
    changing.value = 0;
  }
}

/** 打开发送删除确认（inline；与状态确认共用一套卡片内确认样式） */
function askDelete(p) {
  confirming.value = 0;
  deleteConfirm.value = p.id;
  deleteTrouble.value = { ...deleteTrouble.value, [p.id]: '' };
}

/** 真正删除：成功后只移除本地这一行，不重取整张列表，避免丢掉滚动位置与上下文 */
async function removeProduct(p) {
  deleting.value = p.id;
  deleteTrouble.value = { ...deleteTrouble.value, [p.id]: '' };
  try {
    await api.adminDeleteProduct(p.id);
    products.value = products.value.filter((x) => x.id !== p.id);
    deleteConfirm.value = 0;
    flash.value = '已删除「' + p.name + '」：数据库记录已删；已存方案不受影响，模型文件保留';
  } catch (e) {
    // 原文照说：不存在 / 被占用 / 后端拒绝，下一步动作完全不同。
    deleteTrouble.value = {
      ...deleteTrouble.value,
      [p.id]: (e && e.reason ? e.reason + '：' : '') + (e && e.message ? e.message : '未知原因'),
    };
  } finally {
    deleting.value = 0;
  }
}

/**
 * 「停用 / 启用」按钮的提示语。
 *
 * 放脚本里而不是模板里：模板里那句要拆成两行，而 `check-quotes.py` 是**按行**看引号的 ——
 * 拆行后每一行都不成对，扫描器直接报出来（这个坑 `variantHint` 已经踩过一次）。
 */
function statusHint(p) {
  if (noMaintainText.value) return noMaintainText.value;
  return statusActionLabel(p.status) + '：只改「前台还看不看得见」，不动它的内容；'
    + '已存方案与分享链接不受影响（它们存的是几何快照，不查目录）';
}

/** 一句话反馈（几秒后自动消失；文案在 statusLabel 的同一套词表里） */
const flash = ref('');

onMounted(fetchList);
</script>

<template>
  <div class="pl">
    <header class="pl__head">
      <h1 class="pl__title">产品模型库</h1>
      <p class="pl__lead">从模型、声明尺寸、门型到缩略图，在这里补齐并维护；停用只影响前台可见性，删除只删数据库记录。</p>
    </header>

    <!-- 汇总：每条数字都标了单位（产品 / 角标是两种东西，混着写一定会被误读） -->
    <div class="pl__sum">
      <span class="pl__total">共 <b>{{ stats.total }}</b> 款产品</span>
      <span class="pl__k pl__k--bad">必须修 {{ stats.bad }} 款</span>
      <span class="pl__k pl__k--warn">该修 {{ stats.warn }} 款</span>
      <span class="pl__k pl__k--off">已停用 {{ stats.off }} 款</span>
      <span class="pl__spacer" />
      <span class="pl__src">{{ storeLabel(store) }}</span>
      <button class="adm__btn" :disabled="phase === 'loading'" @click="fetchList">
        {{ phase === 'loading' ? '取数中…' : '重取列表' }}
      </button>
      <button class="adm__btn pl__add" :disabled="canMaintain === false"
        :title="noMaintainText || '走三步向导新增一个产品模型（需要供应商给的 GLB）'"
        @click="go('/admin/products/new')">
        ＋ 新增产品
      </button>
      <button class="adm__btn" :disabled="canMaintain === false"
        :title="noMaintainText || '供应商没按规范交时用这条：填对尺寸与来源，先把产品建出来（没有模型文件）'"
        @click="go('/admin/products/new/manual')">
        人工代录
      </button>
    </div>

    <p v-if="flash" class="pl__flash">{{ flash }}</p>
    <p v-if="phase === 'loading'" class="pl__msg">正在取产品列表…</p>
    <p v-else-if="phase === 'fail'" class="pl__msg pl__msg--bad">
      取不到产品列表：<span class="adm__mono">{{ trouble }}</span>
      <button class="adm__btn" @click="fetchList">重试</button>
    </p>

    <template v-else>
      <nav class="pl__filter">
        <button
          v-for="t in FILTER_TABS"
          :key="t.key"
          :aria-pressed="filter === t.key"
          @click="filter = t.key"
        >{{ t.label }} <span class="pl__n">{{ countOf(t.key) }}</span></button>
        <span class="pl__spacer" />
        <!-- 筛选绝不静默：永远把"显示几条 / 一共几条"写出来 -->
        <span class="pl__shown">显示 {{ shown.length }} / 共 {{ stats.total }} 款</span>
      </nav>

      <p v-if="!shown.length" class="pl__msg">这一档里没有产品（不是没有数据 —— 换个档位看看）。</p>

      <div class="pl__grid">
        <article v-for="p in shown" :key="p.id" class="pcard" :class="{ 'is-off': p.status !== 'active' }">
          <span class="pcard__thumb" :style="{ '--c': p.color || '#9fb3c0' }" :title="p.name">
            <img v-if="thumbOf(p)" :src="thumbOf(p)" :alt="p.name" draggable="false">
            <span v-else class="pcard__ph" />
          </span>

          <div class="pcard__main">
            <div class="pcard__top">
              <b>{{ p.name }}</b>
              <span class="pcard__model">{{ p.modelNo }}</span>
            </div>

            <div class="pcard__meta">
              <span v-if="m2(p.model && p.model.bboxW)" class="pcard__dim">
                {{ m2(p.model.bboxW) }} × {{ m2(p.model.bboxD) }} × {{ m2(p.model.bboxH) }} m
              </span>
              <span v-else class="pcard__dim pcard__dim--none">无实测尺寸</span>
              <!-- 门型：把"已确认/未确认"写在旁边 —— 规则7 的开门净空体检**依赖它**，
                    未确认的产品体检结论不可信；这事必须在列表上就能看见，不必点进去。 -->
              <span
                  v-if="doorText(p.doorPart)"
                  class="pcard__tag"
                  :class="{ 'pcard__tag--warn': !p.doorVerified }"
                  :title="p.doorVerified ? '门型已确认（来源 ' + (p.doorSource || '?') + '）' : '门型未确认 —— 规则7 开门净空体检算不准'"
                >{{ doorText(p.doorPart) }}<template v-if="!p.doorVerified"> · 未确认</template></span>
              <span class="pcard__tag">{{ p.variantCount }} 个变体</span>
              <!-- 变体逐个列出来（B5）：一个产品可以有多份模型（颜色/版本），
                   而“哪一份就绪了/哪一份没就绪”是**每一份各自的**事 —— 一个数字回答不了。
                   没就绪的那份要把它自己的失败原因带出来（同一栏里看不见就得去翻日志）。 -->
              <span v-if="p.variants && p.variants.length > 1" class="pcard__tag pcard__tag--variants">
                <template v-for="(v, i) in p.variants" :key="v.variant">
                  <template v-if="i">·</template>
                  <span :title="v.ready ? (v.file || '有产物文件') : ('没产物文件' + (v.lodError ? '：' + v.lodError : ''))"
                    :class="{ 'is-bad': !v.ready && v.isDefault }">
                    {{ v.variant }}{{ v.isDefault ? '(默认)' : '' }}{{ v.ready ? '' : ' 未就绪' }}
                  </span>
                </template>
              </span>
              <span class="pcard__tag">{{ p.noteCount }} 条说明</span>
              <!-- 更新人：owner 是"谁创建的"，这是"最近谁改的" —— 多人协作必须分清。
                   种子来的 4 行是空的：空就是空，不随便填个人名充数。 -->
              <span v-if="p.updatedBy" class="pcard__tag pcard__tag--by">改：{{ actorLabel(p.updatedBy) }}</span>
              <span v-if="p.recipeId !== p.id" class="pcard__tag pcard__tag--id">{{ p.recipeId }} / #{{ p.id }}</span>
            </div>

            <!-- 卡上的动作（B5）：低频、与“看”分开放在底下。
                 “加一个变体”必须带产品 id 走（它是给**这一款**加模型）。 -->
            <div class="pcard__acts">
              <button class="adm__btn adm__btn--tiny" :disabled="canMaintain === false"
                data-hotspot-entry :data-hotspot-status="hotspotState(p)"
                :title="'打开这一款的 3D 标注看板：只编辑模型热点；产品卖点/参数在第 1 步维护'"
                @click="go('/admin/products/' + p.id + '/hotspots')">
                标注看板 · {{ hotspotLabel(p) }}<template v-if="hotspotCount(p) !== null"> · {{ hotspotCount(p) }}</template>
              </button>
              <button class="adm__btn adm__btn--tiny" :disabled="canMaintain === false"
                :title="variantHint(p)"
                @click="go('/admin/products/' + p.id + '/variant')">
                ＋ 加一个变体 →
              </button>
              <button class="adm__btn adm__btn--tiny" :disabled="canMaintain === false"
                data-product-edit :data-product-id="p.id"
                title="编辑产品信息、声明尺寸、门型、缩略图、卖点与参数"
                @click="go('/admin/products/' + p.id + '/edit')">
                编辑
              </button>
              <button class="adm__btn adm__btn--tiny" :disabled="canMaintain === false || deleting === p.id"
                data-product-delete :data-product-id="p.id"
                title="删除数据库记录；已存方案不受影响，模型文件不物理删除"
                @click="askDelete(p)">
                删除
              </button>
              <!-- 停用 / 启用（决策③）：这条链路以前**根本不存在** —— 列表上一直有「已停用」
                   档位与角标，却没有任何地方能把一款改成停用（第 2 轮审查 req-1）。 -->
              <button class="adm__btn adm__btn--tiny"
                :disabled="canMaintain === false || changing === p.id"
                :title="statusHint(p)"
                @click="confirming = (confirming === p.id ? 0 : p.id)">
                {{ statusActionLabel(p.status) }}{{ statusLabel(p.status) ? '（现：' + statusLabel(p.status) + '）' : '' }}
              </button>
            </div>

            <div v-if="confirming === p.id" class="pcard__confirm">
              <p class="pcard__confirm-t">{{ statusActionLabel(p.status) }}「{{ p.name }}」？</p>
              <ul class="pcard__confirm-l">
                <li v-for="(l, i) in statusConfirmLines(p)" :key="i">{{ l }}</li>
              </ul>
              <label class="pcard__confirm-note">
                备注（只进操作留痕，不回显）：
                <input class="adm__in" type="text" maxlength="80"
                  :value="notes[p.id] || ''"
                  @input="notes = { ...notes, [p.id]: $event.target.value }">
              </label>
              <div class="pcard__confirm-acts">
                <button class="adm__btn adm__btn--tiny" @click="confirming = 0">取消</button>
                <button class="adm__btn adm__btn--tiny adm__btn--primary"
                  :disabled="changing === p.id"
                  @click="setStatus(p)">
                  {{ changing === p.id ? '提交中…' : '确认' + statusActionLabel(p.status) }}
                </button>
              </div>
            </div>
            <p v-if="actTrouble[p.id]" class="pcard__err">改状态失败：<span class="adm__mono">{{ actTrouble[p.id] }}</span></p>

            <!-- 删除确认：放卡片内，能同时看清是哪一款；文案必须交代“方案不受影响 / 模型文件不物理删” -->
            <div v-if="deleteConfirm === p.id" class="pcard__confirm pcard__confirm--danger" data-delete-confirm>
              <p class="pcard__confirm-t">删除「{{ p.name }}」的数据库记录？</p>
              <ul class="pcard__confirm-l">
                <li>数据库记录删除，已存方案不受影响；模型文件不物理删除（内容寻址，可能被别的产品共用）。</li>
                <li>该产品的变体、热点与内容编辑态会随数据库记录一起删除；操作不可撤销。</li>
              </ul>
              <div class="pcard__confirm-acts">
                <button class="adm__btn adm__btn--tiny" data-delete-cancel @click="deleteConfirm = 0">取消</button>
                <button class="adm__btn adm__btn--tiny adm__btn--danger" data-delete-submit
                  :disabled="deleting === p.id" @click="removeProduct(p)">
                  {{ deleting === p.id ? '删除中…' : '确认删除' }}
                </button>
              </div>
            </div>
            <p v-if="deleteTrouble[p.id]" class="pcard__err">删除失败：<span class="adm__mono">{{ deleteTrouble[p.id] }}</span></p>

            <!-- 角标：title 里带 why —— 判据必须能被问出来，否则管理员只能选择不信 -->
            <div class="pcard__badges">
              <span
                v-for="b in p.badges"
                :key="b.text"
                class="badge"
                :class="'badge--' + b.level"
                :title="b.why"
              >{{ b.text }}</span>
              <span v-if="!p.badges.length" class="badge badge--none" title="模型、缩略图、尺寸对账都齐">无待办</span>
            </div>
          </div>
        </article>
      </div>
    </template>
  </div>
</template>
