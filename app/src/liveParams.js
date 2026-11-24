/**
 * liveParams.js —— 启动时把**服务端发布的**规则参数装进内核（R6-4 B4a）
 *
 * ## 为什么必须有这一步
 *
 * 后台改了参数、服务端也读到了、接口也发出来了 —— 但只要前端不 `configure()` 进去，
 * 现场看到的判定还是**代码里的默认值**。那样的"参数可配置"是假的：
 * 界面上改得动、存得下、查得到，就是**不生效** —— 本项目最不能忍的那类功能
 * （"看起来能配，其实没生效"）。所以生效链路的最后一环在这里落地：
 *
 * ```
 * app_config → ParamsSource → GET /api/params → **configure()** → 内核真的按它算
 * ```
 *
 * ## 三条口径
 *
 * 1. **不 await**（照目录那套）：界面先出来，参数到了一秒内自己换。后端没起也不能白屏。
 * 2. **拿到之后还是走内核自己的 `configure()`**（不是直接改 `cfg`）。服务端已经校过一遍，
 *    这里再校一遍不是重复：`configure()` 是"**进口**"，两边口径万一不同那天，
 *    这是最后一道能挡住"内核拿着一份没校验的值在算规则"的地方。
 * 3. **失败就说清楚，并且明确"现在按默认值算"** —— 静默退回默认值会让人以为参数生效了。
 */
import * as kernel from './kernel.js';
import { api } from './api.js';
import { liveLine } from './paramsText.js';

/** 轮询间隔。5 秒是「人改完看一眼」的尺度：再密是白问，再疏会让人觉得「改了没反应」 */
export const WATCH_MS = 5000;

/** 当前生效的那一份从哪来（界面要能说出来） */
export const state = {
  source: 'default',   // 'server' | 'default'
  rev: null,           // 服务端给的参数版本（= 指纹）；没取到就是 null，**不拿本地的冒充**
  error: null,
  count: 0,
  ignored: [],         // 服务端明确告诉我们的「库里有、但没被采用」的值
  appliedAt: null,
  // ── 自动跟新（2026-09-29 拍板要做）────────────────────────────────────
  watching: false,     // 有没有在盯
  autoUpdates: 0,      // 这一趟会话里自动跟上了几次
  lastAuto: null,      // 最近一次自动跟新的回执（界面拿它说「参数已更新」）
};

let lastFetch = null;

export async function loadParams(fetchParams) {
  if (fetchParams) lastFetch = fetchParams;
  try {
    const res = await fetchParams();
    const values = res?.values ?? {};
    if (!values || typeof values !== 'object' || !Object.keys(values).length) {
      const e = new Error('服务端参数是空的');
      e.reason = 'params-empty';
      throw e;
    }
    // `allowNonAdmin`：**装服务端发布的整份生效值**，不是后台表单提交 ——
    // 那份里含 6 项 `admin:false`（它们本来就该生效，只是不许在后台改）。
    // 「不许改」那道门在**发布接口**上（PUT /api/params 会拒），不在这里。
    // 不传这个选项的后果实测过：整份被拒 → 内核退回默认值 → 15° 一档照旧按 5° 转。
    kernel.params.configure(values, { allowNonAdmin: true });
    state.source = 'server';
    state.rev = res.rev ?? null;
    state.count = Object.values(values)
      .reduce((n, g) => n + (g && typeof g === 'object' ? Object.keys(g).length : 0), 0);
    state.ignored = Array.isArray(res.ignored) ? res.ignored : [];
    state.error = null;
    state.appliedAt = new Date().toISOString();
    return { ok: true, rev: state.rev, origin: res.origin, ignored: state.ignored };
  } catch (e) {
    // 失败不许静默：**状态留在 default**，并把原因与"内核里现在是哪一版"一起报出来
    state.source = 'default';
    state.rev = null;
    state.error = e?.reason ?? e?.message ?? 'unknown';
    state.appliedAt = new Date().toISOString();
    return { ok: false, reason: state.error, faults: e?.errors ?? null, localRev: paramsRev() };
  }
}

/** 重试（后端刚起来 / 刚修好，别逼用户刷页面）—— 照目录那套复用上一次的取数方式 */
export async function reloadParams() {
  if (!lastFetch) return { ok: false, reason: 'no-fetcher' };
  return loadParams(lastFetch);
}

// ── 订阅：参数**自动**换了要有人说话 ─────────────────────────────────────
//
// 为什么必须有这一步：参数自动换 ≠ 只把值换掉。判定标准中途变了，现场看到的结论就跟着变，
// 而用户不知道自己脚下发生了什么 —— 那正是「界面必须说真话」要防的事。
// 所以每换一次都要能广播出去（界面负责说：**参数已更新，结论按新参数**）。
const watchers = new Set();

/** 订阅参数变更。**返回退订函数** —— 组件卸载时不退订，热更新下会一层层叠上去 */
export function onParamsChange(fn) {
  watchers.add(fn);
  return () => watchers.delete(fn);
}

function tell(event) {
  for (const fn of watchers) {
    try { fn(event); } catch (e) { console.warn('[params] 订阅者报错（不影响参数本身）', e); }
  }
}

let timer = null;

/**
 * 开始盯服务端的版本：**先问版本、变了才取内容**。
 *
 * - 问到同一个版本 → 什么都不做（绝大多数轮询走这条）；
 * - 版本变了 → 复用启动时那条路（`loadParams`）取回并 `configure()`，然后广播；
 * - 取回来装不上（值不合法 / 后端抽风）→ **不换**，但广播一条失败（界面要能说「后台改的那一版没装上」）；
 * - 轮询本身失败（后端重启中）→ 记在 `state.error`，**不刷屏、不打扰**，下一次还会问。
 */
export function startWatch(fetchRev) {
  stopWatch();
  state.watching = true;
  timer = setInterval(async () => {
    try {
      const r = await (fetchRev || api.paramsRev)();
      const rev = r && r.rev;
      if (rev == null || rev === state.rev) return;
      const got = await loadParams(api.params);
      state.autoUpdates += 1;
      state.lastAuto = { ok: got.ok, rev: state.rev, reason: got.reason || null, at: new Date().toISOString() };
      tell(got.ok
        ? { kind: 'updated', rev: state.rev, origin: state.origin }
        : { kind: 'failed', reason: got.reason || 'unknown' });
    } catch (e) {
      state.error = (e && (e.reason || e.message)) || 'unknown';
    }
  }, WATCH_MS);
  return () => stopWatch();
}

export function stopWatch() {
  if (timer) clearInterval(timer);
  timer = null;
  state.watching = false;
}

/**
 * 内核**此刻**按哪一版参数在算（本地算的指纹）。
 * 它与服务端 `state.rev` 不一致时，说明中间出了岔子 —— 这正是要能说得出来的那一件事。
 */
export function paramsRev() {
  return kernel.params.fingerprint();
}

/**
 * 一页话把状态说全（界面要显示的就是这个，别让各处自己拼）。
 * **整句的写法在 `paramsText.js`** —— 设计器、维护端、自动跟新提示用的是同一句。
 */
export function paramsLine() {
  return liveLine(state, state.source === 'server' ? state.rev : paramsRev());
}