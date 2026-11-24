/**
 * admin/params.js —— 参数配置页的**纯计算**（R6-4 B4b）
 *
 * 单独抽出来的理由与 `admin/schemes.js` / `admin/view.js` 一样：这一页最值钱的判断是
 * **"到底改了哪几项"**与**"为什么这一项改不了"**。前者算错 = 发布出去的东西与用户以为的不一样；
 * 后者算错 = 用户对着一个灰色输入框猜。两种错在界面上都看不出来，所以必须是纯函数、必须被钉住。
 *
 * ⚠️ 这一层**不认识 HTTP，也不认识 Vue**：它只做"规格 + 当前值 + 草稿 → 该显示什么 / 该发什么"。
 *   发出去之后成不成立，**后端才是裁判**（界面自检只是省一次往返，见 `draftProblems`）。
 */

/** 数字相等（草稿是输入框来的**字符串**，当前值是数字 —— 直接 `!==` 会把 `90` 与 `'90'` 判成"改过"） */
function sameNumber(a, b) {
  if (a === '' || a == null || b == null) return a === b;
  const x = Number(a);
  const y = Number(b);
  if (Number.isFinite(x) && Number.isFinite(y)) return x === y;
  return String(a) === String(b);
}

/** 把接口给的**分组嵌套** values 摊平成 `path → 值`（规格里给的是 path） */
export function flatValues(values) {
  const out = {};
  for (const [g, items] of Object.entries(values || {})) {
    if (!items || typeof items !== 'object') continue;
    for (const [k, v] of Object.entries(items)) out[g + '.' + k] = v;
  }
  return out;
}

/**
 * 规格 + 当前值 → **表单行**（顺序照规格，一行一项）。
 *
 * 每行带全了用户做决定要用的东西：名字、单位、当前值、出厂值、允许范围、说明，
 * 以及**能不能改**（`editable` + 不能改时的原话 `lockedNote`）。
 */
export function formRows(schema, values) {
  const flat = flatValues(values);
  const list = (schema && Array.isArray(schema.flat)) ? schema.flat : [];
  // ⚠️ 这里**没有** `key` 字段（曾经有过 `key: e.key`，但导出器 `tools/export-params.mjs`
  //    的结果里根本没有 `key`，于是它恒为 undefined，全仓也没有一个读取方 —— 死字段删掉）。
  //    要认一项，用 `path`：它才是真源里的键名（`params.js` 的 PARAM_SPEC）。
  return list.map((e) => ({
    path: e.path,
    label: e.label,
    unit: e.unit || '',
    min: e.min,
    max: e.max,
    step: e.step,
    admin: e.admin !== false,
    help: e.help || '',
    now: flat[e.path],
    def: e.default,
    editable: e.admin !== false,
    // 不能改的行**必须把原因写出来**（就是规格里那句话），不许只给个灰框
    lockedNote: e.admin === false ? ('不允许在后台改：' + (e.help || '')) : '',
  }));
}

/** 范围的说法（照规格里的数字拼，**界面不写死**）：`0~180 ° · 步长 1` */
export function rangeText(row) {
  if (!row) return '';
  const parts = [];
  if (row.min != null && row.max != null) parts.push(row.min + '~' + row.max);
  if (row.unit) parts.push(row.unit);
  if (row.step) parts.push('步长 ' + row.step);
  return parts.join(' ');
}

/** 按规格的 groups 分栏（**顺序与说明都照规格**，界面不自己编分栏） */
export function groupRows(schema, rows) {
  const byPath = new Map((rows || []).map((r) => [r.path, r]));
  const groups = (schema && Array.isArray(schema.groups)) ? schema.groups : [];
  return groups.map((g) => ({
    id: g.id,
    label: g.label,
    help: g.help || '',
    rows: (g.params || []).map((p) => byPath.get(p.path)).filter(Boolean),
  }));
}

/**
 * 这一行改了吗（草稿 vs 当前值）。`drafts` 里没有这个 path 就是没动过。
 *
 * ⚠️⚠️ **这里绝不能用 `Object.prototype.hasOwnProperty.call(drafts, path)` 来判断"在不在"。**
 *
 * 传进来的 `drafts` 在真实页面里是 Vue 的 **响应式代理**，而 Vue 3 的代理**只实现了
 * `get` / `set` / `deleteProperty` / `has` / `ownKeys`** —— 它**没有实现
 * `getOwnPropertyDescriptor`**。`hasOwnProperty` 走的正是那个没实现的陷阱，
 * 于是这次判断**不会被追踪**：用户改了输入框，`drafts` 确实写进去了，
 * 但依赖它的 `computed`（"改了 N 项"、发布按钮的可用状态）**永远不重算**。
 *
 * 症状很有迷惑性：界面不报错、输入框里的字也变了，**只是"改了 0 项"、发布按钮永远点不动**
 * —— 也就是说**这一页对真人完全不可用**。而 `admin-params.test.js` 用普通对象跑，
 * 一路全绿（普通对象上 `hasOwnProperty` 行为完全正常）。
 *
 * 所以改成**读值**：`drafts[path]` 走的是 `get` 陷阱 → 被追踪 → 写进去就会重算。
 * 草稿里的值永远是字符串，所以 `undefined` 就等于"没进过草稿表"。
 *
 * （这条是 R6-4 B4b 的探针逐层挖出来的：`draftsAfterEvent = {door.openOkDeg: '86'}` 写进去了，
 *   而 `countAfterEvent` 还是"改了 0 项"。见 `docs/38`。）
 */
export function isDirty(row, drafts) {
  if (!row || !drafts) return false;
  const now = drafts[row.path];          // ← get：会被追踪（不要换成 hasOwnProperty）
  if (now === undefined) return false;   // 没进草稿表 = 没动过
  return !sameNumber(now, row.now);
}

/** 改了哪几项（给"改了 N 项"与"发布哪些"用；顺序照表单） */
export function dirtyRows(rows, drafts) {
  return (rows || []).filter((r) => isDirty(r, drafts));
}

/**
 * 草稿 → **发布用的补丁**（只含改过、且允许改的项）。
 *
 * 两项纪律：
 *  ① **只发改过的**：整份提交等于"我没动过的项也由我确认了一遍"，
 *     而且别人刚改的值会被我的旧值盖回去（这正是"只写真的变了的项"要防的）。
 *  ② `admin:false` 的项**一个都不进去**：界面已经把它禁用了，但"界面禁了"不是保证 ——
 *     后端也会拒（两道），这里少发一道是减少一次必然失败的往返，不是替代后端那一道。
 */
export function draftPatch(rows, drafts) {
  const changed = {};
  const paths = [];
  for (const r of dirtyRows(rows, drafts)) {
    if (!r.editable) continue;
    const g = r.path.slice(0, r.path.indexOf('.'));
    const k = r.path.slice(r.path.indexOf('.') + 1);
    if (!changed[g]) changed[g] = {};
    const raw = drafts[r.path];
    const n = Number(raw);
    changed[g][k] = Number.isFinite(n) && String(raw).trim() !== '' ? n : raw;
    paths.push(r.path);
  }
  return { patch: changed, changed: paths };
}

/**
 * 发布前自检 —— **与后端同一套判据的本地版**，只为了不让用户白等一次往返。
 *
 * ⚠️ 它**不是裁判**：判的是"数字/范围"这类一眼能看的，界面上必须写明"最终以后端为准"。
 *    真正的裁判是 `PUT /api/params`（它还会判跨字段、以及规格里没写进前端的规则）。
 *    自检说"没问题"而发布失败，是正常的；反过来（自检拦住了后端本来会收的）不该发生 ——
 *    所以这里的判据必须从规格里的数字来，不写死。
 */
export function draftProblems(rows, drafts) {
  const out = [];
  for (const r of dirtyRows(rows, drafts)) {
    const raw = drafts[r.path];
    if (!r.editable) {
      out.push({ path: r.path, message: r.lockedNote });
      continue;
    }
    const n = Number(raw);
    if (String(raw).trim() === '' || !Number.isFinite(n)) {
      out.push({ path: r.path, message: r.label + '必须是数字（现在填的是「' + String(raw) + '」）' });
      continue;
    }
    if (r.min != null && n < r.min) {
      out.push({ path: r.path, message: r.label + '超出范围：' + n + ' 小于下限 ' + r.min + (r.unit || '') });
      continue;
    }
    if (r.max != null && n > r.max) {
      out.push({ path: r.path, message: r.label + '超出范围：' + n + ' 大于上限 ' + r.max + (r.unit || '') });
    }
  }
  return out;
}

/** 发布成功的回执（**要说清改了哪几项、新版本是多少** —— 只说"发布成功"等于没说） */
export function publishDoneText(res) {
  const changed = Array.isArray(res && res.changed) ? res.changed : [];
  if (!changed.length) return (res && res.message) || '没有任何改动（一项都没写）';
  return '已发布 ' + changed.length + ' 项：' + changed.join('、')
    + ' ｜ 新参数版本 ' + (res && res.rev) + '（前台会在几秒内自动跟上）';
}

/** 失败时逐条读出来（后端给的就是这些话，界面不许换成"参数不合法"四个字） */
export function problemLines(res) {
  const errs = Array.isArray(res && res.errors) ? res.errors : [];
  if (errs.length) return errs.map((e) => ({ path: e.path || '', message: e.message || String(e) }));
  return [{ path: '', message: (res && (res.message || res.reason)) || '发布失败（原因不明）' }];
}
