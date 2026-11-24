/**
 * fmt.js —— 长度/坐标的**唯一**显示口径
 *
 * 为什么要有这个文件：同一个位置在四个地方显示过（设计器右栏、产品栏、只读分享页、面板），
 * 之前有的 1 位、有的 2 位、有的 toFixed 硬补零 —— 用户会以为精度不一样，其实只是格式没统一。
 *
 * 口径（与内核 `roundMm` 对齐）：
 *  - **最多 3 位**（毫米）；
 *  - **不补零**：`1.5` 就显示 `1.5`，不写成 `1.500`（补零是小谎，会让人以为精度更高）；
 *  - 超出 3 位的（老数据里的浮点长尾）按毫米收，**不trim成科学计数**。
 */
export function fmtLen(v) {
  if (!Number.isFinite(v)) return '—';
  const r = Math.round(v * 1000) / 1000;
  return String(parseFloat(r.toFixed(3)));
}

/** 位置（x, z）—— 两轴一起，用于提示/分享页那一行 */
export function fmtPos(x, z) {
  return `${fmtLen(x)} m / ${fmtLen(z)} m`;
}

/**
 * 面积（m²）—— **两位**，不补零。
 *
 * 为什么不跟长度一样到三位：面积是长度的平方，毫米级的长度对应到面积已经是 10⁻⁶ 量级，
 * 报三位只会把"12.15 m²"写成"12.150 m²"（多出来的那位是噪音，不是精度）。
 * 而一位也不行：4.05 × 3 = 12.15，一位会显示成"12.2" —— 那就把用户刚设的尺寸藏掉了。
 */
export function fmtArea(v) {
  if (!Number.isFinite(v)) return '—';
  return String(parseFloat((Math.round(v * 100) / 100).toFixed(2)));
}
