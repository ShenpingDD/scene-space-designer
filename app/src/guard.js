/**
 * guard.js —— 谁能进哪一页（纯函数，判据在 `app/test/auth-guard.test.js`）
 *
 * ## 为什么把判断从组件里拿出来
 * "没登录就跳登录页、并把原来要去的地方带上"这件事有两个触发点（导航时、请求回 401 时），
 * 却只有一个正确答案。写成纯函数之后：界面只负责摆字，判断能被单测逐条摆出来。
 *
 * ## 回跳地址是**攻击面**
 * 登录页会带着 `?redirect=` 跳走 —— 不校验的话，别人给你一条
 * `/login?redirect=https://evil.com` 的链接，你输完口令就被送到站外。
 * 所以 `safeRedirect` 只收**站内相对路径**，`//evil.com` 这类协议相对地址也一律不收。
 */
import { schemeIdOf } from './router.js';

export const LOGIN_PATH = '/login';
export const HOME_PATH = '/index';

/** 已经在登录页（含带 query 的形态）—— 会话失效时用它避免反复跳自己 */
export function isLoginPath(p) {
  const s = String(p == null ? '' : p);
  return s === LOGIN_PATH || s.startsWith(LOGIN_PATH + '?') || s.startsWith(LOGIN_PATH + '/');
}

/**
 * 回跳地址的站内校验。收下就原样返回，收不下就回首页。
 *
 * 收不下的：不以 `/` 开头的（`https://evil.com`、`javascript:alert(1)`）、
 * `//evil.com` 这种协议相对地址、带反斜杠的（浏览器把 `\` 当 `/`，`/\evil.com` 一样能跳出去）、
 * 带控制字符的、空值、以及登录页自己（跳回去就是打转）。
 */
export function safeRedirect(raw) {
  const p = String(raw == null ? '' : raw).trim();
  if (!p.startsWith('/')) return HOME_PATH;
  if (p.startsWith('//') || p.startsWith('/\\')) return HOME_PATH;
  if (isLoginPath(p)) return HOME_PATH;
  if (/[\\\u0000-\u001f\u007f]/.test(p)) return HOME_PATH;
  return p;
}

/** 登录页地址。**参数名与转义只在这里定义**（`redirect` 的值里可能带 `&`、`?`） */
export function loginHref(target) {
  return LOGIN_PATH + '?redirect=' + encodeURIComponent(safeRedirect(target));
}

/**
 * 登录失败时那句话。**分因给话** —— 四种原因的下一步动作完全不同：
 * 「密码不对」重输、「账号停用」找管理员、「令牌失效」刷新页面、「连不上」去起服务。
 * 混成一句「登录失败」，用户只能乱试。
 *
 * ⚠️ 账号不存在与密码不对**刻意合成一句**（服务端也只回 `bad-credentials`）：
 *    分开说等于给了一个不需要密码就能问出"这个账号存不存在"的口子。
 */
export function loginFailText(reason, message) {
  const r = String(reason == null ? '' : reason);
  if (r === 'bad-credentials') return '账号或密码不对。';
  if (r === 'account-disabled') return '这个账号已停用，请联系管理员。';
  if (r === 'bad-csrf') return '安全令牌失效了 —— 刷新页面（F5）之后重试。';
  if (r === 'backend-down') return '连不上后端 —— 确认服务已启动（项目根目录执行 bash start.sh）。';
  if (r === 'invalid-request') return '账号或密码的格式不对：' + String(message == null ? '' : message);
  const tail = (r ? r + '：' : '') + String(message == null ? '' : message);
  return tail || '登录没成功，原因未知。';
}

/**
 * 一次导航该不该放行。
 *
 * @param {{path?:string, fullPath?:string, params?:object, meta?:object}} to 目标路由
 * @param {boolean} authed 会话有效？
 * @returns {{action:'allow'}|{action:'redirect', to:string}}
 *
 * 规则四条（**顺序即优先级**）：
 *   ① 已登录还去登录页 → 回首页（不让人停在登录页上打转）；
 *   ② 公开页（`meta.public`：登录页、只读分享页）放行 —— 客户手里的分享链接还要求先登录，
 *      他就只会看到一堵墙，而这条链接本来就是要给没有账号的人看的；
 *   ③ `/design/<id>` 的 id 不是正整数 → 回首页（与"认不出来的一律安静回首页"同一条口径）；
 *   ④ 未登录 → 去登录页，并把**原来要去的地方**带上（登录后原路回去）。
 *
 * ⚠️ ① 必须排在 ② 前面：登录页自己带 `meta.public`，先判放行的话，
 *    已登录的人停在登录页上，那条规则永远走不到（这一条是单测抓出来的）。
 */
export function routeDecision(to, authed) {
  const t = to || {};
  const meta = t.meta || {};
  const path = String(t.path || '');
  if (authed && isLoginPath(path)) return { action: 'redirect', to: HOME_PATH };
  if (meta.public) return { action: 'allow' };
  if (!authed) return { action: 'redirect', to: loginHref(t.fullPath || path) };
  if (meta.designDetail && schemeIdOf(t.params && t.params.id) === null) {
    return { action: 'redirect', to: HOME_PATH };
  }
  return { action: 'allow' };
}
