/**
 * routes.js —— 路由表与守卫（vue-router 的 history 模式）
 *
 * ## 为什么用现成的路由
 * 设计决策记录 §5 判据 1：有语义匹配的轮子直接用。现在有七条路径、两种入口形态（真实路径 + 旧 hash 接管）、
 * 一处登录守卫 —— 手写解析与订阅已经比轮子贵了。
 *
 * ## 放行名单只有一个出处
 * 「这一页要不要登录」写在路由自己的 `meta.public` 上，守卫只读这一个标记（`guard.js` 的
 * `routeDecision`）。**不许**在别处再手写一份"以 `/view/` 开头的就放行"——
 * 那种抄两份的名单，改一处漏一处的时候两边都不报错。
 *
 * ## 为什么组件是懒加载
 * 登录页不该把 Three.js 拖下来；设计器外壳也不该在登录页就被下载。
 * 每条路由一个动态 import，vite 自己分块。
 */
import { createRouter, createWebHistory } from 'vue-router';
import { ROUTES, setNavigator } from './router.js';
import { routeDecision } from './guard.js';
import { authed, ensureSession } from './session.js';

export const ROUTES_TABLE = [
  { path: '/login', name: ROUTES.LOGIN, meta: { public: true }, component: () => import('./pages/LoginPage.vue') },
  { path: '/index', name: ROUTES.HOME, component: () => import('./pages/HomePage.vue') },
  { path: '/project', name: ROUTES.PROJECT, component: () => import('./pages/MySchemesPage.vue') },
  // `/design/new` 必须写在 `/design/:id` 前面（静态段优先，读表的人也不用猜）
  { path: '/design/new', name: ROUTES.DESIGN_NEW, component: () => import('./App.vue') },
  {
    path: '/design/:id',
    name: ROUTES.DESIGN,
    meta: { designDetail: true },
    component: () => import('./App.vue'),
  },
  // 维护端五个页签与向导三个子路径都靠后续分段判断，这里一条兜住（AdminApp 自己认）
  { path: '/admin/:seg(.*)*', name: ROUTES.ADMIN, component: () => import('./admin/AdminApp.vue') },
  // 只读分享页：**免登录**（`meta.public`），凭手里的口令看
  {
    path: '/view/:token',
    name: ROUTES.SHARE,
    meta: { public: true },
    props: true,
    component: () => import('./components/PresentView.vue'),
  },
  // 认不出来的一律安静回首页（不报错、不白屏）—— 与手写路由时代同一条口径
  { path: '/', redirect: '/index' },
  { path: '/:pathMatch(.*)*', redirect: '/index' },
];

export function createAppRouter() {
  const router = createRouter({ history: createWebHistory(), routes: ROUTES_TABLE });

  // 跳转只有一个出口（router.js 的 go 调它），组件里不再直接改地址栏
  setNavigator((path) => { router.push(path); });

  router.beforeEach(async (to) => {
    await ensureSession();
    const d = routeDecision(to, authed.value);
    return d.action === 'redirect' ? d.to : true;
  });

  return router;
}
