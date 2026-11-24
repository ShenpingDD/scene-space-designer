import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SEE_CURRENT_TEXT, switchName, switchText, absoluteLink, daysLeft, leftText, netHint, tail } from '../src/share.js';
import * as shareModule from '../src/share.js';
import { legacyHashRedirect, shareHref, shareTokenOf } from '../src/router.js';

/**
 * share.test.js —— 只读分享的判据与话术
 *
 * 这一层要钉住的四件事，全都是"错了也看不出来"的那一类：
 *
 *   ① 链接格式（`/view/<8 位口令>`）—— 拼错一处不会报错，只会让客户收到一条打不开的链接；
 *   ② 「还有几天」四种情况不能互相冒充（不过期 / 读不出来 / 今天到期 / 已过期）；
 *   ③ 路由只认**恰好** `/view/<一段>` —— 半截地址该落回首页，不是"口令错了"；
 *   ④ 回环/内网地址必须给提示（手机扫了打不开，是现场最容易翻车的地方，设计决策记录 §3.4）。
 */
test('有效期档位**不在这一层**：档位由服务端给（写两份就等着漂）', () => {
  assert.equal(shareModule.DAYS_CHOICES, undefined,
    'share.js 不该再导出 DAYS_CHOICES —— 三档来自服务端 `sharesOf` 的 dayChoices');
});

test('口令后 4 位：够认人、又不泄露完整口令（8 位口令也一样）', () => {
  assert.equal(tail('abcdefgh'), '****efgh');
  assert.equal(tail('abcdefghjkmnpqrstuvwxyz23456789'), '****6789');
  assert.equal(tail('abc'), '****', '太短就不露');
  assert.equal(tail(null), '****');
});

test('完整链接：`origin` + `shareHref`（地址格式只有一个出处），**井号已经去掉**', () => {
  const t = 'abcd2345';
  assert.equal(absoluteLink('http://127.0.0.1:5180', t), `http://127.0.0.1:5180/view/${t}`);
  assert.equal(absoluteLink('http://x:1/', t), `http://x:1/view/${t}`, '尾部斜杠要归一化，不能拼出 //');
  assert.equal(absoluteLink('http://x:1///', t), `http://x:1/view/${t}`, '多个尾斜杠也要归一化');
  // ⭐ U1 起是**真实路径**：微信里点开更短更像一条正规链接，服务端也已按 history 形态配了转发
  assert.doesNotMatch(absoluteLink('http://x', t), /#/, '不许再拼出井号形态');
  assert.equal(absoluteLink('http://x', ''), 'http://x', '没口令就不拼半截地址（不给出 /view/ 这种）');
});

test('shareHref：没口令就回空串（不许拼出一条 /view/ 的空链接）', () => {
  assert.equal(shareHref(''), '');
  assert.equal(shareHref(null), '');
  assert.equal(shareHref('  abc  '), '/view/abc', '去掉首尾空白');
});

test('⭐ 回环 / 内网地址必须给提示（删掉提示 → 这条就红）', () => {
  const loop = netHint('http://127.0.0.1:5180', true);
  assert.equal(loop.kind, 'loopback');
  assert.ok(loop.text.includes('127.0.0.1'), '要说清当前地址是哪个：' + loop.text);
  assert.ok(loop.text.includes('只有这台电脑'), '要说清后果：' + loop.text);
  assert.ok(loop.text.includes('内网地址') || loop.text.includes('IP'), '要给出下一步怎么办：' + loop.text);

  assert.equal(netHint('http://localhost:5180', true).kind, 'loopback');
  assert.equal(netHint('http://[::1]:5180', true).kind, 'loopback');
  assert.equal(netHint('http://10.0.0.10:5180', true).kind, 'lan');
  assert.ok(netHint('http://10.0.0.10:5180', true).text.includes('同一个网络'), '内网地址要说同一网络');
  assert.equal(netHint('https://design.example.com', true).kind, 'public');
  assert.equal(netHint('https://design.example.com', true).text, '', '公网域名不需要提示');
  assert.equal(netHint('http://127.0.0.1:5180', false).kind, 'none',
    '还没有链接时不提示（免得一句话挂在没有链接的面板上）');
});

test('⭐ 「还有几天」四种情况不能互相冒充', () => {
  const now = new Date('2026-09-30T16:00:00').getTime();
  const iso = (days) => new Date(now + days * 86400000).toISOString();
  assert.equal(daysLeft(null, now), null, '不过期 → null（不是 0）');
  assert.equal(leftText(null, now), '不过期', '永久档：写「不过期」，不能留空');
  assert.equal(leftText('这不是时间', now), '到期时间读不出来', '读不出来也要说，不能留空');
  assert.equal(leftText(iso(0), now), '今天到期');
  assert.equal(leftText(iso(30), now), '还有 30 天');
  assert.equal(leftText(iso(-1), now), '已经过期');
  // 0 与 null 必须分开：混了就会把"不过期"说成"今天到期"
  assert.notEqual(leftText(null, now), leftText(iso(0), now));
});

test('⭐ 只读页三句话里必须有"看到的是当前内容"', () => {
  // 开关上的字：开着/关着/待确认**三种**，两两不同，而且「待确认」不许冒充「已打开」
  const on = switchText({ active: true });
  const off = switchText({ active: false });
  const pend = switchText({ active: true, confirming: true });
  assert.notEqual(on, off);
  assert.notEqual(pend, on, '待确认与已打开必须是两句 —— 不然用户以为第一次点击没生效：' + pend);
  assert.ok(on.includes('已打开') && off.includes('已关闭'), '开关要一眼看出当前状态');
  assert.ok(off.includes('打不开'), '关着的后果要说出来（客户打不开）：' + off);
  // 无障碍名：要讲"拨下去会发生什么"，不能只念"开/关"
  const n1 = switchName({ active: false }), n2 = switchName({ active: true }), n3 = switchName({ active: true, confirming: true });
  assert.ok(n1.includes('打开') && n2.includes('关闭'), '读屏要知道拨下去发生什么');
  assert.ok(n3.includes('确认'), '待确认那一步要说清是"再拨一次":' + n3);
  assert.notEqual(n3, n2);
  // 「客户看到的是当前内容」这句是**发链接的人**该知道的（从客户页挪过来）
  assert.ok(SEE_CURRENT_TEXT.includes('当前'), SEE_CURRENT_TEXT);
  assert.ok(!SEE_CURRENT_TEXT.includes('**'), '界面文字里不许漏出 markdown 星号：' + SEE_CURRENT_TEXT);
  for (const s of [on, off, pend, n1, n2, n3]) assert.ok(!s.includes('**'), '不许有星号：' + s);
});

test('路由：分享地址是 `/view/<口令>` 恰好一段；半截地址落回首页', () => {
  // 新形态：真在用的地址
  assert.equal(shareHref('abcd2345'), '/view/abcd2345');
  assert.match(shareHref('abcd2345'), /^\/view\/[^/]+$/);
  // 旧形态：已经发出去的链接由 `legacyHashRedirect` 接管到同一个新地址上
  assert.equal(legacyHashRedirect('#/view/abcd2345'), '/view/abcd2345');
  // ⚠️ 半截地址**不许**被当成"口令错了" —— 它只是不完整，该落回首页（改写责任到此为止）
  assert.equal(legacyHashRedirect('#/view'), null);
  assert.equal(legacyHashRedirect('#/view/a/b'), null);
  assert.equal(legacyHashRedirect('#/view/'), null);
  // ⚠️ 旧形态 `#/s/<...>` 不再认（V13 已把 32 位口令全部撤销，本来也打不开）
  assert.equal(legacyHashRedirect('#/s/abcdefghjkmnpqrstuvwxyz23456789'), null,
    '旧分享形态已下线 —— 认它就会给出一句"口令对不上"，而真话是"这条链接已经作废"');
});

test('分享页与维护端/设计器互不串门', () => {
  assert.equal(legacyHashRedirect('#/admin'), '/admin');
  assert.equal(legacyHashRedirect('#/designer?scheme=2'), '/design/2');
  assert.equal(shareTokenOf('abcd2345'), 'abcd2345', '分享页拿到的口令是原来那一个');
  // 别的页面上的东西不许被当成口令（PresentView 的口令只从路由参数来）
  assert.equal(shareTokenOf(undefined), null);
  assert.equal(shareTokenOf(''), null);
});