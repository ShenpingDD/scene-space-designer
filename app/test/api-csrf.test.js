/**
 * 退出登录之后，在同一篇文档里重新登录 —— 令牌从哪来。
 *
 * 盯的是一个真缺口：`POST /api/auth/logout` 会把 `XSRF-TOKEN` 与 `SPATIAL_SESSION` 一起注销掉，
 * 而登录页是同一篇文档里的客户端跳转、挂载时不发任何请求；于是「退出之后马上重新登录」
 * 这一次 POST 手里一个令牌都没有，服务端按跨站请求挡下（403 `bad-csrf`），
 * 人非得手动刷新一次页面才恢复。
 *
 * 这里不替服务端做判断：下面这台 HTTP 服务是真的（`node:http`），令牌是真的走 `Set-Cookie`
 * 下来的，登录那一趟的请求头由**服务端自己**核对 —— 对不上就回 403。测试只代班浏览器本来
 * 就会做的两件事：把响应的 `Set-Cookie` 收进 cookie 罐子、把罐子当成 `document.cookie` 给页面看。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { CSRF_COOKIE, CSRF_HEADER, REASON, api, setSessionLostHandler } from '../src/api.js';

/**
 * 服务端发下来的令牌（带 `=` 补位：顺便看住「按第一个 = 切」那条口径）。
 * 值**故意写成一眼看得出是夹具**的样子：随机 base64 串会被密钥扫描器当成真凭证报出来
 * （gitleaks 的 generic-api-key 就这样中过一次），而这个文件里只需要「一个带 = 的令牌」。
 */
const TOKEN = 'csrf-fixture-0123456789abcdef==';

/** 请求流水：`方法 地址`，用来判「谁先谁后」 */
const sequence = (server) => server.hits.map((h) => h.method + ' ' + h.url);

/**
 * 一台真的 HTTP 服务，行为照服务端那三件事写：任何一趟响应都把令牌种下来、写请求核对令牌、未登录回 401。
 * `stopIssueToken()` 用来造「令牌要了一趟也要不回来」那种服务端。
 */
async function startServer() {
  const hits = [];
  let issueToken = true;
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      hits.push({
        method: req.method,
        url: req.url,
        token: req.headers[CSRF_HEADER.toLowerCase()] || null,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      const reply = (status, payload, setCookie) => {
        const headers = { 'Content-Type': 'application/json' };
        if (setCookie) headers['Set-Cookie'] = setCookie;
        res.writeHead(status, headers);
        res.end(JSON.stringify(payload));
      };
      if (req.url === '/api/auth/me') {
        // CsrfCookieFilter：每一趟响应都把令牌写下来（手里没有就发一个新的）
        reply(200, { ok: true, authenticated: false },
          issueToken ? `${CSRF_COOKIE}=${TOKEN}; Path=/` : null);
        return;
      }
      if (req.url === '/api/auth/login') {
        // CsrfFilter：令牌对不上就是跨站请求
        if (req.headers[CSRF_HEADER.toLowerCase()] !== TOKEN) {
          reply(403, { ok: false, reason: REASON.BAD_CSRF, message: '跨站请求令牌缺失或不匹配：刷新页面之后重试' });
          return;
        }
        reply(200, { ok: true, user: { id: 7, username: 'u1', displayName: '张三', roleCode: 'admin' } });
        return;
      }
      if (req.url === '/api/schemes') {
        reply(401, { ok: false, reason: REASON.UNAUTHORIZED, message: '没有登录' });
        return;
      }
      reply(404, { ok: false, reason: REASON.NOT_FOUND, message: '没有这个地址' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    hits,
    origin: 'http://127.0.0.1:' + server.address().port,
    stopIssueToken: () => { issueToken = false; },
    close: () => new Promise((r) => server.close(r)),
  };
}

/** 浏览器的代班：cookie 罐 + 跳转记录。每一趟请求都真的发出去，响应也真的读回来 */
function installBrowser(origin) {
  const jar = new Map();
  const assigned = [];
  const realFetch = globalThis.fetch;

  globalThis.fetch = async (url, init) => {
    const res = await realFetch(url, init);
    // 浏览器收到 Set-Cookie 就写进罐子：值为空或 Max-Age=0 就是删掉这一项
    for (const raw of res.headers.getSetCookie()) {
      const pair = String(raw).split(';')[0];
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value) jar.set(name, value);
      else jar.delete(name);
    }
    return res;
  };

  globalThis.document = {
    get cookie() {
      return [...jar.entries()].map(([k, v]) => k + '=' + v).join('; ');
    },
  };
  globalThis.window = {
    location: {
      origin,
      pathname: '/index',
      search: '',
      assign: (to) => assigned.push(to),
    },
  };

  return {
    assigned,
    at: (path) => { globalThis.window.location.pathname = path; },
    cookieText: () => globalThis.document.cookie,
    restore() {
      globalThis.fetch = realFetch;
      delete globalThis.document;
      delete globalThis.window;
    },
  };
}

test('退出登录之后（cookie 罐已清空）再登录：先取令牌，再带头发那一次 POST', async (t) => {
  const server = await startServer();
  const browser = installBrowser(server.origin);
  t.after(async () => { browser.restore(); await server.close(); });

  const r = await api.login('u1', 'pw-123456');

  assert.equal(r.user.username, 'u1');
  assert.deepEqual(sequence(server), ['GET /api/auth/me', 'POST /api/auth/login'],
    '手里没有令牌：先走一趟放行清单里的取令牌 GET，再发登录');
  assert.equal(server.hits[1].token, TOKEN, '登录这一趟必须带上令牌头');
  assert.equal(server.hits[1].body, JSON.stringify({ username: 'u1', password: 'pw-123456' }));
});

test('手里已经有令牌（页面加载时问过一趟「我是谁」）：登录不再多插一趟取令牌的 GET', async (t) => {
  const server = await startServer();
  const browser = installBrowser(server.origin);
  t.after(async () => { browser.restore(); await server.close(); });

  await api.authMe();
  assert.deepEqual(sequence(server), ['GET /api/auth/me']);
  assert.equal(browser.cookieText(), CSRF_COOKIE + '=' + TOKEN, '这一趟把令牌种进了罐子');

  await api.login('u1', 'pw-123456');
  assert.deepEqual(sequence(server), ['GET /api/auth/me', 'POST /api/auth/login'],
    '已经有令牌就不该再问一趟');
  assert.equal(server.hits[1].token, TOKEN);
});

test('令牌要了一趟还是要不回来：就地抛出，不硬发那一次注定被挡的 POST', async (t) => {
  const server = await startServer();
  server.stopIssueToken();
  const browser = installBrowser(server.origin);
  t.after(async () => { browser.restore(); await server.close(); });

  await assert.rejects(() => api.login('u1', 'pw-123456'), (e) => e.reason === REASON.BAD_CSRF);

  assert.deepEqual(sequence(server), ['GET /api/auth/me'], '没有令牌就不该把登录请求发出去');
  assert.equal(browser.cookieText(), '', '罐子一直是空的');
});

test('会话过期那条路不变：401 带 reason=expired 回登录页，读请求不发取令牌那一趟', async (t) => {
  const server = await startServer();
  const browser = installBrowser(server.origin);
  browser.at('/project');
  setSessionLostHandler(() => true);
  t.after(async () => { setSessionLostHandler(null); browser.restore(); await server.close(); });

  await assert.rejects(() => api.mySchemes(), (e) => e.reason === REASON.UNAUTHORIZED);

  assert.deepEqual(browser.assigned, ['/login?redirect=%2Fproject&reason=' + REASON.EXPIRED]);
  assert.deepEqual(sequence(server), ['GET /api/schemes'], '读请求不需要令牌，不该多插一趟');
});

test('从没登录过的人被 401 请回登录页：不带 reason（他不该看到「会话已过期」）', async (t) => {
  const server = await startServer();
  const browser = installBrowser(server.origin);
  browser.at('/project');
  setSessionLostHandler(() => false);
  t.after(async () => { setSessionLostHandler(null); browser.restore(); await server.close(); });

  await assert.rejects(() => api.mySchemes(), (e) => e.reason === REASON.UNAUTHORIZED);

  assert.deepEqual(browser.assigned, ['/login?redirect=%2Fproject']);
});

/**
 * S2-A 回归：会话过期时**两趟**在飞的请求一起回 401，只许跳一次，且第一趟的 reason 要保住。
 *
 * 缺陷原样：第一趟 `GET /api/schemes` 401 时处置方还说「登录过」（true），地址带 reason=expired；
 * 第二趟 401 时处置方已把会话清空（false），若它照旧 assign，一个**不带 reason** 的地址
 * 就把第一次的地址覆盖掉。而 `window.location.assign` 在 unload 前不改 `pathname`，
 * `isLoginPath()` 挡不住第二次 —— 真实浏览器里就是这么丢的。
 */
test('连着一趟会话两趟 401：只跳一次登录页，第一趟的 reason=expired 不被覆盖', async (t) => {
  const server = await startServer();
  const browser = installBrowser(server.origin);
  browser.at('/project');
  // 处置方照真实实现的顺序回答：第一趟 true（会话刚没），之后 false（已经清过了）
  let asked = 0;
  setSessionLostHandler(() => {
    asked += 1;
    return asked === 1;
  });
  t.after(async () => { setSessionLostHandler(null); browser.restore(); await server.close(); });

  await assert.rejects(() => api.mySchemes(), (e) => e.reason === REASON.UNAUTHORIZED);
  await assert.rejects(() => api.mySchemes(), (e) => e.reason === REASON.UNAUTHORIZED);

  assert.deepEqual(sequence(server), ['GET /api/schemes', 'GET /api/schemes'], '两趟请求都真的发出去了');
  assert.equal(asked, 2, '两趟 401 都问过处置方（第一次 true、第二次 false），不是只问了第一趟');
  assert.deepEqual(browser.assigned, ['/login?redirect=%2Fproject&reason=' + REASON.EXPIRED],
    '只跳一次；第二次不带 reason 的地址不许覆盖第一次');
});

test('同一篇文档里重新登录之后闩要复位：这个人再过期还会被请回登录页', async (t) => {
  const server = await startServer();
  const browser = installBrowser(server.origin);
  browser.at('/project');
  setSessionLostHandler(() => true);
  t.after(async () => { setSessionLostHandler(null); browser.restore(); await server.close(); });

  await assert.rejects(() => api.mySchemes(), (e) => e.reason === REASON.UNAUTHORIZED);
  assert.deepEqual(browser.assigned, ['/login?redirect=%2Fproject&reason=' + REASON.EXPIRED],
    '第一趟跳登录页');

  // 登录页是客户端跳转，整篇文档不重新加载 —— 闩必须在新会话建立时复位，
  // 否则这个人之后再过期就只是报错、不会跳（不报错的错，最难查）。
  await api.login('u1', 'pw-123456');
  await assert.rejects(() => api.mySchemes(), (e) => e.reason === REASON.UNAUTHORIZED);

  assert.deepEqual(browser.assigned,
    ['/login?redirect=%2Fproject&reason=' + REASON.EXPIRED,
      '/login?redirect=%2Fproject&reason=' + REASON.EXPIRED],
    '重新登录之后的这一次过期仍然要被请回登录页');
});
