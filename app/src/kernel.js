/**
 * kernel.js —— 前端与业务内核之间的唯一接口
 *
 * 界面**只**通过这里调用规则，不自己算业务判断。
 * 这样做的直接好处：前端永远不可能"偷偷实现一版自己的规则"——
 * 而这正是原型那个"导出即丢数据"bug 的成因（写入端与读取端各有一套限制）。
 *
 * 内核位置：`../spatial-core/src`（vite alias `@core`），是**源码**不是打包副本。
 */

import * as params from '@core/params.js';
import * as geometry from '@core/geometry.js';
import * as room from '@core/room.js';
import * as validate from '@core/validate.js';
import * as placement from '@core/placement.js';
import * as scheme from '@core/scheme.js';
import * as doors from '@core/doors.js';
import * as model from '@core/model.js';
import * as collision from '@core/collision.js';
import * as clearance from '@core/clearance.js';
import * as openings from '@core/openings.js';
import * as rooms from '@core/rooms.js';
import * as wall from '@core/wall.js';
import { createHistory } from '@core/history.js';

// 目录查找统一住在 src/catalog.js（**运行时**：服务端优先、本地资产兜底）。
// 这里**不再导出 CATALOG 这个数组绑定** —— 它是会被整体替换的东西，
// 导出成绑定就会有人拿着旧的那一份算，而界面显示的是新的。
import { catalogState, getProduct, onCatalogChange, productLabel, productModel } from './catalog.js';

export {
  params, geometry, room, validate, placement, scheme, doors, model, collision, clearance, openings, rooms, wall,
  createHistory, getProduct, productLabel, productModel, catalogState, onCatalogChange,
};

// B19：墙的合法性检查从**同一个出口**出去 —— 界面不许自己去 @core 里另找一个入口，
// 那就等于给同一件事开第二条路，下一个人会以为它们是两件事。
export const { checkAllWalls } = validate;

/**
 * 界面里能直接引用的边界值（一律来自内核，界面不写死数字）
 *
 * ⚠️ **必须是 getter**。这里原来是普通属性 —— 那就是参数表头注释里点名不许犯的错：
 * 「不要在导入期把它抄进常量（`const X = cfg.door.openOkDeg` 会让配置永远不生效）」。
 * 后果在 R6-4 上线参数发布之后才显形：后台把 `layout.maxItems` 从 100 改成 150，
 * 内核算得对，而**界面上的提示还写着 100** —— 界面说的和算的不是一回事。
 * getter 每次访问都现取，调用处一个字都不用改。
 */
export const LIMITS = {
  get room() { return room.roomLimits(); },              // 长宽 3–20 m，高 2–5 m（读参数表）
  get items() { return params.cfg.layout.maxItems; },    // 默认 100 台（读参数表）
  get walls() { return params.cfg.layout.maxWalls; },    // 默认 100 面（读参数表）
  get file() { return scheme.LIMITS.fileBytes; },        // 1 MB
  get minWall() { return scheme.LIMITS.minWallLength; },
};

export const MSG = { ...placement.MSG, ...scheme.IMPORT_ERROR };

/** 门相关的扁平再导出：界面直接 `canOpen(...)`，不必写 `doors.canOpen(...)` */
export const {
  canOpen, clampDoorAmount, isDoorOpen, doorStateText, doorButtonLabel, doorPartLabel,
} = doors;

/**
 * 规则 7 的"主动提示"：自动摆放后的一句话（接缝 A 的 C 方案）—— 纯提示，不阻断放置。
 * 都开得到底时返回 ''，界面就照旧只说"已放入…"。
 */
export const { doorTroubleClause } = clearance;

/** 原因码 → 用户语言（FIX-21 的落地：不同失败给不同话术） */
const REASON_TEXT = {
  'out-of-room': '超出房间范围',
  'hit-wall': '与墙体冲突',
  'unknown-product': '未知型号',
};

export function reasonText(reason) {
  if (!reason) return '布局已就绪';
  if (reason.startsWith('overlap-item#')) return `与设备 #${reason.split('#')[1]} 重叠`;
  return REASON_TEXT[reason] ?? reason;
}

export function reasonShort(reason) {
  if (!reason) return '正常';
  if (reason.startsWith('overlap-item#')) return `与 #${reason.split('#')[1]} 重叠`;
  return REASON_TEXT[reason] ?? reason;
}

/** 逐台设备算合法性（界面用它标红具体哪一台，而不是只给一句总数） */
export function issuesOf(layout) {
  return layout.items
    .map((item) => ({ item, reason: validate.checkItem(layout, item, getProduct) }))
    .filter((x) => x.reason);
}

/**
 * 逐台设备算"门最多能开多少度"（规则 7，接缝 A 的 A3 决策）。
 * 与 issuesOf **并列**：它不阻挡放置，只是把"这么摆用不用得上"告诉用户。
 */
export function clearanceOf(layout) {
  return clearance.clearanceReport(layout, getProduct).map((row) => ({
    ...row,
    text: clearance.clearanceText(row, getProduct),
    hint: clearance.clearanceHint(row),
    skipText: clearance.clearanceSkipText(row),
  }));
}

/**
 * 房间面积（m²）—— **原值**，这里不取整。
 *
 * ⚠️ 这里原来写着 `Math.round(w * d * 10) / 10`。房间尺寸已经是毫米口径（4.05 × 3.05），
 *    内核再偷偷抹到一位，界面就show不出 12.35 —— 变成 12.4，"用户刚设的尺寸被藏掉了"。
 *    取整属于**显示**，不属于内核：要几位由 `fmt.js` 的 `fmtArea` 说了算。
 */
export function areaOf(layout) {
  return layout.w * layout.d;
}

/** 设备占地总面积（m²，含旋转外接框口径） */
export function footprintOf(layout) {
  const sum = layout.items.reduce((acc, i) => {
    const p = getProduct(i.p);
    if (!p) return acc;
    const e = geometry.extents(p.w, p.d, i.r);
    return acc + e.w * e.d;
  }, 0);
  return Math.round(sum * 10) / 10;
}