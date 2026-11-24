/**
 * wallstyle.js —— 外墙"外观档位"的唯一出处
 *
 * 为什么要有它：档位是**关键词**（`solid` / `half` / `light`），不是数字。
 * 数字会让"半透明"随参数表变来变去，于是同一份方案在两个时间点导出的交付图不一样 ——
 * 方案要**可复现**，所以进了方案的东西必须是稳定的名字。
 *
 * 参数表里的 `space.wallOpacity` 只负责"**没选过的方案**默认多透"（默认 1 = 实心，
 * 也就是今天的样子 —— 它是个 opt-in 的美观选项，不该悄悄改掉所有人的图）。
 */
export const WALL_STYLES = {
  solid: { label: '实心', opacity: 1 },
  half: { label: '半透明', opacity: 0.6 },
  light: { label: '很透', opacity: 0.35 },
};

export const WALL_STYLE_KEYS = ['solid', 'half', 'light'];

/** 认得的档位才返回值，否则 null（不猜、不就近取整 —— 宁可回默认） */
export function normalizeWallStyle(v) {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(WALL_STYLES, v) ? v : null;
}

/**
 * 实际不透明度：方案选了就按方案的，没选就按参数表。
 * @param {string|null} style   方案里的档位（可能是未知值 —— 那时回退）
 * @param {number} fallback     参数表里的默认不透明度
 */
export function wallOpacityOf(style, fallback) {
  const k = normalizeWallStyle(style);
  if (k) return WALL_STYLES[k].opacity;
  const f = Number(fallback);
  return Number.isFinite(f) ? Math.min(1, Math.max(0.2, f)) : 1;
}
