/**
 * session.js —— 会话状态（我是谁、我能不能进）在前端只有这一份
 *
 * ## 只问一次
 * `/api/auth/me` 与 `/api/admin/me` 都只在**第一次需要**时问一次，结果缓存在这里：
 * 每跳一次页面就问一遍后端，既慢又会让"两个页面说法不一样"有机会发生。
 * 会话失效回来（`sessionLost`）时把缓存清掉，下一次导航重新问。
 *
 * ## 能力表仍然只从 `/api/admin/me` 读
 * 登录响应里带的是身份（id / username / displayName / roleCode），**不含能力表** ——
 * 同一个事实不留两处（设计决策记录 §三第5项）。
 */
import { computed, ref } from 'vue';
import { api, setSessionLostHandler } from './api.js';

/** 会话有效？`ensureSession()` 问过之后才有意义 */
export const authed = ref(false);
/** 登录身份：`{id, username, displayName, roleCode}`；没登录是 null */
export const user = ref(null);
/** `/api/admin/me` 的整份响应（能力表在里面）。null = 还没读到 */
export const me = ref(null);
/**
 * 能力表（`caps`）。`null` = 还没读到（后端不通）—— 与"读到了但都是 false"是两件事：
 * 前者界面不许禁用任何按钮，后者该灰的灰掉并写明原因。三个界面共用这一个定义。
 */
export const caps = computed(() => (me.value && me.value.caps ? me.value.caps : null));
/** 问不到会话时的原因（后端不通这类）—— 登录页要把它说出来 */
export const authTrouble = ref('');

let asked = false;

export async function loadMe() {
  try {
    me.value = await api.adminMe();
  } catch (e) {
    me.value = null;
    authTrouble.value = e && e.message ? e.message : '未知原因';
  }
  return me.value;
}

export async function ensureSession() {
  if (asked) return authed.value;
  asked = true;
  authTrouble.value = '';
  try {
    const r = await api.authMe();
    authed.value = !!(r && r.authenticated);
    user.value = (r && r.user) || null;
  } catch (e) {
    // 问不到 ≠ 没登录，但界面上只能按"没登录"处理 —— 原因要留在 authTrouble 里说出来
    authed.value = false;
    user.value = null;
    authTrouble.value = (e && e.reason ? e.reason + '：' : '') + (e && e.message ? e.message : '未知原因');
  }
  if (authed.value) await loadMe();
  return authed.value;
}

/** 登录成功之后接上身份（不再多问一次 `/api/auth/me`：登录响应里就是答案） */
export async function signedIn(u) {
  authed.value = true;
  user.value = u || null;
  asked = true;
  authTrouble.value = '';
  await loadMe();
}

/**
 * 退出登录。**服务端没回应也要把本机状态清掉**，但把原因**返回给调用方** ——
 * 界面要说清"本机已退出、服务端会话可能还在"，不能装作一切都好。
 */
export async function signOut() {
  let trouble = '';
  try {
    await api.logout();
  } catch (e) {
    trouble = (e && e.reason ? e.reason + '：' : '') + (e && e.message ? e.message : '未知原因');
  }
  authed.value = false;
  user.value = null;
  me.value = null;
  asked = true;
  return trouble;
}

/**
 * 会话没了（任意请求回了 401）：清缓存，下次导航重新问。
 *
 * 返回值说明**刚才是不是已经登录过**（清之前看一眼）—— `api.js` 据此决定要不要在
 * 登录页地址上带 `reason=expired`：登录过的人是被请出去的，与从没登录过的人说不同的话。
 */
export function sessionLost() {
  const known = !!me.value || !!user.value || authed.value;
  authed.value = false;
  user.value = null;
  me.value = null;
  asked = false;
  return known;
}

// 401 的处置只有一处（`api.js` 那两处 fetch 封装里），这里只是把它"忘了会话"这件事接上
setSessionLostHandler(sessionLost);
