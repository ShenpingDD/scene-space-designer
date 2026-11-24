/**
 * scene2d.js —— 布局状态 → SVG 图元（纯函数，可在断言里直接调用）
 *
 * 为什么 2D 用 SVG 而不是 canvas（R1 的 canvas 版做不到这一点）：
 *   ① 渲染不依赖 requestAnimationFrame —— 本环境 `document.visibilityState=hidden`
 *      导致 rAF 完全暂停，canvas 版**没有任何办法验证**；SVG 版照常渲染、可测、可截图。
 *   ② 每台设备就是一个 DOM 节点，点击/拖拽的命中判定免费拿到，不用手写像素级 hit test。
 *   ③ 矢量：打印、缩放、"发给同事看的图"都不用重画。
 *   ④ 100 台设备的规模，SVG 性能完全够（canvas 的优势在这个量级不存在）。
 *
 * 坐标约定：SVG 的 x 就是房间 x，SVG 的 y 就是房间 z（z 向下），与内核一套坐标系。
 * 旋转约定与内核 `corners()` 一致（3D 侧用 `rotation.y = -r` 对齐同一约定）。
 */

import { corners, extents, wallBox, DEG } from '@core/geometry.js';
import { wallPieces, pieceCorners } from '@core/wallpieces.js';
import { cfg } from '@core/params.js';
import { isBoundaryWall } from '@core/room.js';
import { wallSeg, openingsOf } from '@core/wall.js';
import { solidBlocks, openingMarks, openingLabel, doorOpenings } from '@core/openings.js';
import { planRoutes, routeSegments } from '@core/route.js';
import * as roomsKernel from '@core/rooms.js';
import { checkColumn as coreCheckColumn, columns2d as coreColumns2d } from '@core/columns.js';
import { getProduct } from './catalog.js';
import { measuredDoors } from './data/doors.measured.js';

const path = (pts) => pts.map(([x, z], i) => `${i ? 'L' : 'M'}${x.toFixed(4)} ${z.toFixed(4)}`).join(' ') + ' Z';

/**
 * 房间墙体：**构件与三维同一份**（内核 `wallPieces()`）。
 *
 * 为什么必须同源（用户真机反馈）：2D 原来每面墙各画一个原始盒子 —— 两墙交汇的**内角**
 * 会留一个 (t/2)×(t/2) 的方缺口（屏幕上就是「交接处模型破面」，实测约 2450 mm²）；
 * 而三维早就缩了半个墙厚再补接角块。同一处几何两个出处，必然一边对一边错。
 *
 * `d` 是**构件**的多边形（沿墙朝向、在公共端点缩半个墙厚）；`corners` 给断言直接用；
 * `mid`/`length` 仍取**墙的定义** —— 墙就是它那么长，缩掉的那半截属于接头、不属于这面墙。
 */
/** 外墙端头：在墙中心线两端各画一条垂直短线（T 形收头），长度取墙厚的 1.5 倍。
 *  只表达「这是外墙的端头」，不改变墙体几何；内墙返回 ''。 */
function wallCaps2d(seg, exterior) {
  if (!exterior) return '';
  const [x, z, xx, zz] = seg;
  const len = Math.hypot(xx - x, zz - z);
  if (!(len > 1e-9)) return '';
  const nx = -(zz - z) / len;
  const nz = (xx - x) / len;
  const half = cfg.space.wallThicknessM * 1.5;
  const cap = (px, pz) => `M${(px + nx * half).toFixed(4)} ${(pz + nz * half).toFixed(4)} L${(px - nx * half).toFixed(4)} ${(pz - nz * half).toFixed(4)}`;
  return `${cap(x, z)} ${cap(xx, zz)}`;
}

/* ---------------- 矩形柱（docs/101 P2 2D）---------------- */
/**
 * 柱 → 2D 图元。柱**不进 walls2d**；调用方按模板顺序把这一层画在墙之上、设备之下。
 * `selected` 只是显示态，由调用方传入，**不写进 layout**。
 *
 * 校验只有内核 `columns.checkColumn` 一份；这里为了“显示自己时不报与自身重叠”，
 * 把待查柱先从现有清单里摘掉再问内核（不是另写一套规则）。
 */
export function columns2d(layout, { selectedId = null } = {}) {
  const list = Array.isArray(layout?.columns) ? layout.columns : [];
  return coreColumns2d(layout).map((col) => {
    const base = { ...layout, columns: list.filter((c) => String(c.id) !== String(col.id)) };
    const check = coreCheckColumn(base, col, { ignoreId: col.id, getProduct });
    const invalid = check.ok ? null : {
      reason: check.reason,
      message: check.message,
      openingKind: check.reason === 'column-blocks-opening'
        ? (String(check.message).includes('窗') ? 'window' : 'door')
        : undefined,
    };
    return {
      ...col,
      area: col.w * col.d,
      selected: String(col.id) === String(selectedId),
      // 模板用 dPath；内核同时给 d，保留两者，换实现不影响模板
      dPath: col.dPath ?? col.d,
      invalid,
    };
  });
}

export function walls2d(layout) {
  const byIndex = new Map(wallPieces(layout).pieces.map((p) => [p.index, p]));
  return layout.walls.map((wall, index) => {
    const pc = byIndex.get(index);
    const pts = pc ? pieceCorners(pc) : wallBox(wall);   // 零长的退化墙没有构件，退回原盒子
    const seg = wallSeg(wall);
    const opens = openingsOf(wall);
    // ⚠️ W2 起这里只传**门洞**（`doorOpenings`）：窗**不能断墙身** —— 顶视图里「断开的墙」
    //    传达的就是「这儿能过去」，而窗不是（而且它真走不过去，见 docs/78 §六）。
    //    窗在平面上画**三线符号**（`o.sashPath`，见下面 openings 那段）。
    // 有门洞的墙：把构件按洞切开画（**不含过梁** —— 顶视图里过梁会把洞口盖住，
    // 于是平面图上看不出"这里有个门"）。没有门洞时 `solidBlocks` 返回整块，路径与以前逐字一致。
    const blocks = pc ? solidBlocks(pc, doorOpenings(wall), { lintel: false }).map((b) => b.poly) : [pts];
    const boundary = isBoundaryWall(layout, wall);
    // 角色是**持久化语义**（`wall.role`）；旧墙没有 role / role 非法时走内核几何回退。
    // 渲染层不自己拿端点猜：这样 P1 改判/手工切角色后，2D 只跟着 role 变。
    const role = wall.role === 'exterior' || wall.role === 'interior'
      ? wall.role
      : (boundary ? 'exterior' : 'interior');
    return {
      index,
      wall,
      // `corners` 仍是**整块构件**（斜接后的多边形）：判据拿它比形状，与洞口无关
      corners: pts,
      // `blocks` = 真正画出来的那几块（有门洞时是两段），`d` 是它们的合并路径
      blocks,
      d: blocks.map((q) => path(q)).join(' '),
      boundary,
      role,
      // 外墙 T 端头（两条垂直短线）的 path；内墙为 ''，模板只按归一化后的 role 画
      caps: wallCaps2d(seg, role === 'exterior'),
      horizontal: Math.abs(seg[1] - seg[3]) < 1e-9,
      // 方向角（度，0 = 沿 +x）：斜墙之后列表不能再写「水平/垂直」
      angleDeg: (Math.atan2(seg[3] - seg[1], seg[2] - seg[0]) * 180) / Math.PI,
      length: Math.hypot(seg[2] - seg[0], seg[3] - seg[1]),
      mid: [(seg[0] + seg[2]) / 2, (seg[1] + seg[3]) / 2],
      openingCount: opens.length,
      // 洞口标记（门框两条短线 + 净宽读数 + 命中区）：几何全部来自内核，界面不自己算
      openings: openingMarks(wall).map((m) => ({
        ...m,
        path: m.jambs.map((j) => `M${j[0][0].toFixed(4)} ${j[0][1].toFixed(4)} L${j[1][0].toFixed(4)} ${j[1][1].toFixed(4)}`).join(' '),
        // 窗线（第三线，建筑制图的窗画法）：只有窗有；门是 `null` —— 界面按它分流
        sashPath: m.sash ? `M${m.sash[0][0].toFixed(4)} ${m.sash[0][1].toFixed(4)} L${m.sash[1][0].toFixed(4)} ${m.sash[1][1].toFixed(4)}` : null,
        // 命中区：洞口那块矩形（用四个角画多边形）—— 点它才选得中
        hit: [m.jambs[0][0], m.jambs[0][1], m.jambs[1][1], m.jambs[1][0]],
        text: openingLabel(m.opening),
        // 平面图上的读数：门和窗**同一种格式**，只写净宽 —— 用户 验收 第三轮明确说窗的
        // 「0.90 m · 离地 1.20」太长、放完之后只想知道宽度。离地那一个数没丢：完整读屏信息
        // 仍在 `text`（= `openingLabel`），Inspector 里离地高度照旧可编辑。
        short: `${m.width.toFixed(2)} m`,
      })),
    };
  });
}

/**
 * 接头**补角**：只有**三根以上墙在一个点收头**时才可能有。
 *
 * 两墙交汇交给斜接（构件本身铺满，不需要补块）；三岔口以上铺不满 —— 扇形可能比墙身还宽
 * （Y 形：扇形 150°、墙身只到 90°）—— 缺口就由这里补上。
 *
 * 以前这里叫"接角块"、画的是**轴对齐的 t×t 正方形**：两墙斜着交汇时，那个方块的角
 * 会从墙身里戳出去，屏幕上就是用户报的「方补丁」。现在换成内核算出来的**精确缺口多边形**：
 * 四条约束（到两条中心线的距离、在两个端面之后）全部来自墙的定义，既填得满、也不多盖。
 * 合并成**一条** path：一整层，画在墙体下面（选中/悬停涂品牌色时不露出一块灰的）。
 */
export function wallFills2d(layout) {
  const fills = wallPieces(layout).fills;
  const polys = fills.map((f) => f.poly);
  // `polys` 与 `d` 是**同一份**数据（测试直接用多边形判覆盖，不去解析路径字符串）
  return { count: fills.length, polys, d: polys.map((q) => path(q)).join(' ') };
}

/**
 * 一台设备在平面图上的全部图元。
 * 门的部分只画"动起来的关键量"：铰链、门扇、当前开角 → 一个扇形。
 *
 * 几何全部来自 `doors.measured.js`（验收器从 GLB 里量出来、再换算到平面）：
 *   铰链 = 模型里真实的门节点原点（demo-ct-scanner 在 +x 端、demo-freezer-chest 上盖在**后沿**），不是"前脸左端"的猜测；
 *   半径 = 实测扫掠半径（demo-freezer-dual 真值 514 mm，按柜宽估会画成 990 mm，差近一倍）。
 * 实测缺席的型号退回估算，并且 `measured:false` 可辨识 —— 那是**回退**，不是等价算法。
 */

/** three.js 绕 +Y 旋转 θ 作用在本地 (x,z) 上：x' = x·cosθ + z·sinθ，z' = −x·sinθ + z·cosθ */
function localRotate(dx, dz, rad) {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [dx * c + dz * s, -dx * s + dz * c];
}

function rectPath(pts) {
  return `M${pts.map((q) => q.join(' ')).join(' L')} Z`;
}
export function item2d(item) {
  const p = getProduct(item.p);
  if (!p) return null;

  const pts = corners(item.x, item.z, p.w, p.d, item.r);
  const ext = extents(p.w, p.d, item.r);
  const r = item.r * DEG;

  // 前脸：本地 +z 边（原型约定：设备正面朝 +Z）
  const front = [
    [item.x + (-p.w / 2) * Math.cos(r) - (p.d / 2) * Math.sin(r), item.z + (-p.w / 2) * Math.sin(r) + (p.d / 2) * Math.cos(r)],
    [item.x + (p.w / 2) * Math.cos(r) - (p.d / 2) * Math.sin(r), item.z + (p.w / 2) * Math.sin(r) + (p.d / 2) * Math.cos(r)],
  ];

  // 门：几何来自实测（doors.measured.js）；实测缺席则退回"前脸左端 + 柜宽估算"
  const amount = item.doorAmount ?? 0;
  // 本地点 → 平面点（与内核 corners() 同一套旋转：平面绕原点转 +r）
  const at = (lx, lz) => [item.x + lx * Math.cos(r) - lz * Math.sin(r), item.z + lx * Math.sin(r) + lz * Math.cos(r)];
  const measured = measuredDoors(item.p);
  const door = {
    amount,
    open: amount > 0.001,
    measured: measured.length > 0,
    exact: measured.length > 0 && measured.every((d) => d.exact),
    sectors: [],      // 绕竖轴的门：扇形（唯一在平面上有"占位"含义的门型）
    lidLines: [],     // 上盖（绕水平轴）：只画铰链线，平面半径是竖直方向的，不能当占位用
    closedLines: [],  // 闭合门扇（铰链 → 闭合端）
    leafRects: [],    // 门自己闭合时的贴地轮廓
    hinge: null,
    leafEnd: null,
    arc: null,
  };

  if (measured.length) {
    for (const d of measured) {
      door.leafRects.push(rectPath([
        at(d.leaf.x0, d.leaf.z0), at(d.leaf.x1, d.leaf.z0),
        at(d.leaf.x1, d.leaf.z1), at(d.leaf.x0, d.leaf.z1),
      ]));
      const hinge = at(d.hinge.x, d.hinge.z);
      door.hinge = door.hinge ?? hinge;

      if (d.axis !== 'y') {
        door.lidLines.push([at(d.leaf.x0, d.hinge.z), at(d.leaf.x1, d.hinge.z)]);
        continue;
      }

      // 门扇往哪边展开：看铰链离门盒子的哪一端更远（由几何定，不猜）
      const farX = Math.abs(d.leaf.x1 - d.hinge.x) > Math.abs(d.leaf.x0 - d.hinge.x) ? d.leaf.x1 : d.leaf.x0;
      const dx = farX - d.hinge.x;
      const closedTip = at(d.hinge.x + dx, d.hinge.z);
      // 开门方向：模型绕 +Y 转 openAngle，本地点跟着转同样角（平面旋转在最后一步统一施加）
      const [ox, oz] = localRotate(dx, 0, d.openAngleDeg * DEG * amount);
      const openTip = at(d.hinge.x + ox, d.hinge.z + oz);

      // SVG 圆弧绕向：按 (x,z) 平面里"闭合位 → 开门位"的角度差定
      let delta = Math.atan2(oz, ox) - Math.atan2(0, dx);
      while (delta > Math.PI) delta -= 2 * Math.PI;
      while (delta < -Math.PI) delta += 2 * Math.PI;
      const sweep = delta > 0 ? 1 : 0;
      const large = Math.abs(delta) > Math.PI ? 1 : 0;
      const arc = amount > 0.001
        ? `M${hinge[0].toFixed(4)} ${hinge[1].toFixed(4)} L${closedTip[0].toFixed(4)} ${closedTip[1].toFixed(4)} A${d.swing} ${d.swing} 0 ${large} ${sweep} ${openTip[0].toFixed(4)} ${openTip[1].toFixed(4)} Z`
        : null;

      door.sectors.push({ node: d.node, radius: d.swing, hinge, closedTip, leafEnd: openTip, arc });
      door.closedLines.push([hinge, closedTip]);
      door.leafEnd = door.leafEnd ?? openTip;
      door.arc = door.arc ?? arc;
    }
  } else {
    // 回退：前脸左端 + 柜体宽度估算（原型口径）。没有实测数据时不假装精确，但也不留空。
    const hinge = front[0];
    const leaf = p.w;
    const closedDir = [Math.cos(r), Math.sin(r)];
    const ang = Math.atan2(closedDir[1], closedDir[0]) + (item.doorOpenAngle ?? 1.85) * amount * (item.doorSign ?? 1);
    const closedTip = [hinge[0] + closedDir[0] * leaf, hinge[1] + closedDir[1] * leaf];
    const leafEnd = [hinge[0] + Math.cos(ang) * leaf, hinge[1] + Math.sin(ang) * leaf];
    door.sectors.push({
      node: null, radius: leaf, hinge, closedTip, leafEnd,
      arc: amount > 0.001
        ? `M${hinge[0].toFixed(4)} ${hinge[1].toFixed(4)} L${closedTip[0].toFixed(4)} ${closedTip[1].toFixed(4)} A${leaf} ${leaf} 0 0 ${item.doorSign === -1 ? 0 : 1} ${leafEnd[0].toFixed(4)} ${leafEnd[1].toFixed(4)} Z`
        : null,
    });
    door.closedLines.push([hinge, closedTip]);
    door.hinge = hinge;
    door.leafEnd = leafEnd;
    door.arc = door.sectors[0].arc;
  }

  return {
    id: item.id,
    product: p,
    item,
    d: path(pts),
    front: front.map((p2) => p2.join(' ')).join(' L'),
    center: [item.x, item.z],
    ext,
    label: `${Math.round(p.w * 1000)}×${Math.round(p.d * 1000)}`,
    showLabel: ext.w * 1.35 > 0.5 && ext.d * 1.35 > 0.5,
    // 读屏用的名字（B14）：平面图上那两个小字是「1200×800」和「#3」——
    // 型号、位置、朝向在屏幕上是**看出来的**，读屏看不到，所以在这里补齐；
    // 口径与可见信息一字不差（mm / m / 度），两边说的必须是同一件事。
    ariaLabel: `${p.model || '未知型号'} #${item.id}：`
      + `${Math.round(p.w * 1000)}×${Math.round(p.d * 1000)} mm，`
      + `位置 x ${item.x.toFixed(2)} m、z ${item.z.toFixed(2)} m，朝向 ${Math.round(item.r)}°`,
    door,
  };
}

/* ---------------- 动线（W4，**全部派生**）---------------- */

/** 站点字母：A..T（P1 上限 20，不做 A1/B1 的扩展；超过上限由内核拒绝） */
function stopLabel(index) {
  return index < 26 ? String.fromCharCode(65 + index) : `A${index - 25}`;
}

function linePath(points) {
  return points.map(([x, z], i) => `${i ? 'L' : 'M'}${x.toFixed(4)} ${z.toFixed(4)}`).join(' ');
}

/**
 * 2D 箭头形状（**尖头朝 +x**）。`routes2d` 的 angle 已按 A→B 方向旋转；
 * 这里形状本身必须也朝 +x —— 旧路径把尖端放在 -0.10、缺口放在 +0.02，
 * 旋转再对也会看起来是反的（验收：A→B 被画成 B→A）。
 */
export const ROUTE_ARROW_D = 'M0.10 0 L-0.08 -0.055 L-0.02 0 L-0.08 0.055 Z';

/** 沿线放箭头：每 `cfg.route.arrowEveryM` 一个；短段至少一个，位置取段中点 */
function routeArrows(segments) {
  const every = Math.max(0.3, Number(cfg.route.arrowEveryM) || 1.5);
  const out = [];
  for (const [a, b] of segments) {
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (!(len > 1e-6)) continue;
    const n = Math.max(1, Math.round(len / every));
    const angle = (Math.atan2(dz, dx) * 180) / Math.PI;
    for (let k = 0; k < n; k += 1) {
      const t = n === 1 ? 0.5 : (k + 0.5) / n;
      out.push({ x: a[0] + dx * t, z: a[1] + dz * t, angle });
    }
  }
  return out;
}

/**
 * 动线 → 2D 图元。**不复制寻路规则**：路径来自 `planRoutes`（P1 纯函数），
 * 这里只把 `legs[].points` 拼成 path、按顺序算颜色/线型/箭头；失效路线只画用户段作红虚线。
 *
 * @param {object} layout
 * @param {Array|null} plans 已由 designer 算好的 planRoutes 结果；不传则现算（测试/打印可用）
 */
export function routes2d(layout, plans = null) {
  const list = Array.isArray(layout?.routes) ? layout.routes : [];
  const results = Array.isArray(plans) ? plans : planRoutes(layout, { getProduct });
  return list.map((route, index) => {
    const plan = results[index] ?? {
      ok: false, status: 'blocked', routeId: route?.id ?? null,
      points: route?.points ?? [], legs: [], length: 0,
      reason: 'bad-route', message: '动线没有规划结果',
    };
    const status = plan.ok ? 'ok' : 'blocked';
    const segments = [];
    if (plan.ok) {
      for (const leg of plan.legs ?? []) {
        const pts = Array.isArray(leg.points) ? leg.points : [];
        for (let i = 0; i + 1 < pts.length; i += 1) segments.push([pts[i], pts[i + 1]]);
      }
    } else {
      // 失效路线不画自动折线（可能过期/穿墙），只画用户点之间的诊断段，由模板标红
      for (const seg of routeSegments(route)) segments.push([seg.a, seg.b]);
    }
    const points = (Array.isArray(route?.points) ? route.points : [])
      .filter((p) => Array.isArray(p) && p.length >= 2)
      .map((p, i) => ({ index: i, label: stopLabel(i), x: p[0], z: p[1] }));
    return {
      id: route.id,
      index,
      number: index + 1,
      colorIndex: (index % 6) + 1,
      name: typeof route.name === 'string' && route.name ? route.name : `动线 ${route.id}`,
      points,
      stops: points,
      status,
      reason: plan.reason ?? null,
      message: plan.message ?? '',
      length: Number(plan.length) || 0,
      segments,
      arrows: status === 'ok' ? routeArrows(segments) : [],
      d: linePath(segments.flatMap(([a, b], i) => (i === 0 ? [a, b] : [b]))),
      plan,
    };
  });
}

/** 网格线：0.5 m 细线 + 1 m 粗线（与原型平面图口径一致） */
export function grid2d(layout) {
  const minor = [];
  const major = [];
  for (let x = 0; x <= layout.w + 1e-9; x += cfg.space.snapM * 5) {
    const line = [x, 0, x, layout.d];
    (Math.abs(x - Math.round(x)) < 1e-9 ? major : minor).push(line);
  }
  for (let z = 0; z <= layout.d + 1e-9; z += cfg.space.snapM * 5) {
    const line = [0, z, layout.w, z];
    (Math.abs(z - Math.round(z)) < 1e-9 ? major : minor).push(line);
  }
  return { minor, major };
}

/**
 * 房间层（M1，**派生**：来自墙，不在 state 里）。
 *
 * 界面只负责把它画出来 —— 面积/形心/名字/窄缝标记全部来自内核 `rooms.js`。
 * `d` 是房面的路径（画填充），`at` 是名字该落在哪儿（凹口形房间的形心可能落在房外，
 * 内核已经退到"离墙最远的内部点"了）。
 */
export function rooms2d(layout) {
  return roomsKernel.roomSummary(layout, layout.roomLabels).map((r) => ({
    id: r.id,
    name: r.name,
    displayName: r.displayName,
    area: r.area,
    sliver: r.sliver,
    walls: r.walls,
    openings: r.openings,
    itemCount: r.items,
    poly: r.poly,
    d: path(r.poly),
    at: r.labelAt,
  }));
}

/** 一次算完，模板里只做绑定 */
export function scene2d(layout, { routePlans = null, selectedColumn = null } = {}) {
  const walls = walls2d(layout);
  return {
    w: layout.w,
    d: layout.d,
    h: layout.h,
    grid: grid2d(layout),
    walls,
    // 房间层（画在**最底下**：地面之上、墙与设备之下，它只是底色与分区）
    rooms: rooms2d(layout),
    fills: wallFills2d(layout),
    // 柱：独立层；不塞 walls2d。选中态由调用方传，不写进 layout。
    columns: columns2d(layout, { selectedId: selectedColumn }),
    items: layout.items.map(item2d).filter(Boolean),
    // 门洞的扁平清单（渲染与读屏都用它；条数与墙上的真数一致 —— 判据直接比这个数）
    openings: walls.flatMap((w) => w.openings.map((o) => ({ ...o, wallIndex: w.index }))),
    // 开放面积（米²）：派生量，来自内核；旧语义（legacy）自然是 0
    openArea: roomsKernel.openAreaTotal(layout),
    wallThickness: cfg.space.wallThicknessM,
    // 动线（W4）：全部派生；plans 由 designer 缓存，打印/测试可省略（函数内现算）
    routes: routes2d(layout, routePlans),
  };
}