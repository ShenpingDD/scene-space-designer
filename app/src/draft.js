/**
 * draft.js —— 未保存草稿：**只活在这台浏览器里**（纯函数 + 存储读写，判据在 `app/test/draft.test.js`）
 *
 * ## 为什么草稿不落后端
 * 用户 2026-10-16 拍板：新建的改动在保存之前只放本机。没保存的东西进库，
 * 库里就会长出"谁也没确认过"的方案；而"我昨天改了一半"这件事本来就只跟他这台机器有关。
 *
 * ## 键里必须带账号 id
 * 换了账号还能读到上一个人的草稿，是这一层最容易出的错，而且**界面上看不出来** ——
 * 用户只会觉得"系统自己把别人的方案打开了"。所以键是 `spatial.draft.v1.<userId>`，
 * 取不到 userId 时写入**直接拒绝**（不写到一个没名字的键上）。
 *
 * ## 介质是 localStorage
 * 关掉浏览器再回来它还要在。按模型缓存的缩略图那套用 `sessionStorage`（`thumbs.js`），
 * 两者寿命不同，不混用。
 *
 * ## 写入失败不做静默跳过
 * 隐私模式、配额满都会让写入抛出来。这里**不让它抛得无声无息**：异常原样往上走，
 * 界面写一句"本机缓存写不进去：<原因>"，用户当场就知道刷新之后草稿不会在。
 */

export const DRAFT_VERSION = 1;
export const DRAFT_PREFIX = 'spatial.draft.v1.';

/** 草稿键。userId 为空 → 空串（调用方据此拒绝读写） */
export function draftKey(userId) {
  const id = String(userId == null ? '' : userId).trim();
  return id ? DRAFT_PREFIX + id : '';
}

/**
 * 草稿 → 文本。
 *
 * 带上 `v`：将来草稿结构变了，旧文本必须能被**认出来并丢掉**，
 * 而不是被当成新版解析出半份内容塞进编辑器。
 */
export function encodeDraft(state, format, nowMs) {
  const at = Number.isFinite(nowMs) ? nowMs : Date.now();
  return JSON.stringify({ v: DRAFT_VERSION, savedAt: at, state, format: String(format == null ? '' : format) });
}

/**
 * 文本 → 草稿；读不出来一律回 `null`（**不抛异常、不返回半份草稿**）。
 *
 * 坏 JSON、缺字段、版本号不认识、state 不是对象 —— 四种都算读不出来。
 * 半份草稿比没有草稿更坏：编辑器会带着一份残缺的布局继续跑。
 */
export function decodeDraft(text) {
  if (typeof text !== 'string' || !text) return null;
  let obj = null;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (obj.v !== DRAFT_VERSION) return null;
  if (!Number.isFinite(Number(obj.savedAt))) return null;
  if (!obj.state || typeof obj.state !== 'object' || Array.isArray(obj.state)) return null;
  if (typeof obj.format !== 'string') return null;
  return { savedAt: Number(obj.savedAt), state: obj.state, format: obj.format };
}

/**
 * 存储读写。`storage` 由调用方给（生产代码给 `window.localStorage`），
 * 于是这一层能在 node 里判：`localStorage` 在 node 里不存在，而键名与编解码必须被逐条钉住。
 */
export function createDraftStore(storage, userId) {
  const key = draftKey(userId);
  return {
    key,
    read() {
      if (!key) return null;
      return decodeDraft(storage.getItem(key));
    },
    write(state, format, nowMs) {
      if (!key) throw new Error('没有账号 id，草稿不写（写下去会变成谁都能读到的键）');
      storage.setItem(key, encodeDraft(state, format, nowMs));
    },
    clear() {
      if (!key) return;
      storage.removeItem(key);
    },
  };
}

/**
 * 恢复草稿：**先过内核校验再写进编辑器**。
 *
 * `apply(state, format)` 是真正的加载路径（生产代码传 `designer.applyServerState`，
 * 它内部走 `scheme.importScheme`）。校验不过就**当场把这份草稿丢掉**：
 * 留着它只会每次打开都失败一次，而且失败得无声无息。
 *
 * `reset()` 是「回到默认那一间房」（生产代码传 `designer.resetNewDesign`）。当前账号**没有**
 * 可用草稿时必须调它：退出登录与换账号登录都是同一篇文档里的客户端跳转，内存里那份布局
 * 不会自己回到默认，于是新账号会看到上一个账号没保存的那一间房。两个函数都必给 ——
 * 少给一个就当场抛出，免得「回默认」这一支被忘掉。
 */
export function restoreDraft(store, apply, reset) {
  if (typeof apply !== 'function' || typeof reset !== 'function') {
    throw new Error('restoreDraft 要 apply 与 reset 两个函数：少了 reset，没有草稿时工作区就会留着上一个人的内容');
  }
  const draft = store.read();
  if (!draft) {
    reset();
    return { restored: false, reason: 'empty' };
  }
  const ok = apply(draft.state, draft.format);
  if (!ok) {
    store.clear();
    reset();
    return { restored: false, reason: 'rejected' };
  }
  return { restored: true, draft };
}

/* ---------------- 当前这一份草稿（装配时接上，写库那几个动作要清它） ---------------- */

let active = null;

/**
 * 本机时间戳 → 「月-日 时:分」（**本机时区**）。
 *
 * 不能拿 `new Date(ms).toISOString()` 再切字符串：那是 UTC，东八区会差八小时，
 * 用户看到的「上次未保存的时间」会与他自己刚才的操作对不上。
 */
export function draftTimeText(ms) {
  // 空值要**先挡掉**：`Number(null)` 是 0，`new Date(0)` 会显示成 1970-01-01 08:00 这种数
  if (ms === null || ms === undefined || ms === '') return '';
  const d = new Date(Number(ms));
  if (!Number.isFinite(d.getTime())) return '';
  const two = (n) => String(n).padStart(2, '0');
  return two(d.getMonth() + 1) + '-' + two(d.getDate()) + ' ' + two(d.getHours()) + ':' + two(d.getMinutes());
}

export function activateDraft(store) {
  active = store || null;
}

export function activeDraft() {
  return active;
}

/** 清掉当前草稿。保存成功、以及用户点「放弃草稿」时调用 */
export function dropActiveDraft() {
  if (active) active.clear();
}
