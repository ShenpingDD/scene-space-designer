/**
 * 2D 设备边框可读性：分类色退出画布，状态不靠颜色单独表达。
 *
 * 这类回归不会让构建失败：只要有人把 `it.product.color` 加回 `stroke`，页面照样能打开，
 * 但画布会重新变成蓝/橙/灰混杂。这里用源码判据钉住“本体/前脸/选中/问题/净空”的分层。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');
const plan = read('app/src/components/PlanView.vue');
const css = read('app/src/style.css');

const itemBlock = (() => {
  const at = plan.indexOf('v-for="it in d.scene.value.items"');
  assert.ok(at > 0, '设备渲染块必须还在');
  return plan.slice(at, plan.indexOf('<!-- 动线站点', at));
})();

test('2D 设备本体不使用目录分类色：统一 ink-2 描边 + line 填充', () => {
  assert.doesNotMatch(plan, /it\.product\.color/,
    '分类色不能在 2D 画布里出现；它只属于左栏型号卡');
  assert.match(itemBlock, /class="item-body"/, '设备本体要有 item-body');
  assert.match(itemBlock, /class="item-front"[^>]*fill="none"/, '前脸仍要单独画');
  assert.match(css, /\.plan \.item-body \{[^}]*stroke: var\(--ink-2\)/,
    '所有设备本体用同一个深中性描边');
  assert.match(css, /\.plan \.item-body \{[^}]*fill: var\(--line\)/,
    '本体填充用现有中性 token，不新增品牌色');
  assert.match(css, /\.plan \.item-front \{[^}]*stroke: var\(--ink\)/,
    '前脸同属中性色但更深，做方向提示');
});

test('选中是品牌色 + 外圈虚线 + 加粗，不只靠颜色', () => {
  assert.match(itemBlock, /v-if="d\.selectedId\.value === it\.id"[^>]*class="item-select-ring"/,
    '选中态要有独立外圈（第二通道）');
  assert.match(css, /\.plan \.item\.is-selected \.item-body \{[^}]*stroke: var\(--brand\)/,
    '选中本体描边用品牌色');
  assert.match(css, /\.plan \.item\.is-selected \.item-body \{[^}]*stroke-width: calc\(3\.2 \* var\(--u\)\)/,
    '选中还要加粗，避免只靠色相区分');
  assert.match(css, /\.plan \.item-select-ring \{[^}]*stroke-dasharray/,
    '选中外圈用虚线，形成线型第二通道');
});

test('问题/净空保留状态色，并用线型/aria 做第二通道；本体不被染色', () => {
  assert.match(itemBlock, /v-if="issueIds\.has\(it\.id\)" class="item-bad"/,
    '问题设备保留红色虚线覆盖');
  assert.match(css, /\.plan \.item-bad \{[^}]*stroke: var\(--bad\)/,
    '问题覆盖仍是 bad 红');
  assert.match(css, /\.plan \.item-bad \{[^}]*stroke-dasharray/,
    '问题第二通道是虚线');
  assert.match(css, /\.plan \.item\.lv-warn \.door-arc \{[^}]*stroke-dasharray/,
    '净空 warn 的门弧改长虚线，不只换颜色');
  assert.match(css, /\.plan \.item\.lv-bad \.door-arc \{[^}]*stroke-dasharray/,
    '净空 bad 的门弧改密虚线，不只换颜色');
  assert.doesNotMatch(css, /\.plan \.item\.lv-(warn|bad) \.item-body/,
    '净空等级不能给整台设备本体染色');
  assert.match(itemBlock, /:data-item-selected=/);
  assert.match(itemBlock, /:data-item-issue=/);
  assert.match(itemBlock, /:data-item-clearance=/);
  assert.match(itemBlock, /:aria-label="itemAria\(it\)"/,
    '选中/问题/净空要进读屏名字');
  assert.match(plan, /门开启净空提醒/);
  assert.match(plan, /门开启净空不足/);
  assert.match(plan, /布局问题：\$\{issue\}/);
});
