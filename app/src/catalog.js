/**
 * catalog.js —— 运行时型号目录：**服务端是唯一来源，本地资产只做离线兜底**
 *
 * 过去目录是构建期从 JSON 生成的 JS 资产（`data/catalog.js`），于是"维护端改了库、界面不知道"。
 * 现在启动时向 `GET /api/catalog` 要一份；拿不到（后端没起、或跑在 `--no-db`）就退回本地资产，
 * 并且**在界面上写明当前用的是哪一份** —— 静默回退等于让用户拿旧目录做决策。
 *
 * 为什么这个文件**不依赖 vue**：纯状态 + 订阅，于是 node 里能直接断言适配层
 * （`app/test/catalog.test.js`）。响应性交给 `designer.js`（订阅后写进 ref）——
 * 数据翻译和框架绑定不该混在一起。
 *
 * 一条纪律：**查找函数只有这一份**。本地资产与服务端目录进来时都先被"补齐成同一种形状"
 * （尤其 `doors`），所以 `getProduct` 不需要分叉 —— 分叉就会重演原型那个"写入端与读取端
 * 各有一套限制"的老路。
 */
import { CATALOG as STATIC_ROWS } from './data/catalog.js';
import { DOORS_MEASURED } from './data/doors.measured.js';

const state = {
  rows: [],
  source: 'static',   // 'static' | 'server'
  error: null,
  loading: false,
  loadedAt: null,
  // 自动重读的读数（界面/探针要能问出"刚才那次重读为什么没动"）：
  lastTryAt: 0,       // 上一次**尝试**取数的时间戳（节流按它算，不看成功与否）
  attempts: 0,        // 尝试次数（含被节流挡下的？不 —— 只有真的发了请求才 +1）
  skipped: 0,         // 被节流/正在加载挡下的次数
  updates: 0,         // 真的换了目录的次数（内容一致不算）
  lastChange: null,   // { added: [...], removed: [...], at }
};

let byId = new Map();
const subs = new Set();

function adopt(rows, source) {
  const before = new Set(state.rows.map((p) => p.id));
  const after = new Set(rows.map((p) => p.id));
  state.rows = rows;
  state.source = source;
  byId = new Map(rows.map((p) => [p.id, p]));
  // 变化的**身份**记下来，供界面说"新增了哪几款"（只说数量等于让人自己去猜是哪款）
  const first = before.size === 0;
  const added = first ? [] : rows.map((p) => p.id).filter((id) => !before.has(id));
  const removed = first ? [] : [...before].filter((id) => !after.has(id));
  if (!first) state.lastChange = { added, removed, at: new Date().toISOString() };
  for (const fn of subs) fn(state);
}

// 初始 = 本地资产（服务端目录到了会被整体替换）。这里就把 doors 补齐，两条路形状一致。
const STATIC_ADAPTED = STATIC_ROWS.map((p) => ({
  ...p,
  doors: DOORS_MEASURED[p.id]?.doors ?? p.doors ?? [],
}));
adopt(STATIC_ADAPTED, 'static');

export const catalogState = state;

/** 目录被替换时通知（`designer.js` 用它把变化写进 ref；返回取消订阅） */
export function onCatalogChange(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

export function getProduct(id) {
  const p = byId.get(id);
  return p ? { ...p, doors: p.doors ?? [] } : undefined;
}

export function productLabel(id) {
  return byId.get(id)?.name ?? id;
}

export function productModel(id) {
  return byId.get(id)?.model ?? '—';
}

/**
 * 尺寸可信度等级（`noteLevel`）：这是 `sizeNote` 的**展示分类**，不是主数据 ——
 * 主数据是那句文案本身，维护端改文案、等级跟着变。旧目录是手写的，所以这里必须与它逐款吻合
 * （`app/test/catalog.test.js` 拿本地资产当标准答案验过 4/4）。
 */
export function noteLevelOf(sizeNote) {
  return /非产品尺寸|演示比例/.test(sizeNote ?? '') ? 'bad' : 'warn';
}

/**
 * 门部件名（`doorPart`）的**兜底推导** —— 只在服务端那一列缺失时才用，而且它**会错**：
 *
 * 我原以为"绕 x 轴=上盖(top) / 两扇以上=双门(double) / 否则柜门(single)"能把这件事推出来，4 款里 3 款对上，
 * 唯独 demo-freezer-dual（双温双控低温保存箱）错 —— 它的**实测门只有 1 扇**（下门没进实测），
 * 而产品本身是"双门"。写测试时才发现（见 app/test/catalog.test.js）。
 *
 * 所以正确做法是**那一列**（V6 加的 `door_part`，种子从手写目录派生）。这段推导留着，
 * 只是为了让缺列时不至于把界面弄崩 —— 服务端发现缺列会打 WARN，不许安静。
 */
export function doorPartOf(doors) {
  // V8 起返回**代码**（与 product.door_part 同口径）；文案由内核 doorPartLabel 负责
  if (!doors?.length) return 'single';
  if (doors.every((d) => d.axis === 'x')) return 'top';
  return doors.length >= 2 ? 'double' : 'single';
}

/**
 * 服务端目录 → 界面既有形状。**这是唯一一处把数据库的列名翻译成界面字段的地方。**
 * 注意 `w/d/h` 直接来自服务端：它给的是**声明包络**（米），已经换算好 —— 界面不碰单位。
 */
export function adaptServerProduct(p) {
  const n = p.notes ?? {};
  return {
    id: p.id,
    dbId: p.dbId,
    name: p.name,
    model: p.model,
    w: p.w,
    d: p.d,
    h: p.h,
    color: p.color,
    origin: p.origin,
    sizeNote: p.sizeNote,
    noteLevel: noteLevelOf(p.sizeNote),
    desc: p.desc,
    sourceUrl: p.sourceUrl ?? null,
    recipeId: p.model ?? null,
    facts: n.facts ?? [],
    features: n.features ?? [],
    // 配方里"声明的"门（老写法叫 hinges）—— 与实测 doors 分开，不合并
    hinges: (p.recipeDoors ?? []).map((d) => ({ name: d.node, axis: d.axis, openAngle: d.openAngleRad })),
    // 列优先：列**缺失**（undefined）才退回推导（推导会错）；
    // 列显式为 null = 「这个型号没有门」（演示机 demo-ct-scanner），不许推成 single 编一个门出来
    doorPart: p.doorPart === undefined ? doorPartOf(p.doors) : p.doorPart,
    doors: p.doors ?? [],
    // 模型资产：库里的 file_path 本身就是 `assets/optimized/...`，vite 的 `/assets` 直接能取
    assetFile: p.file ?? null,
    modelMd5: p.modelMd5 ?? null,
    thumbUrl: p.thumbUrl ?? null,
    bboxMm: p.bboxMm ?? null,
    envelopeMode: p.envelopeMode ?? null,
    // 详情入口用（docs/105 §6.1）：判据**在服务端**，这里如实搬过来、不替它猜。
    // `false`（含"字段还没上线"= 不是 true）就是不给入口：宁可等后端重启，也不在前端造一个
    // 点进去必然空着的入口 —— 那种入口比没有更让人以为坏了。
    hasDetail: p.hasDetail === true,
    hotspotCount: p.hotspotCount ?? 0,
    contentRev: p.contentRev ?? 0,
    status: p.status ?? null,
    asset: { kind: 'db', note: p.origin },
  };
}

/**
 * 拉服务端目录。`fetchCatalog` 由调用方注入（`api.catalog`）—— 于是这里能在测试里
 * 用一个假函数把成功/失败两条路都走一遍，不需要真的起后端。
 */
/** 上一次的取数方式。记住它是为了让"重试"不需要界面知道接口长什么样 */
let lastFetch = null;

export async function loadCatalog(fetchCatalog) {
  if (fetchCatalog) lastFetch = fetchCatalog;
  // 转圈要有人关：成功与失败两条路都得关（漏一条就是「永远在转」）
  state.loading = true;
  try {
    const res = await fetchCatalog();
    const raw = res?.products ?? [];
    // 目录只收 active：维护端的**草稿**（未发布产品）不算"目录里的一款"，
    // 否则设计端会看到一款点不进去（甚至没有模型）的产品 —— 静默多显示和静默少显示一样坏。
    const active = raw.filter((p) => !p.status || p.status === 'active');
    const rows = active.map(adaptServerProduct).filter((p) => p.id && p.w > 0 && p.d > 0);
    if (!rows.length) {
      const e = new Error('服务端目录是空的');
      e.reason = 'catalog-empty';
      throw e;
    }
    adopt(rows, 'server');
    state.error = null;
    state.loading = false;
    state.loadedAt = new Date().toISOString();
    state.updates += 1;
    return {
      ok: true,
      count: rows.length,
      skipped: raw.length - rows.length,
      drafts: raw.length - active.length,
      added: state.lastChange?.added ?? [],
      removed: state.lastChange?.removed ?? [],
    };
  } catch (e) {
    state.loading = false;
    // 后端不可用 → **保留本地资产**（界面照常能用），但把原因留着，界面会写明用的是哪一份
    state.error = e?.reason ?? e?.message ?? 'unknown';
    // 退回本地资产 —— 不是只改个标签：如果这一轮之前已经用过服务端目录，
    // 那些行必须**整份换掉**，否则会出现"界面说本地资产、算的却是服务端那一份"（比不退回更糟）。
    if (state.source !== 'static') adopt(STATIC_ADAPTED, 'static');
    else state.source = 'static';
    return { ok: false, reason: state.error };
  }
}

/**
 * 重试取目录（后端刚起来 / 刚修好，**不该逼用户手动刷新页面**）。
 *
 * 复用上一次的取数方式：界面因此完全不需要知道接口长什么样，
 * 也就不会出现"重试走的是另一条路"这种只有在出错时才暴露的差异。
 */
export async function reloadCatalog() {
  if (!lastFetch) return { ok: false, reason: 'no-fetcher' };
  return loadCatalog(lastFetch);
}

/* ---------------- 自动重读（同页看见新产品）----------------
 *
 * 背景（task-75）：维护端在同一台机器上把一款产品从草稿改成**已上架**，设计端已经开着的页面
 * 却一直显示旧目录 —— 用户只能刷新整页，还会丢掉当前方案里没保存的改动。
 *
 * 所以这里有两条"同页重读"的触发，**都不打断正在做的事**：
 *   ① 页面重新获得焦点 / 标签页重新可见（用户从维护端切回来）；② 路由回到设计页。
 * 每次都要过一道节流（`REFRESH_THROTTLE_MS`）：切窗口很频繁，不节流等于持续打后端。
 *
 * 三条纪律：
 *   · **节流按"尝试"算**，不按成功算 —— 后端挂着的时候每次 focus 都重连一遍，会把控制台刷满、也真的更慢；
 *   · 正在加载时不叠加（返回 `busy`，界面可据此显示"正在取"而不是再发一次）；
 *   · 失败**保留**当前目录（含本地兜底那一份），只更新 `error` —— 拿不到新目录不等于目录变成空的。
 */
export const REFRESH_THROTTLE_MS = 5000;

/**
 * 前台多久问一次目录（与节流同量级：再密也没有意义，节流会把多出来的挡掉）。
 * 取值理由：P0 判据是"上架后 ≤5s 同页可见"，所以轮询周期本身就得是 5s 量级；
 * 节流保证即使 focus + poll 撞在一起也只发一次。
 */
export const CATALOG_POLL_MS = 5000;

/**
 * 重新读一次目录（带节流）。
 * @param {{ force?: boolean, reason?: string, now?: number }} [opts]
 *        `force` = 用户手动点「重试」（跳过节流）；`reason` 只用于读数/排错
 * @returns {Promise<{ok:boolean, skipped?:string, reason?:string, added?:string[], count?:number}>}
 */
export async function refreshCatalog(opts = {}) {
  // `fetch` 只给测试/探针用（生产调用不传）：让节流与"真的发请求了吗"能被分开断言
  if (typeof opts.fetch === 'function') lastFetch = opts.fetch;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  if (state.loading) return { ok: false, skipped: 'busy' };
  if (!opts.force && now - state.lastTryAt < REFRESH_THROTTLE_MS) {
    state.skipped += 1;
    return { ok: false, skipped: 'throttled', waitMs: REFRESH_THROTTLE_MS - (now - state.lastTryAt) };
  }
  if (!lastFetch) return { ok: false, reason: 'no-fetcher' };
  state.lastTryAt = now;
  state.attempts += 1;
  state.lastReason = opts.reason ?? 'manual';
  const r = await loadCatalog(lastFetch);
  return { ...r, reason: r.reason ?? opts.reason };
}

/**
 * 挂上"同页重读"的全部触发，返回取消函数。
 *
 * 两路互补，缺一不可（task-75 / P0 判据）：
 *   ① **前台定时**（默认 5s）：维护端上架之后，设计端**什么都不做**也该在几秒内看到新品 ——
 *      QA 就在同一页等着看，不会去点一下窗口再切回来；
 *   ② **回到页面时立刻问一次**（focus / visibilitychange）：切回来是用户最期待的时刻，
 *      不该还要等一个定时片。
 *
 * 两种都走 `refreshCatalog` 的同一道节流（≥5s，按"尝试"算），所以**不会叠加**成双倍请求；
 * 页面 `hidden` 时定时器**直接跳过**（后台标签页不烧网络/CPU，回来时由 ② 补一次）。
 * 故意不接受"传一个自己的 ref"之类的东西：这一层只认 `window` 与时间，才好单测。
 */
export function startCatalogAutoRefresh(win = typeof window === 'undefined' ? null : window, opts = {}) {
  if (!win || typeof win.addEventListener !== 'function') return () => {};
  const intervalMs = Number.isFinite(opts.intervalMs) ? opts.intervalMs : CATALOG_POLL_MS;
  const bump = (reason) => { refreshCatalog({ reason }); };
  const onFocus = () => bump('focus');
  const visible = () => (win.document?.visibilityState ?? 'visible') !== 'hidden';
  const onVisible = () => { if (visible()) bump('visible'); };

  /**
   * 定时片。**被节流挡下时补一次收尾重试**，这是"≤5s 看见新品"能成立的关键：
   * 挂载时路由那一次重读已经占住了节流窗口，紧接着的定时片会被挡下（拿到的 `waitMs` 只剩几百毫秒）；
   * 不补的话它要再等整整一个周期，最坏情况新品要 ~10s 才出现。
   */
  let pending = 0;
  let stopped = false;
  const poll = async () => {
    if (stopped || !visible()) return;
    const r = await refreshCatalog({ reason: 'poll' });
    if (stopped || r?.skipped !== 'throttled') return;
    const wait = Math.max(50, Number(r.waitMs) || 0) + 30;
    if (typeof win.setTimeout === 'function') {
      pending = win.setTimeout(() => { pending = 0; poll(); }, wait);
    }
  };
  const tick = () => { poll(); };

  win.addEventListener('focus', onFocus);
  win.addEventListener('visibilitychange', onVisible);
  const timer = typeof win.setInterval === 'function' ? win.setInterval(tick, intervalMs) : 0;

  return () => {
    stopped = true;
    win.removeEventListener('focus', onFocus);
    win.removeEventListener('visibilitychange', onVisible);
    if (timer && typeof win.clearInterval === 'function') win.clearInterval(timer);
    if (pending && typeof win.clearTimeout === 'function') win.clearTimeout(pending);
  };
}

/**
 * 这一款能不能开详情（入口要不要显示）。
 *
 * - 服务端行：`hasDetail === true` 才给入口（判据在服务端，docs/105 §6.1；**前端不兜底**，
 *   后端还没上线这个字段时宁可没有入口）。
 * - 本地资产行：没有这个字段（`undefined`），按同一条口径自算：有简介 或 有热点 → 有得看。
 * **不确定就当没有**：给人一个点进去必然空着的入口，比不给入口更让人以为坏了。
 */
export function canOpenDetail(p) {
  if (!p) return false;
  if (typeof p.hasDetail === 'boolean') return p.hasDetail;
  return !!(String(p.desc ?? '').trim() || (p.hotspotCount ?? 0) > 0);
}
