import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/* docs/109 首页设计稿落地：只钉首页自己的文件，不碰登录页/维护端/共享 token。 */
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const HOME = read('../src/pages/HomePage.vue');
const CSS = read('../src/pages/home.css');

test('banner 高度只按内容区宽度算：calc(100cqi / 7.1935)，旧三段公式已删除', () => {
  assert.match(CSS, /\.home__banner\s*\{[\s\S]{0,180}height:\s*calc\(100cqi \/ 7\.1935\)/,
    '容器比例必须恒等于图比例 7.1935:1');
  assert.doesNotMatch(CSS, /212px|100vh - 617px/, '旧上限（像素/视口高）不得残留');
  assert.doesNotMatch(CSS, /height:\s*min\(calc\(100cqi/, '不能再对高度取 min');
  assert.doesNotMatch(CSS, /100vw/, '首页不按视口宽算 banner');
  assert.match(CSS, /\.home__shot\s*\{[\s\S]{0,260}object-fit:\s*contain/, '图整幅显示');
});

test('banner 使用默认卡片阴影；方案卡默认/悬停分别用两档 token', () => {
  assert.match(CSS, /\.home__banner\s*\{[\s\S]{0,360}box-shadow:\s*var\(--shadow-card\)/);
  assert.match(CSS, /\.home__card\s*\{[\s\S]{0,300}box-shadow:\s*var\(--shadow-card\)/);
  assert.match(CSS, /\.home__card:hover\s*\{[\s\S]{0,200}box-shadow:\s*var\(--shadow-card-hover\)/);
  assert.match(CSS, /\.home__card\s*\{[\s\S]{0,360}transition:[^;]*box-shadow/,
    'hover 加深要有过渡，不能生硬跳变');
  assert.match(CSS, /\.home__card:hover\s*\{[\s\S]{0,120}border-color:\s*var\(--brand\)/,
    '悬停仍保留品牌蓝描边');
});

test('卡片墙保留 5 档断点：1328/1072/816/560 → 5/4/3/2/1 列', () => {
  assert.match(CSS, /\.home__wall\s*\{[\s\S]{0,120}grid-template-columns:\s*1fr/);
  assert.match(CSS, /@media \(min-width: 560px\)\s*\{\s*\.home__wall\s*\{\s*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(CSS, /@media \(min-width: 816px\)\s*\{\s*\.home__wall\s*\{\s*grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\);/);
  assert.match(CSS, /@media \(min-width: 1072px\)\s*\{\s*\.home__wall\s*\{\s*grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\);/);
  assert.match(CSS, /@media \(min-width: 1328px\)\s*\{\s*\.home__wall\s*\{\s*grid-template-columns:\s*repeat\(5, minmax\(0, 1fr\)\);/);
});

test('第 1 格固定新建卡，方案卡最多 19 张，不把新建卡挤到后面', () => {
  assert.match(HOME, /const MAX_CARDS = 19;/);
  assert.match(HOME, /\.slice\(0, MAX_CARDS\)\.map\(cardOf\)/);
  const atNew = HOME.indexOf('class="home__new"');
  const atCards = HOME.indexOf('v-for="c in cards"');
  assert.ok(atNew > 0 && atCards > atNew, '新建卡必须在方案卡 v-for 之前');
  assert.match(HOME, /新建场景空间设计方案/);
});

test('视觉尺寸按参考稿：内容区 24/32/32、标题 20、卡名 14/600、更新时间 12「更新于 …」', () => {
  assert.match(CSS, /\.home__body\s*\{[\s\S]{0,120}padding:\s*24px 32px 32px/);
  assert.match(CSS, /\.home__head h1\s*\{[\s\S]{0,120}font-size:\s*20px;[\s\S]{0,40}font-weight:\s*600/);
  assert.match(CSS, /\.home__name\s*\{[\s\S]{0,160}font-size:\s*14px;[\s\S]{0,40}font-weight:\s*600/);
  assert.match(CSS, /\.home__time\s*\{[\s\S]{0,80}font-size:\s*12px/);
  assert.match(HOME, /更新于 \{\{ c\.updatedText \}\}/);
});

test('链接、账号、轮播、空态与无障碍行为都保留，首页不碰登录页/维护端', () => {
  assert.match(HOME, /data-ui-slot="home-guide"/);
  assert.match(HOME, /<AccountBox\s*\/>/);
  assert.match(HOME, /class="home__admin"[\s\S]{0,120}go\('\/admin'\)/);
  assert.match(HOME, /class="home__all"[\s\S]{0,120}go\('\/project'\)/);
  assert.match(HOME, /role="tablist"/);
  assert.match(HOME, /:aria-selected="i === index"/);
  assert.match(HOME, /@mouseenter="pause"/);
  assert.match(HOME, /@mouseleave="resume"/);
  assert.match(HOME, /prefers-reduced-motion/);
  assert.match(HOME, /你还没有方案/);
  assert.match(HOME, /取不到方案列表：/);
  assert.match(HOME, /go\('\/design\/new'\)/);
  assert.ok(!/login/i.test(HOME), '首页不引用登录页实现');
});
