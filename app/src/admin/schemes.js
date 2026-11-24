/**
 * schemes.js —— 场景方案库的纯计算（R6-3 3c）
 *
 * 为什么单独抽文件（照 wizard.js / view.js 的既有做法）：
 *   这个列表要回答的全是「判断」，不是「排版」——
 *     · 这份方案放得下吗、门开得到底吗（角标）
 *     · 筛掉了什么、按什么条件筛的（**筛选不许静默**）
 *     · 「最近谁改的」这一列该显示什么（老数据没这一列，空就是空）
 *   判断散在组件的 computed 里只能「看起来对」；抽出来才钉得住。
 *
 * 三条来自 设计决策记录的硬规矩，构成这个文件的骨架：
 *   1. 筛选**不许静默** —— 必须能说出「显示 N / 共 M」以及按什么条件筛的
 *   2. 缺数据**不许补** —— 老的 5 条没有 cover_file / updated_by，就显示占位与「—」，
 *      不假渲染、不假人名（与 ProductCards.vue 同一态度）
 *   3. 状态词表**只有两档**（draft / delivered —— 拍板⑤不启用 submitted），
 *      但筛选选项**从数据里现算**：将来真出现第三个值，也不会被悄悄过滤掉
 *
 * ⚠️ 一件**实测才知道**的事（按直觉写必错）：`room_json.items` 里，设备型号存在字段
 *    **`p`**（产品配方码，如 `demo-ct-scanner`）里，而 `id` 是这一台的实例号（1/2/3）。
 *    拿 `id` 当型号数会数成「3 台 3 个型号」—— 每台都不一样，永远对不上。
 *    实测样本（scheme id=2）：{"p":"demo-ct-scanner","r":0,"x":0.7,"z":0.7,"id":1,"doorAmount":0}
 */

import { formatBytes } from './format.js';

/* ---------- 词表：代码是 ASCII，说法在 label map 里（本项目铁律） ---------- */

/** 状态码。本批**只启用两档** */
export const STATUS_DRAFT = 'draft';
export const STATUS_DELIVERED = 'delivered';

/**
 * 状态词表的**声明顺序**（筛选标签按这个顺序排）。
 * `submitted` 刻意不在里面 —— 没有任何入口能到达的状态等于假状态（拍板⑤）。
 */
export const STATUS_ORDER = [STATUS_DRAFT, STATUS_DELIVERED];

/** 状态码 → 界面说法 */
export const STATUS_LABEL = { draft: '草稿', delivered: '已交付' };

/** 排序维度（照 设计决策记录：最近更新 · 最近创建 · 规模） */
export const SORTS = { UPDATED: 'updated', CREATED: 'created', SCALE: 'scale' };
export const SORT_ORDER = [SORTS.UPDATED, SORTS.CREATED, SORTS.SCALE];
export const SORT_LABEL = {
  updated: '最近更新',
  created: '最近创建',
  scale: '规模（台数）',
};

/* ---------- 单值格式化：每个都只管把一件事说清楚 ---------- */

/** 数字 → 最多一位小数的短写法。8.0 → 「8」（不显示 8.0，也不丢 2.8） */
function num1(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  return String(Math.round(n * 10) / 10);
}

/**
 * 状态码 → 人话。**不认识就说「未知（xxx）」，不假装认识、也不悄悄丢掉**。
 * 空值显示「—」（老数据靠 DDL 默认值有值，但接口万一给空也不许编）。
 */
export function statusLabel(code) {
  const c = String(code == null ? '' : code).trim();
  if (!c) return '—';
  if (Object.prototype.hasOwnProperty.call(STATUS_LABEL, c)) return STATUS_LABEL[c];
  return '未知（' + c + '）';
}

/**
 * 「最近谁改的」这一列。
 *
 * ⚠️ 库里的值**是 id 不是人名**（`varchar(32)`，B3 起写 `String.valueOf(ownerId)`）。
 *    老数据是空串 —— **空就显示「—」，不补人名**；不认得的原样带 # 号显示，绝不猜。
 *    U1 起账号不止一个，所以不再有"id 是 1 就是本机用户"这种特判：
 *    1 只是普通账号之一，把它的名字编出来比留一个 #1 更坏。
 */
export function actorLabel(updatedBy) {
  const v = String(updatedBy == null ? '' : updatedBy).trim();
  if (!v) return '—';
  return '#' + v;
}

/**
 * 「这一份是谁的」。**优先用服务端给的名字**（它才知道账号表里写的是什么），
 * 服务端没给名字时退回 `#<id>` —— 不编名字、也不留白。
 * 两样都没有（老数据没有归属）时说「—」。
 */
export function ownerLabel(row) {
  const name = String((row && row.ownerName) || '').trim();
  if (name) return name;
  const id = String(row && row.ownerId != null ? row.ownerId : '').trim();
  return id ? '#' + id : '—';
}

/**
 * 房间尺寸 → 人话。**单位写进界面**（这是给人看的字符串，单位必须在里面）。
 * 列表接口给的是 `row.room`，**里面只有 `w`/`d`/`h`**（没有 walls/items，见 SchemeService.list）。
 * 缺数或不是数就说「—」—— 宁可少一条信息，不许编一个尺寸出来。
 */
export function sizeText(room) {
  const s = room && typeof room === 'object' ? room : {};
  const w = num1(s.w);
  const d = num1(s.d);
  const h = num1(s.h);
  if (!w || !d || !h) return '—';
  return w + ' × ' + d + ' × ' + h + ' m';
}

/**
 * 设备台数。
 * ⚠️ **列表里这个数是服务端算好给的**（`row.itemCount`）—— 这里**优先用它**，不当场再算一遍：
 *    同一个数有两个算法，迟早会不一样。
 *    接口没给（或给了非数）就回 `null`：界面显示「—」、排序时排最后，
 *    **不拿 0 冒充** —— 「0 台」和「不知道几台」是两件事。
 */
export function itemCountOf(row) {
  const v = row ? row.itemCount : undefined;
  // ⚠️ **别写成 `Number(row && row.itemCount)`** —— `Number(null)` 和 `Number('')` 都是 **0**，
  //    于是"接口没给这个数"会变成"这台数正好是 0"。我第一版就是这么写的，
  //    被单测第 9 条当场抓住：**我正要防的那件事，恰好藏在我用来防它的那一行里**。
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 房间数。
 *
 * ⚠️ 与台数同一条规矩：**这是服务端算好给的**（`row.roomCount`），界面不自己数 `state.rooms` ——
 *    列表不带 state，自己数就得为了一张卡片把几 MB 的方案取回来。
 *    接口没给就回 `null`（界面显示「房间 —」）：**不拿 0 冒充**，"0 个房间"与"不知道几个房间"不同。
 */
export function roomCountOf(row) {
  const v = row ? row.roomCount : undefined;
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 从 `state.items` 里数出型号码（去重，按首次出现顺序）。**型号在 `item.p` 里，不在 `item.id`** */
export function modelCodesFromItems(items) {
  if (!Array.isArray(items)) return [];
  const seen = [];
  for (const it of items) {
    const p = it && it.p != null ? String(it.p).trim() : '';
    if (p && seen.indexOf(p) < 0) seen.push(p);
  }
  return seen;
}

/**
 * 这份方案用到的型号码（去重）。
 *
 * ⚠️ **列表接口不给 items**（只给 `room` 的 w/d/h 与 `itemCount`）—— 所以列表那一份
 *    由服务端算好放在 `row.modelCodes` 里，这里**优先用它**；只有详情（给了完整 state）
 *    才客户端自己数。
 *
 * ⚠️ **两处算法必须一致**（Java 的 `SchemeService.modelCodes` 与本函数）：
 *    各有一份单测钉着同一批字面量，改了一边另一边会红。这是"同一个判断只该有一个出处"
 *    在有语言边界时的折中 —— 边界挡不住，就用测试挡。
 */
export function modelCodesOf(row) {
  const given = row && row.modelCodes;
  if (Array.isArray(given)) return given.map(String).filter(Boolean);
  const items = row && row.state ? row.state.items : null;
  if (Array.isArray(items)) return modelCodesFromItems(items);
  // ⚠️ **答不出来就回 null，不许回空数组** —— 空数组等于告诉界面「0 个型号」，
  //    而真话是「接口没给这个信息」。编一个 0 出来，比留白坏得多（界面会显示「0 型号」）。
  return null;
}

/**
 * 型号数。**未知回 null**（界面显示「—」），含义同 `itemCountOf`。
 * 列表接口目前**还没吐 modelCodes**（见 设计决策记录 §九 的落差），所以现阶段界面上
 * 这一项多半是「—」—— 那是实话，不是坏了。
 */
export function modelCountOf(row) {
  const codes = modelCodesOf(row);
  return codes === null ? null : codes.length;
}

/**
 * 标签。服务端**不解析** `tags`（设计决策记录 §三 的口径），所以这里要同时认两种形状：
 * 库里的 JSON 文本（接口现在就是原样发的字符串）、以及已经解析好的数组。
 * 坏 JSON 不抛错 —— 但也**不被当成标签**（标签只用来显示，不作为任何判据）。
 */
export function tagsOf(row) {
  const raw = row && row.tags;
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (typeof raw !== 'string') return [];
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return [];
  }
  return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : [];
}

/**
 * 时间 → 列表里那一列。
 * **与前台方案表同一条规则**（SchemePanel 的 fmtTime：掐到「月-日 时:分」）——
 * 同一个实体在两处显示成两个样子，用户会以为是两件事。
 */
export function timeText(iso) {
  const s = String(iso == null ? '' : iso).trim();
  if (!s) return '—';
  const t = s.replace('T', ' ');
  return t.length < 16 ? t : t.slice(5, 16);
}

/**
 * 封面的 URL（R6-3 3f）。
 *
 * ## 为什么非得拼一个 `?v=`
 *
 * 封面的文件名是**固定的**（一次方案一张图，新的覆盖旧的 —— 用户拍板 2026-09-29），
 * 所以 URL 本身**永远不会变**。浏览器据此会把旧图一直还给你，而我们**没有任何办法察觉** ——
 * 这正是本项目最怕的那类问题：不是"错了"，而是"错了但看不出来"。
 *
 * `coverChecksum` 就是答案，而且它本来就是为这件事建的
 * （`V9` 里那一列的注释原文：「改了封面必须变 → 前端缓存键」）。
 * 它变了才换 URL：图变了浏览器一定知道，没变就继续吃缓存。
 *
 * 服务端那边还有一层（`Cache-Control: no-cache` + `ETag` 用同一个指纹）——
 * **两层各自都能独立挡住这件事**，任何一层被绕过都不会让用户看到旧图。
 *
 * 没有封面 → 返回空串，调用方据此显示占位（**不假渲一张**）。
 */
export function coverUrl(row) {
  if (!hasCover(row)) return '';
  const id = row.id;
  // 指纹缺失（老数据、或库里那一列是空的）→ 不带 v：宁可多取一次，也不要**猜**一个键。
  // 猜错的表现是"封面永远是旧的"，而它不报错。
  const v = String(row.coverChecksum || '').trim();
  return v ? `/api/schemes/${id}/cover?v=${encodeURIComponent(v)}` : `/api/schemes/${id}/cover`;
}

/** 有没有封面。没有就显示占位（**不假渲染一张**，见 设计决策记录） */
export function hasCover(row) {
  return !!(row && String(row.coverFile == null ? '' : row.coverFile).trim());
}

/**
 * 封面那一格的话术（鼠标停上去看到的）。
 *
 * ⚠️ 措辞里**故意没有「这一版的封面」**：封面不跟版本走（用户拍板 2026-09-29）——
 *    回滚之后卡片上那张图仍然是最新一次截的图。说它是"当前版本的封面"就是一句假话，
 *    而**一句假话比一句"不知道"坏得多**。所以只说它是怎么来的：「最近一次保存时截的三维视角」。
 */
export function coverTitle(row) {
  if (!hasCover(row)) return '没有封面 —— 不假渲一张；下次在前台保存方案时会自动截一张（平面图里保存也会截，离屏渲的）';
  return '封面：' + row.coverFile + '（' + coverSizeText(row) + '）· 固定正面斜 45° 视角（与交付包第一张同机位）';
}

/** 封面大小的说法（复用 format.js 的 formatBytes，不再写第二份字节格式化） */
export function coverSizeText(row) {
  if (!hasCover(row)) return '—';
  return formatBytes(row.coverSize);
}

/* ---------- 角标：照搬前台已经跑着的那条判据，不另造一个 ---------- */

/**
 * 体检角标。
 *
 * ⚠️ **判据不是这里发明的** —— 前台方案表（SchemePanel.vue）早就在用它了。这里只是把
 *    同一句话抽成可测的纯函数（原来嵌在模板里，谁也钉不住）。**同一个判断只该有一个出处**；
 *    另造一个，两处会慢慢说不一样的话。
 *
 * 语义取自内核（Audit.java 头注释）：
 *   · `issues`  = 放不下的台数（越界 / 占地重叠 / 压内墙）
 *   · `trouble` = 门开不到**绿灯阈值**的台数（黄 + 红）—— 摆得下，但用起来别扭
 *   · 都为 0 只说「摆得合规」+「门都开得到底」，**不说这方案好**（那是评审的事）
 *
 * 90° 是接缝 A 拍板定的黄灯阈值。threshold 一旦要改，改的是内核参数表，
 * 不是这里 —— 这里只是把内核的结论翻译成人话。
 */
export function auditBadge(audit) {
  if (!audit || typeof audit !== 'object') {
    return { level: 'none', text: '—', why: '这份方案还没有体检结论' };
  }
  const issues = Number(audit.issues) || 0;
  const trouble = Number(audit.trouble) || 0;
  if (issues > 0) {
    return {
      level: 'bad',
      text: '放不下 ' + issues,
      why: issues + ' 台放不下（越界 / 占地重叠 / 压内墙）',
    };
  }
  if (trouble > 0) {
    return {
      level: 'warn',
      text: '门 ' + trouble,
      why: trouble + ' 台的门开不到 90° —— 摆得下，但用起来别扭',
    };
  }
  return { level: 'ok', text: 'ok', why: '摆得合规，且门都开得到底' };
}

/* ---------- 筛选：**不许静默** ---------- */

/** 这一行的状态码（统一成字符串，免得各处自己 trim） */
export function statusOf(row) {
  return String((row && row.status) == null ? '' : row.status).trim();
}

/**
 * 筛选标签的计数 —— **从数据里现算**，不是照词表硬列。
 *
 * 为什么现算：照词表硬列会得到一个「已交付 0」这样永远点不出东西的标签；
 * 而真正该被看见的是「库里出现了词表外的状态」。所以：
 *   · 词表里的档位按声明顺序排（**含 0 的档也留着** —— 它说的是"现在这类没有"，是真话）
 *   · **词表外的码一律追加在后面**，标成「未知（xxx）」—— 不许被悄悄过滤掉
 */
export function statusCounts(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const seen = new Map();
  for (const r of list) {
    const c = statusOf(r);
    seen.set(c, (seen.get(c) || 0) + 1);
  }
  const out = STATUS_ORDER.map((code) => ({ code, label: statusLabel(code), count: seen.get(code) || 0 }));
  const extra = [];
  for (const code of seen.keys()) {
    if (STATUS_ORDER.indexOf(code) < 0) extra.push(code);
  }
  extra.sort();
  for (const code of extra) {
    out.push({ code, label: statusLabel(code), count: seen.get(code) || 0 });
  }
  return out;
}

/** 可搜的文本（方案名 / 型号码 / 标签） */
function haystack(row) {
  const parts = [
    row && row.name,
    (modelCodesOf(row) || []).join(' '),
    tagsOf(row).join(' '),
  ];
  return parts.map((x) => String(x == null ? '' : x)).join(' ').toLowerCase();
}

/**
 * 筛选。条件：
 *   · `q`      文本 —— 匹配**方案名 / 型号码 / 标签**
 *   · `status` 精确匹配状态码
 *   · `model`  含某型号
 *
 * ⚠️ **刻意不匹配的**（写出来，因为"搜不到"必须能问出为什么）：
 *    不搜 `id`（内部编号，不是给人找东西用的）、不搜创建人（单用户档下只有一个值）。
 *    空条件 = 不筛。
 */
export function filterSchemes(rows, filter) {
  const list = Array.isArray(rows) ? rows : [];
  const f = filter || {};
  const q = String(f.q == null ? '' : f.q).trim().toLowerCase();
  const status = String(f.status == null ? '' : f.status).trim();
  const model = String(f.model == null ? '' : f.model).trim();
  return list.filter((row) => {
    if (!row) return false;
    if (status && statusOf(row) !== status) return false;
    if (model && (modelCodesOf(row) || []).indexOf(model) < 0) return false;
    if (q && haystack(row).indexOf(q) < 0) return false;
    return true;
  });
}

/**
 * 筛选结果的**说明文字** —— 「筛选不许静默」的落地处。
 * 界面必须能一句话说出「显示几条 / 共几条 / 按什么条件」，
 * 而不是让人对着一个变短的列表猜自己刚才点了什么。
 */
export function filterSummary(visible, total, filter) {
  const v = Number(visible) || 0;
  const t = Number(total) || 0;
  const f = filter || {};
  const cond = [];
  const q = String(f.q == null ? '' : f.q).trim();
  if (q) cond.push('文本含「' + q + '」');
  const status = String(f.status == null ? '' : f.status).trim();
  if (status) cond.push('状态 = ' + statusLabel(status));
  const model = String(f.model == null ? '' : f.model).trim();
  if (model) cond.push('含型号 ' + model);
  if (!cond.length) return '共 ' + t + ' 份';
  return '显示 ' + v + ' / 共 ' + t + ' 份（条件：' + cond.join('、') + '）';
}

/* ---------- 排序 ---------- */

/**
 * 排序。**返回新数组，不动入参**（列表是界面状态；排序顺手改了原数组，
 * 会让人在别处看到"顺序怎么自己变了"）。
 *
 * 并列时按 id 倒序兜底：**没有兜底键的排序，两次渲染的顺序可能不一样**，
 * 表现出来就是"卡片偶尔自己换位置"。
 *
 * 规模排序里"台数缺失"（接口没给）排最后 —— 不知道几台的，不该混在"很少几台"里。
 */
export function sortSchemes(rows, sort) {
  const list = Array.isArray(rows) ? rows.slice() : [];
  const key = SORT_ORDER.indexOf(sort) >= 0 ? sort : SORTS.UPDATED;
  const at = (row, field) => String((row && row[field]) == null ? '' : row[field]);
  const scaleOf = (row) => {
    const n = itemCountOf(row);
    return n === null ? -1 : n;
  };
  list.sort((a, b) => {
    let d = 0;
    if (key === SORTS.CREATED) d = at(b, 'createdAt').localeCompare(at(a, 'createdAt'));
    else if (key === SORTS.SCALE) d = scaleOf(b) - scaleOf(a);
    else d = at(b, 'updatedAt').localeCompare(at(a, 'updatedAt'));
    if (d !== 0) return d;
    return (Number(b && b.id) || 0) - (Number(a && a.id) || 0);
  });
  return list;
}

/* ---------- 汇总与选项：列表页的「分诊数字」 ---------- */

/**
 * 列表汇总。**单位是「份」（方案条数），不是「个角标」** ——
 * 与 `view.js` 同一条规矩：一条产品可以有两个角标，"2" 到底是 2 条还是 2 个角标，
 * 读的人一定会猜错。管理员动手的单位是「一份方案」，所以这里只产出**方案份数**。
 *
 * 容错：空数组、null、残缺对象都要能算 —— 维护端最不该出现的失败是「没数据时白屏或 NaN」。
 *
 * @param {Array} cards `cardOf()` 的输出（不是原始行）—— 角标已经归一成 `audit.level`
 */
export function summarizeCards(cards) {
  const list = Array.isArray(cards) ? cards.filter(Boolean) : [];
  const level = (c) => (c && c.audit && c.audit.level) || 'none';
  return {
    total: list.length,
    bad: list.filter((c) => level(c) === 'bad').length,
    warn: list.filter((c) => level(c) === 'warn').length,
    ok: list.filter((c) => level(c) === 'ok').length,
    /** 没有体检结论的（既不算好也不算坏 —— 说它 "ok" 就是撒谎） */
    noAudit: list.filter((c) => level(c) === 'none').length,
  };
}

/**
 * 「含某型号」的可选项 —— **从数据里现算**（照 `statusCounts` 的同一条理由）：
 * 硬列一个型号清单，迟早会列出一个筛不出东西的型号；而真正该被看见的是
 * 「库里出现了哪些型号」。
 *
 * 排序是为了**同一批数据两次渲染顺序一致**（否则下拉项会自己换位置）。
 * ⚠️ 型号未知（接口没给 `modelCodes`）的行**一个型号都贡献不了** —— 这是实话，不是缺陷。
 */
export function modelOptions(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const seen = new Set();
  for (const r of list) {
    const codes = modelCodesOf(r);
    if (!codes) continue;
    for (const c of codes) seen.add(c);
  }
  return Array.from(seen).sort();
}

/* ---------- 卡片 ---------- */

/**
 * 这一行是不是软删的。
 *
 * 为什么要这个：**列表接口现在只发 `deleted = 0` 的行**（`SQL_LIST` 里写死），
 * 所以回收站要另开一个入口（见 设计决策记录 §九）。但只要有一天列表把两种行混着发回来，
 * 卡片就必须能标出「已删除」，**而不是混在正常方案里**。
 */
export function deletedFlag(row) {
  const d = row && row.deleted;
  return d === true || d === 1 || d === '1' || d === 'true';
}

/**
 * 一行接口数据 → 一张卡片要用的东西。
 * **只做汇总，不做判断**（判断都在各自的函数里，能单独测）。
 */
export function cardOf(row) {
  const r = row || {};
  return {
    id: r.id,
    name: String(r.name == null ? '' : r.name),
    rev: Number(r.rev) || 0,
    statusCode: statusOf(row),
    statusLabel: statusLabel(statusOf(row)),
    sizeText: sizeText(r.room),
    itemCount: itemCountOf(row),
    roomCount: roomCountOf(row),
    modelCount: modelCountOf(row),
    modelCodes: modelCodesOf(row) || [],
    deleted: deletedFlag(row),
    tags: tagsOf(row),
    hasCover: hasCover(row),
    coverFile: String(r.coverFile == null ? '' : r.coverFile),
    coverSizeText: coverSizeText(row),
    // URL 与话术都在纯函数里算（URL 里那个 `?v=` 是缓存键，值得单独测）
    coverUrl: coverUrl(row),
    coverTitle: coverTitle(row),
    actor: actorLabel(r.updatedBy),
    // U1：方案按登录账号归属。名字由服务端给，给不出名字就退回 #id（见 ownerLabel）
    owner: ownerLabel(r),
    ownerWhy: String(r.ownerName || '').trim()
      ? '方案归属人：' + String(r.ownerName).trim()
      : (ownerLabel(r) === '—'
        ? '这一份没有归属记录（U1 之前建的方案都没有 —— 空就是空，不补一个名字）'
        : '服务端只给了归属账号 id，没有给显示名 —— 原样带 # 显示，不猜名字'),
    updatedText: timeText(r.updatedAt),
    createdText: timeText(r.createdAt),
    audit: auditBadge(r.audit),
    // ⚠️ R6-4 B4d：这两样接口一直在发，但卡片投影没带 —— 表现是卡片上显示
    //    「内容是按参数 rev （未知）摆的」和「没有存下当时的结论」（**明明存了**）。
    //    探针在真机上抓到的：接口对、纯函数对、模板对，**中间那一层把它俩丢了**。
    paramsRev: Number.isFinite(Number(r.paramsRev)) ? Number(r.paramsRev) : null,
    auditStored: r.auditStored || null,
  };
}

/* ---------- 版本历史与三个写动作（R6-3 3e） ---------- */

/**
 * 版本历史的一行 → 界面上要说的东西。**只做汇总，不做判断**。
 *
 * ⚠️ 摘要来自**这一版自己的快照**（后端每行都带），不是当前版本 ——
 *    所以「第 2 版是 8×6 m」这句话说的是第 2 版当时的样子。
 *    两处一旦混了（比如拿当前 state 给所有版本算摘要），每一版都会长得一模一样，
 *    而那正是我们加摘要要避免的事。
 */
export function revisionOf(row) {
  const r = row || {};
  const codes = Array.isArray(r.modelCodes) ? r.modelCodes : null;
  return {
    rev: Number(r.rev) || 0,
    note: String(r.note == null ? '' : r.note),
    /** 这一版就是当前那一版（界面据此把「回滚」按钮对它关上：回到当前版是没意义的选择） */
    isCurrent: r.isCurrent === true,
    sizeText: sizeText(r.room),
    itemCount: itemCountOf(r),
    modelCount: codes ? codes.length : null,
    paramsRev: Number(r.paramsRev) || 0,
    createdText: timeText(r.createdAt),
  };
}

/**
 * 版本历史的**完整性**：共第几版、留存的几版、缺哪几版。
 *
 * 为什么要算这个：`scheme_revision` 上**没有任何约束保证"每版都有快照"**，所以历史可能是缺的。
 * 而「历史是不是完整的」是回滚时最要紧的一句话 —— 用户看不到第 3、4 版，
 * 会以为是自己记错了；告诉他「缺第 3、4 版」才是实话。
 *
 * ⚠️ 分寸（2026-09-29 实测）：**当前库里 5 条方案的快照都是完整的**，
 *    所以这一句现在基本不会出现。它不是预防针，是"真缺了要看得出来"的那个出口。
 */
export function historySummary(rows, currentRev) {
  const list = Array.isArray(rows) ? rows : [];
  const current = Number(currentRev) || 0;
  const seen = new Set();
  for (const r of list) seen.add(Number(r && r.rev) || 0);
  const missing = [];
  for (let i = 1; i <= current; i += 1) {
    if (!seen.has(i)) missing.push(i);
  }
  return { count: list.length, current, missing };
}

/** 版本历史的那一句话（**缺就是缺，不补**） */
export function historyNote(rows, currentRev) {
  const s = historySummary(rows, currentRev);
  if (s.current < 1) return '这份方案还没有版本记录。';
  if (!s.missing.length) return '版本历史完整：第 1–' + s.current + ' 版都有留存，都能回滚。';
  return '历史不完整：一共第 ' + s.current + ' 版，留存的只有 ' + s.count
    + ' 版（缺第 ' + s.missing.join('、') + ' 版：这几版没有留存快照，回滚不到它们。'
    + '**缺的原因查不出来** —— 可能是导入时就没留、也可能被清过，所以不乱猜；'
    + '缺就是缺，不补，也不拿当前版本顶上）。';
}

/**
 * 回滚前的确认话术。**必须把两件事都说出来**：
 *   ① 回滚之后内容会变成什么样（否则用户是在盲选一个版本）
 *   ② 当前那一版会先自动留存（这是用户拍板的 A1 —— 界面上不说，用户就不知道这一步存在）
 */
export function rollbackConfirmText(target, currentRev) {
  const t = target || {};
  const facts = [];
  if (t.sizeText) facts.push(t.sizeText);
  if (t.itemCount !== null && t.itemCount !== undefined) facts.push(t.itemCount + ' 台');
  if (t.modelCount) facts.push(t.modelCount + ' 个型号');
  return '回滚到第 ' + (Number(t.rev) || 0) + ' 版：内容会变成 '
    + (facts.length ? facts.join(' / ') : '（这一版没给摘要，只能按版本号认）')
    + '。当前的第 ' + (Number(currentRev) || 0) + ' 版会**先自动留存一版**，不会丢。';
}

/**
 * 回滚做完之后的那一句话。
 *
 * ⚠️ 为什么要把「本来就有」与「本次补存」分开说：用户被告知「你的东西没丢」，
 * 而「没丢」的原因有两种 —— 一种不需要感谢服务端，另一种是服务端刚救了一次。
 * 混成一句「已留存」，用户下次就会以为这是白来的。
 */
export function rollbackDoneText(res) {
  const r = res || {};
  const kept = r.keptWasExisting
    ? '第 ' + (Number(r.keptRev) || 0) + ' 版本来就在历史里（没有额外动作）'
    : '第 ' + (Number(r.keptRev) || 0) + ' 版历史里没有，**已自动补存一版**';
  return '已回滚到第 ' + (Number(r.rolledBackTo) || 0) + ' 版 → 现在是第 '
    + (Number(r.rev) || 0) + ' 版；回滚前的' + kept + '。';
}

/** 复制完之后的那一句话：**说清它从哪来**（过两天用户会怀疑自己拷了另一版） */
export function duplicateDoneText(res) {
  const r = res || {};
  return '已复制为 #' + r.id + '「' + String(r.name == null ? '' : r.name)
    + '」（来自 #' + r.fromId + ' 第 ' + r.fromRev + ' 版）。'
    + '副本状态是草稿、没有封面也不带标签 —— 那些字段说的是源方案那一份。';
}

/** 删除 / 恢复之后的那一句话（两个方向共用，方向不同、话说不同） */
export function deleteDoneText(id, restored) {
  return restored
    ? '#' + id + ' 已从回收站恢复，回到了方案库（版本号没有变 —— 恢复不是一次内容编辑）。'
    : '#' + id + ' 已放进回收站（软删，没有真删掉；在「回收站」里可以恢复）。';
}
