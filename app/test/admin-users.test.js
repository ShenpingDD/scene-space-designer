/**
 * admin-users.test.js —— 维护端「用户」页那些判断（`admin/users.js`）
 *
 * 这一页最容易出的两个错都**看得见却想不到**：
 *   · 把"不知道"显示成"没有"（接口没给 `hasPassword` 就说"口令未设置"，管理员于是白跑一趟）；
 *   · 把失败说成一句"操作失败"（自保、最后一名管理员、名下有方案，三件的下一步动作完全不同）。
 * 所以每一条都钉字面量。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PASSWORD_MIN, USERNAME_RE,
  enabledText, isSelf, passwordText, passwordWhy, roleOptions, schemeCountOf,
  selfWhy, userFailText, userRowOf, usernameWhy,
} from '../src/admin/users.js';

const ROW = {
  id: 3,
  username: 'designer',
  displayName: '前台设计师',
  roleCode: 'designer',
  enabled: 1,
  hasPassword: false,
  schemeCount: 0,
};

/* ---------------- 三态显示：不知道就说不知道 ---------------- */

test('启用状态：两态说人话，缺字段说「—」（不冒充「已停用」）', () => {
  assert.equal(enabledText({ enabled: true }), '已启用');
  assert.equal(enabledText({ enabled: 1 }), '已启用');
  assert.equal(enabledText({ enabled: false }), '已停用');
  assert.equal(enabledText({ enabled: 0 }), '已停用');
  assert.equal(enabledText({}), '—', '接口没给启用状态，不许说成"已停用"');
  assert.equal(enabledText({ enabled: 'yes' }), '—');
});

test('口令是否设过：三态同样分开（这一列决定管理员要不要去重置口令）', () => {
  assert.equal(passwordText({ hasPassword: true }), '已设置');
  assert.equal(passwordText({ hasPassword: false }), '未设置');
  assert.equal(passwordText({}), '—');
});

test('方案条数：缺字段回 null（界面显示「—」），0 与"不知道"是两件事', () => {
  assert.equal(schemeCountOf({ schemeCount: 0 }), 0);
  assert.equal(schemeCountOf({ schemeCount: '4' }), 4);
  assert.equal(schemeCountOf({}), null);
  assert.equal(schemeCountOf({ schemeCount: '' }), null);
  assert.equal(schemeCountOf({ schemeCount: 'x' }), null);
  assert.equal(schemeCountOf(null), null);
});

test('一行数据的汇总：只搬运与翻译，不补任何字段', () => {
  const r = userRowOf(ROW);
  assert.deepEqual(r, {
    id: 3,
    username: 'designer',
    displayName: '前台设计师',
    roleCode: 'designer',
    enabled: true,
    enabledText: '已启用',
    passwordText: '未设置',
    schemeCount: 0,
  });
  // 全空的一行不许抛异常（接口字段改名时要能看见「—」而不是白屏）
  const empty = userRowOf({});
  assert.equal(empty.username, '');
  assert.equal(empty.enabled, null);
  assert.equal(empty.enabledText, '—');
  assert.equal(empty.schemeCount, null);
});

/* ---------------- 自保 ---------------- */

test('自保：自己那一行认得出（id 用字符串比较，数字与字符串混着来也认）', () => {
  assert.equal(isSelf({ id: 3 }, 3), true);
  assert.equal(isSelf({ id: 3 }, '3'), true);
  assert.equal(isSelf({ id: '3' }, 3), true);
  assert.equal(isSelf({ id: 4 }, 3), false);
  assert.equal(isSelf({ id: null }, 3), false, '没有 id 的行不许被当成自己');
  assert.equal(isSelf({ id: 3 }, ''), false, '自己的 id 读不到时不许把谁都当成自己');
  assert.ok(selfWhy({ username: 'admin' }).includes('admin'), '灰按钮的说明要说清是哪个账号');
  assert.ok(selfWhy({ username: 'admin' }).includes('另一位管理员'), '要给出下一步：找另一位管理员');
});

/* ---------------- 角色下拉 ---------------- */

test('角色下拉：四档，顺序与后端同序，标签有中文', () => {
  const opts = roleOptions();
  assert.deepEqual(opts.map((o) => o.code), ['admin', 'editor', 'designer', 'viewer']);
  assert.deepEqual(opts.map((o) => o.label), ['管理员', '维护端维护者', '前台设计师', '只读']);
});

/* ---------------- 输入校验（省一趟后端往返） ---------------- */

test('登录名：2-64 位的字母数字与 `. _ -`，不合格要说清哪里不合格', () => {
  assert.equal(usernameWhy('designer'), '');
  assert.equal(usernameWhy('a.b_c-d'), '');
  assert.equal(usernameWhy('  admin  '), '', '两侧空白不算错');
  assert.match(usernameWhy(''), /要填/);
  assert.match(usernameWhy('a'), /2-64/);
  assert.match(usernameWhy('a'.repeat(65)), /2-64/);
  assert.match(usernameWhy('张三'), /中文/, '中文登录名在登录框里认不出来');
  assert.match(usernameWhy('a b'), /字母/);
  // 正则本身：与 设计决策记录 §五第2项逐字对齐
  assert.equal(USERNAME_RE.source, '^[A-Za-z0-9._-]{2,64}$');
  assert.equal(USERNAME_RE.test('ab'), true);
  assert.equal(USERNAME_RE.test('a'), false);
});

test('口令：至少 8 位', () => {
  assert.equal(PASSWORD_MIN, 8);
  assert.equal(passwordWhy('12345678'), '');
  assert.match(passwordWhy('1234567'), /至少 8 位/);
  assert.match(passwordWhy(''), /要填/);
});

/* ---------------- 失败话术 ---------------- */

test('失败话术：四条守卫各说各的下一步（自保 / 最后一名管理员 / 名下有方案 / 重名）', () => {
  const self = userFailText('self-lockout', '');
  const last = userFailText('last-admin', '');
  const used = userFailText('user-in-use', '这个号名下有 3 份方案');
  const dup = userFailText('conflict', '');
  assert.ok(self.includes('自己'));
  assert.ok(last.includes('最后一名管理员'));
  assert.ok(dup.includes('换一个'));
  assert.equal(used, '这个号名下有 3 份方案', '服务端给了原话就用原话 —— 它带着具体计数');
  for (const [a, b] of [[self, last], [last, used], [used, dup]]) assert.notEqual(a, b);
});

test('失败话术：服务端没给原话时也要给一句能照做的事', () => {
  assert.match(userFailText('user-in-use', ''), /停用/);
  assert.match(userFailText('conflict', ''), /登录名/);
  assert.match(userFailText('bad-role', ''), /admin/);
  assert.match(userFailText('invalid-request', ''), /不合格/);
  assert.match(userFailText('forbidden', ''), /admin/);
  assert.match(userFailText('backend-down', ''), /没有生效/, '说不通后端时要讲清"这次改动没生效"');
  // 认不出的原因也要把原话带上（不要把信息吞掉）
  assert.equal(userFailText('weird-thing', '后端原话'), 'weird-thing：后端原话');
  assert.equal(userFailText('', ''), '原因未知');
});
