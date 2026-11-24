/**
 * step4-2d-borders.test.js —— t24：2D 平面设备边框统一
 *
 * 只钉“画布不拿分类色表达状态”这一条。分类色仍在左栏型号卡；
 * 画布里本体/前脸统一中性色，选中用品牌色+外圈，问题红虚线，净空只走门弧。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/components/PlanView.vue', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/style.css', import.meta.url), 'utf8');

function block(selector) {
  const start = css.indexOf(selector);
  assert.ok(start >= 0, `缺样式 ${selector}`);
  const end = css.indexOf('}', start);
  return css.slice(start, end + 1);
}

test('2D 设备不再把 product.color 写进 SVG', () => {
  assert.doesNotMatch(src, /:style="\{ color: it\.product\.color \}"/);
  assert.doesNotMatch(src, /:stroke="it\.product\.color"/);
  assert.doesNotMatch(src, /:fill="it\.product\.color"/);
});

test('本体/前脸统一中性色，分类色不参与画布状态', () => {
  const body = block('.plan .item-body {');
  assert.match(body, /stroke: var\(--ink-2\)/);
  assert.match(body, /fill: var\(--line\)/);
  const front = block('.plan .item-front {');
  assert.match(front, /stroke: var\(--ink\)/);
});

test('选中态用品牌色 + 外圈第二通道，不是只加粗', () => {
  const selected = block('.plan .item.is-selected .item-body');
  assert.match(selected, /stroke: var\(--brand\)/);
  const ring = block('.plan .item-select-ring');
  assert.match(ring, /stroke: var\(--brand\)/);
  assert.match(ring, /stroke-dasharray/);
});

test('问题仍是红色虚线；净空分级只改门弧线型/颜色', () => {
  const bad = block('.plan .item-bad');
  assert.match(bad, /stroke: var\(--bad\)/);
  assert.match(bad, /stroke-dasharray/);
  const warnArc = block('.plan .item.lv-warn .door-arc');
  assert.match(warnArc, /stroke-dasharray/);
  const badArc = block('.plan .item.lv-bad .door-arc');
  assert.match(badArc, /stroke-dasharray/);
});
