/**
 * qr.js —— 二维码：把一条链接画成 **SVG**（纯函数，可单测）
 *
 * ## 为什么引 `qrcode-generator`（而不是 `qrcode`，更不是自己写）
 *
 * 按"用轮子"四条判据（`docs/21`）：
 *   · `qrcode-generator` **零依赖** —— 实测 `npm install` 只多一个包（`added 1 package`）；
 *   · `qrcode` 带 3 个依赖（`dijkstrajs` / `pngjs` / `yargs`）—— 我们只要一个矩阵，
 *     不要 CLI、不要 PNG 编码器，**轮子比活还大**；
 *   · 自己写更不行：QR 要 Reed–Solomon 纠错 + 掩码选择，做出一个"能生成、扫不出"的东西
 *     并不难，而且**从屏幕上根本看不出来**（正是本项目最怕的那类缺陷）。
 *
 * ⚠️ 这个库**只有编码、没有解码** —— 这正是我们要的：判据
 * （`tools/verify/verify-qr.py`）是一份**独立写的矩阵级解码器**，
 * 不可能"拿库自证"（`docs/52` 的 C25：判据别循环断言）。
 *
 * ## 为什么渲染成 SVG，而不是 canvas / PNG
 *
 * ① 矢量，放多大都不糊；② **探针能读 DOM**（canvas 读不了，判据做不了）；
 * ③ 不依赖 `toDataURL`（离屏/无头环境里容易踩空）；④ 打印、放进材料都行。
 */
import qrcode from 'qrcode-generator';

/**
 * 容错级别：**Q（25%）**。
 *
 * 现场是"屏幕对屏幕"扫（反光、脏屏、角度斜），可靠性优先。代价只是模块多一点、
 * 码略大 —— 面板里放得下。
 */
export const QR_EC = 'Q';

/** 静区：标准要求至少 4 个模块，少了扫不出 */
export const QR_QUIET = 4;

/**
 * 文本 → 模块矩阵。
 *
 * `typeNumber = 0` = **按内容自动选最小版本**（链接长度会变：域名/端口/口令都不一样，
 * 写死版本就是给自己埋一个"某些环境下生成失败"的坑）。
 */
export function qrMatrix(text, ec = QR_EC) {
  const q = qrcode(0, ec);
  q.addData(String(text));
  q.make();
  const size = q.getModuleCount();
  const rows = [];
  for (let r = 0; r < size; r++) {
    const row = [];
    for (let c = 0; c < size; c++) row.push(q.isDark(r, c) ? 1 : 0);
    rows.push(row);
  }
  return { size, rows, ec };
}

/**
 * 矩阵 → 一条 SVG `path`。
 *
 * 逐行把**连续的黑块**并成一根"1 单位高"的横条（`M x y h w v1 h -w z`）：
 * 相邻两行的横条天然拼接，所以画出来是实心的，而 path 指令数远少于逐模块画方块。
 * 坐标已经算进静区（`quiet`），所以外面直接用 `viewBox="0 0 extent extent"` 就行。
 */
export function qrPath(matrix, quiet = QR_QUIET) {
  const { size, rows } = matrix;
  let d = '';
  for (let r = 0; r < size; r++) {
    let c = 0;
    while (c < size) {
      if (!rows[r][c]) { c += 1; continue; }
      let end = c;
      while (end < size && rows[r][end]) end += 1;
      const x = c + quiet;
      const y = r + quiet;
      d += `M${x} ${y}h${end - c}v1h-${end - c}z`;
      c = end;
    }
  }
  return { d, extent: size + quiet * 2 };
}

/**
 * 一步到位：文本 → `{ matrix, path, extent, px, sizePx }`。
 *
 * `px` = 一个模块占几个 CSS px（面板里给平板看，6~8 就够；`extent * px` 是建议边长）。
 */
export function qrSvg(text, { ec = QR_EC, quiet = QR_QUIET, px = 6 } = {}) {
  const matrix = qrMatrix(text, ec);
  const { d, extent } = qrPath(matrix, quiet);
  return { matrix, path: d, extent, px, sizePx: extent * px };
}