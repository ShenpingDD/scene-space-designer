/**
 * my-schemes-design.test.js —— 我的全部方案设计稿落地的源码判据
 *
 * 只钉这一页自己的 4 个文件（页面 / 卡片 / 样式 / 本测试），不碰登录页、首页、维护端与共享 token。
 * 每条判据都写清**变异点**：改哪里会让它红。
 *
 * 这里**不做 DOM 渲染**（仓库的 SSR/jsdom 判据由真机探针负责，见 `tools/probes/`）；
 * 源码判据的价值是钉住「设计稿的数字与结构」以及几条容易写错的硬约束：
 *   · 外层卡片是 `<div role="button">` —— 写成 `<button>` 会被浏览器隐式闭合，网格错乱；
 *   · 每页 7 个方案 + 新建 = 8 格；不足一页不显示分页；
 *   · 旧版统计胶囊（放不下 / 门 / 重取列表）已删除，但筛选说明与回收站入口必须还在。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const PAGE = read('../src/pages/MySchemesPage.vue');
const CARD = read('../src/components/DesignSchemeCard.vue');
const CSS = read('../src/pages/my-schemes.css');
/** 判「旧东西不在了」时先去掉注释：文档里解释「删掉了什么」不算残留 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
const PAGE_CODE = stripComments(PAGE);

/* ---------------- 版面骨架 ---------------- */

test('顶栏是品牌标 40 + 账号胶囊（不放新建），内容区 1516 / 24-32-32', () => {
  assert.match(PAGE, /import brandMark from '\.\.\/assets\/brand\/brand-mark\.png'/);
  assert.match(PAGE, /class="my__brand"[\s\S]{0,160}:src="brandMark"/);
  assert.match(PAGE, /<AccountBox\s*\/>/);
  assert.match(CSS, /\.my__top\s*\{[\s\S]{0,260}height:\s*56px/);
  assert.match(CSS, /\.my__brand img\s*\{[\s\S]{0,80}height:\s*40px;[\s\S]{0,40}width:\s*auto/);
  assert.match(CSS, /\.my__body\s*\{[\s\S]{0,120}padding:\s*24px 32px 32px/);
  assert.match(CSS, /\.my__pane\s*\{[\s\S]{0,120}max-width:\s*1516px/);

  // 新建入口只能在卡片墙第一格：导航与标题行里不许出现 go('/design/new')
  const atGrid = PAGE.indexOf('class="my__grid"');
  const atNewLink = PAGE.indexOf("go('/design/new')");
  assert.ok(atGrid > 0 && atNewLink > atGrid, '新建入口不许出现在导航栏或标题行');
  assert.ok(!/class="header"/.test(PAGE), '不再用旧的 .header 顶栏');
  assert.ok(!/新建场景空间设计方案<\/button>[\s\S]{0,80}<AccountBox/.test(PAGE), '顶栏不放新建按钮');
});

test('标题行：我的全部方案 22/600 + 回收站低调文字入口 + 返回首页 13', () => {
  assert.match(PAGE, /<h1>我的全部方案<\/h1>/);
  assert.match(CSS, /\.my__head h1\s*\{[\s\S]{0,80}font-size:\s*22px;[\s\S]{0,40}font-weight:\s*600/);
  assert.match(PAGE, /class="my__trash"[\s\S]{0,260}switchView\(/);
  assert.match(PAGE, /回收站/);
  assert.match(PAGE, /返回方案库/);
  assert.match(PAGE, /class="my__back"[\s\S]{0,120}go\('\/index'\)/);
  assert.match(CSS, /\.my__back,\s*\n?\.my__trash\s*\{[\s\S]{0,220}font-size:\s*13px/);
  // 低调：回收站与返回首页都不是主按钮
  assert.ok(!/class="[^"]*btn--primary[^"]*"[^>]*回收站/.test(PAGE), '回收站不该做成主按钮');
});

/* ---------------- 工具条 ---------------- */

test('工具条：搜索 / 状态胶囊 / 型号 / 排序 / 清空条件，旧统计胶囊已删', () => {
  assert.match(PAGE, /placeholder="搜方案名 \/ 型号 \/ 标签"/);
  assert.match(PAGE, /v-for="t in statusTabs"/);
  assert.match(PAGE, /filter\.status === t\.code/);
  // 设计稿口径：draft → 未完成、delivered → 已完成；真实状态码与词表写进 title
  assert.match(PAGE, /if \(code === 'draft'\) return '未完成';/);
  assert.match(PAGE, /if \(code === 'delivered'\) return '已完成';/);
  assert.match(PAGE, /状态码 draft（/);
  assert.match(PAGE, /状态码 delivered（/);
  assert.match(PAGE, /statusLabel\(code\)/, '未知状态不吞掉，照词表显示');
  assert.match(PAGE, /:title="t\.why"/);
  // 型号与排序都从数据/词表现算，不硬列
  assert.match(PAGE, /v-for="m in models"/);
  assert.match(PAGE, /v-for="k in SORT_ORDER"/);
  assert.match(PAGE, /class="my__clear"[\s\S]{0,80}v-if="filtering"|v-if="filtering"[\s\S]{0,120}class="my__clear"/);

  // 旧版「统计胶囊行」与「重取列表」按设计稿删除
  assert.ok(!PAGE_CODE.includes('pl__sum'), '旧的统计行必须删掉');
  assert.ok(!PAGE_CODE.includes('放不下 {{ stats'), '旧统计胶囊必须删掉');
  assert.ok(!PAGE_CODE.includes('重取列表'), '旧「重取列表」必须删掉');

  // 但「筛选不静默」的说明不能跟着删：它解释筛掉了什么
  assert.match(PAGE, /filterSummary\(/);
  assert.match(PAGE, /class="my__summary"/);
});

/* ---------------- 卡片墙与分页 ---------------- */

test('网格 4 列，断点 1180/900/600 降 4/3/2/1，gap 16', () => {
  assert.match(CSS, /\.my__grid\s*\{[\s\S]{0,120}grid-template-columns:\s*1fr;[\s\S]{0,80}gap:\s*16px/);
  assert.match(CSS, /@media \(min-width: 600px\)\s*\{\s*\.my__grid \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/);
  assert.match(CSS, /@media \(min-width: 900px\)\s*\{\s*\.my__grid \{\s*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \}/);
  assert.match(CSS, /@media \(min-width: 1180px\)\s*\{\s*\.my__grid \{\s*grid-template-columns: repeat\(4, minmax\(0, 1fr\)\); \}/);
});

test('第一格是虚线新建大卡；每页 7 个方案 + 新建 = 8 格', () => {
  assert.match(PAGE, /const PAGE_SCHEMES = 7;/);
  assert.match(PAGE, /shown\.value\.slice\(\(page\.value - 1\) \* PAGE_SCHEMES, page\.value \* PAGE_SCHEMES\)/);
  assert.ok(PAGE.indexOf('class="my__new"') < PAGE.indexOf('<DesignSchemeCard'), '新建卡必须在方案卡之前');
  assert.match(PAGE, /class="my__new"[\s\S]{0,160}go\('\/design\/new'\)/);
  assert.match(CSS, /\.my__new\s*\{[\s\S]{0,300}border:\s*1px dashed var\(--line\)/);
  assert.match(CSS, /\.my__new\s*\{[\s\S]{0,340}border-radius:\s*12px/);
  // 回收站里不出现新建卡
  assert.match(PAGE, /v-if="view === 'library'"[\s\S]{0,60}class="my__new"/);
});

test('分页：pageCount>1 才显示、32×32、右对齐/移动居中、当前页品牌蓝白字、禁用 50%', () => {
  assert.match(PAGE, /const pageCount = computed\(\(\) => Math\.max\(1, Math\.ceil\(shown\.value\.length \/ PAGE_SCHEMES\)\)\)/);
  assert.match(PAGE, /v-if="phase === 'ok' && pageCount > 1"/);
  assert.match(PAGE, /:class="\{ 'is-on': p === page \}"/);
  assert.match(PAGE, /:disabled="page <= 1"/);
  assert.match(PAGE, /:disabled="page >= pageCount"/);
  assert.match(CSS, /\.my__pager\s*\{[\s\S]{0,160}justify-content:\s*flex-end/);
  assert.match(CSS, /\.my__pg\s*\{[\s\S]{0,160}height:\s*32px/);
  assert.match(CSS, /\.my__pg--num\s*\{[\s\S]{0,80}width:\s*32px/);
  assert.match(CSS, /\.my__pg\.is-on\s*\{[\s\S]{0,120}background:\s*var\(--brand\)/);
  assert.match(CSS, /\.my__pg\.is-on\s*\{[\s\S]{0,160}color:\s*#fff/);
  assert.match(CSS, /\.my__pg:disabled\s*\{[\s\S]{0,60}opacity:\s*\.5/);
  assert.match(CSS, /@media \(max-width: 767px\)[\s\S]{0,260}\.my__pager \{ justify-content: center; \}/);
  // 不伪造页数下限；页数多时必须折叠，不能把 64 个页码全铺开
  assert.ok(!/Math\.max\(3,/.test(PAGE), '不许伪造页数');
  assert.match(PAGE, /const pageItems = computed\(\(\) =>/, '页码要有窗口折叠');
  assert.ok(!/v-for="p in pageCount"/.test(PAGE), '不能直接遍历全部页数');
  assert.match(PAGE, /p === '…'/, '折叠处要有省略号');
});

test('筛选/排序变化页码归 1（含排序维度）', () => {
  assert.match(PAGE, /watch\(\(\) => \[filter\.value\.q, filter\.value\.status, filter\.value\.model, sort\.value\], \(\) => \{ page\.value = 1; \}\)/);
});

/* ---------------- 卡片结构与动作 ---------------- */

test('卡片外层是 div role=button（不能嵌套 button），内部按钮都 @click.stop', () => {
  assert.match(CARD, /<div\s+ref="root"[\s\S]{0,240}class="dscard"/);
  assert.match(CARD, /:role="clickable \? 'button' : null"/);
  assert.match(CARD, /@click="open"/);
  assert.match(CARD, /@keydown\.enter\.self\.prevent="open"/);
  assert.match(CARD, /@keydown\.space\.self\.prevent="open"/);
  assert.ok(!/<button[^>]*class="dscard"/.test(CARD), '外层不能用 <button>：会嵌套按钮，网格错乱');
  const stops = (CARD.match(/@click\.stop/g) || []).length;
  assert.ok(stops >= 8, '卡片内部的按钮必须全部 @click.stop（实际 ' + stops + ' 处）');
});

test('卡片视觉：16:9 封面、右上角 11px 放不下/门、名称 14/600、更新于 MM-DD HH:mm、继续编辑 + ···', () => {
  assert.match(CSS, /\.dscard__thumb\s*\{[\s\S]{0,260}aspect-ratio:\s*16 \/ 9/);
  assert.match(CSS, /\.dscard__badge\s*\{[\s\S]{0,120}font-size:\s*11px/);
  assert.match(CSS, /\.dscard__badge--bad\s*\{\s*background:\s*var\(--bad\)/);
  assert.match(CSS, /\.dscard__badge--warn\s*\{\s*background:\s*var\(--warn\)/);
  assert.match(CARD, /:title="c\.audit\.why"/, '角标必须能被问出来');
  assert.match(CSS, /\.dscard__name\s*\{[\s\S]{0,200}font-size:\s*14px;[\s\S]{0,40}font-weight:\s*600/);
  assert.match(CSS, /\.dscard__name\s*\{[\s\S]{0,240}white-space:\s*nowrap;[\s\S]{0,60}text-overflow:\s*ellipsis/);
  assert.match(CSS, /\.dscard__time\s*\{[\s\S]{0,60}font-size:\s*12px/);
  assert.match(CARD, /更新于 \{\{ c\.updatedText \}\}/);
  assert.match(CARD, />\s*继续编辑\s*</);
  assert.match(CARD, /class="dscard__more-btn"[\s\S]{0,420}···/);
  assert.match(CSS, /\.dscard\s*\{[\s\S]{0,260}box-shadow:\s*var\(--shadow-card\)/);
  assert.match(CSS, /\.dscard:hover\s*\{[\s\S]{0,120}border-color:\s*var\(--brand\)/);
  assert.match(CSS, /\.dscard:hover\s*\{[\s\S]{0,160}box-shadow:\s*var\(--shadow-card-hover\)/);
});

test('更多菜单保留复制/版本历史/删除（回收站恢复），确认条与版本抽屉不能丢', () => {
  assert.match(CARD, /pick\('duplicate'\)/);
  assert.match(CARD, /openHistory/);
  assert.match(CARD, /pick\('ask-delete'\)/);
  assert.match(CARD, /复制一份/);
  assert.match(CARD, /版本历史/);
  assert.match(CARD, /放进回收站/);
  assert.match(CARD, /v-if="view === 'trash'"[\s\S]{0,260}emit\('restore', c\.id\)/);
  assert.match(CARD, /emit\('delete', c\.id\)/);
  assert.match(CARD, /emit\('ask-rollback', c, r\)/);
  assert.match(CARD, /emit\('toggle-history', c\.value\)/);
  assert.match(CARD, /historyNote\(drawer\.rows, drawer\.currentRev\)/);
  assert.match(CARD, /回滚到这一版/);
  assert.match(CARD, /没有真删掉/, '删除确认必须说清「可恢复」');
  assert.match(CARD, /confirming\.kind === 'rollback'/, '回滚确认条不能丢');
  // 确认条与抽屉区必须挡住外层点击，否则点「取消」会顺手打开设计器
  assert.match(CARD, /class="dscard__confirm" @click\.stop/);
  assert.match(CARD, /class="dscard__revs" @click\.stop/);
  // 页面把动作接到共用实现上（写库只有一份）
  assert.match(PAGE, /createSchemeActions\(refresh\)/);
  assert.match(PAGE, /@ask-delete="acts\.askDelete"/);
  assert.match(PAGE, /@restore="acts\.doRestore"/);
  assert.match(PAGE, /@duplicate="acts\.doDuplicate"/);
  assert.match(PAGE, /@toggle-history="acts\.toggleHistory"/);
});

/* ---------------- 取数、状态与兼容约束 ---------------- */

test('状态说法与旧版本都在：加载/失败重试/没有方案/筛没了/回收站空/notice', () => {
  assert.match(PAGE, /正在取方案列表…/);
  assert.match(PAGE, /取不到方案列表：/);
  assert.match(PAGE, /class="my__retry"[\s\S]{0,80}refresh/);
  assert.match(PAGE, /你还没有保存过方案/);
  assert.match(PAGE, /这一组条件下没有方案/);
  assert.match(PAGE, /回收站是空的/);
  assert.match(PAGE, /class="my__notice"[\s\S]{0,160}notice\.text/);
  assert.match(PAGE, /知道了/);
});

test('共享纪律不破：只走 api.mySchemes、卡片走共用组件、能进维护端的账号才有入口', () => {
  assert.match(PAGE, /api\.mySchemes\(/);
  assert.ok(!/adminSchemes/.test(PAGE), '维护端那一口不该出现在这一页');
  assert.ok(!/fetch\(/.test(PAGE.replace(/\/\*[\s\S]*?\*\//g, '')), '取数只走 api.js');
  assert.match(PAGE, /DesignSchemeCard/, '卡片模板走共用组件（旧测试按 SchemeCard 子串钉）');
  assert.match(PAGE, /canAdmin[\s\S]{0,120}enterAdmin/);
  assert.match(PAGE, /v-if="canAdmin"/);
  assert.ok(!/import '\.\.\/admin\/admin\.css'/.test(PAGE), '不再引维护端样式（本页有自己的 my-schemes.css）');
  assert.match(PAGE, /import '\.\/my-schemes\.css'/);
});
