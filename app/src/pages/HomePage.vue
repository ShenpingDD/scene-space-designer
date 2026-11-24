<script setup>
/**
 * HomePage —— 首页（`/index`）
 *
 * ## 版面
 * 导航栏（组合标 + 账号区）、banner 轮播卡片（三张图自动轮换，宽度与下方卡片墙一致）、标题行（一级标题 + 查看全部 →）、
 * 5 × 4 卡片墙：第 1 格固定是「新建场景空间设计方案」，其余 19 格是最近编辑的方案。
 *
 * ## 轮换要能停
 * 6 秒换一张；鼠标停在 banner 上、或键盘把焦点放到圆点上就暂停（设计决策记录 §十一第 3 条）。
 * 系统设了「减少动态效果」的人不自动轮换，圆点仍可点。
 *
 * ## 数据只有一条来源
 * 列表从 `GET /api/schemes` 取，排序复用方案库那一套（`sortSchemes` / `cardOf`）——
 * 首页不另算一套「最近」，否则同一份方案在两页上的名次能对不上。
 *
 * ## banner 的图里自带文字
 * 三张图本身已经把标题与说明画进去了，页面只负责显示与轮换，不再往上压字或蒙版（设计决策记录 §四）。
 * 容器高度按自身内容宽等比例计算（100cqi / 7.1935），容器比例恒等于图比例，
 * 图整幅显示、不裁切，任何分辨率下都不产生两侧留白。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { api } from '../api.js';
import { go, schemeHref } from '../router.js';
import { caps } from '../session.js';
import AccountBox from '../components/AccountBox.vue';
import { cardOf, sortSchemes, SORTS } from '../admin/schemes.js';
import brandMark from '../assets/brand/brand-mark.png';
import banner1 from '../assets/home/banner-1.png';
import banner2 from '../assets/home/banner-2.png';
import banner3 from '../assets/home/banner-3.png';
import './home.css';

/** 三张 banner 照 设计决策记录 §四；标题只用于读屏与圆点的 aria-label，页面上不再显示 */
const BANNERS = [
  { src: banner1, title: '平面到立体，一屏同看' },
  { src: banner2, title: '摆完即体检：碰墙、间距、开门净空' },
  { src: banner3, title: '一个二维码，客户免登录看立体图' },
];

/** 卡片墙：20 格减去新建那一格（设计决策记录 §五第 3 条） */
const MAX_CARDS = 19;
/** 换图间隔（设计决策记录 §四） */
const ROTATE_MS = 6000;

const phase = ref('loading');
const rows = ref([]);
const trouble = ref('');

const index = ref(0);
const paused = ref(false);
let timer = 0;

async function load() {
  phase.value = 'loading';
  trouble.value = '';
  try {
    const list = await api.mySchemes();
    rows.value = Array.isArray(list) ? list : [];
    phase.value = 'ok';
  } catch (e) {
    phase.value = 'fail';
    trouble.value = (e && e.reason ? e.reason + '：' : '') + (e && e.message ? e.message : '未知原因');
  }
}

const cards = computed(() => sortSchemes(rows.value, SORTS.UPDATED).slice(0, MAX_CARDS).map(cardOf));

const canAdmin = computed(() => !!(caps.value && caps.value.enterAdmin));

function stopRotate() {
  if (timer) {
    clearInterval(timer);
    timer = 0;
  }
}

function startRotate() {
  stopRotate();
  if (paused.value) return;
  timer = setInterval(() => {
    index.value = (index.value + 1) % BANNERS.length;
  }, ROTATE_MS);
}

function pick(i) {
  index.value = i;
  startRotate();
}

function pause() {
  paused.value = true;
  stopRotate();
}

function resume() {
  paused.value = false;
  startRotate();
}

function open(card) {
  const href = schemeHref(card.id);
  if (href) go(href);
}

onMounted(() => {
  load();
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) startRotate();
});

onBeforeUnmount(stopRotate);
</script>

<template>
  <div class="home">
    <nav class="home__top">
      <!-- 品牌：整张横版组合标（图形与中英文名称都在这张图里），与登录页同一张 -->
      <div class="home__brand">
        <img :src="brandMark" alt="场景空间设计器 · Scene Space Designer">
      </div>

      <div class="home__account">
        <!-- 维护端入口：排在账号区左侧，只有能进维护端的账号才出现 -->
        <a v-if="canAdmin" class="home__admin" href="/admin" @click.prevent="go('/admin')">维护端</a>
        <AccountBox />
      </div>
    </nav>

    <main class="home__body">
      <div class="home__pane">
        <!--
          banner 区：三张图轮换，图里自带文字，页面不叠字、不叠蒙版。
          `data-ui-slot="home-guide"` 这个挂点从旧版导览区搬到这里，属性名不动（端到端探针按它取元素）。
        -->
        <section
          class="home__banner"
          data-ui-slot="home-guide"
          aria-roledescription="轮播"
          aria-label="产品说明"
          @mouseenter="pause"
          @mouseleave="resume"
        >
          <img
            v-for="(b, i) in BANNERS"
            :key="b.src"
            class="home__shot"
            :class="{ 'is-on': i === index }"
            :src="b.src"
            :alt="'产品说明第 ' + (i + 1) + ' 张：' + b.title"
            :aria-hidden="i !== index"
          >
          <div class="home__dots" role="tablist" aria-label="换一张">
            <button
              v-for="(b, i) in BANNERS"
              :key="b.title"
              class="home__dot"
              :class="{ 'is-on': i === index }"
              type="button"
              role="tab"
              :aria-selected="i === index"
              :aria-label="'第 ' + (i + 1) + ' 张：' + b.title"
              @click="pick(i)"
              @focus="pause"
              @blur="resume"
            />
          </div>
        </section>

        <div class="home__head">
          <h1>我的场景空间设计方案</h1>
          <a class="home__all" href="/project" @click.prevent="go('/project')">查看全部 →</a>
        </div>

        <div class="home__wall">
          <!-- 第 1 格固定是新建 -->
          <button class="home__new" type="button" @click="go('/design/new')">
            <span class="home__plus" aria-hidden="true">+</span>
            <span class="home__new-text">新建场景空间设计方案</span>
          </button>

          <div v-if="phase === 'loading'" class="home__state">正在取方案列表…</div>

          <div v-else-if="phase === 'fail'" class="home__state home__state--bad">
            取不到方案列表：{{ trouble }}
            <button class="btn btn--mini" @click="load">重试</button>
          </div>

          <!-- 空态只在一条方案都没有时出现，位于新建卡片右侧一格 -->
          <div v-else-if="!cards.length" class="home__state">
            你还没有方案 —— 点左上角那张卡片开始。
          </div>

          <template v-else>
            <button
              v-for="c in cards"
              :key="c.id"
              class="home__card"
              type="button"
              :title="'继续编辑：' + (c.name || '未命名方案')"
              @click="open(c)"
            >
              <span class="home__thumb">
                <img v-if="c.coverUrl" :src="c.coverUrl" :alt="'封面：' + (c.name || '未命名方案')" loading="lazy">
                <span v-else>无封面</span>
              </span>
              <span class="home__meta">
                <span class="home__name">{{ c.name || '（未命名）' }}</span>
                <span class="home__time">更新于 {{ c.updatedText }}</span>
              </span>
            </button>
          </template>
        </div>
      </div>
    </main>
  </div>
</template>
