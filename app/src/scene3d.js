/**
 * scene3d.js —— 布局 → three.js 场景（含 3D 视图与第一人称漫游）
 *
 * 设计上有一条与原型完全不同的选择：**按需渲染，不用 rAF 循环**。
 *   ① 本环境 `document.visibilityState === 'hidden'`，rAF 完全暂停 —— 挂着循环也一帧不出，
 *      等于"没法验证"。按需渲染则可以同步 `render()`，随时能取到真实像素。
 *   ② OrbitControls 关掉阻尼后本来就不需要每帧重算。
 *   ③ 后台标签页不烧 GPU（业务同事开着多个标签页是常态）。
 *   ④ 任何状态变化后调一次 `renderOnce()`，语义明确，不依赖"循环一定会跑到"。
 *
 * 业务规则一律不从内核之外取：房间/墙体/设备的位置与角度来自 `layout`，
 * 合法性判断在 2D 侧与内核里已经完成，3D 只负责**如实呈现**。
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { viewPoint } from './views3d.js';
import { cfg, envelopeTolMm } from '@core/params.js';
import { corners, DEG } from '@core/geometry.js';
import { isBoundaryWall, wallRole } from '@core/room.js';
import { roomsOf, wallClasses, openAreaTotal, roomAreaTotal, roomSemanticsOf } from '@core/rooms.js';
import { wallPieces } from '@core/wallpieces.js';
import { wallOpacityOf } from '@core/wallstyle.js';
import { prismFaces } from '@core/prism.js';
import { openingsOf } from '@core/wall.js';
import { solidBlocks } from '@core/openings.js';
import { walkStep } from '@core/collision.js';
import { moveBasis, stepVector } from '@core/walkbasis.js';
import { planRoutes } from '@core/route.js';
import { getProduct } from './catalog.js';
import { doorsFromScene } from './detail3d.js';
import {
  loadCatalogs, loadAsset, loadAssetFile, resolveAssetPlan, entryOf, levelsOf, pickLevel,
  measure, countTriangles, fitClone, bindDoors, applyDoor,
} from './gltf.js';

const COLORS = {
  ground: 0xf2f5f7,
  wall: 0xcfd8de,
  select: 0x005caf,
  grid: 0xdfe6ea,
  // 接触阴影（docs/101 §三.3）：柱脚那块贴着地面的深色贴花。**不是** shadowMap —— 本渲染器
  // 没有开实时阴影，只做"落地感"。用一档比墙更深的冷灰，避免看起来像柱体本身多了一层颜色。
  columnShadow: 0x2a3844,
};

/**
 * 柱（P4·docs/101 §三.3 / docs/100 §6）—— **纯几何**，不碰渲染器，单测直接调。
 *
 * 口径（P1 契约）：
 *   · 数据只认 `layout.columns`（`{id,x,z,w,d}`）；缺省 = 空数组，**绝不从 walls 反推**；
 *   · 轴对齐矩形棱柱，y ∈ [0, layout.h]（柱高 = 层高，不入库）；
 *   · 全部柱合并成**一份**几何（12 tri/根），接触阴影另一份（2 tri/根）——
 *     不采用"每根柱一个 mesh"（50 根 = 50 draw call）。
 */
export function columnsOf(l) {
  const list = Array.isArray(l?.columns) ? l.columns : [];
  const out = [];
  for (const c of list) {
    const x = Number(c?.x);
    const z = Number(c?.z);
    const w = Number(c?.w);
    const d = Number(c?.d);
    if (![x, z, w, d].every(Number.isFinite) || w <= 0 || d <= 0) continue;
    out.push({ id: c.id ?? out.length + 1, x, z, w, d });
  }
  return out;
}

/** 柱占地矩形 `[x0,z0,x1,z1]`（与内核 `columnRect()` 同口径；三维自己再算一遍只为不引新依赖） */
export function columnRect(c) {
  return [c.x - c.w / 2, c.z - c.d / 2, c.x + c.w / 2, c.z + c.d / 2];
}

/** 一根柱 = 一个矩形棱柱（12 个三角形）；缠绕/法线复用与墙同一份 `prismFaces` */
export function columnPrismGeometry(c, h) {
  const [x0, z0, x1, z1] = columnRect(c);
  const f = prismFaces([[x0, z0], [x1, z0], [x1, z1], [x0, z1]], h, 0);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(f.positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(f.normals, 3));
  return g;
}

/** 接触阴影：与占地同形的一张平面（2 个三角形/根），略缩一圈、贴地 y≈0.003 */
export function columnShadowGeometry(c) {
  const k = 0.92;
  const [x0, z0, x1, z1] = columnRect(c);
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const hw = ((x1 - x0) * k) / 2;
  const hd = ((z1 - z0) * k) / 2;
  const y = 0.003;
  const pos = [
    cx - hw, y, cz - hd, cx + hw, y, cz - hd, cx + hw, y, cz + hd,
    cx - hw, y, cz - hd, cx + hw, y, cz + hd, cx - hw, y, cz + hd,
  ];
  const nrm = [];
  for (let i = 0; i < pos.length / 3; i++) nrm.push(0, 1, 0);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  return g;
}

/**
 * 建柱的两份合并几何：`body`（柱体，1 draw）+ `shadow`（接触阴影贴花，1 draw）。
 * 空方案两份都是 `null`（0 draw）；三角形数按**真实几何**数出来，不写死 12×n。
 */
export function buildColumnsGeometry(columns, h) {
  const list = Array.isArray(columns) ? columns : [];
  const height = Number(h) > 0 ? Number(h) : 2.8;
  const bodies = [];
  const shadows = [];
  for (const c of list) {
    bodies.push(columnPrismGeometry(c, height));
    shadows.push(columnShadowGeometry(c));
  }
  const body = bodies.length ? mergeGeometries(bodies) : null;
  const shadow = shadows.length ? mergeGeometries(shadows) : null;
  for (const g of bodies) g.dispose();
  for (const g of shadows) g.dispose();
  return {
    body,
    shadow,
    count: list.length,
    height,
    triangles: body ? Math.round((body.attributes.position?.count ?? 0) / 3) : 0,
    shadowTriangles: shadow ? Math.round((shadow.attributes.position?.count ?? 0) / 3) : 0,
  };
}

/**
 * 动线（P3）—— 三维里的地面视觉引导层。
 *
 * 冻结口径（docs/97 §5.4 / §7.1）：
 *   · 只读 `layout.routes`（用户点出的站点），折线/状态全由 P1 的 `planRoutes()` 派生；
 *   · **视觉引导，不是导航约束** —— 不参与 `walkStep`、不拉回、不锁定方向；
 *   · 全部动线合并成两份几何：贴地 ribbon 1 mesh + 箭头 1 mesh；选中高亮最多 +1；
 *   · 失效路线**不画假线**（这里不生成任何三角形），原因由探针/界面说；
 *   · `wallMeshes === 1` 的既有判据不动。
 */
const ROUTE_Y = {
  ribbon: 0.008,      // 地面 0 → 网格 0.002 → 动线 0.008 → 高亮 0.015 → 箭头 0.02 → 站点标记 0.026
  arrows: 0.02,       // docs/95 §6：箭头再抬高一层，鸟瞰/第一人称都不与地面打架
  markers: 0.026,     // 站点标记：起点/终点圆环、途经点菱形，压在最上面
  highlight: 0.015,   // 选中高亮夹在动线与箭头之间，不与另外两层共面
};
const ROUTE_RIBBON_HALF_W = 0.04;   // 带宽 0.08 m（docs/95 §6.1）
const ROUTE_ARROW_GAP = 0.9;        // 箭头间距 0.9 m（同上）
const ROUTE_MARKER_SEGMENTS = 10;   // 圆环/圆点的段数；8 段在贴地斜视时已经够圆

/**
 * P1 的 `plan.legs` 才是**实际可走的折线**；`plan.points` 只是用户点出的锚点。
 * 三维必须用前者 —— 旧实现用后者，于是 A→B 直接穿墙，和 2D 的自动折线对不上。
 * 按 leg 顺序拼成连续 polyline，并去掉 leg 接缝处的重复点。
 */
export function routePathPoints(plan) {
  if (!plan || !plan.ok) return [];
  const out = [];
  const add = (p) => {
    if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return;
    const last = out[out.length - 1];
    if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) <= 1e-9) return;
    out.push([p[0], p[1]]);
  };
  for (const leg of Array.isArray(plan.legs) ? plan.legs : []) {
    for (const p of Array.isArray(leg?.points) ? leg.points : []) add(p);
  }
  return out;
}

/**
 * 路线颜色**只读 CSS 令牌** `--route-1..6`（P2 在 style.css 里定义）；读不到回退 `--brand`。
 * 颜色按路线序号派生，不存 hex、不进 state、不在三维里维护第二套色表。
 */
function cssRoot() {
  return typeof document !== 'undefined' ? getComputedStyle(document.documentElement) : null;
}

/** 解析 CSS 颜色令牌用的一次性挂件（不进布局、不进无障碍树） */
let routeColorEl = null;
let routeColorCtx = null;

/**
 * 把 CSS 颜色**真的算成 RGB**。
 *
 * `getComputedStyle(root).getPropertyValue('--route-1')` 拿到的是**令牌原文** ——
 * P2 的槽位是 `var(--brand)` / `color-mix(...)`，而 `THREE.Color` 只认 `#rrggbb`/`rgb()`，
 * 直接把原文丢进去会得到**白色**（还只在控制台留一句 warning）。所以先挂到一个隐藏元素上
 * 让浏览器把 `var()`/`color-mix()` 解析成 computed color，再画进 1×1 canvas 读回字节
 * （computed 可能是 `rgb()`，也可能是 `color(srgb …)`，canvas 两种都收）。
 */
export function cssColor(text) {
  if (!text) return null;
  if (typeof document === 'undefined') {
    // Node 测试：没有文档可解析。`var()`/`color-mix()` 绝不能交给 THREE.Color ——
    // 它不抛错，而是**静默返回白色**（正是这轮踩到的坑）；字面量仍照常可读。
    if (/^(var|color-mix)\(/i.test(text)) return null;
    try { return new THREE.Color(text); } catch (err) { return null; }
  }
  routeColorEl ||= (() => {
    const el = document.createElement('span');
    el.setAttribute('aria-hidden', 'true');
    el.style.cssText = 'position:absolute;left:-9999px;top:0;width:0;height:0;overflow:hidden;';
    document.body.appendChild(el);
    return el;
  })();
  routeColorEl.style.color = '';
  routeColorEl.style.color = text;      // 无效值会被浏览器丢掉，下面据此判失败
  if (!routeColorEl.style.color) return null;
  const computed = getComputedStyle(routeColorEl).color;
  routeColorCtx ||= (() => {
    const c = document.createElement('canvas');
    c.width = 1;
    c.height = 1;
    return c.getContext('2d', { willReadFrequently: true });
  })();
  routeColorCtx.clearRect(0, 0, 1, 1);
  routeColorCtx.fillStyle = '#010203';  // 解析失败时 fillStyle 保持不变 → 读回哨兵色
  routeColorCtx.fillStyle = computed;
  routeColorCtx.fillRect(0, 0, 1, 1);
  const d = routeColorCtx.getImageData(0, 0, 1, 1).data;
  if (!d[3]) return null;
  // ⚠️ 必须按 sRGB 显式声明：`new THREE.Color(r,g,b)` 把三个数当**线性**工作色，
  //    `getHexString()` 再做一次线性→sRGB 编码，#005caf 会变成 #00a2d8（实测）。
  return new THREE.Color().setRGB(d[0] / 255, d[1] / 255, d[2] / 255, THREE.SRGBColorSpace);
}

function routeColorOf(index, root) {
  const css = root ?? cssRoot();
  const pick = (name) => (css ? String(css.getPropertyValue(name) || '').trim() : '');
  const slot = `--route-${(index % 6) + 1}`;
  return cssColor(pick(slot) || pick('--brand') || '') || new THREE.Color(1, 1, 1);
}

/**
 * 把 `planRoutes()` 的结果拼成**合并几何**（纯函数，不碰场景/相机/第一人称）。
 *
 * @param {Array<{ok:boolean, points:number[][], legs?:Array, length:number}>} planned 与 `layout.routes` 等长
 * @param {{colors?:THREE.Color[], ribbonY?:number, arrowsY?:number, arrows?:boolean, markers?:boolean}} [opts]
 * @return {{ribbon:THREE.BufferGeometry|null, arrows:THREE.BufferGeometry|null, triangles:number,
 *           valid:number, invalid:number, length:number, markers:number}} 失效路线不产生任何三角形
 */
export function buildRouteGeometry(planned, opts = {}) {
  const list = Array.isArray(planned) ? planned : [];
  const colors = Array.isArray(opts.colors) ? opts.colors : [];
  const ribbonY = Number.isFinite(opts.ribbonY) ? opts.ribbonY : ROUTE_Y.ribbon;
  const arrowsY = Number.isFinite(opts.arrowsY) ? opts.arrowsY : ROUTE_Y.arrows;
  const wantArrows = opts.arrows !== false;
  const wantMarkers = opts.markers !== false;
  const ribbonPos = [];
  const ribbonCol = [];
  const arrowPos = [];
  const arrowCol = [];
  let valid = 0;
  let length = 0;
  let markers = 0;

  const pushTri = (pos, col, a, b, c, color) => {
    pos.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    col.push(
      color.r, color.g, color.b,
      color.r, color.g, color.b,
      color.r, color.g, color.b,
    );
  };

  /** 贴地圆点/圆环/菱形环 —— 站点标记与 ribbon/箭头共用同一份箭头几何，路线仍是 2 个 mesh。 */
  const markerY = ROUTE_Y.markers;
  const markerInk = new THREE.Color(0x24445f);
  const at = (cx, cz, r, a) => [cx + Math.cos(a) * r, markerY, cz + Math.sin(a) * r];
  const pushDisc = (cx, cz, r, color) => {
    for (let i = 0; i < ROUTE_MARKER_SEGMENTS; i += 1) {
      const a0 = (i / ROUTE_MARKER_SEGMENTS) * Math.PI * 2;
      const a1 = ((i + 1) / ROUTE_MARKER_SEGMENTS) * Math.PI * 2;
      pushTri(arrowPos, arrowCol,
        [cx, markerY, cz], at(cx, cz, r, a1), at(cx, cz, r, a0), color);
    }
  };
  const pushRing = (cx, cz, rIn, rOut, color) => {
    for (let i = 0; i < ROUTE_MARKER_SEGMENTS; i += 1) {
      const a0 = (i / ROUTE_MARKER_SEGMENTS) * Math.PI * 2;
      const a1 = ((i + 1) / ROUTE_MARKER_SEGMENTS) * Math.PI * 2;
      const o0 = at(cx, cz, rOut, a0);
      const o1 = at(cx, cz, rOut, a1);
      const i0 = at(cx, cz, rIn, a0);
      const i1 = at(cx, cz, rIn, a1);
      pushTri(arrowPos, arrowCol, o0, o1, i1, color);
      pushTri(arrowPos, arrowCol, o0, i1, i0, color);
    }
  };
  const pushDiamond = (cx, cz, rIn, rOut, color) => {
    for (let i = 0; i < 4; i += 1) {
      const a0 = (i / 4) * Math.PI * 2;
      const a1 = ((i + 1) / 4) * Math.PI * 2;
      const o0 = at(cx, cz, rOut, a0);
      const o1 = at(cx, cz, rOut, a1);
      const i0 = at(cx, cz, rIn, a0);
      const i1 = at(cx, cz, rIn, a1);
      pushTri(arrowPos, arrowCol, o0, o1, i1, color);
      pushTri(arrowPos, arrowCol, o0, i1, i0, color);
    }
  };

  list.forEach((plan, routeIndex) => {
    if (!plan || !plan.ok) return;
    const path = routePathPoints(plan);
    if (path.length < 2) return;
    const color = colors[routeIndex] || new THREE.Color(1, 1, 1);
    valid += 1;
    length += Number(plan.length) || 0;

    // 用 P1 的 legs 拼真实折线（自动过门/绕设备）；`plan.points` 只是用户锚点，不能直接连。
    const segs = [];
    for (let i = 0; i + 1 < path.length; i += 1) {
      const [ax, az] = path[i];
      const [bx, bz] = path[i + 1];
      const dx = bx - ax;
      const dz = bz - az;
      const len = Math.hypot(dx, dz);
      if (len < 1e-6) continue;
      segs.push({ ax, az, bx, bz, ux: dx / len, uz: dz / len, len });
    }
    if (!segs.length) return;

    // 贴地 ribbon：每段一个四边形（两端各延出半个带宽，转角处自然搭上；同色重叠看不见缝）
    for (const s of segs) {
      const nx = -s.uz * ROUTE_RIBBON_HALF_W;
      const nz = s.ux * ROUTE_RIBBON_HALF_W;
      const ex = s.ux * ROUTE_RIBBON_HALF_W;
      const ez = s.uz * ROUTE_RIBBON_HALF_W;
      const ax = s.ax - ex;
      const az = s.az - ez;
      const bx = s.bx + ex;
      const bz = s.bz + ez;
      const p1 = [ax + nx, ribbonY, az + nz];
      const p2 = [bx + nx, ribbonY, bz + nz];
      const p3 = [bx - nx, ribbonY, bz - nz];
      const p4 = [ax - nx, ribbonY, az - nz];
      pushTri(ribbonPos, ribbonCol, p1, p2, p3, color);
      pushTri(ribbonPos, ribbonCol, p1, p3, p4, color);
    }

    // 箭头：沿行进方向每 0.9 m 一个扁平三角形；短于 0.9 m 的整条路线在中点放一个
    if (wantArrows) {
      const total = segs.reduce((sum, s) => sum + s.len, 0);
      const before = arrowPos.length;
      let nextAt = ROUTE_ARROW_GAP / 2;
      let cursor = 0;
      const arrowAt = (px, pz, ux, uz) => {
        const nx = -uz * 0.09;
        const nz = ux * 0.09;
        const tip = [px + ux * 0.14, arrowsY, pz + uz * 0.14];
        const left = [px - ux * 0.10 + nx, arrowsY, pz - uz * 0.10 + nz];
        const right = [px - ux * 0.10 - nx, arrowsY, pz - uz * 0.10 - nz];
        pushTri(arrowPos, arrowCol, tip, right, left, color);
      };
      for (const s of segs) {
        while (nextAt <= cursor + s.len) {
          const t = (nextAt - cursor) / s.len;
          arrowAt(s.ax + (s.bx - s.ax) * t, s.az + (s.bz - s.az) * t, s.ux, s.uz);
          nextAt += ROUTE_ARROW_GAP;
        }
        cursor += s.len;
      }
      if (arrowPos.length === before && total > 0.2) {
        // 整条路线短于半个间距：仍给一个箭头（不然短动线在三维里只剩一条线，看不出方向）
        const half = total / 2;
        let walked = 0;
        for (const s of segs) {
          if (half <= walked + s.len) {
            const t = (half - walked) / s.len;
            arrowAt(s.ax + (s.bx - s.ax) * t, s.az + (s.bz - s.az) * t, s.ux, s.uz);
            break;
          }
          walked += s.len;
        }
      }
    }

    // 站点标记：起点/终点 = 深色圆环 + 路线色圆点；中间途经点 = 深色菱形环 + 路线色圆点。
    // 环用深色是为了在浅色地面上真的看得见（白色环在 62% 透明下几乎消失）。
    // 与箭头共用 `routes-arrows` 这一份几何，所以常态仍是 ribbon/arrows 两个 mesh。
    if (wantMarkers) {
      const stops = Array.isArray(plan.points) ? plan.points : [];
      stops.forEach((p, i) => {
        if (!Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return;
        const end = i === 0 || i === stops.length - 1;
        if (end) pushRing(p[0], p[1], 0.075, 0.125, markerInk);
        else pushDiamond(p[0], p[1], 0.075, 0.135, markerInk);
        pushDisc(p[0], p[1], 0.055, color);
        markers += 1;
      });
    }
  });

  const makeGeom = (pos, col) => {
    if (!pos.length) return null;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeBoundingSphere();
    return g;
  };
  return {
    ribbon: makeGeom(ribbonPos, ribbonCol),
    arrows: makeGeom(arrowPos, arrowCol),
    triangles: (ribbonPos.length + arrowPos.length) / 9,
    valid,
    invalid: list.length - valid,
    length: +length.toFixed(3),
    markers,
  };
}

function createView3D() {
  let renderer = null;
  let scene = null;
  let camera = null;
  let controls = null;
  let canvas = null;
  let observer = null;
  let attached = false;

  // 场景里的活物件
  let groundGroup = null;
  let wallGroup = null;
  /** 上一次建墙的读数（合并成一份几何之后不能再数 children —— 那数的是网格数，不是墙数） */
  let lastWallPieces = { pieces: 0, fills: 0, walls: 0, openings: 0, lintels: 0, sills: 0 };
  /** 「走进去」/「站到 A 点」的下一双站位（`wantSpawn` 写、`setView('walk')` 读并清空） */
  let pendingSpawn = null;
  /** 与 `pendingSpawn` 配套的可选朝向（弧度；= 站到 A 点、面朝 B）。不传就沿用原来的「朝房间中心」 */
  let pendingSpawnYaw = null;
  /** 外墙外观读数（探针要能读到"到底多透"，否则等于没接） */
  let lastWallStyle = { style: null, opacity: 1 };
  let itemGroup = null;
  let pickGroup = null;      // 选中标记
  let items = new Map();     // id → {group, clone, doors, lod, productId, triangles}

  // 动线（P3）：两份合并几何 + 一份选中高亮；状态读数给探针/界面用
  let routeGroup = null;     // 贴地 ribbon 1 mesh + 箭头 1 mesh（都在这一组里）
  let routeHiGroup = null;   // 选中路线高亮（最多 1 mesh；常态为空）
  // 柱（P4·docs/101 §三.3）：独立 `columnGroup`，**不并入 wallGroup**（`wallMeshes === 1` 的判据不动）。
  let columnGroup = null;        // 全部柱合并成 1 份几何
  let columnShadowGroup = null;  // 接触阴影合并成 1 份几何（y≈0.003 的贴花，不写深度）
  let columnHiGroup = null;      // 选中高亮 0/1（2D「柱」卡/画布驱动，3D 不可点选）
  let columnSelectedId = null;
  // 上次建柱的"签名"：列内容 / 层高 / 墙档位不透明度 —— 三者都没变就不再重建（拖设备不该重建柱）
  let lastColumnsKey = null;
  let lastColumns = {
    count: 0, meshes: 0, shadowMeshes: 0, hiMeshes: 0, triangles: 0, shadowTriangles: 0,
  };
  let lastRoutes = { count: 0, valid: 0, invalid: 0, status: 'none', statuses: [], triangles: 0, length: 0, markers: 0 };
  let lastPlanned = [];      // planRoutes() 结果（与 layout.routes 等长；站到 A 点要读）
  let routeSelectedId = null;

  let layout = null;
  let view = 'orbit';        // 'orbit' | 'walk'
  let level = 'auto';
  /** 像素比上限（默认 2）—— 面客模式在平板上收到 1.5，见 `attach` 的参数说明 */
  let pixelRatioCap = 2;
  let selectedId = null;
  let onSelect = () => {};
  /**
   * 场景**真的搭完**时喊一声（GLB 异步：`setLayout` 的 promise 落定时模型还在路上）。
   *
   * ⭐ 为什么必须有这个回调（真机拓出来的缺陷 **D54**）：面客模式那句话「正在载入模型…（n/m）」
   * 只在**开始**算过一次 —— 模型早到位了，那句话还挂在屏幕上，页面在说假话。
   * 修法不能是"多轮询几次"（轮询次数是猜的），得让**知道这件事的人**（内核）说出来。
   */
  let onSceneSettled = null;
  // 场景自己也会改视角（第一人称里按 Esc 回鸟瞰）—— 界面必须知道，否则按钮/浮层停在旧视角上，
  // 表现就是"Esc 按了没反应"（实测：内部状态确实变了，但界面没变）。
  let onExitWalk = null;
  const errors = [];
  /**
   * 「目录里压根没有这一款的模型」的**台数**（与 `errors` 分开：一个是"没做好"，一个是"没加载出来"）。
   *
   * 面客模式要说的话完全不同（`present.js` 的 `presentNote`），而这两种情况以前只能从
   * `errors` 的**文字**里猜（`${p}: 目录里没有可用模型`）—— 靠字符串匹配认状态，
   * 改一个字就默默失效。所以这里给一个结构化的数。
   */
  let missingAssetItems = 0;

  const walk = { yaw: 0, pitch: 0, pos: new THREE.Vector3(1.0, 0, 1.0), speed: 1.4,
    stuck: false };   // FIX-17：嵌在几何体里时置位，界面必须说出来（不许静默）
  // 视点高度不再写在这里：读参数表 `walk.eyeM`（原来硬编码 1.6，与"参数表是唯一真源"不符 —— W1 顺手改掉）

  /**
   * 封面截图的长边上限（px）。
   *
   * 为什么要在**截图这一步**就限住：画布的实际像素是 `CSS 尺寸 × pixelRatio(≤2)`，
   * 大屏上很容易超过服务端 2 MB 的上限 —— 那条判据是**兜底**，不该变成日常打扰。
   * 缩到长边 ≤1600 之后，一张三维截图通常在 300–800 KB，尺寸也仍然够看清。
   */
  const CAPTURE_MAX = 1600;

  /* ---------------- 搭场景 ---------------- */

  /**
   * @param {HTMLCanvasElement} el 画布
   * @param {{maxPixelRatio?:number}} [opts]
   *   `maxPixelRatio` = 像素比上限（默认 2）。**面客模式传 1.5**：2K 平板的物理像素是
   *   2560×1600 起步，按 2 倍渲染等于每帧画 400 万像素的点，中低端平板会掉帧 ——
   *   收到 1.5 视觉上几乎无差，像素少 44%。这件事**记在文档里**（`docs/57`），不假装没降。
   */
  function attach(el, opts = {}) {
    if (attached) return;
    canvas = el;
    pixelRatioCap = Number(opts.maxPixelRatio) > 0 ? Number(opts.maxPixelRatio) : 2;
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelRatioCap));
    renderer.outputColorSpace = THREE.SRGBColorSpace;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0xeef2f5);
    camera = new THREE.PerspectiveCamera(55, 1, 0.05, 120);
    camera.rotation.order = 'YXZ';

    scene.add(new THREE.HemisphereLight(0xffffff, 0x8fa3b0, 2.0));
    const sun = new THREE.DirectionalLight(0xffffff, 2.4);
    sun.position.set(4, 8, 6);
    scene.add(sun);
    const fill = new THREE.DirectionalLight(0xffffff, 0.7);
    fill.position.set(-6, 5, -4);
    scene.add(fill);

    groundGroup = new THREE.Group();
    wallGroup = new THREE.Group();
    itemGroup = new THREE.Group();
    pickGroup = new THREE.Group();
    routeGroup = new THREE.Group();
    routeGroup.name = 'routes';
    routeHiGroup = new THREE.Group();
    routeHiGroup.name = 'routes-hi';
    columnGroup = new THREE.Group();
    columnGroup.name = 'columns';
    columnShadowGroup = new THREE.Group();
    columnShadowGroup.name = 'columns-shadow';
    columnHiGroup = new THREE.Group();
    columnHiGroup.name = 'columns-hi';
    scene.add(groundGroup, wallGroup, columnGroup, columnShadowGroup, itemGroup, pickGroup,
      routeGroup, routeHiGroup, columnHiGroup);
    items.clear();          // 上一轮挂载的物件属于旧场景，不能带过来
    lastRoutes = { count: 0, valid: 0, invalid: 0, status: 'none', statuses: [], triangles: 0, length: 0, markers: 0 };
    lastPlanned = [];
    lastColumnsKey = null;
    lastColumns = { count: 0, meshes: 0, shadowMeshes: 0, hiMeshes: 0, triangles: 0, shadowTriangles: 0 };
    errors.length = 0;
    missingAssetItems = 0;

    controls = new OrbitControls(camera, canvas);
    controls.enableDamping = false;    // 关阻尼 → 不需要每帧循环
    controls.maxPolarAngle = Math.PI / 2 - 0.02;
    controls.minDistance = 1;
    controls.maxDistance = 60;
    controls.addEventListener('change', renderOnce);
    // ⭐ D51：`OrbitControls` **必须跟着视角开关**。
    //    以前全文没有一处 `controls.enabled = false` —— 桌面端看不出来（指针锁定时 clientX/Y
    //    不动，OrbitControls 收不到位移），但**锁定失败 / 按过 Esc 解锁 / 触摸**这三条路径上，
    //    它与第一人称的 `walkLook` **同时改一个相机**（表现：拖着拖着视角自己弹一下、
    //    滚轮在漫游里把机位推走）。面客模式（平板、没有指针锁定）必然踩到。
    controls.enabled = !isWalk();
    canvas.addEventListener('dblclick', onDoubleClick);

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointerup', onPointerUp);
    // 触摸环视（面客模式第②层降级）—— 与鼠标那条路严格分流，见 `onPointerMove`
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointercancel', onPointerCancel);
    document.addEventListener('pointerlockchange', onLockChange);
    document.addEventListener('pointerlockerror', onLockError);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('keydown', onKeyDown);
    observer = new ResizeObserver(resize);
    observer.observe(canvas.parentElement ?? canvas);

    attached = true;
    resize();
  }

  function resize() {
    if (!renderer) return;
    const host = canvas.parentElement ?? canvas;
    const w = Math.max(1, Math.floor(host.clientWidth || canvas.clientWidth || 640));
    const h = Math.max(1, Math.floor(host.clientHeight || canvas.clientHeight || 480));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderOnce();
  }

  function renderOnce() {
    // 已释放（renderer 被丢掉）时画一笔也画不出东西 —— 直接不画，
    // 而不是拿一个失去上下文的 renderer 去画（那是静默失败：屏幕上什么都没有，控制台也什么都没有）
    if (!renderer) return;
    if (!renderer || !scene || !camera) return null;
    renderer.render(scene, camera);
    return probeRender();
  }

  /**
   * 截一张"现在这个视角"（R6-3 3f 封面的原料）。
   *
   * ## 三个决定，每个都有理由
   *
   * ① **先渲一次再取**。渲染器建的时候已经开了 `preserveDrawingBuffer`
   *    （不开的话 `toDataURL` 拿到的是一片空白 —— 这是这个坑的标准成因），
   *    但"渲完立刻取"仍然是更稳的做法：缓冲区可能已被别的绘制翻掉。
   *
   * ② **截图前把选中高亮清掉**。选中框是**界面状态**，不是方案内容 ——
   *    一张卡片封面上挂着橙色描边，读的人会以为方案里有个"被选中的东西"。
   *    清完立刻恢复，屏幕上的观感不变。
   *
   * ③ **失败返回 null，不编一张图**。封面不是关键路径：卡片退回占位
   *    （「没有封面」），而不是拿一张白图或旧图冒充。**假封面比没封面更坏。**
   *
   * @returns {string|null} `data:image/png;base64,...`，或 null
   */
  /**
   * 把相机摆到某个**固定视角**（`views3d.js` 那三个）—— 只摆机位，不截图。
   *
   * 抽出来是为了让「摆机位」只有一份实现：交付包的三张截图（`shotView`）与面客模式打开时
   * 停住的那个机位（`PresentView` → `frameView(front45)`）用的是同一段代码（D48）。
   */
  function aimView(v) {
    if (!renderer || !scene || !camera || !controls || !layout || !v) return false;
    const p = viewPoint(layout.w, layout.d, layout.h, v);
    camera.position.set(p.pos.x, p.pos.y, p.pos.z);
    controls.target.set(p.target.x, p.target.y, p.target.z);
    camera.lookAt(controls.target);
    controls.update();
    return true;
  }

  /**
   * 摆到固定视角**并留在那儿**。
   *
   * 与 `shotView` 的区别就这一条：`shotView` 截完会把相机**还给用户**（它的副作用不能是
   * 「我的视图被挪走了」），而这个是给界面用的 —— 用户就希望停在那个机位。
   */
  function frameView(v) {
    if (!aimView(v)) return false;
    renderOnce();
    return true;
  }

  /**
   * 按 A13 的某个固定视角截一张（交付包用）。
   *
   * 三条与 `snapshot()` 不同的地方，都是刻意的：
   *   ① **要摆机位**：先把相机放到 `viewPoint()` 算出的位置、看向房间中心，渲一帧，再截。
   *   ② **截完必须把相机还给用户**：三张截完，用户看到的还是他自己那个视角 ——
   *      不还原的话，"打了个交付包"这件事的副作用是"我的视图被挪走了"（而且用户不知道为什么）。
   *   ③ 返回 `null` 就是真截不到（画布没准备好）—— **不拿一张白图冒充**（与封面同一条规矩）。
   *
   * @param {{id:string,distFactor:number}} view 来自 `views3d.js` 的固定视角
   * @returns {string|null} dataURL
   */
  function shotView(view) {
    if (!renderer || !scene || !camera || !controls || !layout) return null;
    const keepPos = camera.position.clone();
    const keepTarget = controls.target.clone();
    try {
      if (!aimView(view)) return null;
      renderOnce();
      return snapshotWithoutRestore();
    } catch (e) {
      console.warn('[scene3d] 固定视角截不出：' + e.message + '（视角=' + view.id + '）');
      return null;
    } finally {
      camera.position.copy(keepPos);
      controls.target.copy(keepTarget);
      camera.lookAt(controls.target);
      controls.update();
      renderOnce();
    }
  }

  /** `snapshot()` 去掉"还原选中态"的那部分（它自己被 shotView 包着用，别把两件事叠一起） */
  function snapshotWithoutRestore() {
    const src = renderer.domElement;
    const scale = Math.min(1, CAPTURE_MAX / Math.max(src.width, src.height));
    let out = src;
    if (scale < 1) {
      const off = document.createElement('canvas');
      off.width = Math.max(1, Math.round(src.width * scale));
      off.height = Math.max(1, Math.round(src.height * scale));
      off.getContext('2d').drawImage(src, 0, 0, off.width, off.height);
      out = off;
    }
    return out.toDataURL('image/png');
  }

  /**
   * 离屏截一张**固定视角**（#5：保存方案时三维没挂载，也要有封面）。
   *
   * 用户反馈"维护端方案库列表缺封面"。量出来的成因不在渲染，而在**根本没截**：
   * `snapshot()` 要求三维画布已挂载，而绝大多数人是在**平面图**里设计、保存的 →
   * 每次都是 `null` → 库里的 `cover_file` 永远是空。
   *
   * 这里复用**同一套场景代码**（`attach` → `setLayout` → `shotView`），只是把画布挂在屏幕外：
   * 于是"平面图里保存"也能得到封面，而且与交付包里第一张图**同机位**（可复现）。
   *
   * ⚠️ 用完必须 `dispose()`：里面会 `forceContextLoss()` —— WebGL 上下文是有限资源，
   *    浏览器超了会偷偷丢掉最早那个（画面变黑、还不报错，B18 的教训）。
   * ⚠️ 画布必须**有尺寸的父元素**：`resize()` 读父元素的 clientWidth，游离的 canvas 量到 0，
   *    会退化成 640×480（能出图，但不是我们要的尺寸）。
   */
  async function snapshotOffscreen(l, view) {
    if (!l || !view) return null;
    if (attached) return shotView(view); // 已经挂着就用现成的，不重复建上下文
    const host = document.createElement('div');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'position:fixed;left:-10000px;top:0;width:960px;height:720px;'
      + 'pointer-events:none;opacity:0;';
    const cv = document.createElement('canvas');
    host.appendChild(cv);
    document.body.appendChild(host);
    try {
      attach(cv);
      await setLayout(l); // 等模型真的到位（GLB 异步；不等就会拍出半成品）
      return shotView(view);
    } catch (e) {
      if (errors.length < 12) errors.push(`离屏截图失败：${e.message}`);
      return null;
    } finally {
      dispose();
      host.remove();
    }
  }

  function snapshot() {
    if (!renderer || !canvas || !canvas.width) return null;
    const keep = selectedId;
    try {
      setSelected(null);
      renderOnce();
      const src = renderer.domElement;
      const scale = Math.min(1, CAPTURE_MAX / Math.max(src.width, src.height));
      let out = src;
      if (scale < 1) {
        // 缩小用 2D 画布画一遍：比"重新摆机位再渲一次"简单，也不改变场景状态
        const off = document.createElement('canvas');
        off.width = Math.max(1, Math.round(src.width * scale));
        off.height = Math.max(1, Math.round(src.height * scale));
        off.getContext('2d').drawImage(src, 0, 0, off.width, off.height);
        out = off;
      }
      const url = out.toDataURL('image/png');
      return url && url.length > 200 ? url : null;
    } catch (e) {
      console.warn('[scene3d] 截不出封面：' + e.message);   // 出声，但不打断保存
      return null;
    } finally {
      setSelected(keep);
      renderOnce();
    }
  }

  /* ---------------- 房间与墙体 ---------------- */

  function clearGroup(g) {
    while (g.children.length) {
      const c = g.children.pop();
      // 几何与材质都是**每次重建新建的**（地面/墙/选中标记/动线），不释放会随布局拖拽一直涨。
      // 这里只处理被整组清空的这几组（地面/墙/选中/动线）；设备组按台账增删，不在这里碰。
      c.traverse?.((o) => {
        if (!o.isMesh && !o.isLine) return;
        o.geometry?.dispose?.();
        o.material?.dispose?.();
      });
      c.parent = null;
    }
  }

  function buildRoom(l) {
    clearGroup(groundGroup);
    clearGroup(wallGroup);

    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(l.w, l.d),
      new THREE.MeshStandardMaterial({ color: COLORS.ground, roughness: 0.95, metalness: 0 }),
    );
    plane.rotation.x = -Math.PI / 2;
    plane.position.set(l.w / 2, 0, l.d / 2);
    plane.name = 'ground';
    groundGroup.add(plane);

    const grid = new THREE.GridHelper(Math.max(l.w, l.d), Math.round(Math.max(l.w, l.d)), COLORS.grid, COLORS.grid);
    grid.position.set(l.w / 2, 0.002, l.d / 2);
    grid.name = 'grid';
    groundGroup.add(grid);

    // ⚠️ 以前这里每面墙建一个**轴对齐 AABB 盒子**（拿 wallBox 的四点取 min/max）→
    //    转角互相穿模 + 顶面共面打架 + 半透明内墙排序错乱（「缝隙 / 面错位 / 破面」的真身）。
    //    现在按 `wallPieces()` 的构件建：斜接（两墙）/ 齐平（T 形）/ 补角（三岔口以上）+ 0.5 mm 咬入。
    //    每类合并成一份几何：内墙只画一次透明 → 排序问题从根上没了。
    const { pieces, fills } = wallPieces(l);
    const openingsTotal = l.walls.reduce((n, w) => n + openingsOf(w).length, 0);
    lastWallPieces = { pieces: pieces.length, fills: fills.length, walls: l.walls.length, openings: openingsTotal, lintels: 0, sills: 0 };
    // 墙体外观只有**一个**判据：方案选了档位就按方案，没选就按参数表 space.wallOpacity（默认 1 = 实心）。
    // 用户真机反馈：内墙必须与外墙**一模一样** —— 所以外墙 / 内墙 / 接角块**合并成一份网格、一个材质**。
    // 顺带把"透明物体排序"这个问题从根上消掉：场景里只有一份透明墙，没有第二个可以排错的对象。
    const opacity = wallOpacityOf(l.view?.wallOpacity, cfg.space.wallOpacity);
    lastWallStyle = { style: l.view?.wallOpacity ?? null, opacity };
    // ⚠️ 构件与补角都是**凸多边形**（斜接之后可能是 5 边形）→ BoxGeometry 用不上，
    //    走内核的棱柱（`prismFaces`）：缠绕、法线方向在内核里就被断言过，渲染层只管塞点。
    const geoms = [];
    const prism = (poly, h, base = 0) => {
      const f = prismFaces(poly, h, base);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(f.positions, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(f.normals, 3));
      return g;
    };
    // ⭐ 洞口（W1 门洞 / W2 窗）：一面带洞的墙**不是一个棱柱**（`prismFaces` 要凸；"把墙切成两段"又会丢掉过梁）。
    //    所以按内核算好的分块建：**左右实心段（base=0）+ 过梁（base=洞高）**。
    //    没有门洞时 `solidBlocks` 返回整块、`base=0` —— 与以前逐字一致（零回归）。
    for (const pc of pieces) {
      for (const b of solidBlocks(pc, openingsOf(pc.wall))) {
        // ⭐ 窗这一批**几何零改动**：`prism(poly, height, base)` 本来就吃任意 base，
        //    而「窗下墙」就是一块 `base=0 / height=sill` 的块 —— 门洞当初留下 `base` 那一步的红利。
        if (b.kind === 'lintel') lastWallPieces.lintels++;
        if (b.kind === 'sill') lastWallPieces.sills++;
        geoms.push(prism(b.poly, b.height, b.base));
      }
    }
    for (const f of fills) geoms.push(prism(f.poly, f.h));    // 三岔口以上才可能有
    if (geoms.length) {
      const mesh = new THREE.Mesh(
        mergeGeometries(geoms),
        new THREE.MeshStandardMaterial({
          color: COLORS.wall,
          roughness: 0.9, metalness: 0,
          transparent: opacity < 1,
          opacity,
        }),
      );
      for (const g of geoms) g.dispose();
      mesh.name = 'wall';
      wallGroup.add(mesh);
    }
  }

  /* ---------------- 动线（P3） ---------------- */

  /**
   * 动线材质：贴地 + 真深度测试（墙/设备正常遮挡）+ 关写深（避免和地面打架）。
   * `polygonOffset` 只解决**同一像素**的深度之争，不替代 y 分层 —— 两层都做才稳。
   */
  function routeMaterial(opacity) {
    return new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity,
      depthTest: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      // ⭐ -2 在无头 Edge（深度精度更差）里会被地面挡住 —— 实测动线整条看不见；
      //    -16 足够稳，且只影响这一层贴花，不会把墙/设备的遮挡关系改掉。
      polygonOffsetUnits: -16,
      side: THREE.DoubleSide,
      // ⭐ three 默认把**透明双面**材质画两遍（先背面再正面，改善排序）—— 那会让
      //    「ribbon 1 mesh」实际产生 2 次 draw call。动线是贴地平面、两层几何不重叠，
      //    单遍就够；关掉之后 mesh 数 = draw call 数（常态正好 +2）。
      forceSinglePass: true,
    });
  }

  function addRouteMesh(group, geom, name, opacity, renderOrder) {
    if (!geom) return null;
    const mesh = new THREE.Mesh(geom, routeMaterial(opacity));
    mesh.name = name;
    mesh.renderOrder = renderOrder;
    mesh.matrixAutoUpdate = false;   // 顶点已经是世界坐标（米），不需要再乘一次矩阵
    mesh.updateMatrix();
    group.add(mesh);
    return mesh;
  }

  /**
   * 建**全部**动线的贴地呈现：ribbon 1 mesh + 箭头 1 mesh；选中路线再加 1 份高亮 ribbon。
   * 读 `layout.routes`（用户点出的站点），折线/状态全由 P1 内核 `planRoutes()` 派生 ——
   * 三维不自己解析、不重新寻路；失效路线在这里**一个三角形都不生成**（不画假线）。
   */
  function buildRoutes(l) {
    if (!routeGroup || !routeHiGroup) return;
    clearGroup(routeGroup);
    clearGroup(routeHiGroup);
    const routes = Array.isArray(l?.routes) ? l.routes : [];
    lastPlanned = routes.length ? planRoutes(l, { getProduct }) : [];
    const colors = routes.map((r, i) => routeColorOf(i, cssRoot()));
    const base = buildRouteGeometry(lastPlanned, { colors });
    addRouteMesh(routeGroup, base.ribbon, 'routes-ribbon', 0.46, 3);
    addRouteMesh(routeGroup, base.arrows, 'routes-arrows', 0.62, 4);

    let hi = null;
    const selIdx = routes.findIndex((r) => String(r.id) === String(routeSelectedId));
    if (selIdx >= 0 && lastPlanned[selIdx]?.ok) {
      hi = buildRouteGeometry([lastPlanned[selIdx]], { colors: [colors[selIdx]], ribbonY: ROUTE_Y.highlight, arrows: false, markers: false });
      addRouteMesh(routeHiGroup, hi.ribbon, 'routes-hi', 0.95, 5);
    }
    const statuses = routes.map((r, i) => {
      const p = lastPlanned[i];
      return {
        id: r?.id ?? null,
        name: r?.name || `动线 ${i + 1}`,
        status: p?.ok ? 'ok' : 'blocked',
        reason: p?.reason ?? null,
        message: p?.message ?? null,
      };
    });
    const invalid = statuses.filter((x) => x.status !== 'ok').length;
    lastRoutes = {
      count: routes.length,
      valid: statuses.length - invalid,
      invalid,
      status: routes.length === 0 ? 'none' : (invalid === 0 ? 'ok' : 'blocked'),
      statuses,
      triangles: base.triangles + (hi?.triangles ?? 0),
      length: +(base.length).toFixed(2),
      markers: base.markers,
    };
    if (!attached) return;
    if (isWalk()) applyWalk(); else renderOnce();
  }

  /** 选中哪条动线（P2 的图例/右栏选中同步用；只影响高亮，不影响几何合法性） */
  function setRouteSelected(id) {
    routeSelectedId = id == null ? null : id;
    if (attached && layout) buildRoutes(layout);
  }

  /**
   * 「站到 A 点」：只把相机放到 A、朝向 B（复用 `wantSpawn`），不自动沿线走、不锁方向。
   * 返回 `{ok, at, yaw, reason}` —— 调用方（View3D）自己切第一人称。
   */
  function standAtRoute(id) {
    if (!layout) return { ok: false, reason: 'not-ready' };
    const routes = Array.isArray(layout.routes) ? layout.routes : [];
    let idx = routes.findIndex((r) => String(r.id) === String(id));
    if (idx < 0) idx = routes.findIndex((r, i) => lastPlanned[i]?.ok);
    const plan = idx >= 0 ? (lastPlanned[idx] || planRoutes(layout, { getProduct })[idx]) : null;
    const path = routePathPoints(plan);
    if (!plan || !plan.ok || path.length < 2) {
      return { ok: false, reason: plan?.reason || 'no-valid-route', message: plan?.message || null };
    }
    const a = path[0];
    const b = path[1];
    const yaw = Math.atan2(b[0] - a[0], b[1] - a[1]);
    wantSpawn(a[0], a[1], { yaw });
    return { ok: true, at: [a[0], a[1]], yaw: +yaw.toFixed(4), routeId: routes[idx]?.id ?? null };
  }

  /* ---------------- 柱（P4·docs/101 §三.3 / docs/100 §6） ---------------- */

  /** 重建与否只看这三件事：柱内容 / 层高 / 墙档位（柱不透明度与墙同源） */
  function columnKey(l) {
    const cols = columnsOf(l).map((c) => `${c.id}:${c.x}:${c.z}:${c.w}:${c.d}`).join('|');
    const opacity = wallOpacityOf(l?.view?.wallOpacity, cfg.space.wallOpacity);
    return `${cols}@h${Number(l?.h) || 0}@o${opacity}`;
  }

  /** 全部柱合并 1 份几何 + 接触阴影合并 1 份；空方案两个组都是空的（0 draw） */
  function buildColumns(l) {
    clearGroup(columnGroup);
    clearGroup(columnShadowGroup);
    const cols = columnsOf(l);
    const opacity = wallOpacityOf(l?.view?.wallOpacity, cfg.space.wallOpacity);
    const built = buildColumnsGeometry(cols, l?.h);

    if (built.body) {
      const mesh = new THREE.Mesh(built.body, new THREE.MeshStandardMaterial({
        // 材质与墙**同源**（docs/100 §6.1）：同色、同粗糙度，不透明度跟墙档位；
        // 顶面/侧面靠灯光与法线分层，不靠第二套颜色（也就不会多一个材质/draw call）。
        color: COLORS.wall,
        roughness: 0.9,
        metalness: 0,
        transparent: opacity < 1,
        opacity,
      }));
      mesh.name = 'column';
      columnGroup.add(mesh);
    }
    if (built.shadow) {
      const sm = new THREE.Mesh(built.shadow, new THREE.MeshBasicMaterial({
        color: COLORS.columnShadow,
        transparent: true,
        opacity: 0.22,
        depthTest: true,
        depthWrite: false,               // 不写深度：只是"落地感"，不参与遮挡
        side: THREE.DoubleSide,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -2,
      }));
      sm.name = 'column-shadow';
      sm.renderOrder = 1;
      columnShadowGroup.add(sm);
    }

    lastColumns = {
      count: built.count,
      meshes: columnGroup.children.length,
      shadowMeshes: columnShadowGroup.children.length,
      hiMeshes: columnHiGroup.children.length,
      triangles: built.triangles,
      shadowTriangles: built.shadowTriangles,
    };
    applyColumnSelection();
    return lastColumns;
  }

  /**
   * **增量入口**（docs/101 §三.3）：柱内容/层高/墙档位都没变就一次几何都不重建 ——
   * 拖设备、改房名、切视图都不会把柱重建一遍。`setLayout` 走这条。
   */
  function setColumns(l) {
    if (!attached) return lastColumns;
    const key = columnKey(l);
    if (key === lastColumnsKey) return lastColumns;
    lastColumnsKey = key;
    buildColumns(l);
    if (isWalk()) applyWalk(); else renderOnce();
    return lastColumns;
  }

  /** 选中哪根柱（2D 画布/「柱」卡驱动；**3D 不点选**，最多 1 个高亮对象） */
  function setSelectedColumn(id) {
    columnSelectedId = id == null ? null : id;
    if (!attached) return;
    applyColumnSelection();
    if (isWalk()) applyWalk(); else renderOnce();
  }

  function applyColumnSelection() {
    if (!columnHiGroup) return;
    clearGroup(columnHiGroup);
    if (columnSelectedId == null || !layout) return;
    const c = columnsOf(layout).find((x) => String(x.id) === String(columnSelectedId));
    if (!c) return;
    const h = Number(layout.h) > 0 ? Number(layout.h) : 2.8;
    const box = new THREE.BoxGeometry(c.w, h, c.d);
    const edges = new THREE.EdgesGeometry(box);
    box.dispose();
    // 真深度（depthTest: true）：柱在墙后就不该透出来 —— 不做"透墙看柱"
    const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: COLORS.select, depthTest: true }));
    line.position.set(c.x, h / 2, c.z);
    line.name = 'column-hi';
    columnHiGroup.add(line);
  }

  /* ---------------- 设备 ---------------- */

  async function syncItems(l) {
    const wanted = new Map(l.items.map((i) => [i.id, i]));
    // 删
    for (const [id, rec] of items) {
      if (!wanted.has(id)) { itemGroup.remove(rec.group); items.delete(id); }
    }
    // 加 / 改
    for (const item of l.items) {
      // 静态 manifest 优先；DB 动态产品没有静态 entry，回退 `/api/catalog` 的 assetFile。
      // 两者都没有才是真的“没有可用模型”，不能把动态产品/临时加载报成缺失。
      const product = getProduct(item.p);
      const plan = resolveAssetPlan(item.p, {
        count: l.items.length,
        force: level === 'auto' ? null : level,
        product,
      });
      if (!plan) {
        if (errors.length < 12) errors.push(`${item.p}: 目录里没有可用模型`);
        missingAssetItems++;
        continue;
      }
      const want = plan.level;
      const assetFile = plan.entry?.assetFile || plan.entry?.lods?.find((x) => x.file)?.file || '';
      let rec = items.get(item.id);
      if (rec && (rec.level !== want || rec.productId !== item.p || rec.assetFile !== assetFile)) {
        itemGroup.remove(rec.group);
        items.delete(item.id);
        rec = null;
      }
      if (!rec) {
        try {
          const loaded = plan.dynamic
            ? await loadAssetFile(assetFile, plan.entry)
            : await loadAsset(item.p, want);
          const { root, lod, entry } = loaded;
          const group = new THREE.Group();
          group.name = `item-${item.id}`;
          const clone = root.clone(true);
          // 顺序很重要：**先量铰链、再校准**。铰链位置要跟验收器（读的是文件本身）对上，
          // 就必须在缩放/重置原点之前量；反过来的话 fit 模型（s≠1）会全部误报"铰链不对"。
          // 目录给了门就用目录的；没给（如 352 的 hinge_nodes 为空）才从模型 extras 推导。
          // 两者都没有就是真没有门，绝不按名字伪造。
          const specDoors = Array.isArray(entry.doors) && entry.doors.length
            ? entry.doors : doorsFromScene(clone);
          const doors = bindDoors(clone, { ...entry, doors: specDoors });
          const fit = fitClone(clone, entry);
          group.add(clone);
          group.userData = { productId: item.p, lod, fit, doors, entry };
          rec = {
            group, clone, doors, level: want, lodRecord: lod, productId: item.p,
            assetFile, triangles: countTriangles(clone),
          };
          items.set(item.id, rec);
          itemGroup.add(group);
        } catch (err) {
          if (errors.length < 12) errors.push(`${item.p}/${want}: ${err.message}`);
          continue;
        }
      }
      applyItemPose(rec.group, item);
      const amount = item.doorAmount ?? 0;
      for (const b of rec.doors) applyDoor(b, amount);
    }
    applySelection();
    renderOnce();
  }

  function applyItemPose(group, item) {
    group.position.set(item.x, 0, item.z);
    group.rotation.y = -item.r * DEG;   // 与内核 corners()/scene2d 同一旋转约定
  }

  function applySelection() {
    clearGroup(pickGroup);
    if (selectedId == null) return;
    const rec = items.get(selectedId);
    const item = layout?.items.find((i) => i.id === selectedId);
    if (!rec || !item) return;
    const ext = rec.group.userData.entry.declared;
    const pts = corners(item.x, item.z, ext.w, ext.d, item.r);
    const geo = new THREE.BufferGeometry().setFromPoints(
      pts.map(([x, z]) => new THREE.Vector3(x, 0.012, z)),
    );
    const line = new THREE.LineLoop(geo, new THREE.LineBasicMaterial({ color: COLORS.select }));
    line.name = 'selection';
    pickGroup.add(line);
  }

  /* ---------------- 第一人称 ---------------- */

  const isWalk = () => view === 'walk';

  /**
   * 把相机挪到**某一间房**（M1 判据 7 的"相机两档"：整栋一档、单间一档）。
   * 与 `focusItem` 同口径：只挪目标点与机位；距离按这间房自己的尺寸算
   *（拿整栋的公式套小房间，小房间会呆在大房间的机位上）。
   * @param {Array<[number,number]>} poly 房面顶点（来自内核，界面不自己算）
   */
  function focusRoom(poly) {
    if (!layout || !camera || !controls || !Array.isArray(poly) || !poly.length) return false;
    const xs = poly.map((p) => p[0]);
    const zs = poly.map((p) => p[1]);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cz = (Math.min(...zs) + Math.max(...zs)) / 2;
    const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs), 1);
    controls.target.set(cx, layout.h / 2.4, cz);
    camera.position.set(cx + span * 0.45, span * 0.95, cz + span * 1.05);
    controls.update();
    renderOnce();
    return true;
  }

  /**
   * 下一双「走进第一人称」时站在哪儿（M1：「走进去」/ 面客页点房间）。
   * 不直接改 `walk.pos`：`setView('walk')` 自己会重新摆一次站位 —— 两者必须走**同一条路**，
   * 否则"点走进去"与"点第一人称"会站到两个地方（用户看到的结论就是"按钮时灵时不灵"）。
   */
  function wantSpawn(x, z, opts = {}) {
    pendingSpawn = [x, z];
    // 「站到 A 点」会带一个朝 B 的 yaw；不传就沿用原来的「朝房间中心」
    pendingSpawnYaw = Number.isFinite(opts?.yaw) ? opts.yaw : null;
  }

  function applyWalk() {
    if (!camera || !layout) return;
    const margin = 0.35;
    walk.pos.x = Math.max(margin, Math.min(layout.w - margin, walk.pos.x));
    walk.pos.z = Math.max(margin, Math.min(layout.d - margin, walk.pos.z));
    camera.position.set(walk.pos.x, cfg.walk.eyeM, walk.pos.z);
    camera.rotation.y = Math.PI + walk.yaw;   // yaw=0 → 面朝 +z（与平面图"z 向下"一致）
    camera.rotation.x = walk.pitch;
    camera.rotation.z = 0;
    renderOnce();
  }

  function setView(next) {
    view = next === 'walk' ? 'walk' : 'orbit';
    // ⭐ D51：两套控制器（`OrbitControls` 与第一人称的 `walkLook`）**不许同时活着** ——
    //    它们改的是同一个相机。放在这里（而不是只放在 attach 里）：视角是会来回切的。
    if (controls) controls.enabled = !isWalk();
    // 组件挂上 ≠ 布局已到：`attached` 在 attach() 里就为真，而 layout 要等 setLayout。
    // 没有房间尺寸就没法摆相机 —— 先记住选择，布局到了由 setLayout 补上。
    if (!layout || !attached) return view;
    if (isWalk()) {
      // 从鸟瞰切进来时，站到房间一角，视线朝房间中心；
      // 有人指明了站位（「走进去」/ 面客页点房间）就用那一个 —— 同一条路。
      const at = pendingSpawn;
      const atYaw = pendingSpawnYaw;
      pendingSpawn = null;
      pendingSpawnYaw = null;
      if (at) walk.pos.set(at[0], 0, at[1]);
      // 0 间房（开放场景）没有"房间一角"可站：站**场景中心**。
      // 墙围不成房间时，角落里就是围墙根，第一人称一进去贴着墙看 —— docs/92 §5 / §11 E23。
      else if (roomsOf(layout).length === 0) walk.pos.set(layout.w / 2, 0, layout.d / 2);
      else walk.pos.set(Math.min(0.9, layout.w / 4), 0, Math.min(0.9, layout.d / 4));
      // 站到 A 点：朝向 B（planRoute 给的第二站）；否则沿用「朝房间中心」
      walk.yaw = Number.isFinite(atYaw) ? atYaw : Math.atan2(layout.w / 2 - walk.pos.x, layout.d / 2 - walk.pos.z);
      walk.pitch = 0;
      applyWalk();
    } else {
      if (document.pointerLockElement === canvas) document.exitPointerLock();
      frameAll();
    }
    return view;
  }

  /**
   * 门障碍（FIX-16 的修法）：拿**门叶此刻的世界包围盒**，不是扫掠区。
   *
   * 原型用的是"扇形扫过的那一整块"，于是门一开，空地上就多出一堵看不见的墙；
   * 而且它没跳过关着的门 —— 关着的门也挡人。这里两条都改掉：
   *   · 用 `Box3().setFromObject(门叶)` = 门**现在**在哪；
   *   · `amount > 0` 才算障碍（关着的门不挡人）。
   * 高度区间由内核的 `doorIsBlocking()` 判（低处门挡人、上盖不挡）。
   */
  function doorBoxesFor() {
    const out = [];
    if (!layout) return out;
    for (const it of layout.items) {
      if (!(it.doorAmount > 0)) continue;
      const rec = items.get(it.id);
      if (!rec) continue;
      for (const b of rec.doors) {
        if (!b.obj) continue;
        const box = new THREE.Box3().setFromObject(b.obj);
        out.push({
          minX: box.min.x, maxX: box.max.x,
          minZ: box.min.z, maxZ: box.max.z,
          minY: box.min.y, maxY: box.max.y,
        });
      }
    }
    return out;
  }

  /**
   * 「按一次键」的步进量子（秒）—— `walkMove(1, 0)` = 以 **0.1 秒**的时长往前走一步。
   *
   * 以前这个 0.1 是写在 `walkMove` 里的裸数字，摇杆要"按秒推进"时得靠调用方反推它 ——
   * 那种"把魔法数当成约定"的写法，改一个忘一个就错。现在它是常量，两处（键盘 / 摇杆）共用。
   */
  const WALK_TAP_SEC = 0.1;

  function walkMove(forward, right) {
    if (!isWalk() || !layout || !attached) return null;
    const s = walk.speed;
    // ⭐ 前/右 → 世界位移**只在核心里算一份**（`@core/walkbasis.js`）。
    //   以前这两行是手写的：符号写反了不会报错，用户只能说"感觉 A/D 反了"，
    //   而手感说不清是哪条轴。现在它是纯函数，有单测、也有 QA 接口可断言。
    //   注意传入的是**角度**（内核里角度统一用度：设备 r、墙方向都是度）。
    const { dx: ux, dz: uz } = stepVector((walk.yaw * 180) / Math.PI, forward, right);
    const dx = ux * s * WALK_TAP_SEC;
    const dz = uz * s * WALK_TAP_SEC;
    // ⭐ 碰撞（B17）：问内核，**不在这里另写一套** —— 原型就是
    //   "2D 校验 / 漫游 / 导入各写一份"才互相打架的（见 validate.js 头注释）。
    const r = walkStep(walk.pos.x, walk.pos.z, dx, dz, layout, getProduct, doorBoxesFor());
    walk.pos.x = r.x;
    walk.pos.z = r.z;
    walk.stuck = r.stuck;
    applyWalk();
    return probeCamera();
  }

  /**
   * 摇杆/持续输入的**按秒**推进（批 C）。
   *
   * 为什么不另写一套：方向数学（前/右 → 世界位移）与碰撞都在 `walkMove` 里那份，
   * 这里只把"持续了多久"换成"按了多少次键"（`dt / WALK_TAP_SEC`）再交给它。
   * 自己再写一遍 `stepVector` + `walkStep` 就是第二个实现 —— 本项目反复踩过的病根。
   *
   * `dt` **夹在 `WALK_TAP_SEC` 内**：切标签页、掉了一大帧之后回来时，
   * 那段时间**不能**算成"用户一直在走"（否则客户一回来就发现自己穿到墙里了）。
   */
  function walkDrive(forward, right, dtSec) {
    if (!isWalk() || !layout || !attached) return null;
    const dt = Math.max(0, Math.min(Number(dtSec) || 0, WALK_TAP_SEC));
    if (dt <= 0) return null;
    return walkMove(forward * (dt / WALK_TAP_SEC), right * (dt / WALK_TAP_SEC));
  }

  function walkLook(yawDeg, pitchDeg) {
    if (!layout || !attached) return null;
    walk.yaw += (yawDeg ?? 0) * DEG;
    walk.pitch = Math.max(-1.48, Math.min(1.48, walk.pitch + (pitchDeg ?? 0) * DEG));
    applyWalk();
    return probeCamera();
  }

  function onMouseMove(evt) {
    if (!isWalk()) return;
    // 锁上了就用 movement 环视；没锁上（浏览器不给锁 / 用户按 Esc 解锁后仍在第一人称）则"按住左键拖动"环视。
    // 少了后面这条路，"锁定失败"就等于"第一人称里什么都做不了"。
    if (document.pointerLockElement !== canvas && !dragLook) return;
    // 位移为 0 的 move 是**白活**（触摸拖拽会顺带触发一条 compat mousemove，它的 movementX 恒为 0）：
    // 不算角度却要重排一遍相机再重画一帧。跳掉它，行为不变。
    if (!evt.movementX && !evt.movementY) return;
    walkLook(evt.movementX * 0.12, -evt.movementY * 0.12);
  }

  /**
   * 触摸环视（面客模式的第②层降级 —— `docs/55` §4.6）。
   *
   * ## 为什么鼠标那条路接不住触摸
   * `onMouseMove` 读的是 `evt.movementX/movementY` —— 那是**指针锁定**才有的量。触摸不会锁定，
   * 也不产生 `movementX`（恒 0）⇒ 平板上进第一人称就是"站在原地、头也转不了"。
   *
   * ## 为什么单独开一条路，而不是把两种输入揉进同一个 handler
   * D51 的病根就是"两套东西改同一个相机"。这里严格按 `pointerType` 分流：触摸走这一条
   * （按**位移量**算角度），鼠标走原来那条（`movementX` 或按住左键拖动）—— **两条不会同时生效**。
   */
  let touchLook = null;    // {id,x,y}：只有**第一根**手指转视角（第二根留给摇杆/捏合）

  function onPointerMove(evt) {
    if (!isWalk() || evt.pointerType !== 'touch') return;
    if (!touchLook) { touchLook = { id: evt.pointerId, x: evt.clientX, y: evt.clientY }; return; }
    if (evt.pointerId !== touchLook.id) return;
    const dx = evt.clientX - touchLook.x;
    const dy = evt.clientY - touchLook.y;
    touchLook.x = evt.clientX;
    touchLook.y = evt.clientY;
    // ⭐ 与鼠标**同一条路径、同一个系数**（`walkLook`）：两种输入的手感不该是两套数
    walkLook(dx * 0.12, -dy * 0.12);
  }

  /**
   * 触摸的第一根手指**按住的那一刻就把锚点定下来**。
   *
   * 为什么不等到第一次 `pointermove` 再定：那样第一段滑动只用来定锚点、不转头 ——
   * 手指按下去拖了一大截、画面纹丝不动，看着就像"触摸失灵"（真机探针就是这么拓出来的）。
   * 锚点定在按下点，第一段滑动立刻生效（和鼠标按住拖动的手感一致）。
   */
  function anchorTouchLook(evt) {
    if (evt.pointerType === 'touch' && !touchLook) {
      touchLook = { id: evt.pointerId, x: evt.clientX, y: evt.clientY };
    }
  }

  /** 手指被系统拿走（来电、手势被浏览器接管）—— 必须清掉跟踪，否则下一根手指一直算不出来 */
  function onPointerCancel(evt) {
    if (touchLook && evt.pointerId === touchLook.id) touchLook = null;
  }

  function onKeyDown(evt) {
    // Esc 必须自己处理：这是内嵌浏览器，实测它不会替我们放锁。
    // 第一次 Esc = 释放鼠标（工具条立刻能点，浮层上的"退出第一人称"也点得到）；
    // 第二次 Esc（此时没锁）= 回鸟瞰。给一条**两次都成立**的路，用户不用记细节。
    if (evt.key === 'Escape') {
      if (document.pointerLockElement === canvas) {
        evt.preventDefault();
        document.exitPointerLock?.();
        return;
      }
      if (isWalk()) {
        evt.preventDefault();
        // 交给界面去切（走同一条 pickView 路径）—— 只改内部状态的话，界面不知道
        if (onExitWalk) onExitWalk();
        else setView('orbit');
      }
      return;
    }
    if (!isWalk()) return;
    const step = evt.shiftKey ? 2.4 : 1;
    const map = { w: [1, 0], s: [-1, 0], a: [0, -1], d: [0, 1], ArrowUp: [1, 0], ArrowDown: [-1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    const dir = map[evt.key] ?? map[evt.key.toLowerCase?.()];
    if (!dir) return;
    evt.preventDefault();
    walkMove(dir[0] * step, dir[1] * step);
  }

  function onLockChange() {
    if (document.pointerLockElement === canvas) lockFailed = false;
    renderOnce();
  }

  /** 浏览器拒绝锁定（环境/权限）—— 必须说出来，否则用户只知道"鼠标不听使唤" */
  function onLockError() {
    lockFailed = true;
    renderOnce();
  }

  let downAt = null;
  let dragLook = false;
  let lockFailed = false;

  function onPointerDown(evt) {
    if (isWalk()) {
      anchorTouchLook(evt);
      // 锁得住就锁（环视手感最好）；锁不住退化成"按住左键拖动"
      if (document.pointerLockElement !== canvas) {
        // requestPointerLock() 在新版 Chrome **返回 promise**，失败时是"拒绝"而不是抛错 ——
        // 不接住就是一条未捕获的 Promise 拒绝（实测控制台里出现过 WrongDocumentError：
        // 这个内嵌浏览器不给锁定）。锁不住不算错误：下面 dragLook 本来就是主路径。
        try {
          const lock = canvas.requestPointerLock?.();
          if (lock && typeof lock.catch === 'function') lock.catch(() => {});
        } catch { /* 老版本同步抛错也吞掉 —— 锁不上不影响走动 */ }
      }
      dragLook = true;
      return;
    }
    downAt = { x: evt.clientX, y: evt.clientY };
  }

  /**
   * 一次射线，返回**最先**命中的目标：`{kind:'item'|'column', id}` 或 null。
   *
   * ⚠️ 为什么不能只 raycast `itemGroup`（docs/101 §三.3「3D 点柱的遮挡坑」）：
   *    柱是全高不透明的实体，若拾取只打设备，点柱会**穿透**选中它背后的设备 ——
   *    用户看到的是柱，选中的却是后面的柜子。所以柱必须先参与遮挡判定。
   */
  function pickTargetAt(evt) {
    if (!renderer || !camera) return null;
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((evt.clientX - rect.left) / rect.width) * 2 - 1,
      -((evt.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, camera);
    const itemHits = ray.intersectObjects([...items.values()].map((r) => r.group), true);
    const colHits = columnGroup && columnGroup.children.length ? ray.intersectObject(columnGroup, true) : [];
    const firstItem = itemHits[0] ?? null;
    const firstCol = colHits[0] ?? null;
    if (firstCol && (!firstItem || firstCol.distance <= firstItem.distance)) {
      // 合并网格里没有 per-column 对象（也不该有：那会变成 50 个 draw call）——
      // 用命中点的 x/z 反推是哪一根，命中点必然落在其中一根的占地矩形里。
      const p = firstCol.point;
      const hit = columnsOf(layout).find((c) => p.x >= c.x - c.w / 2 - 1e-6 && p.x <= c.x + c.w / 2 + 1e-6
        && p.z >= c.z - c.d / 2 - 1e-6 && p.z <= c.z + c.d / 2 + 1e-6);
      return { kind: 'column', id: hit ? hit.id : null };
    }
    if (firstItem) {
      let o = firstItem.object;
      while (o && !String(o.name).startsWith('item-')) o = o.parent;
      return { kind: 'item', id: o ? Number(o.userData?.id ?? o.name.slice(5)) : null };
    }
    return null;
  }

  /** 设备拾取的旧口径（双击聚焦等）：点柱**不是**点到了它背后的设备，返回 null */
  function pickItemIdAt(evt) {
    const t = pickTargetAt(evt);
    return t && t.kind === 'item' ? t.id : null;
  }

  /** 双击设备 = 把观察目标挪到它身上（"我就想看这台"）—— 只挪目标点，相机距离不动，用户还是自己控视角 */
  function focusItem(id) {
    const rec = items.get(id);
    if (!rec || !controls) return false;
    const box = new THREE.Box3().setFromObject(rec.group);
    if (box.isEmpty()) return false;
    box.getCenter(controls.target);
    controls.update();
    renderOnce();
    return true;
  }

  /**
   * 屏幕上的一个点 → 平面坐标 `[x, z]`（打在**地面**上）。
   *
   * 用数学平面（y=0）求交，不靠 raycast 地板网格：地板是一整块、没有细分，
   * raycast 只能告诉我"打到了"，拿不到落在哪 —— 而多房间要的正是"落在哪一间"。
   * 打到整栋之外返回 null（界面不许把"房外"当成"某一间"）。
   */
  function pickFloor(clientX, clientY) {
    if (!camera || !canvas || !layout) return null;
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, camera);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(plane, hit)) return null;
    const x = hit.x;
    const z = hit.z;
    if (x < 0 || x > layout.w || z < 0 || z > layout.d) return null;
    return [+x.toFixed(3), +z.toFixed(3)];
  }

  function onDoubleClick(evt) {
    if (isWalk()) return;
    const id = pickItemIdAt(evt);
    if (id !== null) focusItem(id);
  }

  /** 点击拾取（与原型"点设备选中"一致；漫游模式下点击是锁定鼠标，不拾取） */
  function onPointerUp(evt) {
    dragLook = false;
    if (touchLook && evt.pointerId === touchLook.id) touchLook = null;
    if (!downAt || !renderer) return;
    const moved = Math.hypot(evt.clientX - downAt.x, evt.clientY - downAt.y);
    downAt = null;
    if (moved > 4) return;   // 拖动过就不是"点击"，别把视角操作当成选中
    const target = pickTargetAt(evt);
    if (!target) { onSelect(null); return; }
    // 点柱 = sentinel（v1 3D **不可点选**）：吞掉这次点击 —— 不选柱、不清空已有选择、
    // 也不让它穿透去选背后那台设备。选中只由 2D 画布与右栏「柱」卡驱动。
    if (target.kind === 'column') { renderOnce(); return; }
    onSelect(target.id);
  }

  /* ---------------- 相机取景 ---------------- */

  function frameAll() {
    if (!layout || !camera) return;
    const r = Math.max(layout.w, layout.d);
    camera.position.set(layout.w / 2 + r * 0.35, r * 0.75, layout.d + r * 0.55);
    controls.target.set(layout.w / 2, layout.h / 2.4, layout.d / 2);
    controls.update();
    renderOnce();
  }

  /* ---------------- 对外 ---------------- */

  function setLayout(l) {
    layout = l;
    if (!attached) return undefined;
    buildRoom(l);
    buildRoutes(l);
    setColumns(l);           // 增量：柱/层高/墙档位都没变时一次几何都不重建
    const pending = (async () => {
      await loadCatalogs();   // 目录没到齐就只能选出 `null` 级别，后面全部载不了模型
      return queueSync();
    })();
    if (isWalk()) applyWalk(); else renderOnce();
    return pending;
  }

  /**
   * 把场景同步排成一条队，绝不并发。
   * 踩过的坑：布局连续变化时两次 syncItems 会同时起步，两边都发现"这台设备还没建"，
   * 于是各建一份、后一次覆盖 map —— 场景里就多出一批没人管的物件（还被渲染，绘制量直接翻倍）。
   * 队列里的每一次都读**当时最新的** layout，所以连续拖拽不会补跑一堆过期状态。
   */
  let syncChain = Promise.resolve();
  function queueSync() {
    syncChain = syncChain.then(() => syncItems(layout)).catch((err) => {
      if (errors.length < 12) errors.push(`同步失败：${err.message}`);
    }).then(() => {
      // 队列跑完 = 这一刻场景里的台数**就是** `probe().scene.meshes` 说的那个数 ——
      // 谁在读这个数（界面上的加载提示、探针）都该在这个点上重读一次。
      // 注意：**成功失败都喊**（失败也得让界面重读，否则错误读数同样会僵在那里）。
      if (onSceneSettled) onSceneSettled();
    });
    return syncChain;
  }

  function setSelected(id) {
    selectedId = id;
    if (attached) applySelection();
  }

  function setLevel(next) {
    level = next || 'auto';
    if (!attached || !layout) return Promise.resolve(level);
    for (const [id, rec] of items) { itemGroup.remove(rec.group); items.delete(id); }
    // 返回队列：调用方 await 它之后读到的才是**新级别已就位**的状态（否则读到空档）
    return queueSync();
  }

  function probeRender() {
    const info = renderer.info;
    return {
      triangles: info.render.triangles,
      calls: info.render.calls,
      lines: info.render.lines,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs?.length ?? 0,
      size: { w: renderer.domElement.width, h: renderer.domElement.height },
    };
  }

  function probeCamera() {
    const t = new THREE.Vector3();
    camera.getWorldDirection(t);
    // ⭐ 相机自己的**局部 +x 轴**在世界里的方向 = three.js 给出的"右"。
    //   探针必须拿它来对账：只拿内核返回的 basis 跟内核算出来的位移比，是**循环论证** ——
    //   基准符号反了，两边一起反，照样全绿（变异验证实测踩过）。
    const rw = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    return {
      view,
      pos: [+camera.position.x.toFixed(3), +camera.position.y.toFixed(3), +camera.position.z.toFixed(3)],
      yawDeg: +(walk.yaw * 180 / Math.PI).toFixed(1),
      // 当前朝向的「前/右」基准 —— 探针拿它断言方向（不自己重算公式：那种"各写一份"正是本轮的病根）
      basis: (() => { const b = moveBasis((walk.yaw * 180) / Math.PI); return { fx: +b.fx.toFixed(6), fz: +b.fz.toFixed(6), rx: +b.rx.toFixed(6), rz: +b.rz.toFixed(6) }; })(),
      pitchDeg: +(walk.pitch * 180 / Math.PI).toFixed(1),
      forward: [+t.x.toFixed(3), +t.y.toFixed(3), +t.z.toFixed(3)],
      // 与 three.js 对账用的独立锚点（不由本项目任何公式算出）
      rightWorld: [+rw.x.toFixed(6), +rw.z.toFixed(6)],
      target: controls ? [+controls.target.x.toFixed(3), +controls.target.y.toFixed(3), +controls.target.z.toFixed(3)] : null,
      pointerLocked: document.pointerLockElement === canvas,
      pointerLockFailed: lockFailed,
      stuck: !!walk.stuck,
    };
  }

  function probe() {
    const list = [...items.entries()].map(([id, rec]) => ({
      id,
      productId: rec.productId,
      lod: rec.level,
      triangles: rec.triangles,
      scale: +rec.group.userData.fit.scale.toFixed(5),
      envelopeMode: rec.group.userData.fit.mode,
      anisotropyPct: rec.group.userData.fit.anisotropyPct,
      recenterMm: rec.group.userData.fit.recenterMm,
      pos: [+rec.group.position.x.toFixed(3), rec.group.position.y.toFixed(3), rec.group.position.z.toFixed(3)],
      rotYDeg: +(rec.group.rotation.y * 180 / Math.PI).toFixed(2),
      doors: rec.doors.map((b) => ({
        node: b.node,
        found: b.found,
        axis: b.axis,
        rotationDeg: +(b.obj?.rotation[b.axis] * 180 / Math.PI).toFixed(2),
        pivotOk: b.pivotOk ?? null,
        swingRadiusMm: b.swingRadiusMm,
      })),
    }));
    return {
      attached,
      ready: attached && !!layout,
      view,
      level,
      items: list,
      scene: {
        ground: groundGroup?.children.length ?? 0,
        // 口径变更：每类墙合并成**一份**几何，所以「墙有几面」要问构件清单，不能数 children
        walls: lastWallPieces.walls,
        wallPieces: lastWallPieces.pieces,
        wallFills: lastWallPieces.fills,
        wallMeshes: wallGroup?.children.length ?? 0,
        wallOpenings: lastWallPieces.openings,
        wallLintels: lastWallPieces.lintels,
        // 窗下墙的块数（探针拿它证「窗底下那截墙真的建出来了」）
        wallSills: lastWallPieces.sills,
        eyeM: cfg.walk.eyeM,
        wallStyle: lastWallStyle.style,
        wallOpacity: lastWallStyle.opacity,
        interiorWalls: (layout?.walls ?? []).filter((w) => !isBoundaryWall(layout, w)).length,
        boundaryWalls: (layout?.walls ?? []).filter((w) => isBoundaryWall(layout, w)).length,
        // 房间（M1）：派生量也进读数 —— 探针拿它断言"多房间仍是一个场景"
        rooms: layout ? roomsOf(layout).length : 0,
        partyWalls: layout ? wallClasses(layout).filter((c) => c === 'party').length : 0,
        // 开放场景（P4）：语义 / 开放面积 / 角色计数。
        // ⚠️ `role` 只用于 2D 样式与探针**分组**，**不拆 3D 材质** ——
        //    「墙是一份合并网格 + 一个材质」（`wallMeshes === 1`）是用户拍板的判据，这里只读不建。
        semantics: layout ? roomSemanticsOf(layout) : null,
        openAreaM2: layout ? +openAreaTotal(layout).toFixed(3) : null,
        roomAreaM2: layout ? +roomAreaTotal(layout).toFixed(3) : null,
        wallRoles: layout
          ? {
            exterior: layout.walls.filter((wl) => wallRole(layout, wl) === 'exterior').length,
            interior: layout.walls.filter((wl) => wallRole(layout, wl) === 'interior').length,
          }
          : null,
        spawn: walk.pos ? [+walk.pos.x.toFixed(3), +walk.pos.z.toFixed(3)] : null,
        meshes: itemGroup?.children.length ?? 0,
        missingAssets: missingAssetItems,
        totalTriangles: list.reduce((s, i) => s + i.triangles, 0),
        // 柱（P4·docs/101 §三.3）：独立合并网格；`columnShadow*` 是**接触阴影贴花**，
        // 不是 shadowMap（本渲染器没开实时阴影，写 castShadow 只会得到假判据）。
        columnCount: lastColumns.count,
        columnMeshes: columnGroup?.children.length ?? 0,
        columnShadowMeshes: columnShadowGroup?.children.length ?? 0,
        columnHiMeshes: columnHiGroup?.children.length ?? 0,
        columnTriangles: lastColumns.triangles,
        columnShadowTriangles: lastColumns.shadowTriangles,
        columnSelected: columnSelectedId,
        // docs/100 §6.2 约定的嵌套形状（与上面扁平字段同一份来源，不各算一次）
        columns: {
          columnCount: lastColumns.count,
          columnMeshes: columnGroup?.children.length ?? 0,
          columnShadowMeshes: columnShadowGroup?.children.length ?? 0,
          columnHiMeshes: columnHiGroup?.children.length ?? 0,
          columnTriangles: lastColumns.triangles,
          columnShadowTriangles: lastColumns.shadowTriangles,
          wallMeshes: wallGroup?.children.length ?? 0,
        },
      },
      camera: attached ? probeCamera() : null,
      // 动线（P3·docs/97 §5.4）：常态 routeMeshes === 2（ribbon + arrows），选中高亮最多 +1。
      // 失效路线不进几何（routeTriangles 里没有它们的三角形），原因在 routes.statuses 里。
      routeCount: lastRoutes.count,
      routeStatus: lastRoutes.status,
      routeMeshes: (routeGroup?.children.length ?? 0) + (routeHiGroup?.children.length ?? 0),
      routeTriangles: lastRoutes.triangles,
      routeLengthM: lastRoutes.length,
      routeMarkers: lastRoutes.markers,
      routeSelected: routeSelectedId,
      routes: {
        count: lastRoutes.count,
        valid: lastRoutes.valid,
        invalid: lastRoutes.invalid,
        status: lastRoutes.status,
        triangles: lastRoutes.triangles,
        length: lastRoutes.length,
        markers: lastRoutes.markers,
        statuses: lastRoutes.statuses,
      },
      render: attached ? { ...probeRender(), pixelRatio: renderer.getPixelRatio(), pixelRatioCap } : null,
      errors,
    };
  }

  /**
   * 自检：把目录里每一款每一级都真加载一遍，核对
   *   ① 拉伸/比例：实测包围盒 vs 声明包络（`1:1` 必须一致，`fit` 报各轴失真）
   *   ② 门：节点找得到吗？铰链世界坐标 = 验收器实测的 pivot 吗？（±2 mm）
   * 这条不依赖"界面挂着"，也不依赖渲染帧 —— 因为本环境 rAF 是暂停的。
   */
  async function selfTest() {
    const cat = await loadCatalogs();
    const out = { models: [], ok: true };
    const ids = cat.entries.map((e) => e.id);
    for (const id of ids) {
      const entry = entryOf(id);
      for (const lv of levelsOf(id)) {
        const row = { productId: id, level: lv, modelCode: entry.modelCode };
        try {
          const { root } = await loadAsset(id, lv);
          const clone = root.clone(true);
          // 先量铰链（与验收器同一基准）→ 再校准尺寸
          const doors = bindDoors(clone, entry);
          const fit = fitClone(clone, entry);
          const after = measure(clone);
          row.triangles = countTriangles(clone);
          row.bytes = null;
          row.scale = +fit.scale.toFixed(5);
          row.envelopeMode = fit.mode;
          row.measuredMm = { w: +after.mm.w.toFixed(2), h: +after.mm.h.toFixed(2), d: +after.mm.d.toFixed(2) };
          row.declaredMm = { w: entry.declared.w * 1000, h: entry.declared.h * 1000, d: entry.declared.d * 1000 };
          row.deltaMm = {
            w: +(after.mm.w - entry.declared.w * 1000).toFixed(2),
            h: +(after.mm.h - entry.declared.h * 1000).toFixed(2),
            d: +(after.mm.d - entry.declared.d * 1000).toFixed(2),
          };
          row.recenterBig = fit.recentered;
          row.doors = doors.map((b) => ({
            node: b.node, found: b.found, pivotOk: b.pivotOk ?? null,
            pivotDeltaMm: b.pivotDeltaMm ?? null, swingRadiusMm: b.swingRadiusMm ?? null,
          }));
          const doorOk = doors.every((b) => b.found && b.pivotOk !== false);
          const deltas = Object.values(row.deltaMm).map(Math.abs);
          /**
           * 两种口径不能混：
           *   `1:1` 模型必须与声明包络**逐轴**一致（± `model.envelopeTolMm`，默认 1 mm）
           *   `fit` 模型靠 min() 等比缩放兜底，本来就填不满三个方向 —
           *   合格判据是"至少有一个方向贴齐声明值"（证明缩放生效）
           *   “各轴比例失真”是**源模型的数据质量**问题，如实报出来，不当加载失败。
           *
           * ⚠️ 容差**与维护端同一处出处**（`envelopeTolMm()`）。这里原来写死 5 mm，
           *    而写入侧判 1 mm —— 声明 990 / 实测 994.5 的模型在维护端挂「尺寸未对账」、
           *    在这里却报合格（第 3 轮审查 C-10）。
           */
          const tolMm = envelopeTolMm();
          const sizeOk = fit.mode === '1:1'
            ? Math.max(...deltas) <= tolMm
            : Math.min(...deltas) <= tolMm;
          row.sizeOk = sizeOk;
          // 「各轴比例失真」按**参数表**判（`model.anisotropyWarn`，默认 1.02）。原来判在
          // gltf.js 里写死为 2%，全仓有三份阈值、改哪一份都不生效（第 2 轮审查 dev-5）。
          row.shapeOk = fit.anisotropyRatio <= cfg.model.anisotropyWarn;
          row.recenterMaxMm = +Math.max(...Object.values(fit.recenterMm).map(Math.abs)).toFixed(2);
          row.ok = doorOk && sizeOk;
          if (!row.ok) out.ok = false;
        } catch (err) {
          row.ok = false; row.error = err.message; out.ok = false;
        }
        out.models.push(row);
      }
    }
    out.anisotropyWarn = [...new Set(out.models.filter((m) => m.shapeOk === false).map((m) => m.productId))];
    out.recenterWarn = [...new Set(out.models.filter((m) => m.recenterBig).map((m) => m.productId))];
    return out;
  }

  /**
   * 门在**世界坐标**里的真实位置与范围 —— 2D↔三维对账就靠它。
   *
   * 两条路各自独立：平面图用的是"验收器从文件里量出来、再换算到平面"的铰链；
   * 这里给的是"three.js 加载完之后真实节点的世界坐标"。两边对得上，才说明换算链没有偏。
   * 这是 R3-7 唯一真正算数的验收 —— 光看"扇形画出来了"什么也证明不了。
   */
  function doorWorld(id) {
    const rec = items.get(id);
    if (!rec) return null;
    const out = [];
    for (const b of rec.doors) {
      if (!b.obj) continue;
      const h = new THREE.Vector3();
      b.obj.getWorldPosition(h);
      const box = new THREE.Box3().setFromObject(b.obj);
      out.push({
        node: b.node,
        axis: b.axis,
        hinge: [h.x, h.y, h.z],
        boxMin: [box.min.x, box.min.y, box.min.z],
        boxMax: [box.max.x, box.max.y, box.max.z],
      });
    }
    const p = rec.group.position;
    return { itemPos: [p.x, p.y, p.z], rotYDeg: rec.group.rotation.y * 180 / Math.PI, doors: out };
  }

  function dispose() {
    if (!attached) return;
    observer?.disconnect();
    canvas?.removeEventListener('pointerdown', onPointerDown);
    canvas?.removeEventListener('pointerup', onPointerUp);
    canvas?.removeEventListener('pointermove', onPointerMove);
    canvas?.removeEventListener('pointercancel', onPointerCancel);
    // 双击那个监听在 `attach` 里加过、以前**没人在 dispose 里摘** —— 靠「画布跟着组件一起没了」兜住。
    // 面客模式会反复进出这一页（平板来回切），收尾清单就写全一点。
    canvas?.removeEventListener('dblclick', onDoubleClick);
    document.removeEventListener('pointerlockchange', onLockChange);
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('pointerlockerror', onLockError);
    controls?.dispose();
    // ⭐ 释放 WebGL 上下文（B18）：`renderer.dispose()` **不会**把上下文还给浏览器 ——
    //    浏览器同时只允许有限个 WebGL 上下文（超了会偷偷丢掉最早那个，画面直接变黑，
    //    而且不报错）。进进出出三维视图几次就能碰上。
    //    这里安全：`renderer` 是 `attach()` 每次新建的（不是复用），丢掉它下次进来重建一个。
    renderer?.forceContextLoss();
    renderer?.dispose();
    renderer = null;
    attached = false;
  }

  return {
    attach, dispose, setLayout, setSelected, setLevel, setView, renderOnce, snapshot, shotView,
    setColumns, setSelectedColumn,
    snapshotOffscreen, frameView, setRouteSelected, standAtRoute,
    probe, probeRender, selfTest,
    walkMove, walkLook, walkDrive, frameAll, doorWorld, focusRoom, wantSpawn, pickFloor,
    get attached() { return attached; },
    get view() { return view; },
    get level() { return level; },
    get items() { return items; },
    set onSelect(fn) { onSelect = fn; },
    set onExitWalk(fn) { onExitWalk = fn; },
    set onSceneSettled(fn) { onSceneSettled = fn; },
  };
}

/** 单实例：3D 视图与应用共享一份（devkit 也通过它做验证） */
export const view3d = createView3D();
export default view3d;