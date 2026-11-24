<script setup>
/**
 * ProductRail —— 左栏：模型库（唯一一块）
 *
 * 按 docs/84 §四：卡头常驻、卡体内部滚动；空间尺寸与内墙已搬去右栏
 * （`RoomSizeCard` / `InteriorWallCard`）。验收 #4 之后这一块有两个页签：
 *   · 产品设备（默认）：目录取数、检索、缩略图与「＋ 放进布局」
 *   · 通用模型：**本轮只做诚实空态** —— 不放假数据、不放「放进布局」，也没动后端
 *
 * 取数与放入动作都走 designer，界面不算几何；目录的"从哪来"照旧写在卡头里。
 */
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { designer as d } from '../designer.js';
import { thumbFor } from '../thumbs.js';
import { canOpenDetail, catalogState, refreshCatalog } from '../catalog.js';

/**
 * 详情入口只发事件：这一栏不 own 弹层（弹层挂在 App，因为它是模态、要 Teleport 到 body），
 * 也不 own "哪款被打开"这个状态（关掉之后要还焦点给这张缩略图，只有 App 那层知道顺序）。
 */
const emit = defineEmits(['open-detail']);

function openDetail(p, ev) {
  if (!canOpenDetail(p)) return;
  // 把触发的那个元素一起交出去：关详情时焦点要回到它（键盘用户否则会掉到 body）
  emit('open-detail', p, ev?.currentTarget ?? null);
}

/** 页签键（顺序即 tab 顺序；产品设备默认） */
const TAB_KEYS = ['product', 'generic'];
const tab = ref('product');

function pickTab(k) {
  tab.value = k;
}

/**
 * 页签的键盘走法（WAI-ARIA tabs 的标准动作）：方向键换页签、Home/End 跳首尾。
 * 鼠标点也行 —— 但只做"可点"的话，键盘用户在这两个页签之间就只能靠 Tab 一个个过。
 */
function onTabKey(e) {
  const buttons = [...e.currentTarget.querySelectorAll('[role="tab"]')];
  const i = buttons.indexOf(e.target);
  if (i < 0) return;
  let n = null;
  if (e.key === 'ArrowRight') n = (i + 1) % buttons.length;
  else if (e.key === 'ArrowLeft') n = (i - 1 + buttons.length) % buttons.length;
  else if (e.key === 'Home') n = 0;
  else if (e.key === 'End') n = buttons.length - 1;
  if (n === null) return;
  e.preventDefault();
  buttons[n].focus();
  buttons[n].click();
}

/** 检索词（只在产品页签里用）：名称 / 型号，大小写不敏感的 substring —— 不做拼音、不做分词 */
const q = ref('');
const keyword = computed(() => q.value.trim().toLowerCase());

/**
 * 过滤后的目录。没有关键词就原样给整份目录（**不静默过滤**：匹配数与总数一起显示在卡头）。
 * `series` 目录行将来可能带（型号系列名），带上一起搜；没有这一项也不影响。
 */
const filtered = computed(() => {
  const kw = keyword.value;
  if (!kw) return d.catalog;
  return d.catalog.filter((p) => [p.name, p.model, p.series]
    .some((v) => String(v ?? '').toLowerCase().includes(kw)));
});

/** 卡头上的读数：搜索时给「匹配 N / 共 M」，没搜时给总数 */
const matchText = computed(() => (keyword.value
  ? `匹配 ${filtered.value.length} / 共 ${d.catalog.length} 款`
  : `共 ${d.catalog.length} 款`));
const sourceText = computed(() => (d.catalogSource === 'server' ? '来自数据库' : '本地资产'));

/**
 * 目录取数：「重试」在**两种来源下都留着**（task-75）。
 *
 * 过去只在本地兜底时显示 —— 于是"服务端目录已经取到了、但维护端刚上架的新品还没进来"
 * 这条路上用户没有任何手动入口，只能按 F5（还要冒丢未保存改动的风险）。
 * 现在它同时是"手动刷新"：`force` 跳过节流，点一次就真的去问一次。
 */
const catalogBusy = ref(false);
const catalogNote = ref('');
// 文案进脚本、不进模板（模板里跨行三元 + 中文引号既难读，也会被 check-quotes 判成可疑行）
const catalogIsServer = computed(() => d.catalogSource === 'server');
const retryTitle = computed(() => (catalogIsServer.value
  ? '重新读一次服务端目录（维护端刚上架的产品，不用刷新页面也能看见）'
  : '后端未连上时用的是本地资产；后端起来后点这里重取，不用刷新页面'));
const retryLabel = computed(() => {
  if (catalogBusy.value) return catalogIsServer.value ? '刷新中…' : '重试中…';
  return catalogIsServer.value ? '刷新' : '重试';
});

async function retryCatalog() {
  catalogBusy.value = true;
  catalogNote.value = '';
  try {
    const r = await refreshCatalog({ force: true, reason: 'manual' });
    if (r.ok) {
      const added = r.added ?? [];
      catalogNote.value = added.length
        ? `目录已更新：新增 ${added.length} 款（${added.join('、')}）`
        : `目录已是最新（${r.count} 款）`;
    } else {
      catalogNote.value = `重取失败：${r.reason ?? r.skipped ?? '未知原因'}（仍在用${
        catalogState.source === 'server' ? '上一次的服务端目录' : '本地资产'}）`;
    }
  } finally {
    catalogBusy.value = false;
  }
}

/** 自动重读带来的新增（focus / 切回页面时）：说出来是哪几款，不要只改数字 */
const recentAdded = computed(() => {
  const ch = catalogState.lastChange;
  if (!ch?.added?.length) return [];
  const byId = new Map(d.catalog.map((p) => [p.id, p]));
  return ch.added.map((id) => byId.get(id)?.name ?? id);
});

// ── 型号卡上的缩略图（离屏渲染，见 src/thumbs.js）──────────────────────────────
// 一次渲一个（4 张同时抢 GPU 只会让首屏更慢）；目录被服务端那一份替换后会重来一遍。
// `thumbRun` 是防串台的：目录换了两轮时，前一轮的图绝不能贴到新一轮上。
const thumbs = ref({});
let thumbRun = 0;

async function loadThumbs() {
  const run = ++thumbRun;
  for (const p of d.catalog) {
    if (run !== thumbRun) return;
    if (thumbs.value[p.id]) continue;
    const url = await thumbFor(p);
    if (url && run === thumbRun) thumbs.value = { ...thumbs.value, [p.id]: url };
  }
}

onMounted(loadThumbs);
watch(() => d.catalog, () => { thumbs.value = {}; loadThumbs(); });

function mm(v) { return Math.round(v * 1000); }

/** 卡片上按米显示（两位，与「空间尺寸」栏同一个口径）；毫米原值挂在 title 上 */
function m2(v) { return Number(v).toFixed(2); }

/** 页签面板的 id：页签的 aria-controls 与面板的 id 必须对得上（两个面板都在文档里，v-show 切换） */
const panelId = (k) => 'catalog-panel-' + k;
const tabId = (k) => 'catalog-tab-' + k;
</script>

<template>
  <aside class="rail rail--left">
    <section class="card rail-card">
      <!-- 卡头常驻（docs/84 §四规则 1）：标题 / 两个页签 / 检索 / 读数，全都不跟着卡体滚 -->
      <header class="rail-card__head">
        <div class="rail-card__title-row">
          <span class="rail-card__title">模型库</span>
          <button
            class="btn btn--mini"
            data-catalog-retry
            :disabled="catalogBusy"
            :title="retryTitle"
            @click="retryCatalog"
          >{{ retryLabel }}</button>
        </div>

        <div class="rail-card__tabs" role="tablist" aria-label="模型库分类" @keydown="onTabKey">
          <button
            :id="tabId('product')"
            type="button"
            role="tab"
            :aria-selected="tab === 'product'"
            :aria-controls="panelId('product')"
            :tabindex="tab === 'product' ? 0 : -1"
            data-catalog-tab="product"
            @click="pickTab('product')"
          >产品设备</button>
          <button
            :id="tabId('generic')"
            type="button"
            role="tab"
            :aria-selected="tab === 'generic'"
            :aria-controls="panelId('generic')"
            :tabindex="tab === 'generic' ? 0 : -1"
            data-catalog-tab="generic"
            @click="pickTab('generic')"
          >通用模型</button>
        </div>

        <!-- 检索只在产品页签里出现（通用模型本轮没有可搜的数据，假搜索框比没有更坏） -->
        <div v-if="tab === 'product'" class="rail-card__search">
          <input
            v-model="q"
            type="search"
            class="rail-card__search-input"
            data-catalog-search
            placeholder="搜索名称或型号"
            aria-label="按名称或型号搜索产品，不区分大小写"
            autocomplete="off"
            spellcheck="false"
            @keydown.esc="q = ''"
          >
          <button v-if="q" class="btn btn--mini" title="清空检索词" @click="q = ''">清空</button>
        </div>

        <div v-if="tab === 'product'" class="rail-card__meta">
          <span
            class="hint"
            :title="d.catalogSource === 'server' ? '目录来自数据库（product / product_model / product_note）' : '后端不可用，用的是打包进站的本地资产'"
          >{{ matchText }} · {{ sourceText }}</span>
        </div>
        <!-- 重读的结果要说出来（新增了哪几款 / 为什么没更新），否则"数字没变"和"没去取"看起来一样 -->
        <p v-if="catalogNote" class="hint rail-card__note" role="status">{{ catalogNote }}</p>
        <p v-else-if="recentAdded.length" class="hint rail-card__note" role="status">
          目录已更新：新增 {{ recentAdded.length }} 款（{{ recentAdded.join('、') }}）
        </p>
      </header>

      <!-- 产品设备：卡体内部滚动，目录再长也不把整栏撑破 -->
      <div
        v-show="tab === 'product'"
        :id="panelId('product')"
        class="card-body rail-card__body"
        role="tabpanel"
        :aria-labelledby="tabId('product')"
        tabindex="0"
      >
        <!-- 面板元素用 v-show 留住（页签的 aria-controls 始终指得到人），
             但内容跟着页签整块卸掉：通用模型页签下 DOM 里不该还躺着一排产品卡 ——
             "不放假数据"也包括不把真数据藏在 display:none 里假装没有。 -->
        <template v-if="tab === 'product'">
          <!-- 验收2-1：左侧大缩略图 + 右侧信息堆叠；底部整行「放进布局」撤掉，
               改成缩略图右上角的悬浮圆形加号（hover/focus 出现、触屏常显，点击只调 d.add 一次）。 -->
          <article v-for="p in filtered" :key="p.id" class="product" :data-product-id="p.id">
            <div class="product__media">
              <!-- 缩略图 = 详情入口（docs/104 §4.1：点缩略图打开只读详情）。
                   没有可看内容时它退回成一张图（`data-has-detail="false"`），
                   不给一个点进去必然空着的按钮。 -->
              <button
                v-if="canOpenDetail(p)"
                type="button"
                class="thumb thumb--btn"
                :style="{ '--c': p.color }"
                :title="`查看「${p.name}」三维详情`"
                :aria-label="`查看「${p.name}」三维详情`"
                data-product-thumb
                data-has-detail="true"
                @click="openDetail(p, $event)"
              >
                <img v-if="thumbs[p.id]" :src="thumbs[p.id]" alt="" draggable="false">
                <span v-else class="thumb-ph" />
                <span class="thumb__hint" aria-hidden="true">详情</span>
              </button>
              <span v-else class="thumb" :style="{ '--c': p.color }" :title="p.model" data-product-thumb data-has-detail="false">
                <img v-if="thumbs[p.id]" :src="thumbs[p.id]" alt="" draggable="false">
                <span v-else class="thumb-ph" />
              </span>
              <button
                type="button"
                class="product__add"
                data-product-add
                :title="`把「${p.name}」放进布局`"
                :aria-label="`把「${p.name}」放进布局`"
                @click.stop="d.add(p.id)"
              >＋</button>
            </div>
            <div class="product__info">
              <b class="product__name" :title="p.name">{{ p.name }}</b>
              <span class="product__model" :title="p.model">{{ p.model }}</span>
              <div class="dim" :title="`${mm(p.w)} × ${mm(p.d)} × ${mm(p.h)} mm`">{{ m2(p.w) }} × {{ m2(p.d) }} × {{ m2(p.h) }} m</div>
            </div>
          </article>

          <!-- 有检索词但一个都没匹配上：明确说清"搜了什么、目录里一共几款"，并给一键清空 -->
          <div v-if="keyword && !filtered.length" class="catalog-empty" data-catalog-empty="search">
            <b>没有匹配「{{ q.trim() }}」的型号</b>
            <p class="hint">检索按名称与型号做不区分大小写的包含匹配；目录里共 {{ d.catalog.length }} 款，都还在。</p>
            <button class="btn btn--mini" @click="q = ''">清空搜索</button>
          </div>

          <!-- 目录本身是空的（后端与本地资产都没有）：与"搜不到"是两件事，分开说 -->
          <p v-if="!d.catalog.length" class="hint" data-catalog-empty="catalog">
            目录为空：后端不可用，本地资产里也没有型号。后端起来后点上方「重试」再取一次。
          </p>

          <p v-if="filtered.length" class="hint">
            尺寸为<b>声明包络</b>（做占地用，不含把手凸出）。带「演示比例」的型号不能用于实际安装。
          </p>
        </template>
      </div>

      <!-- 通用模型：本轮只有诚实空态（不放假数据、不放「放进布局」，也没动后端） -->
      <div
        v-show="tab === 'generic'"
        :id="panelId('generic')"
        class="card-body rail-card__body"
        role="tabpanel"
        :aria-labelledby="tabId('generic')"
        tabindex="0"
      >
        <div class="catalog-empty" data-catalog-empty="generic">
          <b>通用模型还没有接入</b>
          <p class="hint">这一档留给不绑定产品型号的通用模型。本轮不放假数据、也不提供「放进布局」——接入之后会出现在这里。</p>
          <p class="hint">产品设备那一页签照旧可用。</p>
        </div>
      </div>
    </section>
  </aside>
</template>

<style scoped>
/* 左栏只有一块：卡撑满栏高，卡头常驻、卡体自己滚（docs/84 §四规则 1）。
   栏本身的 padding / 底色 / overflow 由全局 `.rail` 管，这里只把这一块拆成「卡头 + 可滚卡体」。 */
.rail-card {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.rail-card > .rail-card__head {
  flex: none;
  display: grid;
  gap: 8px;
  min-width: 0;
}

.rail-card__title-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.rail-card__title {
  color: var(--ink);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: .2px;
}
.rail-card__title-row .btn { margin-left: auto; }

/* 两个页签：等宽分段，选中态同时靠底色与字重表达（不只靠颜色） */
.rail-card__tabs {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
  padding: 3px;
  background: var(--bg-2);
  border: 1px solid var(--line-2);
  border-radius: 8px;
  min-width: 0;
}
.rail-card__tabs button {
  min-width: 0;
  padding: 6px 4px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: var(--ink-2);
  font: inherit;
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
}
.rail-card__tabs button:hover { color: var(--brand-dark); }
.rail-card__tabs button[aria-selected="true"] {
  background: #fff;
  color: var(--brand-dark);
  font-weight: 600;
  box-shadow: var(--shadow);
}
.rail-card__tabs button:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }

.rail-card__search {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.rail-card__search-input {
  flex: 1 1 auto;
  min-width: 0;
  padding: 7px 9px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: #fff;
  color: var(--ink);
  font: inherit;
  font-size: 12px;
  font-weight: 400;
}
.rail-card__search-input:focus { outline: 2px solid var(--brand-soft); border-color: var(--brand); }

.rail-card__meta { display: flex; align-items: center; gap: 6px; min-width: 0; }
.rail-card__meta .hint {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.rail-card__body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  /* 用 flex 纵向排卡，不用 grid：grid 在「容器高度固定、内容略超」时会把 auto 行压回
     min-height，长型号卡的文字会被裁掉（实测 demo-freezer-chest 行高 138 而内容要 163）。
     flex 的 item 用 `flex: 0 0 auto` 保持内容高度，超出就交给卡体滚动。 */
  display: flex;
  flex-direction: column;
  align-items: stretch;
  /* 卡体内部滚动，但不让滚动条吃掉 15px 卡宽（macOS 真机是 overlay 滚动条；
     无头 Chrome 会按经典滚动条排版，卡宽会从 229 掉到 214、文字多折一行）。
     隐藏滚动条后滚轮/触控板/方向键照旧能滚。 */
  scrollbar-width: none;
}
.rail-card__body::-webkit-scrollbar { width: 0; height: 0; }
.rail-card__body:focus-visible { outline: 2px solid var(--brand); outline-offset: -2px; }

/* ── 型号卡（验收2-1：左大缩略图 + 右信息堆叠，加号悬浮）──────────────────────
   卡宽/内边距/圆角/卡间距沿用上一版：宽度由卡体决定，padding 10px，卡间距来自 `.card-body` 的 gap。
   右侧名称/型号/尺寸/sizeNote 全部换行展示（不 line-clamp、不丢字）：
   卡高由内容决定 —— 典型约 138px，窄栏 + 超长型号自然到约 156px。 */
.rail-card__body .product {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: start;
  flex: 0 0 auto;
  gap: 10px;
  padding: 10px;
  /* 目标卡高 138：缩略图 96 + 上下内边距 20 只有 116，短型号卡会偏矮；
     给一个下限，长型号照旧按内容自然长到约 156（不截断）。 */
  min-height: 138px;
}
.product__media { position: relative; flex: none; }
.product__info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
/* 名称/型号：**换行展示，不截省略号**。240 px 档位下"双温双控低温保存箱"会占两行，
   型号像 DEMO-FZ-25C 这种长串也会在斜杠处折开 —— 宁可高一行，也不丢字。 */
.rail-card__body .product__name {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.25;
  color: var(--ink);
  white-space: normal;
  overflow-wrap: anywhere;
}
.rail-card__body .product__model {
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.25;
  color: var(--ink-2);
  white-space: normal;
  overflow-wrap: anywhere;
}
/* 尺寸与尺寸可信度：完整展示（全局那两条是 nowrap + 省略号，窄栏里会把数截掉） */
.rail-card__body .product .dim {
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.25;
  color: var(--ink-3);
  white-space: normal;
  overflow: visible;
  overflow-wrap: anywhere;
  text-overflow: clip;
}
.rail-card__body .product .size-note {
  font-size: 11px;
  line-height: 1.25;
  color: var(--warn-ink);
  white-space: normal;
  overflow: visible;
  overflow-wrap: anywhere;
  text-overflow: clip;
}
.rail-card__body .product .size-note.is-bad { color: var(--bad-ink); }

/* 悬浮加号：缩略图右上角一枚圆形按钮。
   · 鼠标 hover 卡片 / 键盘焦点进入卡片时出现；
   · `(hover: none)`（触屏等无 hover 设备）常显；
   · 只调 d.add(p.id)，`@click.stop` 保证不误触卡片其他区域。 */
.product__add {
  position: absolute;
  top: -6px;
  right: -6px;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 2px solid #fff;
  border-radius: 50%;
  background: var(--brand);
  color: #fff;
  font: inherit;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  box-shadow: 0 2px 6px rgb(22 35 44 / 22%);
  opacity: 0;
  pointer-events: none;
  transform: translateY(-2px);
  transition: opacity .15s, transform .15s, background-color .15s;
}
.product:hover .product__add,
.product:focus-within .product__add {
  opacity: 1;
  pointer-events: auto;
  transform: none;
}
.product__add:hover { background: var(--brand-dark); }
.product__add:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
@media (hover: none) {
  .product__add { opacity: 1; pointer-events: auto; transform: none; }
}

/* 缩略图：默认 96×96；窄栏（≤1366：左栏 240）缩到 80×80。
   没有图时不是破图，而是**按型号色**的占位块（回退也得能看）；有图时 object-fit: contain。 */
.thumb {
  width: 96px;
  height: 96px;
  flex: none;
  border-radius: 8px;
  overflow: hidden;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--c) 8%, #fff);
  border: 1px solid var(--line-2);
}
.thumb img { width: 100%; height: 100%; object-fit: contain; display: block; }
.thumb-ph {
  width: 100%;
  height: 100%;
  background: linear-gradient(135deg, color-mix(in srgb, var(--c) 10%, #fff), color-mix(in srgb, var(--c) 28%, #fff));
}
@media (max-width: 1366px) {
  .thumb { width: 80px; height: 80px; }
}

.rail-card__note { margin: 0; color: #4a5b66; }

/* 缩略图当按钮时：去掉按钮默认外观，保留原来的容器尺寸；hover/focus 才露出"详情"二字 */
.thumb--btn { border: 1px solid var(--line-2); padding: 0; cursor: pointer; position: relative; }
.thumb--btn:hover, .thumb--btn:focus-visible { border-color: var(--brand, #1f6fb2); }
.thumb--btn:focus-visible { outline: 2px solid #14568c; outline-offset: 2px; }
.thumb__hint {
  position: absolute; right: 4px; bottom: 4px; padding: 1px 6px; border-radius: 999px;
  background: rgba(12, 24, 33, .72); color: #fff; font-size: 10px; line-height: 16px;
  opacity: 0; transition: opacity .15s;
}
.thumb--btn:hover .thumb__hint, .thumb--btn:focus-visible .thumb__hint { opacity: 1; }

/* 空态（搜不到 / 通用模型未接入）：说清"为什么空"，并给出下一步 */
.catalog-empty {
  display: grid;
  gap: 8px;
  justify-items: start;
  padding: 10px 2px;
}
.catalog-empty b { font-size: 12px; color: var(--ink-2); }
.catalog-empty .hint { overflow-wrap: anywhere; }
</style>
