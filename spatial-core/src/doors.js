/**
 * doors.js —— 规则 4：门语义（纯函数）
 *
 * 来源：原型 `setDoorAmount()` / `applyDoorAmount()` 与模型工厂的 `setDoor()`。
 * 搬运时合并了一处**重复实现**：`h.node.rotation[h.axis] = h.openAngle * amount`
 * 原本在两处各写了一遍（主脚本 + 工厂）——两份迟早会漂移，现在只有这一份。
 *
 * 门=「铰链节点 + 轴 + 最大开角」构成：铰链信息来自模型（配方 pivots 或节点 extras，
 * 见 设计决策记录），因此**门能不能开是模型属性，不是 UI 判断**。
 */
import { cfg } from './params.js';

// 参数见 params.js（原常量 DOOR）：cfg.door.amountMin, cfg.door.amountMax

/** 当前模型缺少门体节点时给用户的原话 */
export const NO_HINGES = '当前模型缺少门体节点，请更新开门版模型';

/** 门能不能开：模型是否带铰链（原型 `currentModel.hinges.length > 0`，散落在两处 → FIX-12） */
export function canOpen(model) {
  return Array.isArray(model?.hinges) && model.hinges.length > 0;
}

export function clampDoorAmount(v) {
  if (!Number.isFinite(v)) return 0;
  return Math.max(cfg.door.amountMin, Math.min(cfg.door.amountMax, v));
}

export function isDoorOpen(amount) {
  return amount > 0;
}

/**
 * 铰链旋转量：`rotation[axis] = openAngle × amount` —— 全项目唯一的公式。
 * @param {{axis:string, openAngle:number}} hinge
 */
export function hingeRotation(hinge, amount) {
  return { [hinge.axis]: hinge.openAngle * clampDoorAmount(amount) };
}

/**
 * 门型代码 → 中文文案（**全项目唯一一份**）
 *
 * 代码共 4 个，与 `product.door_part` 那一列同值（V8 起的口径）：
 *   single 单开（立式前门，绕竖轴） ｜ double 双开（对开，绕竖轴）
 *   top    顶开（上盖，绕水平轴）    ｜ drawer 抽拉（预留，暂无产品）
 *   none   无门（整机一体 / 无可动件）—— **已验证的事实**，与「空值（未确认）」不是一回事
 *
 * 为什么要代码化：中文当枚举在库里是**工程债** —— 不好索引、没法做多语言、代码里容易写错别字。
 * 更根本的是：门型是**产品事实**（厂家的叫法），**不是几何的函数**
 * （实测证据：demo-freezer-dual 实测门只有 1 扇，但产品本身是双门 —— 见 V6 的注释）。
 */
export const DOOR_PART_LABELS = { single: '柜门', double: '双门', top: '上盖', drawer: '抽屉', none: '无门' };

const warnedParts = new Set();

/**
 * 部位文案。
 *
 * ⚠️ 参数是**门型代码**（`product.doorPart`），**不是产品 id**。
 * 这里以前是按型号名写死的（demo-freezer-chest→上盖），那是"同一件事两处说"：
 * 库里一列、代码里一段 —— 现在真相只住在那一列。
 *
 * 过渡期兼容：认不出的值**原样显示**（老库里可能还是中文），并且**吼一声**
 * （每个值只吼一次，不许安静）。
 *
 * ⚠️ 空值不再兜底「柜门」：**没填 ≠ 没有门，也不等于柜门**。旧兜底会凭空造出一扇门，
 * 让「门型未确认」的产品看起来像有柜门。空值如实说「未确认」；确无门时数据里写 none。
 */
export function doorPartLabel(part) {
  const raw = typeof part === 'string' ? part.trim() : '';
  const hit = Object.prototype.hasOwnProperty.call(DOOR_PART_LABELS, raw) ? DOOR_PART_LABELS[raw] : null;
  if (hit) return hit;
  if (raw) {
    if (!warnedParts.has(raw)) {
      warnedParts.add(raw);
      console.warn('[doors] 认不出的门型代码「' + raw + '」—— 原样显示。'
        + 'product.door_part 应为 single|double|top|drawer|none（V8 口径）');
    }
    return raw;
  }
  return '未确认';   // 空值 = 不知道，不是柜门（见上）
}

/** 按钮文案：打开/关闭 + 部位 */
export function doorButtonLabel(part, amount) {
  return (isDoorOpen(amount) ? '关闭' : '打开') + doorPartLabel(part);
}

/** 状态文案（原型 `doorState`） */
export function doorStateText(amount) {
  const a = clampDoorAmount(amount);
  return a === 0 ? '已关闭' : `已打开 ${Math.round(a * 100)}%`;
}

/** 把门开度写进方案（纯函数：返回新布局） */
export function setDoorAmount(layout, itemId, amount) {
  const a = clampDoorAmount(amount);
  return {
    ...layout,
    items: layout.items.map((i) => (i.id === itemId ? { ...i, doorAmount: a } : i)),
  };
}

/** 开门净空提示（供平面图/漫游使用；尺寸来自模型交付规范 meta.json 的 clearance） */
export function clearanceOf(product) {
  return Number.isFinite(product?.clearanceOpenMm) ? product.clearanceOpenMm / 1000 : null;
}