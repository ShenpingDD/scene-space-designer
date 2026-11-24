/**
 * 验收-2 产品库 / 编辑页判据（静态源码锁）。
 *
 * 这一页的事实很多来自后端：声明尺寸必须三轴齐全、thumbFile 只认 assets/thumbs/、
 * 内容保存与发布是两步。界面里少一个入口或顺序反了，都不会报错，只会让人
 * 悄悄丢字段 / 看到旧缩略图 / 以为内容发布了。所以这里锁住入口、字段与调用顺序。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const cards = read('app/src/admin/ProductCards.vue');
const app = read('app/src/admin/AdminApp.vue');
const edit = read('app/src/admin/ProductEdit.vue');
const css = read('app/src/admin/admin.css');

test('产品库页签与页面标题都叫「产品模型库」，路由 key 仍是 products', () => {
  assert.match(app, /label:\s*'产品模型库'/, 'AdminApp 页签标签');
  assert.match(app, /产品模型库 · 场景方案库/, '维护端头部副标题');
  assert.match(cards, /<h1 class="pl__title">产品模型库<\/h1>/, '列表页标题');
  assert.match(app, /\{ key: 'products', label: '产品模型库', path: '\/admin' \}/,
    'tab key 必须仍是 products（其它路由按它判定）');
});

test('编辑入口走 /admin/products/{id}/edit，且 AdminApp 真的渲染 ProductEdit', () => {
  assert.match(cards, /data-product-edit/);
  assert.match(cards, /'\/admin\/products\/' \+ p\.id \+ '\/edit'/);
  assert.match(app, /s\[3\] === 'edit'.*'productEdit'/,
    '路由 /admin/products/{id}/edit 要映射到 productEdit');
  assert.match(app, /<ProductEdit v-else-if="tab === 'productEdit'"/);
  assert.match(app, /:product-id="routePid"/, '编辑页必须收到当前产品 id');
});

test('删除是卡片内二次确认：说清数据库 / 方案 / 模型文件三件事，成功只移除本地行', () => {
  assert.match(cards, /data-product-delete/);
  assert.match(cards, /data-delete-confirm/);
  assert.match(cards, /data-delete-submit/);
  assert.match(cards, /api\.adminDeleteProduct\(p\.id\)/);
  assert.match(cards, /数据库记录删除，已存方案不受影响；模型文件不物理删除/,
    '删除确认必须同时交代这三件事');
  assert.match(cards, /products\.value = products\.value\.filter\(/,
    '删除成功后本地移除这一行，不必重取整张列表');
  assert.match(cards, /deleteTrouble/, '删除失败要把原因留在卡片上');
});

test('缩略图优先读 p.model.thumbFile（draft 也有），目录渲染只做兜底', () => {
  assert.match(cards, /p\.model\.thumbFile/, '第一优先来源必须是服务端缩略图');
  assert.match(cards, /serverThumb\(p\) \|\| thumbs\.value\[p\.recipeId\]/,
    '顺序不能反：服务端真图优先，thumbFor 才是兜底');
  assert.match(cards, /<img v-if="thumbOf\(p\)"/);
});

test('编辑页字段与保存调用齐全：产品事实、声明尺寸、门型、缩略图、内容两步', () => {
  for (const f of ['name', 'description', 'series', 'sourceUrl', 'sizeNote', 'color',
    'declaredW', 'declaredD', 'declaredH', 'doorPart', 'doorVerified']) {
    assert.match(edit, new RegExp('data-product-field="' + f + '"'), '缺字段：' + f);
  }
  assert.match(edit, /<ProductContentFields/, '卖点/参数必须复用同一套字段组件');
  assert.match(edit, /api\.adminUpdateProduct\(props\.productId, body\)/);
  assert.match(edit, /api\.adminUploadThumb\(file\)/);
  assert.match(edit, /api\.adminSaveProductContent\(props\.productId/);
  assert.match(edit, /api\.adminPublishProductContent\(props\.productId/);
  assert.match(edit, /expectedRev:\s*contentRev\.value/, '发布必须带保存后的 rev');
  assert.match(edit, /declared:\s*\{[\s\S]{0,160}w: numOrNull/);
  assert.match(edit, /model:\s*\{[\s\S]{0,220}thumbFile/);
  assert.match(edit, /envelopeMode/);
  assert.match(edit, /anisotropyOk/);
});

test('保存顺序：产品信息 → 内容（仅变化时）→ 发布；声明尺寸三轴齐全才发请求', () => {
  const update = edit.indexOf('api.adminUpdateProduct');
  const save = edit.indexOf('api.adminSaveProductContent');
  const publish = edit.indexOf('api.adminPublishProductContent');
  assert.ok(update > 0, '缺 adminUpdateProduct');
  assert.ok(save > update, '内容保存必须在产品信息之后');
  assert.ok(publish > save, '发布必须在内容保存之后');
  assert.match(edit, /if \(contentChanged\)/, '内容没变化不该重复发布');
  assert.match(edit, /声明尺寸需要宽\/深\/高三轴齐全/,
    '后端 declared 三轴必填；界面要先说清而不是等 400');
  assert.match(edit, /保存失败（编辑内容还在）/, '内容保存失败必须保留编辑内容');
});

test('声明尺寸输入允许小数：step=any，否则 1339.565 会让 form.checkValidity=false，保存按钮点了没反应', () => {
  assert.match(edit, /data-product-field="declaredW" type="number" min="1" step="any"/);
  assert.match(edit, /data-product-field="declaredD" type="number" min="1" step="any"/);
  assert.match(edit, /data-product-field="declaredH" type="number" min="1" step="any"/);
});

test('编辑页声明尺寸改变会重算 envelope/anisotropy，不能沿用旧结论', () => {
  assert.match(edit, /import \{ anisotropyOf, envelopeOkFor \} from '\.\/analyze\.js'/, '必须复用同一套尺寸判据');
  assert.match(edit, /const sizeVerdict = computed/, '尺寸结论要随声明值重算');
  assert.match(edit, /envelopeOk:\s*sizeVerdict\.value\.envelopeOk/, '保存时不能用旧 envelopeOk');
  assert.match(edit, /anisotropyOk:\s*sizeVerdict\.value\.anisotropyOk/);
  assert.match(edit, /content\.model\.declared|r\.model\.declared/, '声明尺寸要从 content.model.declared 回填');
  assert.match(edit, /data-product-field="envelopeMode"/, '尺寸口径要可选（1:1 / fit）');
});

test('编辑页样式只在 .pe / 产品库标题 / 删除确认范围内，不碰其它面板', () => {
  assert.match(css, /\.pl__title/);
  assert.match(css, /\.pe__title/);
  assert.match(css, /\.pe__grid/);
  assert.match(css, /\.pcard__confirm--danger/);
  assert.doesNotMatch(css, /^\.pe__title\s+body/m, '不应有全局 body 覆盖');
});
