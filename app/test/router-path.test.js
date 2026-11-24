/**
 * router-path.test.js —— 真实路径这一档的判据：旧地址接管、兜底口径、跳转出口
 *
 * ## 为什么旧地址这一族的判据一条都不能少
 * `#/view/<口令>` 的二维码已经印到客户手里，`#/designer?scheme=<id>` 之类的地址在维护端
 * 与聊天记录里到处都是。接管规则写错**不会报错**：用户只会看到"打开的是另一份方案"或"回到首页"。
 *
 * ## 「认不出来」也要有判据
 * 地址栏是能乱敲的地方。旧形态认不出来时**回 null**（改写的责任到此为止），
 * 由路由表的兜底规则安静送回首页 —— 白屏是这一族里最坏的结果。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { go, legacyHashRedirect, setNavigator } from '../src/router.js';

/* ---------------- 旧地址（hash 形态）→ 真实路径 ---------------- */

test('旧 `#/view/<口令>` 恰好两段 → `/view/<口令>`（已经发出去的链接不许失效）', () => {
  assert.equal(legacyHashRedirect('#/view/abcd2345'), '/view/abcd2345');
  assert.equal(legacyHashRedirect('  #/view/abcd2345  '), '/view/abcd2345', '两侧空白不算错');
});

test('旧 `#/designer?scheme=<正整数>` → `/design/<id>`', () => {
  assert.equal(legacyHashRedirect('#/designer?scheme=2'), '/design/2');
  assert.equal(legacyHashRedirect('#/designer?scheme=55'), '/design/55');
  assert.equal(legacyHashRedirect('#/designer?a=1&scheme=7'), '/design/7', '参数顺序不该有影响');
  assert.equal(legacyHashRedirect('#/designer?scheme=8&a=1'), '/design/8');
  assert.equal(legacyHashRedirect('#/designer?scheme=%35'), '/design/5', '转义过的数字也认');
});

test('旧 `#/designer`（无参数）→ `/design/new`（无参设计器就是新方案那一档）', () => {
  assert.equal(legacyHashRedirect('#/designer'), '/design/new');
  assert.equal(legacyHashRedirect('#/designer?'), '/design/new');
  // ⚠️ 参数读不出来时**回新方案**，不许猜一个 id：猜出来的 id 会打开别人的方案
  for (const bad of ['abc', '0', '-1', '1.5', '5a', 'x5', 'undefined', 'NaN']) {
    assert.equal(legacyHashRedirect('#/designer?scheme=' + bad), '/design/new', bad + ' 不该被当成 id');
  }
  assert.equal(legacyHashRedirect('#/designer?scheme=%zz'), '/design/new', '坏转义不抛异常');
});

test('旧 `#/admin` 与 `#/admin/...` → 去掉前导 `#`，query 保留', () => {
  assert.equal(legacyHashRedirect('#/admin'), '/admin');
  assert.equal(legacyHashRedirect('#/admin/products'), '/admin/products');
  assert.equal(legacyHashRedirect('#/admin/products/new/manual'), '/admin/products/new/manual');
  assert.equal(legacyHashRedirect('#/admin?tab=params'), '/admin?tab=params');
  // 多斜杠与尾斜杠要归一化（用户粘贴半截地址是常事）
  assert.equal(legacyHashRedirect('#//admin//'), '/admin');
});

test('半截地址与旧形态的分享口令不改写（交给兜底规则，安静回首页）', () => {
  // 半截地址被当成"口令错了"，人只会以为链接坏了 —— 所以这里不接管
  assert.equal(legacyHashRedirect('#/view'), null);
  assert.equal(legacyHashRedirect('#/view/a/b'), null);
  // 旧 32 位形态已下线（V13 全部撤销），认它只会给出一句与事实不符的话
  assert.equal(legacyHashRedirect('#/s/abcdefghjkmnpqrstuvwxyz23456789'), null);
});

test('认不得的旧地址一律回 null（大小写敏感、不模糊匹配）', () => {
  for (const h of ['', '#', '/', '#/', null, undefined, '   ', 'admin', '#/admn', '#/admin-x', '#/products', '#/Admin', '#/whatever/deep']) {
    assert.equal(legacyHashRedirect(h), null, JSON.stringify(h) + ' 不该被改写');
  }
  // 没有 `#` 的地址已经是真实路径，不属于"旧地址"，不在这里处理
  assert.equal(legacyHashRedirect('/design/2'), null);
});

/* ---------------- 跳转只有一个出口 ---------------- */

test('`go` 没接上路由时**当场抛出**（不许悄悄什么都不做）', () => {
  assert.throws(() => go('/index'), /go\(\) 还没接上路由/, '未装配就跳转 = 点了没反应，必须响亮地错');
});

test('`go` 接上之后把斜杠补齐的路径交给导航函数（调用点不用自己拼）', () => {
  const seen = [];
  setNavigator((p) => seen.push(p));
  go('/design/2');
  go('index');
  go('  /admin/users  ');
  assert.deepEqual(seen, ['/design/2', '/index', '/admin/users']);
  // 拆掉之后回到"抛出"状态：装配关系是可换的，不是一次性的
  setNavigator(null);
  assert.throws(() => go('/index'), /go\(\) 还没接上路由/);
});
