import { createApp } from 'vue';
// 根组件只挂公共提示条 + <router-view>；界面选择归路由表（routes.js）
import Root from './Root.vue';
import './style.css';
import './devkit.js'; // QA/演示接口（window.__spatial），不参与界面渲染

import { createAppRouter } from './routes.js';
import { legacyHashRedirect } from './router.js';
import { loadCatalog, startCatalogAutoRefresh } from './catalog.js';
import { api } from './api.js';
import { loadParams, startWatch } from './liveParams.js';

// 旧地址（hash 形态）在装配之前改写一次。`#/view/<口令>` 的链接已经发到客户手里，
// 没有任何渠道把它收回来，所以这段接管长期保留。
// 用 replaceState：用户按一次后退不该又回到旧地址、再被改写一次。
const legacyTarget = legacyHashRedirect(window.location.hash);
if (legacyTarget) window.history.replaceState(null, '', legacyTarget);

createApp(Root).use(createAppRouter()).mount('#app');

// 目录：**服务端优先、本地资产兜底**。刻意不 await —— 界面先出来，目录到了自己换；
// 后端没起也不影响干活（型号目录卡片上会写明当前用的是哪一份）。
loadCatalog(api.catalog).then((r) => {
  if (r.ok) console.log('[catalog] 服务端目录 ' + r.count + ' 款' + (r.skipped ? '（跳过 ' + r.skipped + ' 条残缺）' : ''));
  else console.warn('[catalog] 退回本地资产（原因：' + r.reason + '）');
});

/**
 * 目录的同页重读（task-75）：维护端上架一款产品之后，设计端**不用刷新整页**就该看见。
 *
 * 触发点是"人回到这个标签页"（window focus / visibilitychange），不是定时轮询 ——
 * 设计端可能一开几小时，定期问后端既没意义也压机器。节流（≥5s）在 catalog.js 里，
 * 这里只负责挂/摘监听；失败时目录**保留**当前那一份，原因由 ProductRail 的「刷新」显示。
 */
const stopCatalogWatch = startCatalogAutoRefresh();
window.addEventListener('beforeunload', stopCatalogWatch, { once: true });

// 规则参数：与目录同一套写法（不 await —— 后端没起也不能白屏）。
// 但**失败必须说出来**：静默退回默认值会让人以为"后台改的参数生效了"，而它没生效。
loadParams(api.params).then((r) => {
  if (r.ok) console.log('[params] 服务端参数已生效 rev ' + r.rev + '（' + r.origin + '）'
    + (r.ignored && r.ignored.length ? '，' + r.ignored.length + ' 项没被采用' : ''));
  else console.warn('[params] 退回代码里的默认值（原因：' + r.reason + '，内核本地 rev ' + r.localRev + '）');
  // 然后盯住版本：后台一改，**已经打开的页面也跟上**（2026-09-29 拍板要做自动刷新）。
  // 只问版本（几十字节），变了才取整份内容 —— 见 liveParams.startWatch。
  startWatch(api.paramsRev);
});
