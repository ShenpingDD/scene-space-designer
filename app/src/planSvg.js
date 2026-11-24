/**
 * planSvg.js —— 交付包里的「平面图.svg」（B7 / R6-5）
 *
 * ## 三条口径（每一条都是踩过之后才定下来的）
 *
 * ① **几何与屏幕同源**：这里不自己算墙在哪、设备在哪 —— 全部来自 `scene2d(layout)`
 *    （`PlanView.vue` 用的是同一个函数）。所以"图上摆的东西"与"设计器里看到的东西"
 *    永远是同一份几何。
 *
 * ② **样式是另一份，而且必须另写**：屏幕上那份的描边/填充在 `style.css` 里（`.wall` / `.item-body` …），
 *    用 `outerHTML` 导出来的 SVG **带不走它们**（打开就是一片黑块或全无描边）。
 *    所以这里写了一份**打印用**的样式：外墙细、内墙深、设备用产品色、门用扇形。
 *    结论写进 docs/42：**"样式是打印版，几何与设计器一致"** —— 不说"与屏幕一模一样"（那是句大话）。
 *    ⚠️ 墙体"外观档位"（实心/半透明/很透）**有意不进打印版**：纸上没有"透过去"这回事，
 *    印一张"很透"的墙只会让人以为打印漏墨。屏幕那份（style.css）才表达档位。
 *    内墙在外墙同色系里靠**描边**区分（屏幕上虚线、打印版细实线）—— 两处颜色不同是**设计**，
 *    不是漏改；用户反馈的那条是"屏幕上两块墙颜色像两个系统"，改的是屏幕。
 *
 * ③ **不引用任何外部资源**：字体只用通用族名、不引 CSS/图片 —— 验收判据就是
 *    「在另一台机器上能打开」（`PROGRESS` B7 那一行的原话）。
 *
 * viewBox 用**毫米**：打印/量取都对得上；线宽用 `vector-effect="non-scaling-stroke"`，
 * 于是"毫米坐标 + 毫米线宽"两件事互不干扰（不然 1 的线宽会被缩放矩阵放大成 1 米）。
 */

import { scene2d } from './scene2d.js';
import { columnAreaTotal } from '@core/columns.js';

/** 米 → 毫米（交付图纸上的数都用毫米，与设备清单.csv 同一口径） */
const mm = (m) => Math.round((Number(m) || 0) * 1000);

/** XML 文本转义 —— 方案名里有 `&` 或 `<` 就会让整张图打不开（不是显示难看，是**打不开**）。
 *
 * ⚠️ 引号写成 `String.fromCharCode(34/39)` 而不是字面量：`check-quotes.py` 是**按行**数半角双引号的
 * （一行里必须是偶数个），而把两种引号写在同一行会看起来像「引号落单」。
 */
function esc(s) {
  return String(s == null ? '' : s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll(String.fromCharCode(34), '&quot;')   // 34 = 双引号
    .replaceAll(String.fromCharCode(39), '&apos;');  // 39 = 单引号
}

const PAD_MM = 600;      // 四周留白（放尺寸线与标题）
const TITLE_MM = 700;    // 底部标题块高度

/**
 * 生成一整份可以独立打开的 SVG 文本。
 *
 * @param {object} layout  v4 方案 state（{w,d,h,walls,items}）
 * @param {object} opts    {name, at, by, paramsRev, note}
 */
export function planSvg(layout, opts = {}) {
  const s = scene2d(layout);
  // 柱层（docs/101 P4）：几何全部来自 `scene2d(...).columns`，这里不自己算矩形；
  // 面积用内核 `columnAreaTotal`，也不在这里重写"面积 = w × d"。
  const cols = s.columns || [];
  const colArea = cols.length ? columnAreaTotal(layout) : 0;
  const W = mm(s.w);
  const D = mm(s.d);
  const boxW = W + PAD_MM * 2;
  const boxH = D + PAD_MM * 2 + TITLE_MM;
  const t = s.wallThickness;                   // 米
  const sw = Math.max(2, mm(t) / 20);          // 线宽（毫米）—— 墙越厚，线略粗一点

  const out = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${boxW}mm" height="${boxH}mm" `
    + `viewBox="0 0 ${boxW} ${boxH}">`);
  out.push('<style>'
    + 'text{font-family:"Microsoft YaHei","PingFang SC",Helvetica,Arial,sans-serif;fill:#111}'
    + '.dim{stroke:#666;stroke-width:1.5;stroke-dasharray:12 8}'
    + '.dimtxt{font-size:180px;fill:#333}'
    + '.wall{stroke:#222;stroke-width:3;fill:#e9e9e9}'
    + '.grid{stroke:#dcdcdc;stroke-width:1}'
    + '.grid-major{stroke:#c8c8c8;stroke-width:1.4}'
    + '.front{stroke-width:3;fill:none}'
    + '.leaf{fill:#fff;stroke:#c0392b;stroke-width:2;stroke-dasharray:8 6}'
    + '.arc{fill:none;stroke:#c0392b;stroke-width:1.6}'
    + '.hinge{stroke:#c0392b;stroke-width:2}'
    + '.ojamb{stroke:#c0392b;stroke-width:2.6;fill:none}'
    + '.otxt{font-size:150px;fill:#c0392b}'
    + '.ilabel{font-size:200px;fill:#555}'
    + '.rlabel{font-size:210px;fill:#0b4f86;font-weight:bold}'
    + '.rarea{font-weight:normal;fill:#555}'
    + '.title{font-size:260px;font-weight:bold}'
    + '.meta{font-size:190px;fill:#444}'
    + '.note{font-size:170px;fill:#666}'
    // 柱的打印样式**只在有柱时才写**：无柱的旧图必须逐字节不变（连一段空样式都不多）
    + (cols.length ? '.column{fill:#e6e6e6;stroke:#222;stroke-width:2.4}' : '')
    + '<\/style>');

  // 图框（白底 + 细边框）
  out.push(`<rect x="0" y="0" width="${boxW}" height="${boxH}" fill="#fff"/>`);
  out.push(`<rect x="40" y="40" width="${boxW - 80}" height="${boxH - 80}" fill="none" stroke="#999" stroke-width="2"/>`);

  // 平面坐标系：原点在留白之后，y 向下（与设计器一致：平面 z 向下）
  out.push(`<g transform="translate(${PAD_MM} ${PAD_MM}) scale(1000)">`);

  // 地面 + 网格
  out.push(`<rect x="0" y="0" width="${s.w}" height="${s.d}" fill="#fbfbfb" stroke="#bbb" stroke-width="2" vector-effect="non-scaling-stroke"/>`);
  if (s.grid && s.grid.minor) {
    out.push(`<path class="grid" d="${s.grid.minor}" fill="none" vector-effect="non-scaling-stroke"/>`);
  }
  if (s.grid && s.grid.major) {
    out.push(`<path class="grid-major" d="${s.grid.major}" fill="none" vector-effect="non-scaling-stroke"/>`);
  }

  // 墙体（内外墙同一套样式 —— 与屏幕一致；几何同样来自内核构件，所以角上不会留缺口）
  // 补角先画一遍（在墙体下面），只有三岔口以上才非空
  if (s.fills && s.fills.d) out.push(`<path class="wall" d="${s.fills.d}" vector-effect="non-scaling-stroke"/>`);
  for (const w of s.walls) {
    out.push(`<path class="wall" d="${w.d}" vector-effect="non-scaling-stroke"/>`);
  }
  // 柱层（docs/101 P4）：**墙之后、设备之前** —— 结构柱常嵌在墙里/贴着墙，
  // 放在墙下面会被墙的填充与描边吃掉一半，纸面上看起来像"这里没有柱"；
  // 放在设备下面则保证设备占地（压柱是非法态，但导入旧文件可能出现）仍看得清。
  // 几何来自 `scene2d.columns`（同一份 `PlanView` 用的几何），打印版只负责换样式。
  for (const c of cols) {
    out.push(`<path class="column" d="${c.dPath}" vector-effect="non-scaling-stroke"/>`);
  }
  // 房间名（M1）：两间起才写（一间房时它就是整块地面，"未命名房间"四个字只是噪声）。
  // 写在墙**上面**：纸面上房间名被墙线穿过很难认。施工/交付按房间对设备时靠它。
  if (s.rooms && s.rooms.length > 1) {
    for (const r of s.rooms) {
      out.push(`<text class="rlabel" x="${r.at[0]}" y="${r.at[1]}" text-anchor="middle" dominant-baseline="middle">${esc(r.displayName)}`
        + `<tspan class="rarea"> · ${r.area.toFixed(1)} ㎡</tspan></text>`);
    }
  }
  // 门洞（W1）：缺口是墙自己断开的（`w.d` 已经把洞挖掉了），这里补门框线与净宽读数 ——
  // 纸面上"一个缺口"读不出那是门还是漏画，施工要按净宽做门框。
  for (const w of s.walls) {
    for (const o of w.openings || []) {
      out.push(`<path class="ojamb" d="${o.path}" vector-effect="non-scaling-stroke"/>`);
      out.push(`<text class="otxt" x="${o.mid[0]}" y="${o.mid[1]}" text-anchor="middle" dominant-baseline="middle">${mm(o.width)}</text>`);
    }
  }

  // 设备：本体 / 前脸 / 门（门几何来自实测，与屏幕同一份数据）
  for (const it of s.items) {
    const color = esc(it.product.color || '#888');
    out.push(`<path d="${it.d}" fill="${color}" fill-opacity="0.22" stroke="${color}" stroke-width="2.4" vector-effect="non-scaling-stroke"/>`);
    out.push(`<path class="front" d="M${it.front}" stroke="${color}" vector-effect="non-scaling-stroke"/>`);
    for (const lr of it.door.leafRects || []) {
      out.push(`<path class="leaf" d="${lr}" vector-effect="non-scaling-stroke"/>`);
    }
    for (const sec of it.door.sectors || []) {
      if (sec.arc) out.push(`<path class="arc" d="${sec.arc}" vector-effect="non-scaling-stroke"/>`);
      if (sec.arc) {
        out.push(`<line x1="${sec.hinge[0]}" y1="${sec.hinge[1]}" x2="${sec.leafEnd[0]}" y2="${sec.leafEnd[1]}" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke"/>`);
      }
    }
    for (const l of it.door.lidLines || []) {
      out.push(`<line class="hinge" x1="${l[0][0]}" y1="${l[0][1]}" x2="${l[1][0]}" y2="${l[1][1]}" vector-effect="non-scaling-stroke"/>`);
    }
    for (const l of it.door.closedLines || []) {
      out.push(`<line x1="${l[0][0]}" y1="${l[0][1]}" x2="${l[1][0]}" y2="${l[1][1]}" stroke="#999" stroke-width="1.2" stroke-dasharray="0.06 0.05" fill="none" vector-effect="non-scaling-stroke"/>`);
    }
    // 型号（图上直接认得出是哪一款 —— 施工队按型号对东西，不按颜色）
    out.push(`<text class="ilabel" x="${it.center[0]}" y="${it.center[1]}" text-anchor="middle" dominant-baseline="middle">${esc(it.product.model)}</text>`);
  }
  out.push('</g>');

  // 尺寸线（毫米）—— 图上有尺寸，量起来才不用回去翻文件
  const dimY = PAD_MM - 220;
  const dimX = PAD_MM - 220;
  out.push(`<line class="dim" x1="${PAD_MM}" y1="${dimY}" x2="${PAD_MM + W}" y2="${dimY}"/>`);
  out.push(`<text class="dimtxt" x="${PAD_MM + W / 2}" y="${dimY - 60}" text-anchor="middle">宽 ${W} mm</text>`);
  out.push(`<line class="dim" x1="${dimX}" y1="${PAD_MM}" x2="${dimX}" y2="${PAD_MM + D}"/>`);
  out.push(`<text class="dimtxt" x="${dimX - 60}" y="${PAD_MM + D / 2}" text-anchor="end">深 ${D} mm</text>`);

  // 标题块
  const ty = PAD_MM * 2 + D + 160;
  out.push(`<text class="title" x="${PAD_MM}" y="${ty}">${esc(opts.name || '未命名方案')}</text>`);
  const openingTotal = (s.openings || []).length;
  // 多房间时的口径要说清：整栋尺寸 + 几间房 + 几台设备（一间房时不写"1 间"，那是废话）
  const roomTotal = (s.rooms || []).length;
  const roomPart = roomTotal > 1 ? `　｜　${roomTotal} 间房` : '';
  out.push(`<text class="meta" x="${PAD_MM}" y="${ty + 330}">整栋 ${W} × ${D} × ${mm(s.h)} mm（宽 × 深 × 高）${roomPart}　｜　${s.items.length} 台设备`
    + (openingTotal ? `　｜　${openingTotal} 个门洞` : '')
    // 柱的读数（docs/101 P4）：根数 + 柱脚总面积，与 2D 柱卡的数同一个来源（内核 `columnAreaTotal`）。
    // 有柱才写 —— 无柱的旧图不加一个字节（"纸上没柱"就是事实，不需要写"柱 0 根"）。
    // 位置选在这条汇总行（而不是另起一行）：标题块的下两行本来就落在 viewBox 之外
    // （历史排版问题），另起一行只会把读数也排出图纸。
    + (cols.length ? `　｜　柱：${cols.length} 根（占 ${colArea.toFixed(2)} m²）` : '')
    + '</text>');
  out.push(`<text class="meta" x="${PAD_MM}" y="${ty + 560}">生成 ${esc(opts.at || '')}　｜　${esc(opts.by || '')}`
    + (opts.paramsRev ? `　｜　规则参数第 ${esc(opts.paramsRev)} 版` : '')
    + (opts.rev ? `　｜　方案第 ${esc(opts.rev)} 版` : '') + '</text>');
  out.push(`<text class="note" x="${PAD_MM}" y="${ty + 790}">几何与设计器一致（同一份数据）；本图样式为打印版。单位：毫米。`
    + (openingTotal ? '门洞：墙上的缺口，红色短线为门框位置、数字为净宽（mm）。' : '')
    + (roomTotal > 1 ? '房间：由墙围出（房名与面积为参考，以现场为准）。' : '')
    + `方案名 ${esc(opts.name || '')}</text>`);
  out.push('</svg>');
  return out.join('\n');
}