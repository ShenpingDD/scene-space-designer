/**
 * u1-source.test.js —— U1 前端判据里**只能靠读源码**才能钉住的那几条（F9 / F10 / F12 与几条同源纪律）
 *
 * 为什么要有这一层：这几件事在界面上**都对得出来**，却在运行时报不出来 ——
 * 名单抄了两份、跳转逻辑写了第二处、挂点被塞进假数据，全都是"看起来正常"。
 * 判据沿用 `admin-batch4-cleanup.test.js` 的先例：直接读 `.vue` / `.js` 的文本。
 *
 * 从 `app/test/` 出发 `'../../'` 才是仓根（少一层就到 `app/` 下面去了 —— 实测 ENOENT 踩过）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const read = (p) => readFileSync(new URL('../../' + p, import.meta.url), 'utf8');

/** 去掉注释之后的源码：注释里会出现"别这么写"的示例（例如 `window.location.hash = …`），
 *  拿它当犯规是判据自己看错了。只用它做"整片里不许出现某件事"这类断言。 */
function stripComments(text) {
  return String(text).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** app/src 下的全部源码（`.js` 与 `.vue`），用于"整片里不许出现某件事"这类断言 */
function srcFiles() {
  const root = new URL('../../app/src/', import.meta.url);
  return readdirSync(root, { recursive: true })
    .map((p) => String(p).replace(/\\/g, '/'))
    .filter((p) => p.endsWith('.js') || p.endsWith('.vue'))
    .map((p) => ({ path: 'app/src/' + p, text: read('app/src/' + p) }));
}

const SRC = srcFiles();
/** 找犯规者：排除掉"这里本来就是它的家"的那几个文件 */
const offendersOf = (re, allowed) => SRC.filter((f) => !allowed.includes(f.path) && re.test(stripComments(f.text)))
  .map((f) => f.path);

/* ---------------- F9：免登录名单只有一个出处 ---------------- */

test('F9：分享页的免登录标记写在路由上，守卫读的是同一个标记', () => {
  const routes = read('app/src/routes.js');
  assert.match(routes, /path: '\/view\/:token'/, '分享页要有一条真实路径的路由');
  assert.match(routes, /meta: \{ public: true \}/, '免登录标记写在路由自己身上');
  assert.match(routes, /props: true/, '口令要作为参数交给页面，页面不自己去读地址栏');

  const guard = read('app/src/guard.js');
  assert.match(guard, /meta\.public/, '守卫只读这一个标记');
});

test('F9：`app/src` 里没有第二处手写的「/view/ 开头的就放行」', () => {
  assert.deepEqual(offendersOf(/startsWith\(\s*['"]\/view/, []), [],
    '放行名单抄第二份就会出现"改一处漏一处"，而两边都不报错');
  // 反过来说明这条断言不是瞎的：`/view/` 这个形状本身确实出现在源码里
  assert.ok(SRC.some((f) => f.text.includes('/view/')), '源码里应当有 /view/ 这个形状');
});

/* ---------------- F8 的兜底那一半：认不出来的地址安静回首页 ---------------- */

test('路由表：兜底回首页，而且 `/design/new` 排在 `/design/:id` 前面', () => {
  const routes = read('app/src/routes.js');
  assert.match(routes, /path: '\/:pathMatch\(\.\*\)\*', redirect: '\/index'/,
    '认不出来的地址安静回首页（白屏是这一族里最坏的结果）');
  assert.match(routes, /path: '\/', redirect: '\/index'/, '根地址回首页');
  const atNew = routes.indexOf("path: '/design/new'");
  const atId = routes.indexOf("path: '/design/:id'");
  assert.ok(atNew > 0 && atId > 0 && atNew < atId,
    '静态段要排在参数段前面（读表的人不用猜谁先匹配）');
  const atLogin = routes.indexOf("path: '/login'");
  const atHome = routes.indexOf("path: '/index'");
  assert.ok(atLogin > 0 && atLogin < atHome, '登录页排在最前面');
});

/* ---------------- F10：首页改版 ---------------- */

test('F10：首页的挂点在 banner 容器上，banner 里是真图与圆点，不再是一句占位', () => {
  const home = read('app/src/pages/HomePage.vue');
  assert.match(home, /data-ui-slot="home-guide"/, '挂点名字是判据盯的那个属性');
  // 挂点搬到 banner 那个 section 上（设计决策记录 §十三第 2 条）：属性名不动，端到端探针按它取元素
  assert.match(home, /class="home__banner"[\s\S]{0,200}data-ui-slot="home-guide"/,
    '挂点要在 banner 容器上');
  assert.ok(!/功能导览区（样式待 UI 稿）/.test(home), '占位说明随改版一起去掉');
  // 三张 banner 由 ESM 导入；标题只给读屏与圆点用，页面不再往图上压字
  for (const n of [1, 2, 3]) assert.match(home, new RegExp('assets/home/banner-' + n + '\\.png'));
  for (const t of ['平面到立体，一屏同看', '摆完即体检：碰墙、间距、开门净空', '一个二维码，客户免登录看立体图']) {
    assert.ok(home.includes(t), 'banner 标题照 设计决策记录 §四抄：' + t);
  }
  // 图里自带文字：蒙版与叠加的标题说明都不该再出现
  const css = read('app/src/pages/home.css');
  for (const gone of ['home__shade', 'home__pitch', 'home__title', 'home__desc']) {
    assert.ok(!home.includes(gone) && !css.includes(gone), 'banner 上不再叠 ' + gone);
  }
  // 高度只按容器自己的宽度算（100cqi），容器比例恒等于图 7.1935:1；不再用 212px/视口高上限
  assert.match(css, /height: calc\(100cqi \/ 7\.1935\)/, 'banner 高度按内容区宽度比例计算，contain 不产生两侧留白');
  assert.ok(!/212px|100vh - 617px/.test(css), '旧的三段取小公式已废止');
  assert.ok(!/100vw/.test(css), '整份首页样式都不按视口宽算');
  assert.ok(!/aspect-ratio: 3791/.test(css), '容器不写死图比例，高度由容器宽算');
  assert.match(css, /\.home__shot \{[\s\S]{0,260}object-fit: contain/, '图片整幅显示，不裁切');
  assert.match(css, /\.home__banner \{[\s\S]{0,360}box-shadow: var\(--shadow-card\)/, 'banner 用设计稿的默认卡片阴影');
  assert.match(css, /\.home__card \{[\s\S]{0,260}box-shadow: var\(--shadow-card\)/, '方案卡默认阴影');
  assert.match(css, /\.home__card:hover \{[\s\S]{0,180}box-shadow: var\(--shadow-card-hover\)/, '方案卡 hover 加深一档');
  // 边框不占布局：outline 压在盒子内沿，内容盒与图同比例，四边零留白
  assert.match(css, /\.home__banner \{[\s\S]{0,300}outline: 1px solid var\(--line\)/, 'banner 的边线画在盒子内沿');
  assert.match(css, /\.home__banner \{[\s\S]{0,300}outline-offset: -1px/, '边线不占布局，图能铺满');
  assert.ok(!/\.home__banner \{[\s\S]{0,300}border: 1px solid var\(--line\)/.test(css), 'banner 不再用占布局的边框');
  // 栅格容器：banner、标题行、卡片墙同宽居中，容器查询按它自己的宽度
  assert.match(css, /\.home__pane \{[\s\S]{0,200}max-width: 1516px/, '栅格容器最宽 1516');
  assert.match(css, /\.home__pane \{[\s\S]{0,200}container-type: inline-size/, '栅格容器按自身宽度做容器查询');
  const mainStart = home.indexOf('<main class="home__body">');
  const mainEnd = home.indexOf('</main>');
  const atPane = home.indexOf('class="home__pane"');
  for (const cls of ['home__banner', 'home__head', 'home__wall']) {
    const at = home.indexOf('class="' + cls + '"');
    assert.ok(atPane > mainStart && at > atPane && at < mainEnd, cls + ' 在 pane 里，与 banner 同级');
  }
  // 卡片墙四档递增式断点，各带自己的列数
  assert.match(css, /@media \(min-width: 560px\) \{\s*\.home__wall \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/, '560 px 起两列');
  assert.match(css, /@media \(min-width: 816px\) \{\s*\.home__wall \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \}/, '816 px 起三列');
  assert.match(css, /@media \(min-width: 1072px\) \{\s*\.home__wall \{ grid-template-columns: repeat\(4, minmax\(0, 1fr\)\); \}/, '1072 px 起四列');
  assert.match(css, /@media \(min-width: 1328px\) \{\s*\.home__wall \{ grid-template-columns: repeat\(5, minmax\(0, 1fr\)\); \}/, '1328 px 起五列');
  // 圆点组垫半透明胶囊底，白底图上也能看清
  assert.match(css, /\.home__dots \{[\s\S]{0,260}background: rgb\(20 32 40 \/ 45%\)/, '圆点组有半透明底');
  assert.match(css, /\.home__dots \{[\s\S]{0,260}border-radius: 999px/, '底是胶囊形');
  assert.match(home, /ROTATE_MS/, '轮换要有一个可读的间隔常量');
  assert.match(home, /prefers-reduced-motion/, '设了减少动态效果的人不自动轮换');

  assert.match(home, /go\('\/design\/new'\)/, '「新建场景空间设计方案」走真实路径');
  assert.ok(!/window\.location\.hash/.test(stripComments(home)), '不许自己改地址栏');
});

test('F10：首页卡片墙是 5 列、最多 19 张，第 1 格固定是新建', () => {
  const home = read('app/src/pages/HomePage.vue');
  const css = read('app/src/pages/home.css');
  assert.match(home, /MAX_CARDS = 19/, '20 格减去新建那一格（设计决策记录 §五第 3 条）');
  assert.match(home, /sortSchemes\(rows\.value, SORTS\.UPDATED\)/, '按最近更新时间排序，复用方案库那一套');
  assert.match(home, /\.slice\(0, MAX_CARDS\)\.map\(cardOf\)/, '取前 19 条再转卡片');
  assert.match(css, /\.home__wall \{[\s\S]{0,120}grid-template-columns: 1fr/, '最窄一档单列，往上由递增断点加列');
  // 新建卡片排在方案卡片之前：模板里它的位置要在 v-for 那段之前
  const atNew = home.indexOf('class="home__new"');
  const atCards = home.indexOf('v-for="c in cards"');
  assert.ok(atNew > 0 && atCards > atNew, '第 1 格是新建');
  assert.match(home, /你还没有方案/, '没有方案时给一句引导');
  assert.match(home, /取不到方案列表：/, '取不到列表要说清是哪一种失败');
});

test('F10：首页卡片与账号区按 设计决策记录的形状写（缩略图 alt、16:9、菜单只有退出登录）', () => {
  const home = read('app/src/pages/HomePage.vue');
  const css = read('app/src/pages/home.css');
  const acct = read('app/src/components/AccountBox.vue');
  const global = read('app/src/style.css');
  assert.match(home, /:alt="'封面：' \+/, '缩略图的替代文字是「封面：〔方案名〕」');
  assert.match(home, /<span v-else>无封面<\/span>/, '没有封面时用文字占位，不画假图');
  assert.match(home, /更新于 \{\{ c\.updatedText \}\}/, '卡片要说清最后更新时间，带「于」字');
  assert.match(css, /aspect-ratio: 16 \/ 9/, '缩略图 16:9');
  assert.match(css, /min-height: 210px/, '新建卡片与状态格的高度');
  // 账号区：一个按钮带 aria-haspopup，菜单里只有一条 role="menuitem"
  assert.match(acct, /aria-haspopup="menu"/);
  assert.match(acct, /:aria-expanded="open"/);
  assert.match(acct, /role="menu"/);
  assert.equal((acct.match(/role="menuitem"/g) || []).length, 1, '菜单里只有「退出登录」一项');
  assert.match(acct, /busy \? '退出中…' : '退出登录'/);
  assert.match(global, /\.acct__menu \{[\s\S]*?width: 160px/, '菜单宽 160、圆角 12、带阴影（设计决策记录 §三第 9 条）');
  assert.match(global, /\.acct__menu \{[\s\S]*?border-radius: 12px/);
  // 显示名在上、角色缩小放在它下方
  assert.match(acct, /class="acct__who">[\s\S]{0,120}class="acct__name"/, '名字与角色装在同一个块里');
  assert.match(acct, /class="acct__name"[\s\S]{0,80}class="acct__role"/, '角色排在名字后面');
  assert.match(global, /\.acct__who \{[\s\S]{0,160}?flex-direction: column/, '两行是竖排，名字与角色不并排');
  assert.match(global, /\.acct__name \{ font-size: 13px; font-weight: 600/, '显示名 13 px、加粗');
  assert.match(global, /\.acct__role \{ font-size: 11px; color: var\(--ink-3\)/, '角色 11 px、颜色比显示名浅');
  // 维护端入口是顶部导航的一项，排在账号区左侧
  assert.match(home, /<a v-if="canAdmin" class="home__admin" href="\/admin"/, '维护端入口是链接');
  const atAdmin = home.indexOf('class="home__admin"');
  const atAcct = home.indexOf('<AccountBox />');
  assert.ok(atAdmin > 0 && atAcct > atAdmin, '维护端排在账号区左侧');
  // 窄屏只收起角色，显示名与维护端入口都还在（设计决策记录 §十）
  const narrow = css.slice(css.indexOf('@media (max-width: 767px)'));
  assert.match(narrow, /\.home \.acct__role \{ display: none; \}/, '窄屏收起角色');
  assert.ok(!/\.home \.acct__who[^}]*display: none/.test(narrow), '窄屏仍然显示用户名');
  assert.ok(!/\.home__admin \{[^}]*display: none/.test(narrow), '窄屏仍然能看到维护端入口');
  // 提醒底色走变量，不写死十六进制
  assert.ok(!/#[0-9a-f]{6}/i.test(css), '页面配色一律走 style.css 的变量');
});

/* ---------------- F12：会话失效的处置只有一处 ---------------- */

test('F12：跳到登录页并带回跳地址的逻辑只出现在请求封装里', () => {
  assert.deepEqual(offendersOf(/loginHref\(/, ['app/src/api.js', 'app/src/guard.js']), [],
    '别的文件不许自己跳登录页 —— 同一个判断写两处，改漏一侧不报错');
  const api = read('app/src/api.js');
  // 两个 fetch 封装都要处置 401（少一个就会出现"这个接口失效时不跳"这种半截行为）
  assert.equal(api.split('handleUnauthorized()').length - 1, 3, '一处定义 + 两处调用（call 与 callBlob）');
  assert.match(api, /if \(res\.status === 401\) handleUnauthorized\(\);/);
  assert.match(api, /isLoginPath\(currentPath\(\)\)/, '已经在登录页就不再跳自己（否则会反复刷新）');
});

test('F12：两处请求封装都带 CSRF 头（写方法与读方法一视同仁）', () => {
  const api = read('app/src/api.js');
  // 只看两个封装自己的函数体：取令牌那一趟的定义在它们前面，混在一起看不出漏了哪一处
  const callBody = api.split('async function call(method, path, body)')[1].split('async function callBlob')[0];
  const blobBody = api.split('async function callBlob')[1].split('export function fileNameOf')[0];
  assert.ok(callBody.includes('csrfHeaderOf(document.cookie)'), 'call 要带令牌头');
  assert.ok(blobBody.includes('csrfHeaderOf(document.cookie)'), 'callBlob 要带令牌头');
  assert.ok(callBody.includes('if (isWriteMethod(method)) await primeCsrf();'), 'call 里写请求先取令牌');
  assert.ok(blobBody.includes('if (isWriteMethod(method)) await primeCsrf();'), 'callBlob 里写请求先取令牌');
  assert.match(api, /export const CSRF_HEADER = 'X-XSRF-TOKEN'/, '头名只有一个出处');
  assert.match(api, /export const CSRF_COOKIE = 'XSRF-TOKEN'/, 'cookie 名只有一个出处');
  assert.match(api, /export function isWriteMethod\(method\)/, '「哪些请求要令牌」只有一处');
  assert.match(api, /const AUTH_ME = '\/auth\/me'/, '取令牌的地址只有一个出处');
});

test('F12：会话失效之后的去向由 session.js 接上（不是各页面自己清状态）', () => {
  const session = read('app/src/session.js');
  assert.match(session, /setSessionLostHandler\(sessionLost\)/, '装配只有一处');
  assert.deepEqual(offendersOf(/setSessionLostHandler\(\s*[a-zA-Z]/, ['app/src/api.js', 'app/src/session.js']), [],
    '第二个注册方会让"会话没了"这件事有两个说法');
});

/* ---------------- 登录页那两句稳定文案（端到端判据 A15 盯着它们） ---------------- */

test('登录页：会话过期与"带回头路"各有一句稳定文案，且只从 query 读', () => {
  const page = read('app/src/pages/LoginPage.vue');
  assert.ok(page.includes('会话已过期，请重新登录'), '被请回登录页时要说清为什么又要登录');
  assert.ok(page.includes('登录后会回到你原来要去的页面'), '带 redirect 时要说清登录之后的去向');
  assert.match(page, /route\.query\.reason/, '过期的标记从 query 读');
  assert.match(page, /route\.query\.redirect/, '回跳地址从 query 读');
  // 两句各有一个显示条件，不许合并成一句
  assert.match(page, /v-if="expired"/);
  assert.match(page, /v-if="hasBack"/);
});

test('登录页改版：品牌区、宽 400 的卡、两个输入框的标签与占位', () => {
  const page = read('app/src/pages/LoginPage.vue');
  const css = read('app/src/pages/login.css');
  assert.match(page, /assets\/brand\/brand-mark\.png/, '左上角用横版组合标那张图（与首页共用）');
  assert.match(page, /alt="场景空间设计器/, '这张图要有替代文字');
  assert.match(css, /url\("\.\.\/assets\/login\/login-bg\.png"\)/, '背景图走 CSS 的相对 url，交给 Vite 处理');
  assert.match(css, /\.login__card \{[\s\S]*?width: min\(400px, 100%\)/, '卡宽 400、窄屏跟着视口收（设计决策记录 §二）');
  assert.match(css, /\.login__card \{[\s\S]*?border-radius: 12px/, '卡圆角 12（设计决策记录 §八）');
  // 标签与输入框用 for/id 关联：点标签能把光标送进输入框（设计决策记录 §九第 2 条）
  assert.match(page, /<label for="login-username">账号<\/label>/);
  assert.match(page, /<label for="login-password">密码<\/label>/);
  assert.match(page, /id="login-username"/);
  assert.match(page, /id="login-password"/);
  assert.match(page, /placeholder="请输入账号"/);
  assert.match(page, /placeholder="请输入密码"/);
  // 两个输入框的 name 是探针取元素的方式，改不得（设计决策记录 §十一第 5 条）
  assert.match(page, /name="username"/);
  assert.match(page, /name="password"/);
  assert.match(page, /autocomplete="current-password"/);
});

test('登录页只留品牌、标题、两个输入框与按钮：说明句、页脚与背景亮点都不在', () => {
  const page = read('app/src/pages/LoginPage.vue');
  const css = read('app/src/pages/login.css');
  for (const s of ['请用管理员给你的账号登录。',
    '权限来自登录账号的角色',
    '本系统在内网以明文 HTTP 运行',
    '账号由管理员在维护端「用户」页创建与停用',
    '忘记了密码也找管理员重置。',
    '平面到立体，一屏同看',
    '拖一笔，成一间房',
    '门与窗按真实尺寸开在墙上',
    '摆完即体检：碰墙、间距、开门净空']) {
    assert.ok(!page.includes(s), '这一页不该再出现：' + s);
  }
  for (const cls of ['.login__lead', '.login__foot', '.login__points']) {
    assert.ok(!css.includes(cls), '样式里也不该留着：' + cls);
  }
  assert.ok(!page.includes('口令'), '这一页的用词里不该有「口令」（分享口令是另一件事）');
  assert.match(page, /账号和密码都要填。/, '必填提示仍在');
});

test('过期的标记只加在"登录过的人"身上（从没登录过的人不该看到那句话）', () => {
  const api = read('app/src/api.js');
  assert.match(api, /onSessionLost\(\) === true/, '处置方要说明刚才是不是已经登录过');
  assert.match(api, /\+ \(known \? '&reason=' \+ REASON\.EXPIRED : ''\)/,
    '只有登录过的人才带 reason=expired');
  assert.match(api, /EXPIRED: 'expired'/, '参数值只有一个出处');
  const session = read('app/src/session.js');
  assert.match(session, /const known = !!me\.value \|\| !!user\.value \|\| authed\.value;/,
    '清状态之前先看有没有登录过');
  assert.match(session, /return known;/, '这个事实要交回给请求层');
});

/* ---------------- 分端纪律：方案库与「我的方案」各取各的 ---------------- */

test('「我的方案」页只调 `/api/schemes`（维护端那一口是另一页的事）', () => {
  const page = read('app/src/pages/MySchemesPage.vue');
  assert.match(page, /api\.mySchemes\(/, '这一页取自己的方案');
  assert.ok(!/adminSchemes/.test(page), '维护端那一口（全部账号）不该出现在这一页');
  assert.ok(!/fetch\(/.test(stripComments(page)), '取数只走 api.js —— 界面里不该有第二个知道 HTTP 的地方');
  // 「工具条与取数各留一份」（设计决策记录 §六第2项）：卡片模板共用，页面各自有工具条与取数
  assert.match(page, /SchemeCard/, '卡片模板走共用组件');
});

/* ---------------- 不留旧形态的痕迹 ---------------- */

test('全站不再有自己写地址栏的代码（跳转只走 `go`）', () => {
  assert.deepEqual(offendersOf(/window\.location\.hash\s*=/, []), [],
    '自己改地址栏就会出现"地址变了界面没换"');
  // 唯一允许读 hash 的地方是启动时那一次旧地址接管
  const readers = SRC.filter((f) => /legacyHashRedirect/.test(f.text)).map((f) => f.path).sort();
  assert.deepEqual(readers, ['app/src/main.js', 'app/src/router.js']);
});

test('权限提示的那句话在维护端两处都写出来了（角色 + 明文 HTTP 的边界）', () => {
  // 登录页按用户要求只留品牌、标题、两个输入框与按钮，这句话不再出现在那一页
  const claims = {
    'app/src/App.vue': '口令',
    'app/src/admin/AdminApp.vue': '口令',
  };
  for (const [p, word] of Object.entries(claims)) {
    const flat = read(p).replace(/\s+/g, '');
    for (const c of ['权限来自登录账号的角色',
      '本系统在内网以明文 HTTP 运行，' + word + '与分享链接不要转发到内网以外']) {
      assert.ok(flat.includes(c.replace(/\s+/g, '')), p + ' 上要说这句：' + c);
    }
  }
  // 认证还没接时那句旧话术不许留在源码里
  assert.deepEqual(offendersOf(/认证尚未接入/, []), [], '认证已经接了，旧话术会把用户指错方向');
});

test('F7：`/design/new` 上没有草稿时工作区回到默认那一间房（换账号之后不许留着上一个人的）', () => {
  const app = read('app/src/App.vue');
  assert.match(app,
    /restoreDraft\(\s*store,\s*\(state, format\) => d\.applyServerState\(state, format\),\s*\(\) => d\.resetNewDesign\(\),\s*\)/,
    '恢复草稿这一趟要把「回默认」那一支接上');
  // 程序换布局不能当成用户改动：不然换账号进 `/design/new` 会凭空写下一条默认布局的草稿
  assert.match(app, /if \(preparing\) return;/, 'watch 要挡住程序换布局那几次触发');
  assert.match(app, /watch\(d\.layout, \(\) => \{[\s\S]*?\}, \{ flush: 'sync' \}\)/,
    '同步 flush 才能让那个标记在同一段同步代码里生效');

  const designer = read('app/src/designer.js');
  const core = designer.split('function resetNewDesign()')[1].split('function reset()')[0];
  assert.match(core, /room\.createLayout\(\{ w: 8, d: 6, h: 2\.8 \}\)/, '默认那一间房由内核建出来');
  assert.match(core, /history\.clear\(\)/, '换了一份内容，撤销历史要一起清');
  assert.match(core, /nextId\.value = 4/);
  assert.doesNotMatch(core, /toast\(/, '这一支是代码自己走的，不该弹提示');
  const wrapper = designer.split('function reset()')[1].split('\n  }')[0];
  assert.match(wrapper, /resetNewDesign\(\)/, '用户点「重置」与换账号回默认是同一件事');
  assert.match(wrapper, /toast\(/, '用户自己点的那一次要告诉他');
  assert.match(designer, /reset, resetNewDesign, download/, 'resetNewDesign 要装配得出去');
});
