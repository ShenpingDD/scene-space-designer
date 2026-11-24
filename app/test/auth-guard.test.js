/**
 * auth-guard.test.js —— 登录这一层的判据：回跳地址、放行判定、失败话术、CSRF 头
 *
 * 这四族错起来都**不会报错**：
 *   · 回跳地址不校验 → 输完口令被送去站外（开放重定向），界面上一切都"正常"；
 *   · 放行判定写错 → 分享链接要求先登录（客户看到一堵墙），或者未登录的人进了设计器；
 *   · 失败话术混成一句 → 用户只能乱试；
 *   · CSRF 头没带上 → 写操作 403，而界面会说成"服务端挡下了角色"，指错方向。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOME_PATH, LOGIN_PATH, isLoginPath, loginFailText, loginHref, routeDecision, safeRedirect } from '../src/guard.js';
import { CSRF_COOKIE, CSRF_HEADER, REASON, csrfHeaderOf } from '../src/api.js';

/* ---------------- 回跳地址：构造（F3） ---------------- */

test('回跳地址的构造：参数名与转义只在这一处', () => {
  assert.equal(loginHref('/design/2'), '/login?redirect=%2Fdesign%2F2');
  assert.equal(loginHref('/project'), '/login?redirect=%2Fproject');
  // ⚠️ 目标里带 `&` 与 `?` 时必须转义，否则回跳会被截成半截地址
  assert.equal(loginHref('/admin/users?tab=1&x=2'),
    '/login?redirect=' + encodeURIComponent('/admin/users?tab=1&x=2'));
  assert.ok(!loginHref('/admin/users?tab=1&x=2').includes('&x=2'),
    '不转义的话 `&x=2` 会变成登录页自己的参数');
});

/* ---------------- 回跳地址：站内校验（F4，成对） ---------------- */

test('回跳地址的站内校验：站内相对路径原样收下', () => {
  assert.equal(safeRedirect('/design/2'), '/design/2');
  assert.equal(safeRedirect('/project'), '/project');
  assert.equal(safeRedirect('/admin/users?tab=1'), '/admin/users?tab=1');
  assert.equal(safeRedirect('/view/abcd2345'), '/view/abcd2345', '分享页也在站内');
  assert.equal(safeRedirect('  /index  '), '/index', '两侧空白不算错');
});

test('回跳地址的站内校验：站外与打转的一律回首页', () => {
  for (const bad of [
    '//evil.com',                 // 协议相对地址：浏览器会当成 https://evil.com
    'https://evil.com',
    'http://evil.com/x',
    '/\\evil.com',                // 浏览器把反斜杠当斜杠
    '\\/evil.com',
    '/a\\b',
    'javascript:alert(1)',
    '',
    '   ',
    null,
    undefined,
    'design/2',                   // 不以斜杠开头的不算站内路径
    '/login',                     // 跳回登录页就是打转
    '/login?redirect=%2Findex',
    '/login/x',
    '/index' + String.fromCharCode(0),   // 控制字符也不收（地址里混进不可见字符只会让人看不懂）
  ]) {
    assert.equal(safeRedirect(bad), HOME_PATH, JSON.stringify(bad) + ' 不该被收下');
  }
});

test('回跳地址：收下的东西一定还在站内（过一遍是幂等的）', () => {
  for (const p of ['/design/2', '/project', '/admin/users?tab=1', '/view/abcd2345']) {
    assert.equal(safeRedirect(safeRedirect(p)), p, p + ' 过两遍就变了');
  }
});

/* ---------------- 放行判定表（F8，成对） ---------------- */

const to = (path, meta = {}, params = {}) => ({ path, fullPath: path, meta, params });

test('未登录：受保护页面去登录页，并带上原来要去的地方', () => {
  for (const path of ['/design/2', '/design/new', '/project', '/index', '/admin/users']) {
    const d = routeDecision(to(path), false);
    assert.equal(d.action, 'redirect', path + ' 未登录该跳登录页');
    assert.ok(d.to.startsWith('/login?redirect='), path + ' 要带回跳参数：' + d.to);
    assert.ok(d.to.includes(encodeURIComponent(path)), path + ' 回跳参数里要是它自己');
  }
});

test('未登录：公开页放行（分享页要人先登录，客户就看不到内容了）', () => {
  assert.equal(routeDecision(to('/login', { public: true }), false).action, 'allow');
  assert.equal(routeDecision(to('/view/abcd2345', { public: true }), false).action, 'allow');
});

test('已登录：访问登录页回首页，其它页面照常放行', () => {
  assert.deepEqual(routeDecision(to('/login', { public: true }), true), { action: 'redirect', to: HOME_PATH });
  assert.equal(routeDecision(to('/design/2', { designDetail: true }, { id: '2' }), true).action, 'allow');
  assert.equal(routeDecision(to('/admin/users'), true).action, 'allow');
  assert.equal(routeDecision(to('/index'), true).action, 'allow');
});

test('已登录：`/design/<id>` 的 id 读不出来就回首页（不拿一份"看起来像"的方案盖掉编辑区）', () => {
  for (const bad of ['abc', '0', '-1', '1.5', '']) {
    const d = routeDecision(to('/design/' + bad, { designDetail: true }, { id: bad }), true);
    assert.deepEqual(d, { action: 'redirect', to: HOME_PATH }, bad + ' 该回首页');
  }
});

test('公开页优先于登录页那条规则（`meta.public` 是唯一的免登录标记）', () => {
  // 已登录的人打开分享链接照样放行 —— 分享页不该因为"你登录了"就跳走
  assert.equal(routeDecision(to('/view/abcd2345', { public: true }), true).action, 'allow');
});

test('登录页识别：带 query 的形态也算登录页（否则会话失效会反复跳自己）', () => {
  assert.equal(isLoginPath('/login'), true);
  assert.equal(isLoginPath('/login?redirect=%2Findex'), true);
  assert.equal(isLoginPath('/login/x'), true);
  assert.equal(isLoginPath('/logins'), false, '前缀相同但不是它');
  assert.equal(isLoginPath('/index'), false);
  assert.equal(LOGIN_PATH, '/login');
  assert.equal(HOME_PATH, '/index');
});

/* ---------------- 登录失败话术 ---------------- */

test('登录失败：四种原因给四句不同的话（下一步动作不同）', () => {
  const cred = loginFailText('bad-credentials', '账号或密码不对');
  const disabled = loginFailText('account-disabled', '这个账号已停用');
  const csrf = loginFailText('bad-csrf', 'CSRF 令牌对不上');
  const down = loginFailText('backend-down', '连不上后端');
  assert.equal(cred, '账号或密码不对。');
  for (const [a, b] of [[cred, disabled], [disabled, csrf], [csrf, down], [cred, down]]) {
    assert.notEqual(a, b);
  }
  assert.ok(csrf.includes('刷新'), '令牌失效那条要给出可执行的下一步：' + csrf);
  assert.ok(down.includes('start.sh'), '连不上那条要说去哪儿起服务：' + down);
  assert.ok(disabled.includes('管理员'), '账号停用那条要说找谁：' + disabled);
  // 账号不存在与密码不对**必须是同一句**：分开说等于给了一个问"这账号存不存在"的口子
  assert.equal(loginFailText('bad-credentials', '用户名不存在'), cred);
});

/* ---------------- CSRF 头 ---------------- */

test('CSRF：从 cookie 里取令牌，取不到就不带这个头', () => {
  assert.deepEqual(csrfHeaderOf(CSRF_COOKIE + '=abc123'), { [CSRF_HEADER]: 'abc123' });
  assert.deepEqual(csrfHeaderOf('a=1; ' + CSRF_COOKIE + '=abc123; b=2'), { [CSRF_HEADER]: 'abc123' });
  assert.deepEqual(csrfHeaderOf(CSRF_COOKIE + '=abc='), { [CSRF_HEADER]: 'abc=' }, '值里可能带 `=`，按第一个切');
  assert.deepEqual(csrfHeaderOf('other=1'), {}, '没有令牌就回空对象');
  assert.deepEqual(csrfHeaderOf(CSRF_COOKIE + '='), {}, '空值等于没有令牌（发空串会被判成"对不上"）');
  assert.deepEqual(csrfHeaderOf(''), {});
  assert.deepEqual(csrfHeaderOf(null), {});
  assert.equal(CSRF_COOKIE, 'XSRF-TOKEN');
  assert.equal(CSRF_HEADER, 'X-XSRF-TOKEN', 'Spring Security 默认头名，写错就是每个写操作 403');
});

/* ---------------- 原因码（F12 的后半段） ---------------- */

test('失败原因码：U1 新增的八个都在这张表里，且与后端逐字对得上', () => {
  assert.equal(REASON.UNAUTHORIZED, 'unauthorized');
  assert.equal(REASON.BAD_CREDENTIALS, 'bad-credentials');
  assert.equal(REASON.ACCOUNT_DISABLED, 'account-disabled');
  assert.equal(REASON.BAD_CSRF, 'bad-csrf');
  assert.equal(REASON.SELF_LOCKOUT, 'self-lockout');
  assert.equal(REASON.LAST_ADMIN, 'last-admin');
  assert.equal(REASON.USER_IN_USE, 'user-in-use');
  assert.equal(REASON.BAD_ROLE, 'bad-role');
  // 旧的三条一个都不许被顶掉（改错名字会让既有话术整片失配）
  assert.equal(REASON.FORBIDDEN, 'forbidden');
  assert.equal(REASON.NOT_FOUND, 'not-found');
  assert.equal(REASON.REV_CONFLICT, 'rev-conflict');
});
