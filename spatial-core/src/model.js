/**
 * model.js —— 模型层契约（纯函数：不依赖 Three.js）
 *
 * 来源：原型 `makeProduct()` 的缩放（R1 的 FIX-09）。
 * 原来三轴各算一次比例，比例来自**实测包围盒**（含外凸把手），于是三个比例不相等 →
 * 铰链在非等比父节点下旋转被剪切变形（开门动画变成斜拉的平行四边形）。
 *
 * 现在的口径（R1 定、这里固化）：
 *   2D 占地矩形 = **声明包络**（envelope，不含凸出物）
 *   3D 模型按 `min` 三轴比例**等比**缩放 → 模型恒 ⊆ 矩形，把手不会"长到隔壁设备身上"
 *   代价：矩形内少量留白（比越界/变形划算）
 */
import { cfg } from './params.js';

// 参数见 params.js（原常量 ANISOTROPY_WARN）：cfg.model.anisotropyWarn

/**
 * 等比缩放系数。
 * @param {{w:number,h:number,d:number}} envelope 声明包络尺寸（米，不含凸出物）
 * @param {{w:number,h:number,d:number}} bbox 模型实测包围盒（米，含把手/脚轮）
 * @returns {number} 三轴比例的最小值（保证内接）
 */
export function uniformScale(envelope, bbox) {
  // 先验输入：缺值/0/负数一律拒绝。原型会静默产出 Infinity/NaN 比例 →
  // 几何体变成 NaN 并污染后续包围盒（FIX-26 记录的同类隐患）
  const vals = [envelope?.w, envelope?.h, envelope?.d, bbox?.w, bbox?.h, bbox?.d];
  if (!vals.every((v) => Number.isFinite(v) && v > 0)) throw new Error('模型包络或包围盒尺寸不合法');
  const s = Math.min(envelope.w / bbox.w, envelope.h / bbox.h, envelope.d / bbox.d);
  if (!Number.isFinite(s) || s <= 0) throw new Error('模型包络或包围盒尺寸不合法');
  return s;
}

/**
 * 各向异性倍数（1 = 完全等比）。用于开发期发现"模型被拉变形"，也是模型入库校验项：
 * > cfg.model.anisotropyWarn 说明包络与模型本体口径不一致，应回问提供方。
 */
export function anisotropy(envelope, bbox) {
  const r = [envelope.w / bbox.w, envelope.h / bbox.h, envelope.d / bbox.d];
  return Math.max(...r) / Math.min(...r);
}

/** 等比缩放下模型是否一定落在占地矩形内（FIX-09 的核心不变量） */
export function fitsFootprint(envelope, bbox) {
  const s = uniformScale(envelope, bbox);
  return bbox.w * s <= envelope.w + 1e-9 && bbox.d * s <= envelope.d + 1e-9;
}

/** 模型入库/展示前的口径自检：尺寸是否经核实（原型 userData.dimensionsVerified） */
export function dimensionsNote(envelope, bbox) {
  const a = anisotropy(envelope, bbox);
  return a > cfg.model.anisotropyWarn
    ? { verified: false, anisotropy: a, note: '包络与模型本体口径不一致，尺寸待核实' }
    : { verified: true, anisotropy: a, note: '口径一致' };
}