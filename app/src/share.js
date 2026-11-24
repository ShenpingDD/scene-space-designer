/**
 * share.js —— 只读分享的**话术与纯计算**（纯函数，可单测）
 *
 * ## 这里不判断"这条链接还能不能用"
 *
 * 能不能用**由服务端说了算**（它才知道口令在不在、撤销了没、过期了没 —— 见 `ShareService`）。
 * 界面照抄服务端发下来的 `ok / state / stateText`，自己不重新算一遍：
 * 两处各算一份，就等着"服务端说能用、界面说不能用"这类谁也说不清的分歧。
 *
 * 那这里算什么？算**服务端算不了的那一件**：「还有几天」。
 * 服务端算出来的那一刻就已经旧了（页面开着不刷新它就永远不动），而"现在"是浏览器才知道的事。
 *
 * ## 链接格式只有一个出处
 *
 * `/view/<口令>` 这种地址写在 `router.js` 的 `shareHref` 里（与方案深链同一条纪律）——
 * 不许各处自己拼。拼错一处不会报错，只会让客户收到一条打不开的链接。
 * （服务端有一份副本 `Share.linkPath`，由 `ShareLinkFormatDriftTest` 盯着，不许漂。）
 *
 * ## 有效期三档**不在这里**
 *
 * 7 / 30 / 不过期 是**服务端**给的（`Share.DAY_CHOICES` → `sharesOf` 的 `dayChoices`）。
 * 这边曾经写死过一份 `[7, 30, 90]` —— 档位一改（90 换成「不过期」）两边就对不上，
 * 而且**两边都不报错**。所以这份拷贝删掉了，界面照服务端给的那三档渲染。
 */
import { shareHref } from './router.js';

/** 口令后 4 位（认人/对账用；日志里留的也是这个形状 —— 完整口令不进日志） */
export function tail(token) {
  const t = String(token == null ? '' : token);
  return t.length < 4 ? '****' : '****' + t.slice(-4);
}

/**
 * 拼完整链接给客户。
 *
 * `origin` 用 `location.origin`（浏览器自己知道）；服务端**不知道**对外是什么域名
 * （内网/域名/端口都可能不一样），所以它只给相对路径 —— 拼完整地址是浏览器的事。
 */
export function absoluteLink(origin, token) {
  const base = String(origin == null ? '' : origin).replace(/\/+$/, '');
  return base + shareHref(token);
}

/**
 * 这个地址能不能被**别的设备**打开。回环地址只有本机能开（设计决策记录 §3.4）。
 *
 * 返回 `{kind, text}`：`kind` 给判据/探针认，`text` 是要摆到界面上的那句话。
 * 为什么不写在模板里：这是一条需要被**变异验证**的规则（删掉提示 → 判据必须红），
 * 放在纯函数里才能单测（`app/test/share.test.js`）。
 */
export function netHint(origin, hasLink) {
  if (!hasLink) return { kind: 'none', text: '' };
  const o = String(origin == null ? '' : origin);
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(o)) {
    return {
      kind: 'loopback',
      text: `当前地址是 ${o} —— 只有这台电脑能打开。要让手机扫，请用这台电脑的内网地址（IP）打开本页，再生成一次链接。`,
    };
  }
  if (/^https?:\/\/(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(o)) {
    return { kind: 'lan', text: '这是内网地址：手机需要和这台电脑在同一个网络才能打开。' };
  }
  return { kind: 'public', text: '' };
}

/**
 * 还有几天。返回 `null` = 算不出来（不过期 / 时间读不出来）—— **不返回 0 冒充"今天到期"**。
 * 0 留给"今天到期"，两者混了会把一条不过期的链接说成今天过期。
 */
export function daysLeft(expiresAt, nowMs) {
  if (expiresAt == null || expiresAt === '') return null;
  const t = new Date(expiresAt).getTime();
  if (!Number.isFinite(t)) return null;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  return Math.ceil((t - now) / 86400000);
}

/** 有效期的人话。四种情况四句话（"读不出来"也要说，不能留空） */
export function leftText(expiresAt, nowMs) {
  if (expiresAt == null || expiresAt === '') return '不过期';
  const d = daysLeft(expiresAt, nowMs);
  if (d === null) return '到期时间读不出来';
  if (d < 0) return '已经过期';
  if (d === 0) return '今天到期';
  return `还有 ${d} 天`;
}

/**
 * 分享开关那两句话（2026-10-08 用户拍板：开关样式，不是两个按钮）。
 *
 * 三条规矩：
 *   · 开关上的字必须跟它自己的位置一致（开着说"客户现在能看"，关着说"客户打不开"）——
 *     状态词写反了不报错，客户只是打不开，而发链接的人以为开着；
 *   · 「待确认」是**第三种**状态（不是开也不是关），它有自己的一句话 ——
 *     不这样写，用户看到的还是"已打开"，会以为第一次点击没生效；
 *   · 「关掉再打开 = 换新口令」这件事落在确认那句话里（它只在这一刻需要被知道）。
 *
 * ⚠️ 这些字是**纯文本**，会被直接摆进 HTML —— 里面**不许出现 markdown 星号**
 * （以前写过 `这里看到的是**当前**内容`，页面上就真的显示两个星号，真机探针拓出来的）。
 * 要强调就用【】。
 *
 * @param {{active?:boolean, confirming?:boolean}} s
 */
export function switchText(s = {}) {
  const on = !!s.active;
  if (on) return s.confirming ? '已打开（等确认）' : '已打开 · 客户现在能看';
  return '已关闭 · 客户打不开';
}

/** 开关的无障碍名：读屏要知道"拨下去会发生什么"，不能只念"开/关" */
export function switchName(s = {}) {
  const on = !!s.active;
  if (on) return s.confirming ? '再拨一次：确认关闭分享（旧链接永久失效）' : '分享已打开，拨一下关闭（要先确认）';
  return '分享已关闭，拨一下打开（生成一条只读链接）';
}

/**
 * 「客户看到的永远是当前内容」——这句话从**客户那一页**挪到了**发链接的人这一边**
 * （2026-10-08 用户要求删掉客户页上那段只读说明）。
 *
 * 为什么不能连它一起删：它是**行为契约**里最容易误会的一条 —— 会有人以为"链接是快照"，
 * 于是拿一条旧链接去给客户看新版内容，或者以为改了方案客户看不见。
 * 发链接的人该知道；客户不必每次看一遍。
 */
export const SEE_CURRENT_TEXT = '客户看到的永远是【当前】内容 —— 以后再改方案，这条链接看到的也跟着变。';