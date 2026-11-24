/**
 * openings.js —— 洞口（建筑洞口 = 墙上的开口）：校验 / 放置 / 几何（纯函数，不碰 three、不碰 DOM）
 *
 * ## 洞口是什么（与"设备柜门"完全不是一回事）
 *
 * - **洞口**（本模块，参数组 `cfg.opening.*` 与 `cfg.window.*`）：墙上挖的一个**矩形**缺口。
 *   它长在墙上（`wall.openings`），不参与房间闭合判定（一个洞口不该把两间房并成一间），
 *   在**渲染**里是"这里有个口"。
 * - **设备柜门**（`cfg.door.*` / 设计决策记录规则 7）：设备自己的柜门能开多大，
 *   是绕铰链的扇形扫掠，消费链路在 `clearance.js`。两个"门"零重叠（设计决策记录 §四）。
 *
 * ## 洞口只有两种：门洞（W1）与窗（W2），一共**一处**语义差别
 *
 * 水平方向（`at` / `w`、沿墙定位、重叠判定、离墙角、每墙上限）两者**逐字共用**；
 * 竖直方向窗多一个**离地高度** `sill`（从地面量到洞口下沿），于是墙的实心块从 3 块变 4 块
 * （左段 · 右段 · **窗下墙** · 过梁）。
 *
 * ⭐ **唯一必须纠正的一处：窗不能走人。**
 * 门洞最本质的作用是"这儿能过去"（`wallSolidSegments()` 把洞那段从碰撞线段里**删掉**，
 * 漫游才走得过去）。窗**绝不能**这么做 —— 否则人就从窗里走出去。而这一条错了，
 * 界面上**完全看不出来**（墙上有洞、看着对），只有走到窗前才发现人穿墙而过。
 * 所以本模块有一条成对判据守着：**门洞正中不挡 · 窗洞正中仍然挡**（两态都断言，
 * 只断一半会变成假绿）。
 *
 * `kind` 只在窗上写（`kind: 'window'`），门**省略**它 —— 于是今天所有含门洞的方案
 * 导出字节逐字不变（设计决策记录 §2.2）。形状的唯一定义在 `wall.js`（`mkOpening/readOpening`）。
 *
 * ## 三条不许违反的口径
 *
 * 1. **`at` 是沿墙自 `a` 端点的弧长（米）**，不是 0..1 比例 —— 比例会在墙变长时
 *    把洞悄悄挪位置。2D/3D/碰撞/校验共用这一个口径（守恒判据的分母是**原墙长**）。
 * 2. **几何是"左右实心段 + 过梁"（窗还多一块窗下墙），不是"把墙切成两段"**：
 *    `prismFaces()` 要凸多边形，一面带洞的墙不可能是单个棱柱；而"切成两段"会**丢掉过梁**
 *    （洞上方那一截墙就没了）并且让平面图看着"房间不闭合"。
 * 3. **导入宽容、交互严格**（这一条与字面读法的差别，是刻意为之）：
 *    - 结构不合法（坐标不是有限数、洞跑到墙外、两洞重叠、比墙还高、窗的离地不是有限数）→ **拒绝**：
 *      这不是本应用的文件；
 *    - 与**可编辑参数**有关的边界（最小/最大净宽、离墙角间隙、每墙上限、窗的离地上下限）→
 *      放置时按当前参数**夹取并出声**，导入时**只提示不拒绝**。理由：那些参数是现场可改的策略，
 *      拿"今天的策略"去拒绝"昨天导出的文件"就是在制造 FIX-05（自己导出的文件自己导不回来）。
 *
 * ## 2D 与 3D 的**刻意分叉**（窗这一批新增，设计决策记录 §六）
 *
 * 平面图里墙只有**门**才断开：顶视图里"断开的墙"传达的就是"这儿能过去"，窗不是。
 * 所以 2D 侧调 `solidBlocks()` 时只传**门洞**（`doorOpenings()`），窗在平面图里画
 * **建筑制图的三线符号**（洞口两条边线 + 沿墙中线一条），墙身照旧整段实心。
 * 3D 侧照传全部洞口（窗要真的挖出洞 + 有窗下墙）。
 */

import { cfg } from './params.js';
import { columnsAtOpening, COLUMN_MESSAGE } from './columns.js';
import { wallA, wallB, wallLen, openingsOf, kindOf, sillOf, cloneOpening, mkOpening, mkWall, roleOf, WINDOW, holeName } from './wall.js';
import { clipHalfPlane } from './geometry.js';

/** 每面墙洞口数的**格式上限**（不是策略上限 —— 策略上限是 `opening.maxPerWall` / `window.maxPerWall`，可在后台改） */
export const OPENING_HARD_LIMIT = 10;

/** 结构层面的不合法（导入也要拒） */
export const OPENING_REASON = {
  OK: null,
  BAD_OPENING: 'bad-opening',
  BAD_SILL: 'opening-bad-sill',
  OFF_WALL: 'opening-off-wall',
  OVERLAP: 'opening-overlap',
  TOO_TALL: 'opening-too-tall',
  TOO_MANY: 'opening-too-many',
};

/** 策略层面的越界（放置时夹取 + 出声；导入只提示） */
export const OPENING_WARN = {
  TOO_NARROW: 'opening-too-narrow',
  TOO_WIDE: 'opening-too-wide',
  TOO_CLOSE_TO_CORNER: 'opening-too-close-to-corner',
  OVER_PER_WALL: 'opening-over-per-wall',
  SILL_TOO_LOW: 'window-sill-too-low',
  SILL_TOO_HIGH: 'window-sill-too-high',
};

/** 某一类洞口的净宽上下限与每墙上限（**不许双真源**：读参数表只有这处） */
export function minWidthOf(kind) {
  return kind === WINDOW ? cfg.window.minWidthM : cfg.opening.minWidthM;
}

export function maxWidthOf(kind) {
  return kind === WINDOW ? cfg.window.maxWidthM : cfg.opening.maxWidthM;
}

export function maxPerWallOf(kind) {
  return kind === WINDOW ? cfg.window.maxPerWall : cfg.opening.maxPerWall;
}

/** 内核出话、界面原样转述（照 `placement.MSG` 的先例：文案只有一份）。
 *  ⚠️ 名字里带洞口的几条是**函数**（说"门洞"还是"窗"由 `holeName()` 定），
 *  不传 kind 就是门洞 —— 老调用点与老判据照旧能用。 */
export const MSG = {
  get wallMissing() { return '这面墙已经不在了（是拿到旧快照了吗？）'; },
  badOpening: (kind) => `${holeName(kind)}数据不合法（位置与尺寸必须是有限数字）`,
  badSill: () => '窗的离地高度不合法（必须是 0 以上的有限数字）',
  offWall: (kind) => `${holeName(kind)}必须整段落在墙身上（两端各留 ${cfg.opening.wallEdgeGapM} m 才放得下框）`,
  cannotFit: (kind) => `这面墙太短，放不下 ${minWidthOf(kind)} m 的${holeName(kind)}（两端各要留 ${cfg.opening.wallEdgeGapM} m）`,
  overlap: () => '洞口与已有的洞口重叠了（同一个位置不能既是门洞又是窗）',
  tooTall: (kind) => `${holeName(kind)}比墙还高`,
  windowTooHigh: () => '窗比墙还高（离地高度 + 净高 不能超过墙高）',
  windowNoRoom: (sill) => `墙高不够：离地 ${Number(sill).toFixed(2)} m 之后放不下窗`,
  tooMany: (kind) => `一面墙最多 ${maxPerWallOf(kind)} 个${holeName(kind)}`,
  tooManyHard: () => `一面墙最多 ${OPENING_HARD_LIMIT} 个洞口（门洞与窗合计）`,
  clippedNarrow: (kind) => `净宽已按最小 ${minWidthOf(kind)} m 夹取`,
  clippedWide: (kind) => `净宽已按最大 ${maxWidthOf(kind)} m 夹取`,
  get clippedCorner() { return `洞口已挪开，离墙角至少留 ${cfg.opening.wallEdgeGapM} m`; },
  get clippedTall() { return '净高已按墙高夹取'; },
  get clippedSillLow() { return `离地高度已按最小 ${cfg.window.minSillM} m 夹取`; },
  get clippedSillHigh() { return `离地高度已按最大 ${cfg.window.maxSillM} m 夹取`; },
};

/* ---------------- 按类别取洞口 ---------------- */

/** 门洞（缺省类别）—— ⭐ **只有门能走人**，窗不在其列 */
export function doorOpenings(w) {
  return openingsOf(w).filter((o) => kindOf(o) !== WINDOW);
}

/** 窗 */
export function windowOpenings(w) {
  return openingsOf(w).filter((o) => kindOf(o) === WINDOW);
}

/** 某一类洞口的个数（每墙上限**按类别各算各的**：一面墙可以 3 门 + 3 窗） */
export function countOf(list, kind) {
  return list.filter((o) => kindOf(o) === kind).length;
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** 洞口中心沿墙的弧长区间 `[起, 止]` */
export function openingSpan(o) {
  return [o.at - o.w / 2, o.at + o.w / 2];
}

/**
 * 一组洞口的区间（**按起点排序**，带原下标）。
 *
 * 排序不是风格问题：几何是"相邻两洞之间那段墙"，不排序就会算出自相交的区间。
 */
function spansOf(list) {
  return list
    .map((o, index) => ({ opening: o, index, gs: o.at - o.w / 2, ge: o.at + o.w / 2 }))
    .sort((a, b) => a.gs - b.gs);
}

/** 一面墙上所有洞口的区间（门与窗一起：重叠判定要跨类别） */
export function openingSpans(wall) {
  return spansOf(openingsOf(wall));
}

/** 一面墙上**门洞**的区间（碰撞用：只有门挖空墙身） */
function doorSpans(wall) {
  return spansOf(doorOpenings(wall));
}

/** 两区间是否重叠（恰好相接 = 不重叠；留 1e-6 容差给取整） */
function overlaps(a, b, tol = 1e-6) {
  return a.gs < b.ge - tol && b.gs < a.ge - tol;
}

/**
 * 单个洞口的**结构**校验（导入/服务端也用它；与策略参数无关）。
 * @returns {null|{reason:string,message:string}} null = 结构合法
 */
export function checkOpeningShape(wall, opening, roomH) {
  const kind = kindOf(opening);
  if (!opening || !finite(opening.at) || !finite(opening.w) || !finite(opening.h)) {
    return { reason: OPENING_REASON.BAD_OPENING, message: MSG.badOpening(kind) };
  }
  const len = wallLen(wall);
  if (!(opening.w > 1e-6) || opening.w > len + 1e-9) {
    return { reason: OPENING_REASON.OFF_WALL, message: MSG.offWall(kind) };
  }
  const [gs, ge] = openingSpan(opening);
  if (gs < -1e-6 || ge > len + 1e-6) return { reason: OPENING_REASON.OFF_WALL, message: MSG.offWall(kind) };
  if (!(opening.h > 1e-6) || (finite(roomH) && opening.h > roomH + 1e-6)) {
    return { reason: OPENING_REASON.TOO_TALL, message: MSG.tooTall(kind) };
  }
  // 窗的竖直约束：离地是有限数、不为负，且**洞顶不许穿出墙顶**（离地 + 净高 ≤ 墙高）
  if (kind === WINDOW) {
    if (!finite(opening.sill) || opening.sill < -1e-6) {
      return { reason: OPENING_REASON.BAD_SILL, message: MSG.badSill() };
    }
    if (finite(roomH) && opening.sill + opening.h > roomH + 1e-6) {
      return { reason: OPENING_REASON.TOO_TALL, message: MSG.windowTooHigh() };
    }
  }
  return null;
}

/**
 * 一面墙的洞口体检：结构 + 两两重叠 + 个数（**按类别**）。
 * @param {number} [roomH] 房间墙高（判"比墙还高"）
 * @param {'strict'|'tolerant'} [mode] `tolerant` = 忽略**策略**个数上限（导入用；上限是可改的策略）
 * @returns {null|{reason:string,message:string}}
 */
export function checkWallOpenings(wall, roomH, mode = 'strict') {
  const list = openingsOf(wall);
  if (!list.length) return null;
  if (mode === 'strict') {
    for (const kind of ['door', WINDOW]) {
      if (countOf(list, kind) > maxPerWallOf(kind)) {

        return { reason: OPENING_REASON.TOO_MANY, message: MSG.tooMany(kind) };
      }
    }
  }
  if (list.length > OPENING_HARD_LIMIT) return { reason: OPENING_REASON.TOO_MANY, message: MSG.tooManyHard() };
  for (const o of list) {
    const bad = checkOpeningShape(wall, o, roomH);
    if (bad) return bad;
  }
  const spans = openingSpans(wall);
  for (let i = 1; i < spans.length; i++) {
    if (overlaps(spans[i - 1], spans[i])) return { reason: OPENING_REASON.OVERLAP, message: MSG.overlap() };
  }
  return null;
}

/**
 * 交互层的体检：结构 + **策略**（净宽上下限、离墙角间隙、每墙上限按类别、窗的离地上下限）。
 *
 * 策略越界**不是"拒绝"**，而是"要夹取" —— 所以单独给一组 `{clamps, warnings}`，
 * 由放置函数去夹、去出声。界面拿 `warnings` 显示（选中洞口时也显示，让"这扇低于当前下限"看得见）。
 * @returns {{structural: null|object, warnings: Array<{reason:string,message:string}>}}
 */
export function inspectOpening(wall, opening, roomH) {
  const structural = checkOpeningShape(wall, opening, roomH);
  const warnings = [];
  const kind = kindOf(opening);
  const len = wallLen(wall);
  if (!structural) {
    if (opening.w < minWidthOf(kind) - 1e-9) warnings.push({ reason: OPENING_WARN.TOO_NARROW, message: `净宽小于当前下限 ${minWidthOf(kind)} m` });
    if (opening.w > maxWidthOf(kind) + 1e-9) warnings.push({ reason: OPENING_WARN.TOO_WIDE, message: `净宽大于当前上限 ${maxWidthOf(kind)} m` });
    if (kind === WINDOW) {
      const s = sillOf(opening);
      if (s < cfg.window.minSillM - 1e-9) warnings.push({ reason: OPENING_WARN.SILL_TOO_LOW, message: `离地高度小于当前下限 ${cfg.window.minSillM} m` });
      if (s > cfg.window.maxSillM + 1e-9) warnings.push({ reason: OPENING_WARN.SILL_TOO_HIGH, message: `离地高度大于当前上限 ${cfg.window.maxSillM} m` });
    }
    const [gs, ge] = openingSpan(opening);
    if (gs < cfg.opening.wallEdgeGapM - 1e-9 || len - ge < cfg.opening.wallEdgeGapM - 1e-9) {
      warnings.push({ reason: OPENING_WARN.TOO_CLOSE_TO_CORNER, message: `离墙角不足 ${cfg.opening.wallEdgeGapM} m` });
    }
    if (countOf(openingsOf(wall), kind) > maxPerWallOf(kind)) warnings.push({ reason: OPENING_WARN.OVER_PER_WALL, message: MSG.tooMany(kind) });
  }
  return { structural, warnings };
}

/**
 * 把"想要的洞口"夹成"墙上放得下的洞口"。
 *
 * 四类夹取（每一类都会在返回值里报出来 —— 静默改数是这个项目最不能接受的一类 bug）：
 *   ① 净宽 → 夹进 `[minWidthM, maxWidthM]`（按类别），**中心不动**（用户瞄的是"洞口在这儿"）；
 *   ② 整段挪回墙上（两端各留 `wallEdgeGapM`，挪不动就缩）；优先**平移**，平移不行再缩宽度；
 *   ③ 净高 → 门夹到墙高；窗夹到 `墙高 − 离地`；
 *   ④ **窗的离地高度** → 夹进 `[window.minSillM, window.maxSillM]`。
 *
 * @param {object} wall
 * @param {{at:number,w:number,h:number,kind?:string,sill?:number}} want
 * @param {{roomH:number, existing?:Array}} [opts] `existing` = 要避开的已存在区间（同一面墙上的其它洞，**跨类别**）
 * @param {string} [kind] 类别（不传就看 `want.kind`）
 * @returns {{ok:false,reason:string,message:string}|{ok:true,opening:object,clamps:string[]}}
 */
export function fitOpening(wall, want, { roomH, existing = [] } = {}) {
  const len = wallLen(wall);
  const gap = cfg.opening.wallEdgeGapM;
  const kind = kindOf(want);
  if (!finite(want?.at) || !finite(want?.w) || !finite(want?.h)) {
    return { ok: false, reason: 'bad-opening', message: MSG.badOpening(kind) };
  }
  let w = want.w;
  let h = want.h;
  let sill = 0;
  const clamps = [];

  // ④ 窗的离地高度：先夹进策略范围，再受结构约束（离地 + 净高 ≤ 墙高）
  if (kind === WINDOW) {
    sill = finite(want.sill) ? want.sill : cfg.window.defaultSillM;
    if (sill < cfg.window.minSillM - 1e-9) { sill = cfg.window.minSillM; clamps.push(MSG.clippedSillLow); }
    if (sill > cfg.window.maxSillM + 1e-9) { sill = cfg.window.maxSillM; clamps.push(MSG.clippedSillHigh); }
    // 墙高不够（离地已经贴到墙顶）→ **拒绝**，绝不夹成一个 0.05 m 高的缝
    if (finite(roomH) && sill >= roomH - 1e-6) {
      return { ok: false, reason: 'cannot-fit', message: MSG.windowNoRoom(sill) };
    }
  }

  // ① 净宽上下限
  if (w < minWidthOf(kind) - 1e-9) { w = minWidthOf(kind); clamps.push(MSG.clippedNarrow(kind)); }
  if (w > maxWidthOf(kind) + 1e-9) { w = maxWidthOf(kind); clamps.push(MSG.clippedWide(kind)); }
  // ③ 净高（窗的余量比门少一个离地高度）
  const headroom = finite(roomH) ? roomH - sill : Infinity;
  if (h > headroom + 1e-9) { h = headroom; clamps.push(MSG.clippedTall); }
  if (h < 1e-6) h = Math.min(headroom, 1e-6);

  // 能不能放下：可用区间 = [gap, len-gap]
  const room = len - 2 * gap;
  if (room < minWidthOf(kind) - 1e-9) {
    return { ok: false, reason: 'cannot-fit', message: MSG.cannotFit(kind) };
  }
  if (w > room) { w = room; clamps.push(MSG.clippedNarrow(kind)); }

  // ② 端点回墙：先试平移，再按需缩
  let at = want.at;
  const half = w / 2;
  if (at - half < gap) { at = gap + half; }
  if (at + half > len - gap) { at = len - gap - half; }
  const [gsF, geF] = [at - half, at + half];
  if (gsF < gap - 1e-9 || geF > len - gap + 1e-9) {
    // 平移不够（洞比可用区间还大）→ 缩到可用区间，中心对齐用户瞄的位置
    w = Math.max(minWidthOf(kind), room);
    at = Math.min(Math.max(at, gap + w / 2), len - gap - w / 2);
    clamps.push(MSG.clippedNarrow(kind));
  }
  if (Math.abs(at - want.at) > 1e-9 || Math.abs(w - want.w) > 1e-9) {
    if (!clamps.includes(MSG.clippedCorner)) clamps.push(MSG.clippedCorner);
  }

  const opening = mkOpening({ at, w, h, kind, sill });
  // 与已有洞口重叠 → 拒绝（这不是夹取能解决的：往哪儿挪都是另一个洞。**跨类别也算**：
  // 同一个位置不能既是门洞又是窗）
  const span = { gs: opening.at - opening.w / 2, ge: opening.at + opening.w / 2 };
  for (const e of existing) {
    if (overlaps(span, e)) return { ok: false, reason: 'overlap', message: MSG.overlap() };
  }
  return { ok: true, opening, clamps };
}

/** 把洞口按 `at` 排序后写回墙（几何/校验都假设有序）。
 *  ⚠️ 走 `cloneOpening`（形状的唯一定义）——手抄 `{at,w,h}` 会把窗降级成门 */
function wallsWith(walls, wallIndex, nextWall) {
  return walls.map((w, i) => (i === wallIndex ? nextWall : w));
}

/**
 * 换掉一面墙的洞口清单（**唯一一处**重建墙的地方）。
 *
 * ⚠️ 必须走 `mkWall` 并显式带 `roleOf(wall)`：手抄 `{a,b,openings}` 会把墙的**角色**丢掉 ——
 * 放/改/删一次门窗，外墙就静默变回几何回退（贴边内墙会因此变外墙、设备穿过）。
 * 角色丢失平时测不出来（几何回退恰好一致时），只在"角色与几何不同"的布局上现形（P1，设计决策记录）。
 */
function withOpenings(wall, list) {
  const sorted = [...list].sort((p, q) => p.at - q.at).map(cloneOpening);
  return mkWall(wall.a, wall.b, sorted, roleOf(wall));
}

/**
 * 把"想要的洞口"解析成"要夹取的候选"（纯函数）。
 *
 * ⭐ 预览与落笔**共用这一条**：界面把同一个 `want` 递进来（拖动中的那一段/点的那个位置），
 * 算出来的就是落笔后的那一个 —— "看到的"和"存下来的"不可能不一样（照画墙预览的先例）。
 *
 * 默认尺寸按类别取：门洞 `opening.defaultWidthM/HeightM`，窗 `window.defaultWidthM/HeightM/SillM`。
 *
 * @param {{at?:number,w?:number,h?:number,kind?:string,sill?:number,span?:[number,number]}} want
 * @returns {{ok:false,reason:string,message:string}|{ok:true,opening:object,clamps:string[]}}
 */
export function draftOpening(wall, want = {}, { roomH, existing = [] } = {}) {
  const kind = kindOf(want);
  let at = want.at;
  let w = want.w;
  if (Array.isArray(want.span)) {
    const s0 = Math.min(want.span[0], want.span[1]);
    const s1 = Math.max(want.span[0], want.span[1]);
    at = (s0 + s1) / 2;
    w = s1 - s0;
  }
  if (!finite(at)) at = wallLen(wall) / 2;
  if (!finite(w)) w = kind === WINDOW ? cfg.window.defaultWidthM : cfg.opening.defaultWidthM;
  const h = finite(want.h) ? want.h : (kind === WINDOW ? cfg.window.defaultHeightM : cfg.opening.defaultHeightM);
  const sill = kind === WINDOW
    ? (finite(want.sill) ? want.sill : cfg.window.defaultSillM)
    : 0;
  return fitOpening(wall, { at, w, h, kind, sill }, { roomH, existing });
}

/**
 * 在墙上放一个洞口（门洞或窗）。
 *
 * @param {object} layout
 * @param {number} wallIndex
 * @param {{at?:number,w?:number,h?:number,kind?:string,sill?:number,span?:[number,number]}} want
 *   `at` = 中心弧长（点击放置）；`span` = 起止弧长（拖拽放置；宽度由这一段决定）；
 *   `kind` = `'window'` 就是窗（缺省门洞）；窗可以给 `sill`（缺省用参数表的默认离地）
 * @returns {{ok:false,reason:string,message:string}|{ok:true,layout:object,opening:object,clamps:string[],index:number}}
 */
export function placeOpening(layout, wallIndex, want = {}) {
  const wall = layout?.walls?.[wallIndex];
  if (!wall) return { ok: false, reason: 'no-wall', message: MSG.wallMissing };
  const kind = kindOf(want);
  const list = openingsOf(wall);
  if (countOf(list, kind) >= maxPerWallOf(kind)) {
    return { ok: false, reason: 'too-many', message: MSG.tooMany(kind) };
  }
  if (list.length >= OPENING_HARD_LIMIT) {
    return { ok: false, reason: 'too-many', message: MSG.tooManyHard() };
  }

  const existing = openingSpans(wall);
  const fit = draftOpening(wall, want, { roomH: layout.h, existing });
  if (!fit.ok) return fit;
  const column = columnsAtOpening(layout, wall, fit.opening)[0];
  if (column) {
    return { ok: false, reason: 'column-in-opening', message: COLUMN_MESSAGE.IN_OPENING(column.id) };
  }

  const nextWall = withOpenings(wall, [...list, fit.opening]);
  const index = nextWall.openings.findIndex((o) => o.at === fit.opening.at && o.w === fit.opening.w && kindOf(o) === kind);
  return {
    ok: true,
    layout: { ...layout, walls: wallsWith(layout.walls, wallIndex, nextWall) },
    opening: fit.opening,
    clamps: fit.clamps,
    index,
  };
}

/** 删掉一个洞口（门洞或窗，同一条路径） */
export function removeOpening(layout, wallIndex, openingIndex) {
  const wall = layout?.walls?.[wallIndex];
  if (!wall) return { ok: false, reason: 'no-wall', message: MSG.wallMissing };
  const list = openingsOf(wall).filter((_, i) => i !== openingIndex);
  if (list.length === openingsOf(wall).length) return { ok: false, reason: 'no-opening', message: MSG.badOpening() };
  return { ok: true, layout: { ...layout, walls: wallsWith(layout.walls, wallIndex, withOpenings(wall, list)) } };
}

/**
 * 改一个洞口（拖把手改宽 / 输入框改数值 / 窗改离地高度）。
 * 走的还是同一条夹取路径（`fitOpening`）—— 界面不许自己算几何。
 */
export function updateOpening(layout, wallIndex, openingIndex, patch) {
  const wall = layout?.walls?.[wallIndex];
  if (!wall) return { ok: false, reason: 'no-wall', message: MSG.wallMissing };
  const list = openingsOf(wall);
  const cur = list[openingIndex];
  if (!cur) return { ok: false, reason: 'no-opening', message: MSG.badOpening() };
  const kind = kindOf(cur);
  const want = {
    at: patch.at ?? cur.at,
    w: patch.w ?? cur.w,
    h: patch.h ?? cur.h,
    kind,
    sill: patch.sill ?? sillOf(cur),
  };
  const existing = openingSpans(wall).filter((s) => s.index !== openingIndex);
  const fit = fitOpening(wall, want, { roomH: layout.h, existing });
  if (!fit.ok) return fit;
  const column = columnsAtOpening(layout, wall, fit.opening)[0];
  if (column) {
    return { ok: false, reason: 'column-in-opening', message: COLUMN_MESSAGE.IN_OPENING(column.id) };
  }
  const next = list.map((o, i) => (i === openingIndex ? fit.opening : o));
  const nextWall = withOpenings(wall, next);
  const index = nextWall.openings.findIndex((o) => o.at === fit.opening.at && o.w === fit.opening.w && kindOf(o) === kind);
  return {
    ok: true,
    layout: { ...layout, walls: wallsWith(layout.walls, wallIndex, nextWall) },
    opening: fit.opening,
    index,
    clamps: fit.clamps,
  };
}

/** 把布局里的洞口按墙取出来（几何层用；索引 = 墙序号） */
export function openingsByWall(layout) {
  return (layout?.walls ?? []).map((w) => openingsOf(w));
}

/* ---------------- 几何：带洞的墙 = 左右实心段 + （窗下墙）+ 过梁 ---------------- */

/**
 * 一块墙构件被洞口切开之后的**凸**分块。
 *
 * 做法：沿墙方向的弧长 `s(p) = (p − wall.a)·dir`，把构件的多边形按"洞的左右边界"用
 * 两个半平面各裁一刀。构件（含斜接后的 5 边形）本来就是凸的，凸多边形被半平面裁完还是凸的
 * —— 所以每一块都能直接喂 `prismFaces()`。
 *
 * 竖直方向的分块（**门 3 块 / 窗 4 块**）：
 *
 *     门： 左段 + 右段 + 过梁(base = h)                        → 洞从地面起
 *     窗： 左段 + 右段 + **窗下墙**(base 0, height = sill) + 过梁(base = sill + h)
 *
 * ⚠️ **2D 侧只传门洞**（`doorOpenings()`）：窗在顶视图里不断墙身（断开的墙＝"这儿能过去"）。
 * 只传门时窗下墙天然不产（门的 `sill` 恒 0）—— 所以 2D 不需要额外开关。
 *
 * @param {object} piece `wallpieces.wallPieces()` 的构件（`poly` 已斜接）
 * @param {Array} openings 该墙的洞口（`at/w/h[/kind/sill]`）
 * @param {{lintel?:boolean}} [opts] `lintel:false` = 不产过梁（**平面图用**：
 *        顶视图里过梁会把洞口盖住，于是"门"在平面上看不见 —— 这是 2D/3D 唯一的刻意分叉）
 * @returns {Array<{poly:Array, base:number, height:number, kind:'full'|'sill'|'lintel', openingIndex:number}>}
 */
export function solidBlocks(piece, openings = [], { lintel = true } = {}) {
  const poly = piece?.poly;
  if (!Array.isArray(poly) || poly.length < 3) return [];
  const wall = piece.wall;
  const a = wallA(wall);
  const len = wallLen(wall);
  const dir = len > 1e-12
    ? [(wallB(wall)[0] - a[0]) / len, (wallB(wall)[1] - a[1]) / len]
    : [1, 0];
  // 沿墙弧长：半平面的符号距离函数
  const sOf = (p) => (p[0] - a[0]) * dir[0] + (p[1] - a[1]) * dir[1];
  const keepBelow = (q, limit) => clipHalfPlane(q, sOf, limit);          // s ≤ limit
  const keepAbove = (q, limit) => clipHalfPlane(q, (p) => -sOf(p), -limit); // s ≥ limit

  const spans = openings
    .map((o, index) => ({ o, index, gs: o.at - o.w / 2, ge: o.at + o.w / 2 }))
    .sort((p, q) => p.gs - q.gs);

  const out = [];
  const push = (q, base, height, kind, openingIndex) => {
    if (q.length < 3 || height <= 1e-9) return;
    out.push({ poly: q, base, height, kind, openingIndex });
  };
  // 洞口正下方/正上方那一块（沿墙的 `[gs, ge]` 之间，竖直方向 base..base+height）
  const column = (s, base, height, kind) => {
    let q = keepAbove(poly, s.gs);
    q = keepBelow(q, s.ge);
    push(q, base, height, kind, s.index);
  };

  // 实心段：洞与洞之间（以及两端）
  let cursor = -Infinity;
  for (const s of spans) {
    let q = poly;
    if (Number.isFinite(cursor)) q = keepAbove(q, cursor);
    q = keepBelow(q, s.gs);
    push(q, 0, piece.h, 'full', -1);
    cursor = s.ge;
  }
  if (spans.length) {
    let q = Number.isFinite(cursor) ? keepAbove(poly, cursor) : poly;
    push(q, 0, piece.h, 'full', -1);
  } else {
    push(poly, 0, piece.h, 'full', -1);
  }

  for (const s of spans) {
    const sill = sillOf(s.o);
    // 窗下墙：洞底下那一截实心墙（门不产：sill 恒 0 → 零高块，`push` 直接丢掉）
    if (sill > 1e-9) column(s, 0, sill, 'sill');
    if (!lintel) continue;
    // 过梁：洞正上方那一段（**base = 离地 + 洞高**；门就是洞高）
    const base = sill + s.o.h;
    column(s, base, piece.h - base, 'lintel');
  }
  return out;
}

/**
 * 一面墙的**实心子段**（碰撞/漫游用）：**门洞**的位置整段不挡人，其余照旧挡。
 *
 * ⭐ **窗不在这里**：窗那一块墙照旧是实心的 —— 人不能从窗里走出去。
 * 用 `doorSpans()` 而不是 `openingSpans()` 就是这一条的全部实现，
 * 而成对判据（门洞正中不挡 · 窗洞正中仍挡）守着它不被改回去。
 *
 * 为什么不写"整墙判定、洞区间 if-else 放行"：那样 0.1 m 的缝也能钻过去 ——
 * 子段喂给同一个 `segmentDistance()` 才是对的几何（窄洞自然过不去：两侧都要留出人体半径，
 * 0.4 m 的洞算下来就没地方站，不需要专门写一条"窄门规则"）。
 * @returns {Array<[number,number,number,number]>} `[x1,z1,x2,z2]` 线段清单
 */
export function wallSolidSegments(wall) {
  const a = wallA(wall);
  const b = wallB(wall);
  const len = wallLen(wall);
  if (!(len > 1e-12)) return [];
  const dir = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
  const at = (s) => [a[0] + dir[0] * s, a[1] + dir[1] * s];
  const spans = doorSpans(wall);
  if (!spans.length) return [[a[0], a[1], b[0], b[1]]];
  const out = [];
  let cursor = 0;
  for (const s of spans) {
    const gs = Math.max(0, s.gs);
    if (gs - cursor > 1e-9) {
      const p0 = at(cursor);
      const p1 = at(gs);
      out.push([p0[0], p0[1], p1[0], p1[1]]);
    }
    cursor = Math.max(cursor, Math.min(len, s.ge));
  }
  if (len - cursor > 1e-9) {
    const p0 = at(cursor);
    out.push([p0[0], p0[1], b[0], b[1]]);
  }
  return out;
}

/**
 * 洞口那块矩形的四个角（世界坐标，按顺序）。
 * 渲染层用它画框线、命中区、预览 —— 几何只有这一份，界面不自己算。
 * （水平方向的几何：门与窗**一模一样**，竖直方向的差别在 `solidBlocks` 与 `sillOf`）
 */
export function holeQuad(wall, opening) {
  const a = wallA(wall);
  const b = wallB(wall);
  const len = wallLen(wall);
  if (!(len > 1e-12)) return null;
  const dir = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
  const perp = [-dir[1], dir[0]];
  const half = cfg.space.wallThicknessM / 2;
  const at = (s) => [a[0] + dir[0] * s, a[1] + dir[1] * s];
  const gs = opening.at - opening.w / 2;
  const ge = opening.at + opening.w / 2;
  const p0 = at(gs);
  const p1 = at(ge);
  return [
    [p0[0] - perp[0] * half, p0[1] - perp[1] * half],
    [p0[0] + perp[0] * half, p0[1] + perp[1] * half],
    [p1[0] + perp[0] * half, p1[1] + perp[1] * half],
    [p1[0] - perp[0] * half, p1[1] - perp[1] * half],
  ];
}

/**
 * 墙上的洞口在平面上的标记（2D 画框线与读数；3D 不用它）。
 * 返回的是**墙的局部几何**，调用方自己转世界坐标。
 *
 * 门与窗的平面画法**刻意不同**（设计决策记录 §六）：
 *   · 门：墙身断开（`blocks` 已经把洞挖掉了）+ 洞口两条门框线；
 *   · 窗：墙身**不断**（这儿走不过去）+ 洞口两条窗框线 + **沿墙中线一条窗线**
 *     （建筑制图的"三线"画法）→ `sash`。
 */
export function openingMarks(wall) {
  const a = wallA(wall);
  const b = wallB(wall);
  const len = wallLen(wall);
  if (!(len > 1e-12)) return [];
  const dir = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
  const perp = [-dir[1], dir[0]];
  const half = cfg.space.wallThicknessM / 2;
  const at = (s) => [a[0] + dir[0] * s, a[1] + dir[1] * s];
  return openingSpans(wall).map((sp) => {
    const [gs, ge] = [sp.gs, sp.ge];
    const p0 = at(gs);
    const p1 = at(ge);
    const kind = kindOf(sp.opening);
    return {
      index: sp.index,
      opening: sp.opening,
      kind,
      width: sp.opening.w,
      height: sp.opening.h,
      sill: sillOf(sp.opening),
      // 两条框线（横跨墙厚），画在洞口的两侧
      jambs: [
        [[p0[0] - perp[0] * half, p0[1] - perp[1] * half], [p0[0] + perp[0] * half, p0[1] + perp[1] * half]],
        [[p1[0] - perp[0] * half, p1[1] - perp[1] * half], [p1[0] + perp[0] * half, p1[1] + perp[1] * half]],
      ],
      // 窗线（第三线）：沿墙**中线**从洞口一侧到另一侧 —— 门没有这一条（`null`）
      sash: kind === 'window' ? [p0, p1] : null,
      // 洞口矩形（命中区/选中底色都用它）—— 与 `holeQuad` 是同一份几何
      quad: holeQuad(wall, sp.opening),
      mid: [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2],
      dir,
    };
  });
}

/** 洞口的读屏/界面文案（两处要说同一句话） */
export function openingLabel(o) {
  const head = `净宽 ${o.w.toFixed(2)} m · 净高 ${o.h.toFixed(2)} m`;
  return kindOf(o) === WINDOW
    ? `窗 ${head} · 离地 ${sillOf(o).toFixed(2)} m`
    : `门洞 ${head}`;
}