/**
 * scheme.js —— 规则 5：方案文件格式（v4）导出 / 导入 / 校验（纯函数）
 *
 * 来源：原型 `$('save').onclick` 与 `$('file').onchange`。
 * 这是 R1 修得最重的一块（FIX-05「导出即丢数据」）：**写入端与读取端必须共用同一套限制**，
 * 否则就会重演"自己导出的文件自己导不回来"。所以在内核里，限制常数只有一份、在下面。
 *
 * 与原型唯一的差异（纯增强）：导入失败返回**分类原因**（原型 4 类失败共用一句提示，FIX-21）。
 */
/**
 * scheme.js —— 规则 5：方案文件格式（墙 = 对象那一代）导出 / 导入 / 校验（纯函数）
 *
 * 来源：原型 `$('save').onclick` 与 `$('file').onchange`。
 * 这是 R1 修得最重的一块（FIX-05「导出即丢数据」）：**写入端与读取端必须共用同一套限制**，
 * 否则就会重演"自己导出的文件自己导不回来"。所以在内核里，限制常数只有一份、在下面。
 *
 * ## W1 门洞：格式标识换代（docs/66 §2.2）
 *
 * 墙从 `[x1,z1,x2,z2]` 升成对象 `{a,b,openings}`（门洞要长在墙上，见 `wall.js`）。
 * 标识因此**换代**：`scene-space-designer`（数组那一代）降为**只读历史**，与三个
 * `demo-*` 并排保留 —— 用户手里已有的导出文件必须还能导入（兼容是功能，不是包袱）。
 *
 * 两条规矩照旧（`docs/31` 的先例）：
 *   · **新标识没有版本后缀** —— 标识说的是"哪一代格式"，以后再变再起一个新名字；
 * ## W2 窗：标识再换代（docs/78 §2.4）
 *
 * 洞口多了两种写法：门 `{at,w,h}`（与上一代逐字相同）、窗 `{at,w,h,kind,sill}`。
 * 形状是严格超集，为什么还要换代？**为了让老版本明确拒绝，而不是把窗当成能走人的落地洞**：
 * 沿用旧标识时，不含窗支持的构建会把 `kind`/`sill` 静默丢掉（那两处窄门），
 * 于是窗变成「从地面起的一个洞」——**看着对、其实错**，而且没有任何提示。
 * 换代之后那种构建会直接报 `bad-format`（响亮地错）。本项目的价值排序是「拒绝 > 静默错」。
 * 旧标识留在 `ACCEPTED_FORMATS` 里当**只读历史**：老文件照样打开，只是导出会写成新标识。
 *
 *   · **读取端宽容、写入端唯一** —— 导入在边界上归一化一次（数组 → 对象、老洞口 → 新洞口），导出一律只写新形状。
 *     "旧文件能不能逐字节导回"**不是判据**（`docs/31` 改名那批起就不成立：库里 5 行全被改写）。
 *     真正要钉的是**同代稳定**：`export(import(export(x))) === export(x)`。
 */

import { cfg } from './params.js';
import { normalizeWallStyle } from './wallstyle.js';
import { nextIdFor } from './placement.js';
import { roomLimits, roomRangeText } from './room.js';
import { cloneWall, readWall, wallSeg } from './wall.js';
import { checkWallOpenings } from './openings.js';
import { checkWall } from './validate.js';
import { cleanRoomLabels, openAreaTotal, roomsOf } from './rooms.js';
import { cloneColumn, columnCfg, columnNextId, readColumns } from './columns.js';

/**
 * ## W3 开放场景：标识再换代（docs/93 §3.2，docs/91 §五）
 *
 * 这一代多了**一个可选字段** `walls[].role`（`exterior` / `interior`），以及一条**语义换代**：
 * 房间不再是"矩形外框兜出来的面"，而是"边界全部由墙组成的闭合面"；矩形外框剩下的部分是
 * **开放场景**（院子、开口场地），它不是房间、不可命名、面积按剩余量算。
 *
 * 为什么加一个可选字段也要换代？与 W2 的理由同一条：**让老构建响亮地拒绝，而不是静默理解错**。
 * 老构建不认识 `role`，会把一面"院子围墙"当成普通内墙——于是设备不许靠、碰撞会挡，
 * 而且没有任何提示（看着对、结论错）。换代之后老构建直接 `bad-format`（这是想要的那声响）。
 *
 * 旧标识继续留在 {@link ACCEPTED_FORMATS} 里当**只读历史**：老文件照样打开，
 * 只不过按**旧语义**算房间（`layout.roomSemantics = 'legacy'`，由 `roomsOf` 消费），
 * 导出时一律写成新标识。两种语义的差别写进 {@link #importScheme} 的注释里 ——
 * 「旧方案导入后房间数不许悄悄变少」是这一代的兼容底线（docs/93 §4）。
 */
/**
 * ## W4 人员地面动线：标识再换代（docs/97 §四）
 *
 * `state.routes` 加了一条**可选**的持久化形状：`{id, name?, points:[[x,z],...]}`。
 * 只存用户点出的站点/途经点（2–20 个）—— 自动折线、长度、箭头、状态、颜色都是**派生量**，
 * 与"不存房间、不存开放面积"同一条纪律（存进去就等于同一个方案有两套事实）。
 *
 * 换代理由与 W2/W3 同一条：**让老构建响亮地拒绝，而不是把动线静默丢掉**。
 * 旧构建不认识 `routes`，保存一次就会把设计师点好的 A/B/C/D 静默抹掉；
 * 换代之后那种构建直接 `bad-format`。旧标识继续留在 {@link ACCEPTED_FORMATS} 里当只读历史，
 * 其中 W3 那一代（`-scene`，开放场景）**必须继续映射 `walls` 房间语义** ——
 * 否则已有开放场景方案重开时会被当成"外框兜底"，把院子误算回房间（docs/93 的回归）。
 */
export const FORMAT = 'scene-space-designer-scene-routes-columns';

/**
 * W4 那一代（人员动线）的标识：只读历史。
 * 新代码不要再把它当 `FORMAT` 用；保留常量是为了 Java 镜像和测试有唯一出处。
 */
export const W4_FORMAT = 'scene-space-designer-scene-routes';

/**
 * W3 那一代（开放场景）的标识：**只读历史，且语义是 `walls`**。
 *
 * 它不是"更老的旧格式"：开放场景的房间口径就是从这一代开始的。所以 `roomSemanticsOfFormat`
 * 必须把它和新标识一起算进 `walls` —— 只按"等于 FORMAT 吗"判断，会让 W3 方案重开时退回 legacy，
 * 院子被算成房间、开放面积变 0，而用户什么都没改（docs/97 §四特别点名的坑）。
 */
export const W3_FORMAT = 'scene-space-designer-scene';

/** 必须继续兼容的历史格式（用户手里已有这些文件） */
export const ACCEPTED_FORMATS = [
  FORMAT,
  W4_FORMAT,                       // W4 动线：只读历史
  W3_FORMAT,                       // W3 开放场景：只读历史，语义仍是 `walls`
  'scene-space-designer-windows',  // W2 那一代：窗（`kind`/`sill`），房间按矩形外框兜底
  'scene-space-designer-openings', // W1 那一代：洞口只有门（没有 `kind`/`sill`）
  'scene-space-designer',        // W1 之前那一代：墙是扁平数组 [x1,z1,x2,z2]
  'legacy-spatial-v2',
  'legacy-spatial-v3',
  'legacy-spatial-doors-v4',   // 历史标识：用户手里已有的导出文件必须还能导入
];

/**
 * 墙的角色（W3，docs/93 §3.1）：`exterior`（外墙）/ `interior`（内墙），**可选**。
 *
 * ⚠️ 缺省**不是**"内墙"，而是"按几何回退"（`room.wallRole`）—— 旧文件里没有这个字段，
 * 不能因为缺省就把旧方案的四面外墙当内墙：那会让 `checkItem` 突然开始挡设备、门扇净空开始报警，
 * 而用户什么都没改（docs/93 §3.1「旧文件不需要迁移，也不会被误读」）。
 *
 * **读取/写入的唯一来源是 `wall.js`**（`isWallRole` / `roleOf` / `readWall` / `cloneWall`）——
 * 本文件只声明「导出要带上它、顺序固定在 `openings` 之后」，不再自己抄一份校验：
 * 同一个形状两处读法，迟早一边改一边漏（W2 的 6 处手抄 `{at,w,h}` 就是这么来的）。
 */

/**
 * 房间派生语义（**内部字段**，不进 `state`）：`legacy` / `walls`。
 *
 * 它由**格式标识**决定，不是用户选项：
 *   · `legacy` = 旧标识导入：矩形外框参与闭合，正面积面就算房间（旧行为，房间数不许变）；
 *   · `walls`  = 新标识/新建：只有「边界全部由墙组成」的面才是房间，其余是开放场景。
 *
 * 这个字段随内存 layout 走（撤销/重做快照要带上），但 {@link #exportScheme} 的白名单
 * **不发射**它 —— 派生口径不是数据，写进文件就会变成"同一个文件两种事实"。
 * 读取器是 `rooms.roomSemanticsOf(layout)`（缺省 `legacy`：不认识这个字段的旧 layout 按旧语义算）。
 */
export const ROOM_SEMANTICS = { LEGACY: 'legacy', WALLS: 'walls' };

/**
 * 房间语义是 `walls` 的格式标识：W4（动线）与 W3（开放场景）。
 * 其余全部是只读历史 → `legacy`（矩形外框参与闭合）。
 *
 * ⚠️ 这张表是**代际判断的唯一出处**：加新一代格式时必须两边一起看 ——
 * 只加进 {@link ACCEPTED_FORMATS} 而忘了这里，新代方案重开就会静默退回旧语义。
 */
export const WALLS_SEMANTICS_FORMATS = [FORMAT, W4_FORMAT, W3_FORMAT];

/** 格式标识 → 房间语义：W4/W3 是 `walls`，其余都是只读历史 */
export function roomSemanticsOfFormat(format) {
  return WALLS_SEMANTICS_FORMATS.includes(format) ? ROOM_SEMANTICS.WALLS : ROOM_SEMANTICS.LEGACY;
}

/** 与原型一致的限制（写入端/读取端共用这一份） */
export const LIMITS = {
  /** 一律用 getter：读的时候才取当前配置值。写成普通字段会在导入期被"抄"成常量，配置就永远不生效 */
  get fileBytes() { return cfg.scheme.maxFileBytes; },
  get items() { return cfg.layout.maxItems; },
  get walls() { return cfg.layout.maxWalls; },
  get coord() { return cfg.scheme.maxCoordM; },
  get minWallLength() { return cfg.scheme.minWallLengthM; },
  get routes() { return cfg.route.maxRoutes; },
  get routePoints() { return cfg.route.maxPoints; },
  get columns() { return columnCfg().maxCount; },
  get room() { return roomLimits(); },
};

/** 导入失败原因（FIX-21：让 UI 能说清"到底哪里不对"） */
export const IMPORT_ERROR = {
  NOT_JSON: { reason: 'not-json', message: '无法导入：文件不是有效的 JSON' },
  BAD_FORMAT: { reason: 'bad-format', message: '无法导入：不是本应用的方案文件（格式标识不符）' },
  get BAD_ROOM() { return { reason: 'bad-room', message: `无法导入：空间尺寸超出范围（${roomRangeText()}）` }; },
  get TOO_MANY_ITEMS() { return { reason: 'too-many-items', message: `无法导入：设备数量超过上限（${cfg.layout.maxItems} 台）` }; },
  get TOO_MANY_WALLS() { return { reason: 'too-many-walls', message: `无法导入：墙体数量超过上限（${cfg.layout.maxWalls} 面）` }; },
  BAD_ITEM: { reason: 'bad-item', message: '无法导入：设备数据不合法（型号、编号、坐标或角度异常）' },
  DUP_ID: { reason: 'duplicate-id', message: '无法导入：设备编号重复' },
  get BAD_WALL() { return { reason: 'bad-wall', message: `无法导入：墙体数据不合法（需水平/垂直且长度 ≥${cfg.scheme.minWallLengthM} m）` }; },
  WALL_OUT_OF_ROOM: { reason: 'wall-out-of-room', message: '无法导入：有墙体落在空间之外' },
  BAD_OPENING: { reason: 'bad-opening', message: '无法导入：门洞数据不合法（洞口跑到墙外、比墙高、或两个洞重叠）' },
  // W4 动线（docs/97 §四）：**结构**不对就整份拒绝，不静默跳过 ——
  // 静默丢一条动线，等于用户画好的参观路线在一次保存之后消失了，而且没有任何提示。
  BAD_ROUTE: { reason: 'bad-route', message: '无法导入：动线数据不合法（每条动线需要 2–20 个 [x,z] 点，id 为不重复的正整数）' },
  DUP_ROUTE_ID: { reason: 'duplicate-route-id', message: '无法导入：动线编号重复' },
  get TOO_MANY_ROUTES() { return { reason: 'too-many-routes', message: `无法导入：动线数量超过上限（${cfg.route.maxRoutes} 条）` }; },
  ROUTE_OUT_OF_ROOM: { reason: 'route-out-of-room', message: '无法导入：有动线的点落在场景之外' },
  // W5 矩形柱（docs/101 §2.3）：结构/编号/边界/尺寸/数量不合法才拒绝；
  // 柱-柱/设备/洞口的关系冲突**导入宽容**（打开后由 checkColumn 报，不拦文件）。
  BAD_COLUMN: { reason: 'bad-column', message: '柱数据不合法（每条柱需要 id 与 x/z/w/d）' },
  DUP_COLUMN_ID: { reason: 'duplicate-column-id', message: '柱编号重复' },
  COLUMN_OUT_OF_SCENE: { reason: 'column-out-of-scene', message: '柱必须完整在场景内' },
  get COLUMN_TOO_SMALL() { return { reason: 'column-too-small', message: `柱边长小于下限（${columnCfg().minSideM} m）` }; },
  get COLUMN_TOO_LARGE() { return { reason: 'column-too-large', message: `柱边长超过上限（${columnCfg().maxSideM.toFixed(2)} m）` }; },
  get TOO_MANY_COLUMNS() { return { reason: 'too-many-columns', message: `柱数量超过上限（${columnCfg().maxCount} 根）` }; },
  GENERIC: { reason: 'invalid', message: '无法导入：请使用本应用导出的有效方案文件' },
};

/**
 * 动线（W4）：读端 → 内存形状。**只做结构校验，不寻路**（寻路在 `route.js`，服务端不重写）。
 *
 * 判据（docs/97 §四冻结）：
 *   · 最多 `cfg.route.maxRoutes` 条；单条 2–`cfg.route.maxPoints` 个 `[x,z]` 点；
 *   · `id` 为正整数、方案内唯一（由 `max(id)+1` 分配，不建独立计数器）；
 *   · 点在场景矩形 `[0,w]×[0,d]` 内 —— 浮点残差给 1e-6 容差（与外墙容差同一条纪律：
 *     UI 算出来的 `8.000000000000002` 不该让一份合法方案打不开）。
 *   · `name` 是**装饰性**字段：非字符串当没写、**不截断**（与 `roomLabels` 同一条规矩；
 *     20 字上限归写入端）。不为一个名字让整份方案打不开。
 *
 * @returns {{ok:true, routes:Array}|{ok:false, reason:string, message:string}}
 */
function readRoutes(raw, w, d) {
  if (raw === undefined || raw === null) return { ok: true, routes: [] };
  if (!Array.isArray(raw)) return { ok: false, ...IMPORT_ERROR.BAD_ROUTE };
  if (raw.length > LIMITS.routes) return { ok: false, ...IMPORT_ERROR.TOO_MANY_ROUTES };
  const out = [];
  const seen = new Set();
  for (const r of raw) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return { ok: false, ...IMPORT_ERROR.BAD_ROUTE };
    if (!Number.isInteger(r.id) || r.id < 1) return { ok: false, ...IMPORT_ERROR.BAD_ROUTE };
    if (seen.has(r.id)) return { ok: false, ...IMPORT_ERROR.DUP_ROUTE_ID };
    seen.add(r.id);
    const points = r.points;
    if (!Array.isArray(points) || points.length < 2 || points.length > LIMITS.routePoints) {
      return { ok: false, ...IMPORT_ERROR.BAD_ROUTE };
    }
    const clean = [];
    for (const p of points) {
      if (!Array.isArray(p) || p.length !== 2 || !p.every(isFiniteNum)) return { ok: false, ...IMPORT_ERROR.BAD_ROUTE };
      const tol = 1e-6;
      if (p[0] < -tol || p[0] > w + tol || p[1] < -tol || p[1] > d + tol) {
        return { ok: false, ...IMPORT_ERROR.ROUTE_OUT_OF_ROOM };
      }
      clean.push([p[0], p[1]]);
    }
    // 字段顺序与写端同一份：id → name? → points（内存形状与文件形状一致，比较/快照都不会飘）
    const route = { id: r.id };
    if (typeof r.name === 'string' && r.name !== '') route.name = r.name;
    route.points = clean;
    out.push(route);
  }
  return { ok: true, routes: out };
}

/**
 * 一条动线 → **写入形状**：`{id, name?, points}`（`name` 有值才写；顺序固定 id → name → points）。
 * 空 `routes` 由调用方整个字段省掉 —— 旧方案导出字节不被无意义改写。
 */
function routeForFile(route) {
  const out = { id: route.id };
  if (typeof route.name === 'string' && route.name !== '') out.name = route.name;
  out.points = route.points.map((p) => [p[0], p[1]]);
  return out;
}

/** 导出：与原型完全一致的 JSON 文本（缩进 2） */
export function exportScheme(layout, { indent = 2 } = {}) {
  const state = {
    w: layout.w, d: layout.d, h: layout.h,
    // 墙一律写成**对象**（`cloneWall`：`a, b, openings?, role?` —— 有值才写，顺序固定）——
    // 旧墙没有 `role`，导出字节不变；新墙同代可逐字节往返（及 Java 侧镜像）
    walls: layout.walls.map((wl) => cloneWall(wl)),
    // 柱（W5，可选）：空数组**不发射** —— 无柱旧方案导出字节不变。
    // 位置固定在 walls 之后、items 之前；每根顺序 id → x → z → w → d（Java 同序）。
    ...(Array.isArray(layout.columns) && layout.columns.length
      ? { columns: layout.columns.map((c) => cloneColumn(c)) }
      : {}),
    items: layout.items.map((i) => ({ id: i.id, p: i.p, x: i.x, z: i.z, r: i.r, doorAmount: i.doorAmount ?? 0 })),
  };
  // 动线（W4，可选）：**只在真有动线时写** —— 空 `routes` 不发射，旧方案导出字节不被无意义改写
  // （与 `view` / `roomLabels` 同一条规矩）。字段顺序在 `items` 之后、`view` 之前。
  // 只写用户点出的站点：自动折线/长度/状态/颜色都是派生量，**不进 state**（docs/97 §四）。
  const routes = Array.isArray(layout.routes) ? layout.routes : [];
  if (routes.length) state.routes = routes.map((r) => routeForFile(r));
  // 视图档位**进方案**：交付包的截图是浏览器现画的，不写进方案的话，
  // 同一次交付会因"谁点的导出"而长得不一样 —— 方案要可复现。
  const style = normalizeWallStyle(layout.view?.wallOpacity);
  if (style) state.view = { wallOpacity: style };
  // 房间名（M1a，可选）：**只在真有名字时写**。没名字就不写这个字段 ——
  // 于是"旧文件（连字段都没有）"与"新文件但没命名"长得一模一样，同代往返逐字节稳定。
  // 房间本身是**派生**的（`roomsOf`），永远不进 state（判据：导出里不许出现 `rooms`）。
  // 名字表**照它自己的顺序**写回去、不按"房间现在存不存在"过滤（与 Java 侧逐字节镜像同一份规则，
  // 理由见 `rooms.js` 的 `cleanRoomLabels`）
  const labels = cleanRoomLabels(layout.roomLabels);
  if (Object.keys(labels).length) state.roomLabels = labels;
  return JSON.stringify({ format: FORMAT, state }, null, indent);
}

const bad = (e) => ({ ok: false, ...e });
const isFiniteNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * 校验并解析（可传文本或已解析对象）——逐条对齐原型，但返回分类原因。
 * @param {object} [opts] opts.getProduct 传入型号目录则校验型号是否存在（原型行为）；
 *                       不传时内核保持"无目录依赖"，便于服务端单独做结构校验。
 */
export function importScheme(input, { getProduct = null } = {}) {
  let raw;
  if (typeof input === 'string') {
    try { raw = JSON.parse(input); } catch { return bad(IMPORT_ERROR.NOT_JSON); }
  } else raw = input;
  if (!raw || typeof raw !== 'object') return bad(IMPORT_ERROR.NOT_JSON);

  const s = raw.state;
  if (!ACCEPTED_FORMATS.includes(raw.format) || !s) return bad(IMPORT_ERROR.BAD_FORMAT);

  if (![s.w, s.d, s.h].every(isFiniteNum)) return bad(IMPORT_ERROR.BAD_ROOM);
  if (s.w < LIMITS.room.w[0] || s.w > LIMITS.room.w[1]) return bad(IMPORT_ERROR.BAD_ROOM);
  if (s.d < LIMITS.room.d[0] || s.d > LIMITS.room.d[1]) return bad(IMPORT_ERROR.BAD_ROOM);
  if (s.h < LIMITS.room.h[0] || s.h > LIMITS.room.h[1]) return bad(IMPORT_ERROR.BAD_ROOM);

  if (!Array.isArray(s.items)) return bad(IMPORT_ERROR.BAD_ITEM);
  if (s.items.length > LIMITS.items) return bad(IMPORT_ERROR.TOO_MANY_ITEMS);
  if (!Array.isArray(s.walls)) return bad(IMPORT_ERROR.BAD_WALL);
  if (s.walls.length > LIMITS.walls) return bad(IMPORT_ERROR.TOO_MANY_WALLS);

  // 视图档位是**可选**偏好：认得的收下，不认得的**忽略**（不报错 —— 未来版本的档位
  // 不该让一份合法方案打不开；也不猜，宁可回默认）。
  const viewStyle = normalizeWallStyle(s.view?.wallOpacity);
  const itemsOk = s.items.every((i) => i && typeof i.p === 'string'
    && (!getProduct || !!getProduct(i.p))
    && (i.doorAmount === undefined || (isFiniteNum(i.doorAmount) && i.doorAmount >= 0 && i.doorAmount <= 1))
    && [i.id, i.x, i.z, i.r].every(isFiniteNum)
    && Number.isInteger(i.id)
    && i.r >= 0 && i.r < 360
    && Math.abs(i.x) <= LIMITS.coord && Math.abs(i.z) <= LIMITS.coord);
  if (!itemsOk) return bad(IMPORT_ERROR.BAD_ITEM);
  if (new Set(s.items.map((i) => i.id)).size !== s.items.length) return bad(IMPORT_ERROR.DUP_ID);

  // 墙判据：**斜墙合法**（两点之间的直墙都行），所以不再要求横平竖直 ——
  // 只要求「坐标有限 + 长度够 + 端点落在房间内」（最后一条由下面的 wallOut 兜住）。
  // 形状由 `readWall` 宽容归一化：**老文件是数组、新文件是对象**，下游只面对对象一种形状。
  // W3：`role` 由 `readWall` 宽容读（合法才带、认不得/缺省当没写，不因此拒整份文件）。
  const walls = s.walls.map((v) => readWall(v));
  const wallsOk = walls.every((w) => w
    && [w.a[0], w.a[1], w.b[0], w.b[1]].every((v) => Math.abs(v) <= LIMITS.coord)
    && Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]) >= LIMITS.minWallLength);
  if (!wallsOk) return bad(IMPORT_ERROR.BAD_WALL);
  // B19：墙还必须落在房间范围内。写入端不会产生越界墙（画墙有吸附），但**手改过的文件**会 ——
  // 原先只查"水平/垂直 + 长度"，一面待在房间外的墙会被原样收下（它不挡设备、也不进任何结论）。
  // 外墙正好贴在边界上（x=0..w），所以这条判据对它们是**恰好合法**，不用特判。
  // ⚠️ 这里**调用写入端那个函数**（`validate.checkWall`），不再自己写一遍比较 ——
  //    两处各写一次，迟早一边改了另一边没改（M1a 就当场发生过：外墙那条跳过让"戳出整栋的外墙"
  //    写端放过、读端拒绝）。读端与写端共用一份口径是 FIX-05 的全部内容。
  const probe = { w: s.w, d: s.d, h: s.h, walls, items: [] };
  if (walls.some((w) => checkWall(probe, w) !== null)) return bad(IMPORT_ERROR.WALL_OUT_OF_ROOM);
  // 门洞：**只查结构**（跑到墙外 / 比墙高 / 两洞重叠 / 个数超格式上限）。
  // 与可编辑参数有关的边界（最小净宽、离墙角间隙、每墙上限）**不在导入侧拒绝** ——
  // 那些参数是现场可改的策略，拿"今天的策略"去拒"昨天导出的文件"就是在制造 FIX-05 的反面。
  for (const w of walls) {
    if (checkWallOpenings(w, s.h, 'tolerant')) return bad(IMPORT_ERROR.BAD_OPENING);
  }

  // 房间名（M1a，可选）：与视图档位同一个宽容口径 —— 只收"字符串键 + 字符串值"，
  // 别的形状当没写（不为一个装饰性字段让一份合法方案打不开）；名称本身**不截断**（见 `readRoomLabel`）。
  const labels = cleanRoomLabels(s.roomLabels);
  // 柱（W5，可选）：缺省空；结构/编号/边界/尺寸/数量不合法整份拒绝。
  // 关系冲突（叠柱/压设备/压洞口）在导入侧**不拒绝** —— 旧文件/手改文件的冲突要在打开后
  // 由 `columns.checkColumn` 报，不能因此让整份方案打不开。
  const columns = readColumns(s.columns, { w: s.w, d: s.d, getProduct });
  if (!columns.ok) return bad(columns);
  // 动线（W4，可选）：坏形状**整份拒绝**（静默丢一条 = 用户画好的参观路线在一次保存后消失）。
  // 服务端只校验结构，不寻路（寻路在内核 `route.js`，不为交付清单写第二套）。
  const routes = readRoutes(s.routes, s.w, s.d);
  if (!routes.ok) return bad(routes);
  const layout = {
    w: s.w, d: s.d, h: s.h,
    walls: walls.map((w) => cloneWall(w)),
    columns: columns.columns,
    items: s.items.map((i) => ({ id: i.id, p: i.p, x: i.x, z: i.z, r: i.r, doorAmount: i.doorAmount ?? 0 })),
    // 动线（W4）：读进来的站点原样挂在 layout 上（缺省空数组 —— 旧文件没有这个字段）
    routes: routes.routes,
    // 档位认出来了就挂上（认不得的已经被 normalizeWallStyle 变成 null → 不写）
    ...(viewStyle ? { view: { wallOpacity: viewStyle } } : {}),
    ...(Object.keys(labels).length ? { roomLabels: labels } : {}),
    // 房间派生语义（W3）：由**文件标识**决定，不是用户选项。
    // 旧标识 → legacy（外框参与闭合，房间数与旧行为逐条相同）；新标识 → walls（开放场景两分）。
    // ⚠️ 这个字段**不进 state**（导出白名单没有它）：写进文件就会变成"同一份文件两种事实"。
    roomSemantics: roomSemanticsOfFormat(raw.format),
  };
  return {
    ok: true, layout, nextId: nextIdFor(layout), nextColumnId: columnNextId(layout),
    format: raw.format, roomSemantics: layout.roomSemantics,
  };
}


/**
 * 旧方案转换预检（P4 用；**纯函数，不写 state、不改输入**）。
 *
 * ## 它回答什么问题
 *
 * 房间口径换代之后，同一份墙在两种语义下**不是同一批房间**：
 * legacy（旧标识）用矩形外框兜底，walls（新一代）只认"边界全部由墙组成"的面。
 * 于是一份"少画了一面外墙"的旧方案，旧语义下是 1 间房（外框把缺口补上了），
 * 新语义下是 **0 间房 + 48 m² 开放场景** —— 这就是 docs/93 §4.2 说的**有损转换**。
 * 用户不该在按下保存的那一刻才发现"我的房间没了"，所以保存前先跑这一份报告。
 *
 * ## 为什么放在内核、为什么不改输入
 *
 * 两种语义的差别只体现在 `roomsOf` 读的 `layout.roomSemantics` 上，所以做法是：
 * **同一份墙复制两份**，分别标 legacy / walls，各跑一次 `roomsOf` —— 面遍历仍然只有一份实现，
 * 界面（P4 的 SchemePanel）不许自己再算一遍（那正是本项目最贵的教训）。
 * 输入 layout 的 `roomSemantics` 一个字都不动：预检不是转换，用户还没决定要不要转。
 *
 * @returns {{
 *   ok: boolean, error: string|null,
 *   lossy: boolean,            // 房间数变了、或者有房间名要掉 → 保存前必须让用户看见并确认
 *   roomsBefore: number,       // legacy 语义下的房间数（旧方案导入后用户看到的数）
 *   roomsAfter: number,        // walls 语义下的房间数（保存升代之后会变成的数）
 *   labelsKept: number,        // 转换后仍能挂回某间房的房间名个数
 *   droppedLabels: number,     // 转换后**挂不回去**的房间名个数（房间变开放/消失）
 *   droppedLabelNames: string[], // 上面那些名字本身（按输入顺序；界面直接列出来，不另算）
 *   openAreaM2: number,        // walls 语义下的开放面积（legacy 恒 0）
 * }}
 */
export function legacyConvertReport(layout) {
  if (!layout || !Array.isArray(layout.walls)) {
    return {
      ok: false, error: 'layout 缺少 walls（这份报告要在合法 layout 上跑）',
      lossy: false, roomsBefore: 0, roomsAfter: 0,
      labelsKept: 0, droppedLabels: 0, droppedLabelNames: [], openAreaM2: 0,
    };
  }
  // 两份副本：墙深拷（roomSemantics 只影响派生，不影响墙本身），输入保持原样
  const withSemantics = (semantics) => ({
    ...layout,
    walls: layout.walls.map((w) => cloneWall(w)),
    roomSemantics: semantics,
  });
  try {
    const legacy = withSemantics(ROOM_SEMANTICS.LEGACY);
    const walls = withSemantics(ROOM_SEMANTICS.WALLS);
    const before = roomsOf(legacy);
    const after = roomsOf(walls);
    const beforeIds = new Set(before.map((r) => r.id));
    const afterIds = new Set(after.map((r) => r.id));
    const labels = cleanRoomLabels(layout.roomLabels);
    const kept = Object.keys(labels).filter((id) => afterIds.has(id));
    // 掉的 = 转换前挂得上某间房、转换后挂不上了的名字。
    // 转换前就挂不上的「在等房间」老名字不算掉（它本来就没地方挂，得留着等墙围回去）。
    const dropped = Object.keys(labels).filter((id) => beforeIds.has(id) && !afterIds.has(id));
    return {
      ok: true,
      error: null,
      // "有损"只算**变少或掉名**：房间变多也是变化，但它不丢东西 —— 由 roomsBefore/After 如实给读数
      lossy: after.length < before.length || dropped.length > 0,
      roomsBefore: before.length,
      roomsAfter: after.length,
      labelsKept: kept.length,
      droppedLabels: dropped.length,
      droppedLabelNames: dropped.map((id) => labels[id]),
      openAreaM2: openAreaTotal(walls),
    };
  } catch (err) {
    // 几何离谱到面遍历都跑不完时**如实说**，不假装"没有损失"
    return {
      ok: false, error: String(err?.message ?? err),
      lossy: false, roomsBefore: 0, roomsAfter: 0,
      labelsKept: 0, droppedLabels: 0, droppedLabelNames: [], openAreaM2: 0,
    };
  }
}

/** 文件大小预检（原型 `file.size > 1e6` 直接 throw） */
export function checkFileSize(bytes) {
  return bytes <= LIMITS.fileBytes
    ? { ok: true }
    : { ok: false, reason: 'too-large', message: `无法导入：文件过大（上限 ${LIMITS.fileBytes / 1000} KB）` };
}