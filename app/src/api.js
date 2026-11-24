/**
 * api.js —— 与后端说话的唯一入口
 *
 * 为什么只有这一个文件碰 `fetch`：
 *   界面里零业务判断是这项目的铁律，同理 —— 界面里也**只应该有一处**知道 HTTP 长什么样。
 *   将来换鉴权、加请求头、加重试，都只改这里。
 *
 * 为什么路径写成 `/api`：
 *   Vite 开发服务器把 `/api` 代理到 `127.0.0.1:8080`（见 vite.config.js），
 *   所以**没有跨域、没有 CORS 配置、也不需要把后端地址写在前端**。
 *   将来前端打包成静态文件交给后端托管时，同一份代码照样能用。
 *   请求时把当前文档的来源拼在前面（`apiBase()`）：同来源，与相对路径是同一个请求。
 *
 * 错误口径：后端失败一律是 `{ok:false, reason, message}`（见 docs/20）。
 *   这里把 HTTP 错误**翻译成带 `reason` 的异常**抛出去，界面只认 `reason`，不解析 HTTP 状态码。
 *
 * CSRF：Spring Security 的双提交令牌（cookie `XSRF-TOKEN` + 请求头 `X-XSRF-TOKEN`）。
 *   两处 fetch 封装统一带上，写方法与读方法都带 —— 分支越少越不容易漏。
 *   写请求之前若 cookie 里没有令牌，先走一趟 `GET /api/auth/me` 把令牌要回来（见 `primeCsrf`）。
 *
 * 会话失效（401）：**只有这里处置**。忘了本机缓存的会话，再把当前地址当回跳参数带去登录页。
 *   这一族坑在本仓出现过多次（同一个判断写两处，改漏一侧不报错），所以判据会盯"只有一处"。
 */
import { currentPath } from './router.js';
import { isLoginPath, loginHref } from './guard.js';

const BASE = '/api';

/** 「我是谁」那一个地址。登录页与取令牌都走它：它在放行清单里，不需要令牌 */
const AUTH_ME = '/auth/me';

/**
 * 请求前缀。
 *
 * 浏览器里相对路径 `/api` 会按当前文档的地址解析（Vite 开发服务器再代理到 8080）。
 * Node 里的 `fetch` 不认相对路径，所以带上当前文档的来源 —— 同来源的绝对地址
 * 在浏览器里与相对路径是同一个请求，代理与 cookie 的行为都不变。
 */
function apiBase() {
  const origin = typeof window !== 'undefined' && window.location ? String(window.location.origin || '') : '';
  // `file://` 下 origin 是字符串 `null`，那时仍走相对路径（由浏览器自己解析）
  return /^https?:/.test(origin) ? origin + BASE : BASE;
}

/** 把对象拼成查询串（**跳过空值**：空串/undefined/null 都不发，理由见 paramsRevisions） */
function query(q) {
  if (!q) return '';
  const parts = [];
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
  }
  return parts.length ? '?' + parts.join('&') : '';
}

/** 后端约定的失败原因（与 docs/20 一一对应，界面据此给不同话术） */
export const REASON = {
  REV_CONFLICT: 'rev-conflict',
  REV_REQUIRED: 'rev-required',
  NOT_FOUND: 'not-found',
  INVALID_REQUEST: 'invalid-request',
  BAD_TIME: 'bad-time',            // 审计查询的时间读不懂（B4c）
  // 下两个是 B4e 起才分出来的（之前 4xx 一律 invalid-request）——
  // 「你的角色不能做这件事」与「和现有数据撞了」的下一步动作完全不同，必须能分辨
  FORBIDDEN: 'forbidden',          // 403：角色门挡下的（AdminGate）
  CONFLICT: 'conflict',            // 409：撞了（如变体重名）
  // U1（docs/80 §三第8项）分出来的四个。下一步动作各不相同，混成一句等于没说：
  UNAUTHORIZED: 'unauthorized',          // 401：没登录 / 会话过期 → 去登录页，登录后回原路
  BAD_CREDENTIALS: 'bad-credentials',    // 401：账号不存在或密码不对（**刻意不分开说**）
  ACCOUNT_DISABLED: 'account-disabled',  // 403：账号已停用 → 找管理员
  BAD_CSRF: 'bad-csrf',                  // 403：令牌没带上/对不上 → 刷新页面重试
  // 用户管理的三条：自保与占用（docs/80 §五第3、4项）
  SELF_LOCKOUT: 'self-lockout',
  LAST_ADMIN: 'last-admin',
  USER_IN_USE: 'user-in-use',
  BAD_ROLE: 'bad-role',
  // 前端自己加的一个查询参数值：会话过期被请回登录页时带上它，
  // 登录页据此说「会话已过期，请重新登录」—— 与"从没登录过"分开说
  EXPIRED: 'expired',
};

/** CSRF 的 cookie 名与请求头名（Spring Security 的默认值，只有这一处） */
export const CSRF_COOKIE = 'XSRF-TOKEN';
export const CSRF_HEADER = 'X-XSRF-TOKEN';

/**
 * 从 `document.cookie` 里取 CSRF 令牌 → 一个请求头对象。
 *
 * 取不到就回**空对象**（不构造空值头：空串发上去会被判成"令牌对不上"，
 * 而真正的原因是"还没有令牌"）。值里可能带 `=`（base64 补位），所以按**第一个** `=` 切。
 */
export function csrfHeaderOf(cookieString) {
  for (const pair of String(cookieString == null ? '' : cookieString).split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    if (pair.slice(0, eq).trim() !== CSRF_COOKIE) continue;
    const v = pair.slice(eq + 1).trim();
    return v ? { [CSRF_HEADER]: v } : {};
  }
  return {};
}

/** 写请求（`GET` / `HEAD` 之外）才需要令牌 —— 读请求带不带都不影响服务端判定 */
export function isWriteMethod(method) {
  return !/^(GET|HEAD)$/i.test(String(method || ''));
}

/**
 * 写请求发出去之前，手里必须有 CSRF 令牌。
 *
 * 退出登录那一趟会把 `XSRF-TOKEN` 与 `SPATIAL_SESSION` 一起注销掉（服务端在 logout 的响应里
 * 就把令牌作废了），而登录页是**同一篇文档里的客户端跳转**、挂载时不发任何请求 ——
 * 这时点「登录」，这一次 POST 手里一个令牌都没有，服务端按跨站请求挡下（403 `bad-csrf`），
 * 人非得手动刷新一次页面才恢复。
 *
 * 所以写请求之前先看 cookie：没有就先走一趟放行清单里的 `GET /api/auth/me`（它不要令牌，
 * 服务端的 `CsrfCookieFilter` 在这一趟里把新令牌种下来），拿到之后再发正式请求。
 * 要了一趟还是没有令牌就**就地抛出**：硬发一次注定被挡的请求，只会把失败原因藏起来。
 */
async function primeCsrf() {
  if (csrfHeaderOf(document.cookie)[CSRF_HEADER]) return;
  const res = await fetch(apiBase() + AUTH_ME, { method: 'GET', headers: { Accept: 'application/json' } });
  await res.text();   // 这一趟只为把令牌要回来；响应体仍要读掉，连接才还得回去
  if (!csrfHeaderOf(document.cookie)[CSRF_HEADER]) {
    const err = new Error('本机没有跨站请求令牌，去问了一趟也没拿到');
    err.reason = REASON.BAD_CSRF;
    throw err;
  }
}

let onSessionLost = null;

/**
 * 401 的一次性跳转闩（理由见 `handleUnauthorized`）。
 * 会话一没会同时打穿好几趟在飞的请求，而**「刚才是不是已经登录过」只有第一趟说得准**；
 * 记下「这一趟会话已经处置过了」，晚到的 401 就不再改地址。
 */
let unauthorizedHandled = false;

/** 谁想知道"会话没了"（装配时由 `session.js` 注册一次）。返回值说明"刚才是不是已经登录过" */
export function setSessionLostHandler(fn) {
  onSessionLost = typeof fn === 'function' ? fn : null;
  // 重新注册 = 换了一轮装配（单测每个用例都会重设一次 handler，见 api-csrf.test.js）：
  // 闩必须跟着复位，否则上一轮留下的「已处置」会把这一轮的第一次 401 吞掉 ——
  // 表现是「该跳却没跳」，不报错，最难查。生产里装配只有一次，复位不改变那条路的语义。
  unauthorizedHandled = false;
}

/**
 * 会话失效的处置：忘掉本机缓存的会话 + 带着当前地址去登录页。
 * 已经在登录页就不再跳 —— 登录页自己的请求一失败就会变成反复刷新。
 *
 * 处置方（`session.js`）会说明"刚才是不是已经登录过"：登录过的人是被**请出去的**，
 * 登录页要说「会话已过期，请重新登录」；从没登录过的人不该看到这句话（他会以为是自己掉的线）。
 *
 * ## 只处置这一趟会话的第一次 401
 * 会话一没，同时在飞的请求会**一起**回 401（首页那趟 `GET /api/schemes` 与随后的
 * `POST /api/audit` 就是这么一对）。第一趟跳的是 `/login?redirect=…&reason=expired`；
 * 等第二趟回来，处置方已经把会话清掉了、这次回 false，于是会跳一个**不带 reason** 的地址。
 * 而 `window.location.assign` 在页面 unload 之前不会改 `pathname`，`isLoginPath()` 挡不住它 ——
 * 第二次 assign 就这样把第一次的地址覆盖掉：人明明是被请出去的，登录页却说他"从没登录过"。
 *
 * 所以：`onSessionLost` 照旧每趟都调（它幂等，清缓存多调一次无害），但**跳转只发一次**；
 * 第一趟的 reason 因此保住，晚到的 401 不再改地址。
 */
function handleUnauthorized() {
  const known = !!(onSessionLost && onSessionLost() === true);
  if (unauthorizedHandled) return;   // 这一趟已经处置过：晚到的 401 不许覆盖第一次的地址
  if (isLoginPath(currentPath())) return;
  unauthorizedHandled = true;
  window.location.assign(loginHref(currentPath()) + (known ? '&reason=' + REASON.EXPIRED : ''));
}

async function call(method, path, body) {
  let res;
  try {
    // FormData 必须原样交给浏览器：它要自己带 multipart 边界，还要自己设 Content-Type。
    // 这里若照 JSON 那条路走，FormData 会被 JSON.stringify 成 {}，而且类型头也错。
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    if (isWriteMethod(method)) await primeCsrf();
    const headers = csrfHeaderOf(document.cookie);
    if (body !== undefined && !isForm) headers['Content-Type'] = 'application/json';
    res = await fetch(apiBase() + path, {
      method,
      headers,
      body: body === undefined ? undefined : (isForm ? body : JSON.stringify(body)),
    });
  } catch (e) {
    // 取令牌那一步抛的（要了一趟还是没有令牌）原样上抛：它不是"连不上后端"
    if (e && e.reason) throw e;
    // fetch 本身失败 = 网络层就没通（后端没起、端口不对）
    const err = new Error('连不上后端');
    err.reason = 'backend-down';
    throw err;
  }

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null; // 非 JSON（例如代理返回的错误页）→ 下面按状态码兜底
  }

  if (!res.ok) {
    const err = new Error((data && data.message) || `后端返回 HTTP ${res.status}`);
    err.status = res.status;
    err.reason = (data && data.reason) || (res.status >= 500 ? 'backend-down' : 'unknown');
    err.data = data;
    if (res.status === 401) handleUnauthorized();
    throw err;
  }
  return data;
}

/**
 * 要**二进制**的那一条路（交付包是 zip，不是 JSON）。
 *
 * 失败时后端回的仍然是 JSON（`{ok:false,reason,message}`）—— 所以这里把它读出来、
 * 照样抛一个带 `reason` 的异常：于是"下载失败"与"接口失败"在界面上是同一种东西、同一套话术。
 * （不然会出现一种最难查的失败：用户看到"下载了一个文件"，打开却是错误页。）
 */
async function callBlob(method, path, body) {
  let res;
  try {
    if (isWriteMethod(method)) await primeCsrf();
    res = await fetch(apiBase() + path, {
      method,
      headers: { ...csrfHeaderOf(document.cookie), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    if (e && e.reason) throw e;
    const err = new Error('连不上后端');
    err.reason = 'backend-down';
    throw err;
  }
  if (!res.ok) {
    let data = null;
    try {
      const text = await res.text();
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    const err = new Error((data && data.message) || `后端返回 HTTP ${res.status}`);
    err.status = res.status;
    err.reason = (data && data.reason) || (res.status >= 500 ? 'backend-down' : 'unknown');
    err.data = data;
    if (res.status === 401) handleUnauthorized();
    throw err;
  }
  const blob = await res.blob();
  return { blob, fileName: fileNameOf(res.headers.get('Content-Disposition')) };
}

/**
 * 从 `Content-Disposition` 取包文件名。
 *
 * **优先 RFC 5987 的 `filename*=`**：方案名是中文，服务端两份都给（一份 ASCII 兽名 + 一份 UTF-8 编码的真名），
 * 这里先解后者 —— 取错的表现是"下载下来的包叫 delivery.zip"，大家就分不清哪个包是哪个了。
 */
export function fileNameOf(disposition) {
  const cd = String(disposition || '');
  const lower = cd.toLowerCase();
  // ① RFC 5987 的 `filename*=UTF-8''<百分号编码>` —— 中文名靠它
  const starAt = lower.indexOf('filename*=');
  if (starAt >= 0) {
    const value = cd.slice(starAt + 10).split(';')[0].trim().replace(/^utf-8''/i, '');
    try {
      return decodeURIComponent(value);
    } catch {
      /* 解不开就走到下面那个 ASCII 名（宁可名字难看，也不要抛在这里把整次下载变成失败） */
    }
  }
  // ② 老式 `filename=...`（带不带引号都收）：只当兼容用
  const plainAt = lower.indexOf('filename=');
  if (plainAt < 0) return '';
  let v = cd.slice(plainAt + 9).split(';')[0].trim();
  const Q = String.fromCharCode(34);   // 双引号（写成字面量会让 check-quotes 认为这一行的引号不成对）
  if (v.startsWith(Q)) v = v.slice(1);
  if (v.endsWith(Q)) v = v.slice(0, -1);
  return v.trim();
}

export const api = {
  /**
   * **我自己的**方案列表（不含 state：列表页不需要几 MB 的 JSON）。
   *
   * 归属过滤由**服务端**做（docs/80 §四第5项）：界面不自己按 owner 筛 ——
   * 自己筛会把"看不见别人的方案"变成"筛掉了"，那是两件完全不同的事。
   * `{deleted:true}` 要的是**回收站**（只含已软删的）；不传就是平时的方案库。
   */
  mySchemes: (opts) => call('GET', '/schemes' + (opts && opts.deleted ? '?deleted=true' : ''))
    .then((r) => r.schemes ?? []),
  /**
   * 维护端的方案库：**全部账号的**方案（`GET /api/admin/schemes`，门 `canMaintain`）。
   * 卡片里多带归属人（`ownerId` / `ownerName`）—— 维护端要能回答"这是谁的"。
   */
  adminSchemes: (opts) => call('GET', '/admin/schemes' + (opts && opts.deleted ? '?deleted=true' : ''))
    .then((r) => r.schemes ?? []),
  getScheme: (id) => call('GET', `/schemes/${id}`),
  createScheme: (name, state) => call('POST', '/schemes', { name, state }),
  /** `rev` 是乐观锁：传前端手里的版本，服务端对不上会回 409 + currentRev */
  saveScheme: (id, rev, name, state, note) => call('PUT', `/schemes/${id}`, { rev, name, state, note }),
  /**
   * 只改方案名（第二轮 验收 · V9）：`PATCH /schemes/{id}/name`，body 只有 `{name}`。
   *
   * 与 `saveScheme` 是两件事：这一趟**不动布局、不增 rev、不写版本记录** ——
   * 改个名字不该让「第 N 版」+1，也不该在版本历史里多出一条"和上一版一模一样"的记录。
   * 回执 `{id, name, rev}`（rev 是服务端确认的当前版本，正常应与手里的一致）。
   */
  renameScheme: (id, name) => call('PATCH', `/schemes/${id}/name`, { name }),
  deleteScheme: (id) => call('DELETE', `/schemes/${id}`),
  /**
   * 版本历史。R6-3 3e 起每行带**版本摘要**（尺寸 / 台数 / 型号）与 `isCurrent` ——
   * 回滚是用户必须做的**一个选择**，而「第 3 版 / 第 4 版」两行在他眼里长得一模一样。
   */
  revisions: (id) => call('GET', `/schemes/${id}/revisions`).then((r) => r.revisions ?? []),

  /* ---------------- 维护端的三个写动作（R6-3 3e）---------------- */

  /** 从回收站恢复。**不动 rev**（它不是一次内容编辑） */
  restoreScheme: (id) => call('POST', `/schemes/${id}/restore`),

  /**
   * 交一张封面（R6-3 3f）。`dataUrl` 是 `canvas.toDataURL('image/png')` 的整串输出。
   *
   * 单独一个请求、且**不带 rev**：封面不是内容编辑（不产生新版本），
   * 所以它不该因为"别人刚保存了第 4 版"而被 409 挡住 —— 图是已经截好的，重截要重新摆机位。
   */
  saveSchemeCover: (id, dataUrl) => call('POST', `/schemes/${id}/cover`, { dataUrl }),
  /**
   * 复制一份。**总是带一个 JSON 体**（`{name}`）—— 后端那条路径要求有对象，
   * 免得「有没有带 body」变成一条隐式分支。不传名字就由服务端按「<源名> 副本」生成。
   */
  duplicateScheme: (id, name) =>
    call('POST', `/schemes/${id}/duplicate`, { name: name == null ? null : name }),
  /**
   * 回滚到历史里的某一版。
   *
   * ⚠️ **两个版本号都要传，而且名字必须写全**：
   *   · `targetRev` 要回到哪一版
   *   · `expectRev` 手里是哪一版（乐观锁，对不上后端回 409 `rev-conflict`）
   * 只传一个的话，调用方与读代码的人都会把它当成另一个 —— 而搞混一次就是覆盖别人的改动。
   */
  rollbackScheme: (id, targetRev, expectRev) =>
    call('POST', `/schemes/${id}/rollback`, { targetRev, expectRev }),
  /** 型号目录：**服务端是唯一来源**，拿不到就退回本地资产（见 src/catalog.js） */
  catalog: () => call('GET', '/catalog'),
  /**
   * 目录卡的 3D 详情（产品知识看板）：只读已发布快照，正文/热点不塞进目录。
   * `permitAll`；老产品无 product_content 行时返回 legacy-projection，不得当 404。
   */
  catalogDetail: (catalogId) => call('GET', `/catalog/${encodeURIComponent(catalogId)}/detail`),
  /**
   * 规则参数（R6-4 B4a）。**读不设门** —— 前台设计器也要这份值，
   * 不然"后台能配"只是看着能配（docs/32 §4.2 的生效链路）。
   */
  params: () => call('GET', '/params'),
  /** 发布一份参数补丁（要维护端角色；校验不过会带 `errors` 全量问题回来） */
  publishParams: (patch, note) => call('PUT', '/params', { patch, note }),
  /**
   * **只问版本，不问内容**（前台自动跟新的轮询口，几十字节）。
   * 前台每 5 秒要问一次「后台改了吗」；整份 `/api/params` 带着 64 项规格（约 43 KB，W4 后实测），
   * 为了看一个数字反复拉它，是白花的流量与解析。
   */
  paramsRev: () => call('GET', '/params/rev'),
  /**
   * 我能不能改参数（维护端参数页用）。**只转发后端那一次判断** ——
   * 界面不自己比对角色码，否则「界面以为能改、后端拒了」（或反过来）都会出现。
   */
  paramsWhoami: () => call('GET', '/params/whoami'),

  /**
   * 参数留痕 / 审计（R6-4 B4c）。
   *
   * ⚠️ **只发有值的条件**（空串不发）：后端把"这个字段没给"当"这一条不筛"，
   * 而把空串当"筛一个叫空的项"就会一条都查不到 —— 两种写法在界面上分不出来。
   * 时间读不懂时后端回 400（`bad-time`），界面把**原话**显示出来（不静默）。
   */
  paramsRevisions: (q) => call('GET', '/params/revisions' + query(q)),
  paramsRevision: (id) => call('GET', '/params/revisions/' + encodeURIComponent(id)),

  // （曾有两段注释挂在这里，描述「按参数版本取值」与「按现参数复核已存方案」两个调用点。
  //   那两个前端调用点在 2026-10-07 随维护端卡片整块删掉了，注释却留了下来 —— 结果两段
  //   注释压在 `health` 头上。服务端那两个口**还在**（`/params/snapshot/{rev}` 等，见
  //   `ParamsController`，保留的理由写在那里）；前端要再用时，照着那边的口径重加。）
  health: () => call('GET', '/health'),
  /** 后端内核自检：用例表是否与服务端**同结论**（"服务端是唯一裁判"的运营抓手） */
  kernelHealth: () => call('GET', '/health/kernel'),
  /**
   * 服务端体检（R4-3）：把当前布局递给裁判。
   * `cached` / `costMs` 一起回来 —— 缓存有没有在干活，看响应就知道（"怕安静"用在缓存上）。
   */
  audit: (state) => call('POST', '/audit', { state }),
  /** 体检缓存的账本（命中率 / 算过几次 / 上次算多久） */
  auditStats: () => call('GET', '/audit/stats'),

  /* ---------------- 维护端（R6-1）---------------- */

  /**
   * 维护端身份。**这是唯一不过角色门的维护端接口**，故意的：
   * 前端的权限门要靠它决定"让不让进"。连"我是谁"都问不到，界面就只能猜 ——
   * 猜出来的权限迟早是错的。它回的内容本身就是答案（isAdmin=false）。
   */
  adminMe: () => call('GET', '/admin/me'),

  /* ---------------- 登录与会话（U1，docs/80 §三）---------------- */

  /**
   * 现在是谁。**登录页也会调它**：外壳要先知道"要不要显示登录页"。
   * 未登录回 `{ok:true, authenticated:false}`（不是 401）—— 所以它不会触发 401 那条处置。
   * 这一趟同时把 CSRF 令牌发下来（服务端在会话里种 cookie）。
   */
  authMe: () => call('GET', AUTH_ME),
  /**
   * 登录。成功回 `{ok:true, user:{id,username,displayName,roleCode}}`。
   * ⚠️ 能力表**不在**这个响应里：界面仍然只从 `/api/admin/me` 读那一张（同一个事实不留两处）。
   *
   * 成功之后要把 401 的跳转闩（`unauthorizedHandled`）复位：登录页是**同一篇文档里的客户端跳转**，
   * 页面不会重新加载；闩不清的话，这个人过一阵再过期就不会被请回登录页（不报错，只是不跳）。
   * 复位只放在「新会话建立」（这里）与「重新装配」（`setSessionLostHandler`）两处；
   * 不能按「任意请求成功」复位：会话刚没时别的请求成功一次（参数轮询就是），下一次 401
   * 又会用不带 reason 的地址覆盖第一次，缺陷原样回来。
   */
  login: (username, password) => call('POST', '/auth/login', { username, password })
    .then((r) => { unauthorizedHandled = false; return r; }),
  logout: () => call('POST', '/auth/logout'),

  /* ---------------- 用户管理（U1，docs/80 §五）---------------- */

  /** 用户列表。读的门是 `canMaintain`；写动作（下面五个）的门是 `manageUsers`（只有 admin） */
  adminUsers: () => call('GET', '/admin/users').then((r) => r.users ?? []),
  /** 建号。用户名撞了回 409 `conflict`，字段不合格回 400 `invalid-request` */
  adminCreateUser: (body) => call('POST', '/admin/users', body),
  /** 改显示名 / 角色 / 启用状态（字段可选，至少给一项） */
  adminPatchUser: (id, body) => call('PATCH', `/admin/users/${id}`, body),
  /** 重置口令（长度 ≥ 8）。这一件事会进审计日志 */
  adminResetPassword: (id, password) => call('POST', `/admin/users/${id}/password`, { password }),
  /** 物理删除。名下有方案/分享/参数改动时回 409 `user-in-use`，`extra` 里带三个计数 */
  adminDeleteUser: (id) => call('DELETE', `/admin/users/${id}`),

  /* ---------------- 只读分享（R6-5）---------------- */

  /** 生成一条免登录只读链接（`days` 缺省 = 30 天；**不给「不过期」选项**） */
  createShare: (id, days) => call('POST', `/schemes/${id}/share`, { days }),
  /** 这份方案的全部口令（含已过期/已撤销）—— **要写方案的门**：里面带着完整口令，它是凭据 */
  sharesOf: (id) => call('GET', `/schemes/${id}/shares`),
  /** 撤销。`note` 选填，写了进审计日志 */
  revokeShare: (id, shareId, note) => call('POST', `/schemes/${id}/share/${shareId}/revoke`, { note }),
  /**
   * 凭口令读方案 —— **全项目唯一不带角色门的接口**（打开它的人还没有身份，
   * 身份就是他手里那条链接）。服务端回的内容里**没有方案 id**：口令持有人能看内容，
   * 但不该顺手拿到调别的接口要用的 id。
   */
  shareRead: (token) => call('GET', `/share/${encodeURIComponent(token)}`),

  /**
   * 交付包（R6-5 · A10/A11/A13）。**响应体是 zip 本身**，所以走 `callBlob`。
   *
   * 一次请求同时做三件事：生成包 → 写交付记录 → 把方案置成「已交付」（A11 的自动置位）。
   * 三件事必须在一起：分成三个请求的话，中间任何一步失败都会留下
   * "库里写着已交付、可包没生成"这种**看起来是成功**的状态。
   */
  packageDelivery: (id, body) => callBlob('POST', `/schemes/${id}/delivery`, body),
  /** 交付记录 + 改状态留痕 + 可勾选的件清单（服务端下发，界面不抄）+ 三个固定视角 */
  deliveries: (id) => call('GET', `/schemes/${id}/deliveries`),
  /** 人工改交付状态（A11）：必须带一句原因，那句话进审计日志 */
  setDeliveryState: (id, status, note) => call('POST', `/schemes/${id}/delivery-state`, { status, note }),
  /** 型号使用情况（含「从未被使用的型号」）—— 维护端用 */
  adminProductUsage: () => call('GET', '/admin/product-usage'),
  /** 产品卡片列表（**含停用**：维护端要管的就是这些，见 AdminRepository 的注释） */
  adminProducts: () => call('GET', '/admin/products'),

  // 停用 / 启用（决策③：产品只停用不删除）。note 只进留痕，不回显 —— 它是给以后查的人看的。
  adminSetProductStatus: (id, status, note) =>
    call('POST', `/admin/products/${id}/status`, { status, note }),
  /** 系统状态：对象计数 / 磁盘 / LOD / 迁移版本 */
  adminSystem: () => call('GET', '/admin/system'),

  /**
   * 上传一个 .glb。后端**内容寻址**（按 sha256 命名），同一份文件重复上传不会写第二遍。
   * 返回的 `path` 是 `/api/assets/<sha>.glb`，直接作为 `model.sourceFilePath` 传回去 ——
   * 后端自己反推磁盘位置，前端不需要知道上传目录在哪。
   */
  adminUploadGlb: (file) => {
    const fd = new FormData();
    fd.append('file', file);
    return call('POST', '/admin/products/upload', fd);
  },
  /** 缩略图上传：浏览器分析器渲出的 PNG 或维护端手选图片；返回服务端相对路径。 */
  adminUploadThumb: (file) => {
    const fd = new FormData();
    fd.append('file', file);
    return call('POST', '/admin/products/upload-thumb', fd);
  },
  /** 产品信息 + 默认模型元数据（声明尺寸/门型/缩略图/尺寸结论）编辑。 */
  adminUpdateProduct: (id, body) => call('PUT', `/admin/products/${encodeURIComponent(id)}`, body),
  /** 物理删除产品；子表由数据库级联。模型文件保留（内容寻址，可能被别的产品共享）。 */
  adminDeleteProduct: (id) => call('DELETE', `/admin/products/${encodeURIComponent(id)}`),

  /**
   * 新建产品草稿。body 形如 `{ product, model, notes }`（由 `admin/wizard.js` 的
   * `buildPayload()` 组装，字段名与后端 `ProductAdminController` 逐字对应）。
   * 成功返回里带 `status`（应为 `draft`）与异步 LOD 的去向。
   */
  adminCreateProduct: (body) => call('POST', '/admin/products', body),

  /**
   * 给**已有产品**加一份模型（B5）。接口只收 `model` ——
   * 产品行一个字段都不改（型号/尺寸/门型是产品事实），于是已摆好的方案几何不受影响。
   * 失败了要说人话：404（产品不在）/ 409（变体重名，会列出已有的）/ 400（缺字段，一次攒齐）。
   */
  adminAddVariant: (productId, body) =>
    call('POST', `/admin/products/${encodeURIComponent(productId)}/variants`, body),

  /* ---------------- 产品知识看板（P0）---------------- */

  /** 维护端读内容 + 热点编辑态 + 发布摘要 + issues（GET，不写） */
  adminProductContent: (productId) =>
    call('GET', `/admin/products/${encodeURIComponent(productId)}/content`),
  /** 只读质量闸门：逐轴对账 + BLOCK/WARN 明细（人工代录无模型行 → 404） */
  adminProductQuality: (productId) =>
    call('GET', `/admin/products/${encodeURIComponent(productId)}/quality`),
  /**
   * 合并保存内容 + 热点 + validation：服务端内部 tx1 编辑态、tx2 发布快照。
   * 成功返回 `{rev,published,publishedRev,warnings,invalidCount}`；发布失败仍 200，
   * 带 `published:false` + `publishError`，编辑态保留。
   */
  adminSaveProductContent: (productId, body) =>
    call('PUT', `/admin/products/${encodeURIComponent(productId)}/content`, body),
  /** 只写热点编辑态（106 两步实现用），不发布；随后必须紧跟 publish。 */
  adminSaveProductHotspots: (productId, body) =>
    call('PUT', `/admin/products/${encodeURIComponent(productId)}/hotspots`, body),
  /** 把当前编辑态序列化为线上快照；v1 由“保存”按钮自动调用，不单独露按钮。 */
  adminPublishProductContent: (productId, body) =>
    call('POST', `/admin/products/${encodeURIComponent(productId)}/content/publish`, body || {}),
};