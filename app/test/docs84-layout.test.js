/**
 * docs84-layout.test.js —— docs/84 设计端布局改版的源码判据
 *
 * 版面本身靠真机截图验收；这一层只钉那些**改回去不会报错、但会悄悄破坏版面**的契约：
 * 底栏又冒出来、六个模式按钮被塞回工具条、提示行离开视图栏、右栏顺序被打乱、
 * 折叠容器丢 aria/丢本机记忆。判据只读源码，不启动 DOM。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const strip = (s) => String(s)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/\/\/[^\n]*/g, ' ');

const app = read('app/src/App.vue');
const css = read('app/src/style.css');
const plan = read('app/src/components/PlanView.vue');
const prod = read('app/src/components/ProductRail.vue');
const insp = read('app/src/components/Inspector.vue');
const rail = read('app/src/components/RailFold.vue');
const panel = read('app/src/components/SchemePanel.vue');

test('docs/84 顶栏：方案名/状态/视图分段/保存按钮各就各位，底栏撤掉', () => {
  assert.match(app, /class="doc__name"/, '顶栏要显示方案名·版本');
  assert.match(app, /class="doc__status"/, '顶栏要显示保存状态三态文字');
  assert.match(app, /data-view="2d"/, '平面设计要有 data-view=2d');
  assert.match(app, /data-view="3d"/, '三维预览要有 data-view=3d');
  assert.match(panel, /data-act="save"/, '保存按钮要有 data-act=save');
  assert.doesNotMatch(strip(panel), /保存至方案库/, '主按钮文案只写「保存」');
  assert.doesNotMatch(app, /<footer\b/, '底栏必须撤掉（房间数与尺寸在右栏空间体检）');
  assert.doesNotMatch(strip(css), /\.footer\s*\{/, '全局样式里不该再留底栏样式');
  // 保存是主按钮，排在最前：顺序错了会把「撤销」变成视觉上的主操作
  assert.ok(app.indexOf('<SchemePanel') > 0 && app.indexOf('<SchemePanel') < app.indexOf('aria-label="撤销"'),
    '保存按钮要排在撤销前面');
});

test('docs/84 + docs/97 画布：工具条放七个模式按钮，提示/缩略图/缩放搬进下方视图栏', () => {
  const toolsAt = plan.indexOf('class="plan-tools"');
  const svgAt = plan.indexOf('class="plan"');
  const viewsAt = plan.indexOf('class="plan-views"');
  assert.ok(toolsAt > 0 && svgAt > toolsAt && viewsAt > svgAt,
    '版面顺序必须是：上方工具条 → 画布 → 下方视图栏');

  const tools = plan.slice(toolsAt, svgAt);
  for (const tool of ['wall', 'opening', 'window', 'room', 'split', 'route', 'column']) {
    assert.match(tools, new RegExp(`data-tool="${tool}"`), `工具条要有 data-tool=${tool}`);
  }
  assert.equal((tools.match(/data-tool="/g) || []).length, 7, '工具条应有七个模式按钮（docs/101 加画柱）');

  const views = plan.slice(viewsAt);
  assert.match(views, /id="plan-keys"/, '模式提示要在视图栏');
  assert.match(views, /data-tool="thumbs"/, '缩略图开关要在视图栏');
  assert.match(views, /class="zoom"/, '缩放簇要在视图栏');
  assert.match(plan, /aria-describedby="plan-keys"/, '画布要指向当前那条提示');
  assert.doesNotMatch(plan, /class="plan-legend"/, '旧图例占掉 62px 画布高度，docs/84 的三行版面没有它');
});

test('docs/84 右栏：六块顺序固定，折叠容器带 aria 与本机记忆', () => {
  const order = [
    'title="空间体检"',
    '<RoomSizeCard',
    '<RoomList',
    '<InteriorWallCard',
    'title="外观"',
    ':title="selTitle"',
  ].map((needle) => insp.indexOf(needle));
  assert.ok(order.every((i) => i >= 0), '六块要都能在 Inspector 里找到');
  assert.deepEqual([...order].sort((a, b) => a - b), order, '右栏顺序必须是 体检→尺寸→房间→内墙→外观→选中');

  assert.match(rail, /spatial\.designer\.rail/, '折叠状态要存在这个键');
  assert.match(rail, /aria-expanded/, '折叠按钮要有 aria-expanded');
  assert.match(rail, /aria-controls/, '折叠按钮要有 aria-controls');
  assert.match(rail, /v-show="open"/, '卡体用 v-show 留在文档里，aria-controls 才不指向空气');
  assert.match(rail, /<button[\s\S]*?rail-fold__toggle/, '折叠按钮必须是真 button');
  assert.match(insp, /data-rooms-foot/, '房间数与尺寸要在空间体检里');
  assert.match(css, /\.rail--right\s*>\s*\.card\s*\{\s*flex:\s*none/, '右栏卡片不能被压扁，否则整栏永远滚不动');
});

test('docs/84 左栏：只剩模型库一块，空间尺寸与内墙不再出现', () => {
  assert.match(prod, /模型库/, '左栏标题要改成模型库');
  assert.doesNotMatch(strip(prod), /空间尺寸/, '空间尺寸已搬到右栏');
  assert.doesNotMatch(strip(prod), /内墙/, '内墙已搬到右栏');
  assert.match(css, /grid-template-columns:\s*280px minmax\(0,\s*1fr\) 320px/,
    '1440 档列宽 280 / 1fr / 320');
  assert.match(css, /@media \(max-width: 1366px\)[\s\S]*?grid-template-columns:\s*240px minmax\(0,\s*1fr\) 300px/,
    '≤1366 档列宽 240 / 1fr / 300');
});
