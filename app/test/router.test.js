/**
 * router.test.js —— 地址形态的判据（真实路径）
 *
 * 链接错了是**白屏级**故障（点了没反应、客户收到打不开的链接），所以这里钉的不是"能跑"，
 * 而是各种边界：非法 id、空白、小数、前导零、坏转义。
 *
 * 只测纯函数：`go` 是转交给 vue-router 的薄封装，`currentPath` 读 `window` ——
 * 它们在 node 里没有 window，靠真机探针覆盖（不是漏测，是分工）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROUTES, schemeHref, schemeIdOf, shareHref, shareTokenOf } from '../src/router.js';

test('路由名是七个，且是 ASCII 标识（判据靠它认页面）', () => {
  assert.deepEqual(Object.values(ROUTES).sort(), ['admin', 'design', 'design-new', 'home', 'login', 'project', 'share']);
});

/* ---------------- 方案链接（`/design/<id>`） ---------------- */

test('造链接：形状是 `/design/<id>`，而且**路由表真的认它**', () => {
  assert.equal(schemeHref(5), '/design/5');
  assert.equal(schemeHref('7'), '/design/7');
  assert.equal(schemeHref(5.9), '/design/5', '小数取整，不造出读不回来的链接');
  // ⚠️ 这条是**跨两件事的钉子**：链接造出来如果路由落不到设计器，点了就是没反应 ——
  //    而那不会报错，只会悄悄不生效。路由表在 routes.js（不 import vue-router 的地方读不了），
  //    这里钉住形状本身，路由表那一条在 `u1-source.test.js` 里按源码断言。
  assert.match(schemeHref(5), /^\/design\/[1-9][0-9]*$/);
});

test('造链接：非法 id 造出空串（宁可不造，也不造一个打不开的）', () => {
  for (const bad of [0, -1, null, undefined, '', 'abc', NaN, Infinity]) {
    assert.equal(schemeHref(bad), '', JSON.stringify(bad) + ' 不该造出链接');
  }
});

test('解链接：只认纯数字的正整数', () => {
  assert.equal(schemeIdOf('5'), 5);
  assert.equal(schemeIdOf(5), 5);
  assert.equal(schemeIdOf('  7  '), 7, '两侧空白不算错');
  assert.equal(schemeIdOf('12345'), 12345);
});

test('解链接：取不到就回 null，绝不猜一个 id 出来', () => {
  for (const bad of ['', ' ', null, undefined, 'abc', '0', '-1', '1.5', '5a', 'x5', 'undefined', 'NaN', '%35', '/5']) {
    assert.equal(schemeIdOf(bad), null, JSON.stringify(bad) + ' 不该被当成 id');
  }
  // `0` 与 `-1` 尤其要说清：它们"看起来像数字"，但方案 id 从 1 开始
  assert.equal(schemeIdOf('0'), null);
  assert.equal(schemeIdOf(-1), null);
});

test('**来回一趟必须对上**（造链接与解链接是同一个格式的两个方向）', () => {
  for (const id of [1, 2, 5, 16, 19, 12345]) {
    assert.equal(schemeIdOf(schemeHref(id).split('/')[2]), id, 'id=' + id + ' 来回一趟对不上');
  }
});

/* ---------------- 分享链接（`/view/<口令>`） ---------------- */

test('分享链接：形状是 `/view/<口令>`，**不再有 `#`**', () => {
  assert.equal(shareHref('abcdefgh'), '/view/abcdefgh');
  assert.doesNotMatch(shareHref('abcdefgh'), /#/, 'U1 起是真实路径，井号已经去掉');
});

test('shareHref：没口令就回空串（不许拼出一条 /view/ 的空链接）', () => {
  assert.equal(shareHref(''), '');
  assert.equal(shareHref(null), '');
  assert.equal(shareHref(undefined), '');
  assert.equal(shareHref('   '), '');
  assert.equal(shareHref('  abc  '), '/view/abc', '去掉首尾空白');
});

test('解口令：只管取，不判合法性（合法与否在服务端 `Share.looksLikeToken`）', () => {
  assert.equal(shareTokenOf('abcd2345'), 'abcd2345');
  assert.equal(shareTokenOf('  abcd2345 '), 'abcd2345');
  // 长度与字符集**不在这里判**：前端多判一条就会多出"界面说不对、服务端其实认得"的分歧
  assert.equal(shareTokenOf('abc'), 'abc');
  assert.equal(shareTokenOf(''), null);
  assert.equal(shareTokenOf(null), null);
  assert.equal(shareTokenOf('   '), null);
});
