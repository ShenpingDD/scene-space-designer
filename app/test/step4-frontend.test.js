/**
 * 步骤4B：声明尺寸显式确认 / 无门与未判断 / 去掉假门兜底。
 *
 * Vue 组件没有渲染测试器，所以这里分两层：
 *   · 纯函数用行为断言（dimsOf / declaredMissing / buildPayload）
 *   · 界面规则用源码挂点锁住（提交闸门、按钮文案、none 选项、Inspector 不再造铰链）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dimsOf, declaredMissing, declaredSourceOf, declaredFromMeasured, buildPayload } from '../src/admin/wizard.js';
import { canOpen, doorPartLabel } from '../src/kernel.js';

const read = (p) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');

test('dimsOf：空表单不再回退实测 bbox；三轴必须人工给', () => {
  const analysis = { picks: { size: { w: 700, d: 730, h: 850 } } };
  assert.deepEqual(dimsOf({}, analysis), { w: null, d: null, h: null },
    '实测只能校准，不能静默变成声明');
  assert.deepEqual(dimsOf({ w: '595', d: 800, h: 1990 }, analysis), { w: 595, d: 800, h: 1990 });
  assert.deepEqual(dimsOf({ w: -1, d: 0, h: '' }, analysis), { w: null, d: null, h: null });
});

test('declaredMissing：逐轴指出缺哪几个，不猜也不补', () => {
  assert.deepEqual(declaredMissing({}), [
    { key: 'w', label: '宽' }, { key: 'd', label: '深' }, { key: 'h', label: '高' },
  ]);
  assert.deepEqual(declaredMissing({ w: 1, d: null, h: 3 }), [{ key: 'd', label: '深' }]);
  assert.deepEqual(declaredMissing({ w: 1, d: 2, h: 3 }), []);
});

test('declaredFromMeasured：只有点按钮才一次写三轴并标记 measured', () => {
  const picked = declaredFromMeasured({ w: null, d: null, h: null }, { w: 595, d: 800, h: 1990 });
  assert.deepEqual([picked.w, picked.d, picked.h], [595, 800, 1990]);
  assert.equal(picked.declaredSource, 'measured');
  assert.equal(declaredSourceOf(picked), 'measured');
  assert.equal(declaredSourceOf({ w: 1, d: 2, h: 3 }), 'manual');
});

test('payload：声明尺寸只从表单进 recipe；来源标记 measured/manual 可追溯', () => {
  const measured = buildPayload(
    { name: 'X', modelNo: 'M', w: 1, d: 2, h: 3, declaredSource: 'measured' },
    { picks: { size: { w: 9, d: 9, h: 9 } } },
    {},
  );
  const recipe = JSON.parse(measured.product.recipeJson);
  assert.deepEqual([recipe.w, recipe.d, recipe.h], [1, 2, 3], '不能把分析器的 9/9/9 当声明');
  assert.equal('declaredSource' in measured.product, false, 'API payload 不带无主字段');
  assert.equal(declaredSourceOf({}), 'manual');
  assert.equal(declaredSourceOf({ declaredSource: 'measured' }), 'measured');
});

test('向导：声明尺寸卡片同时展示实测 bbox 与声明，按钮才填三轴，空值阻止提交', () => {
  const src = read('app/src/admin/ProductWizard.vue');
  assert.match(src, /实测 bbox（mm，仅校准）/);
  assert.match(src, /声明尺寸（mm，占地权威）/);
  assert.match(src, /data-wz-use-measured[^>]*>用实测尺寸作为声明/);
  assert.match(src, /function useMeasuredAsDeclared\(\)[\s\S]{0,420}declaredFromMeasured\(form\.value, m\)[\s\S]{0,160}envelopeMode', '1:1'/,
    '按钮必须一次性填三轴并标记来源');
  assert.match(src, /data-wz-declared-missing/);
  assert.match(src, /if \(!isVariant\.value && !declaredComplete\.value\)[\s\S]{0,260}step\.value = STEPS\.BASIC/,
    '提交前空声明必须回到字段页并阻止');
  assert.match(src, /data-wz-size-note-missing/);
});

test('向导/编辑页：none→无门；空值显示未判断，不显示柜门', () => {
  const wz = read('app/src/admin/ProductWizard.vue');
  const edit = read('app/src/admin/ProductEdit.vue');
  const cards = read('app/src/admin/ProductCards.vue');
  assert.match(wz, /<option value="none">无门<\/option>/);
  assert.match(edit, /key: 'none', label: '无门'/);
  assert.match(edit, /（未判断）/);
  assert.match(wz, /DOOR_LABEL\[form\.doorPart\] \|\| '（未判断）'/);
  assert.match(cards, /doorPartLabel\(part\) \|\| '未判断'/, '空门型不能显示成柜门');
  assert.equal(doorPartLabel('none'), '无门');
  assert.equal(doorPartLabel(''), '未确认');
});

test('Inspector：没有真实 hinges 不 canOpen、不渲染开门按钮', () => {
  const src = read('app/src/components/Inspector.vue');
  assert.doesNotMatch(src, /p\.hinges \?\?/, '假铰链兜底必须删掉');
  assert.doesNotMatch(src, /recipeId \? \[\{ axis: 'y' \}\]/, '不能按 recipeId 造铰链');
  assert.match(src, /Array\.isArray\(p\.hinges\) \? p\.hinges : \[\]/);
  assert.match(src, /v-if="doorSupported" class="field" data-inspector-door/);
  assert.match(src, /data-inspector-no-door/);
  assert.match(src, /无可动门 \/ 未提供门几何/);
  assert.equal(canOpen({ hinges: [] }), false);
  assert.equal(canOpen({ hinges: [{ axis: 'y' }] }), true);
});
