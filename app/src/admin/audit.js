/**
 * admin/audit.js —— 参数审计页的**纯计算**（R6-4 B4c）
 *
 * 单独抽出来的理由与 `admin/schemes.js` / `admin/params.js` / `admin/view.js` 一样：
 * 这一页最值钱的判断是「**现在显示的是哪几条、被筛掉了多少、这一条到底改了什么**」，
 * 而这三件事算错了在界面上都看不出来（看起来都是一张正常的表）。
 *
 * ⚠️ 这一层**不认识 HTTP，也不认识 Vue**：它只做"接口给的行 → 该显示成什么"。
 *   所以每一条都能在没有浏览器的地方断言（`app/test/admin-audit.test.js`）。
 *
 * ⚠️ 三条界面纪律（与方案库、参数页同款）：
 *   ① **条件句常驻**：`filterLine()` 无论筛没筛都要给出一句完整的"现在看的是什么"。
 *      只写"共 22 条"、不写"已筛掉 20 条"，就是静默筛选；
 *   ② **缺数据不补**：没写原因就写「（没写原因）」，认不出的人就显示原始 id，
 *      没有快照就说没有 —— 审计里编一个更漂亮的值是最坏的结果；
 *   ③ **空态要说清是哪一种空**：真的没有改动 vs 被条件筛没了（要告诉用户去掉条件还有多少）。
 */

/** 规格 → `path → {label, unit}`（规格里给的是 `schema.flat`，与参数页同一份） */
export function schemaIndex(schema) {
  const out = {};
  const list = (schema && Array.isArray(schema.flat)) ? schema.flat : [];
  for (const e of list) {
    if (!e || !e.path) continue;
    out[e.path] = { label: e.label || e.path, unit: e.unit || '' };
  }
  return out;
}

/** 项的中文名 + 路径。**认不出就原样给路径**（库里可能有早已从规格里删掉的项，别编名字） */
export function keyLabel(key, index) {
  const hit = index && index[key];
  return hit ? hit.label + '（' + key + '）' : String(key);
}

/** 单位（认不出就没有 —— 不猜） */
export function unitOf(key, index) {
  const hit = index && index[key];
  return hit ? hit.unit : '';
}

/** `2026-09-29T22:05:39` → `2026-09-29 22:05:39`；没有时间就说没有 */
export function timeText(iso) {
  const s = String(iso == null ? '' : iso).trim();
  if (!s) return '（没有时间）';
  return s.replace('T', ' ').slice(0, 19);
}

/** 谁改的：有名字就给名字（带 id），没名字就给原始 id —— **不编名字** */
export function byText(row) {
  const id = row && row.changedBy ? String(row.changedBy) : '';
  const name = row && row.changedByName ? String(row.changedByName).trim() : '';
  if (!id && !name) return '（没记是谁）';
  if (!id) return name;
  return name ? name + '（#' + id + '）' : '#' + id;
}

/** 一个值怎么显示（`null` = 当时**没有这一项**，与"值是 0"是两件事） */
export function valueText(v) {
  if (v === null || v === undefined) return '（原来没有这一项）';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** 前后值一句话（带单位；原来是新增的就不画箭头） */
export function changeText(row, unit) {
  const u = unit || '';
  const isNew = !row || row.oldValue === null || row.oldValue === undefined;
  const to = valueText(row && row.newValue) + u;
  if (isNew) return '新增：' + to;
  return valueText(row.oldValue) + u + ' → ' + to;
}

/**
 * 原因。**没写就写「（没写原因）」**。
 *
 * 2026-09-29 用户拍板取消了"发布必须写为什么"的摩擦（PROGRESS A19）——
 * 于是"有的行有原因、有的行没有"变成常态。**这不是缺陷，但也不许留白**：
 * 空的格子会让人以为界面出错了，写清楚才是实话（也顺便提醒下一个人：写一句更省事）。
 */
export function noteText(row) {
  const s = row && row.note ? String(row.note).trim() : '';
  return s || '（没写原因）';
}

/** 筛选条件拆成几段（顺序固定：项 → 时间 → 人） */
export function condParts(cond, index) {
  const c = cond || {};
  const out = [];
  if (c.key) out.push('项：' + keyLabel(c.key, index));
  if (c.from) out.push('从 ' + c.from);
  if (c.to) out.push('到 ' + c.to + (c.to.length === 10 ? '（含当天）' : ''));
  if (c.by) out.push('人：' + (c.byName ? c.byName + '（#' + c.by + '）' : '#' + c.by));
  return out;
}

export function isFiltered(cond) {
  return condParts(cond).length > 0;
}

/**
 * **常驻**的那句计数（没筛也要在）。
 * 少了它，用户看到 20 行就会以为"一共就 20 条"。
 */
export function filterLine(cond, shown, total, index) {
  const parts = condParts(cond, index);
  const tail = parts.length ? '（条件：' + parts.join(' · ') + '）' : '（没有筛选条件）';
  return '显示 ' + shown + ' / 共 ' + total + ' 条' + tail;
}

/**
 * 空态。**必须说清是哪一种空**：
 *   ① 库本来就空（参数从来没被改过）；
 *   ② 被条件筛没了 —— 这时要告诉用户"去掉条件能看到多少"。
 * `allTotal` 拿不到时就直说"去掉条件再看"，**不拿 0 冒充**。
 */
export function emptyText(cond, allTotal) {
  const parts = condParts(cond);
  if (!parts.length) return '库里一条留痕都没有 —— 这套参数从来没被改过。';
  const tail = (allTotal == null || allTotal === '')
    ? '去掉条件，看看一共有多少条。'
    : '去掉条件能看到 ' + allTotal + ' 条。';
  return '没有符合这些条件的留痕（' + parts.join(' · ') + '）。' + tail;
}

/** 分页那一行：`第 1–22 条 / 共 22 条 · 第 1 / 1 页`（一页装得下就不提页数） */
export function pageText(offset, limit, total) {
  const t = Number(total) || 0;
  if (!t) return '没有留痕';
  const from = Math.min(Number(offset) || 0, t - 1) + 1;
  const to = Math.min(from + (Number(limit) || 0) - 1, t);
  const pages = Math.max(1, Math.ceil(t / (Number(limit) || 1)));
  const page = Math.floor((Number(offset) || 0) / (Number(limit) || 1)) + 1;
  const head = '第 ' + from + '–' + to + ' 条 / 共 ' + t + ' 条';
  return pages > 1 ? head + ' · 第 ' + page + ' / ' + pages + ' 页' : head;
}

/**
 * 全量快照 → 一列可看的行（详情面板）。
 *
 * 顺带做一次**诚实性检查**：留痕说"这一项改成了 X"，而快照里这一项是 Y → 标记 `mismatch`。
 * 正常永远不该出现（同一次发布写的是同一份值）；一旦出现，说明有代码把两处写岔了，
 * 而这种岔只有"把两份放一起看"才能发现 —— 界面能看见，就顺手标出来。
 */
export function snapshotRows(snapshot, schema, row) {
  const index = schemaIndex(schema);
  const key = row && row.key ? String(row.key) : '';
  const out = [];
  for (const p of Object.keys(snapshot || {}).sort()) {
    const v = snapshot[p];
    const isChanged = p === key;
    const same = isChanged && String(v) === String(row.newValue);
    out.push({
      path: p,
      label: keyLabel(p, index),
      unit: unitOf(p, index),
      value: valueText(v) + unitOf(p, index),
      changed: isChanged,
      mismatch: isChanged && !same,
      expected: isChanged && !same ? valueText(row.newValue) + unitOf(p, index) : '',
    });
  }
  return out;
}