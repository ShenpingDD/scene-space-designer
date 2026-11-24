/**
 * router.js —— 地址形态的**唯一出处**（链接怎么拼、旧地址怎么改写）
 *
 * ## 地址形态换成了真实路径
 * 路由表在 `routes.js`（vue-router 的 history 模式）。这个文件**不 import vue-router**：
 * 它只放能单独测的纯函数（判据在 `app/test/router-path.test.js`）。
 * 唯一的例外是 `go()`：跳转这件事转交给 `routes.js` 装配时注册进来的导航函数，
 * 于是七个调用点一行都不用改，而"谁在管地址栏"仍然只有一个答案。
 *
 * ## 链接格式只有一个出处
 * `schemeHref` / `shareHref` 造链接，`schemeIdOf` / `shareTokenOf` 解链接。
 * 四处各写一份格式就是埋一颗"改了这边忘了那边"的隐患，而且两边都不会报错 ——
 * 只是悄悄不生效（点了没反应，最难查的那种）。
 *
 * ## 旧地址（hash 形态）的接管
 * `legacyHashRedirect` 是纯函数，由 `main.js` 在装配前调一次。`#/view/<口令>` 的兼容长期保留：
 * 二维码已经印到客户手里，没有任何渠道把地址收回来。
 */

/** 路由名。与 `routes.js` 的 name 一字不差（判据靠它认页面） */
export const ROUTES = {
  LOGIN: 'login',
  HOME: 'home',
  PROJECT: 'project',
  DESIGN: 'design',
  DESIGN_NEW: 'design-new',
  ADMIN: 'admin',
  SHARE: 'share',
};

/**
 * 分享链接（`/view/<口令>`）—— **格式只在这里定义**。
 * 口令由服务端给（8 位、无歧义字符集，见 `Share.TOKEN_CHARS`），这里只负责把它放进地址。
 *
 * ## 口令合不合法不在这里判
 * 长度与字符集的规矩在服务端（`Share.looksLikeToken`）：前端多判一条，
 * 就会多出"界面说格式不对、服务端其实认得"这种谁也说不清的分歧。
 */
export function shareHref(token) {
  const t = String(token == null ? '' : token).trim();
  return t ? '/view/' + t : '';
}

/** 从路由参数里取分享口令；取不到回 `null`（不判合法性，见 `shareHref`） */
export function shareTokenOf(param) {
  const t = String(param == null ? '' : param).trim();
  return t ? t : null;
}

/**
 * 方案链接（`/design/<id>`）—— 格式只在这里定义。
 *
 * `id` 读不回来（不是正整数）时回**空串**：调用方据此不跳（宁可什么都不做，
 * 也不要跳到一份"看起来像、其实对不上"的方案上）。
 */
export function schemeHref(id) {
  const n = Number(id);
  if (!Number.isFinite(n) || n <= 0) return '';
  return '/design/' + Math.trunc(n);
}

/**
 * 从路由参数里取方案 id；取不到回 `null`。
 *
 * **只认纯数字的正整数**：`abc` / `0` / `-1` / `1.5` / `5a` 一律 null。
 * 这一头连着"打开一份方案并**覆盖编辑器当前状态**"，
 * 宁可回首页，也不要打开一份**看起来像、其实对不上**的方案。
 */
export function schemeIdOf(param) {
  const s = String(param == null ? '' : param).trim();
  if (!s) return null;
  const allDigits = s.split('').every((c) => c >= '0' && c <= '9');
  if (!allDigits) return null;
  const n = Number(s);
  return n > 0 && Number.isFinite(n) ? n : null;
}

/** query 串里取 `scheme`（旧形态 `#/designer?scheme=5` 用）；坏转义当没有这一条 */
function schemeParam(queryPart) {
  for (const pair of String(queryPart || '').split('&')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    if (pair.slice(0, eq) !== 'scheme') continue;
    let v = pair.slice(eq + 1);
    try {
      v = decodeURIComponent(v);
    } catch {
      return null;
    }
    return schemeIdOf(v);
  }
  return null;
}

/**
 * 旧地址（hash 形态）→ 真实路径。**不改写就回 `null`**。
 *
 * 四条规则：
 *   · `#/view/<口令>` 恰好两段 → `/view/<口令>`
 *   · `#/designer?scheme=<正整数>` → `/design/<id>`
 *   · `#/designer`（无参数）→ `/design/new`（无参设计器就是新方案那一档）
 *   · `#/admin` 与 `#/admin/...` → 去掉前导 `#`
 *
 * 半截地址（`#/view`、`#/view/a/b`）不改写，交给兜底规则 ——
 * 与手写路由时代同一条口径：那种地址被当成"口令错了"，人只会以为链接坏了。
 */
export function legacyHashRedirect(hash) {
  const raw = String(hash == null ? '' : hash).trim();
  if (!raw.startsWith('#')) return null;
  const body = raw.slice(1);
  const q = body.indexOf('?');
  const pathPart = q < 0 ? body : body.slice(0, q);
  const queryPart = q < 0 ? '' : body.slice(q + 1);
  const segs = pathPart.split('/').filter((s) => s !== '');

  if (segs[0] === 'view' && segs.length === 2) return '/view/' + segs[1];

  if (segs[0] === 'designer' && segs.length === 1) {
    const id = schemeParam(queryPart);
    return id ? '/design/' + id : '/design/new';
  }

  if (segs[0] === 'admin') {
    const path = '/' + segs.join('/');
    return queryPart ? path + '?' + queryPart : path;
  }

  return null;
}

/** 导航函数（由 `routes.js` 装配时注册）—— 这个文件因此不用认识 vue-router */
let navigator = null;

export function setNavigator(fn) {
  navigator = typeof fn === 'function' ? fn : null;
}

/**
 * 跳转。**只走注册进来的导航函数**：地址栏、历史记录、守卫三件事都归 vue-router 管，
 * 各处自己写 `window.location.hash = …` 就会出现"地址变了但界面没换"这种安静的错误。
 */
export function go(path) {
  let p = String(path == null ? '' : path).trim();
  if (!p.startsWith('/')) p = '/' + p;
  if (!navigator) throw new Error('go() 还没接上路由（routes.js 要在装配时调用 setNavigator）');
  navigator(p);
}

/** 当前地址（含 query），会话失效时当回跳参数用 */
export function currentPath() {
  return window.location.pathname + window.location.search;
}
